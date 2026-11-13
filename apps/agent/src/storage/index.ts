import { S3BlobStore, type BlobStore } from "./blobs";
import { storageConfigFromEnv, type StorageConfig } from "./config";
import { AccessService, type Principal } from "./access";
import { connect, migrate, prepareRowSecurity, waitForMigrations, type Sql } from "./db";
import { ChatService } from "./chats";
import { EventHub } from "./events";
import { ExperimentService } from "./experiments";
import { FileService } from "./files";
import { MemoryService } from "./memory";
import { SharedMemoryService } from "./shared-memory";
import { MemoryPackHub } from "./memory-packs";
import { NodeService } from "./nodes";
import { ProposalService } from "./proposals";
import { SearchService } from "./search";
import { ApiEmbedder, LocalEmbedder, SemanticIndex, type Embedder } from "./semantic";
import { Session } from "./session";

export { ChatService } from "./chats";
export type { ChatRun, ChatSummary } from "./chats";
export { FileExistsError, FileService } from "./files";
export { MemoryService } from "./memory";
export { SharedMemoryService } from "./shared-memory";
export { MemoryPackHub } from "./memory-packs";
export type { MemoryEvent, MemoryNote, MemorySummary } from "./memory";
export type { FileInfo, FileVersion } from "./files";
export { NodeService } from "./nodes";
export { ExperimentService } from "./experiments";
export type { Experiment, ExperimentStatus } from "./experiments";
export { ProposalService } from "./proposals";
export type { Proposal, ProposalStatus, Promotable } from "./proposals";
export type { KnowledgeNode, NodeType } from "./nodes";
export type { Principal, Role } from "./access";
export { Session } from "./session";
export { SearchService } from "./search";
export type { SearchHit, SearchOptions } from "./search";
export { ApiEmbedder, LocalEmbedder, SemanticIndex, type Embedder } from "./semantic";

export interface Storage {
  config: StorageConfig;
  sql: Sql;
  /** The workspace these services act in: the default one, or the one inWorkspace() named. */
  workspaceId: string;
  /** The default workspace, which requests that name none use (docs/workspaces.md). */
  defaultWorkspaceId: string;
  /** Files at the workspace root; .inNode(id) / .inExperiment(id) for others. */
  files: FileService;
  nodes: NodeService;
  experiments: ExperimentService;
  access: AccessService;
  search: SearchService;
  /** Proposed versions of files, waiting for review. */
  proposals: ProposalService;
  /** Each user's chat history. */
  chats: ChatService;
  /** Each user's personalized memory (issue #93). */
  memory: MemoryService;
  /** Memory for a workspace, node or group (issue #93, step 3). */
  sharedMemory: SharedMemoryService;
  /** Memory packs on the hub, and installs of them (step 4). */
  memoryPacks: MemoryPackHub;
  /** Search by meaning; null when no embedding model is set. Not ready until prepared. */
  semantic: SemanticIndex | null;
  events: EventHub;
  blobs: BlobStore;
  /** Whether Postgres also enforces access for users' queries (004_row_security.sql). */
  rowSecurity: boolean;
  /** What `principal` may do; every API call and tool goes through one. */
  session(principal: Principal): Session;
  /**
   * The same storage acting in workspace `id` (issue #226): the services bound
   * to it, sharing the connection pool, the object store and search by meaning.
   * Doesn't check that the workspace exists or who belongs to it: resolve the
   * workspace first (./workspaces.ts).
   */
  inWorkspace(id: string): Storage;
  close(): Promise<void>;
}

/**
 * Connects to Postgres and the object store, applies migrations (or, with
 * MIGRATIONS=off, waits for the Python API server to) and makes sure the bucket
 * exists. Returns null when storage isn't configured.
 */
