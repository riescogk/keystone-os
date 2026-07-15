import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ExtractionStatusBadge } from "@/components/reports/ExtractionStatusBadge";
import { ReviewStatusBadge } from "@/components/reports/ReviewStatusBadge";
import { FindingCard } from "@/app/(dashboard)/dashboard/reports/[id]/FindingCard";
import type { FindingSeverity } from "@/lib/review/types";

export const metadata = {
  title: "Report — Keystone OS",
};

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  moderate: 1,
  low: 2,
};

interface ReportPageProps {
  params: Promise<{ id: string }>;
}

/**
 * PRD Section 8.5 (Findings Report) / 8.6 (Finding Detail), scoped to
 * Phase 5: shows extraction/review status for one report, and any
 * findings from the single deterministic check implemented so far
 * (cross-document identity consistency). Triage (FR-4) is available
 * inline per finding via FindingCard. Re-review comparison (Section
 * 8.7, FR-5) and export (FR-6) are later phases.
 */
export default async function ReportPage({ params }: ReportPageProps) {
  const { id } = await params;
  const supabase = await createClient();

  // RLS scopes this to reports the caller owns; a report id belonging
  // to another user (or that doesn't exist) simply returns no row.
  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select(
      "id, original_filename, created_at, page_count, extraction_status, review_status"
    )
    .eq("id", id)
    .single();

  if (reportError || !report) {
    notFound();
  }

  const { data: findings } = await supabase
    .from("findings")
    .select(
      "id, category, severity, confidence, status, description, evidence, location, dismissed_reason"
    )
    .eq("report_id", id)
    .order("created_at", { ascending: true });

  const sortedFindings = [...(findings ?? [])].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity as FindingSeverity] -
      SEVERITY_ORDER[b.severity as FindingSeverity]
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/dashboard"
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Back to dashboard
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-slate-900">
          {report.original_filename}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <ExtractionStatusBadge status={report.extraction_status} />
          {report.extraction_status === "completed" && (
            <ReviewStatusBadge status={report.review_status} />
          )}
        </div>
        <p className="text-xs text-slate-500">
          Uploaded{" "}
          {new Date(report.created_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
          {report.page_count ? ` · ${report.page_count} pages` : ""}
        </p>
      </div>

      {report.extraction_status === "ocr_required" && (
        <StatusNotice>
          This report doesn&apos;t contain selectable text (it appears to be a
          scanned document), so it can&apos;t be reviewed yet. OCR support is
          planned for a future update.
        </StatusNotice>
      )}

      {report.extraction_status === "failed" && (
        <StatusNotice tone="error">
          Text extraction failed for this report. Try deleting and re-uploading
          it.
        </StatusNotice>
      )}

      {(report.extraction_status === "pending" ||
        report.extraction_status === "processing") && (
        <StatusNotice>
          This report is still being processed. This page will update
          automatically — check back in a moment.
        </StatusNotice>
      )}

      {report.extraction_status === "completed" && (
        <>
          {(report.review_status === "pending" ||
            report.review_status === "processing") && (
            <StatusNotice>
              Automated review is running. Findings will appear here once
              it&apos;s done.
            </StatusNotice>
          )}

          {report.review_status === "failed" && (
            <StatusNotice tone="error">
              The automated review failed for this report. Try deleting and
              re-uploading it.
            </StatusNotice>
          )}

          {report.review_status === "complete" &&
            sortedFindings.length === 0 && (
              <StatusNotice tone="success">
                No issues found by the automated review. (Note: this version
                only checks cross-document identity consistency — client name,
                property address, and effective date. More checks are planned.)
              </StatusNotice>
            )}

          {report.review_status === "complete" && sortedFindings.length > 0 && (
            <ul className="flex flex-col gap-3">
              {sortedFindings.map((finding) => (
                <FindingCard
                  key={finding.id}
                  id={finding.id}
                  category={finding.category}
                  severity={finding.severity}
                  confidence={finding.confidence}
                  status={finding.status}
                  description={finding.description}
                  evidence={finding.evidence}
                  location={finding.location}
                  dismissedReason={finding.dismissed_reason}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function StatusNotice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success";
}) {
  const toneClasses = {
    info: "border-slate-200 bg-white text-slate-600",
    error: "border-red-200 bg-red-50 text-red-700",
    success: "border-green-200 bg-green-50 text-green-700",
  }[tone];

  return (
    <div className={`rounded-lg border px-6 py-4 text-sm ${toneClasses}`}>
      {children}
    </div>
  );
}
