import { compactEvents, EventType, type AbstractAgent, type BaseEvent, type Message } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { finalizeRunEvents } from "@copilotkit/shared";
import { Observable, ReplaySubject } from "rxjs";

import { IDENTITY_HEADER, authSecret, readIdentityHeader } from "./auth";
import { ChatTakenError, type ChatStore, type ChatUser, type StoredRun } from "./chat-store";

/**
 * Runs the chat and keeps each user's chats (issue #91). In place of
 * CopilotKit's InMemoryAgentRunner, which keeps every thread in one
 * process-wide list for everyone and forgets it on restart, this runner:
 *
 * - streams a live run from memory, so reconnecting mid-run works as before;
 * - saves every finished run (its compacted AG-UI events and the messages
 *   after it) to a ChatStore: Postgres through the agent server when it has
 *   storage, else memory, per user either way (src/lib/chat-store.ts);
 * - replays a chat from the store when the browser connects to it, e.g. when
 *   it is picked from the history after a restart.
 *
 * Who a run is for comes from the X-Knowledge-User header the app's route
 * signed (route.ts); without login everyone is the local user. A thread id
 * that is someone else's chat is refused. The history routes themselves are
 * answered by src/lib/chat-routes.ts.
 */

interface LiveRun {
  runId: string;
  /** Whose run it is: the user's login subject, "local" without login. */
  owner: string;
  agent: AbstractAgent;
  events: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
}

const ownerKey = (user: ChatUser) => user?.sub ?? "local";

/** The user an X-Knowledge-User header names; undefined when login is on and it names nobody. */
export function chatUserFrom(headers: Record<string, string> | undefined): ChatUser | undefined {
  if (!authSecret()) return null;
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === IDENTITY_HEADER)?.[1];
  return readIdentityHeader(header) ?? undefined;
}

const NAME_LENGTH = 80;

/** A chat's name: the first thing the user asked, shortened. */
export function chatName(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content as unknown;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
              .join(" ")
          : "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    return clean.length > NAME_LENGTH ? `${clean.slice(0, NAME_LENGTH - 1).trimEnd()}…` : clean;
  }
  return null;
}

/** Message ids a chat's past runs already hold, so a new run's RUN_STARTED only carries new ones. */
function pastMessageIds(runs: StoredRun[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const event of run.events as (BaseEvent & { messageId?: unknown; input?: { messages?: Message[] } })[]) {
      if (typeof event.messageId === "string") ids.add(event.messageId);
      if (event.type === EventType.RUN_STARTED) for (const m of event.input?.messages ?? []) ids.add(m.id);
    }
  }
  return ids;
}

export class ChatRunner extends AgentRunner {
  private readonly live = new Map<string, LiveRun>();

  /**
   * @param saved the agents whose chats are kept; others (the follow-up chips'
   * "suggester", whose every run is a throwaway thread) only run.
   */
  constructor(
    private readonly store: ChatStore,
    private readonly saved: (agentId: string) => boolean = (agentId) => agentId === "default",
  ) {
    super();
  }

  /** Whose run is live on the thread, if any (route.ts checks it before a stop). */
  liveOwner(threadId: string): string | null {
    return this.live.get(threadId)?.owner ?? null;
  }

  run({ threadId, agent, input }: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (this.live.has(threadId)) throw new Error("Thread already running");
    // An HttpAgent's clone carries the request's x-* headers (src/agent.ts).
    const user = chatUserFrom((agent as { headers?: Record<string, string> }).headers);
    const events = new ReplaySubject<BaseEvent>(Infinity);
    if (user === undefined) {
      events.next({ type: EventType.RUN_ERROR, message: "Sign in first" } as BaseEvent);
      events.complete();
      return events.asObservable();
    }
    const live: LiveRun = { runId: input.runId, owner: ownerKey(user), agent, events, stopRequested: false };
    this.live.set(threadId, live);
    void this.execute(threadId, user, live, input);
    return events.asObservable();
  }

