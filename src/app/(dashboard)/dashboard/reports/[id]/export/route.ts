import { createClient } from "@/lib/supabase/server";
import { buildFindingsReportPdf } from "@/lib/export/findingsReportPdf";
import {
  buildExportFileName,
  isExportable,
  type ExportFinding,
  type ExportReport,
} from "@/lib/export/findingsReportData";
import type {
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
  FindingStatus,
  ModelReviewFailureReason,
  ModelReviewStatus,
} from "@/lib/review/types";

// PDF generation uses Node APIs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * GET /dashboard/reports/[id]/export — the standalone findings report
 * (PRD Section 23, FR-6) as a PDF download.
 *
 * Security:
 * - Does its own authentication. It deliberately does NOT rely on the
 *   proxy/layout having already protected the path (defense in depth;
 *   route handlers are not wrapped by the dashboard layout).
 * - Every read uses the caller's own RLS-scoped session, so a report id
 *   that belongs to someone else behaves exactly like one that does
 *   not exist (404) — it cannot be probed.
 * - No service-role key, no model call, no write of any kind.
 * - `Cache-Control: private, no-store`: the file contains the user's
 *   client data and must never be stored by a shared cache.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  if (!UUID_PATTERN.test(id)) {
    return textResponse("Report not found.", 404);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return textResponse("You must be logged in.", 401);
  }

  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select(
      "id, original_filename, created_at, page_count, extraction_status, review_status, review_completed_at, review_version, model_review_status, model_review_error, model_review_completed_at, model_review_version"
    )
    .eq("id", id)
    .single();

  if (reportError || !report) {
    return textResponse("Report not found.", 404);
  }

  if (!isExportable(report)) {
    return textResponse(
      "The review for this report isn't complete yet, so there is no findings report to export.",
      409
    );
  }

  const { data: findingRows, error: findingsError } = await supabase
    .from("findings")
    .select(
      "category, severity, confidence, status, description, evidence, location, dismissed_reason, acknowledged_at, dismissed_at, created_at"
    )
    .eq("report_id", id)
    .order("created_at", { ascending: true });

  if (findingsError) {
    console.error("[export] Loading findings failed:", findingsError);
    return textResponse("The findings report could not be generated.", 500);
  }

  const exportReport: ExportReport = {
    fileName: report.original_filename,
    uploadedAt: report.created_at,
    pageCount: report.page_count,
    reviewCompletedAt: report.review_completed_at,
    reviewVersion: report.review_version,
    modelReviewStatus: report.model_review_status as ModelReviewStatus,
    modelReviewError:
      report.model_review_error as ModelReviewFailureReason | null,
    modelReviewCompletedAt: report.model_review_completed_at,
    modelReviewVersion: report.model_review_version,
  };

  const findings: ExportFinding[] = (findingRows ?? []).map((row) => ({
    category: row.category as FindingCategory,
    severity: row.severity as FindingSeverity,
    confidence: row.confidence as FindingConfidence,
    status: row.status as FindingStatus,
    description: row.description,
    evidence: row.evidence,
    location: row.location,
    dismissedReason: row.dismissed_reason,
    acknowledgedAt: row.acknowledged_at,
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
  }));

  let pdf: Uint8Array;
  try {
    pdf = await buildFindingsReportPdf({ report: exportReport, findings });
  } catch (error) {
    console.error("[export] PDF generation failed:", error);
    return textResponse("The findings report could not be generated.", 500);
  }

  const fileName = buildExportFileName(
    report.original_filename,
    report.review_completed_at
  );

  return new Response(
    new Blob([pdf as BlobPart], { type: "application/pdf" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}
