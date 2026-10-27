"use client";

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Files,
  FilePlus,
  FlaskConical,
  ListTodo,
  Lock,
  Network,
  Package,
  Pencil,
  Plus,
  Search,
  Table2,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionsBlock } from "./actions";
import { FileIcon } from "./file-icon";
import { KnowledgeTree } from "./knowledge-tree";
import type { SidebarView } from "./layout";
import { placeName, StateBadge, StatusBadge } from "./experiment-panel";
import { runsUnder } from "./runs";
import { SearchPanel } from "./search-panel";
import { MemoryPanel, useMemory } from "./memory";
import { SkillsPanel } from "./skills";
import { useWorkspace } from "./store";
import { useWorkbench } from "./workbench";
import { fileName, FileExistsError, isTextFile, mimeForPath, ReadOnlyFileError, RUNS_TAB, TASKS_TAB, type FileKind, type WorkspaceFile } from "./types";

export type { SidebarView };

const VIEWS: { id: SidebarView; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "runs", label: "Runs", icon: FlaskConical },
  { id: "knowledge", label: "Knowledge", icon: Network },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "uploads", label: "Uploads", icon: Upload },
  { id: "artifacts", label: "Artifacts", icon: Package },
];

/** VS Code-style icon rail. Clicking the active view collapses the panel. */
export function ActivityBar({
  view,
  panelOpen,
  onSelect,
}: {
  view: SidebarView;
  panelOpen: boolean;
  onSelect: (view: SidebarView) => void;
}) {
  // Memory shows only where the server has it (MEMORY=on with storage).
  const memory = useMemory().status !== "unavailable";
  return (
    <nav
      aria-label="Sidebar views"
      className="flex flex-col items-center gap-1 py-2 border-r border-[var(--border)] bg-[var(--secondary)]"
    >
      {VIEWS.filter(({ id }) => id !== "memory" || memory).map(({ id, label, icon: Icon }) => {
        const active = panelOpen && view === id;
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => onSelect(id)}
            className={cn(
              "relative flex size-10 items-center justify-center rounded-md transition-colors cursor-pointer",
              active
                ? "text-[var(--foreground)] bg-[var(--card)] shadow-sm"
                : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
            )}
          >
            <Icon className="size-5" />
          </button>
        );
      })}
    </nav>
  );
}

async function readUpload(file: File): Promise<{ content: string; mime: string }> {
  const mime = file.type || mimeForPath(file.name);
  if (isTextFile({ mime, path: file.name })) return { content: await file.text(), mime };
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { content, mime };
}

