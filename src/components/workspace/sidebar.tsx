"use client";

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Files,
  FilePlus,
  ListTodo,
  MessagesSquare,
  Package,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { CopilotThreadsDrawer } from "@copilotkit/react-core/v2";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-icon";
import { useWorkspace } from "./store";
import { fileName, isTextFile, mimeForPath, TASKS_TAB, type FileKind, type WorkspaceFile } from "./types";

export type SidebarView = "files" | "skills" | "uploads" | "artifacts" | "chats";

const VIEWS: { id: SidebarView; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "uploads", label: "Uploads", icon: Upload },
  { id: "artifacts", label: "Artifacts", icon: Package },
  { id: "chats", label: "Chats", icon: MessagesSquare },
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
  return (
    <nav
      aria-label="Sidebar views"
      className="flex flex-col items-center gap-1 py-2 border-r border-[var(--border)] bg-[var(--secondary)]"
    >
      {VIEWS.map(({ id, label, icon: Icon }) => {
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
  const { files, write, open } = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const upload = async (list: FileList | null) => {
    let last: string | null = null;
    for (const file of Array.from(list ?? [])) {
      const { content, mime } = await readUpload(file);
      last = write(`uploads/${file.name}`, content, { mime }).path;
    }
    if (last) open(last);
  };

  const newFile = (kind: Extract<FileKind, "note" | "skill">) => {
    const taken = new Set(files.map((f) => f.path));
    let n = 1;
    const pathFor = (i: number) =>
      kind === "skill" ? `skills/new-skill-${i}/SKILL.md` : `notes/untitled-${i}.md`;
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

  const title = VIEWS.find((v) => v.id === view)?.label ?? "";
  const actions: ReactNode = (
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
        if (view === "chats") return;
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
        {view === "skills" && (
          <FlatList
            files={files.filter((f) => f.kind === "skill")}
            label={(f) => f.path.split("/")[1] ?? fileName(f.path)}
            empty="No skills yet. Skills are SKILL.md files that teach Claude a workflow."
          />
        )}
        {view === "uploads" && (
          <FlatList
            files={files.filter((f) => f.kind === "upload")}
            empty="Drop files here or use the upload button."
          />
        )}
        {view === "artifacts" && (
          <FlatList
            files={files.filter((f) => f.kind === "artifact")}
            empty="Files Claude creates show up here."
          />
        )}
        {view === "chats" && (
          <div className="h-full [&_copilotkit-threads-drawer]:h-full">
            <CopilotThreadsDrawer agentId="default" collapsible={false} label="Chats" />
          </div>
        )}
      </div>
      {view !== "chats" && (
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
  const { active, open, remove } = useWorkspace();
  const selected = active === file.path;
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => open(file.path)}
      onKeyDown={(e) => e.key === "Enter" && open(file.path)}
      title={file.path}
      style={{ paddingLeft: 12 + depth * 12 }}
      className={cn(
        "group flex h-7 cursor-pointer items-center gap-1.5 pr-2",
        selected ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "hover:bg-[var(--secondary)]",
      )}
    >
      <FileIcon file={file} />
      <span className="min-w-0 flex-1 truncate">{label ?? fileName(file.path)}</span>
      {file.author === "agent" && (
        <Bot className="size-3.5 shrink-0 text-[var(--muted-foreground)]" aria-label="Written by Claude" />
      )}
      <button
        type="button"
        aria-label={`Delete ${file.path}`}
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete ${file.path}?`)) remove(file.path);
        }}
        className="hidden size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] group-hover:flex cursor-pointer"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
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

function FileTree({ files }: { files: WorkspaceFile[] }) {
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

  return <div role="tree">{render(tree, 0)}</div>;
}
