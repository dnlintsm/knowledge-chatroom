import type { WorkspaceFile } from "./types";
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
  put: (file: WorkspaceFile, at: PlaceId) => Promise<{ sha256: string }>;
  onError: (error: string | null) => void;
  delay?: number;
  clock?: Clock;
}

/** Owns per-place write order, debounce, pending/failed protection and hashes. */
export class SaveScheduler {
  private readonly pending = new Map<string, { path: string; at: PlaceId; timer: Timer }>();
  private readonly inflight = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly hashes = new Map<string, string>();
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
    const failed = this.failed.values().next().value;
    this.options.onError(failed ? `Couldn't save ${failed.slice(failed.indexOf("\n") + 1)}` : null);
  };
  busy = (path: string, at = this.options.getPlace()) => {
    const key = this.key(path, at);
    return this.pending.has(key) || (this.inflight.get(key) ?? 0) > 0 || this.failed.has(key);
  };
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
    if (this.options.getMode() === "local" || at !== this.options.getPlace()) return;
    const file = this.options.getFile(path);
    if (!file) return;
    // Capture before the next navigation changes the currently loaded files.
    this.beginWrite(path, at);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const sent = previous.then(() => this.options.put(file, at));
    const tail = sent.then(() => {}, () => {});
    this.chains.set(key, tail);
    try {
      const info = await sent;
      this.remember(path, info.sha256, at);
      const recovered = this.failed.delete(key);
      if (recovered || !this.failed.size) this.reportFailures();
    } catch (error) {
      console.error("[workspace] save failed:", error);
      this.failed.add(key);
      this.options.onError(`Couldn't save ${path}`);
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
  settle = async (at: PlaceId) => {
    this.flush();
    const prefix = `${at ?? ""}\n`;
    const mine = (keys: Iterable<string>) => [...keys].filter((key) => key.startsWith(prefix));
    const onWire = () => mine(this.inflight.keys()).length > 0;
    for (let i = 0; i < 200 && onWire(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
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
    if (this.failed.delete(key)) this.reportFailures();
  };
  forget = (path: string, at = this.options.getPlace()) => this.hashes.delete(this.key(path, at));
}
