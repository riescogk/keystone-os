import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Account Settings — Keystone OS",
};

/**
 * Phase 2 scope note: read-only profile view only. Editing profile
 * fields, password change, and account/data deletion (PRD Section 8.8,
 * 8.9) are built in a later phase. This page exists now purely so the
 * "Account Settings" nav link (PRD Section 9) is not a dead end.
 */
export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: userResult } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("users")
    .select("full_name, firm_name, email")
    .eq("id", userResult.user?.id)
    .single();

  return (
    <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-slate-900">Account Settings</h1>
      <dl className="mt-6 flex flex-col gap-4">
        <div>
          <dt className="text-xs font-medium text-slate-500 uppercase">Name</dt>
          <dd className="text-sm text-slate-900">{profile?.full_name}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500 uppercase">Firm</dt>
          <dd className="text-sm text-slate-900">
            {profile?.firm_name || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-slate-500 uppercase">
            Email
          </dt>
          <dd className="text-sm text-slate-900">{profile?.email}</dd>
        </div>
      </dl>
    </div>
  );
}
