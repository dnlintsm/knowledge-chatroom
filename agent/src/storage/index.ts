import { S3BlobStore } from "./blobs";
import { storageConfigFromEnv, type StorageConfig } from "./config";
import { connect, migrate, type Sql } from "./db";
import { FileService } from "./files";

export { FileService } from "./files";
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

/** The running storage, or null before it is ready / when it is off or failed. */
export function currentFiles(): FileService | null {
  return current?.files ?? null;
}

/**
 * Starts storage in the background for the server process. Until it is ready
 * (or if it fails) the file API answers 503 and file tools return an error,
 * while chat keeps working.
 */
export function startStorage(config: StorageConfig | null = storageConfigFromEnv()) {
  if (!config) return;
  initStorage(config)
    .then((ready) => {
      current = ready;
      console.log("[storage] ready");
    })
    .catch((err) => {
      console.error("[storage] failed to start; /files is unavailable:", err);
    });
}
