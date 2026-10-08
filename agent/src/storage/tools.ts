/**
 * Workspace file tools for Claude, served by the agent itself (in-process MCP)
 * so they work whether or not a browser tab is open. Writes are recorded as
 * the agent's versions, and the UI hears about them through the /files change
 * stream (it opens files Claude writes).
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { AccessError, ForbiddenError, type Principal } from "./access";
import type { Storage } from "./index";
import { ReadOnlyFileError } from "./files";
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
        err instanceof AccessError
      ) {
        return error(err.message);
      }
      console.error("[storage] tool failed:", err);
      return error("Workspace storage error.");
    }
  };
  /** Files of `node` (root when omitted). */
  const inNode = (node: string | undefined, fn: (files: FilesSession) => Promise<ToolResult>) =>
    run(async (session) => fn(await session.files(node || null)));

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
      "List the files at the workspace root or in one knowledge node, with kind " +
        "(note, skill, upload, artifact), size in bytes and who last wrote it.",
      { node: nodeParam },
      ({ node }) =>
        inNode(node, async (service) =>
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
      "Read a workspace file by path (in a knowledge node when `node` is given). " +
        "Each line starts with its line number and a tab, for citing lines; the " +
        "numbers are not part of the file.",
      { path: z.string().describe("Workspace path, e.g. notes/welcome.md"), node: nodeParam },
      ({ path, node }) =>
        inNode(node, async (service) => {
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
        "numbers), at the workspace root or in a knowledge node. Write where the user " +
        "is working (the context's currentNode) unless they say otherwise. It opens " +
        "for the user automatically. Put new generated documents in the focused run's " +
        "artifacts/ folder (<run>/artifacts/, see `run` in context), or under " +
        "artifacts/ when there is no run, unless the user asks to change an existing " +
        "file. Paths starting with notes/, skills/<name>/SKILL.md, uploads/ or " +
        "artifacts/ decide where the file is listed. Every write is kept as a version. " +
        "Read-only files (readOnly in list_files) can't be written.",
      {
        path: z.string().describe("e.g. runs/etch-2026-10-01/artifacts/summary.md"),
        content: z.string().describe("The full file content (markdown for .md files)."),
        node: nodeParam,
      },
      ({ path, content, node }) =>
        inNode(node, async (service) => {
          const existed = Boolean(await service.stat(path));
          const info = await service.write(path, new TextEncoder().encode(content));
          return text({ ok: true, path: info.path, node: service.nodeId, created: !existed });
        }),
    ),
  ];
}
