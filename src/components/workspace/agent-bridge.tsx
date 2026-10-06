"use client";

import { useRef } from "react";
import { z } from "zod";
import { useAgentContext, useFrontendTool } from "@copilotkit/react-core/v2";
import { normalizePath, useWorkspace } from "./store";
import { isTextFile, TASKS_TAB } from "./types";

/** Keeps context small: the agent can always call readWorkspaceFile for more. */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * Connects the workspace to Claude:
 * - context: the open file, the user's selection, and the file list, sent with
 *   every run so "summarize this" or "rewrite the selected part" just works;
 * - frontend tools: list / read / write / open files, and open the task board.
 *
 * Tools run in the browser, so files Claude writes land straight in the
 * workspace (and open in the middle pane).
 */
export function useWorkspaceAgent() {
  const ws = useWorkspace();
  // Tools register once and read the latest workspace through this ref.
  const latest = useRef(ws);
  latest.current = ws;

  const open = ws.activeFile;
  useAgentContext({
    description:
      "The user's knowledge workspace (shown beside the chat). `openFile` is the file in the middle pane; `selection` is text the user highlighted in it. When the user says 'this', 'here' or 'the selection', they mean these.",
    value: {
      openFile: open
        ? {
            path: open.path,
            kind: open.kind,
            content: isTextFile(open)
              ? open.content.slice(0, MAX_CONTEXT_CHARS)
              : `(binary ${open.mime}, not shown)`,
            truncated: isTextFile(open) && open.content.length > MAX_CONTEXT_CHARS,
          }
        : ws.active === TASKS_TAB
          ? "The task board is open."
          : null,
      selection: ws.selection || null,
      files: ws.files.map((f) => ({ path: f.path, kind: f.kind, by: f.author })),
    },
  });

  useFrontendTool({
    name: "listWorkspaceFiles",
    description:
      "List every file in the user's workspace with its kind (note, skill, upload, artifact), size and who last wrote it.",
    parameters: z.object({}),
    handler: async () =>
      latest.current.files.map((f) => ({
        path: f.path,
        kind: f.kind,
        mime: f.mime,
        size: f.content.length,
        lastWrittenBy: f.author,
      })),
  });

  useFrontendTool({
    name: "readWorkspaceFile",
    description: "Read the full content of a workspace file by path.",
    parameters: z.object({ path: z.string().describe("Workspace path, e.g. notes/welcome.md") }),
    handler: async ({ path }) => {
      const file = latest.current.getFile(path);
      if (!file) return { error: `No file at ${path}` };
      if (!isTextFile(file)) return { path: file.path, mime: file.mime, note: "Binary file; content not readable as text." };
      return { path: file.path, content: file.content };
    },
  });

  useFrontendTool({
    name: "writeWorkspaceFile",
    description:
      "Create or overwrite a workspace file with the COMPLETE new content, then open it for the user. Put new generated documents under artifacts/ unless the user asks to change an existing file. Paths starting with notes/, skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is listed.",
    parameters: z.object({
      path: z.string().describe("e.g. artifacts/summary.md"),
      content: z.string().describe("The full file content (markdown for .md files)."),
    }),
    handler: async ({ path, content }) => {
      const existed = Boolean(latest.current.getFile(path));
      const file = latest.current.write(path, content, { author: "agent" });
      latest.current.open(file.path);
      return { ok: true, path: file.path, created: !existed };
    },
  });

  useFrontendTool({
    name: "openWorkspaceFile",
    description: "Open a workspace file in the middle pane so the user can see it.",
    parameters: z.object({ path: z.string() }),
    handler: async ({ path }) => {
      if (!latest.current.getFile(path)) return { error: `No file at ${path}` };
      latest.current.open(normalizePath(path));
      return { ok: true };
    },
  });

  useFrontendTool({
    name: "openTaskBoard",
    description: "Open the shared todo board in the middle pane. Do this before adding or changing todos.",
    parameters: z.object({}),
    handler: async () => {
      latest.current.open(TASKS_TAB);
      return { ok: true };
    },
  });
}
