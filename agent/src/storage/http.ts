import type { IncomingMessage, ServerResponse } from "node:http";

import type { EventHub, WorkspaceEvent } from "./events";
import type { Storage, StorageState } from "./index";
import { NodeError, NodeNotFoundError, type NodeService } from "./nodes";
import { InvalidPathError } from "./paths";

/**
 * REST API for workspace files and the knowledge tree, mounted at /files and
 * /nodes on the agent server:
 *
 *   GET    /files                   list live files (JSON)
 *   GET    /files?watch             change stream (Server-Sent Events), one
 *                                   `data: {…}` per committed change:
 *                                   {"op":"write"|"delete","node","path",…} for
 *                                   files, {"op":"node","change","id"} for nodes
 *   GET    /files/<path>            file bytes, Content-Type = file mime
 *   GET    /files/<path>?versions   version history (JSON)
 *   PUT    /files/<path>            create or replace; body = bytes,
 *                                   Content-Type = mime (optional)
 *   DELETE /files/<path>            soft delete
 *
 *   Every /files route takes ?node=<id> for that knowledge node's files;
 *   without it, files at the workspace root.
 *
 *   GET    /nodes                   {types, nodes}: the levels and every node
 *   POST   /nodes                   {parentId|null, name} → the new node (its
 *                                   type is the level below the parent's)
 *   GET    /nodes/<id>              {node, lineage}: lineage is top level first
 *   PATCH  /nodes/<id>              {name} → rename
 *   DELETE /nodes/<id>              soft delete, with everything below it
 *
 * No auth yet: this is the single-user step. Login and per-workspace roles
 * come next (see issue #4), so keep the agent port off the public internet.
 */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function watch(res: ServerResponse, events: EventHub) {
  // Subscribe before answering, so a failure still gets a normal error response.
  const unsubscribe = await events.subscribe((event: WorkspaceEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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

async function handleNodes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  nodes: NodeService,
) {
  const id = decodeURIComponent(url.pathname.replace(/^\/nodes\/?/, ""));
  if (!id) {
    if (req.method === "GET") {
      json(res, 200, { types: await nodes.types(), nodes: await nodes.list() });
    } else if (req.method === "POST") {
      const body = await readJson(req);
      const parentId = body?.parentId ?? null;
      if (!body || typeof body.name !== "string" || (parentId !== null && typeof parentId !== "string")) {
        json(res, 400, { error: "Expected {parentId: string | null, name: string}" });
        return;
      }
      json(res, 201, await nodes.create(parentId, body.name));
    } else {
      json(res, 405, { error: "Method not allowed" });
    }
    return;
  }

  switch (req.method) {
    case "GET": {
      const lineage = await nodes.lineage(id);
      if (!lineage) json(res, 404, { error: "Node not found" });
      else json(res, 200, { node: lineage[lineage.length - 1], lineage });
      return;
    }
    case "PATCH": {
      const body = await readJson(req);
      if (!body || typeof body.name !== "string") {
        json(res, 400, { error: "Expected {name: string}" });
        return;
      }
      const node = await nodes.rename(id, body.name);
      if (!node) json(res, 404, { error: "Node not found" });
      else json(res, 200, node);
      return;
    }
    case "DELETE": {
      if (await nodes.remove(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: "Node not found" });
      return;
    }
    default:
      json(res, 405, { error: "Method not allowed" });
  }
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
      if (url.pathname === "/nodes" || url.pathname.startsWith("/nodes/")) {
        await handleNodes(req, res, url, current.nodes);
        return;
      }
      await handleFiles(req, res, url, current);
    } catch (err) {
      if (err instanceof InvalidPathError || (err instanceof NodeError && !(err instanceof NodeNotFoundError))) {
        json(res, 400, { error: err.message });
        return;
      }
      if (err instanceof NodeNotFoundError) {
        json(res, 404, { error: err.message });
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
      await watch(res, current.events);
      return;
    }

    const service = await current.files.inNode(url.searchParams.get("node") || null);
    if (!service) {
      json(res, 404, { error: "Node not found" });
      return;
    }

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
        const file = await service.read(path);
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
          author: "user",
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
