import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Root route: sends an authenticated user to their dashboard, and an
 * unauthenticated visitor to login. There is no public marketing page
 * in Phase 2 scope.
 */
export default async function RootPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  redirect(data.user ? "/dashboard" : "/login");
}
