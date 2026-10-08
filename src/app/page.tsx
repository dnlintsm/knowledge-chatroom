import { cookies } from "next/headers";
import { redirect } from "next/navigation";

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
  return <Home />;
}
