/**
 * Shared types/constants for the Phase 5 review pipeline. Mirrors
 * src/lib/extraction/types.ts's separation: kept dependency-free so
 * UI code can import it directly.
 */

export type ReviewStatus = "pending" | "processing" | "complete" | "failed";

/**
 * Phase 5 implemented the first category; Phase 6 the second; Phase 7
 * the third; Phase 8 the fourth (the deterministic sub-case of PRD
 * Section 18 category 6 only — see docs/architecture.md Phase 8).
 * The full PRD Section 18 list has seven; this type (and the DB check
 * constraint in the findings migrations) grows as later phases add
 * categories.
 */
export type FindingCategory =
  | "cross_document_identity_consistency"
  | "template_leftover_detection"
  | "typo_and_formatting_inconsistency"
  | "missing_supporting_documentation";

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
export const REVIEW_VERSION = "review-pipeline-v4";

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  cross_document_identity_consistency: "Cross-Document Identity Consistency",
  template_leftover_detection: "Template Leftover Detection",
  typo_and_formatting_inconsistency: "Typo & Formatting Inconsistency",
  missing_supporting_documentation: "Missing Supporting Documentation",
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

/** A check's proposed finding, before it's given an id/report_id and inserted. */
export interface FindingDraft {
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  evidence: string;
  location: string;
}
