import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ExtractionStatusBadge } from "@/components/reports/ExtractionStatusBadge";
import { ReviewStatusBadge } from "@/components/reports/ReviewStatusBadge";
import { FindingCard } from "@/app/(dashboard)/dashboard/reports/[id]/FindingCard";
import { ModelReviewPanel } from "@/app/(dashboard)/dashboard/reports/[id]/ModelReviewPanel";
import { isClaimable } from "@/lib/review/model/runModelReview";
import { isExportable } from "@/lib/export/findingsReportData";
import { ComparisonSummary } from "@/app/(dashboard)/dashboard/reports/[id]/ComparisonSummary";
import { ResolvedFindingCard } from "@/app/(dashboard)/dashboard/reports/[id]/ResolvedFindingCard";
import {
  buildComparison,
  isChange,
  type ComparableFinding,
  type ComparisonResult,
} from "@/lib/review/comparison/buildComparison";
import type {
  FindingSeverity,
  ModelReviewFailureReason,
  ModelReviewStatus,
  SourceReference,
} from "@/lib/review/types";
import type { SourceCheckStatus } from "@/lib/review/provenance";
import {
  FAILURE_COPY,
  type SourceWorkbookFailureReason,
} from "@/lib/review/source/errors";

/**
 * The model-based stage can run after this page triggers it (the
 * "Run model-based checks" action). Allow the invocation enough time
 * for one provider call (30s timeout) with headroom; 60s is accepted
 * on every Vercel plan.
 */
export const maxDuration = 60;

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
  searchParams: Promise<{ view?: string | string[] }>;
}

/** Maps a findings row (untyped Supabase result) to the comparison input shape. */
function toComparable(row: {
  id: string;
  category: string;
  severity: string;
  confidence: string;
  status: string;
  description: string;
  evidence: string;
  location: string | null;
  dismissed_reason: string | null;
  carried_forward_from: string | null;
}): ComparableFinding {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity as FindingSeverity,
    confidence: row.confidence as ComparableFinding["confidence"],
    status: row.status as ComparableFinding["status"],
    description: row.description,
    evidence: row.evidence,
    location: row.location,
    dismissedReason: row.dismissed_reason,
    carriedForwardFrom: row.carried_forward_from,
  };
}

/**
 * PRD Section 8.5 (Findings Report) / 8.6 (Finding Detail), scoped to
 * Phase 5: shows extraction/review status for one report, and any
 * findings from the single deterministic check implemented so far
 * (cross-document identity consistency). Triage (FR-4) is available
 * inline per finding via FindingCard. Re-review comparison (Section
 * 8.7, FR-5) and export (FR-6) are later phases.
 */
