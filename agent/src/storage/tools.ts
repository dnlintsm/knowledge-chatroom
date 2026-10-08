/**
 * Workspace file tools for Claude, served by the agent itself (in-process MCP)
 * so they work whether or not a browser tab is open. Writes are recorded as
 * the agent's versions, and the UI hears about them through the /files change
 * stream (it opens files Claude writes).
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { FileService } from "./files";
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

export function createFileTools(files: () => FileService | null) {
  // Storage starts in the background; a call before it is ready (or after it
  // failed) gets a clear error instead of a crash.
  const run = async (fn: (service: FileService) => Promise<ToolResult>) => {
    const service = files();
    if (!service) return error("Workspace storage is unavailable right now.");
    try {
      return await fn(service);
    } catch (err) {
      if (err instanceof InvalidPathError) return error(err.message);
      console.error("[storage] tool failed:", err);
      return error("Workspace storage error.");
    }
  };

  return [
    tool(
      "list_files",
      "List every file in the user's workspace with its kind (note, skill, upload, " +
        "artifact), size in bytes and who last wrote it.",
      {},
      () =>
        run(async (service) =>
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
      "Read a workspace file by path. Each line starts with its line number and a " +
        "tab, for citing lines; the numbers are not part of the file.",
      { path: z.string().describe("Workspace path, e.g. notes/welcome.md") },
      ({ path }) =>
        run(async (service) => {
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
        "numbers). It opens for the user automatically. Put new generated documents " +
        "in the focused run's artifacts/ folder (<run>/artifacts/, see `run` in " +
        "context), or under artifacts/ when there is no run, unless the user asks " +
        "to change an existing file. Paths " +
        "starting with notes/, skills/<name>/SKILL.md, uploads/ or artifacts/ decide " +
        "where the file is listed. Every write is kept as a version.",
      {
        path: z.string().describe("e.g. runs/etch-2026-10-01/artifacts/summary.md"),
        content: z.string().describe("The full file content (markdown for .md files)."),
      },
      ({ path, content }) =>
        run(async (service) => {
          const existed = Boolean(await service.stat(path));
          const info = await service.write(path, new TextEncoder().encode(content), {
            author: "agent",
          });
          return text({ ok: true, path: info.path, created: !existed });
        }),
    ),
  ];
}
