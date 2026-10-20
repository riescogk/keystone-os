import type { FindingCategory, FindingConfidence } from "@/lib/review/types";

/**
 * Where a finding's evidence came from (Milestone 14). Derived from the
 * category and confidence that are already stored, so it needs no schema of
 * its own. Client-safe: the UI and the export both import it.
 */

export type FindingProvenance = "report_review" | "model_narrative" | "source_workbook";

export function findingProvenance(
  category: FindingCategory,
  confidence: FindingConfidence
): FindingProvenance {
  if (category === "source_workbook_discrepancy") return "source_workbook";
  if (confidence === "model_based") return "model_narrative";
  return "report_review";
}

export const PROVENANCE_LABEL: Record<FindingProvenance, string> = {
  report_review: "Report review",
  model_narrative: "Model-based narrative check",
  source_workbook: "Excel-supported cross-check",
};

/**
 * Lifecycle of the optional source-workbook check, as the UI and the
 * comparison see it. "none" means no workbook was supplied for the report.
 */
export type SourceCheckStatus = "none" | "pending" | "processing" | "complete" | "failed";
