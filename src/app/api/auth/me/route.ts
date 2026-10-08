import type { NextRequest } from "next/server";

import { authSecret, sessionFrom } from "@/lib/auth";

/** Whether login is on, and who is signed in. */
export async function GET(req: NextRequest) {
  const login = Boolean(authSecret());
  const user = login ? sessionFrom(req) : null;
  return Response.json(
    { login, user: user && { name: user.name ?? null, email: user.email ?? null } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
