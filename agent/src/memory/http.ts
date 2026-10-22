import type { IncomingMessage, ServerResponse } from "node:http";

import { identify } from "../storage/identity";
import type { Storage, StorageState } from "../storage";
import {
  INDEX_CHARS,
  MAX_BODY,
  MAX_DESCRIPTION,
  MAX_NOTES,
  MEMORY_TYPES,
  MemoryConflictError,
  MemoryError,
  MemoryNotFoundError,
} from "../storage/memory";
import { memoryEnabled } from "./run";

/**
 * Memory API (issue #93), mounted on the agent server. Needs MEMORY=on and
 * server storage; otherwise every route answers 404 and the app hides memory.
 * Everything is the signed-in user's own: nobody reads another's notes.
 *
 *   GET /memory?thread=           {mode, incognito, notes, inbox, types, limits}:
 *                                 your notes (archived ones last, archived:
 *                                 true), the changes waiting for your review,
 *                                 memory on/ask/off for you, and whether
 *                                 `thread` is an incognito chat
 *   PUT /memory/settings          {mode?: on | ask | off, thread?, incognito?}
 *   GET /memory/activity          Claude's recent changes, newest first
 *   POST /memory/inbox/<id>/accept    makes a proposed change (409 when the
 *                                 note changed since)
 *   POST /memory/inbox/<id>/reject    drops it
 *   GET /memory/export            every note as memory/<name>.md, zipped
 *   GET /memory/notes/<name>      {note, versions}
 *   PUT /memory/notes/<name>      {description, type, body} creates or replaces
 *                                 it (as yours; ?create=1 refuses a name in use)
 *   DELETE /memory/notes/<name>   deletes it for good, with its versions
 *   POST /memory/notes/<name>/restore   {version} makes that version current
 *   POST /memory/notes/<name>/archive   {archived} archives or brings it back
 *   POST /memory/events/<id>/undo       undoes one of Claude's changes
 */
export function createMemoryHandler(storage: () => Storage | null, state: () => StorageState) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function json(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > 64 * 1024) return undefined;
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, s: Storage, userId: string, parts: string[]) {
    const memory = s.memory;
    const [section, name, action] = parts;
    if (req.method === "GET" && !section) {
      const thread = url.searchParams.get("thread");
      const [settings, notes, inbox] = await Promise.all([
        memory.settings(userId, thread),
        memory.list(userId),
        memory.inbox(userId),
      ]);
      return send(res, 200, {
        ...settings,
        notes,
        inbox,
        types: MEMORY_TYPES,
        limits: { notes: MAX_NOTES, body: MAX_BODY, description: MAX_DESCRIPTION, index: INDEX_CHARS },
      });
    }
    if (req.method === "PUT" && section === "settings" && !name) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      if (input.mode !== undefined) await memory.setMode(userId, input.mode);
      if (input.incognito !== undefined) await memory.setIncognito(userId, input.thread, input.incognito === true);
      const thread = typeof input.thread === "string" ? input.thread : null;
      return send(res, 200, await memory.settings(userId, thread));
    }
    if (req.method === "GET" && section === "activity" && !name) {
      return send(res, 200, { activity: await memory.activity(userId) });
    }
    if (req.method === "POST" && section === "inbox" && name && (action === "accept" || action === "reject")) {
      if (action === "reject") {
        await memory.reject(userId, name);
        return send(res, 200, { id: name, status: "rejected" });
      }
      const { note } = await memory.accept(userId, name);
      return send(res, 200, { id: name, status: "accepted", note });
    }
    if (req.method === "GET" && section === "export" && !name) {
      const zip = await memory.exportZip(userId);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="memory.zip"',
        "Cache-Control": "no-store",
      });
      return res.end(zip);
    }
    if (section === "notes" && name && !action) {
      if (req.method === "GET") {
        const note = await memory.get(userId, name);
        if (!note) throw new MemoryNotFoundError(name);
        return send(res, 200, { note, versions: await memory.versions(userId, name) });
      }
      if (req.method === "PUT") {
        const input = await json(req);
        if (!input) return send(res, 400, { error: "Invalid JSON body" });
        const create = ["1", "true"].includes(url.searchParams.get("create") ?? "");
        const { note } = await memory.save(userId, name, input as never, "user", { create });
        return send(res, 200, { note });
      }
      if (req.method === "DELETE") {
        if (!(await memory.remove(userId, name))) throw new MemoryNotFoundError(name);
        return send(res, 200, { name, deleted: true });
      }
    }
    if (req.method === "POST" && section === "notes" && name && (action === "restore" || action === "archive")) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      if (action === "archive") {
        return send(res, 200, { note: (await memory.archive(userId, name, input.archived !== false)).note });
      }
      const version = Number(input.version);
      if (!Number.isInteger(version) || version < 1) return send(res, 400, { error: "Say which version" });
      return send(res, 200, { note: await memory.restore(userId, name, version) });
    }
    if (req.method === "POST" && section === "events" && name && action === "undo") {
      return send(res, 200, await memory.undo(userId, name));
    }
    return send(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "Not found" : "Method not allowed" });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!memoryEnabled()) return send(res, 404, { error: "Memory is off on this server (MEMORY=on turns it on)" });
    const s = storage();
    if (!s) {
      if (state() === "off") return send(res, 404, { error: "Memory needs server storage (DATABASE_URL)" });
      return send(res, state() === "failed" ? 500 : 503, { error: "Storage is not available" });
    }
    try {
      const principal = await identify(req, s);
      if (!principal) return send(res, 401, { error: "Sign in first" });
      let parts: string[];
      try {
        parts = url.pathname.slice("/memory".length).split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        return send(res, 400, { error: "Invalid memory name" });
      }
      if (parts.length > 3) return send(res, 404, { error: "Not found" });
      return await route(req, res, url, s, principal.userId, parts);
    } catch (err) {
      if (err instanceof MemoryError) return send(res, 400, { error: err.message });
      if (err instanceof MemoryNotFoundError) return send(res, 404, { error: err.message });
      if (err instanceof MemoryConflictError) return send(res, 409, { error: err.message });
      console.error("[memory] request failed:", err);
      return send(res, 500, { error: "Memory request failed" });
    }
  };
}
