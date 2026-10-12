import type { IncomingMessage, ServerResponse } from "node:http";

import { identify } from "../storage/identity";
import type { Storage, StorageState } from "../storage";
import { InvalidModeError, UnknownSkillError, type SkillService } from "./service";

/**
 * Skills API, mounted on the agent server next to the storage API:
 *
 *   GET /skills          {skills}: every skill you can use, each with name,
 *                        description, argumentHint, source (builtin |
 *                        workspace), path (its SKILL.md in the workspace),
 *                        mode (auto | manual | off), defaultMode,
 *                        modelInvocable, userInvocable, needsExecution
 *   PUT /skills/<name>   {mode} → that skill, in its new mode, for you
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
    let userId: string | null = null;
    if (s) {
      const principal = await identify(req, s);
      if (!principal) return send(res, 401, { error: "Sign in first" });
      userId = principal.userId;
    }

    const name = decodeURIComponent(url.pathname.slice("/skills".length).replace(/^\/+/, ""));
    try {
      if (req.method === "GET" && !name) {
        return send(res, 200, { skills: await skills.list(userId) });
      }
      if (req.method === "PUT" && name && !name.includes("/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: { mode?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(res, 400, { error: "Invalid JSON body" });
        }
        return send(res, 200, await skills.setMode(userId, name, body?.mode));
      }
      return send(res, 405, { error: "Method not allowed" });
    } catch (err) {
      if (err instanceof InvalidModeError) return send(res, 400, { error: err.message });
      if (err instanceof UnknownSkillError) return send(res, 404, { error: err.message });
      console.error("[skills] request failed:", err);
      return send(res, 500, { error: "Skills request failed" });
    }
  };
}