  private async execute(threadId: string, user: ChatUser, live: LiveRun, input: AgentRunnerRunRequest["input"]) {
    const { agent, events } = live;
    const seen: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      seen.push(event);
      events.next(event);
    };
    const save = this.saved(agent.agentId ?? "default");
    let past: StoredRun[] = [];
    try {
      if (save) past = await this.store.runs(user, threadId);
    } catch (err) {
      this.live.delete(threadId);
      const taken = err instanceof ChatTakenError;
      if (!taken) console.error("[chat] reading chat history failed:", err);
      events.next({
        type: EventType.RUN_ERROR,
        message: taken ? err.message : "Chat history is unavailable right now; try again shortly.",
      } as BaseEvent);
      events.complete();
      return;
    }
    const known = pastMessageIds(past);
    let interruptionMessage: string | undefined;
    try {
      await agent.runAgent(input, {
        onEvent: ({ event }) => {
          // As InMemoryAgentRunner: the run's start records only the messages it adds.
          if (event.type === EventType.RUN_STARTED) {
            const started = event as BaseEvent & { input?: unknown };
            started.input ??= { ...input, messages: input.messages.filter((m) => !known.has(m.id)) };
          }
          emit(event);
        },
      });
    } catch (err) {
      interruptionMessage = err instanceof Error ? err.message : String(err);
    }
    for (const event of finalizeRunEvents(seen, {
      stopRequested: live.stopRequested,
      ...(interruptionMessage !== undefined ? { interruptionMessage } : {}),
    })) {
      emit(event);
    }
    // Saved before the run ends for the browser, so a reload right after
    // finds it. A failed save loses this run's history, not the reply.
    if (save && seen.length) {
      try {
        await this.store.save(user, threadId, {
          agentId: agent.agentId ?? "default",
          runId: input.runId,
          parentRunId: past[past.length - 1]?.runId ?? null,
          events: compactEvents(seen),
          messages: [...agent.messages],
          name: chatName(input.messages),
        });
      } catch (err) {
        console.error("[chat] saving the run failed:", err);
      }
    }
    this.live.delete(threadId);
    events.complete();
  }

  connect({ threadId, headers }: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const out = new ReplaySubject<BaseEvent>(Infinity);
    const user = chatUserFrom(headers);
    if (user === undefined) {
      out.complete();
      return out.asObservable();
    }
    // Looked up before reading the store: a run that finishes in between is
    // then replayed from memory rather than missed.
    const live = this.live.get(threadId);
    const mine = live && live.owner === ownerKey(user) ? live : undefined;
    this.store
      .runs(user, threadId)
      .catch((err) => {
        if (!(err instanceof ChatTakenError)) console.error("[chat] reading chat history failed:", err);
        return [] as StoredRun[];
      })
      .then((runs) => {
        if (live && !mine) return out.complete();
        const stored = runs.filter((run) => run.runId !== mine?.runId);
        const emitted = new Set<string>();
        for (const event of compactEvents(stored.flatMap((run) => run.events as BaseEvent[]))) {
          out.next(event);
          const id = (event as { messageId?: unknown }).messageId;
          if (typeof id === "string") emitted.add(id);
        }
        if (!mine) return out.complete();
        mine.events.subscribe({
          next: (event) => {
            const id = (event as { messageId?: unknown }).messageId;
            if (typeof id === "string" && emitted.has(id)) return;
            out.next(event);
          },
          complete: () => out.complete(),
          error: (err) => out.error(err),
        });
      });
    return out.asObservable();
  }

  async isRunning({ threadId }: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.live.has(threadId);
  }

  async stop({ threadId, runId }: AgentRunnerStopRequest): Promise<boolean> {
    const live = this.live.get(threadId);
    if (!live || live.stopRequested || (runId !== undefined && live.runId !== runId)) return false;
    live.stopRequested = true;
    try {
      live.agent.abortRun();
      return true;
    } catch (err) {
      console.error("[chat] stopping the run failed:", err);
      live.stopRequested = false;
      return false;
    }
  }
}
