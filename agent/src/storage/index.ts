import { S3BlobStore, type BlobStore } from "./blobs";
import { storageConfigFromEnv, type StorageConfig } from "./config";
import { AccessService, type Principal } from "./access";
import { connect, migrate, prepareRowSecurity, type Sql } from "./db";
import { EventHub } from "./events";
import { ExperimentService } from "./experiments";
import { FileService } from "./files";
import { NodeService } from "./nodes";
import { Session } from "./session";

export { FileService } from "./files";
export type { FileInfo, FileVersion } from "./files";
export { NodeService } from "./nodes";
export { ExperimentService } from "./experiments";
export type { Experiment, ExperimentStatus } from "./experiments";
export type { KnowledgeNode, NodeType } from "./nodes";
export type { Principal, Role } from "./access";
export { Session } from "./session";

export interface Storage {
  config: StorageConfig;
  sql: Sql;
  /** Files at the workspace root; .inNode(id) / .inExperiment(id) for others. */
  files: FileService;
  nodes: NodeService;
  experiments: ExperimentService;
  access: AccessService;
  events: EventHub;
  blobs: BlobStore;
  /** Whether Postgres also enforces access for users' queries (004_row_security.sql). */
  rowSecurity: boolean;
  /** What `principal` may do; every API call and tool goes through one. */
  session(principal: Principal): Session;
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
    const rowSecurity = await prepareRowSecurity(sql);
    if (!rowSecurity) {
      console.warn(
        "[storage] row-level security is off: this database user can't use role knowledge_user " +
          "(see 004_row_security.sql). Access is still checked by the app.",
      );
    }

    const blobs = new S3BlobStore(config.s3);
    await blobs.ensureBucket();

    // Single workspace until login and memberships arrive (issue #4, step 4).
    const [ws] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    if (!ws) throw new Error("Workspace default not found");
    const events = new EventHub(sql, ws.id);
    const files = new FileService(sql, blobs, events, ws.id);
    const nodes = new NodeService(sql, events, ws.id);
    const experiments = new ExperimentService(sql, events, ws.id);
    const access = new AccessService(sql, ws.id);
    return {
      config,
      sql,
      files,
      nodes,
      experiments,
      access,
      events,
      blobs,
      rowSecurity,
      session: (principal) => new Session({ files, nodes, experiments, access, sql, rowSecurity }, principal),
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
