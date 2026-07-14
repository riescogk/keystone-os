"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { getSignedReportUrl, deleteReport } from "@/lib/reports/actions";
import { formatFileSize } from "@/lib/reports/validation";

interface ReportRowProps {
  id: string;
  originalFilename: string;
  fileSizeBytes: number;
  createdAt: string;
}

export function ReportRow({
  id,
  originalFilename,
  fileSizeBytes,
  createdAt,
}: ReportRowProps) {
  const router = useRouter();
  const [isOpening, setIsOpening] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <p className="truncate text-sm font-medium text-slate-900">
          {originalFilename}
        </p>
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
