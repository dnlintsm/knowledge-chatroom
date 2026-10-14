"use client";

import { useMemo, useRef, useSyncExternalStore } from "react";
import { useAgent, useConfigureSuggestions, useCopilotKit, UseAgentUpdate } from "@copilotkit/react-core/v2";
import { FOLLOW_UP_INSTRUCTIONS, firstRoundSuggestions } from "./chat-suggestions";
import { RUN_REPORT } from "./runs";
import { useWorkspace } from "./store";
import { isTextFile } from "./types";
import { useWorkbench } from "./workbench";

/** The runtime's chip writer (route.ts); absent with CHAT_SUGGESTIONS=static. */
const SUGGESTER = "suggester";

function useRuntimeHasAgent(id: string): boolean {
  const { copilotkit } = useCopilotKit();
  return useSyncExternalStore(
    (changed) => {
      const sub = copilotkit.subscribe({ onAgentsChanged: changed });
      return () => sub.unsubscribe();
    },
    () => id in copilotkit.agents,
    () => false,
  );
}

/**
 * The chat's chips: the first-round ones (chat-suggestions.ts) for where the
 * user is until the chat has messages, then follow-ups the suggester writes
 * after each reply. Without the suggester the first-round chips stay.
 */
export function useChatSuggestions() {
  const ws = useWorkspace();
  const { runDir } = useWorkbench();
  const open = ws.activeFile && isTextFile(ws.activeFile) ? ws.activeFile.path : null;
  const hasReport = runDir ? Boolean(ws.getFile(`${runDir}/${RUN_REPORT}`)) : false;
  const nodeName = ws.node ? (ws.lineage.at(-1)?.name ?? null) : null;
  const experimentTitle = ws.experiment?.title ?? null;
  const serverStorage = ws.storageMode === "server";

  const firstRound = useMemo(
    () => firstRoundSuggestions({ openFile: open, runDir, hasReport, nodeName, experimentTitle, serverStorage }),
    [open, runDir, hasReport, nodeName, experimentTitle, serverStorage],
  );

  const followUps = useRuntimeHasAgent(SUGGESTER);
  const { agent } = useAgent({ updates: [UseAgentUpdate.OnMessagesChanged] });
  const started = agent.messages.length > 0;
  // Any change to a chip config reloads every config, the suggester's
  // included, so once the chat has started the first round stops following
  // the open file (it isn't shown then anyway).
  const shown = useRef(firstRound);
  if (!followUps || !started) shown.current = firstRound;

  useConfigureSuggestions(
    { suggestions: shown.current, available: followUps ? "before-first-message" : "always" },
    [shown.current, followUps],
  );
  useConfigureSuggestions(
    followUps
      ? {
          instructions: FOLLOW_UP_INSTRUCTIONS,
          minSuggestions: 2,
          maxSuggestions: 3,
          available: "after-first-message",
          providerAgentId: SUGGESTER,
        }
      : null,
    [followUps],
  );
}
