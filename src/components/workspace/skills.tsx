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
import { AlertTriangle, Sparkles, SquareTerminal } from "lucide-react";
import { CopilotChatInput, useAgent, useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { MemoryStatus } from "./memory";
import { HubBrowser, SkillActions, SkillsToolbar, TrustBadges, type Notice } from "./skill-hub";
import { useWorkspace } from "./store";

/**
 * Skill management in the workspace (issue #7):
 * - the Skills panel lists every skill Claude can have (built-in, installed
 *   from the hub, and the workspace's skills/<name>/SKILL.md) and sets each
 *   to Auto, Manual or Off for you; editors of the workspace also set the
 *   default for everyone; the hub and .zip import/export are in skill-hub.tsx;
 * - typing "/" in the chat opens a menu of the skills you can run by name;
 * - under the chat input, a status bar says which skills are on and which
 *   ones the current turn used (the agent sends a "skill_used" event for
 *   each), and opens this chat's own choices.
 * The agent server keeps the modes (/api/skills); the most specific of
 * chat › you › everyone › the skill's default applies.
 */

export type SkillMode = "auto" | "manual" | "off";

export interface SkillInfo {
  name: string;
  description: string;
  argumentHint: string | null;
  source: "builtin" | "workspace" | "hub";
  /** Its SKILL.md in the workspace; null for built-in skills. */
  path: string | null;
  /** The mode that applies here (in the current chat). */
  mode: SkillMode;
  defaultMode: SkillMode;
  /** Chosen for everyone; null = the skill's default. */
  workspaceMode: SkillMode | null;
  /** Your choice; null = the workspace's. */
  userMode: SkillMode | null;
  /** This chat's choice; null = yours. */
  chatMode: SkillMode | null;
  /** For a skill installed from the hub: its pinned version, the newest one, and their standing. */
  hub: {
    version: number;
    latest: number;
    verified: boolean;
    yanked: boolean;
    yankReason: string | null;
  } | null;
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

export type ModeScope = "workspace" | "user" | "chat";

const SCOPE_FIELD = { workspace: "workspaceMode", user: "userMode", chat: "chatMode" } as const;

/** The mode that applies with the chosen levels (as the agent decides it). */
export function resolveMode(skill: SkillInfo, levels: ModeScope[] = ["chat", "user", "workspace"]): SkillMode {
  let mode = levels.map((l) => skill[SCOPE_FIELD[l]]).find((m) => m !== null) ?? skill.defaultMode;
  if (mode === "auto" && !skill.modelInvocable) mode = "manual";
  if (mode === "manual" && !skill.userInvocable) mode = "off";
  return mode;
}

interface Skills {
  skills: SkillInfo[];
  status: "loading" | "ready" | "unavailable";
  /** You may set the defaults for everyone and add skills (editor or owner of the workspace). */
  canSetDefaults: boolean;
  /** You may publish the workspace's skills to the hub (owner). */
  canPublish: boolean;
  /** There is a skill hub (the workspace is stored on the server). */
  hub: boolean;
  /** Skills' scripts run here, in a sandbox (SKILL_SCRIPTS=on on the server). */
  scripts: boolean;
  /** Loads the skills again, e.g. after installing one. */
  reload: () => Promise<void>;
  /** Sets a skill's mode at one level; null clears it there. */
  setMode: (name: string, mode: SkillMode | null, scope?: ModeScope) => Promise<void>;
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
  const [canSetDefaults, setCanSetDefaults] = useState(false);
  const [canPublish, setCanPublish] = useState(false);
  const [hub, setHub] = useState(false);
  const [scripts, setScripts] = useState(false);
  const threadId = useCopilotChatConfiguration()?.threadId;

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
      const query = threadId ? `?thread=${encodeURIComponent(threadId)}` : "";
      const res = await fetch(`/api/skills${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const list = (await res.json()) as {
        skills: SkillInfo[];
        canSetDefaults?: boolean;
        canPublish?: boolean;
        hub?: boolean;
        scripts?: boolean;
      };
      setSkills(list.skills);
      setCanSetDefaults(Boolean(list.canSetDefaults));
      setCanPublish(Boolean(list.canPublish));
      setHub(Boolean(list.hub));
      setScripts(Boolean(list.scripts));
      setStatus("ready");
    } catch {
      setStatus("unavailable");
    }
  }, [threadId]);

  useEffect(() => {
    if (ws.storageMode === "loading") return;
    // Saves are debounced, so give a just-edited SKILL.md a moment to land.
    const timer = setTimeout(() => void load(), skillFiles ? 800 : 0);
    return () => clearTimeout(timer);
  }, [load, skillFiles, ws.storageMode]);

  const setMode = useCallback(
    async (name: string, mode: SkillMode | null, scope: ModeScope = "user") => {
      setSkills((list) =>
        list.map((s) => {
          if (s.name !== name) return s;
          const next = { ...s, [SCOPE_FIELD[scope]]: mode };
          return { ...next, mode: resolveMode(next) };
        }),
      );
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, scope, ...(scope === "chat" ? { thread: threadId } : {}) }),
        });
        if (!res.ok) throw new Error(String(res.status));
      } finally {
        // The server's answer for every level, this chat's included.
        await load();
      }
    },
    [load, threadId],
  );

  // Which skills the current turn used, from the agent's "skill_used" events.
  const { agent } = useAgent();
  const [turn, setTurn] = useState<Turn>({ running: false, used: [] });
  useEffect(() => setTurn({ running: false, used: [] }), [threadId]);
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

  const value = useMemo(
    () => ({ skills, status, canSetDefaults, canPublish, hub, scripts, reload: load, setMode, turn }),
    [skills, status, canSetDefaults, canPublish, hub, scripts, load, setMode, turn],
  );
  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

/** On a skill that ships scripts: whether they run here. */
export function ScriptsBadge() {
  const { scripts } = useSkills();
  return scripts ? (
    <span
      data-testid="skill-scripts"
      data-runs="true"
      title="It ships scripts, which run in a sandbox: no network, and they only see their own folder."
      className="shrink-0 text-[var(--muted-foreground)]"
    >
      <SquareTerminal className="size-3.5" />
    </span>
  ) : (
    <span
      data-testid="skill-scripts"
      data-runs="false"
      title="It ships scripts or asks for a shell; skills here are instructions only, so those parts won't run."
      className="shrink-0 text-amber-600"
    >
      <AlertTriangle className="size-3.5" />
    </span>
  );
}

const MODES: { mode: SkillMode; label: string; title: string }[] = [
  { mode: "auto", label: "Auto", title: "Claude may use it on its own; /name runs it too" },
  { mode: "manual", label: "Manual", title: "Only when you type /name" },
  { mode: "off", label: "Off", title: "Not available to Claude" },
];

const MODE_LABEL: Record<SkillMode, string> = { auto: "Auto", manual: "Manual", off: "Off" };

/** Whether a skill's SKILL.md allows this mode. */
const allows = (skill: SkillInfo, mode: SkillMode) =>
  !(mode === "auto" && !skill.modelInvocable) && !(mode === "manual" && !skill.userInvocable);

/** A select for one level's choice; "" means no choice there (the level above applies). */
function ModeSelect({
  skill,
  value,
  inherit,
  onChange,
  label,
  testId,
}: {
  skill: SkillInfo;
  value: SkillMode | null;
  /** What applies with no choice here, e.g. "Default (Auto)". */
  inherit: string;
  onChange: (mode: SkillMode | null) => void;
  label: string;
  testId: string;
}) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || null) as SkillMode | null)}
      className="rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-xs"
    >
      <option value="">{inherit}</option>
      {MODES.map(({ mode, label }) => (
        <option key={mode} value={mode} disabled={!allows(skill, mode)}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The Skills view of the side panel. `fallback` (the skill files here) shows when skills can't be loaded, and below them with browser-only files. */
export function SkillsPanel({ fallback }: { fallback: ReactNode }) {
  const { skills, status, canSetDefaults, setMode } = useSkills();
  const ws = useWorkspace();
  const atRoot = ws.node === null && !ws.experiment;
  const [browsing, setBrowsing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (status === "loading") {
    return <p className="px-3 py-2 text-[var(--muted-foreground)]">Loading skills…</p>;
  }
  if (status === "unavailable") return <>{fallback}</>;

  const noticeLine = notice && (
    <p
      role="status"
      data-testid="skill-notice"
      className={cn(
        "mx-3 mb-2 rounded px-2 py-1.5 text-xs",
        notice.kind === "error" ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-[var(--secondary)]",
      )}
    >
      {notice.text}
    </p>
  );

  if (browsing) {
    return (
      <div data-testid="skills-panel" className="flex flex-col">
        {noticeLine}
        <HubBrowser onClose={() => setBrowsing(false)} notify={setNotice} />
      </div>
    );
  }

  return (
    <div data-testid="skills-panel" className="flex flex-col">
      <SkillsToolbar onBrowse={() => { setNotice(null); setBrowsing(true); }} notify={setNotice} />
      {noticeLine}
      <p className="px-3 pb-2 text-xs text-[var(--muted-foreground)]">
        Auto: Claude uses it when it fits. Manual: only when you type /name in the chat. Your choice
        applies to all your chats; the bar under the chat sets one chat's own.
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
      {skills.map((skill) => {
        // Yours (or what you get without a choice); a chat's own choice shows in the status bar.
        const yours = resolveMode(skill, ["user", "workspace"]);
        const everyone = resolveMode(skill, ["workspace"]);
        return (
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
                {skill.source === "builtin" ? "Built-in" : skill.hub ? `Hub v${skill.hub.version}` : "Workspace"}
              </span>
              {skill.hub && <TrustBadges {...skill.hub} />}
              {skill.needsExecution && <ScriptsBadge />}
            </div>
            {skill.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">{skill.description}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <div
                role="radiogroup"
                aria-label={`${skill.name} mode`}
                className="inline-flex overflow-hidden rounded border border-[var(--border)]"
              >
                {MODES.map(({ mode, label, title }) => {
                  const disabled = !allows(skill, mode);
                  const active = yours === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={disabled}
                      title={disabled ? "This skill's SKILL.md doesn't allow this" : title}
                      onClick={() => void setMode(skill.name, mode, "user")}
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
              {skill.userMode !== null ? (
                <button
                  type="button"
                  data-testid="skill-use-default"
                  title={`Go back to what everyone gets (${MODE_LABEL[everyone]})`}
                  onClick={() => void setMode(skill.name, null, "user")}
                  className="text-[var(--muted-foreground)] underline-offset-2 hover:underline cursor-pointer"
                >
                  Use default
                </button>
              ) : (
                <span className="text-[var(--muted-foreground)]">
                  {skill.workspaceMode !== null ? "Workspace default" : "Default"}
                </span>
              )}
            </div>
            {canSetDefaults && (
              <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                For everyone:
                <ModeSelect
                  skill={skill}
                  value={skill.workspaceMode}
                  inherit={`Skill default (${MODE_LABEL[resolveMode(skill, [])]})`}
                  onChange={(mode) => void setMode(skill.name, mode, "workspace")}
                  label={`${skill.name} mode for everyone`}
                  testId="skill-workspace-mode"
                />
              </label>
            )}
            <SkillActions skill={skill} notify={setNotice} />
          </div>
        );
      })}
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

/** The chat's input slot: CopilotKit's input plus the skills "/" menu, the memory line and the skills status bar. */
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
        <MemoryStatus />
        {status === "ready" ? (
          <SkillStatusBar skills={skills} turn={turn} />
        ) : (
          <div className="pb-4" />
        )}
      </div>
    </SlashContext.Provider>
  );
}

/** One line under the input: the skills that are on, then what this turn used; and this chat's own choices. */
function SkillStatusBar({ skills, turn }: { skills: SkillInfo[]; turn: Turn }) {
  const { setMode } = useSkills();
  const [open, setOpen] = useState(false);
  const auto = skills.filter((s) => s.mode === "auto").length;
  const manual = skills.filter((s) => s.mode === "manual").length;
  const changed = skills.filter((s) => s.chatMode !== null).length;
  return (
    <div className="relative mx-auto max-w-3xl">
      {open && (
        <div
          data-testid="chat-skills"
          className="absolute inset-x-4 bottom-full z-30 mb-1 max-h-72 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 text-xs shadow-lg @3xl:inset-x-0"
        >
          <p className="px-1 pb-1.5 text-[var(--muted-foreground)]">
            Skills in this chat only. &ldquo;Yours&rdquo; follows your choice in the Skills panel.
          </p>
          {skills.map((skill) => (
            <div key={skill.name} data-skill={skill.name} className="flex items-center gap-2 px-1 py-1">
              <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
              <ModeSelect
                skill={skill}
                value={skill.chatMode}
                inherit={`Yours (${MODE_LABEL[resolveMode(skill, ["user", "workspace"])]})`}
                onChange={(mode) => void setMode(skill.name, mode, "chat")}
                label={`${skill.name} mode in this chat`}
                testId="skill-chat-mode"
              />
            </div>
          ))}
        </div>
      )}
      <div
        data-testid="skill-status"
        className="pointer-events-auto flex flex-wrap items-center gap-1.5 px-5 pt-1.5 pb-3 text-xs text-[var(--muted-foreground)]"
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
        <button
          type="button"
          data-testid="chat-skills-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="ml-auto rounded px-1.5 py-0.5 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
        >
          This chat{changed > 0 ? ` · ${changed} changed` : ""}
        </button>
      </div>
    </div>
  );
}
