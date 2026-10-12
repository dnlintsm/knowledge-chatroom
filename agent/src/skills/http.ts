import type { IncomingMessage, ServerResponse } from "node:http";

import { identify } from "../storage/identity";
import type { Storage, StorageState } from "../storage";
import { HubConflictError, HubError, HubNotFoundError, MAX_ZIP_BYTES, type SkillHub } from "./hub";
import { InvalidModeError, SkillForbiddenError, UnknownSkillError, type SkillService } from "./service";

/**
 * Skills API, mounted on the agent server next to the storage API:
 *
 *   GET /skills          {skills, canSetDefaults, canPublish, hub}: every
 *                        skill you can use, each with name, description,
 *                        argumentHint, source (builtin | hub | workspace),
 *                        path (its SKILL.md in the workspace), hub ({version,
 *                        latest} for an installed hub skill), mode (the one
 *                        that applies: auto | manual | off), defaultMode,
 *                        workspaceMode, userMode, chatMode, modelInvocable,
 *                        userInvocable, needsExecution. ?thread=<id> includes
 *                        that chat's modes. canSetDefaults: you are an editor
 *                        of the root; canPublish: an owner; hub: there is one
 *   PUT /skills/<name>   {mode, scope?, thread?} → that skill as you now see
 *                        it. scope: user (default, yours), workspace (for
 *                        everyone; editors only, else 403) or chat (yours,
 *                        in `thread`). mode null clears that level
 *   GET /skills/<name>/export   the skill as a .zip (<name>/SKILL.md, ...)
 *   POST /skills/import  a .zip as the body (?filename=, ?replace=1) → adds
 *                        it to the workspace as skills/<name>/ (editors; 409
 *                        when that folder exists, unless replace)
 *
 * The hub (needs storage; hub.ts):
 *
 *   GET /hub?q=          {skills, canInstall, canPublish}
 *   GET /hub/<name>      its versions and one version's SKILL.md (?version=)
 *   POST /hub            {skill} publishes that workspace skill (owners)
 *   PUT /hub/<name>/install     {version?} installs or moves the pin (editors)
 *   DELETE /hub/<name>/install  uninstalls
 *   POST /hub/<name>/fork       copies it into the workspace's skills/
 *   GET /hub/<name>/diff?from=&to=   what changed between two versions
 *   POST /hub/<name>/verify     {version, verified} (hub admins)
 *   POST /hub/<name>/yank       {version, yanked, reason?} (publisher, hub admins)
 *   POST /hub/<name>/reports    {reason, version?} reports it (anyone)
 *   DELETE /hub/<name>/reports?id=   dismisses a report (hub admins)
 *
 * /skills works without storage too: then only the built-in skills, for the
 * local user, with modes kept until the server restarts.
 */
