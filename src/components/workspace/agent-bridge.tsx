"use client";

import { useRef } from "react";
import { z } from "zod";
import { useAgentContext, useFrontendTool, type JsonSerializable } from "@copilotkit/react-core/v2";
import { numberLines } from "./file-refs";
import { normalizePath, useWorkspace } from "./store";
import { isInRun, RUN_REPORT } from "./runs";
import { isTextFile, TASKS_TAB } from "./types";
import { useWorkbench } from "./workbench";

/** Keeps context small: the agent can always call readWorkspaceFile for more. */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * Connects the workspace to Claude:
 * - context: the open file, the user's selection, and the file list, sent with
 *   every run so "summarize this" or "rewrite the selected part" just works;
 * - frontend tools: list / read / write / open files, and open the task board.
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

  const open = ws.activeFile;
  const { runDir } = workbench;
  const report = runDir ? ws.getFile(`${runDir}/${RUN_REPORT}`) : undefined;
  // Only while files are browser-only; see the comment above.
  const browserFiles = ws.storageMode === "local";
  useAgentContext({
    description:
      "The user's knowledge workspace (shown beside the chat). `openFile` is the file in the middle pane, each line of its content starting with the line number and a tab (the numbers are not part of the file); `selection` is text the user highlighted in it. When the user says 'this', 'here' or 'the selection', they mean these. `currentNode` is where in the knowledge tree the user is (null = the workspace root); `currentExperiment`, when set, is the experiment on that node the user is working in; `files` are the files where the user is. `run` is the experiment run (RUN_DIR, a folder among those files) the user is focused on: its folder, its files and its xDOE report; questions are about this run unless the user says otherwise, and files for it go inside its folder.",
    value: {
      currentNode: ws.node
        ? {
            id: ws.node,
            path: ws.lineage.map((n) => `${n.name} (${n.type})`).join(" › "),
            ancestors: ws.lineage.slice(0, -1).map((n) => ({ id: n.id, name: n.name, type: n.type })),
          }
        : null,
      currentExperiment: ws.experiment
        ? {
            id: ws.experiment.id,
            title: ws.experiment.title,
            status: ws.experiment.status,
            author: ws.experiment.mine ? "the user" : ws.experiment.authorName,
            canChange: ws.experiment.access === "writer",
            hypothesis: ws.experiment.hypothesis,
            // Plain JSON from the server.
            params: ws.experiment.params as JsonSerializable,
            results: ws.experiment.results as JsonSerializable,
          }
        : null,
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
      "Create or overwrite a workspace file with the COMPLETE new content (no line numbers), then open it for the user. Put new generated documents in the focused run's artifacts/ folder (<run>/artifacts/, see `run` in context), or under artifacts/ when there is no run, unless the user asks to change an existing file. Paths starting with notes/, skills/<name>/SKILL.md, uploads/ or artifacts/ decide where the file is listed.",
    parameters: z.object({
      path: z.string().describe("e.g. runs/etch-2026-10-01/artifacts/summary.md"),
      content: z.string().describe("The full file content (markdown for .md files)."),
    }),
    handler: async ({ path, content }) => {
      const existed = Boolean(latest.current.getFile(path));
      const file = latest.current.write(path, content, { author: "agent" });
      latestWorkbench.current.editor.open(file.path);
      return { ok: true, path: file.path, created: !existed };
    },
  }, [browserFiles]);

  useFrontendTool({
    name: "openWorkspaceFile",
    description:
      "Open a workspace file in the middle pane so the user can see it. Give `node` or `experiment` to open a file in another knowledge node or experiment; the user's view moves there.",
    parameters: z.object({
      path: z.string(),
      node: z.string().optional().describe("Knowledge node id; omit for where the user is now."),
      experiment: z.string().optional().describe("Experiment id; takes precedence over node."),
    }),
    handler: async ({ path, node, experiment }) => {
      const ws = latest.current;
      const moving = experiment
        ? experiment !== ws.experiment?.id
        : node !== undefined && (node !== ws.node || ws.experiment !== null);
      if (moving) {
        const entered = experiment ? await ws.enterExperiment(experiment) : await ws.enterNode(node || null);
        if (!entered) return { error: experiment ? `No experiment ${experiment}` : `No knowledge node ${node}` };
        // The new place's files reach `latest` on the next render.
        for (let i = 0; i < 20 && !latest.current.getFile(path); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
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
}
