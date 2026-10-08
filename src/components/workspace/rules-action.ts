import { BookOpenCheck, Wand2 } from "lucide-react";
import type { ActionContext, ActionDef } from "./actions";
import { parseRulesResponse, RULES_FILE, rulesPath, rulesToMarkdown } from "./rules";
import { serverFileExists } from "./server-files";
import { FileExistsError } from "./types";

/**
 * Generate Rules → Open Rules. Without <RUN_DIR>/models/general_rules.md the
 * action asks the rules API once, writes the file read-only and opens it;
 * once the file exists it only opens it. Calls to the API are kept to one:
 * - the runner never starts the action twice at once (one tab);
 * - a Web Lock per file serializes tabs of this browser, and the check right
 *   before the call asks the server, so a tab that waited finds the file;
 * - the write is create-only, so even two browsers can't overwrite it.
 */
export const generateRules: ActionDef = {
  id: "generate-rules",
  // Opening the rules needs to see the run; generating them writes a file.
  requiredRole: ({ runDir, workspace }) => (workspace.getFile(rulesPath(runDir)) ? "viewer" : "editor"),
  agentInvocable: true,
  description:
    `Open the run's ${RULES_FILE}. If it doesn't exist yet, first generate it (once, read-only) ` +
    "from the rules API.",
  view: ({ runDir, workspace }) => {
    if (workspace.getFile(rulesPath(runDir))) {
      return { label: "Open Rules", icon: BookOpenCheck, enabled: true, hint: `Open ${RULES_FILE}` };
    }
    const loading = workspace.storageMode === "loading";
    return {
      label: "Generate Rules",
      icon: Wand2,
      enabled: !loading,
      hint: loading ? "Waiting for the files to load" : `Generate ${RULES_FILE} for this run`,
    };
  },
  run: generateOrOpenRules,
};

async function generateOrOpenRules({ runDir, workbench, workspace }: ActionContext) {
  const path = rulesPath(runDir);
  if (workspace.getFile(path)) {
    workbench.editor.open(path);
    return;
  }
  await withLock(`knowledge-chatroom:generate-rules:${path}`, async () => {
    const exists =
      workspace.storageMode === "server"
        ? await serverFileExists(path, workspace.node)
        : Boolean(workspace.getFile(path));
    if (exists) return alreadyGenerated();

    const res = await fetch(`/api/rules?run=${encodeURIComponent(runDir)}`, { cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (json as { error?: unknown } | null)?.error;
      throw new Error(typeof message === "string" ? message : `The rules API answered ${res.status}`);
    }
    const markdown = rulesToMarkdown(parseRulesResponse(json));
    try {
      await workspace.create(path, markdown, { mime: "text/markdown", readOnly: true });
    } catch (err) {
      if (err instanceof FileExistsError) return alreadyGenerated();
      throw err;
    }
    workbench.editor.open(path);
    workbench.notify(`Generated ${RULES_FILE} for this run.`, "success");
  });

  function alreadyGenerated() {
    workbench.notify(`${RULES_FILE} was already generated for this run.`, "info");
    workbench.editor.open(path);
  }
}

/** Runs `fn` while holding a lock shared by this browser's tabs, where supported. */
async function withLock(name: string, fn: () => Promise<void>) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return fn();
  await locks.request(name, fn);
}
