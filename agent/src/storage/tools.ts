/**
 * Workspace file tools for Claude, served by the agent itself (in-process MCP)
 * so they work whether or not a browser tab is open. Writes are recorded as
 * the agent's versions, and the UI hears about them through the /files change
 * stream (it opens files Claude writes). In a knowledge node a write becomes a
 * proposed version instead (proposals.ts), for someone who can edit the node
 * to accept or reject.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { AccessError, ForbiddenError, type Principal } from "./access";
import { ExperimentError } from "./experiments";
import type { Storage } from "./index";
import { ReadOnlyFileError } from "./files";
import { NodeError, type KnowledgeNode } from "./nodes";
import type { FilesSession, Session } from "./session";
import { InvalidPathError, isTextFile, kindForPath, normalizePath } from "./paths";
import { ProposalError } from "./proposals";
import { SearchError } from "./search";
import { isInside } from "./workdir";
import type { Skill } from "../skills/catalog";

/** What a chat run knows about itself, for the provenance of runs it starts. */
export interface RunMeta {
  /** The chat (AG-UI thread) the run came from. */
  chat?: string | null;
  model?: string;
  /** The run's skills, to record the version of the one a run used. */
  skills?: Skill[];
}

/** This agent's version and its Claude Agent SDK's, as pinned in its package.json. */
const TOOL_VERSIONS = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    return { agent: pkg.version, claudeAgentSdk: pkg.dependencies["@anthropic-ai/claude-agent-sdk"] };
  } catch {
    return {};
  }
})();

/**
 * A skill as a run records it: name, where it came from, its hub version if
 * it has one, and a hash over its files, which changes with any edit.
 */
export function skillProvenance(name: string, skills: Skill[] = []) {
  const skill = skills.find((s) => s.name === name);
  if (!skill) return { name };
  const hash = createHash("sha256");
  for (const file of [...skill.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(file.path).update("\0").update(file.bytes).update("\0");
  }
  return {
    name,
    source: skill.source,
    ...(skill.hub ? { version: skill.hub.version } : {}),
    sha256: hash.digest("hex"),
  };
}

/** Keeps one tool result reasonable; Claude is told when a file was cut. */
const MAX_READ_CHARS = 200_000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
});
const error = (message: string): ToolResult => ({ ...text(message), isError: true });

