"use client";

import { useRef, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { uploadReport } from "@/lib/reports/actions";
import {
  MAX_FILE_SIZE_BYTES,
  REPORT_ACCEPT,
  isAllowedFileSize,
  isAllowedMimeType,
  reportFormatFromFileName,
  formatFileSize,
} from "@/lib/reports/validation";
import {
  MAX_WORKBOOK_BYTES,
  isAllowedWorkbookSize,
  workbookFormatFromFileName,
} from "@/lib/review/source/workbookFile";

interface UploadFormProps {
  /** Set when this upload is a revised draft of an already-reviewed report (PRD FR-5). */
  revisesReportId?: string;
}

/** Accept hints only; the server checks the real file bytes. */
const WORKBOOK_ACCEPT =
  ".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12";

export function UploadForm({ revisesReportId }: UploadFormProps = {}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workbookInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedWorkbook, setSelectedWorkbook] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [workbookError, setWorkbookError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setServerError(null);
    setClientError(null);
    const file = e.target.files?.[0] ?? null;

    if (!file) {
      setSelectedFile(null);
      return;
    }

    // Client-side checks are a UX convenience only — the server
    // action re-validates both independently and is the one that
    // actually enforces them.
    if (
  !reportFormatFromFileName(file.name) ||
  !isAllowedMimeType(file.type)
) {
  setClientError("Only PDF and Microsoft Word .doc files are supported.");
  setSelectedFile(null);
  e.target.value = "";
  return;
}
    if (!isAllowedFileSize(file.size)) {
      setClientError(
        `File is too large. The limit is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`
      );
      setSelectedFile(null);
      e.target.value = "";
      return;
    }

    setSelectedFile(file);
  }

  function handleWorkbookChange(e: React.ChangeEvent<HTMLInputElement>) {
    setServerError(null);
    setWorkbookError(null);
    const file = e.target.files?.[0] ?? null;

    if (!file) {
      setSelectedWorkbook(null);
      return;
    }

    if (!workbookFormatFromFileName(file.name)) {
      setWorkbookError("The source workbook must be an .xlsx or .xlsm file.");
      setSelectedWorkbook(null);
      e.target.value = "";
      return;
    }
    if (!isAllowedWorkbookSize(file.size)) {
      setWorkbookError(
        `The workbook is too large. The limit is ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MB.`
      );
      setSelectedWorkbook(null);
      e.target.value = "";
      return;
    }

    setSelectedWorkbook(file);
  }

  function clearWorkbook() {
    setWorkbookError(null);
    setSelectedWorkbook(null);
    if (workbookInputRef.current) workbookInputRef.current.value = "";
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile) return;

    setServerError(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.set("file", selectedFile);
    if (selectedWorkbook) {
      // Optional. Only sent when the user attached one.
      formData.set("workbook", selectedWorkbook);
    }
    if (revisesReportId) {
      // The server action re-validates this (it is the one that enforces it).
      formData.set("revisesReportId", revisesReportId);
    }

    const result = await uploadReport(formData);

    setIsUploading(false);

    if (!result.success) {
      setServerError(result.error);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="file" className="text-sm font-medium text-slate-700">
          Report <span className="font-normal text-slate-500">(PDF or Word .doc — required)</span>
        </label>
        <input
          ref={fileInputRef}
          id="file"
          name="file"
          type="file"
          accept={REPORT_ACCEPT}
          onChange={handleFileChange}
          className="text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
        />
        {selectedFile && (
          <p className="text-xs text-slate-500">
            {selectedFile.name} — {formatFileSize(selectedFile.size)}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-3">
          <label htmlFor="workbook" className="text-sm font-medium text-slate-700">
            Source Excel workbook{" "}
            <span className="font-normal text-slate-500">(optional)</span>
          </label>
          <p className="text-xs text-slate-500">
            Add the workbook used to prepare the report for additional
            source-data and calculation checks. The report is reviewed
            without it if you leave this empty.
          </p>
          <input
            ref={workbookInputRef}
            id="workbook"
            name="workbook"
            type="file"
            accept={WORKBOOK_ACCEPT}
            onChange={handleWorkbookChange}
            className="text-sm text-slate-700 file:mr-4 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50"
          />
          {selectedWorkbook && (
            <div className="flex items-center gap-3">
              <p className="text-xs text-slate-500">
                {selectedWorkbook.name} — {formatFileSize(selectedWorkbook.size)}
              </p>
              <button
                type="button"
                onClick={clearWorkbook}
                className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
              >
                Remove workbook
              </button>
            </div>
          )}
          {workbookError && (
            <p role="alert" className="text-xs text-red-600">
              {workbookError}
            </p>
          )}
      </div>

      {clientError && (
        <p role="alert" className="text-sm text-red-600">
          {clientError}
        </p>
      )}
      {serverError && (
        <p role="alert" className="text-sm text-red-600">
          {serverError}
        </p>
      )}

      <Button
        type="submit"
        disabled={!selectedFile || Boolean(workbookError)}
        isLoading={isUploading}
        className="w-full"
      >
        {isUploading ? "Uploading…" : "Run Review"}
      </Button>
    </form>
  );
}
