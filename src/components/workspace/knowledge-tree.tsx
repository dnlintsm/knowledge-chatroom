"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FlaskConical, House, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./experiment-panel";
import type { Experiment, KnowledgeNode, NodeId, Role } from "./server-files";
import { FileTree } from "./sidebar";
import { useWorkspace } from "./store";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const atLeast = (role: Role | null, min: Role) => role !== null && RANK[role] >= RANK[min];

type Editing =
  | { mode: "add"; parentId: NodeId }
  | { mode: "rename"; id: string }
  | { mode: "experiment"; nodeId: string }
  | null;

/**
 * The knowledge tree (tech › module › loop › process, or whatever levels the
 * deployment set up). Clicking a node moves the workspace there; that place's
 * files show under it and in the other views. Experiments are listed under
 * their node with their status; anyone who can view a node can start one.
 */
export function KnowledgeTree() {
  const ws = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);

  const children = useMemo(() => {
    const map = new Map<string | null, KnowledgeNode[]>();
    for (const n of ws.nodes) map.set(n.parentId, [...(map.get(n.parentId) ?? []), n]);
    return map;
  }, [ws.nodes]);
  const experimentsOn = useMemo(() => {
    const map = new Map<string, Experiment[]>();
    for (const e of ws.experiments) map.set(e.nodeId, [...(map.get(e.nodeId) ?? []), e]);
    return map;
  }, [ws.experiments]);
  const typeAt = (depth: number) => ws.nodeTypes.find((t) => t.depth === depth)?.name;

  if (ws.storageMode !== "server") {
    return (
      <p className="px-3 py-2 text-[var(--muted-foreground)]">
        The knowledge tree needs server storage. Set DATABASE_URL for the agent (see the
        README) to organize files by tech, module, loop and process.
      </p>
    );
  }

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
      setEditing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const enter = (id: NodeId) => {
    setError(null);
    void ws.enterNode(id);
  };

  const addInput = (parentId: NodeId, depth: number) =>
    editing?.mode === "add" && editing.parentId === parentId ? (
      <NameInput
        depth={depth}
        placeholder={`New ${typeAt(depth + 1) ?? "node"} name`}
        onCancel={() => setEditing(null)}
        onSubmit={(name) => run(() => ws.createNode(parentId, name))}
      />
    ) : null;

  const here = (depth: number) => <FileTree files={ws.files} depth={depth} />;

  const experimentRows = (nodeId: string, depth: number) => (
    <>
      {(experimentsOn.get(nodeId) ?? []).map((e) => {
        const current = ws.experiment?.id === e.id;
        const go = () => {
          setError(null);
          void ws.enterExperiment(e.id);
        };
        return (
          <div key={e.id} role="group">
            <div
              role="treeitem"
              aria-selected={current}
              tabIndex={0}
              data-testid="experiment-node"
              title={e.mine ? undefined : `By ${e.authorName ?? "someone else"}`}
              onClick={go}
              onKeyDown={(ev) => ev.key === "Enter" && go()}
              style={{ paddingLeft: 4 + depth * 12 }}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1 pr-2",
                current
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "hover:bg-[var(--secondary)]",
              )}
            >
              <span className="flex size-4 items-center justify-center text-[var(--muted-foreground)]">
                <FlaskConical className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <StatusBadge status={e.status} />
            </div>
            {current && here(depth + 1)}
          </div>
        );
      })}
      {editing?.mode === "experiment" && editing.nodeId === nodeId && (
        <NameInput
          depth={depth}
          placeholder="New experiment title"
          onCancel={() => setEditing(null)}
          onSubmit={(title) => run(() => ws.createExperiment(nodeId, title))}
        />
      )}
    </>
  );

  const render = (parentId: string | null, depth: number): ReactNode =>
    (children.get(parentId) ?? []).map((n) => {
      const kids = children.get(n.id) ?? [];
      const exps = experimentsOn.get(n.id) ?? [];
      const current = ws.node === n.id && !ws.experiment;
      const isOpen = !collapsed.has(n.id);
      // Nodes you can't open are shown only as the path to ones you can.
      const open = n.role !== null;
      const canAdd = atLeast(n.role, "editor") && Boolean(typeAt(n.depth + 1));
      const go = () => (open ? enter(n.id) : toggle(n.id));
      const Chevron = isOpen ? ChevronDown : ChevronRight;
      return (
        <div key={n.id} role="group">
          {editing?.mode === "rename" && editing.id === n.id ? (
            <NameInput
              depth={depth}
              initial={n.name}
              onCancel={() => setEditing(null)}
              onSubmit={(name) => run(() => ws.renameNode(n.id, name))}
            />
          ) : (
            <div
              role="treeitem"
              aria-selected={current}
              aria-expanded={kids.length || exps.length || current ? isOpen : undefined}
              tabIndex={0}
              data-testid="knowledge-node"
              title={open ? undefined : "You can't open this; it leads to something shared with you"}
              onClick={go}
              onKeyDown={(e) => e.key === "Enter" && go()}
              style={{ paddingLeft: 4 + depth * 12 }}
              className={cn(
                "group flex h-7 cursor-pointer items-center gap-1 pr-2",
                current
                  ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                  : "hover:bg-[var(--secondary)]",
              )}
            >
              <button
                type="button"
                aria-label={isOpen ? `Collapse ${n.name}` : `Expand ${n.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(n.id);
                }}
                className={cn(
                  "flex size-4 items-center justify-center text-[var(--muted-foreground)] cursor-pointer",
                  !kids.length && !exps.length && !current && "invisible",
                )}
              >
                <Chevron className="size-4" />
              </button>
              <span className={cn("min-w-0 flex-1 truncate font-medium", !open && "text-[var(--muted-foreground)]")}>
                {n.name}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)] group-hover:hidden">
                {n.type}
              </span>
              <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                {canAdd && (
                  <RowAction
                    label={`Add ${typeAt(n.depth + 1)} under ${n.name}`}
                    onClick={() => {
                      setCollapsed((s) => {
                        const next = new Set(s);
                        next.delete(n.id);
                        return next;
                      });
                      setEditing({ mode: "add", parentId: n.id });
                    }}
                  >
                    <Plus className="size-3.5" />
                  </RowAction>
                )}
                {open && (
                  <RowAction
                    label={`New experiment on ${n.name}`}
                    onClick={() => {
                      setCollapsed((s) => {
                        const next = new Set(s);
                        next.delete(n.id);
                        return next;
                      });
                      setEditing({ mode: "experiment", nodeId: n.id });
                    }}
                  >
                    <FlaskConical className="size-3.5" />
                  </RowAction>
                )}
                {atLeast(n.role, "editor") && (
                  <RowAction label={`Rename ${n.name}`} onClick={() => setEditing({ mode: "rename", id: n.id })}>
                    <Pencil className="size-3.5" />
                  </RowAction>
                )}
                {atLeast(n.role, "owner") && (
                  <RowAction
                    label={`Delete ${n.name}`}
                    destructive
                    onClick={() => {
                      if (window.confirm(`Delete ${n.name} and everything under it, including files?`)) {
                        void run(() => ws.deleteNode(n.id));
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </RowAction>
                )}
              </span>
            </div>
          )}
          {isOpen && (
            <>
              {current && here(depth + 1)}
              {experimentRows(n.id, depth + 1)}
              {render(n.id, depth + 1)}
              {addInput(n.id, depth + 1)}
            </>
          )}
        </div>
      );
    });

  const top = typeAt(1);
  return (
    <div role="tree" aria-label="Knowledge tree">
      <div
        role="treeitem"
        aria-selected={ws.node === null}
        tabIndex={0}
        onClick={() => enter(null)}
        onKeyDown={(e) => e.key === "Enter" && enter(null)}
        className={cn(
          "group flex h-7 cursor-pointer items-center gap-1.5 pl-2 pr-2",
          ws.node === null
            ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
            : "hover:bg-[var(--secondary)]",
        )}
      >
        <House className="size-4 text-[var(--muted-foreground)]" />
        <span className="min-w-0 flex-1 truncate font-medium">Workspace</span>
        {top && atLeast(ws.rootRole, "editor") && (
          <RowAction label={`New ${top}`} onClick={() => setEditing({ mode: "add", parentId: null })}>
            <Plus className="size-3.5" />
          </RowAction>
        )}
      </div>
      {ws.node === null && here(1)}
      {render(null, 0)}
      {addInput(null, 0)}
      {!ws.nodes.length && editing === null && (
        <p className="px-3 py-2 text-[var(--muted-foreground)]">
          {atLeast(ws.rootRole, "editor") ? (
            <>
              No {top ?? "nodes"} yet. Use + to add one, then add{" "}
              {ws.nodeTypes.slice(1).map((t) => t.name).join(", ")} levels under it.
            </>
          ) : (
            "Nothing in the knowledge tree is shared with you yet."
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

function RowAction({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] cursor-pointer",
        destructive ? "hover:text-[var(--destructive)]" : "hover:text-[var(--foreground)]",
      )}
    >
      {children}
    </button>
  );
}

function NameInput({
  depth,
  initial = "",
  placeholder,
  onSubmit,
  onCancel,
}: {
  depth: number;
  initial?: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ paddingLeft: 24 + depth * 12 }} className="flex h-7 items-center pr-2">
      <input
        autoFocus
        aria-label={placeholder ?? "Name"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onSubmit(value);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={onCancel}
        className="h-6 w-full rounded border border-[var(--ring)] bg-[var(--background)] px-1.5 text-[13px] outline-none"
      />
    </div>
  );
}
