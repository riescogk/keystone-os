import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ReportRow } from "@/app/(dashboard)/dashboard/ReportRow";

export const metadata = {
  title: "Dashboard — Keystone OS",
};

/**
 * PRD Section 8.2 — Dashboard. Phase 3 adds the real report list;
 * review status/findings summary counts described in the PRD are not
 * shown yet, since reviews don't exist yet (Phase 4+). Listing here
 * is scoped to exactly what Phase 3 built: uploaded reports, nothing
 * about their review state.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: userResult } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("users")
    .select("full_name")
    .eq("id", userResult.user?.id)
    .single();

  const { data: reports, error: reportsError } = await supabase
    .from("reports")
    .select("id, original_filename, file_size_bytes, created_at")
    .order("created_at", { ascending: false });

  const firstName = profile?.full_name?.split(" ")[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">
          {firstName ? `Welcome, ${firstName}.` : "Welcome."}
        </h1>
        <Link
          href="/dashboard/new"
          className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
        >
          New Review
        </Link>
      </div>

      {reportsError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-6 py-4 text-sm text-red-700">
          Couldn&apos;t load your reports right now. Please refresh the page.
        </div>
      )}

      {!reportsError && reports && reports.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-20 text-center">
          <p className="max-w-md text-sm text-slate-600">
            You don&apos;t have any reports yet. Keystone OS is a second reader
            for your finished reports — it checks for inconsistencies,
            calculation mistakes, and leftover mistakes before you deliver.
            Upload your first report to get started.
          </p>
        </div>
      )}

      {!reportsError && reports && reports.length > 0 && (
        <ul className="rounded-lg border border-slate-200 bg-white">
          {reports.map((report) => (
            <ReportRow
              key={report.id}
              id={report.id}
              originalFilename={report.original_filename}
              fileSizeBytes={report.file_size_bytes}
              createdAt={report.created_at}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