export async function initStorage(
  config: StorageConfig | null = storageConfigFromEnv(),
  /** The model for search by meaning; the server passes the configured one (startStorage). */
  embedder: Embedder | null = null,
): Promise<Storage | null> {
  if (!config) return null;

  const sql = connect(config.databaseUrl);
  try {
    if (config.migrations === false) {
      // The Python API server in front applies them (MIGRATIONS=off).
      await waitForMigrations(sql);
    } else {
      const applied = await migrate(sql);
      if (applied.length) console.log(`[storage] applied migrations: ${applied.join(", ")}`);
    }
    const rowSecurity = await prepareRowSecurity(sql);
    if (!rowSecurity) {
      console.warn(
        "[storage] row-level security is off: this database user can't use role knowledge_user " +
          "(see 004_row_security.sql). Access is still checked by the app.",
      );
    }

    const blobs = new S3BlobStore(config.s3);
    await blobs.ensureBucket();

    // Requests that name no workspace use the default one (docs/workspaces.md).
    const [ws] = await sql<{ id: string }[]>`SELECT id FROM workspaces WHERE slug = 'default'`;
    if (!ws) throw new Error("Workspace default not found");
    const semantic = embedder && new SemanticIndex(sql, embedder);
    const access = new AccessService(sql, ws.id);
    const views = new Map<string, Storage>();
    const build = (id: string): Storage => {
      const events = new EventHub(sql, id);
      const files = new FileService(sql, blobs, events, id);
      const nodes = new NodeService(sql, events, id);
      const experiments = new ExperimentService(sql, events, id);
      const scoped = access.inWorkspace(id);
      const search = new SearchService(sql, blobs, id, semantic);
      const proposals = new ProposalService(sql, blobs, events, id);
      const view: Storage = {
        config,
        sql,
        workspaceId: id,
        defaultWorkspaceId: ws.id,
        files,
        nodes,
        experiments,
        access: scoped,
        search,
        proposals,
        chats: new ChatService(sql, id, rowSecurity),
        memory: new MemoryService(sql, id, rowSecurity),
        sharedMemory: new SharedMemoryService(sql, id, rowSecurity),
        memoryPacks: new MemoryPackHub(sql, id),
        semantic,
        events,
        blobs,
        rowSecurity,
        session: (principal) =>
          new Session({ files, nodes, experiments, access: scoped, search, proposals, sql, rowSecurity }, principal),
        inWorkspace: (other) => {
          const key = other.toLowerCase();
          let found = views.get(key);
          if (!found) views.set(key, (found = build(key)));
          return found;
        },
        close: () => {
          semantic?.stop();
          return sql.end();
        },
      };
      return view;
    };
    const storage = build(ws.id);
    views.set(ws.id, storage);
    return storage;
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
 * Indexes files stored before search existed. Blobs the store couldn't hand
 * over (a hiccup, not a missing object) are tried again later, waiting a
 * minute, then twice as long each time, six times at most.
 */
function indexExisting(search: SearchService, attempt = 0) {
  search
    .indexAll()
    .then(({ indexed, failed }) => {
      if (indexed) console.log(`[search] indexed ${indexed} existing files`);
      if (failed && attempt < 6) {
        console.warn(`[search] ${failed} files could not be read for search yet; trying again later`);
        setTimeout(() => indexExisting(search, attempt + 1), 60_000 * 2 ** attempt).unref();
      }
    })
    .catch((err) => console.error("[search] indexing existing files failed:", err));
}

/**
 * Starts storage in the background for the server process. Until it is ready
 * the file API answers 503 (500 if it failed) and file tools return an error,
 * while chat keeps working.
 */
export function startStorage(config: StorageConfig | null = storageConfigFromEnv()) {
  if (!config) return;
  state = "starting";
  const { embeddingModel: model, embeddingApi: api } = config;
  const embedder = !model
    ? null
    : api
      ? new ApiEmbedder(model, api.baseUrl, api.apiKey, api.dimensions)
      : new LocalEmbedder(model, config.embeddingCacheDir);
  initStorage(config, embedder)
    .then((ready) => {
      current = ready;
      state = "ready";
      console.log("[storage] ready");
      if (config.searchIndexer) {
        // Files written before search existed; new writes index themselves.
        if (ready) indexExisting(ready.search);
        // Loads the model and embeds passages in the background (semantic.ts).
        ready?.semantic?.start();
      } else {
        // The Python API server in front runs the indexer; queries still embed here.
        ready?.semantic?.follow();
      }
    })
    .catch((err) => {
      state = "failed";
      console.error("[storage] failed to start; /files is unavailable:", err);
    });
}
