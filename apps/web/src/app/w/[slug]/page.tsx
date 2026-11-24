import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { stepsModeFrom } from "@/components/workspace/agent-steps";
import { SESSION_COOKIE, authSecret, readSession } from "@/lib/auth";
import { MEMBER_ROLE_LABEL, workspacePath } from "@/lib/workspace-choice";
import { DEFAULT_SLUG, type WorkspaceInfo } from "@/lib/workspace-request";
import { findWorkspace } from "@/lib/workspaces";
import { Home } from "../../home";
import { NoWorkspaceYet } from "./no-workspace";

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
 * A workspace's page, /w/<slug> (docs/workspaces.md). The slug is
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
  // How much of each turn's steps the chat shows until a user picks.
  const chatSteps = stepsModeFrom(process.env.CHAT_STEPS);
  const userKey = user?.sub ?? "local";

  const found = await findWorkspace(user, slug);
  if (found.status === "found") return <Home chatSteps={chatSteps} workspace={found.workspace} userKey={userKey} />;
  // No workspaces on this server (it has no storage), or no answer: the
  // default workspace, as before them. Requests then name none, which means
  // the default workspace, and without any server the files stay in the browser.
  if (found.status === "unavailable" && slug.toLowerCase() === DEFAULT_SLUG) {
    return <Home chatSteps={chatSteps} workspace={null} userKey={userKey} />;
  }
  if (found.status === "unavailable") return <Unavailable />;
  if (found.mine.length === 0) {
    return <NoWorkspaceYet email={user?.email ?? null} login={Boolean(user)} canCreate={found.canCreate} />;
  }
  return <NoAccess mine={found.mine} />;
}

function Centered({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <main
      data-testid={testId}
      className="flex min-h-screen items-start justify-center bg-[var(--background)] p-6 pt-[18vh] text-[var(--foreground)]"
    >
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

/**
 * The one page for a workspace that doesn't exist and one the user isn't a
 * member of (docs/workspaces.md, "Screens"). It never names what the URL
 * asked for, so it can't tell anyone whether that workspace exists; it lists
 * the user's own instead.
 */
function NoAccess({ mine }: { mine: WorkspaceInfo[] }) {
  return (
    <Centered testId="workspace-no-access">
      <h1 className="mb-2 text-lg font-semibold">You can&apos;t open this workspace</h1>
      <p className="mb-5 text-sm text-[var(--muted-foreground)]">
        It doesn&apos;t exist, or you aren&apos;t a member of it. To join a workspace, ask one of its Owners or Admins to
        add you.
      </p>
      <h2 className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">Your workspaces</h2>
      <ul aria-label="Your workspaces" className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
        {mine.map((w) => (
          <li key={w.id}>
            <a href={workspacePath(w.slug)} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-[var(--secondary)]">
              <span className="truncate">{w.name}</span>
              <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{MEMBER_ROLE_LABEL[w.role]}</span>
            </a>
          </li>
        ))}
      </ul>
    </Centered>
  );
}

/** The server that keeps the workspaces didn't answer. */
function Unavailable() {
  return (
    <Centered testId="workspace-unavailable">
      <h1 className="mb-2 text-lg font-semibold">Workspaces are unavailable right now</h1>
      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        The server that keeps your workspaces didn&apos;t answer. Try again in a moment.
      </p>
      <a href={workspacePath(DEFAULT_SLUG)} className="text-sm underline underline-offset-2">
        Go to the default workspace
      </a>
    </Centered>
  );
}