export default async function ReportPage({
  params,
  searchParams,
}: ReportPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();

  // RLS scopes this to reports the caller owns; a report id belonging
  // to another user (or that doesn't exist) simply returns no row.
  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select(
      "id, original_filename, created_at, page_count, extraction_status, review_status, review_completed_at, review_version, previous_report_id, model_review_status, model_review_error, model_review_started_at"
    )
    .eq("id", id)
    .single();

  if (reportError || !report) {
    notFound();
  }

  const { data: findings } = await supabase
    .from("findings")
    .select(
      "id, category, severity, confidence, status, description, evidence, location, dismissed_reason, carried_forward_from, source_reference"
    )
    .eq("report_id", id)
    .order("created_at", { ascending: true });

  // Milestone 14: the optional source-workbook check for this report and,
  // for a revision, for the report it revises. A missing row means no
  // workbook was attached ("none"). RLS limits both to the caller's own.
  const sourceWorkbookIds = [
    id,
    ...(report.previous_report_id ? [report.previous_report_id] : []),
  ];
  const { data: sourceRows } = await supabase
    .from("report_source_workbooks")
    .select(
      "report_id, original_filename, check_status, check_error, linked_figure_count, matched_figure_count, flagged_figure_count, ambiguous_count, contains_macros"
    )
    .in("report_id", sourceWorkbookIds);
  const sourceRow = sourceRows?.find((row) => row.report_id === id) ?? null;
  const currentSourceStatus: SourceCheckStatus = sourceRow
    ? (sourceRow.check_status as SourceCheckStatus)
    : "none";

  const sortedFindings = [...(findings ?? [])].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity as FindingSeverity] -
      SEVERITY_ORDER[b.severity as FindingSeverity]
  );

  // Phase 13 (PRD FR-5): is this report superseded by a revised draft?
  // Derived from the revision link, never stored (PRD Section 15).
  const { data: supersededBy } = await supabase
    .from("reports")
    .select("id, original_filename")
    .eq("previous_report_id", id)
    .maybeSingle();

  // If this report IS a revised draft, compare it with the previous
  // review (PRD 8.7). Any failure falls back to the plain findings view
  // with a visible note — comparison must never block the screen.
  let comparison: ComparisonResult | null = null;
  let comparisonUnavailable = false;
  let previousReport: {
    id: string;
    original_filename: string;
    review_completed_at: string | null;
  } | null = null;

  if (report.previous_report_id && report.review_status === "complete") {
    const [{ data: previous, error: previousError }, previousFindingsResult] =
      await Promise.all([
        supabase
          .from("reports")
          .select(
            "id, original_filename, review_completed_at, review_version, model_review_status"
          )
          .eq("id", report.previous_report_id)
          .single(),
        supabase
          .from("findings")
          .select(
            "id, category, severity, confidence, status, description, evidence, location, dismissed_reason, carried_forward_from, source_reference"
          )
          .eq("report_id", report.previous_report_id),
      ]);

    if (previousError || !previous || previousFindingsResult.error) {
      comparisonUnavailable = true;
    } else {
      previousReport = previous;
      comparison = buildComparison(
        {
          findings: (findings ?? []).map(toComparable),
          reviewVersion: report.review_version,
          modelReviewStatus: report.model_review_status as ModelReviewStatus,
          sourceCheckStatus: currentSourceStatus,
        },
        {
          findings: (previousFindingsResult.data ?? []).map(toComparable),
          reviewVersion: previous.review_version,
          modelReviewStatus: previous.model_review_status as ModelReviewStatus,
          sourceCheckStatus: (sourceRows?.find(
            (row) => row.report_id === report.previous_report_id
          )?.check_status ?? "none") as SourceCheckStatus,
        }
      );
    }
  }

  const view: "all" | "changes" =
    comparison &&
    (Array.isArray(query.view) ? query.view[0] : query.view) === "changes"
      ? "changes"
      : "all";
  const visibleFindings =
    view === "changes" && comparison
      ? sortedFindings.filter((finding) =>
          isChange(comparison.labels[finding.id])
        )
      : sortedFindings;
  const hiddenUnchangedCount = sortedFindings.length - visibleFindings.length;

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
        {/* PRD Section 23 / FR-6: standalone findings report (PDF). Only
            offered once the review is complete. A plain anchor (not
            next/link) so it is a real file download, never prefetched. */}
        {isExportable(report) && (
          <div className="mt-1">
            <a
              href={`/dashboard/reports/${report.id}/export`}
              download
              aria-label={`Export findings report for ${report.original_filename} as a PDF`}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              Export findings report (PDF)
            </a>
          </div>
        )}
        {/* PRD FR-5: re-review a revised draft. Offered from the latest
            draft only (a report can be revised once; revisions form a
            chain), and only once its review has finished. */}
        {isExportable(report) && !supersededBy && (
          <div className="mt-1">
            <Link
              href={`/dashboard/new?revises=${report.id}`}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              Upload a revised draft
            </Link>
          </div>
        )}
      </div>

      {supersededBy && (
        <StatusNotice>
          This draft has been superseded by a revised draft:{" "}
          <Link
            href={`/dashboard/reports/${supersededBy.id}`}
            className="underline"
          >
            {supersededBy.original_filename}
          </Link>
          . This report and its findings are kept unchanged for your records.
        </StatusNotice>
      )}

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

          {sourceRow && <SourceWorkbookNotice row={sourceRow} />}

          {comparisonUnavailable && (
            <StatusNotice>
              Comparison with the previous draft is temporarily unavailable.
              Your findings for this draft are shown below.
            </StatusNotice>
          )}

          {comparison && previousReport && (
            <ComparisonSummary
              reportId={report.id}
              previousReportId={previousReport.id}
              previousFileName={previousReport.original_filename}
              previousReviewedAt={previousReport.review_completed_at}
              comparison={comparison}
              view={view}
              hiddenUnchangedCount={hiddenUnchangedCount}
            />
          )}

          {report.review_status === "complete" &&
            sortedFindings.length === 0 && (
              <StatusNotice tone="success">
                The deterministic checks found no issues. This is not a
                guarantee that the report has none — only the specific checks
                Keystone runs were applied.
              </StatusNotice>
            )}

          {report.review_status === "complete" &&
            visibleFindings.length > 0 && (
              <ul className="flex flex-col gap-3">
                {visibleFindings.map((finding) => (
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
                    comparison={comparison?.labels[finding.id]}
                    sourceReference={
                      (finding.source_reference as SourceReference | null) ?? null
                    }
                  />
                ))}
              </ul>
            )}

          {comparison &&
            view === "changes" &&
            visibleFindings.length === 0 &&
            comparison.resolved.length === 0 && (
              <StatusNotice>
                Nothing changed since the previous draft: every finding is still
                present and unchanged.
              </StatusNotice>
            )}

          {comparison && comparison.resolved.length > 0 && (
            <section
              aria-labelledby="resolved-heading"
              className="flex flex-col gap-3"
            >
              <h2
                id="resolved-heading"
                className="text-sm font-semibold text-slate-900"
              >
                Resolved since the previous draft ({comparison.resolved.length})
              </h2>
              <ul className="flex flex-col gap-3">
                {comparison.resolved.map((finding) => (
                  <ResolvedFindingCard
                    key={finding.id}
                    category={finding.category}
                    severity={finding.severity}
                    confidence={finding.confidence}
                    status={finding.status}
                    description={finding.description}
                    evidence={finding.evidence}
                    dismissedReason={finding.dismissedReason}
                  />
                ))}
              </ul>
            </section>
          )}

          {/* Phase 11: the optional model-based layer. Shown only once the
              deterministic review is complete, since it supplements it. */}
          {report.review_status === "complete" && (
            <ModelReviewPanel
              reportId={report.id}
              status={report.model_review_status as ModelReviewStatus}
              failureReason={
                report.model_review_error as ModelReviewFailureReason | null
              }
              canRun={isClaimable(
                report.model_review_status as ModelReviewStatus,
                report.model_review_started_at,
                "manual"
              )}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Milestone 14: what happened to the attached Excel workbook. It states
 * exactly what was checked and what was not, and never describes a failed
 * or unfinished check as a passed one. The report review above is shown as
 * complete regardless, because it is.
 */
function SourceWorkbookNotice({
  row,
}: {
  row: {
    original_filename: string;
    check_status: string;
    check_error: string | null;
    linked_figure_count: number | null;
    matched_figure_count: number | null;
    flagged_figure_count: number | null;
    ambiguous_count: number | null;
    contains_macros: boolean;
  };
}) {
  const name = `“${row.original_filename}”`;
  const macroNote = row.contains_macros
    ? " The workbook contains macros; Keystone did not run them."
    : "";

  if (row.check_status === "pending" || row.check_status === "processing") {
    return (
      <StatusNotice>
        Source workbook {name} is being checked. Refresh this page in a moment.
        {macroNote}
      </StatusNotice>
    );
  }

  if (row.check_status === "failed") {
    const reason = (row.check_error ?? "internal") as SourceWorkbookFailureReason;
    return (
      <StatusNotice tone="error">
        Source workbook {name} could not be checked because{" "}
        {FAILURE_COPY[reason] ?? FAILURE_COPY.internal}. The report review above
        is complete and is not affected. No workbook cross-checks were made.
        {macroNote}
      </StatusNotice>
    );
  }

  const linked = row.linked_figure_count ?? 0;
  const matched = row.matched_figure_count ?? 0;
  const flagged = row.flagged_figure_count ?? 0;
  const ambiguous = row.ambiguous_count ?? 0;

  if (linked === 0) {
    return (
      <StatusNotice>
        Source workbook {name} was checked, but no report figures could be
        linked to it with confidence, so no figures were compared. Figures
        that are not linked are not checked.{macroNote}
      </StatusNotice>
    );
  }

  return (
    <StatusNotice tone={flagged > 0 ? "error" : "success"}>
      Source workbook {name}: {linked} report{" "}
      {linked === 1 ? "figure was" : "figures were"} linked to the workbook and
      checked. {matched} matched within rounding
      {flagged > 0
        ? `, and ${flagged} ${flagged === 1 ? "differs" : "differ"} (listed below as Source Workbook Cross-Check findings)`
        : ""}
      .{ambiguous > 0
        ? ` ${ambiguous} possible ${ambiguous === 1 ? "link was" : "links were"} ambiguous and left unchecked.`
        : ""}{" "}
      Figures that could not be linked were not checked.{macroNote}
    </StatusNotice>
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
