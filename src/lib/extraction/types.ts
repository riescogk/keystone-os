/**
 * Shared types/constants for the Phase 4 text-extraction pipeline.
 * Kept separate from runExtraction.ts so both the orchestrator and
 * any UI code that needs to render a status can import from here
 * without pulling in the (server-only) extraction implementation.
 */

export type ExtractionStatus =
  "pending" | "processing" | "completed" | "ocr_required" | "failed";

export const EXTRACTION_STATUSES: readonly ExtractionStatus[] = [
  "pending",
  "processing",
  "completed",
  "ocr_required",
  "failed",
];

/**
 * Bumped whenever the extraction implementation changes in a way that
 * would produce different output for the same input PDF (e.g.
 * swapping the underlying library, changing the page-delimiter
 * format, changing the "no selectable text" threshold). Stored per
 * report in `extraction_version` so a future pipeline change can
 * identify reports extracted by an older version for reprocessing.
 */
export const EXTRACTION_VERSION = "unpdf-v1";

/** Statuses for which the dashboard should keep polling for an update. */
export const IN_PROGRESS_STATUSES: readonly ExtractionStatus[] = [
  "pending",
  "processing",
];
