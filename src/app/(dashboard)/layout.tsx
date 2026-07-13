import { ReactNode } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/layout/AppShell";

/**
 * Every route under the (dashboard) group is protected.
 *
 * Middleware (src/middleware.ts) already redirects unauthenticated
 * requests before they reach this layout — this server-side check is
 * defense-in-depth, not the only gate, per the project's RLS-first /
 * layered-security principle (Company Bible 0.5, PRD Section 26).
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    redirect("/login");
  }

  return <AppShell userEmail={data.user.email ?? null}>{children}</AppShell>;
}
