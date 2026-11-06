"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Files,
  FilePlus,
  FlaskConical,
  ListFilter,
  ListTodo,
  LocateFixed,
  Lock,
  Network,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ActionsBlock } from "./actions";
import { FileIcon } from "./file-icon";
import {
  ancestorFolders,
  buildTree,
  filterFiles,
  folderOf,
  folderPaths,
  newFilePath,
  type Folder,
} from "./file-tree";
import { KnowledgeTree } from "./knowledge-tree";
import { persistCollapsedFolders, readCollapsedFolders } from "./local-persistence";
import { experimentPlace, type PlaceId } from "./server-files";
import type { SidebarView } from "./layout";
import { placeName, StateBadge, StatusBadge } from "./experiment-panel";
import { runsUnder } from "./runs";
import { SearchPanel } from "./search-panel";
import { MemoryPanel, useMemory } from "./memory";
import { SkillsPanel } from "./skills";
import { useWorkspace } from "./store";
import { uploadFiles } from "./upload";
import { useWorkbench } from "./workbench";
import {
  EXPERIMENT_TAB,
  fileName,
  FileExistsError,
  ReadOnlyFileError,
  RUNS_TAB,
  TASKS_TAB,
  type WorkspaceFile,
} from "./types";

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

export function SidePanel({ view }: { view: SidebarView }) {
  const { files, write, canEdit: mayEdit, storageMode } = useWorkspace();
  const { editor, notify } = useWorkbench();
  const { open } = editor;
  // Until storage answers, the files here may be this browser's copy rather
  // than the server's, so the panel waits instead of showing one, then the other.
  const loading = storageMode === "loading" && view !== "search" && view !== "memory";
  const canEdit = mayEdit && !loading;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const explorer = useExplorer();

  const upload = async (list: FileList | null) => {
    const written = await uploadFiles(list, write, (path) =>
      notify(`${path} is read-only, so the upload was skipped.`, "warning"),
    );
    if (written.length) open(written[written.length - 1]);
  };

  const newSkill = () => {
    const taken = new Set(files.map((f) => f.path));
    let n = 1;
    while (taken.has(`skills/new-skill-${n}/SKILL.md`)) n++;
    const content = `---\nname: new-skill-${n}\ndescription: When Claude should use this skill.\n---\n\n# New skill\n\nSteps Claude should follow.\n`;
    open(write(`skills/new-skill-${n}/SKILL.md`, content).path);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  const label = VIEWS.find((v) => v.id === view)?.label ?? "";
  const title = label;
  const fileTools = view === "files" && !loading;
  // Viewers see the files but get no controls that change them.
  const actions: ReactNode = (
    <>
      {canEdit && view === "files" && (
        <IconButton label="New file" onClick={() => explorer.startNewFile()}>
          <FilePlus className="size-4" />
        </IconButton>
      )}
      {canEdit && (view === "files" || view === "uploads") && (
        <IconButton label="Upload files" onClick={() => inputRef.current?.click()}>
          <Upload className="size-4" />
        </IconButton>
      )}
      {canEdit && view === "skills" && (
        <IconButton label="New skill" onClick={newSkill}>
          <FilePlus className="size-4" />
        </IconButton>
      )}
      {fileTools && <ExplorerTools explorer={explorer} />}
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
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
        <span className="min-w-0 truncate">{title}</span>
        <div role="toolbar" aria-label={`${title} actions`} className="flex shrink-0 items-center normal-case">
          {actions}
        </div>
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
        {loading ? (
          <FilesLoading />
        ) : (
          <>
            {view === "files" && <FilesView explorer={explorer} canEdit={canEdit} />}
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
          </>
        )}
      </div>
      {view === "files" && !loading && <ActionsBlock />}
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

/** Placeholder rows while the workspace asks storage for its files. */
function FilesLoading() {
  return (
    <div role="status" aria-live="polite" data-testid="files-loading" className="px-3 py-2">
      <div className="flex items-center gap-2 text-[var(--muted-foreground)]">
        <Spinner size="sm" />
        Loading files…
      </div>
      <div aria-hidden className="mt-3 space-y-2.5">
        {[70, 55, 80, 45, 65].map((width, i) => (
          <div key={i} className="flex animate-pulse items-center gap-2" style={{ paddingLeft: i % 2 ? 16 : 0 }}>
            <span className="size-4 shrink-0 rounded bg-[var(--muted)]" />
            <span className="h-3 rounded bg-[var(--muted)]" style={{ width: `${width}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] cursor-pointer",
        "hover:bg-[var(--secondary)] hover:text-[var(--foreground)]",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--muted-foreground)]",
        pressed && "bg-[var(--secondary)] text-[var(--foreground)]",
      )}
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

const NO_FOLDERS = new Set<string>();

/** Reading localStorage itself throws when the browser blocks site storage. */
function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Which folders are collapsed in this place's file tree, remembered in this
 * browser so switching views or reloading keeps them as the user left them.
 */
function useCollapsedFolders() {
  const { node, experiment } = useWorkspace();
  const place: PlaceId = experiment ? experimentPlace(experiment.id) : node;
  const [saved, setSaved] = useState<{ place: PlaceId; paths: Set<string> } | null>(null);
  useEffect(() => {
    const storage = localStorageOrNull();
    setSaved({ place, paths: new Set(storage ? readCollapsedFolders(storage, place) : []) });
  }, [place]);
  const collapsed = saved?.place === place ? saved.paths : NO_FOLDERS;
  const set = (next: Set<string>) => {
    setSaved({ place, paths: next });
    const storage = localStorageOrNull();
    if (storage) persistCollapsedFolders(storage, place, [...next]);
  };
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set(next);
  };
  /** Opens these folders (e.g. the ones a file is in). */
  const expand = (paths: string[]) => {
    if (!paths.some((p) => collapsed.has(p))) return;
    set(new Set([...collapsed].filter((p) => !paths.includes(p))));
  };
  return { collapsed, toggle, expand, set };
}

type CollapsedFolders = ReturnType<typeof useCollapsedFolders>;

/**
 * State behind the Files view's toolbar: folders, the name filter, the
 * new-file box, and requests to scroll the open file into view.
 */
function useExplorer() {
  const { files, activeFile, refresh, storageMode } = useWorkspace();
  const { notify } = useWorkbench();
  const folders = useCollapsedFolders();
  const tree = useMemo(() => buildTree(files), [files]);
  const allFolders = useMemo(() => folderPaths(tree), [tree]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The new-file box, with what it starts with; null when closed. */
  const [newFile, setNewFile] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string; at: number } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const allCollapsed = allFolders.length > 0 && allFolders.every((p) => folders.collapsed.has(p));
  const filtering = filterOpen && query.trim() !== "";

  return {
    folders,
    files,
    filterOpen,
    query,
    filtering,
    setQuery,
    newFile,
    reveal,
    refreshing,
    allCollapsed,
    hasFolders: allFolders.length > 0,
    canRefresh: storageMode === "server",
    activeFile,
    toggleAll() {
      folders.set(allCollapsed ? new Set() : new Set(allFolders));
    },
    toggleFilter() {
      if (filterOpen) setQuery("");
      setFilterOpen(!filterOpen);
    },
    closeFilter() {
      setQuery("");
      setFilterOpen(false);
    },
    /** Opens the folders down to the open file and scrolls to it. */
    revealActive() {
      if (!activeFile) return;
      // Keep the filter only while it still shows the file.
      if (filtering && !filterFiles([activeFile], query).length) {
        setQuery("");
        setFilterOpen(false);
      }
      folders.expand(ancestorFolders(activeFile.path));
      setReveal({ path: activeFile.path, at: Date.now() });
    },
    /** Opens the new-file box in `folder` ("a/b/"), or notes/ by default. */
    startNewFile(folder = "notes/") {
      const taken = new Set(files.map((f) => f.path));
      let n = 1;
      while (taken.has(`${folder}untitled-${n}.md`)) n++;
      setNewFile(`${folder}untitled-${n}.md`);
      if (folder) folders.expand(ancestorFolders(`${folder}x`));
    },
    cancelNewFile() {
      setNewFile(null);
    },
    /** After the new-file box made `path`: show it in the tree. */
    created(path: string) {
      setNewFile(null);
      if (filtering && !filterFiles([{ path }], query).length) setQuery("");
      folders.expand(ancestorFolders(path));
      setReveal({ path, at: Date.now() });
    },
    async refresh() {
      setRefreshing(true);
      try {
        await refresh();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        setRefreshing(false);
      }
    },
  };
}

type Explorer = ReturnType<typeof useExplorer>;

/** The Files view's toolbar buttons that don't change files (viewers get them too). */
function ExplorerTools({ explorer }: { explorer: Explorer }) {
  return (
    <>
      <IconButton
        label={explorer.filterOpen ? "Close filter" : "Filter files"}
        pressed={explorer.filterOpen}
        onClick={explorer.toggleFilter}
      >
        <ListFilter className="size-4" />
      </IconButton>
      <IconButton
        label="Reveal open file"
        disabled={!explorer.activeFile}
        onClick={explorer.revealActive}
      >
        <LocateFixed className="size-4" />
      </IconButton>
      {explorer.canRefresh && (
        <IconButton
          label={explorer.refreshing ? "Refreshing files" : "Refresh files"}
          disabled={explorer.refreshing}
          onClick={() => void explorer.refresh()}
        >
          <RefreshCw className={cn("size-4", explorer.refreshing && "animate-spin")} />
        </IconButton>
      )}
      <IconButton
        label={explorer.allCollapsed ? "Expand all folders" : "Collapse all folders"}
        disabled={!explorer.hasFolders}
        onClick={explorer.toggleAll}
      >
        {explorer.allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
      </IconButton>
    </>
  );
}

/** The Files view: the filter and new-file boxes when open, then the tree. */
function FilesView({ explorer, canEdit }: { explorer: Explorer; canEdit: boolean }) {
  const shown = useMemo(
    () => (explorer.filtering ? filterFiles(explorer.files, explorer.query) : explorer.files),
    [explorer.files, explorer.filtering, explorer.query],
  );
  return (
    <>
      {explorer.filterOpen && (
        <div className="flex h-8 items-center gap-1 px-3 pb-1">
          <input
            autoFocus
            // A plain box (not type=search) so browsers don't add a second clear button.
            role="searchbox"
            aria-label="Filter files by name"
            placeholder="Filter by name"
            value={explorer.query}
            onChange={(e) => explorer.setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && explorer.closeFilter()}
            className="h-6 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
          />
          {explorer.query && (
            <button
              type="button"
              aria-label="Clear filter"
              title="Clear filter"
              onClick={() => explorer.setQuery("")}
              className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {explorer.filtering && !shown.length ? (
        <p className="px-3 py-2 text-[var(--muted-foreground)]">No file names match “{explorer.query.trim()}”.</p>
      ) : (
        <FileTreeView
          files={shown}
          folders={explorer.folders}
          // Matches show wherever they are, inside collapsed folders too.
          allOpen={explorer.filtering}
          reveal={explorer.reveal}
          onNewFileIn={canEdit ? (folder) => explorer.startNewFile(`${folder}/`) : undefined}
          newFile={
            explorer.newFile !== null && canEdit
              ? {
                  folder: folderOf(explorer.newFile).replace(/\/$/, ""),
                  input: (depth) => (
                    <NewFileInput
                      key={explorer.newFile}
                      initial={explorer.newFile!}
                      depth={depth}
                      onDone={explorer.created}
                      onCancel={explorer.cancelNewFile}
                    />
                  ),
                }
              : null
          }
        />
      )}
    </>
  );
}

/** Inline box for a new file's path; Enter creates and opens it, Escape cancels. */
function NewFileInput({
  initial,
  depth,
  onDone,
  onCancel,
}: {
  initial: string;
  depth: number;
  onDone: (path: string) => void;
  onCancel: () => void;
}) {
  const { files, create } = useWorkspace();
  const { open } = useWorkbench().editor;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Leaving the box cancels it, except while it creates the file.
  const busy = useRef(false);
  const submit = async () => {
    if (busy.current) return;
    const checked = newFilePath(value, new Set(files.map((f) => f.path)));
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    busy.current = true;
    try {
      const file = await create(checked.path, "");
      onDone(file.path);
      open(file.path);
    } catch (err) {
      setError(
        err instanceof FileExistsError
          ? `${checked.path} already exists`
          : err instanceof ReadOnlyFileError
            ? `${checked.path} is read-only`
            : err instanceof Error
              ? err.message
              : String(err),
      );
    } finally {
      busy.current = false;
    }
  };
  return (
    <div style={{ paddingLeft: 12 + depth * 12 }} className="pr-2">
      <div className="flex h-7 items-center gap-1.5">
        <FilePlus className="size-4 shrink-0 text-[var(--muted-foreground)]" />
        <input
          autoFocus
          aria-label="New file path"
          title="Type a path; folders in it are created too"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          // Select the name without its folder and extension, ready to type over.
          onFocus={(e) => {
            const start = folderOf(initial).length;
            const dot = initial.lastIndexOf(".");
            e.currentTarget.setSelectionRange(start, dot > start ? dot : initial.length);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onCancel();
          }}
          onBlur={() => !busy.current && onCancel()}
          className="h-6 min-w-0 flex-1 rounded border border-[var(--ring)] bg-[var(--background)] px-1.5 text-[13px] outline-none"
        />
      </div>
      {error && (
        <p role="alert" className="pb-1 pl-5 text-[12px] text-[var(--destructive)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** The place's files as a folder tree (also nested in the knowledge tree). */
export function FileTree({ files, depth = 0 }: { files: WorkspaceFile[]; depth?: number }) {
  const folders = useCollapsedFolders();
  return <FileTreeView files={files} depth={depth} folders={folders} />;
}

function FileTreeView({
  files,
  depth: start = 0,
  folders: { collapsed, toggle },
  allOpen = false,
  reveal = null,
  onNewFileIn,
  newFile = null,
}: {
  files: WorkspaceFile[];
  depth?: number;
  folders: CollapsedFolders;
  /** Shows every folder open without changing what's remembered. */
  allOpen?: boolean;
  /** Scrolls to and focuses this file once its row is shown. */
  reveal?: { path: string; at: number } | null;
  /** Adds a "new file here" button to each folder. */
  onNewFileIn?: (folder: string) => void;
  /** The new-file box, shown first in its folder (at the top when that isn't here yet). */
  newFile?: { folder: string; input: (depth: number) => ReactNode } | null;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const newFileAt = useMemo(
    () => (newFile && folderPaths(tree).includes(newFile.folder) ? newFile.folder : ""),
    [newFile, tree],
  );
  const ref = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);

  // Once per request, as soon as the row is there: the folders it opened, or
  // the file just created, may only show in a later render.
  useEffect(() => {
    if (!reveal || revealed.current === reveal.at) return;
    const row = [...(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(
      (el) => el.title === reveal.path,
    );
    if (!row) return;
    revealed.current = reveal.at;
    row.scrollIntoView({ block: "nearest" });
    row.focus({ preventScroll: true });
  }, [reveal, collapsed, tree]);

  const render = (folder: Folder, depth: number): ReactNode => (
    <>
      {newFile && newFileAt === folder.path && newFile.input(depth)}
      {folder.folders.map((sub) => {
        const isOpen = allOpen || !collapsed.has(sub.path);
        const Chevron = isOpen ? ChevronDown : ChevronRight;
        return (
          <div key={sub.path} role="group">
            <div className="group flex h-7 items-center pr-2 hover:bg-[var(--secondary)]">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(sub.path)}
                style={{ paddingLeft: 8 + depth * 12 }}
                className="flex h-full min-w-0 flex-1 items-center gap-1 text-left font-medium cursor-pointer"
              >
                <Chevron className="size-4 shrink-0 text-[var(--muted-foreground)]" />
                <span className="truncate">{sub.name}</span>
              </button>
              {onNewFileIn && (
                <button
                  type="button"
                  aria-label={`New file in ${sub.path}`}
                  title="New file in this folder"
                  onClick={() => onNewFileIn(sub.path)}
                  className="hidden size-5 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] group-hover:flex group-focus-within:flex cursor-pointer"
                >
                  <Plus className="size-3.5" />
                </button>
              )}
            </div>
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
  return (
    <div ref={ref} role={start ? "group" : "tree"}>
      {render(tree, start)}
    </div>
  );
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
        {ws.experiment?.access === "writer" && (
          <IconButton label={`Add files to ${ws.experiment.title}`} onClick={() => editor.open(EXPERIMENT_TAB)}>
            <Upload className="size-4" />
          </IconButton>
        )}
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
