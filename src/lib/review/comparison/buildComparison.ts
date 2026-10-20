import type {
  FindingConfidence,
  FindingSeverity,
  FindingStatus,
  ModelReviewStatus,
} from "@/lib/review/types";
import type { SourceCheckStatus } from "@/lib/review/provenance";
import { evidenceFingerprint } from "@/lib/review/comparison/findingMatching";

/**
 * Derives the Section 8.7 comparison (resolved / still open / new)
 * between a review and the review it re-checks.
 *
 * Nothing here is stored. "Resolved" is derived (a previous-review
 * finding that no current finding carries forward from) so a prior
 * review is never mutated (PRD Section 16), and because the links
 * were written by the same deterministic matcher at review time, this
 * view always agrees with what the pipeline actually carried forward.
 *
 * HONESTY RULE: a finding may only be called "resolved" or "new" when
 * the check that produced it actually ran in BOTH reviews. Otherwise a
 * failed or skipped model pass would read as "all your model-based
 * problems are fixed". Those findings are labeled "not compared".
 */

export interface ComparableFinding {
  id: string;
  category: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  status: FindingStatus;
  description: string;
  evidence: string;
  location: string | null;
  dismissedReason: string | null;
  carriedForwardFrom: string | null;
}

export interface ComparableReview {
  findings: ComparableFinding[];
  reviewVersion: string | null;
  modelReviewStatus: ModelReviewStatus;
  /**
   * Milestone 14: state of the optional source-workbook check. Optional so
   * that reviews without the field behave exactly as before ("none").
   */
  sourceCheckStatus?: SourceCheckStatus;
}

export type ComparisonLabel =
  "new" | "still_open" | "still_open_evidence_changed" | "not_compared";

export interface ComparisonResult {
  /** Label for every finding of the CURRENT review, by finding id. */
  labels: Record<string, ComparisonLabel>;
  /** Previous-review findings whose condition no longer appears. */
  resolved: ComparableFinding[];
  counts: {
    resolved: number;
    stillOpen: number;
    evidenceChanged: number;
    new: number;
    notCompared: number;
  };
  /** Plain-language caveats the UI must show next to the numbers. */
  notes: string[];
}

export function buildComparison(
  current: ComparableReview,
  previous: ComparableReview
): ComparisonResult {
  const notes: string[] = [];

  // Deterministic checks always run when a review is complete, so that
  // group is always comparable. The model group needs both passes done.
  const modelComparable =
    current.modelReviewStatus === "complete" &&
    previous.modelReviewStatus === "complete";

  // Same rule for the source-workbook cross-check: its findings can only be
  // called new or resolved when the check actually ran in BOTH reviews.
  const sourceComparable =
    current.sourceCheckStatus === "complete" &&
    previous.sourceCheckStatus === "complete";

  if (!modelComparable) {
    notes.push(
      "Model-based findings were not compared: the optional model-based pass did not complete in both reviews, so a missing finding cannot be taken to mean a fixed one."
    );
  }

  const involvesSourceCheck =
    current.findings.some((f) => f.category === SOURCE_CATEGORY) ||
    previous.findings.some((f) => f.category === SOURCE_CATEGORY);
  if (involvesSourceCheck && !sourceComparable) {
    notes.push(
      "Source-workbook cross-checks were not compared: the source workbook was not checked in both reviews, so a missing cross-check finding cannot be taken to mean a fixed one."
    );
  }

  if (
    current.reviewVersion &&
    previous.reviewVersion &&
    current.reviewVersion !== previous.reviewVersion
  ) {
    notes.push(
      `Keystone's checks changed between these reviews (${previous.reviewVersion} → ${current.reviewVersion}), so some "new" findings may come from checks the earlier review did not include rather than from changes to your report.`
    );
  }

  const previousById = new Map(previous.findings.map((f) => [f.id, f]));
  const carriedIds = new Set<string>();
  const labels: Record<string, ComparisonLabel> = {};
  let stillOpen = 0;
  let evidenceChanged = 0;
  let isNew = 0;
  let notCompared = 0;

  for (const finding of current.findings) {
    const carriedFrom = finding.carriedForwardFrom
      ? previousById.get(finding.carriedForwardFrom)
      : undefined;

    if (carriedFrom) {
      carriedIds.add(carriedFrom.id);
      const changed =
        finding.confidence === "deterministic" &&
        evidenceFingerprint(finding.evidence) !==
          evidenceFingerprint(carriedFrom.evidence);
      labels[finding.id] = changed
        ? "still_open_evidence_changed"
        : "still_open";
      stillOpen += 1;
      if (changed) evidenceChanged += 1;
      continue;
    }

    if (
      (finding.confidence === "model_based" && !modelComparable) ||
      (finding.category === SOURCE_CATEGORY && !sourceComparable)
    ) {
      labels[finding.id] = "not_compared";
      notCompared += 1;
      continue;
    }

    labels[finding.id] = "new";
    isNew += 1;
  }

  const resolved = previous.findings.filter((finding) => {
    if (carriedIds.has(finding.id)) return false;
    if (finding.confidence === "model_based" && !modelComparable) return false;
    if (finding.category === SOURCE_CATEGORY && !sourceComparable) return false;
    return true;
  });

  return {
    labels,
    resolved,
    counts: {
      resolved: resolved.length,
      stillOpen,
      evidenceChanged,
      new: isNew,
      notCompared,
    },
    notes,
  };
}

const SOURCE_CATEGORY = "source_workbook_discrepancy";

/** The "Changes only" view hides findings that are unchanged carry-overs. */
export function isChange(label: ComparisonLabel | undefined): boolean {
  return label !== "still_open";
}
