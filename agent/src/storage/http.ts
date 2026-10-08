import type { IncomingMessage, ServerResponse } from "node:http";

import type { FileEvent, FileService } from "./files";
import { InvalidPathError } from "./paths";

/**
 * REST file API, mounted at /files on the agent server:
 *
 *   GET    /files                   list live files (JSON)
 *   GET    /files?watch             change stream (Server-Sent Events): one
 *                                   `data: {"op":"write"|"delete","path",…}`
 *                                   per committed change
 *   GET    /files/<path>            file bytes, Content-Type = file mime
 *   GET    /files/<path>?versions   version history (JSON)
 *   PUT    /files/<path>            create or replace; body = bytes,
 *                                   Content-Type = mime (optional)
 *   DELETE /files/<path>            soft delete
 *
 * No auth yet: this is the single-user step. Login and per-workspace roles
 * come next (see issue #4), so keep the agent port off the public internet.
 */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function watch(req: IncomingMessage, res: ServerResponse, service: FileService) {
  // Subscribe before answering, so a failure still gets a normal error response.
  const unsubscribe = await service.subscribe((event: FileEvent) => {
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

export function createFilesHandler(
  files: () => FileService | null,
  maxUploadBytes: number,
) {
  return async function handleFiles(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const service = files();
    if (!service) {
      json(res, 503, { error: "File storage is not configured (set DATABASE_URL)" });
      return;
    }

    const rest = url.pathname.replace(/^\/files\/?/, "");
    let path: string;
    try {
      path = rest.split("/").map(decodeURIComponent).join("/");
    } catch {
      json(res, 400, { error: "Malformed path encoding" });
      return;
    }

    try {
      if (path === "") {
        if (req.method !== "GET") {
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        if (url.searchParams.has("watch")) await watch(req, res, service);
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
    } catch (err) {
      if (err instanceof InvalidPathError) {
        json(res, 400, { error: err.message });
        return;
      }
      console.error("[storage] request failed:", err);
      json(res, 500, { error: "Storage error" });
    }
  };
}
