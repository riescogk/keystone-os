"use client";

import { useRef, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { uploadReport } from "@/lib/reports/actions";
import {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPE,
  isAllowedFileSize,
  isAllowedMimeType,
  formatFileSize,
} from "@/lib/reports/validation";

export function UploadForm() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
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
    if (!isAllowedMimeType(file.type)) {
      setClientError("Only PDF files are supported right now.");
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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedFile) return;

    setServerError(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.set("file", selectedFile);

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
          Report PDF
        </label>
        <input
          ref={fileInputRef}
          id="file"
          name="file"
          type="file"
          accept={ALLOWED_MIME_TYPE}
          onChange={handleFileChange}
          className="text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
        />
        {selectedFile && (
          <p className="text-xs text-slate-500">
            {selectedFile.name} — {formatFileSize(selectedFile.size)}
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
        disabled={!selectedFile}
        isLoading={isUploading}
        className="w-full"
      >
        {isUploading ? "Uploading…" : "Upload report"}
      </Button>
    </form>
  );
}
