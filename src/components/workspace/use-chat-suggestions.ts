"use client";

import { useMemo } from "react";
import { useConfigureSuggestions } from "@copilotkit/react-core/v2";
import { firstRoundSuggestions } from "./chat-suggestions";
import { RUN_REPORT } from "./runs";
import { useWorkspace } from "./store";
import { isTextFile } from "./types";
import { useWorkbench } from "./workbench";

/** Shows the first-round chips (chat-suggestions.ts) for where the user is. */
export function useChatSuggestions() {
  const ws = useWorkspace();
  const { runDir } = useWorkbench();
  const open = ws.activeFile && isTextFile(ws.activeFile) ? ws.activeFile.path : null;
  const hasReport = runDir ? Boolean(ws.getFile(`${runDir}/${RUN_REPORT}`)) : false;
  const nodeName = ws.node ? (ws.lineage.at(-1)?.name ?? null) : null;
  const experimentTitle = ws.experiment?.title ?? null;
  const serverStorage = ws.storageMode === "server";

  const suggestions = useMemo(
    () => firstRoundSuggestions({ openFile: open, runDir, hasReport, nodeName, experimentTitle, serverStorage }),
    [open, runDir, hasReport, nodeName, experimentTitle, serverStorage],
  );
  useConfigureSuggestions({ suggestions, available: "always" }, [suggestions]);
}
