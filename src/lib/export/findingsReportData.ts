import {
  FINDING_CATEGORY_LABEL,
  FINDING_SEVERITY_LABEL,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
  type FindingStatus,
  type ModelReviewFailureReason,
  type ModelReviewStatus,
} from "@/lib/review/types";

/**
 * Data model and pure helpers for the findings export (PRD Section 23,
 * FR-6). Nothing here touches the database or a PDF library, so every
 * rule below (what is exportable, how coverage is described, how the
 * file is named) is unit-tested directly.
 */

export interface ExportReport {
  fileName: string;
  uploadedAt: string;
  pageCount: number | null;
  reviewCompletedAt: string | null;
  reviewVersion: string | null;
  modelReviewStatus: ModelReviewStatus;
  modelReviewError: ModelReviewFailureReason | null;
  modelReviewCompletedAt: string | null;
  modelReviewVersion: string | null;
}

export interface ExportFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  status: FindingStatus;
  description: string;
  evidence: string;
  location: string | null;
  dismissedReason: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Mandatory wording (PRD Sections 8.5 and 23; Manifesto 0.4)          */
/* ------------------------------------------------------------------ */

export const EXPORT_TITLE = "Pre-Delivery Review \u2014 Findings Summary";

/** Full statement, printed prominently on the first page. */
export const DISCLAIMER_FULL =
  "This document is a supplementary quality-control aid produced by Keystone OS. It does not determine, confirm, or opine on market value, capitalization rates, comparable adjustments, or reconciliation, and it is not a substitute for the appraiser's professional judgment or for professional review. It is not part of the appraisal report and must not be delivered as, or attached to, the appraisal report. Findings are flags for the appraiser to consider; the appraiser decides.";

/** Condensed restatement, printed in the footer of EVERY page. */
export const DISCLAIMER_FOOTER =
  "Supplementary QC aid only. Does not determine value and is not a substitute for professional review. Not part of the appraisal report.";

/** PRD Section 8.5 empty-state wording; the disclaimer part is mandatory. */
export const EMPTY_STATE_TEXT =
  "No issues found. This does not confirm your value conclusion or professional judgment \u2014 only that we found no consistency, arithmetic, or completeness issues in the checks we ran.";

export const MODEL_FINDING_NOTE =
  "Model-based finding: identified by a language model from the report text. It is a possible conflict, not an exact check, and may be mistaken \u2014 verify against the report.";

/* ------------------------------------------------------------------ */
/* Eligibility                                                         */
/* ------------------------------------------------------------------ */

/**
 * A findings report only exists for a completed deterministic review.
 * Exporting earlier would present a partial result as if it were a
 * finished review (including a false "No issues found").
 */
export function isExportable(report: {
  extraction_status: string;
  review_status: string;
}): boolean {
  return (
    report.extraction_status === "completed" &&
    report.review_status === "complete"
  );
}

/* ------------------------------------------------------------------ */
/* Ordering and summary                                                */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  moderate: 1,
  low: 2,
};

export function sortFindingsForReport(
  findings: ExportFinding[]
): ExportFinding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.createdAt.localeCompare(b.createdAt)
  );
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<FindingSeverity, number>;
  byStatus: Record<FindingStatus, number>;
  byConfidence: Record<FindingConfidence, number>;
}

export function summarizeFindings(findings: ExportFinding[]): FindingsSummary {
  const summary: FindingsSummary = {
    total: findings.length,
    bySeverity: { critical: 0, moderate: 0, low: 0 },
    byStatus: { open: 0, acknowledged: 0, dismissed: 0 },
    byConfidence: { deterministic: 0, model_based: 0 },
  };
  for (const finding of findings) {
    summary.bySeverity[finding.severity] += 1;
    summary.byStatus[finding.status] += 1;
    summary.byConfidence[finding.confidence] += 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Coverage statements (never overstate what was checked)              */
/* ------------------------------------------------------------------ */

/** Deterministic categories that run on every review, in display order. */
export function deterministicCheckLabels(): string[] {
  return (Object.keys(FINDING_CATEGORY_LABEL) as FindingCategory[])
    .filter((category) => category !== "narrative_data_contradiction")
    .map((category) => FINDING_CATEGORY_LABEL[category]);
}

const MODEL_FAILURE_TEXT: Record<ModelReviewFailureReason, string> = {
  not_configured: "model-based checks were not enabled",
  timeout: "the model provider timed out",
  provider_error: "the model provider returned an error",
  refused: "the model provider declined to process the content",
  incomplete: "the model response was incomplete",
  invalid_output: "the model response was invalid and was discarded",
  save_failed: "the results could not be saved",
};

/**
 * One honest sentence about the optional model-based pass, so the
 * export can never imply coverage that did not happen. If the pass did
 * not complete, the export says so and says no model-based findings
 * are included.
 */
export function describeModelCoverage(
  report: Pick<
    ExportReport,
    | "modelReviewStatus"
    | "modelReviewError"
    | "modelReviewCompletedAt"
    | "modelReviewVersion"
  >
): string {
  const scope =
    "Model-based narrative checks (stated property condition; stated zoning versus highest-and-best-use)";
  switch (report.modelReviewStatus) {
    case "complete":
      return `${scope}: completed${
        report.modelReviewCompletedAt
          ? ` on ${formatUtc(report.modelReviewCompletedAt)}`
          : ""
      }${
        report.modelReviewVersion ? ` (${report.modelReviewVersion})` : ""
      }. Any findings from this pass are labeled "Model-based".`;
    case "processing":
      return `${scope}: still in progress when this summary was exported. Findings from this pass, if any, are not included.`;
    case "failed":
    case "unavailable":
      return `${scope}: could not be completed${
        report.modelReviewError
          ? ` (${MODEL_FAILURE_TEXT[report.modelReviewError]})`
          : ""
      }. No model-based findings are included.`;
    case "not_run":
    default:
      return `${scope}: not run for this report. No model-based findings are included.`;
  }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** "2026-10-13 14:05 UTC" — explicit zone, since the server doesn't know the user's. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function labelSeverity(severity: FindingSeverity): string {
  return FINDING_SEVERITY_LABEL[severity].toUpperCase();
}

export function labelCategory(category: FindingCategory): string {
  return FINDING_CATEGORY_LABEL[category];
}

/**
 * Download filename: "Keystone-Findings-<original name>-<review date>.pdf".
 * Restricted to a header-safe character set (no quotes, slashes,
 * newlines or non-ASCII), so a hostile original filename can never
 * inject into the Content-Disposition header.
 */
export function buildExportFileName(
  originalFilename: string,
  reviewDateIso: string | null
): string {
  const base = originalFilename
    .replace(/\.pdf$/i, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  const date =
    reviewDateIso && !Number.isNaN(new Date(reviewDateIso).getTime())
      ? new Date(reviewDateIso).toISOString().slice(0, 10)
      : "undated";
  return `Keystone-Findings-${base || "report"}-${date}.pdf`;
}
