import type { Sql, Tx } from "./db";

export type AuthorType = "user" | "agent";

/** A committed file change. */
export interface FileEvent {
  op: "write" | "delete";
  /** The knowledge node the file belongs to; null at the workspace root. */
  node: string | null;
  /** The experiment it belongs to instead (node is then null). */
  experiment?: string | null;
  path: string;
  /** Present for writes. */
  sha256?: string;
  author?: AuthorType;
}

/** A committed change to the knowledge tree; clients refetch /nodes. */
export interface NodeEvent {
  op: "node";
  change: "create" | "rename" | "delete";
  id: string;
}

/** A committed change to an experiment on `node`; clients refetch /experiments. */
export interface ExperimentEvent {
  op: "experiment";
  change: "create" | "update" | "status" | "delete";
  id: string;
  node: string;
}

export type WorkspaceEvent = FileEvent | NodeEvent | ExperimentEvent;

const CHANNEL = "workspace_files";

/**
 * Change events for one workspace, delivered to every process through Postgres
 * LISTEN/NOTIFY. Writers call notify() inside their transaction, so listeners
 * never hear about a change that rolled back.
 */
export class EventHub {
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private listening: Promise<unknown> | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  /** Returns an unsubscribe function. */
  async subscribe(listener: (event: WorkspaceEvent) => void): Promise<() => void> {
    this.listening ??= this.sql.listen(CHANNEL, (payload) => {
      const { workspaceId, ...event } = JSON.parse(payload) as WorkspaceEvent & {
        workspaceId: string;
      };
      if (workspaceId !== this.workspaceId) return;
      for (const l of this.listeners) l(event as WorkspaceEvent);
    }).catch((err) => {
      this.listening = null; // Let the next subscriber retry.
      throw err;
    });
    await this.listening;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(tx: Tx, event: WorkspaceEvent) {
    return tx`SELECT pg_notify(${CHANNEL}, ${JSON.stringify({
      ...event,
      workspaceId: this.workspaceId,
    })})`;
  }
}
