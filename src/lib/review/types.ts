/**
 * Shared types/constants for the Phase 5 review pipeline. Mirrors
 * src/lib/extraction/types.ts's separation: kept dependency-free so
 * UI code can import it directly.
 */

export type ReviewStatus = "pending" | "processing" | "complete" | "failed";

/**
 * Phase 5 implemented the first category; Phase 6 the second; Phase 7
 * the third; Phase 8 the fourth (the deterministic sub-case of PRD
 * Section 18 category 6 only); Phase 9 the fifth (the PDF-text-only
 * sub-case of category 3 — see docs/architecture.md Phase 9). The
 * full PRD Section 18 list has seven; this type (and the DB check
 * constraint in the findings migrations) grows as later phases add
 * categories.
 */
export type FindingCategory =
  | "cross_document_identity_consistency"
  | "template_leftover_detection"
  | "typo_and_formatting_inconsistency"
  | "missing_supporting_documentation"
  | "internal_arithmetic_verification"
  | "narrative_data_contradiction"
  | "source_workbook_discrepancy";

/** PRD Section 19 — fixed, permanent three-level taxonomy. */
export type FindingSeverity = "critical" | "moderate" | "low";

/** PRD Section 20 — fixed, permanent two-level taxonomy. */
export type FindingConfidence = "deterministic" | "model_based";

/** PRD Section 17, scoped to what this phase supports (no re-review yet). */
export type FindingStatus = "open" | "acknowledged" | "dismissed";

export const IN_PROGRESS_REVIEW_STATUSES: readonly ReviewStatus[] = [
  "pending",
  "processing",
];

/**
 * Bumped whenever the review pipeline's check logic changes in a way
 * that would produce different findings for the same input — either
 * a change to an existing check, or a new check being added to the
 * pipeline (as in Phase 6). Stored per report in `review_version`,
 * analogous to EXTRACTION_VERSION. Older reports keep their original
 * version string as an honest historical record of which checks
 * actually ran against them; nothing re-runs automatically when this
 * bumps.
 */
export const REVIEW_VERSION = "review-pipeline-v5";

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  cross_document_identity_consistency: "Cross-Document Identity Consistency",
  template_leftover_detection: "Template Leftover Detection",
  typo_and_formatting_inconsistency: "Typo & Formatting Inconsistency",
  missing_supporting_documentation: "Missing Supporting Documentation",
  internal_arithmetic_verification: "Internal Arithmetic Verification",
  narrative_data_contradiction: "Narrative-to-Data Contradiction",
  source_workbook_discrepancy: "Source Workbook Cross-Check",
};

export const FINDING_SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "Critical",
  moderate: "Moderate",
  low: "Low",
};

/** One page's worth of extracted text, as recovered by splitPagesFromStorage. */
export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * Where a source-workbook finding's evidence lives in the workbook
 * (Milestone 14). Stored as jsonb on the finding and rendered by the UI and
 * the export. Only short identifiers and display values are stored here,
 * never workbook contents beyond the single linked value.
 */
export interface SourceReference {
  workbook: string;
  sheet: string;
  cell: string;
  definedName: string | null;
  label: string | null;
  table: string | null;
  formula: string | null;
  /** The linked workbook value, formatted for display. */
  value: string;
  linkedBy: "defined_name" | "defined_range" | "table_row" | "context_label" | "model_context";
  /** Named/table range when the relationship spans more than one cell. */
  range?: string | null;
  /** Header context for multi-column table/range links. */
  header?: string | null;
}

/** A check's proposed finding, before it's given an id/report_id and inserted. */
export interface FindingDraft {
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  evidence: string;
  location: string;
  /** Set only for source-workbook findings. */
  sourceReference?: SourceReference | null;
}

/**
 * Lifecycle of the OPTIONAL model-based review stage (Phase 11).
 * Independent of ReviewStatus: a model failure never changes the
 * deterministic review's outcome. "unavailable" means no model
 * provider is configured on the server.
 */
export type ModelReviewStatus =
  "not_run" | "processing" | "complete" | "failed" | "unavailable";

/** Short reason codes stored in reports.model_review_error (see migration 0011). */
export type ModelReviewFailureReason =
  | "not_configured"
  | "timeout"
  | "provider_error"
  | "refused"
  | "incomplete"
  | "invalid_output"
  | "save_failed";

export const IN_PROGRESS_MODEL_REVIEW_STATUSES: readonly ModelReviewStatus[] = [
  "processing",
];

/** A model-based check's proposed finding. Confidence is fixed, never inferred. */
export interface ModelFindingDraft extends FindingDraft {
  confidence: "model_based";
}
