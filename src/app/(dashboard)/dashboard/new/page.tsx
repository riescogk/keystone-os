import Link from "next/link";
import { UploadForm } from "@/app/(dashboard)/dashboard/new/UploadForm";
import { createClient } from "@/lib/supabase/server";
import {
  checkRevisionTarget,
  isUuid,
} from "@/lib/review/comparison/revisionEligibility";

export const metadata = {
  title: "New Review — Keystone OS",
};

/**
 * The upload Server Action schedules extraction -> deterministic
 * review -> (Phase 11) the optional model-based check via `after()`,
 * which shares this route's invocation time limit. 60s is accepted on
 * every Vercel plan and fits a typical report plus one 30s provider
 * call. If a run is ever cut off, the report keeps its deterministic
 * results and the model stage can be re-run from the report page.
 */
export const maxDuration = 60;

interface NewReviewPageProps {
  searchParams: Promise<{ revises?: string | string[] }>;
}

/**
 * PRD Section 8.3 — upload. Phase 13 (FR-5): with `?revises=<report id>`
 * this becomes "upload a revised draft" of an already-reviewed report.
 * The report is looked up under the user's own RLS session (someone
 * else's id behaves like a missing one) and the same eligibility rule
 * the Server Action enforces is applied here first, so a problem is
 * explained before the user picks a file.
 */
export default async function NewReviewPage({
  searchParams,
}: NewReviewPageProps) {
  const params = await searchParams;
  const revisesRaw = Array.isArray(params.revises)
    ? params.revises[0]
    : params.revises;

  let revisionProblem: string | null = null;
  let revisedFileName: string | null = null;
  let revisesReportId: string | undefined;

  if (revisesRaw) {
    const supabase = await createClient();
    let target: {
      original_filename: string;
      review_status: string;
      extraction_status: string;
    } | null = null;
    let alreadyRevised = false;

    if (isUuid(revisesRaw)) {
      const { data } = await supabase
        .from("reports")
        .select("original_filename, review_status, extraction_status")
        .eq("id", revisesRaw)
        .maybeSingle();
      target = data ?? null;
      if (target) {
        const { data: existing } = await supabase
          .from("reports")
          .select("id")
          .eq("previous_report_id", revisesRaw)
          .limit(1);
        alreadyRevised = (existing?.length ?? 0) > 0;
      }
    }

    const check = checkRevisionTarget({
      revisesReportId: revisesRaw,
      target,
      alreadyRevised,
    });
    if (check.ok) {
      revisesReportId = revisesRaw;
      revisedFileName = target?.original_filename ?? null;
    } else {
      revisionProblem = check.error;
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-lg font-semibold text-slate-900">
        {revisesReportId ? "Upload a revised draft" : "New Review"}
      </h1>

      {revisionProblem ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-6 py-4 text-sm text-red-700">
          <p>{revisionProblem}</p>
          <p className="mt-2">
            <Link href="/dashboard" className="underline">
              Back to dashboard
            </Link>
          </p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-600">
            {revisesReportId
              ? `This will be reviewed as a revised draft of “${revisedFileName}”. The new findings report will show what was resolved, what is still open, and what is new. Your earlier report and its findings are kept.`
              : "Upload a finished PDF or legacy Word (.doc) report (up to 25 MB). You can optionally add the Excel workbook it was prepared from for source-data checks."}
          </p>
          <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
            <UploadForm revisesReportId={revisesReportId} />
          </div>
        </>
      )}
    </div>
  );
}
