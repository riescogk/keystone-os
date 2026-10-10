"use client";

import {
  ChangeEvent,
  FormEvent,
  useState,
} from "react";

export default function IEForm() {
  const [files, setFiles] = useState<File[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  function handleFiles(
    event: ChangeEvent<HTMLInputElement>
  ) {
    setError("");
    setSuccess("");
    setWarnings([]);

    const selectedFiles = Array.from(
      event.target.files ?? []
    );

    const invalidFile = selectedFiles.find((file) => {
      const name = file.name.toLowerCase();

      return (
        !name.endsWith(".xlsx") &&
        !name.endsWith(".xlsm")
      );
    });

    if (invalidFile) {
      setFiles([]);

      setError(
        `${invalidFile.name} is not a supported Excel workbook. Use .xlsx or .xlsm files.`
      );

      return;
    }

    const oversizedFile = selectedFiles.find(
      (file) => file.size > 20 * 1024 * 1024
    );

    if (oversizedFile) {
      setFiles([]);

      setError(
        `${oversizedFile.name} exceeds the 20 MB file-size limit.`
      );

      return;
    }

    if (selectedFiles.length > 20) {
      setFiles([]);

      setError(
        "A maximum of 20 I&E workbooks can be processed at once."
      );

      return;
    }

    setFiles(selectedFiles);
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setError("");
    setSuccess("");
    setWarnings([]);

    if (files.length === 0) {
      setError(
        "Select at least one I&E workbook to process."
      );
      return;
    }

    setProcessing(true);

    try {
      const formData = new FormData();

      for (const file of files) {
        formData.append("files", file);
      }

      const response = await fetch(
        "/api/automation/ie",
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        let message =
          "The I&E files could not be processed.";

        try {
          const body = (await response.json()) as {
            error?: string;
          };

          if (body.error) {
            message = body.error;
          }
        } catch {
          // Keep the fallback message.
        }

        throw new Error(message);
      }

      const blob = await response.blob();

      const contentDisposition =
        response.headers.get("Content-Disposition");

      let filename = "Combined I&E.xlsx";

      if (contentDisposition) {
        const match = contentDisposition.match(
          /filename="([^"]+)"/i
        );

        if (match?.[1]) {
          filename = match[1];
        }
      }

      const encodedWarnings =
        response.headers.get("X-IE-Warnings");

      if (encodedWarnings) {
        try {
          const parsed = JSON.parse(
            decodeURIComponent(encodedWarnings)
          );

          if (Array.isArray(parsed)) {
            setWarnings(
              parsed.filter(
                (value): value is string =>
                  typeof value === "string"
              )
            );
          }
        } catch {
          // A malformed warning header should not block the download.
        }
      }

      const rowCount =
        response.headers.get("X-IE-Row-Count");

      const encodedProperty =
        response.headers.get("X-IE-Property");

      let propertyName = "";

      if (encodedProperty) {
        try {
          propertyName =
            decodeURIComponent(encodedProperty);
        } catch {
          propertyName = encodedProperty;
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = objectUrl;
      anchor.download = filename;

      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      URL.revokeObjectURL(objectUrl);

      const rowText = rowCount
        ? ` ${rowCount} valued line items were combined.`
        : "";

      const propertyText = propertyName
        ? ` for ${propertyName}`
        : "";

      setSuccess(
        `I&E processed successfully${propertyText}.${rowText} The combined workbook was downloaded.`
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The I&E files could not be processed."
      );
    } finally {
      setProcessing(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 flex flex-col gap-6"
    >
      <div>
        <label
          htmlFor="ie-files"
          className="block text-sm font-medium text-slate-900"
        >
          I&amp;E Workbooks
        </label>

        <input
          id="ie-files"
          name="files"
          type="file"
          multiple
          accept=".xlsx,.xlsm"
          disabled={processing}
          onChange={handleFiles}
          className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
        />

        <p className="mt-2 text-xs leading-5 text-slate-500">
          Select one or more Excel workbooks for the same
          property. Supported formats: .xlsx and .xlsm. Maximum
          20 MB per file.
        </p>
      </div>

      {files.length > 0 && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">
            Selected files ({files.length})
          </p>

          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            {files.map((file) => (
              <li
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="flex items-center justify-between gap-4"
              >
                <span className="min-w-0 truncate">
                  {file.name}
                </span>

                <span className="shrink-0 text-xs text-slate-400">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {success && (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700"
        >
          {success}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3">
          <p className="text-sm font-medium text-yellow-800">
            Processed with {warnings.length}{" "}
            {warnings.length === 1
              ? "warning"
              : "warnings"}
          </p>

          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-yellow-700">
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="submit"
        disabled={processing || files.length === 0}
        className="inline-flex w-fit items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {processing
          ? "Processing..."
          : "Process I&E"}
      </button>

      <p className="text-xs text-slate-500">
        Files are processed on demand. Generated I&amp;E
        workbooks are not added to Keystone report history.
      </p>
    </form>
  );
}