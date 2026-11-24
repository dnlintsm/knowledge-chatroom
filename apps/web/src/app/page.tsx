import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, authSecret, readSession } from "@/lib/auth";
import { defaultWorkspacePath, homeWorkspacePath } from "@/lib/workspaces";

// Decided per request, so this page is never prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * A URL without a workspace goes to one of the user's (* docs/workspaces.md, decision 5): the default workspace when they belong to
 * it, otherwise their first one, keeping its query, so links made before
 * workspaces (e.g. `/?experiment=<id>`) still open. Sign-in happens there.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, v);
  }
  const user = authSecret() ? readSession((await cookies()).get(SESSION_COOKIE)?.value) : null;
  // Signed out: the default workspace's page sends them to sign in first.
  if (authSecret() && !user) redirect(defaultWorkspacePath(query.toString()));
  redirect(await homeWorkspacePath(user, query.toString()));
}
