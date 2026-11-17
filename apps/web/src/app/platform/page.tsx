import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { WorkspaceInventory } from "@/components/workspace/inventory";
import { SESSION_COOKIE, authSecret, readSession } from "@/lib/auth";

// Login is decided per request, so this page is never prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Every workspace in the deployment, for its admins (PLATFORM_ADMINS on the
 * API server; issue #255, docs/workspaces.md, "Workspace inventory"). Anyone
 * else is told the page isn't for them.
 */
export default async function PlatformPage() {
  if (authSecret() && !readSession((await cookies()).get(SESSION_COOKIE)?.value)) {
    redirect(`/api/auth/login?returnTo=${encodeURIComponent("/platform")}`);
  }
  return <WorkspaceInventory />;
}
