import { FileChangedError, type WorkspaceFile } from "./types";
import type { PlaceId } from "./server-files";

export type StorageMode = "loading" | "server" | "local";
type Timer = ReturnType<typeof setTimeout>;
interface Clock {
  setTimeout: (run: () => void, delay: number) => Timer;
  clearTimeout: (timer: Timer) => void;
}
interface Options {
  getMode: () => StorageMode;
  getPlace: () => PlaceId;
  getFile: (path: string) => WorkspaceFile | undefined;
  /**
   * Sends the file. `replaces` is the version this browser last saw of it, when
   * it knows one: the server then refuses (FileChangedError) to write over a
   * newer one someone else saved.
   */
  put: (file: WorkspaceFile, at: PlaceId, replaces?: string) => Promise<{ sha256: string }>;
  onError: (error: string | null) => void;
  /** The files whose save was refused because someone else changed them, whenever that set changes. */
  onConflict?: (conflicts: SaveConflict[]) => void;
  delay?: number;
  clock?: Clock;
}

/** A file edited here whose save the server refused: it holds a version this browser hadn't seen. */
export interface SaveConflict {
  path: string;
  at: PlaceId;
  /** The server's version now; null when the file was deleted there. */
  sha256: string | null;
}

/**
 * Owns per-place write order, debounce, pending/failed protection and hashes.
 *
 * A save says which version it replaces (the hash last seen), so two people
 * editing one file can't silently overwrite each other (issue #293). A refused
 * save leaves the file in conflict: its edits stay here, nothing more is sent
 * for it, and incoming changes don't replace it, until the user keeps theirs
 * (keepMine) or takes the server's (dropConflict, then load it).
 */
