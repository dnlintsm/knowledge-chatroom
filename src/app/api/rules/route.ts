import type { NextRequest } from "next/server";
import { mockRules } from "@/lib/rules-mock";

/**
 * The rules API, as the browser sees it: GET /api/rules?run=<title>&experiment=<id>
 * asks RULES_API_URL (GET <url>?run=<title>&experiment=<id>, JSON back) from
 * the server, so the API's address and any credentials stay off the client.
 * A run is an experiment: `run` is its title, `experiment` its id. Without
 * RULES_API_URL it answers with the built-in mock (src/lib/rules-mock.ts).
 */

const TIMEOUT_MS = 30_000;

export async function GET(req: NextRequest) {
  const run = req.nextUrl.searchParams.get("run");
  if (!run) return Response.json({ error: "Missing ?run=" }, { status: 400 });

  const base = process.env.RULES_API_URL;
  if (!base) return Response.json(mockRules(run));

  let upstream: Response;
  try {
    const url = new URL(base);
    url.searchParams.set("run", run);
    const experiment = req.nextUrl.searchParams.get("experiment");
    if (experiment) url.searchParams.set("experiment", experiment);
    upstream = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return Response.json({ error: "The rules API is unreachable" }, { status: 502 });
  }
  if (!upstream.ok) {
    return Response.json({ error: `The rules API answered ${upstream.status}` }, { status: 502 });
  }
  try {
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ error: "The rules API returned invalid JSON" }, { status: 502 });
  }
}