/** Same format as the UI's numberLines() (src/components/workspace/file-refs.ts). */
export function numberLines(content: string): string {
  const lines = content.split(/\r\n|\r|\n/);
  const width = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(width)}\t${line}`).join("\n");
}

/**
 * Lines `offset`.. of a file (1-based), at most `limit` of them and at most
 * `maxChars` characters, numbered like numberLines(). `column` starts the
 * first line part way in, for lines longer than a whole read (minified JSON,
 * say). The header line says which lines these are and, when the file goes
 * on, where to continue from, so Claude can page through files of any size.
 */
export function readLines(
  path: string,
  content: string,
  {
    offset = 1,
    column = 1,
    limit,
    maxChars = MAX_READ_CHARS,
  }: { offset?: number; column?: number; limit?: number; maxChars?: number } = {},
): string {
  const lines = content.split(/\r\n|\r|\n/);
  const total = lines.length;
  if (offset > total) {
    return `${path} (${total} lines; offset ${offset} is past the end)`;
  }
  if (column > 1 && column > lines[offset - 1].length) {
    return `${path} (line ${offset} has ${lines[offset - 1].length} characters; column ${column} is past its end)`;
  }
  const width = String(total).length;
  const out: string[] = [];
  let chars = 0;
  // Set when a line didn't fit whole: the column to continue that line from.
  let resumeAt: number | null = null;
  const end = limit === undefined ? total : Math.min(total, offset - 1 + limit);
  for (let i = offset - 1; i < end; i++) {
    const from = i === offset - 1 ? column - 1 : 0;
    let line = lines[i].slice(from);
    if (chars + line.length > maxChars) {
      if (out.length > 0) break;
      line = line.slice(0, maxChars);
      resumeAt = from + maxChars + 1;
    }
    out.push(`${String(i + 1).padStart(width)}\t${line}`);
    chars += line.length + 1;
    if (resumeAt !== null) break;
  }
  const last = offset - 1 + out.length;
  const whole = offset === 1 && column === 1 && last === total && resumeAt === null;
  let header = path;
  if (!whole) {
    header += ` (lines ${offset}-${last} of ${total}`;
    if (column > 1) header += `; line ${offset} from column ${column}`;
    if (resumeAt !== null) {
      header += `; line ${last} cut before column ${resumeAt}; continue with offset ${last} column ${resumeAt}`;
    } else if (last < total) {
      header += `; continue with offset ${last + 1}`;
    }
    header += ")";
  }
  return `${header}\n${out.join("\n")}`;
}

const nodeParam = z
  .string()
  .optional()
  .describe(
    "Knowledge node id (from list_nodes or the context's currentNode). Omit for the workspace root.",
  );
const experimentParam = z
  .string()
  .optional()
  .describe(
    "Experiment id (from list_experiments or the context's currentExperiment); the experiment's " +
      "files instead of a node's. Takes precedence over `node`.",
  );
const jsonObject = z.record(z.string(), z.unknown());

/** The tree as indented lines, e.g. `- Etch [tech] id=… (3 files, editor)`. */
type TreeNode = KnowledgeNode & { role?: string | null };

export function formatTree(nodes: TreeNode[]): string {
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      const files = node.fileCount === 1 ? "1 file" : `${node.fileCount} files`;
      const about =
        node.role === null ? "no access, shown as a path" : node.role ? `${files}, ${node.role}` : files;
      lines.push(`${"  ".repeat(depth)}- ${node.name} [${node.type}] id=${node.id} (${about})`);
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

/**
 * `user` says whose behalf Claude acts on: its tools can do what that user can,
 * and their changes are recorded as the agent's, acting for that user.
 */
export function createFileTools(
  storage: () => Storage | null,
  // With login on, the user must come from the chat run; until it does, no access.
  user: (storage: Storage) => Promise<string | null> = async (s) =>
    s.config.authSecret ? null : s.access.localUserId(),
  /** The run's working folder (./workdir.ts); adds save_file. */
  workdir?: string,
  /** About the chat run, for the provenance of runs Claude starts. */
  meta: RunMeta = {},
) {
  // Storage starts in the background; a call before it is ready (or after it
  // failed) gets a clear error instead of a crash.
  const run = async (fn: (session: Session) => Promise<ToolResult>) => {
    const current = storage();
    if (!current) return error("Workspace storage is unavailable right now.");
    try {
      const userId = await user(current);
      if (!userId) return error("The user is not signed in, so the workspace is unavailable.");
      const principal: Principal = { userId, actor: "agent" };
      return await fn(current.session(principal));
    } catch (err) {
      if (err instanceof ReadOnlyFileError) {
        return error(`${err.path} is read-only: it can't be changed or deleted.`);
      }
      if (err instanceof NodeError && err.message === "Node not found") {
        return error("No such knowledge node (or the user can't see it). Call list_nodes.");
      }
      if (
        err instanceof InvalidPathError ||
        err instanceof NodeError ||
        err instanceof ForbiddenError ||
        err instanceof AccessError ||
        err instanceof ExperimentError ||
        err instanceof SearchError ||
        err instanceof ProposalError
      ) {
        return error(err.message);
      }
      console.error("[storage] tool failed:", err);
      return error("Workspace storage error.");
    }
  };
  /** Files of `experiment`, else of `node` (root when both are omitted). */
  const inPlace = (
    place: { node?: string; experiment?: string },
    fn: (files: FilesSession) => Promise<ToolResult>,
  ) =>
    run(async (session) =>
      fn(
        place.experiment
          ? await session.experimentFiles(place.experiment)
          : await session.files(place.node || null),
      ),
    );

  /** Writes (or, in a node or for skills, proposes) a file as write_file describes. */
  const store = async (
    session: Session,
    path: string,
    bytes: Uint8Array,
    place: { node?: string; experiment?: string },
    summary?: string,
  ): Promise<ToolResult> => {
    // Claude may suggest skills but not add or change them itself: the
    // workspace's skills shape every later run (issue #7).
    const skillFile =
      !place.experiment && !place.node && kindForPath(normalizePath(path)) === "skill";
    if (!place.experiment && (place.node || skillFile)) {
      const proposal = await session.propose(place.node || null, path, bytes, { note: summary });
      return text({
        ok: true,
        proposed: true,
        path: proposal.path,
        node: proposal.node,
        newFile: proposal.isNew,
        note:
          "Proposed for review, not written yet: someone who can edit " +
          (skillFile ? "the workspace" : "this node") +
          " accepts or rejects it in the editor. Tell the user.",
      });
    }
    const service = place.experiment
      ? await session.experimentFiles(place.experiment)
      : await session.files(null);
    const existed = Boolean(await service.stat(path));
    const info = await service.write(path, bytes);
    return text({
      ok: true,
      path: info.path,
      node: service.nodeId,
      experiment: service.experimentId,
      created: !existed,
    });
  };

  return [
    tool(
      "list_nodes",
      "Show the knowledge tree: its levels (e.g. tech › module › loop › process) and " +
        "the nodes the user can see, with id, number of files and the user's role " +
        "(viewer can read, editor can also write files and add nodes, owner can also delete nodes). Files live " +
        "at the workspace root or in a node.",
      {},
      () =>
        run(async (session) => {
          const { types, nodes } = await session.tree();
          return text(
            `Levels: ${types.map((t) => t.name).join(" › ")}\n` +
              (nodes.length ? formatTree(nodes) : "(no nodes yet)"),
          );
        }),
    ),
    tool(
      "create_node",
      "Add a node to the knowledge tree under a parent (omit parentId for the top " +
        "level). Its level is the one below the parent's.",
      {
        parentId: z.string().optional().describe("Parent node id; omit for the top level."),
        name: z.string().describe("e.g. Etch, Module 3, Endpoint control"),
      },
      ({ parentId, name }) =>
        run(async (session) => {
          const node = await session.createNode(parentId || null, name);
          return text({ ok: true, id: node.id, name: node.name, type: node.type });
        }),
    ),
    tool(
      "list_files",
      "List the files at the workspace root, in one knowledge node or in one experiment, " +
        "with kind (note, skill, upload, artifact), size in bytes and who last wrote it.",
      { node: nodeParam, experiment: experimentParam },
      (place) =>
        inPlace(place, async (service) =>
          text(
            (await service.list()).map((f) => ({
              path: f.path,
              kind: f.kind,
              mime: f.mime,
              size: f.size,
              lastWrittenBy: f.author,
              updatedAt: f.updatedAt,
              ...(f.readOnly ? { readOnly: true } : {}),
            })),
          ),
        ),
    ),
    tool(
      "read_file",
      "Read a workspace file by path (in a knowledge node or experiment when given). " +
        "Each line starts with its line number and a tab, for citing lines; the " +
        "numbers are not part of the file. A read returns at most " +
        `${MAX_READ_CHARS} characters; when a file is longer, the first line says which ` +
        "lines you got and the offset to continue from. Use offset and limit to read " +
        "part of a file, e.g. the lines around a passage search_files found.",
      {
        path: z.string().describe("Workspace path, e.g. notes/welcome.md"),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Line number to start reading from (1-based). Defaults to 1."),
        column: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Character in the offset line to start from (1-based), for continuing a line " +
              "too long for one read. Defaults to 1.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Most lines to return. Defaults to as many as fit in one read."),
        node: nodeParam,
        experiment: experimentParam,
      },
      ({ path, offset, column, limit, ...place }) =>
        inPlace(place, async (service) => {
          const file = await service.read(path);
          if (!file) return error(`No file at ${path}`);
          const { info } = file;
          if (!isTextFile(info.path, info.mime)) {
            return text({
              path: info.path,
              mime: info.mime,
              size: info.size,
              note: "Binary file; content not readable as text.",
            });
          }
          const content = new TextDecoder().decode(file.bytes);
          return text(readLines(info.path, content, { offset, column, limit }));
        }),
    ),
    tool(
      "search_files",
      "Search the text and paths of every workspace file the user can read: the root, all " +
        "knowledge nodes and the experiments they can see. Matches whole words (and their " +
        "forms: etch finds etching), exact text (part numbers) and, when available, passages " +
        "close in meaning (match: \"meaning\"), so describe what you're after in plain words. " +
        "\"Quotes\" or -word ask for exact words only. " +
        "Each result has the place to pass to read_file (node or experiment) and the passage " +
        "that matched. Use it to find what the workspace already knows before answering or " +
        "writing.",
      {
        query: z
          .string()
          .describe('Words to find, e.g. etch rate drift; "quotes" for a phrase, -word to exclude.'),
        scope: z
          .string()
          .optional()
          .describe("Knowledge node id: search only it, the nodes below it and their experiments."),
        node: z
          .string()
          .optional()
          .describe("Where the user is (the context's currentNode), so nearby files rank first."),
        experiment: experimentParam.describe(
          "The context's currentExperiment, if any, so its node's neighborhood ranks first.",
        ),
        limit: z.number().int().min(1).max(50).optional().describe("Most results (default 20)."),
      },
      ({ query, scope, node, experiment, limit }) =>
        run(async (session) => {
          const hits = await session.search({
            query,
            scope: scope || null,
            near: node || null,
            nearExperiment: experiment || null,
            limit,
          });
          if (!hits.length) return text(`No files match ${JSON.stringify(query)}.`);
          return text(
            hits.map((h) => ({
              path: h.path,
              node: h.node,
              experiment: h.experiment,
              where: [
                ...(h.where.length ? h.where : ["(workspace root)"]),
                ...(h.experimentTitle ? [`experiment: ${h.experimentTitle}`] : []),
              ].join(" › "),
              match: h.match,
              snippet: h.snippet || "(matched by path)",
              updatedAt: h.updatedAt,
            })),
          );
        }),
    ),
    tool(
      "write_file",
      "Create or overwrite a workspace file with the COMPLETE new content (no line " +
        "numbers), at the workspace root, in a knowledge node or in an experiment. Write " +
        "where the user is working (the context's currentExperiment, else currentNode) " +
        "unless they say otherwise; inside an experiment, never write to its node. At the " +
        "root and in an experiment the file changes at once and opens for the user. In a " +
        "knowledge node, and for skills (skills/<name>/... at the root), it is PROPOSED " +
        "instead: the file stays as it was until someone who can edit there accepts the " +
        "change (writing the same file again revises your proposal). Put new generated documents under " +
        "artifacts/ (in the run, when the user is in one), unless the user asks to change an existing file. Paths starting with notes/, " +
        "skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is listed. " +
        "Every write is kept as a version. Read-only files (readOnly in list_files) can't be " +
        "written.",
      {
        path: z.string().describe("e.g. artifacts/summary.md"),
        content: z.string().describe("The full file content (markdown for .md files)."),
        node: nodeParam,
        experiment: experimentParam,
        summary: z
          .string()
          .optional()
          .describe("One line on what changed and why; shown to whoever reviews a proposal."),
      },
      ({ path, content, summary, ...place }) =>
        run((session) => store(session, path, new TextEncoder().encode(content), place, summary)),
    ),
    ...(workdir
      ? [
          tool(
            "save_file",
            "Save a file from the working folder (one a script made, e.g. out/plot.png or a CSV) " +
              "into the workspace, with the same rules as write_file: where the user is working " +
              "unless they say otherwise, PROPOSED in a knowledge node or for skills, kept as a " +
              "version, never over a read-only file. Use write_file for text you write yourself.",
            {
              from: z.string().describe("Path in the working folder, e.g. out/plot.png"),
              path: z.string().describe("Workspace path to save it as, e.g. artifacts/plot.png"),
              node: nodeParam,
              experiment: experimentParam,
              summary: z
                .string()
                .optional()
                .describe("One line on what changed and why; shown to whoever reviews a proposal."),
            },
            ({ from, path, summary, ...place }) =>
              run(async (session) => {
                const source = resolve(workdir, from);
                if (!(await isInside(workdir, source))) return error(`${from} is not in the working folder.`);
                if (await isInside(join(workdir, ".claude"), source)) return error("Skills can't be saved from here.");
                const info = await stat(source).catch(() => null);
                if (!info?.isFile()) return error(`No file at ${from} in the working folder.`);
                const max = storage()?.config.maxUploadBytes ?? 0;
                if (max && info.size > max) return error(`${from} is larger than uploads may be (${max} bytes).`);
                return store(session, path, new Uint8Array(await readFile(source)), place, summary);
              }),
          ),
        ]
      : []),
    tool(
      "propose_experiment",
      "Propose an experiment's work to its knowledge node: each file the experiment " +
        "changed or added (or only those in `paths`) becomes a proposed version on the " +
        "node, for someone who can edit the node to accept or reject. Only when the user " +
        "asks to bring an experiment's results back to its node; only its author can.",
      {
        experiment: z.string().describe("Experiment id"),
        paths: z.array(z.string()).optional().describe("Only these files; omit for every changed file."),
        note: z.string().optional().describe("Why these changes belong in the node, in a line or two."),
      },
      ({ experiment, paths, note }) =>
        run(async (session) => {
          const proposals = await session.promote(experiment, paths, note);
          return text({
            ok: true,
            proposed: proposals.map((p) => ({ path: p.path, newFile: p.isNew })),
            node: proposals[0]?.node,
            note: "Waiting for someone who can edit the node to accept or reject them.",
          });
        }),
    ),
    tool(
      "list_experiments",
      "List the experiments (runs) the user can see, on one knowledge node or (without node) " +
        "anywhere: id, title, node (null = at the workspace root), status (draft = only its " +
        "author sees it, shared, archived), state (ready, running, done, failed), author, " +
        "hypothesis, params and results. Use it to compare experiments on a node.",
      { node: nodeParam },
      ({ node }) =>
        run(async (session) => {
          const list = await session.experiments(node || undefined);
          return text(
            list.length
              ? list.map((e) => ({
                  id: e.id,
                  node: e.nodeId,
                  title: e.title,
                  status: e.status,
                  state: e.state,
                  author: e.authorName,
                  canChange: e.access === "writer",
                  hypothesis: e.hypothesis,
                  params: e.params,
                  results: e.results,
                  files: e.fileCount,
                  forkedAt: e.forkedAt,
                }))
              : "(no experiments)",
          );
        }),
    ),
    tool(
      "create_experiment",
      "Start a run (an experiment) for the user: a private draft on a knowledge node (usually " +
        "a process) with a copy of the node's files, where changes don't touch the node; or, " +
        "without node, at the workspace root, starting empty. Only when the user asks to try, " +
        "explore, analyze or run something. List the files it works from as `inputs`: each is " +
        "linked in read only under inputs/ at its current version, so the run keeps exactly what " +
        "it read. The run starts in state running with a report.md whose front matter records " +
        "where it came from (who, this chat, model, skill, input versions); write the report " +
        "below the front matter. Work in it by passing its id as `experiment` to the file tools, " +
        "and finish with set_experiment_results. To run an earlier run again, pass rerunOf " +
        "instead of changing it.",
      {
        node: z.string().optional().describe("Knowledge node id to fork; omit for the workspace root."),
        title: z.string().optional().describe("Short name, e.g. 'Lower RF power, 40 W'; required unless rerunOf."),
        hypothesis: z.string().optional().describe("What the user expects and why."),
        params: jsonObject.optional().describe('What is varied, e.g. {"rfPower_W": 40}'),
        inputs: z
          .array(
            z.object({
              path: z.string().describe("The file's path, e.g. uploads/wafer-map.csv"),
              node: z.string().optional().describe("Its knowledge node; omit for the workspace root."),
              experiment: z.string().optional().describe("Its experiment, if it is in one."),
              as: z.string().optional().describe("Name under inputs/; defaults to its file name."),
            }),
          )
          .optional()
          .describe("Files the run reads (uploads, data, earlier results); the user must be able to read each."),
        skill: z.string().optional().describe("The skill this run follows, if any, e.g. analysis."),
        rerunOf: z
          .string()
          .optional()
          .describe(
            "Run this earlier run (experiment id) again as a new run: its place, params, hypothesis and " +
              "the exact input versions it read are reused unless given here. The old run is left as it is.",
          ),
      },
      ({ node, inputs, skill, rerunOf, ...input }) =>
        run(async (session) => {
          const provenance = {
            chat: meta.chat ?? null,
            model: meta.model ?? null,
            ...(skill ? { skill: skillProvenance(skill, meta.skills) } : {}),
            tools: TOOL_VERSIONS,
          };
          const created = rerunOf
            ? await session.rerun(rerunOf, { ...input, inputs }, provenance)
            : await session.startRun(node || null, input, inputs, provenance);
          return text({
            ok: true,
            id: created.id,
            title: created.title,
            state: created.state,
            files: created.fileCount,
            inputs: (created.provenance.inputs as { path: string }[]).map((i) => i.path),
            report: "report.md",
          });
        }),
    ),
    tool(
      "set_experiment_results",
      "Record a run's results and finish it: state done, or failed when it couldn't be " +
        "completed (say why in its report). Results replace the old ones whole, as numbers with " +
        "units in the key where you can, e.g. {\"yield_pct\": 92.5}. Also refreshes the record " +
        "in its report.md front matter. Only for runs the user authored.",
      {
        id: z.string().describe("Experiment id"),
        results: jsonObject.describe('e.g. {"etchRate_nm_min": 41.2, "uniformity_pct": 3.1}'),
        state: z.enum(["done", "failed"]).optional().describe("Defaults to done."),
      },
      ({ id, results, state }) =>
        run(async (session) => {
          const finished = await session.finishRun(id, results, state ?? "done");
          return text({ ok: true, id: finished.id, state: finished.state, results: finished.results });
        }),
    ),
    tool(
      "update_experiment",
      "Change an experiment the user authored: title, hypothesis or params (each replaces " +
        "the old value whole, so send the complete object), or its status. Record results and " +
        "finish a run with set_experiment_results instead. Only change status (shared shows it to everyone who can see the node; archived makes " +
        "it read only) when the user asks.",
      {
        id: z.string().describe("Experiment id"),
        title: z.string().optional(),
        hypothesis: z.string().optional(),
        params: jsonObject.optional(),
        status: z.enum(["draft", "shared", "archived"]).optional(),
      },
      ({ id, ...input }) =>
        run(async (session) => {
          const updated = await session.updateExperiment(id, input);
          return text({ ok: true, id: updated.id, status: updated.status, state: updated.state });
        }),
    ),
  ];
}
