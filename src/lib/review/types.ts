/**
 * Shared types/constants for the Phase 5 review pipeline. Mirrors
 * src/lib/extraction/types.ts's separation: kept dependency-free so
 * UI code can import it directly.
 */

export type ReviewStatus = "pending" | "processing" | "complete" | "failed";

/**
 * Phase 5 implements exactly one category. The full PRD Section 18
 * list has seven; this type (and the DB check constraint in
 * 0005_findings.sql) will grow as later phases add categories.
 */
export type FindingCategory = "cross_document_identity_consistency";

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
 * that would produce different findings for the same input. Stored
 * per report in `review_version`, analogous to EXTRACTION_VERSION.
 */
export const REVIEW_VERSION = "identity-consistency-v1";

export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  cross_document_identity_consistency: "Cross-Document Identity Consistency",
};

export const FINDING_SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "Critical",
  moderate: "Moderate",
  low: "Low",
};