export function SidePanel({ view }: { view: SidebarView }) {
  const { files, write, canEdit } = useWorkspace();
  const { editor, notify } = useWorkbench();
  const { open } = editor;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const upload = async (list: FileList | null) => {
    let last: string | null = null;
    for (const file of Array.from(list ?? [])) {
      const { content, mime } = await readUpload(file);
      const path = `uploads/${file.name}`;
      try {
        last = write(path, content, { mime }).path;
      } catch (err) {
        if (!(err instanceof ReadOnlyFileError)) throw err;
        notify(`${path} is read-only, so the upload was skipped.`, "warning");
      }
    }
    if (last) open(last);
  };

  const newFile = (kind: Extract<FileKind, "note" | "skill">) => {
    const taken = new Set(files.map((f) => f.path));
    let n = 1;
    const pathFor = (i: number) =>
      kind === "skill"
        ? `skills/new-skill-${i}/SKILL.md`
        : `notes/untitled-${i}.md`;
    while (taken.has(pathFor(n))) n++;
    const content =
      kind === "skill"
        ? `---\nname: new-skill-${n}\ndescription: When Claude should use this skill.\n---\n\n# New skill\n\nSteps Claude should follow.\n`
        : "";
    open(write(pathFor(n), content).path);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  const label = VIEWS.find((v) => v.id === view)?.label ?? "";
  const title = label;
  // Viewers see the files but get no controls that change them.
  const actions: ReactNode = canEdit && (
    <>
      {(view === "files" || view === "uploads") && (
        <IconButton label="Upload files" onClick={() => inputRef.current?.click()}>
          <Upload className="size-4" />
        </IconButton>
      )}
      {view === "files" && (
        <IconButton label="New note" onClick={() => newFile("note")}>
          <FilePlus className="size-4" />
        </IconButton>
      )}
      {view === "skills" && (
        <IconButton label="New skill" onClick={() => newFile("skill")}>
          <FilePlus className="size-4" />
        </IconButton>
      )}
    </>
  );

  return (
    <section
      aria-label={title}
      data-testid="side-panel"
      className={cn(
        "flex h-full min-h-0 flex-col bg-[var(--background)]",
        dragging && "ring-2 ring-inset ring-[var(--ring)]",
      )}
      onDragOver={(e) => {
        if (view === "search" || view === "runs" || view === "memory" || !canEdit) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="flex h-10 shrink-0 items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
        {title}
        <div className="flex items-center gap-0.5 normal-case">{actions}</div>
      </header>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-4 text-[13px]">
        {view === "files" && <FileTree files={files} />}
        {view === "runs" && <RunList />}
        {view === "search" && <SearchPanel />}
        {view === "knowledge" && <KnowledgeTree />}
        {view === "skills" && (
          <SkillsPanel
            fallback={
              <FlatList
                files={files.filter((f) => f.kind === "skill")}
                label={(f) => f.path.split("/")[1] ?? fileName(f.path)}
                empty="No skills yet. Skills are SKILL.md files that teach Claude a workflow."
              />
            }
          />
        )}
        {view === "memory" && <MemoryPanel />}
        {view === "uploads" && (
          <FlatList
            files={files.filter((f) => f.kind === "upload")}
            empty={canEdit ? "Drop files here or use the upload button." : "No uploads here."}
          />
        )}
        {view === "artifacts" && (
          <FlatList
            files={files.filter((f) => f.kind === "artifact")}
            empty="Files Claude creates show up here."
          />
        )}
      </div>
      {view === "files" && <ActionsBlock />}
      {view !== "runs" && (
        <button
          type="button"
          onClick={() => open(TASKS_TAB)}
          className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-[13px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
        >
          <ListTodo className="size-4" /> Task board
        </button>
      )}
    </section>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] cursor-pointer"
    >
      {children}
    </button>
  );
}

function FileRow({
  file,
  label,
  depth = 0,
}: {
  file: WorkspaceFile;
  label?: string;
  depth?: number;
}) {
  const { active, remove, rename, canEdit } = useWorkspace();
  const { open } = useWorkbench().editor;
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = active === file.path;
  const name = fileName(file.path);
  const submit = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) {
      setRenaming(false);
      setError(null);
      return;
    }
    if (trimmed.includes("/")) {
      setError("A name can't contain /");
      return;
    }
    const folder = file.path.slice(0, file.path.length - name.length);
    try {
      await rename(file.path, folder + trimmed);
      setRenaming(false);
      setError(null);
    } catch (err) {
      setError(
        err instanceof FileExistsError
          ? `${trimmed} already exists here`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  };
  const actionClass = cn(
    "size-5 items-center justify-center rounded text-[var(--muted-foreground)] cursor-pointer",
    // Shown on the open file too, for touch screens that can't hover.
    selected ? "flex" : "hidden group-hover:flex group-focus-within:flex",
  );
  if (renaming) {
    return (
      <div style={{ paddingLeft: 12 + depth * 12 }} className="pr-2">
        <div className="flex h-7 items-center gap-1.5">
          <FileIcon file={file} />
          <RenameInput
            initial={name}
            label={`New name for ${file.path}`}
            onSubmit={(value) => void submit(value)}
            onCancel={() => {
              setRenaming(false);
              setError(null);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="pb-1 text-[12px] text-[var(--destructive)]">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => open(file.path)}
      onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && open(file.path)}
      title={file.path}
      style={{ paddingLeft: 12 + depth * 12 }}
      className={cn(
        "group flex h-7 cursor-pointer items-center gap-1.5 pr-2",
        selected ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "hover:bg-[var(--secondary)]",
      )}
    >
      <FileIcon file={file} />
      <span className="min-w-0 flex-1 truncate">{label ?? name}</span>
      {file.author === "agent" && (
        <Bot className="size-3.5 shrink-0 text-[var(--muted-foreground)]" aria-label="Written by Claude" />
      )}
      {file.readOnly ? (
        <Lock className="size-3.5 shrink-0 text-[var(--muted-foreground)]" aria-label="Read-only" />
      ) : (
        canEdit && (
          <>
            <button
              type="button"
              aria-label={`Rename ${file.path}`}
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
              className={cn(actionClass, "hover:text-[var(--foreground)]")}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`Delete ${file.path}`}
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete ${file.path}?`)) remove(file.path);
              }}
              className={cn(actionClass, "hover:text-[var(--destructive)]")}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )
      )}
    </div>
  );
}

function RenameInput({
  initial,
  label,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      // Select the name without its extension, as file managers do.
      onFocus={(e) => {
        const dot = initial.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(value);
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
      className="h-6 min-w-0 flex-1 rounded border border-[var(--ring)] bg-[var(--background)] px-1.5 text-[13px] outline-none"
    />
  );
}

function FlatList({
  files,
  empty,
  label,
}: {
  files: WorkspaceFile[];
  empty: string;
  label?: (f: WorkspaceFile) => string;
}) {
  if (!files.length) return <p className="px-3 py-2 text-[var(--muted-foreground)]">{empty}</p>;
  return (
    <div role="tree">
      {[...files]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((f) => (
          <FileRow key={f.path} file={f} label={label?.(f)} />
        ))}
    </div>
  );
}

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: WorkspaceFile[];
}

function buildTree(files: WorkspaceFile[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.files.sort((a, b) => a.path.localeCompare(b.path));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function FileTree({ files, depth: start = 0 }: { files: WorkspaceFile[]; depth?: number }) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (folder: Folder, depth: number): ReactNode => (
    <>
      {folder.folders.map((sub) => {
        const isOpen = !collapsed.has(sub.path);
        const Chevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <div key={sub.path} role="group">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggle(sub.path)}
              style={{ paddingLeft: 8 + depth * 12 }}
              className="flex h-7 w-full items-center gap-1 pr-2 text-left font-medium hover:bg-[var(--secondary)] cursor-pointer"
            >
              <Chevron className="size-4 text-[var(--muted-foreground)]" />
              {sub.name}
            </button>
            {isOpen && render(sub, depth + 1)}
          </div>
        );
      })}
      {folder.files.map((f) => (
        <FileRow key={f.path} file={f} depth={depth} />
      ))}
    </>
  );

  // Nested in the knowledge tree, this is a group inside that tree.
  return <div role={start ? "group" : "tree"}>{render(tree, start)}</div>;
}

/**
 * Runs view: every run here and below (all of them at the workspace root),
 * newest first; picking one moves into it and opens its report.
 */
function RunList() {
  const ws = useWorkspace();
  const { editor, notify } = useWorkbench();
  const [adding, setAdding] = useState(false);
  if (ws.storageMode !== "server") {
    return (
      <p className="px-3 py-2 text-[var(--muted-foreground)]">
        Runs need server storage. Set DATABASE_URL for the agent (see the README) to keep runs
        with their reports, parameters and results.
      </p>
    );
  }
  const runs = runsUnder(ws.experiments, ws.nodes, ws.node);
  // You can start a run wherever you can see the files (as for experiments).
  const role = ws.node === null ? ws.rootRole : (ws.nodes.find((n) => n.id === ws.node)?.role ?? null);
  const here = placeName(ws.nodes, ws.node);
  const start = async (title: string) => {
    try {
      await ws.createExperiment(ws.node, title);
      setAdding(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  };
  return (
    <div>
      <div className="flex items-center gap-1 px-3 pb-1 text-xs text-[var(--muted-foreground)]">
        <span className="min-w-0 flex-1 truncate">
          {ws.node === null ? "All runs" : `Runs in ${here}`}
        </span>
        {runs.length > 0 && (
          <IconButton label="Compare runs" onClick={() => editor.open(RUNS_TAB)}>
            <Table2 className="size-4" />
          </IconButton>
        )}
        {role && (
          <IconButton label={`New run in ${here}`} onClick={() => setAdding(true)}>
            <Plus className="size-4" />
          </IconButton>
        )}
      </div>
      {adding && <RunTitleInput onSubmit={(t) => void start(t)} onCancel={() => setAdding(false)} />}
      {runs.length ? (
        <ul aria-label="Runs" data-testid="run-list">
          {runs.map((e) => (
            <RunRow
              key={e.id}
              title={e.title}
              detail={[ws.node === e.nodeId ? null : placeName(ws.nodes, e.nodeId), e.mine ? null : e.authorName]
                .filter(Boolean)
                .join(" · ")}
              badges={
                <>
                  <StateBadge state={e.state} />
                  <StatusBadge status={e.status} />
                </>
              }
              current={ws.experiment?.id === e.id}
              onPick={() => void ws.enterExperiment(e.id)}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="px-3 py-2 text-[var(--muted-foreground)]">
            No runs {ws.node === null ? "yet" : "here yet"}. A run is an experiment with a report.md:
            start one with +, or ask Claude to analyze your uploads.
          </p>
        )
      )}
    </div>
  );
}

function RunTitleInput({ onSubmit, onCancel }: { onSubmit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex h-7 items-center px-3">
      <input
        autoFocus
        aria-label="New run title"
        placeholder="New run title"
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

function RunRow({
  title,
  detail,
  badges,
  current,
  onPick,
}: {
  title: string;
  detail: string;
  badges: ReactNode;
  current: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={current ? "true" : undefined}
        title={`Open ${title}`}
        onClick={onPick}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-1.5 text-left cursor-pointer",
          current ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "hover:bg-[var(--secondary)]",
        )}
      >
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-[var(--muted-foreground)]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{title}</span>
            {badges}
          </span>
          {detail && <span className="block truncate text-xs text-[var(--muted-foreground)]">{detail}</span>}
        </span>
      </button>
    </li>
  );
}
