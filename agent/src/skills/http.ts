import type { IncomingMessage, ServerResponse } from "node:http";

import { identify } from "../storage/identity";
import type { Storage, StorageState } from "../storage";
import { InvalidModeError, SkillForbiddenError, UnknownSkillError, type SkillService } from "./service";

/**
 * Skills API, mounted on the agent server next to the storage API:
 *
 *   GET /skills          {skills, canSetDefaults}: every skill you can use,
 *                        each with name, description, argumentHint, source
 *                        (builtin | workspace), path (its SKILL.md in the
 *                        workspace), mode (the one that applies: auto |
 *                        manual | off), defaultMode, workspaceMode, userMode,
 *                        chatMode, modelInvocable, userInvocable,
 *                        needsExecution. ?thread=<id> includes that chat's
 *                        modes. canSetDefaults: you are an editor of the root
 *   PUT /skills/<name>   {mode, scope?, thread?} → that skill as you now see
 *                        it. scope: user (default, yours), workspace (for
 *                        everyone; editors only, else 403) or chat (yours,
 *                        in `thread`). mode null clears that level
 *
 * Works without storage too: then only the built-in skills, for the local
 * user, with modes kept until the server restarts.
 */
export function createSkillsHandler(
  skills: SkillService,
  storage: () => Storage | null,
  state: () => StorageState,
) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const s = storage();
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

      let name: string;
      try {
        name = decodeURIComponent(url.pathname.slice("/skills".length).replace(/^\/+/, ""));
      } catch {
        return send(res, 400, { error: "Invalid skill name" });
      }
      if (req.method === "GET" && !name) {
        return send(res, 200, await skills.list(userId, url.searchParams.get("thread") || undefined));
      }
      if (req.method === "PUT" && name && !name.includes("/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { mode?: unknown; scope?: unknown; thread?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(res, 400, { error: "Invalid JSON body" });
        }
        const thread = typeof body?.thread === "string" ? body.thread : undefined;
        return send(res, 200, await skills.setMode(userId, name, body?.mode, body?.scope ?? "user", thread));
      }
      return send(res, 405, { error: "Method not allowed" });
    } catch (err) {
      if (err instanceof InvalidModeError) return send(res, 400, { error: err.message });
      if (err instanceof UnknownSkillError) return send(res, 404, { error: err.message });
      if (err instanceof SkillForbiddenError) return send(res, 403, { error: err.message });
      console.error("[skills] request failed:", err);
      return send(res, 500, { error: "Skills request failed" });
    }
  };
}
