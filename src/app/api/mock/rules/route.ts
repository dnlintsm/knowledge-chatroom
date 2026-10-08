import type { NextRequest } from "next/server";
import { mockRules } from "@/lib/rules-mock";

/** Mock rules API: GET ?run=<RUN_DIR> → rules JSON. Point RULES_API_URL here to use it over HTTP. */
export async function GET(req: NextRequest) {
  const run = req.nextUrl.searchParams.get("run");
  if (!run) return Response.json({ error: "Missing ?run=" }, { status: 400 });
  return Response.json(mockRules(run));
}
