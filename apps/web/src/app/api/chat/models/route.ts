import { remoteAgentUrl } from "@/lib/agent-target";
import { authSecret, IDENTITY_HEADER, identityHeader, sessionFrom } from "@/lib/auth";
import { advertisedChatModels } from "@/lib/chat-models";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const user = sessionFrom(request);
  if (authSecret() && !user) return new Response(null, { status: 401 });
  const backend = remoteAgentUrl();
  if (!backend) return new Response(null, { status: 204 });
  try {
    const response = await fetch(`${backend}/agent/models`, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
      headers: user ? { [IDENTITY_HEADER]: identityHeader(user) } : undefined,
    });
    if (response.ok) {
      const models = advertisedChatModels(await response.json());
      if (models) return Response.json(models);
    }
    if (response.status >= 500) return new Response(null, { status: 503 });
  } catch {
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
