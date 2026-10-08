"use client";

import { useRef } from "react";
import { z } from "zod";
import { useAgentContext, useFrontendTool } from "@copilotkit/react-core/v2";
import { useActions } from "./actions";
import { numberLines } from "./file-refs";
import { normalizePath, useWorkspace } from "./store";
import { isInRun, normalizeRunDir, RUN_REPORT } from "./runs";
import { isTextFile, TASKS_TAB } from "./types";
import { useWorkbench } from "./workbench";

/** Keeps context small: the agent can always call readWorkspaceFile for more. */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * Connects the workspace to Claude:
 * - context: the open file, the user's selection, and the file list, sent with
 *   every run so "summarize this" or "rewrite the selected part" just works;
 * - frontend tools: list / read / write / open files, open the task board, and
 *   the workbench: show or hide panes, list and focus runs, list and run the
 *   current run's actions (only those marked agentInvocable, with the user's
 *   role, through the same runner as the Actions block).
 *
 * With server storage the agent has its own list / read / write tools (they
 * work without this tab), so the browser's copies are switched off and the
 * store's change stream opens files Claude writes. Without it, these browser
 * tools write straight into the local workspace. Either way file content
 * reaches Claude with numbered lines, so its answers can cite them (see
 * file-refs.ts).
 */
