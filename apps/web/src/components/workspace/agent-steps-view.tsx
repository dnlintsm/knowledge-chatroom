"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Brain, ChevronRight, ListCollapse, ListTree } from "lucide-react";
import {
  CopilotChatAssistantMessage,
  messageGroup,
  messageRow,
  useAgent,
  type CopilotChatAssistantMessageProps,
  type CopilotChatReasoningMessageProps,
  type Message,
  type MessageGroupWrapperProps,
  type MessageRow,
} from "@copilotkit/react-core/v2";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  StepTimes,
  currentActivity,
  formatDuration,
  groupSteps,
  readStepsMode,
  stepIds,
  stepsSummary,
  writeStepsMode,
  type StepsMode,
} from "./agent-steps";

/**
 * Collapsed agent steps (issue #154), the React side of agent-steps.ts.
 *
 * Each turn's thinking, tool calls and narration render inside a StepsBlock:
 * a "Worked for 14s · 5 steps" header (a live status line while it runs) that
 * opens into the steps. The block always renders its messages, inside a
 * StepsContext; the step renderers (ReasoningStep, StepAssistantMessage, the
 * generic tool row in tool-rendering.tsx) read it and hide while the block is
 * closed. Everything else, i.e. paper cards, charts, A2UI, a tool waiting
 * for the user, keeps showing, so outcomes never fold away.
 */

/** Where a step renders: in a block or not, open or not, and the chat's mode. */
interface StepsView {
  inBlock: boolean;
  open: boolean;
  detailed: boolean;
}

const StepsContext = createContext<StepsView>({ inBlock: false, open: true, detailed: false });

/** Whether a step's own details start open: in Detailed mode. */
export function useStepsView(): StepsView {
  return useContext(StepsContext);
}

/** True where a step should not render: inside a closed block. */
export function useStepHidden(): boolean {
  const view = useContext(StepsContext);
  return view.inBlock && !view.open;
}

// ---- The chat's mode, the step times and whether a run is under way -------

interface ChatSteps {
  mode: StepsMode;
  setMode: (mode: StepsMode) => void;
  times: StepTimes;
  running: boolean;
}

const fallbackTimes = new StepTimes();
const ChatStepsContext = createContext<ChatSteps>({ mode: "compact", setMode: () => {}, times: fallbackTimes, running: false });

/** The deployment's default mode, CHAT_STEPS on the server (src/app/page.tsx). */
export const StepsDefaultContext = createContext<StepsMode>("compact");

const browserStorage = () => (typeof window === "undefined" ? null : window.localStorage);

/**
 * Provides the chat's steps mode (this user's choice in localStorage, else
 * CHAT_STEPS) and records when each step happened from the agent's events.
 */
