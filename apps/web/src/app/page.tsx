import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { stepsModeFrom } from "@/components/workspace/agent-steps";
import { SESSION_COOKIE, authSecret, readSession } from "@/lib/auth";
import { Home } from "./home";

// Login is decided per request (AUTH_SECRET may be set only at runtime), so
// this page is never prerendered at build time.
export const dynamic = "force-dynamic";

// With login on (AUTH_SECRET), the workspace is for signed-in users only.
export default async function HomePage() {
  if (authSecret() && !readSession((await cookies()).get(SESSION_COOKIE)?.value)) {
    redirect("/api/auth/login");
  }
  // How much of each turn's steps the chat shows until a user picks (issue #154).
  return <Home chatSteps={stepsModeFrom(process.env.CHAT_STEPS)} />;
}
