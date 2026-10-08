/**
 * Workspace file tools for Claude, served by the agent itself (in-process MCP)
 * so they work whether or not a browser tab is open. Writes are recorded as
 * the agent's versions, and the UI hears about them through the /files change
 * stream (it opens files Claude writes).
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { FileService } from "./files";
import type { Storage } from "./index";
import { NodeError, type KnowledgeNode } from "./nodes";
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

/** The tree as indented lines, e.g. `- Etch [tech] id=… (3 files)`. */
export function formatTree(nodes: KnowledgeNode[]): string {
  const children = new Map<string | null, KnowledgeNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      const files = node.fileCount === 1 ? "1 file" : `${node.fileCount} files`;
      lines.push(`${"  ".repeat(depth)}- ${node.name} [${node.type}] id=${node.id} (${files})`);
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

export function createFileTools(storage: () => Storage | null) {
  // Storage starts in the background; a call before it is ready (or after it
  // failed) gets a clear error instead of a crash.
  const run = async (fn: (storage: Storage) => Promise<ToolResult>) => {
    const current = storage();
    if (!current) return error("Workspace storage is unavailable right now.");
    try {
      return await fn(current);
    } catch (err) {
      if (err instanceof InvalidPathError || err instanceof NodeError) return error(err.message);
      console.error("[storage] tool failed:", err);
      return error("Workspace storage error.");
    }
  };
  /** Files of `node` (root when omitted). */
  const inNode = (node: string | undefined, fn: (service: FileService) => Promise<ToolResult>) =>
    run(async (current) => {
      const service = await current.files.inNode(node || null);
      if (!service) return error(`No knowledge node with id ${node}. Call list_nodes.`);
      return fn(service);
    });

  return [
    tool(
      "list_nodes",
      "Show the knowledge tree: its levels (e.g. tech › module › loop › process) and " +
        "every node with its id and number of files. Files live at the workspace root " +
        "or in a node.",
      {},
      () =>
        run(async (current) => {
          const [types, nodes] = await Promise.all([current.nodes.types(), current.nodes.list()]);
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
        run(async (current) => {
          const node = await current.nodes.create(parentId || null, name);
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
        "for the user automatically. Put new generated documents under artifacts/ " +
        "unless the user asks to change an existing file. Paths starting with notes/, " +
        "skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is " +
        "listed. Every write is kept as a version.",
      {
        path: z.string().describe("e.g. artifacts/summary.md"),
        content: z.string().describe("The full file content (markdown for .md files)."),
        node: nodeParam,
      },
      ({ path, content, node }) =>
        inNode(node, async (service) => {
          const existed = Boolean(await service.stat(path));
          const info = await service.write(path, new TextEncoder().encode(content), {
            author: "agent",
          });
          return text({ ok: true, path: info.path, node: service.nodeId, created: !existed });
        }),
    ),
  ];
}