export function createSkillsHandler(
  skills: SkillService,
  hub: SkillHub,
  storage: () => Storage | null,
  state: () => StorageState,
) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  async function body(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function json(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const bytes = await body(req, 64 * 1024);
    if (!bytes) return undefined;
    try {
      const parsed = JSON.parse(bytes.toString("utf8") || "{}");
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  const version = (value: unknown) => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new HubError("version must be a positive whole number");
    return n;
  };
  const required = (value: unknown, what = "version") => {
    const n = version(value);
    if (n === undefined) throw new HubError(`Say which ${what}`);
    return n;
  };

  async function routeSkills(req: IncomingMessage, res: ServerResponse, url: URL, userId: string | null, parts: string[]) {
    const [name, action] = parts;
    if (req.method === "GET" && !name) {
      return send(res, 200, await skills.list(userId, url.searchParams.get("thread") || undefined));
    }
    if (req.method === "POST" && name === "import" && !action) {
      const zip = await body(req, MAX_ZIP_BYTES);
      if (!zip) return send(res, 413, { error: `The .zip may be at most ${MAX_ZIP_BYTES / 1024 / 1024} MB` });
      const replace = ["1", "true"].includes(url.searchParams.get("replace") ?? "");
      const filename = url.searchParams.get("filename") ?? undefined;
      return send(res, 201, await hub.importZip(userId, new Uint8Array(zip), { replace, filename }));
    }
    if (req.method === "GET" && name && action === "export" && parts.length === 2) {
      const zip = await hub.exportZip(userId, name);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}.zip"`,
        "Cache-Control": "no-store",
      });
      return res.end(zip);
    }
    if (req.method === "PUT" && name && !action) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      const thread = typeof input.thread === "string" ? input.thread : undefined;
      return send(res, 200, await skills.setMode(userId, name, input.mode, input.scope ?? "user", thread));
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  async function routeHub(req: IncomingMessage, res: ServerResponse, url: URL, userId: string | null, parts: string[]) {
    const [name, action] = parts;
    if (req.method === "GET" && !name) {
      return send(res, 200, await hub.list(userId, url.searchParams.get("q") ?? ""));
    }
    if (req.method === "POST" && !name) {
      const input = await json(req);
      if (!input || typeof input.skill !== "string") return send(res, 400, { error: "Say which skill: {skill}" });
      return send(res, 201, await hub.publish(userId, input.skill));
    }
    if (req.method === "GET" && name && !action) {
      return send(res, 200, await hub.detail(userId, name, version(url.searchParams.get("version"))));
    }
    if (name && action === "install" && parts.length === 2) {
      if (req.method === "PUT") {
        const input = await json(req);
        if (!input) return send(res, 400, { error: "Invalid JSON body" });
        return send(res, 200, await hub.install(userId, name, version(input.version)));
      }
      if (req.method === "DELETE") {
        if (!(await hub.uninstall(userId, name))) return send(res, 404, { error: `${name} isn't installed` });
        return send(res, 200, { name, installed: null });
      }
    }
    if (req.method === "POST" && name && action === "fork" && parts.length === 2) {
      return send(res, 201, await hub.fork(userId, name));
    }
    if (req.method === "GET" && name && action === "diff") {
      const from = required(url.searchParams.get("from"), "version to compare from");
      const to = required(url.searchParams.get("to"), "version to compare to");
      return send(res, 200, await hub.diff(userId, name, from, to));
    }
    if (req.method === "POST" && name && (action === "verify" || action === "yank")) {
      const input = await json(req);
      if (!input) return send(res, 400, { error: "Invalid JSON body" });
      const v = required(input.version);
      if (action === "verify") return send(res, 200, await hub.verify(userId, name, v, input.verified !== false));
      const reason = typeof input.reason === "string" ? input.reason : null;
      return send(res, 200, await hub.yank(userId, name, v, input.yanked !== false, reason));
    }
    if (name && action === "reports") {
      if (req.method === "POST") {
        const input = await json(req);
        if (!input) return send(res, 400, { error: "Invalid JSON body" });
        return send(res, 201, await hub.report(userId, name, input.reason, version(input.version)));
      }
      if (req.method === "DELETE") {
        return send(res, 200, await hub.dismissReport(userId, name, url.searchParams.get("id") ?? ""));
      }
    }
    return send(res, 405, { error: "Method not allowed" });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const s = storage();
    const isHub = url.pathname === "/hub" || url.pathname.startsWith("/hub/");
    if (!s && state() !== "off") {
      return send(res, state() === "failed" ? 500 : 503, { error: "Storage is not available" });
    }
    try {
      let userId: string | null = null;
      if (s) {
        const principal = await identify(req, s);
        if (!principal) return send(res, 401, { error: "Sign in first" });
        userId = principal.userId;
      }

      let parts: string[];
      try {
        parts = url.pathname
          .slice(isHub ? "/hub".length : "/skills".length)
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
      } catch {
        return send(res, 400, { error: "Invalid skill name" });
      }
      if (parts.length > 2) return send(res, 404, { error: "Not found" });
      return await (isHub ? routeHub : routeSkills)(req, res, url, userId, parts);
    } catch (err) {
      if (err instanceof InvalidModeError || err instanceof HubError) return send(res, 400, { error: err.message });
      if (err instanceof UnknownSkillError || err instanceof HubNotFoundError) {
        return send(res, 404, { error: err.message });
      }
      if (err instanceof SkillForbiddenError) return send(res, 403, { error: err.message });
      if (err instanceof HubConflictError) return send(res, 409, { error: err.message });
      console.error("[skills] request failed:", err);
      return send(res, 500, { error: "Skills request failed" });
    }
  };
}
