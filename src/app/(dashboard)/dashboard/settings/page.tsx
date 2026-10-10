import { createClient } from "@/lib/supabase/server";
import { DeleteAccountSection } from "@/app/(dashboard)/dashboard/settings/DeleteAccountSection";

export const metadata = {
  title: "Account Settings — Keystone OS",
};

/**
 * Read-only profile view plus (Phase 10) account/data deletion
 * (PRD Section 8.9). Editing profile fields and password change
 * (PRD Section 8.8) are still not built.
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
    <div className="flex flex-col gap-6">
      <div className="max-w-md rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-slate-900">
          Account Settings
        </h1>
        <dl className="mt-6 flex flex-col gap-4">
          <div>
            <dt className="text-xs font-medium text-slate-500 uppercase">
              Name
            </dt>
            <dd className="text-sm text-slate-900">{profile?.full_name}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500 uppercase">
              Firm
            </dt>
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
      <DeleteAccountSection />
    </div>
  );
}
