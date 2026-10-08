import { S3BlobStore } from "./blobs";
import { storageConfigFromEnv, type StorageConfig } from "./config";
import { connect, migrate, type Sql } from "./db";
import { FileService } from "./files";

export { FileExistsError, FileService, ReadOnlyFileError } from "./files";
export type { FileInfo, FileVersion } from "./files";

export interface Storage {
  config: StorageConfig;
  sql: Sql;
  files: FileService;
  close(): Promise<void>;
}

/**
 * Connects to Postgres and the object store, applies migrations and makes sure
 * the bucket exists. Returns null when storage isn't configured.
 */
export async function initStorage(
  config: StorageConfig | null = storageConfigFromEnv(),
): Promise<Storage | null> {
  if (!config) return null;

  const sql = connect(config.databaseUrl);
  try {
    const applied = await migrate(sql);
    if (applied.length) console.log(`[storage] applied migrations: ${applied.join(", ")}`);

    const blobs = new S3BlobStore(config.s3);
    await blobs.ensureBucket();

    const files = await FileService.forWorkspace(sql, blobs);
    return { config, sql, files, close: () => sql.end() };
  } catch (err) {
    await sql.end();
    throw err;
  }
}

let current: Storage | null = null;

/** off: no DATABASE_URL. starting: connecting/migrating. failed: gave up. */
export type StorageState = "off" | "starting" | "ready" | "failed";
let state: StorageState = "off";

export function storageState(): StorageState {
  return state;
}

/** The running storage, or null before it is ready / when it is off or failed. */
export function currentFiles(): FileService | null {
  return current?.files ?? null;
}

/**
 * Starts storage in the background for the server process. Until it is ready
 * the file API answers 503 (500 if it failed) and file tools return an error,
 * while chat keeps working.
 */
export function startStorage(config: StorageConfig | null = storageConfigFromEnv()) {
  if (!config) return;
  state = "starting";
  initStorage(config)
    .then((ready) => {
      current = ready;
      state = "ready";
      console.log("[storage] ready");
    })
    .catch((err) => {
      state = "failed";
      console.error("[storage] failed to start; /files is unavailable:", err);
    });
}
