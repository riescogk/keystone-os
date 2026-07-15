"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { getSignedReportUrl, deleteReport } from "@/lib/reports/actions";
import { formatFileSize } from "@/lib/reports/validation";
import { ExtractionStatusBadge } from "@/components/reports/ExtractionStatusBadge";
import { ReviewStatusBadge } from "@/components/reports/ReviewStatusBadge";
import {
  IN_PROGRESS_STATUSES,
  type ExtractionStatus,
} from "@/lib/extraction/types";
import {
  IN_PROGRESS_REVIEW_STATUSES,
  type ReviewStatus,
} from "@/lib/review/types";

interface ReportRowProps {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  createdAt: string;
  extractionStatus: ExtractionStatus;
  reviewStatus: ReviewStatus;
}

const POLL_INTERVAL_MS = 4000;

export function ReportRow({
  id,
  originalFilename,
  fileSizeBytes,
  createdAt,
  extractionStatus,
  reviewStatus,
}: ReportRowProps) {
  const router = useRouter();
  const [isOpening, setIsOpening] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extraction and review both run in the background after upload
  // (see src/lib/reports/actions.ts and src/lib/extraction/
  // runExtraction.ts). While either is still in progress, refresh
  // this Server Component's data periodically so both badges update
  // without a manual page reload. Stops once both reach a terminal
  // state.
  useEffect(() => {
    const stillInProgress =
      IN_PROGRESS_STATUSES.includes(extractionStatus) ||
      (extractionStatus === "completed" &&
        IN_PROGRESS_REVIEW_STATUSES.includes(reviewStatus));

    if (!stillInProgress) {
      return;
    }
    const intervalId = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [extractionStatus, reviewStatus, router]);

  async function handleOpen() {
    setError(null);
    setIsOpening(true);
    const result = await getSignedReportUrl(id);
    setIsOpening(false);

    if ("error" in result) {
      setError(result.error);
      return;
    }
    window.open(result.url, "_blank", "noopener,noreferrer");
  }

  async function handleDelete() {
    setError(null);
    setIsDeleting(true);
    const result = await deleteReport(id);
    setIsDeleting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-2 border-b border-slate-100 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-slate-900">
            {originalFilename}
          </p>
          <ExtractionStatusBadge status={extractionStatus} />
          {extractionStatus === "completed" && (
            <ReviewStatusBadge status={reviewStatus} />
          )}
        </div>
        <p className="text-xs text-slate-500">
          {formatFileSize(fileSizeBytes)} ·{" "}
          {new Date(createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={`/dashboard/reports/${id}`}
          className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        >
          Details
        </Link>
        <Button variant="secondary" onClick={handleOpen} isLoading={isOpening}>
          Open
        </Button>

        {confirmingDelete ? (
          <>
            <Button
              variant="danger"
              onClick={handleDelete}
              isLoading={isDeleting}
            >
              Confirm delete
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}
