import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { stepsModeFrom } from "@/components/workspace/agent-steps";
import { SESSION_COOKIE, authSecret, readSession } from "@/lib/auth";
import { DEFAULT_SLUG } from "@/lib/workspace-request";
import { findWorkspace } from "@/lib/workspaces";
import { Home } from "../../home";

// Login and the user's workspaces are decided per request, so this page is
// never prerendered at build time.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function queryString(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(name, v);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * A workspace's page, /w/<slug> (issue #226, docs/workspaces.md). The slug is
 * resolved to the workspace's id once, here; the page then sends that id with
 * every request (src/lib/workspace-request.ts). With login on, it is for
 * signed-in users only.
 */
export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const user = authSecret() ? readSession((await cookies()).get(SESSION_COOKIE)?.value) : null;
  if (authSecret() && !user) {
    const here = `/w/${encodeURIComponent(slug)}${queryString(await searchParams)}`;
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(here)}`);
  }
  // How much of each turn's steps the chat shows until a user picks (issue #154).
  const chatSteps = stepsModeFrom(process.env.CHAT_STEPS);
  const userKey = user?.sub ?? "local";

  const found = await findWorkspace(user, slug);
  if (found.status === "found") return <Home chatSteps={chatSteps} workspace={found.workspace} userKey={userKey} />;
  // No workspaces on this server (the agent server alone), or no answer: the
  // default workspace, as before them. Requests then name none, which means
  // the default workspace, and without any server the files stay in the browser.
  if (found.status === "unavailable" && slug.toLowerCase() === DEFAULT_SLUG) {
    return <Home chatSteps={chatSteps} workspace={null} userKey={userKey} />;
  }
  return <NoWorkspace unavailable={found.status === "unavailable"} />;
}

/** Until the no-access page (rollout step 6): what the URL names can't be opened. */
function NoWorkspace({ unavailable }: { unavailable: boolean }) {
  return (
    <main
      data-testid={unavailable ? "workspace-unavailable" : "workspace-not-found"}
      className="flex min-h-screen items-center justify-center bg-[var(--background)] p-6 text-[var(--foreground)]"
    >
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-lg font-semibold">
          {unavailable ? "Workspaces are unavailable right now" : "Workspace not found"}
        </h1>
        <p className="mb-4 text-sm text-[var(--muted-foreground)]">
          {unavailable
            ? "The server that keeps your workspaces didn't answer. Try again in a moment."
            : "It doesn't exist, or you aren't a member of it. Ask one of its owners or admins to add you."}
        </p>
        <a href={`/w/${DEFAULT_SLUG}`} className="text-sm underline underline-offset-2">
          Go to the default workspace
        </a>
      </div>
    </main>
  );
}
