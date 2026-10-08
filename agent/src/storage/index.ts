import { S3BlobStore } from "./blobs";
import { storageConfigFromEnv, type StorageConfig } from "./config";
import { connect, migrate, type Sql } from "./db";
import { EventHub } from "./events";
import { FileService } from "./files";
import { NodeService } from "./nodes";

export { FileService } from "./files";
export type { FileInfo, FileVersion } from "./files";
export { NodeService } from "./nodes";
export type { KnowledgeNode, NodeType } from "./nodes";

export interface Storage {
  config: StorageConfig;
  sql: Sql;
  /** Files at the workspace root; .inNode(id) for a knowledge node's files. */
  files: FileService;
  nodes: NodeService;
  events: EventHub;
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

    // Single workspace until login and memberships arrive (issue #4, step 4).
    const [ws] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    if (!ws) throw new Error("Workspace default not found");
    const events = new EventHub(sql, ws.id);
    return {
      config,
      sql,
      files: new FileService(sql, blobs, events, ws.id),
      nodes: new NodeService(sql, events, ws.id),
      events,
      close: () => sql.end(),
    };
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
export function currentStorage(): Storage | null {
  return current;
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
