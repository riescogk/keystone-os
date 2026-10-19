import {
  FINDING_CATEGORY_LABEL,
  FINDING_SEVERITY_LABEL,
  type FindingCategory,
  type FindingSeverity,
  type FindingStatus,
} from "@/lib/review/types";

interface ResolvedFindingCardProps {
  category: string;
  severity: string;
  confidence: string;
  status: string;
  description: string;
  evidence: string;
  dismissedReason: string | null;
}

/**
 * A finding from the PREVIOUS draft whose condition no longer appears
 * (PRD Section 17 "Resolved"). Read-only on purpose: it belongs to the
 * previous review, which a re-review never modifies (Section 16), and
 * there is nothing left to triage. Shown rather than silently dropped —
 * "visibility into what was fixed is itself valuable confirmation".
 */
export function ResolvedFindingCard({
  category,
  severity,
  confidence,
  status,
  description,
  evidence,
  dismissedReason,
}: ResolvedFindingCardProps) {
  const previousStatus = status as FindingStatus;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-green-200 bg-green-50/50 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
          Resolved
        </span>
        <span className="text-xs text-slate-500">
          {FINDING_CATEGORY_LABEL[category as FindingCategory] ?? category}
        </span>
        <span className="text-xs text-slate-400">
          · {FINDING_SEVERITY_LABEL[severity as FindingSeverity] ?? severity}
          {" · "}
          {confidence === "model_based" ? "Model-based" : "Deterministic"}
        </span>
      </div>
      <p className="text-sm text-slate-700">{description}</p>
      <p className="text-xs text-slate-500">
        Previous draft&apos;s evidence: {evidence}
      </p>
      {previousStatus !== "open" && (
        <p className="text-xs text-slate-500">
          In the previous draft you{" "}
          {previousStatus === "dismissed" ? "dismissed" : "acknowledged"} this
          {previousStatus === "dismissed" && dismissedReason
            ? ` (reason: ${dismissedReason})`
            : ""}
          .
        </p>
      )}
    </li>
  );
}
