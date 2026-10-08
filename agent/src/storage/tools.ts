/**
 * Workspace file tools for Claude, served by the agent itself (in-process MCP)
 * so they work whether or not a browser tab is open. Writes are recorded as
 * the agent's versions, and the UI hears about them through the /files change
 * stream (it opens files Claude writes).
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { AccessError, ForbiddenError, type Principal } from "./access";
import { ExperimentError } from "./experiments";
import type { Storage } from "./index";
import { NodeError, type KnowledgeNode } from "./nodes";
import type { FilesSession, Session } from "./session";
import { InvalidPathError, isTextFile } from "./paths";

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
      if (err instanceof NodeError && err.message === "Node not found") {
        return error("No such knowledge node (or the user can't see it). Call list_nodes.");
      }
      if (
        err instanceof InvalidPathError ||
        err instanceof NodeError ||
        err instanceof ForbiddenError ||
        err instanceof AccessError ||
        err instanceof ExperimentError
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
            })),
          ),
        ),
    ),
    tool(
      "read_file",
      "Read a workspace file by path (in a knowledge node or experiment when given). " +
        "Each line starts with its line number and a tab, for citing lines; the " +
        "numbers are not part of the file.",
      {
        path: z.string().describe("Workspace path, e.g. notes/welcome.md"),
        node: nodeParam,
        experiment: experimentParam,
      },
      ({ path, ...place }) =>
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
          const truncated = content.length > MAX_READ_CHARS;
          return text(
            `${info.path}${truncated ? ` (first ${MAX_READ_CHARS} characters)` : ""}\n` +
              numberLines(content.slice(0, MAX_READ_CHARS)),
          );
        }),
    ),
    tool(
      "write_file",
      "Create or overwrite a workspace file with the COMPLETE new content (no line " +
        "numbers), at the workspace root, in a knowledge node or in an experiment. Write " +
        "where the user is working (the context's currentExperiment, else currentNode) " +
        "unless they say otherwise; inside an experiment, never write to its node. It opens " +
        "for the user automatically. Put new generated documents under artifacts/ " +
        "unless the user asks to change an existing file. Paths starting with notes/, " +
        "skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is " +
        "listed. Every write is kept as a version.",
      {
        path: z.string().describe("e.g. artifacts/summary.md"),
        content: z.string().describe("The full file content (markdown for .md files)."),
        node: nodeParam,
        experiment: experimentParam,
      },
      ({ path, content, ...place }) =>
        inPlace(place, async (service) => {
          const existed = Boolean(await service.stat(path));
          const info = await service.write(path, new TextEncoder().encode(content));
          return text({
            ok: true,
            path: info.path,
            node: service.nodeId,
            experiment: service.experimentId,
            created: !existed,
          });
        }),
    ),
    tool(
      "list_experiments",
      "List the experiments the user can see, on one knowledge node or (without node) " +
        "anywhere: id, title, status (draft = only its author sees it, shared, archived), " +
        "author, hypothesis, params and results. Use it to compare experiments on a node.",
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
      "Start an experiment on a knowledge node (usually a process) for the user: a private " +
        "draft with a copy of the node's files, where changes don't touch the node. Only when " +
        "the user asks to try or explore something as an experiment. Then work in it by " +
        "passing its id as `experiment` to the file tools.",
      {
        node: z.string().describe("Knowledge node id to fork."),
        title: z.string().describe("Short name, e.g. 'Lower RF power, 40 W'"),
        hypothesis: z.string().optional().describe("What the user expects and why."),
        params: jsonObject.optional().describe('What is varied, e.g. {"rfPower_W": 40}'),
      },
      ({ node, ...input }) =>
        run(async (session) => {
          const created = await session.createExperiment(node, input);
          return text({ ok: true, id: created.id, title: created.title, files: created.fileCount });
        }),
    ),
    tool(
      "update_experiment",
      "Change an experiment the user authored: title, hypothesis, params or results (each " +
        "replaces the old value whole, so send the complete object), or its status. Record " +
        "results as numbers with units in the key where you can, e.g. {\"yield_pct\": 92.5}. " +
        "Only change status (shared shows it to everyone who can see the node; archived makes " +
        "it read only) when the user asks.",
      {
        id: z.string().describe("Experiment id"),
        title: z.string().optional(),
        hypothesis: z.string().optional(),
        params: jsonObject.optional(),
        results: jsonObject.optional(),
        status: z.enum(["draft", "shared", "archived"]).optional(),
      },
      ({ id, ...input }) =>
        run(async (session) => {
          const updated = await session.updateExperiment(id, input);
          return text({ ok: true, id: updated.id, status: updated.status });
        }),
    ),
  ];
}
