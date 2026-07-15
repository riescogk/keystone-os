import { clsx } from "@/lib/clsx";
import type { ReviewStatus } from "@/lib/review/types";

interface ReviewStatusBadgeProps {
  status: ReviewStatus;
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "Review Pending",
  processing: "Reviewing",
  complete: "Review Complete",
  failed: "Review Failed",
};

const STATUS_CLASSES: Record<ReviewStatus, string> = {
  pending: "bg-slate-100 text-slate-600",
  processing: "bg-blue-50 text-blue-700",
  complete: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
};

/**
 * Purely presentational — reflects `reports.review_status` (PRD
 * Section 16, scoped to this phase's pending/processing/complete/
 * failed subset). Distinct from ExtractionStatusBadge: a report can
 * be extraction-"Completed" while review is still "Pending" (review
 * hasn't started) or "Reviewing" (in progress).
 */
export function ReviewStatusBadge({ status }: ReviewStatusBadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status]
      )}
    >
      {status === "processing" && (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}
