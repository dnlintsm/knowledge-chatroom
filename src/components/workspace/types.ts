/**
 * Workspace model: a flat list of files keyed by path. The top-level folder of
 * a path decides what kind of item it is, which the left rail groups by.
 *
 * Files use optional agent-backed storage, with a browser-local fallback
 * (see store.tsx and docs/architecture.md).
 */

import { extension, isTextFile as isTextContent } from "../../../shared/files";
import type { LocalFile as WorkspaceFile } from "../../../shared/storage-contract";
export type { LocalFile as WorkspaceFile } from "../../../shared/storage-contract";
export { extension, KIND_FOLDERS, kindForPath, mimeForPath, type FileKind } from "../../../shared/files";

/** An edit or delete of a read-only file. */
export class ReadOnlyFileError extends Error {
  constructor(readonly path: string) {
    super(`${path} is read-only`);
    this.name = "ReadOnlyFileError";
  }
}

/** A create-only write to a path that already has a file. */
export class FileExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists`);
    this.name = "FileExistsError";
  }
}

/** A tab in the middle pane: a file path, or the built-in task board. */
export type TabId = string;
export const TASKS_TAB: TabId = "::tasks";
/** The current experiment's hypothesis, params and results. */
export const EXPERIMENT_TAB: TabId = "::experiment";
/** Proposed changes to this place's files, waiting for review. */
export const REVIEW_TAB: TabId = "::review";
/** Tabs that aren't files. */
export const isBuiltInTab = (tab: TabId) => tab === TASKS_TAB || tab === EXPERIMENT_TAB || tab === REVIEW_TAB;

export function fileName(path: string) {
  return path.split("/").pop() ?? path;
}

export function isTextFile(file: Pick<WorkspaceFile, "mime" | "path">) {
  // UI image previews retain data/HTTP URLs; SVG text remains readable by the agent.
  return isTextContent(file.path, file.mime, false);
}

export function isMarkdown(file: Pick<WorkspaceFile, "mime" | "path">) {
  return file.mime === "text/markdown" || ["md", "markdown"].includes(extension(file.path));
}