export function useWorkspaceAgent() {
  const ws = useWorkspace();
  const workbench = useWorkbench();
  // Tools register once and read the latest workspace and workbench through these refs.
  const latest = useRef(ws);
  latest.current = ws;
  const latestWorkbench = useRef(workbench);
  latestWorkbench.current = workbench;
  const actions = useActions();
  const latestActions = useRef(actions);
  latestActions.current = actions;

  const open = ws.activeFile;
  const { runDir } = workbench;
  const report = runDir ? ws.getFile(`${runDir}/${RUN_REPORT}`) : undefined;
  // Only while files are browser-only; see the comment above.
  const browserFiles = ws.storageMode === "local";
  useAgentContext({
    description:
      "The user's knowledge workspace (shown beside the chat). `run` is the experiment run (RUN_DIR) the user is focused on: its folder, its files and its xDOE report; questions are about this run unless the user says otherwise, and files for it go inside its folder. `openFile` is the file in the middle pane, each line of its content starting with the line number and a tab (the numbers are not part of the file); `selection` is text the user highlighted in it. When the user says 'this', 'here' or 'the selection', they mean these.",
    value: {
      run: runDir
        ? {
            path: runDir,
            files: ws.files.filter((f) => isInRun(f.path, runDir)).map((f) => f.path),
            report: !report
              ? null
              : report.path === open?.path
                ? { path: report.path, content: "(the open file)" }
                : {
                    path: report.path,
                    content: numberLines(report.content.slice(0, MAX_CONTEXT_CHARS)),
                    truncated: report.content.length > MAX_CONTEXT_CHARS,
                  },
          }
        : null,
      openFile: open
        ? {
            path: open.path,
            kind: open.kind,
            content: isTextFile(open)
              ? numberLines(open.content.slice(0, MAX_CONTEXT_CHARS))
              : `(binary ${open.mime}, not shown)`,
            truncated: isTextFile(open) && open.content.length > MAX_CONTEXT_CHARS,
          }
        : ws.active === TASKS_TAB
          ? "The task board is open."
          : null,
      selection: ws.selection ? ws.selection.slice(0, MAX_CONTEXT_CHARS) : null,
      selectionTruncated: ws.selection.length > MAX_CONTEXT_CHARS,
      files: ws.files.map((f) => ({ path: f.path, kind: f.kind, by: f.author })),
    },
  });

  useFrontendTool({
    name: "listWorkspaceFiles",
    available: browserFiles,
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
        ...(f.readOnly ? { readOnly: true } : {}),
      })),
  }, [browserFiles]);

  useFrontendTool({
    name: "readWorkspaceFile",
    available: browserFiles,
    description:
      "Read the full content of a workspace file by path. Each line starts with its line number and a tab, for citing lines; the numbers are not part of the file.",
    parameters: z.object({ path: z.string().describe("Workspace path, e.g. notes/welcome.md") }),
    handler: async ({ path }) => {
      const file = latest.current.getFile(path);
      if (!file) return { error: `No file at ${path}` };
      if (!isTextFile(file)) return { path: file.path, mime: file.mime, note: "Binary file; content not readable as text." };
      return { path: file.path, content: numberLines(file.content) };
    },
  }, [browserFiles]);

  useFrontendTool({
    name: "writeWorkspaceFile",
    available: browserFiles,
    description:
      "Create or overwrite a workspace file with the COMPLETE new content (no line numbers), then open it for the user. Put new generated documents under artifacts/ unless the user asks to change an existing file. Paths starting with notes/, skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is listed.",
    parameters: z.object({
      path: z.string().describe("e.g. artifacts/summary.md"),
      content: z.string().describe("The full file content (markdown for .md files)."),
    }),
    handler: async ({ path, content }) => {
      const existing = latest.current.getFile(path);
      if (existing?.readOnly) return { error: `${existing.path} is read-only: it can't be changed or deleted.` };
      const existed = Boolean(existing);
      const file = latest.current.write(path, content, { author: "agent" });
      latestWorkbench.current.editor.open(file.path);
      return { ok: true, path: file.path, created: !existed };
    },
  }, [browserFiles]);

  useFrontendTool({
    name: "openWorkspaceFile",
    description: "Open a workspace file in the middle pane so the user can see it.",
    parameters: z.object({ path: z.string() }),
    handler: async ({ path }) => {
      if (!latest.current.getFile(path)) return { error: `No file at ${path}` };
      latestWorkbench.current.editor.open(normalizePath(path));
      return { ok: true };
    },
  });

  useFrontendTool({
    name: "openTaskBoard",
    description: "Open the shared todo board in the middle pane. Do this before adding or changing todos.",
    parameters: z.object({}),
    handler: async () => {
      latestWorkbench.current.editor.open(TASKS_TAB);
      return { ok: true };
    },
  });

  useFrontendTool({
    name: "showPane",
    description:
      "Show a pane of the workspace: 'explorer' (files and runs on the left), 'editor' (the middle pane) or 'chat'. On a phone this switches to that pane.",
    parameters: z.object({ pane: z.enum(["explorer", "editor", "chat"]) }),
    handler: async ({ pane }) => {
      latestWorkbench.current.panes.show(pane);
      return { ok: true };
    },
  });

  useFrontendTool({
    name: "hidePane",
    description:
      "Hide the explorer or the chat pane (the editor always stays). Hiding the chat keeps this conversation.",
    parameters: z.object({ pane: z.enum(["explorer", "chat"]) }),
    handler: async ({ pane }) => {
      latestWorkbench.current.panes.hide(pane);
      return { ok: true };
    },
  });

  useFrontendTool({
    name: "listRuns",
    description:
      "List every experiment run (RUN_DIR) in the workspace, and which one the user is focused on.",
    parameters: z.object({}),
    handler: async () => {
      const { runs, runDir } = latestWorkbench.current;
      return {
        current: runDir,
        runs: runs.map((r) => ({ path: r.path, files: r.fileCount, markers: r.markers })),
      };
    },
  });

  useFrontendTool({
    name: "focusRun",
    description:
      "Focus the workspace on another run (path from listRuns): the panes and this chat then work on it, and its report opens.",
    parameters: z.object({ path: z.string().describe("Run folder, e.g. runs/etch-2026-10-01") }),
    handler: async ({ path }) => {
      const wb = latestWorkbench.current;
      const run = wb.runs.find((r) => r.path === normalizeRunDir(path));
      if (!run) return { error: `No run at ${path}. Call listRuns for the runs there are.` };
      wb.run.focus(run.path);
      return { ok: true, run: run.path };
    },
  });

  useFrontendTool({
    name: "listActions",
    description:
      "List the actions for the current run (the buttons in its Actions block): id, label, what it does, whether it can run now, and whether you may run it.",
    parameters: z.object({}),
    handler: async () => {
      const { items } = latestActions.current;
      if (!items.length) return { error: "No run is focused, so there are no actions." };
      return items.map(({ def, view }) => ({
        id: def.id,
        label: view.label,
        description: def.description,
        enabled: view.enabled,
        ...(view.hint && !view.enabled ? { why: view.hint } : {}),
        youMayRun: def.agentInvocable,
      }));
    },
  });

  useFrontendTool({
    name: "runAction",
    description:
      "Run one of the current run's actions by id (from listActions), as if the user clicked it, with the user's permissions. Only actions marked youMayRun.",
    parameters: z.object({ id: z.string().describe("e.g. generate-rules") }),
    handler: async ({ id }) => {
      const result = await latestActions.current.run(id, "agent");
      return result.ok ? { ok: true, id } : { error: result.error };
    },
  });
}
