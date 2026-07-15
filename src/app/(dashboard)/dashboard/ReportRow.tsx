"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { getSignedReportUrl, deleteReport } from "@/lib/reports/actions";
import { formatFileSize } from "@/lib/reports/validation";
import { ExtractionStatusBadge } from "@/components/reports/ExtractionStatusBadge";
import {
  IN_PROGRESS_STATUSES,
  type ExtractionStatus,
} from "@/lib/extraction/types";

interface ReportRowProps {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  createdAt: string;
  extractionStatus: ExtractionStatus;
}

const EXTRACTION_POLL_INTERVAL_MS = 4000;

export function ReportRow({
  id,
  originalFilename,
  fileSizeBytes,
  createdAt,
  extractionStatus,
}: ReportRowProps) {
  const router = useRouter();
  const [isOpening, setIsOpening] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extraction runs in the background after upload (see
  // src/lib/reports/actions.ts). While a report is still
  // pending/processing, refresh this Server Component's data
  // periodically so the badge updates without a manual page reload.
  // Stops as soon as the status leaves the in-progress set.
  useEffect(() => {
    if (!IN_PROGRESS_STATUSES.includes(extractionStatus)) {
      return;
    }
    const intervalId = setInterval(() => {
      router.refresh();
    }, EXTRACTION_POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [extractionStatus, router]);

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
