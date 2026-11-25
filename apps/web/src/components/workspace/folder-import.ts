/**
 * Import a folder as an Experiment (docs/experiment-runs.md): the server
 * copies (or moves) the folder's files into a new Experiment without the
 * browser sending them again. `?preview` answers what it would do.
 */

import type { components } from "@knowledge-chatroom/contracts/generated/storage-api";
import { apiFetch, type Experiment } from "./server-files";

export type FolderImport = Omit<components["schemas"]["FolderImport"], "experiment"> & { experiment?: Experiment };

export interface FolderImportRequest {
  /** The folder's node; null at the workspace root. */
  node: string | null;
  /** The folder's path in that place, without a trailing slash. */
  folder: string;
  destination?: string | null;
  title?: string;
  hypothesis?: string;
  status?: "draft" | "shared";
  move?: boolean;
  pointer?: boolean;
}

/** What importing would do (`preview`), or the import itself; throws the server's reason. */
export async function importFolder(request: FolderImportRequest, preview: boolean): Promise<FolderImport> {
  const res = await apiFetch(`/api/experiments/import${preview ? "?preview=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as FolderImport & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Import: ${res.status}`);
  return data;
}
