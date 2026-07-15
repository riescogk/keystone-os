import { clsx } from "@/lib/clsx";
import type { ExtractionStatus } from "@/lib/extraction/types";

interface ExtractionStatusBadgeProps {
  status: ExtractionStatus;
}

const STATUS_LABEL: Record<ExtractionStatus, string> = {
  pending: "Processing",
  processing: "Processing",
  completed: "Completed",
  ocr_required: "OCR Required",
  failed: "Failed",
};

const STATUS_CLASSES: Record<ExtractionStatus, string> = {
  pending: "bg-slate-100 text-slate-600",
  processing: "bg-blue-50 text-blue-700",
  completed: "bg-green-50 text-green-700",
  ocr_required: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
};

/**
 * Purely presentational — reflects `reports.extraction_status`
 * (PRD/Phase 4 requirement 5: Processing / Completed / OCR Required /
 * Failed). Does not surface any review/findings state, since that
 * lifecycle doesn't exist yet.
 */
export function ExtractionStatusBadge({ status }: ExtractionStatusBadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_CLASSES[status]
      )}
    >
      {(status === "pending" || status === "processing") && (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}
