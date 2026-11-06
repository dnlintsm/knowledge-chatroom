import { normalizePath } from "../../../shared/files";
import type { WorkspaceFile } from "./types";

/** Pure helpers behind the Files view's tree and its toolbar. */

export interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: WorkspaceFile[];
}

/** Folders come from the files' paths; there are no empty folders. */
export function buildTree(files: WorkspaceFile[]): Folder {
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

/** Every folder path under `folder`, parents before children. */
export function folderPaths(folder: Folder): string[] {
  return folder.folders.flatMap((sub) => [sub.path, ...folderPaths(sub)]);
}

/** The folders a file sits in, outermost first: "a/b/c.md" → ["a", "a/b"]. */
export function ancestorFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The folder a file is in, with a trailing slash ("" at the top level). */
export function folderOf(path: string | null | undefined): string {
  if (!path) return "";
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

/**
 * Files whose path contains every word of `query`, ignoring case; all of
 * them for a blank query. "run report" finds runs/etch/report.md.
 */
export function filterFiles<T extends Pick<WorkspaceFile, "path">>(files: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return files;
  return files.filter((f) => {
    const path = f.path.toLowerCase();
    return words.every((w) => path.includes(w));
  });
}

/**
 * The path typed into the new-file box, cleaned up, or a message saying
 * what's wrong with it. A name without an extension becomes a .md note.
 */
export function newFilePath(
  input: string,
  taken: ReadonlySet<string>,
): { path: string } | { error: string } {
  if (!input.trim()) return { error: "Type a file name" };
  if (input.trim().endsWith("/")) return { error: "Add a file name after the folder" };
  let path: string;
  try {
    path = normalizePath(input);
  } catch {
    return { error: "That isn't a valid file name" };
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name.includes(".")) path += ".md";
  if (taken.has(path)) return { error: `${path} already exists` };
  // A file can't sit where a file already is, e.g. notes.md/x.md.
  const clash = ancestorFolders(path).find((folder) => taken.has(folder));
  if (clash) return { error: `${clash} is a file, not a folder` };
  return { path };
}
