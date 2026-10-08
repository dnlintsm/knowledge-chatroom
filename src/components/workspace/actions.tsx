"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./store";
import { useWorkbench, type Workbench } from "./workbench";

/**
 * Actions: buttons in the Actions block (bottom of the Files view in Focus
 * mode) that change the panes or write and open files for the current run.
 * They are data in one registry, so adding one never touches layout code;
 * they act only through the workbench contract and the workspace file API,
 * and the same runner serves the block and Claude (agentInvocable actions).
 */

export type Role = "viewer" | "editor" | "owner";

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function hasRole(role: Role, required: Role) {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Single-user until login and grants land (#4 step 4): the user may do everything. */
export const CURRENT_ROLE: Role = "owner";

export interface ActionContext {
  runDir: string;
  workbench: Workbench;
  workspace: ReturnType<typeof useWorkspace>;
  role: Role;
}

export interface ActionView {
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  busy?: boolean;
  /** Tooltip; says why when the action is disabled. */
  hint?: string;
}

export interface ActionDef {
  id: string;
  requiredRole: Role;
  /** Whether Claude may run it (through the runAction tool). */
  agentInvocable: boolean;
  /** What it does, for Claude. */
  description: string;
  /** Label, icon and state; may depend on the run (e.g. Generate → Open). */
  view(ctx: ActionContext): ActionView;
  run(ctx: ActionContext): void | Promise<void>;
}

const newChat: ActionDef = {
  id: "new-chat",
  requiredRole: "viewer",
  // It would end the conversation Claude is running in.
  agentInvocable: false,
  description: "Start a new, empty chat about the current run.",
  view: () => ({ label: "New Chat", icon: MessageSquarePlus, enabled: true, hint: "Start a new chat about this run" }),
  run: ({ workbench }) => workbench.chat.newThread(),
};

export const ACTIONS: ActionDef[] = [newChat];

export interface ActionItem {
  def: ActionDef;
  view: ActionView;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

interface ActionsValue {
  /** Actions for the current run, in registry order; empty in Traverse mode. */
  items: ActionItem[];
  /** Runs an action unless it is unknown, disabled, not allowed or already running. */
  run(id: string, by?: "user" | "agent"): Promise<ActionResult>;
}

/** How long after a start the same action is refused, covering a double click. */
const REPEAT_MS = 600;

const ActionsContext = createContext<ActionsValue | null>(null);

export function ActionsProvider({
  children,
  actions = ACTIONS,
}: {
  children: ReactNode;
  actions?: ActionDef[];
}) {
  const workbench = useWorkbench();
  const workspace = useWorkspace();
  const role = CURRENT_ROLE;
  const { runDir } = workbench;
  const ctx = useMemo<ActionContext | null>(
    () => (runDir ? { runDir, workbench, workspace, role } : null),
    [runDir, workbench, workspace, role],
  );
  const latest = useRef(ctx);
  latest.current = ctx;

  // Checked and set synchronously, so a double click (or the user and Claude
  // at once) can't start the same action twice.
  const running = useRef(new Set<string>());
  // A double click's second click can land after a synchronous action (New
  // Chat) has already finished, so a start also blocks repeats for a moment.
  const lastStart = useRef(new Map<string, number>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const viewOf = useCallback(
    (def: ActionDef, c: ActionContext): ActionView => {
      const view = def.view(c);
      const allowed = hasRole(c.role, def.requiredRole);
      const isBusy = Boolean(view.busy) || busy.has(def.id);
      return {
        ...view,
        busy: isBusy,
        enabled: view.enabled && allowed && !isBusy,
        hint: allowed ? view.hint : `Needs the ${def.requiredRole} role on this run`,
      };
    },
    [busy],
  );

  const items = useMemo(
    () => (ctx ? actions.map((def) => ({ def, view: viewOf(def, ctx) })) : []),
    [ctx, actions, viewOf],
  );

  const run = useCallback(
    async (id: string, by: "user" | "agent" = "user"): Promise<ActionResult> => {
      const c = latest.current;
      const def = actions.find((a) => a.id === id);
      if (!def) return { ok: false, error: `No action "${id}"` };
      if (!c) return { ok: false, error: "Actions need a focused run" };
      if (by === "agent" && !def.agentInvocable) return { ok: false, error: `Claude can't run "${id}"` };
      if (!hasRole(c.role, def.requiredRole)) {
        return { ok: false, error: `"${id}" needs the ${def.requiredRole} role on this run` };
      }
      const repeated = Date.now() - (lastStart.current.get(id) ?? -Infinity) < REPEAT_MS;
      if (running.current.has(id) || repeated) return { ok: false, error: `"${id}" is already running` };
      const view = viewOf(def, c);
      if (!view.enabled) return { ok: false, error: view.hint ?? `"${id}" is not available` };

      running.current.add(id);
      lastStart.current.set(id, Date.now());
      setBusy(new Set(running.current));
      try {
        await def.run(c);
        return { ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        c.workbench.notify(`${view.label} failed: ${error}`, "error");
        return { ok: false, error };
      } finally {
        running.current.delete(id);
        setBusy(new Set(running.current));
      }
    },
    [actions, viewOf],
  );

  const value = useMemo(() => ({ items, run }), [items, run]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}

export function useActions() {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useActions must be used inside <ActionsProvider>");
  return ctx;
}

const COLLAPSED_KEY = "knowledge-chatroom.actions-collapsed.v1";

/** The foldable Actions block, like VS Code's Outline and Timeline sections. */
export function ActionsBlock() {
  const { items, run } = useActions();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "1");
    } catch {}
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });

  if (!items.length) return null;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section aria-label="Actions" data-testid="actions" className="shrink-0 border-t border-[var(--border)]">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex h-7 w-full items-center gap-1 px-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
      >
        <Chevron className="size-4" />
        Actions
      </button>
      {!collapsed && (
        <ul className="pb-1.5">
          {items.map(({ def, view }) => {
            const Icon = view.icon;
            return (
              <li key={def.id}>
                <button
                  type="button"
                  data-action={def.id}
                  disabled={!view.enabled}
                  aria-busy={view.busy || undefined}
                  title={view.hint}
                  onClick={() => void run(def.id)}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 px-3 text-left text-[13px]",
                    view.enabled
                      ? "hover:bg-[var(--secondary)] cursor-pointer"
                      : "text-[var(--muted-foreground)] cursor-not-allowed",
                  )}
                >
                  {view.busy ? <Spinner size="sm" className="shrink-0" /> : <Icon className="size-4 shrink-0" />}
                  <span className="truncate">{view.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
