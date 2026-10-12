import type { IncomingMessage, ServerResponse } from "node:http";

import { AccessError, ForbiddenError, ROLES, type Role } from "./access";
import type { EventHub, WorkspaceEvent } from "./events";
import { ExperimentError, type ExperimentInput } from "./experiments";
import { identify } from "./identity";
import type { Storage, StorageState } from "./index";
import { FileExistsError, ReadOnlyFileError } from "./files";
import { NodeError, NodeNotFoundError } from "./nodes";
import { InvalidPathError, isTextFile } from "./paths";
import { SearchError } from "./search";
import type { Session } from "./session";

/**
 * REST API for workspace files, the knowledge tree, experiments, search and
 * access, mounted on the agent server:
 *
 *   GET    /files                   list live files (JSON)
 *   GET    /files?watch             change stream (Server-Sent Events), one
 *                                   `data: {…}` per committed change:
 *                                   {"op":"write"|"delete","node","path",…} for
 *                                   files, {"op":"node","change","id"} for nodes
 *   GET    /files/<path>            file bytes, Content-Type = file mime (binary
 *                                   files: a 302 to a signed store link
 *                                   when S3_PUBLIC_URL is set)
 *   GET    /files/<path>?versions   version history (JSON)
 *   PUT    /files/<path>            create or replace; body = bytes,
 *                                   Content-Type = mime (optional).
 *                                   `If-None-Match: *` only creates (412 when
 *                                   the file exists); `X-Read-Only: true`
 *                                   makes a new file read-only
 *   DELETE /files/<path>            soft delete
 *
 *   Read-only files answer 403 to PUT and DELETE, and carry
 *   `X-File-Read-Only: true` on GET.
 *
 *   Every /files route takes ?node=<id> for that knowledge node's files, or
 *   ?experiment=<id> for an experiment's; without either, files at the
 *   workspace root. File events carry "experiment" for an experiment's files.
 *
 *   GET    /nodes                   {types, rootRole, nodes}: the levels, your
 *                                   role at the root, and the nodes you can see
 *                                   (each with your role; null = shown only as
 *                                   the path to something you can see)
 *   POST   /nodes                   {parentId|null, name} → the new node (its
 *                                   type is the level below the parent's)
 *   GET    /nodes/<id>              {node, lineage}: lineage is top level first
 *   PATCH  /nodes/<id>              {name} → rename
 *   DELETE /nodes/<id>              soft delete, with everything below it
 *
 *   GET    /experiments?node=<id>   {experiments}: the ones you can see, on
 *                                   that node or (without node) anywhere, each
 *                                   with your access: writer (its author) or reader
 *   POST   /experiments             {nodeId, title, hypothesis?, params?,
 *                                   results?} → a new draft, with a copy of
 *                                   the node's files
 *   GET    /experiments/<id>        one experiment
 *   PATCH  /experiments/<id>        {title?, hypothesis?, params?, results?,
 *                                   status?: draft|shared|archived}
 *   DELETE /experiments/<id>        soft delete, with its files
 *   Changes arrive on the /files change stream as
 *   {"op":"experiment","change","id","node"}.
 *
 *   GET    /search?q=<text>         {results}: files you can read whose text
 *                                   or path matches, best first, each with
 *                                   path, node, experiment, where (node names
 *                                   from the top), the matching snippet and
 *                                   match: "words", or "meaning" for a passage
 *                                   only close in meaning (semantic.ts).
 *                                   &scope=<node id> searches only that node,
 *                                   the nodes below it and their experiments;
 *                                   &near=<node id> or &experiment=<id> ranks
 *                                   files near there first; &limit= (≤ 50)
 *
 *   GET    /access                  {me, rootRole}
 *   GET    /access/users            everyone who has signed in
 *   GET    /access/groups           the org tree, with direct members
 *   POST   /access/groups           {parentId|null, name}
 *   PATCH  /access/groups/<id>      {name}
 *   DELETE /access/groups/<id>      with its sub-groups
 *   PUT    /access/groups/<id>/members/<userId>    add a member
 *   DELETE /access/groups/<id>/members/<userId>    remove one
 *   GET    /access/grants?node=<id> grants on a node (no node = workspace)
 *   POST   /access/grants           {node|null, principalType: "user"|"group",
 *                                   principalId, role: viewer|editor|owner}
 *   DELETE /access/grants/<id>
 *   GET    /access/audit?limit=     recent changes, newest first
 *
 * Reading needs viewer, changing files and nodes editor, deleting a node or
 * managing grants on it owner (of that node or one above it), and managing
 * groups owner of the workspace. Viewers may fork a node into an experiment;
 * a draft is seen by its author only, a shared or archived one by everyone
 * who can view the node, and only its author changes it. Who is asking comes from identity.ts: the
 * local user without AUTH_SECRET, the signed-in user with it.
 */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function watch(res: ServerResponse, events: EventHub, session: Session) {
  // Subscribe before answering, so a failure still gets a normal error response.
  // Events reach this connection in order, each once the previous was checked.
  let queue = Promise.resolve();
  const unsubscribe = await events.subscribe((event: WorkspaceEvent) => {
    queue = queue
      .then(async () => {
        if (await session.canSee(event)) res.write(`data: ${JSON.stringify(event)}\n\n`);
      })
      .catch((err) => console.error("[storage] watch:", err));
  });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // A comment line first so proxies flush headers, then a heartbeat so idle
  // connections are not cut.
  res.write(": watching\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const bytes = await readBody(req, 64 * 1024);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const optionalId = (value: unknown) =>
  value === null || value === undefined ? null : typeof value === "string" ? value : undefined;

async function handleNodes(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const id = decodeURIComponent(url.pathname.replace(/^\/nodes\/?/, ""));
  if (!id) {
    if (req.method === "GET") {
      json(res, 200, await session.tree());
    } else if (req.method === "POST") {
      const body = await readJson(req);
      const parentId = optionalId(body?.parentId);
      if (!body || typeof body.name !== "string" || parentId === undefined) {
        json(res, 400, { error: "Expected {parentId: string | null, name: string}" });
        return;
      }
      json(res, 201, await session.createNode(parentId, body.name));
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  switch (req.method) {
    case "GET": {
      const lineage = await session.lineage(id);
      json(res, 200, { node: lineage[lineage.length - 1], lineage });
      return;
    }
    case "PATCH": {
      const body = await readJson(req);
      if (!body || typeof body.name !== "string") {
        json(res, 400, { error: "Expected {name: string}" });
        return;
      }
      const node = await session.renameNode(id, body.name);
      if (!node) json(res, 404, { error: "Node not found" });
      else json(res, 200, node);
      return;
    }
    case "DELETE": {
      if (await session.deleteNode(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: "Node not found" });
      return;
    }
    default:
      json(res, 405, { error: "Method not allowed" });
  }
}

/** The experiment fields in a request body; undefined when one has the wrong type. */
function experimentInput(body: Record<string, unknown>): ExperimentInput | undefined {
  const input: ExperimentInput = {};
  for (const key of ["title", "hypothesis", "status"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return undefined;
    (input as Record<string, unknown>)[key] = body[key];
  }
  for (const key of ["params", "results"] as const) {
    if (body[key] !== undefined) input[key] = body[key] as Record<string, unknown>;
  }
  return input;
}

async function handleExperiments(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const id = decodeURIComponent(url.pathname.replace(/^\/experiments\/?/, ""));
  const expected =
    "Expected {title?, hypothesis?: string, params?, results?: object, status?: draft|shared|archived}";
  if (!id) {
    if (req.method === "GET") {
      json(res, 200, { experiments: await session.experiments(url.searchParams.get("node") || undefined) });
    } else if (req.method === "POST") {
      const body = await readJson(req);
      const input = body && experimentInput(body);
      if (!body || typeof body.nodeId !== "string" || !input) {
        json(res, 400, { error: `Expected {nodeId: string, title: string, …}; ${expected}` });
        return;
      }
      json(res, 201, await session.createExperiment(body.nodeId, input));
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  switch (req.method) {
    case "GET":
      json(res, 200, await session.experiment(id));
      return;
    case "PATCH": {
      const body = await readJson(req);
      const input = body && experimentInput(body);
      if (!input) {
        json(res, 400, { error: expected });
        return;
      }
      json(res, 200, await session.updateExperiment(id, input));
      return;
    }
    case "DELETE":
      if (await session.deleteExperiment(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: "Experiment not found" });
      return;
    default:
      json(res, 405, { error: "Method not allowed" });
  }
}

async function handleAccess(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent); // after /access
  const [section, id, sub, subId] = parts;
  const method = req.method ?? "GET";
  const notFound = () => json(res, 404, { error: "Not found" });
  const done = (ok: boolean) => (ok ? json(res, 200, { ok: true }) : notFound());

  if (!section) {
    if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const me = (await session.users()).find((u) => u.id === session.principal.userId) ?? null;
    return json(res, 200, { me, rootRole: await session.role(null) });
  }

  if (section === "users" && !id && method === "GET") {
    return json(res, 200, { users: await session.users() });
  }

  if (section === "groups") {
    if (!id) {
      if (method === "GET") return json(res, 200, { groups: await session.groups() });
      if (method === "POST") {
        const body = await readJson(req);
        const parentId = optionalId(body?.parentId);
        if (!body || typeof body.name !== "string" || parentId === undefined) {
          return json(res, 400, { error: "Expected {parentId: string | null, name: string}" });
        }
        return json(res, 201, { id: await session.createGroup(parentId, body.name) });
      }
    } else if (!sub) {
      if (method === "PATCH") {
        const body = await readJson(req);
        if (!body || typeof body.name !== "string") return json(res, 400, { error: "Expected {name: string}" });
        return done(await session.renameGroup(id, body.name));
      }
      if (method === "DELETE") return done(await session.deleteGroup(id));
    } else if (sub === "members" && subId && (method === "PUT" || method === "DELETE")) {
      return done(await session.setMember(id, subId, method === "PUT"));
    }
  }

  if (section === "grants") {
    if (!id && method === "GET") {
      return json(res, 200, { grants: await session.grants(url.searchParams.get("node") || null) });
    }
    if (!id && method === "POST") {
      const body = await readJson(req);
      const node = optionalId(body?.node);
      if (
        !body ||
        node === undefined ||
        (body.principalType !== "user" && body.principalType !== "group") ||
        typeof body.principalId !== "string" ||
        !ROLES.includes(body.role as Role)
      ) {
        return json(res, 400, {
          error: 'Expected {node: string | null, principalType: "user" | "group", principalId, role}',
        });
      }
      const grantId = await session.setGrant(node, body.principalType, body.principalId, body.role as Role);
      return json(res, 200, { id: grantId });
    }
    if (id && method === "DELETE") return done(await session.revoke(id));
  }

  if (section === "audit" && !id && method === "GET") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    return json(res, 200, { entries: await session.auditLog(Number.isNaN(limit) ? 100 : limit) });
  }

  json(res, 404, { error: "Not found" });
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
  if (!/^\/search\/?$/.test(url.pathname)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const results = await session.search({
    query: url.searchParams.get("q") ?? "",
    scope: url.searchParams.get("scope") || null,
    near: url.searchParams.get("near") || null,
    nearExperiment: url.searchParams.get("experiment") || null,
    limit: Number.isNaN(limit) ? undefined : limit,
  });
  json(res, 200, { results });
}

export function createStorageHandler(
  storage: () => Storage | null,
  maxUploadBytes: number,
  state: () => StorageState = () => "ready",
) {
  return async function handleStorage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const current = storage();
    if (!current) {
      // The UI tells these apart: 503 means "try again shortly"; 404 and 500
      // mean no server storage this session, so it keeps files in the browser.
      const now = state();
      if (now === "starting") json(res, 503, { error: "File storage is starting" });
      else if (now === "failed") json(res, 500, { error: "File storage failed to start" });
      else json(res, 404, { error: "File storage is not configured (set DATABASE_URL)" });
      return;
    }

    try {
      const principal = await identify(req, current);
      if (!principal) {
        json(res, 401, { error: "Sign in to use the workspace" });
        return;
      }
      const session = current.session(principal);
      if (/^\/nodes(\/|$)/.test(url.pathname)) await handleNodes(req, res, url, session);
      else if (/^\/access(\/|$)/.test(url.pathname)) await handleAccess(req, res, url, session);
      else if (/^\/experiments(\/|$)/.test(url.pathname)) await handleExperiments(req, res, url, session);
      else if (/^\/search(\/|$)/.test(url.pathname)) await handleSearch(req, res, url, session);
      else await handleFiles(req, res, url, current, session);
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        json(res, 404, { error: err.message });
        return;
      }
      if (err instanceof ForbiddenError) {
        json(res, 403, { error: err.message });
        return;
      }
      if (err instanceof ReadOnlyFileError) {
        json(res, 403, { error: err.message, readOnly: true });
        return;
      }
      if (err instanceof FileExistsError) {
        json(res, 412, { error: err.message, exists: true });
        return;
      }
      if (
        err instanceof InvalidPathError ||
        err instanceof NodeError ||
        err instanceof AccessError ||
        err instanceof ExperimentError ||
        err instanceof SearchError
      ) {
        json(res, 400, { error: err.message });
        return;
      }
      console.error("[storage] request failed:", err);
      json(res, 500, { error: "Storage error" });
    }
  };

  async function handleFiles(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    current: Storage,
    session: Session,
  ): Promise<void> {
    const rest = url.pathname.replace(/^\/files\/?/, "");
    let path: string;
    try {
      path = rest.split("/").map(decodeURIComponent).join("/");
    } catch {
      json(res, 400, { error: "Malformed path encoding" });
      return;
    }

    if (path === "" && req.method === "GET" && url.searchParams.has("watch")) {
      await watch(res, current.events, session);
      return;
    }

    const experiment = url.searchParams.get("experiment");
    const service = experiment
      ? await session.experimentFiles(experiment)
      : await session.files(url.searchParams.get("node") || null);

    if (path === "") {
      if (req.method !== "GET") json(res, 405, { error: "Method not allowed" });
      else json(res, 200, { files: await service.list() });
      return;
    }

    switch (req.method) {
      case "GET": {
        if (url.searchParams.has("versions")) {
          const versions = await service.history(path);
          if (!versions) json(res, 404, { error: "Not found" });
          else json(res, 200, { versions });
          return;
        }
        // Binary files come straight from the object store when it is reachable
        // from browsers: a short-lived link, made after the access check above.
        // Text stays here, since the UI fetches it from this origin.
        const info = await service.stat(path);
        if (info && !isTextFile(info.path, info.mime)) {
          const link = await current.blobs.downloadUrl(info.sha256, {
            mime: info.mime,
            filename: info.path.split("/").pop() ?? info.path,
          });
          if (link) {
            res.writeHead(302, { Location: link, "Cache-Control": "no-store" });
            res.end();
            return;
          }
        }
        const file = info && (await service.read(path));
        if (!file) {
          json(res, 404, { error: "Not found" });
          return;
        }
        const etag = `"${file.info.sha256}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": file.info.mime,
          "Content-Length": file.bytes.byteLength,
          ETag: etag,
          "Last-Modified": new Date(file.info.updatedAt).toUTCString(),
          "X-File-Author": file.info.author,
          ...(file.info.readOnly ? { "X-File-Read-Only": "true" } : {}),
          "Cache-Control": "no-cache",
        });
        res.end(file.bytes);
        return;
      }
      case "PUT": {
        const bytes = await readBody(req, maxUploadBytes);
        if (!bytes) {
          json(res, 413, { error: `File exceeds ${maxUploadBytes} bytes` });
          return;
        }
        const mime = req.headers["content-type"]?.split(";")[0].trim();
        const info = await service.write(path, bytes, {
          mime: mime && mime !== "application/octet-stream" ? mime : undefined,
          createOnly: req.headers["if-none-match"]?.trim() === "*",
          readOnly: String(req.headers["x-read-only"] ?? "").trim().toLowerCase() === "true",
        });
        json(res, 200, info);
        return;
      }
      case "DELETE": {
        if (await service.remove(path)) json(res, 200, { deleted: path });
        else json(res, 404, { error: "Not found" });
        return;
      }
      default:
        json(res, 405, { error: "Method not allowed" });
    }
  }
}
