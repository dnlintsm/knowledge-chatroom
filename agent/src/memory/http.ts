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
import { importMemory } from "./import";
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
 *
 * Shared memory (step 3): notes for the workspace, a knowledge node or a
 * group, which the people there read and its editors change.
 *
 *   GET /memory also has {shared, sharedProposals, targets}: the shared notes
 *                                 you read (with your and everyone's mode),
 *                                 open proposals you decide or made, and the
 *                                 places you can share to (?node= adds that
 *                                 node)
 *   POST /memory/shared           {scope, nodeId?, groupId?, name, description,
 *                                 type, body}: shares a copy there; {note} where
 *                                 you edit, else {proposal} for its editors
 *   GET /memory/shared/<id>       {note, versions}
 *   PUT /memory/shared/<id>       {description, type, body, version?} (editors;
 *                                 409 when it is past `version`)
 *   DELETE /memory/shared/<id>    deletes it for good (editors)
 *   PUT /memory/shared/<id>/mode  {mode: auto | manual | off | null, everyone?}
 *   POST /memory/shared/proposals/<id>/accept | reject | withdraw
 *
 * Import and memory packs (step 4):
 *
 *   POST /memory/import           {text, label?} (pasted memory or a .md file)
 *                                 or a raw application/zip body (an export):
 *                                 {proposed, skipped, how}, all in the inbox
 *   GET /memory also has {installs}: packs installed in places you read
 *   GET /memory/packs?q=          {packs, isAdmin}: the hub's memory packs
 *   GET /memory/packs/<name>?version=   {pack}: versions, and that one's notes
 *   POST /memory/packs            {scope, nodeId?, groupId?, name, description}
 *                                 publishes the place's own notes (editors)
 *   POST /memory/packs/<name>/install   {scope, nodeId?, groupId?, version?}
 *                                 installs it there, or moves the install to
 *                                 that version (editors)
 *   POST /memory/packs/<name>/verify    {version, verified} (hub admins)
 *   POST /memory/packs/<name>/yank      {version, yanked, reason?} (publisher
 *                                 or hub admins)
 *   DELETE /memory/installs/<id>  uninstalls it, with its notes (editors)
 *   POST /memory/installs/<id>/fork     makes its notes the place's own
 */
/** An import's body at most: a pasted memory, a file or a .zip export. */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export function createMemoryHandler(storage: () => Storage | null, state: () => StorageState) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function body(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > limit) return undefined;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function json(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown> | undefined> {
    const bytes = await body(req, limit);
    if (!bytes) return undefined;
    try {
      const parsed = JSON.parse(bytes.toString("utf8") || "{}");
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
      const node = url.searchParams.get("node");
      const [settings, notes, inbox, shared, sharedProposals, targets, installs] = await Promise.all([
        memory.settings(userId, thread),
        memory.list(userId),
        memory.inbox(userId),
        s.sharedMemory.list(userId),
        s.sharedMemory.proposals(userId),
        s.sharedMemory.targets(userId, node),
        s.memoryPacks.installs(userId),
      ]);
      return send(res, 200, {
        ...settings,
        notes,
        inbox,
        shared,
        sharedProposals,
        targets,
        installs,
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
    if (section === "shared") return sharedRoute(req, res, s, userId, parts.slice(1));
    if (req.method === "POST" && section === "import" && !name) {
      if ((req.headers["content-type"] ?? "").startsWith("application/zip")) {
        const zip = await body(req, MAX_IMPORT_BYTES);
        if (!zip) return send(res, 413, { error: "That file is too big to import (2 MB at most)" });
        return send(res, 200, await importMemory(memory, userId, { zip: new Uint8Array(zip) }));
      }
      const input = await json(req, MAX_IMPORT_BYTES);
      if (!input) return send(res, 400, { error: "Invalid JSON body (2 MB at most)" });
      const label = typeof input.label === "string" ? input.label.slice(0, 100) : undefined;
      return send(res, 200, await importMemory(memory, userId, { text: typeof input.text === "string" ? input.text : "", label }));
    }
    if (section === "packs") return packRoute(req, res, url, s, userId, parts.slice(1));
    if (section === "installs" && name) {
      if (req.method === "DELETE" && !action) {
        await s.memoryPacks.uninstall(userId, name);
        return send(res, 200, { id: name, deleted: true });
      }
      if (req.method === "POST" && action === "fork") return send(res, 200, { id: name, ...(await s.memoryPacks.fork(userId, name)) });
    }
    if (req.method === "POST" && section === "events" && name && action === "undo") {
      return send(res, 200, await memory.undo(userId, name));
    }
    return send(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "Not found" : "Method not allowed" });
  }

  async function sharedRoute(req: IncomingMessage, res: ServerResponse, s: Storage, userId: string, parts: string[]) {
    const shared = s.sharedMemory;
    const [id, action, decision] = parts;
    if (req.method === "POST" && !id) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      return send(res, 200, await shared.share(userId, input, input.name, input as never));
    }
    if (req.method === "POST" && id === "proposals" && action && !parts[3] &&
      (decision === "accept" || decision === "reject" || decision === "withdraw")) {
      return send(res, 200, { id: action, status: decision, ...(await shared.decide(userId, action, decision)) });
    }
    if (id && id !== "proposals" && !action) {
      if (req.method === "GET") {
        const [note, versions] = await Promise.all([shared.get(userId, id), shared.versions(userId, id)]);
        return send(res, 200, { note, versions });
      }
      if (req.method === "PUT") {
        const input = await json(req);
        if (!input) return send(res, 400, { error: "Invalid JSON body" });
        const version = input.version === undefined ? undefined : Number(input.version);
        if (version !== undefined && !Number.isInteger(version)) return send(res, 400, { error: "version is a number" });
        return send(res, 200, { note: await shared.update(userId, id, input as never, version) });
      }
      if (req.method === "DELETE") {
        await shared.remove(userId, id);
        return send(res, 200, { id, deleted: true });
      }
    }
    if (req.method === "PUT" && id && action === "mode" && !decision) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      return send(res, 200, { note: await shared.setMode(userId, id, input.mode ?? null, input.everyone === true) });
    }
    return send(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "Not found" : "Method not allowed" });
  }

  async function packRoute(req: IncomingMessage, res: ServerResponse, url: URL, s: Storage, userId: string, parts: string[]) {
    const hub = s.memoryPacks;
    const [name, action] = parts;
    if (req.method === "GET" && !name) return send(res, 200, await hub.list(userId, url.searchParams.get("q") ?? ""));
    if (req.method === "GET" && name && !action) {
      const v = url.searchParams.get("version");
      const version = v ? Number(v) : undefined;
      if (version !== undefined && !Number.isInteger(version)) return send(res, 400, { error: "version is a number" });
      return send(res, 200, { pack: await hub.detail(userId, name, version) });
    }
    if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
    const input = await json(req);
    if (!input) return send(res, 400, { error: "Invalid JSON body" });
    if (!name) return send(res, 200, await hub.publish(userId, input, input.name, input.description));
    const version = input.version === undefined ? undefined : Number(input.version);
    if (version !== undefined && !Number.isInteger(version)) return send(res, 400, { error: "version is a number" });
    if (action === "install") return send(res, 200, { install: await hub.install(userId, input, name, version) });
    if (version === undefined) return send(res, 400, { error: "Say which version" });
    if (action === "verify") {
      await hub.verify(userId, name, version, input.verified !== false);
      return send(res, 200, { pack: await hub.detail(userId, name, version) });
    }
    if (action === "yank") {
      await hub.yank(userId, name, version, input.yanked !== false, input.reason);
      return send(res, 200, { pack: await hub.detail(userId, name, version) });
    }
    return send(res, 404, { error: "Not found" });
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
      if (parts.length > (parts[0] === "shared" ? 4 : 3)) return send(res, 404, { error: "Not found" });
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