export function ChatStepsProvider({ children }: { children: ReactNode }) {
  const fallback = useContext(StepsDefaultContext);
  const [mode, setModeState] = useState<StepsMode>(fallback);
  useEffect(() => setModeState(readStepsMode(browserStorage(), fallback)), [fallback]);
  const setMode = useCallback((next: StepsMode) => {
    setModeState(next);
    writeStepsMode(browserStorage(), next);
  }, []);

  const { agent } = useAgent({ updates: [] });
  const [times] = useState(() => new StepTimes());
  // A layout effect, so it subscribes before the chat's own effect connects
  // and replays a reopened chat: an agent's run only tells the subscribers it
  // had when it started.
  useLayoutEffect(() => {
    const sub = agent.subscribe({ onEvent: ({ event }) => times.record(event as Parameters<StepTimes["record"]>[0]) });
    return () => sub.unsubscribe();
  }, [agent, times]);
  const [running, setRunning] = useState(agent.isRunning);
  useLayoutEffect(() => {
    setRunning(agent.isRunning);
    const sub = agent.subscribe({
      onRunInitialized: () => setRunning(true),
      onRunFinalized: () => setRunning(false),
      onRunFailed: () => setRunning(false),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  return <ChatStepsContext.Provider value={{ mode, setMode, times, running }}>{children}</ChatStepsContext.Provider>;
}

export function useChatSteps() {
  return useContext(ChatStepsContext);
}

/** The chat header's switch between Compact and Detailed steps. */
export function StepsModeButton({ className }: { className?: string }) {
  const { mode, setMode } = useChatSteps();
  const detailed = mode === "detailed";
  const title = detailed ? "Detailed steps: showing every step. Switch to compact" : "Compact steps: showing results. Switch to detailed";
  const Icon = detailed ? ListTree : ListCollapse;
  return (
    <button
      type="button"
      data-testid="steps-mode"
      title={title}
      aria-label="Show every step"
      aria-pressed={detailed}
      onClick={() => setMode(detailed ? "compact" : "detailed")}
      className={cn(className, detailed && "bg-[var(--card)] text-[var(--foreground)] shadow-sm")}
    >
      <Icon className="size-4" />
    </button>
  );
}

// ---- Grouping ---------------------------------------------------------------

/** The message view's groupMessages for a chat that is or isn't running. */
export function stepRows(messages: Message[], running: boolean): MessageRow[] {
  return groupSteps(messages, running).map((row) =>
    row.type === "message" ? messageRow(row.message) : messageGroup({ key: row.key, messages: row.messages, wrapper: StepsBlock }),
  );
}

// ---- The block --------------------------------------------------------------

/** The group's state, kept by the message view: open or closed, once the user chose. */
type BlockState = { open?: boolean };

/** Re-renders every second while `on`. */
function useTicker(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [on]);
}

function StepsBlock({ messages, children, state, setState }: MessageGroupWrapperProps<BlockState>) {
  const { mode, times, running } = useChatSteps();
  useSyncExternalStore(times.subscribe, times.snapshot, times.snapshot);
  const { agent } = useAgent({ updates: [] });
  // The live block is the latest turn's, while the run lasts.
  const lastId = messages[messages.length - 1]?.id;
  const at = agent.messages.findIndex((m) => m.id === lastId);
  const live = running && at >= 0 && !agent.messages.slice(at + 1).some((m) => m.role === "user");
  useTicker(live);

  const detailed = mode === "detailed";
  const open = state?.open ?? detailed;
  const ids = stepIds(messages);
  const id = useId();
  const liveStart = live ? times.liveStart(ids) : null;
  const summary = stepsSummary(messages, times.duration(ids));

  return (
    <div data-testid="agent-steps" data-open={open} data-live={live} className="my-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setState({ open: !open })}
        className="group flex w-full min-w-0 items-center gap-2 rounded py-0.5 text-left text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
      >
        {live ? (
          <Spinner size="sm" className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        )}
        <span data-testid="agent-steps-summary" aria-live="polite" className="min-w-0 truncate">
          {live ? currentActivity(messages) : summary}
        </span>
        {live && liveStart !== null && (
          <span className="ml-auto shrink-0 tabular-nums text-xs">{formatDuration(Date.now() - liveStart)}</span>
        )}
        {live && <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", liveStart === null && "ml-auto", open && "rotate-90")} />}
      </button>
      <div id={id} className={cn(open && "mt-1 ml-1.5 border-l border-[var(--border)] pl-3")}>
        <StepsContext.Provider value={{ inBlock: true, open, detailed }}>{children}</StepsContext.Provider>
      </div>
    </div>
  );
}

// ---- The step renderers ------------------------------------------------------

/**
 * An assistant message. In a block its text is narration ("Let me read the
 * file"): a muted line while the block is open, hidden while it's closed;
 * its tool calls render either way, so their outcomes show. Outside a block
 * it is an answer, laid out as CopilotKit's own.
 */
export function StepAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const view = useStepsView();
  return (
    <CopilotChatAssistantMessage {...props}>
      {({ markdownRenderer, toolCallsView, toolbar, toolbarVisible, message }) => {
        const text = typeof message.content === "string" && message.content.trim().length > 0;
        if (view.inBlock) {
          return (
            <div data-testid="agent-step-message" data-message-id={message.id}>
              {view.open && text && (
                <div
                  data-testid="agent-step-narration"
                  className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert my-1 opacity-70"
                  style={{ fontSize: "0.875rem" }}
                >
                  {markdownRenderer}
                </div>
              )}
              {toolCallsView}
            </div>
          );
        }
        return (
          <div
            data-copilotkit
            data-testid="copilot-assistant-message"
            data-message-id={message.id}
            className={cn("copilotKitMessage copilotKitAssistantMessage", props.className)}
          >
            <div className="cpk:prose cpk:max-w-full cpk:break-words cpk:dark:prose-invert">{markdownRenderer}</div>
            {toolCallsView}
            {toolbarVisible && toolbar}
          </div>
        );
      }}
    </CopilotChatAssistantMessage>
  );
}

/** A thinking block, as one step: "Thought for 3s", opening into what Claude thought. */
export function ReasoningStep({ message, isRunning, isLatest }: CopilotChatReasoningMessageProps) {
  const view = useStepsView();
  const { times } = useChatSteps();
  useSyncExternalStore(times.subscribe, times.snapshot, times.snapshot);
  const [open, setOpen] = useState<boolean | null>(null);
  const id = useId();
  if (view.inBlock && !view.open) return null;
  const streaming = Boolean(isRunning && isLatest);
  // Its own time, not since the run started: thinking after a tool call says how long it thought.
  const ms = times.span([message.id]);
  const label = streaming ? "Thinking…" : ms !== null && ms > 0 ? `Thought for ${formatDuration(ms)}` : "Thought";
  const content = typeof message.content === "string" ? message.content.trim() : "";
  const shown = (open ?? view.detailed) && content.length > 0;
  return (
    <div data-testid="agent-step" data-step="thinking" className="my-1">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        disabled={!content}
        onClick={() => setOpen(!shown)}
        className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] enabled:hover:text-[var(--foreground)] enabled:cursor-pointer"
      >
        {streaming ? <Spinner size="sm" className="h-3 w-3" /> : <Brain className="h-3 w-3" />}
        <span>{label}</span>
        {content && <ChevronRight className={cn("h-3 w-3 transition-transform", shown && "rotate-90")} />}
      </button>
      {shown && (
        <div
          id={id}
          className="ml-5 mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-[var(--secondary)] px-3 py-2 text-xs text-[var(--muted-foreground)]"
        >
          {content}
        </div>
      )}
    </div>
  );
}
