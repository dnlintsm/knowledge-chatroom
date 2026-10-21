"use client";

import { useEffect, useMemo } from "react";
import { useCopilotKit } from "@copilotkit/react-core/v2";
import { CHATROOM_PROPS, chatroomPlace } from "@/lib/chatroom-props";
import { findReport } from "./runs";
import { useWorkspace } from "./store";

/**
 * Keeps where the user is (node, experiment or run, open file) in CopilotKit's
 * properties, which go out as `forwardedProps.knowledge_chatroom` with every
 * run, the first one of a chat included; the server adds the user
 * (src/lib/chatroom-props.ts). A backend can then set up a thread's agent for
 * that user and place (docs/remote-agent.md).
 */
export function useChatroomProps() {
  const { storageMode, lineage, experiment, activeFile, files } = useWorkspace();
  const { copilotkit } = useCopilotKit();
  const selectedPath = activeFile?.path ?? null;
  const report = experiment ? findReport(files.map((f) => f.path)) : null;

  const place = useMemo(
    () => chatroomPlace({ storage: storageMode, lineage, experiment, report, selectedPath }),
    [storageMode, lineage, experiment, report, selectedPath],
  );

  useEffect(() => {
    // The provider replaces the properties when its own settings change (and
    // once after this first runs), so put ours back whenever they go missing.
    const apply = () => {
      const properties = copilotkit.properties ?? {};
      if (properties[CHATROOM_PROPS] === place) return;
      copilotkit.setProperties({ ...properties, [CHATROOM_PROPS]: place });
    };
    apply();
    const sub = copilotkit.subscribe({ onPropertiesChanged: apply });
    return () => sub.unsubscribe();
  }, [copilotkit, place]);
}
