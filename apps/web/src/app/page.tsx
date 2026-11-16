import { redirect } from "next/navigation";

import { defaultWorkspacePath } from "@/lib/workspaces";

// Decided per request, so this page is never prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * A URL without a workspace goes to the default one (issue #226,
 * docs/workspaces.md, decision 5), keeping its query, so links made before
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
  redirect(defaultWorkspacePath(query.toString()));
}
