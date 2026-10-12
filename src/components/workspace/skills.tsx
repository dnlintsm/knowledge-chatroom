"use client";

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { CopilotChatInput, useAgent } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./store";

/**
 * Skill management in the workspace (issue #7, step 1):
 * - the Skills panel lists every skill Claude can have (built-in + the
 *   workspace's skills/<name>/SKILL.md) and sets each to Auto, Manual or Off;
 * - typing "/" in the chat opens a menu of the skills you can run by name;
 * - under the chat input, a status bar says which skills are on and which
 *   ones the current turn used (the agent sends a "skill_used" event for each).
 * Modes are kept per user by the agent server (/api/skills).
 */

export type SkillMode = "auto" | "manual" | "off";

export interface SkillInfo {
  name: string;
  description: string;
  argumentHint: string | null;
  source: "builtin" | "workspace";
  /** Its SKILL.md in the workspace; null for built-in skills. */
  path: string | null;
  mode: SkillMode;
  defaultMode: SkillMode;
  modelInvocable: boolean;
  userInvocable: boolean;
  needsExecution: boolean;
}

export interface SkillUse {
  skill: string;
  source: SkillInfo["source"];
  /** slash: the user typed /name; model: Claude picked it. */
  trigger: "slash" | "model";
}

interface Turn {
  running: boolean;
  used: SkillUse[];
}

interface Skills {
  skills: SkillInfo[];
  status: "loading" | "ready" | "unavailable";
  setMode: (name: string, mode: SkillMode) => Promise<void>;
  /** The current (or last) turn of the chat. */
  turn: Turn;
}

const SkillsContext = createContext<Skills | null>(null);

export function useSkills(): Skills {
  const skills = useContext(SkillsContext);
  if (!skills) throw new Error("useSkills needs a SkillsProvider");
  return skills;
}

