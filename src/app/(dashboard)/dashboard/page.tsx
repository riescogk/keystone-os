import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Dashboard — Keystone OS",
};

/**
 * Phase 2 scope note: this screen intentionally shows only the
 * empty state described in PRD Section 8.2. Upload, review
 * processing, and findings are built in a later phase — no "New
 * Review" call-to-action is wired up here because it would be a
 * dead end (PRD Section 9: "no dead-end screens").
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: userResult } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("users")
    .select("full_name")
    .eq("id", userResult.user?.id)
    .single();

  const firstName = profile?.full_name?.split(" ")[0];

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-20 text-center">
      <h1 className="text-lg font-semibold text-slate-900">
        {firstName ? `Welcome, ${firstName}.` : "Welcome."}
      </h1>
      <p className="mt-2 max-w-md text-sm text-slate-600">
        You don&apos;t have any reviews yet. Keystone OS is a second reader for
        your finished reports — it checks for inconsistencies, calculation
        mistakes, and leftover mistakes before you deliver. Report upload and
        review are coming in the next build phase.
      </p>
    </div>
  );
}
