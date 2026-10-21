import { BookOpenCheck, Wand2 } from "lucide-react";
import type { ActionContext, ActionDef } from "./actions";
import { parseRulesResponse, RULES_FILE, rulesToMarkdown } from "./rules";
import { experimentPlace, serverFileExists } from "./server-files";
import { FileExistsError } from "./types";

/**
 * Generate Rules → Open Rules. Without the run's models/general_rules.md the
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
  requiredRole: ({ workspace }) => (workspace.getFile(RULES_FILE) ? "viewer" : "editor"),
  agentInvocable: true,
  description:
    `Open the run's ${RULES_FILE}. If it doesn't exist yet, first generate it (once, read-only) ` +
    "from the rules API.",
  view: ({ workspace }) => {
    if (workspace.getFile(RULES_FILE)) {
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

async function generateOrOpenRules({ run, workbench, workspace }: ActionContext) {
  const path = RULES_FILE;
  if (workspace.getFile(path)) {
    workbench.editor.open(path);
    return;
  }
  await withLock(`knowledge-chatroom:generate-rules:${run.id}`, async () => {
    if (await serverFileExists(path, experimentPlace(run.id))) return alreadyGenerated();

    const query = new URLSearchParams({ run: run.title, experiment: run.id });
    const res = await fetch(`/api/rules?${query}`, { cache: "no-store" });
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