export function SkillsProvider({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [status, setStatus] = useState<Skills["status"]>("loading");

  // Workspace skills are the root's skills/ files: reload when those change.
  const atRoot = ws.node === null && !ws.experiment;
  const skillFiles = atRoot
    ? ws.files
        .filter((f) => f.kind === "skill")
        .map((f) => `${f.path}@${f.updatedAt}`)
        .join("|")
    : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/skills", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setSkills(((await res.json()) as { skills: SkillInfo[] }).skills);
      setStatus("ready");
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    if (ws.storageMode === "loading") return;
    // Saves are debounced, so give a just-edited SKILL.md a moment to land.
    const timer = setTimeout(() => void load(), skillFiles ? 800 : 0);
    return () => clearTimeout(timer);
  }, [load, skillFiles, ws.storageMode]);

  const setMode = useCallback(
    async (name: string, mode: SkillMode) => {
      setSkills((list) => list.map((s) => (s.name === name ? { ...s, mode } : s)));
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const updated = (await res.json()) as SkillInfo;
        setSkills((list) => list.map((s) => (s.name === name ? updated : s)));
      } catch {
        await load();
      }
    },
    [load],
  );

  // Which skills the current turn used, from the agent's "skill_used" events.
  const { agent } = useAgent();
  const [turn, setTurn] = useState<Turn>({ running: false, used: [] });
  useEffect(() => {
    const sub = agent.subscribe({
      onRunStartedEvent: () => setTurn({ running: true, used: [] }),
      onCustomEvent: ({ event }) => {
        if (event.name !== "skill_used") return;
        const use = event.value as SkillUse;
        setTurn((t) =>
          t.used.some((u) => u.skill === use.skill) ? t : { ...t, used: [...t.used, use] },
        );
      },
      onRunFinalized: () => setTurn((t) => ({ ...t, running: false })),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  const value = useMemo(() => ({ skills, status, setMode, turn }), [skills, status, setMode, turn]);
  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

const MODES: { mode: SkillMode; label: string; title: string }[] = [
  { mode: "auto", label: "Auto", title: "Claude may use it on its own; /name runs it too" },
  { mode: "manual", label: "Manual", title: "Only when you type /name" },
  { mode: "off", label: "Off", title: "Not available to Claude" },
];

/** The Skills view of the side panel. `fallback` (the skill files here) shows when skills can't be loaded, and below them with browser-only files. */
export function SkillsPanel({ fallback }: { fallback: ReactNode }) {
  const { skills, status, setMode } = useSkills();
  const ws = useWorkspace();
  const atRoot = ws.node === null && !ws.experiment;

  if (status === "loading") {
    return <p className="px-3 py-2 text-[var(--muted-foreground)]">Loading skills…</p>;
  }
  if (status === "unavailable") return <>{fallback}</>;

  return (
    <div data-testid="skills-panel" className="flex flex-col">
      <p className="px-3 pb-2 text-xs text-[var(--muted-foreground)]">
        Auto: Claude uses it when it fits. Manual: only when you type /name in the chat.
      </p>
      {ws.storageMode === "server" && !atRoot && (
        <p className="mx-3 mb-2 rounded bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--muted-foreground)]">
          Claude uses the skills at the workspace root, listed here.
        </p>
      )}
      {skills.length === 0 && (
        <p className="px-3 py-2 text-[var(--muted-foreground)]">
          No skills yet. Skills are SKILL.md files that teach Claude a workflow.
        </p>
      )}
      {skills.map((skill) => (
        <div
          key={skill.name}
          data-testid="skill-row"
          data-skill={skill.name}
          className="border-b border-[var(--border)] px-3 py-2 last:border-b-0"
        >
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 shrink-0 text-amber-500" />
            {skill.path && atRoot ? (
              <button
                type="button"
                title={`Open ${skill.path}`}
                onClick={() => ws.open(skill.path!)}
                className="min-w-0 truncate font-medium hover:underline cursor-pointer"
              >
                {skill.name}
              </button>
            ) : (
              <span className="min-w-0 truncate font-medium">{skill.name}</span>
            )}
            <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
              {skill.source === "builtin" ? "Built-in" : "Workspace"}
            </span>
            {skill.needsExecution && (
              <span
                title="It ships scripts or asks for a shell; skills here are instructions only, so those parts won't run."
                className="shrink-0 text-amber-600"
              >
                <AlertTriangle className="size-3.5" />
              </span>
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">{skill.description}</p>
          )}
          <div
            role="radiogroup"
            aria-label={`${skill.name} mode`}
            className="mt-1.5 inline-flex overflow-hidden rounded border border-[var(--border)] text-xs"
          >
            {MODES.map(({ mode, label, title }) => {
              const disabled =
                (mode === "auto" && !skill.modelInvocable) ||
                (mode === "manual" && !skill.userInvocable);
              const active = skill.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  title={disabled ? "This skill's SKILL.md doesn't allow this" : title}
                  onClick={() => void setMode(skill.name, mode)}
                  className={cn(
                    "px-2 py-0.5 border-r border-[var(--border)] last:border-r-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40",
                    active
                      ? "bg-[var(--accent)] text-[var(--accent-foreground)] font-medium"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {ws.storageMode === "local" && (
        <>
          <p className="mx-3 mt-3 mb-1 rounded bg-[var(--secondary)] px-2 py-1.5 text-xs text-[var(--muted-foreground)]">
            Skill files in this browser. Claude can use them once the workspace is stored on the server.
          </p>
          {fallback}
        </>
      )}
    </div>
  );
}

// Chat input: the "/" menu and the status bar.

interface SlashMenu {
  /** Handles a key while the menu is open; true when it used it. */
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

const SlashContext = createContext<SlashMenu | null>(null);

/** CopilotKit's text area, with the "/" menu's keys taken first. */
const SkillTextArea = forwardRef<HTMLTextAreaElement, CopilotChatInput.TextAreaProps>(
  function SkillTextArea({ onKeyDown, ...props }, ref) {
    const slash = useContext(SlashContext);
    return (
      <CopilotChatInput.TextArea
        ref={ref}
        {...props}
        onKeyDown={(e) => {
          if (slash?.onKey(e)) return;
          onKeyDown?.(e);
        }}
      />
    );
  },
);

type ChatInputProps = Parameters<typeof CopilotChatInput>[0];

/** The chat's input slot: CopilotKit's input plus the skills "/" menu and status bar. */
export function SkillChatInput(props: ChatInputProps) {
  const { skills, status, turn } = useSkills();
  const value = props.value ?? "";
  // The menu shows while the first word is still a /command being typed.
  const query = /^\/([a-z0-9-]*)$/i.exec(value)?.[1]?.toLowerCase() ?? null;
  const matches = useMemo(() => {
    if (query === null) return [];
    const usable = skills.filter((s) => s.mode !== "off" && s.userInvocable && s.name.includes(query));
    return [...usable.filter((s) => s.name.startsWith(query)), ...usable.filter((s) => !s.name.startsWith(query))];
  }, [skills, query]);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const open = matches.length > 0 && dismissed !== value;
  const active = Math.min(highlight, matches.length - 1);

  useEffect(() => setHighlight(0), [query]);

  const pick = (skill: SkillInfo) => props.onChange?.(`/${skill.name} `);

  const slash: SlashMenu = {
    onKey: (e) => {
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((active + step + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(matches[active]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(value);
        return true;
      }
      return false;
    },
  };

  return (
    <SlashContext.Provider value={slash}>
      <div className="relative">
        {open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full z-30 mx-auto max-w-3xl px-4 @3xl:px-0">
            <div
              role="listbox"
              aria-label="Skills"
              data-testid="skill-menu"
              className="pointer-events-auto mb-2 max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg"
            >
              {matches.map((skill, i) => (
                <button
                  key={skill.name}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(skill);
                  }}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm cursor-pointer",
                    i === active && "bg-[var(--secondary)]",
                  )}
                >
                  <span className="shrink-0 font-medium">/{skill.name}</span>
                  {skill.argumentHint && (
                    <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{skill.argumentHint}</span>
                  )}
                  <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">{skill.description}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <CopilotChatInput
          {...props}
          // CopilotKit opens its own "/" menu (attach file) when it has items; ours replaces it.
          onAddFile={value.startsWith("/") ? undefined : props.onAddFile}
          textArea={SkillTextArea}
          disclaimer={() => null}
        />
        {status === "ready" ? (
          <SkillStatusBar skills={skills} turn={turn} />
        ) : (
          <div className="pb-4" />
        )}
      </div>
    </SlashContext.Provider>
  );
}

/** One line under the input: the skills that are on, then what this turn used. */
function SkillStatusBar({ skills, turn }: { skills: SkillInfo[]; turn: Turn }) {
  const auto = skills.filter((s) => s.mode === "auto").length;
  const manual = skills.filter((s) => s.mode === "manual").length;
  return (
    <div
      data-testid="skill-status"
      className="pointer-events-auto mx-auto flex max-w-3xl flex-wrap items-center gap-1.5 px-5 pt-1.5 pb-3 text-xs text-[var(--muted-foreground)]"
    >
      <Sparkles className="size-3 shrink-0 text-amber-500" />
      {turn.used.length > 0 ? (
        <>
          <span>{turn.running ? "Using" : "Used"}:</span>
          {turn.used.map((use) => (
            <span
              key={use.skill}
              data-testid="skill-used"
              title={use.trigger === "slash" ? "You ran it with /" : "Claude chose it"}
              className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[var(--accent-foreground)]"
            >
              {use.trigger === "slash" ? "/" : ""}
              {use.skill}
              {use.trigger === "model" && <span className="opacity-70"> · auto</span>}
            </span>
          ))}
        </>
      ) : (
        <span title="Auto: Claude may use them. Manual: only with /name.">
          {turn.running ? "No skills used yet" : `${auto} auto · ${manual} manual skills`}
          {" · type / to run one"}
        </span>
      )}
    </div>
  );
}