export class SaveScheduler {
  private readonly pending = new Map<string, { path: string; at: PlaceId; timer: Timer }>();
  private readonly inflight = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly hashes = new Map<string, string>();
  private readonly conflicts = new Map<string, SaveConflict>();
  private readonly clock: Clock;
  private readonly delay: number;

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? {
      setTimeout: (run, delay) => setTimeout(run, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    this.delay = options.delay ?? 600;
  }

  private key = (path: string, at: PlaceId) => `${at ?? ""}\n${path}`;
  private reportFailures = () => {
    const conflict = this.conflicts.values().next().value;
    const failed = this.failed.values().next().value;
    this.options.onError(
      conflict
        ? `${conflict.path} was changed by someone else while you edited it; choose which version to keep`
        : failed ? `Couldn't save ${failed.slice(failed.indexOf("\n") + 1)}` : null,
    );
  };
  private reportConflicts = () => {
    this.options.onConflict?.([...this.conflicts.values()]);
    this.reportFailures();
  };
  busy = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    return this.pending.has(key) || (this.inflight.get(key) ?? 0) > 0 || this.failed.has(key) || this.conflicts.has(key);
  };
  conflict = (path: string, at = this.options.getPlace()) => this.conflicts.get(this.key(path, at));
  hash = (path: string, at = this.options.getPlace()) => this.hashes.get(this.key(path, at));
  remember = (path: string, hash: string, at = this.options.getPlace()) => {
    this.hashes.set(this.key(path, at), hash);
  };
  beginWrite = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
  };
  endWrite = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    const count = (this.inflight.get(key) ?? 1) - 1;
    if (count > 0) this.inflight.set(key, count);
    else this.inflight.delete(key);
  };

  private scheduleAt = (path: string, at: PlaceId) => {
    const key = this.key(path, at);
    const previous = this.pending.get(key);
    if (previous) this.clock.clearTimeout(previous.timer);
    const timer = this.clock.setTimeout(() => void this.save(path, at), this.delay);
    this.pending.set(key, { path, at, timer });
  };
  schedule = (path: string) => this.scheduleAt(path, this.options.getPlace());

  private save = async (path: string, at: PlaceId): Promise<void> => {
    const key = this.key(path, at);
    if (this.options.getMode() === "loading") {
      this.scheduleAt(path, at);
      return;
    }
    this.pending.delete(key);
    if (this.options.getMode() === "local" || at !== this.options.getPlace() || this.conflicts.has(key)) return;
    const file = this.options.getFile(path);
    if (!file) return;
    // Capture before the next navigation changes the currently loaded files.
    this.beginWrite(path, at);
    const previous = this.chains.get(key) ?? Promise.resolve();
    // The version to replace is read when it is this save's turn: the save before it sets it.
    const sent = previous.then(async () => {
      if (this.conflicts.has(key)) return null;
      const info = await this.options.put(file, at, this.hashes.get(key));
      this.remember(path, info.sha256, at);
      return info;
    });
    const tail = sent.then(() => {}, () => {});
    this.chains.set(key, tail);
    try {
      // null: in conflict already, so nothing was sent.
      if (!(await sent)) return;
      const recovered = this.failed.delete(key);
      if (recovered || !this.failed.size) this.reportFailures();
    } catch (error) {
      if (error instanceof FileChangedError) {
        this.failed.delete(key);
        this.conflicts.set(key, { path, at, sha256: error.sha256 });
        this.reportConflicts();
        return;
      }
      console.error("[workspace] save failed:", error);
      this.failed.add(key);
      if (this.conflicts.size) this.reportFailures();
      else this.options.onError(`Couldn't save ${path}`);
    } finally {
      this.endWrite(path, at);
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  };

  /** Capture every pending edit before a move/pagehide changes the loaded files. */
  flush = () => {
    for (const { path, at, timer } of [...this.pending.values()]) {
      this.clock.clearTimeout(timer);
      void this.save(path, at);
    }
  };

  /** Fork/archive/promote must not use the server's copy before edits save. */
  settle = (at: PlaceId) => {
    const prefix = `${at ?? ""}\n`;
    return this.settleWhere((key) => key.startsWith(prefix));
  };

  /**
   * Leaving the workspace with "Save" (docs/workspaces.md, Screens): every
   * edit, in every place, with those here that failed tried once more.
   */
  settleAll = () => {
    const here = this.options.getPlace();
    for (const key of this.failed) {
      const split = key.indexOf("\n");
      const at = key.slice(0, split) || null;
      if (at === here) this.scheduleAt(key.slice(split + 1), at);
    }
    return this.settleWhere(() => true);
  };

  /** Whether any edit hasn't saved yet: waiting, being sent, failed, or in conflict. */
  unsaved = () => this.pending.size > 0 || this.inflight.size > 0 || this.failed.size > 0 || this.conflicts.size > 0;

  /**
   * Resolves a conflict in favour of this browser's copy: saves it over the
   * version the server reported. If that one was replaced again meanwhile, the
   * save is refused again and the conflict is back with the newer version.
   */
  keepMine = async (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    const conflict = this.conflicts.get(key);
    if (!conflict) return;
    this.conflicts.delete(key);
    if (conflict.sha256) this.hashes.set(key, conflict.sha256);
    else this.hashes.delete(key);
    this.reportConflicts();
    const waiting = this.pending.get(key);
    if (waiting) this.clock.clearTimeout(waiting.timer);
    await this.save(path, at);
  };

  /**
   * Ends a conflict without saving this browser's copy (the caller loads the
   * server's): edits waiting to be sent for it are dropped.
   */
  dropConflict = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    if (!this.conflicts.delete(key)) return;
    const waiting = this.pending.get(key);
    if (waiting) this.clock.clearTimeout(waiting.timer);
    this.pending.delete(key);
    this.reportConflicts();
  };

  /**
   * Leaving a place drops its files from this browser's memory, and with them
   * the edits a conflict there was holding: nothing is left to choose between.
   */
  leave = (at: PlaceId) => {
    const prefix = `${at ?? ""}\n`;
    const gone = [...this.conflicts.keys()].filter((key) => key.startsWith(prefix));
    for (const key of gone) {
      this.conflicts.delete(key);
      const waiting = this.pending.get(key);
      if (waiting) this.clock.clearTimeout(waiting.timer);
      this.pending.delete(key);
    }
    if (gone.length) this.reportConflicts();
  };

  /** The server's copy of a file in conflict changed again (a change event): keepMine replaces that one. */
  theirs = (path: string, sha256: string | null, at = this.options.getPlace()) => {
    const conflict = this.conflicts.get(this.key(path, at));
    if (conflict) conflict.sha256 = sha256;
  };

  /**
   * Leaving the workspace with "Discard": edits still waiting are never sent,
   * and failed ones aren't retried. One already being sent can't be called back.
   */
  discard = () => {
    for (const { timer } of this.pending.values()) this.clock.clearTimeout(timer);
    this.pending.clear();
    this.failed.clear();
    this.conflicts.clear();
    this.reportConflicts();
  };

  private settleWhere = async (matches: (key: string) => boolean) => {
    this.flush();
    const mine = (keys: Iterable<string>) => [...keys].filter(matches);
    const onWire = () => mine(this.inflight.keys()).length > 0;
    for (let i = 0; i < 200 && onWire(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    const conflict = mine(this.conflicts.keys())[0];
    if (conflict) {
      throw new Error(
        `${this.conflicts.get(conflict)!.path} was changed by someone else while you edited it; choose which version to keep first`,
      );
    }
    if (onWire() || mine(this.pending.keys()).length || mine(this.failed).length) {
      throw new Error("Your latest edits here haven't saved yet; try again once they are saved");
    }
  };

  /** A user delete cancels its debounce and invalidates the last observed hash. */
  cancel = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    const pending = this.pending.get(key);
    if (pending) this.clock.clearTimeout(pending.timer);
    this.pending.delete(key);
    this.hashes.delete(key);
    const failed = this.failed.delete(key);
    if (this.conflicts.delete(key)) this.reportConflicts();
    else if (failed) this.reportFailures();
  };
  forget = (path: string, at = this.options.getPlace()) => this.hashes.delete(this.key(path, at));
}
