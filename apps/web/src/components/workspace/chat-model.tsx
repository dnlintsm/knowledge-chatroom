"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import type { ChatModels } from "@/lib/chat-models";
import { isAborted, workspaceFetch } from "@/lib/workspace-request";

const ModelContext = createContext<{ available: ChatModels | null; model?: string; choose: (model: string) => void }>({
  available: null, choose: () => {},
});

export function ChatModelProvider({ children }: { children: ReactNode }) {
  const threadId = useCopilotChatConfiguration()?.threadId;
  const [available, setAvailable] = useState<ChatModels | null>(null);
  const [byChat, setByChat] = useState<Record<string, string>>({});
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(retry: boolean) {
      try {
        const response = await workspaceFetch("/api/chat/models", { signal: abort.signal });
        if (response.status >= 500) throw new Error("Model discovery is temporarily unavailable.");
        if (response.ok && response.status !== 204) setAvailable(await response.json() as ChatModels);
      } catch (error) {
        if (retry && !abort.signal.aborted && !isAborted(error)) timer = setTimeout(() => void load(false), 750);
      }
    }
    void load(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  const choice = threadId ? byChat[threadId] : undefined;
  const model = choice && available?.models.includes(choice) ? choice : undefined;
  return (
    <ModelContext.Provider value={{ available, model, choose: (next) => {
      if (threadId && available?.models.includes(next)) setByChat((choices) => ({ ...choices, [threadId]: next }));
    } }}>
      {children}
    </ModelContext.Provider>
  );
}

export const useChatModel = () => useContext(ModelContext).model;

function modelLabel(id: string) {
  const match = /^claude-(haiku|sonnet|opus)(?:-(\d+)(?:-(\d))?)?/i.exec(id);
  if (!match) return id;
  const [, family, major, minor] = match;
  return family[0].toUpperCase() + family.slice(1) + (major ? ` ${major}${minor ? `.${minor}` : ""}` : "");
}

export function ChatModelPicker({ disabled }: { disabled: boolean }) {
  const { available, model, choose } = useContext(ModelContext);
  if (!available || available.models.length < 2) return null;
  const selected = model ?? available.default;
  return (
    <label className="kc-model-picker" title={selected}>
      <span aria-hidden="true">{modelLabel(selected)}</span><ChevronDown aria-hidden="true" />
      <select aria-label="Chat model" data-testid="chat-model" value={selected} disabled={disabled}
        onChange={(event) => choose(event.target.value)}>
        {available.models.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
  );
}
