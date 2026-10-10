"use client";

import { FormEvent, useState } from "react";

export default function RentRollForm() {
  const [file, setFile] = useState<File | null>(null);
  const [chargeCodes, setChargeCodes] = useState("rent, erent");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");
    setSuccess("");
    setWarnings([]);

    if (!file) {
      setError("Select a Rent Roll workbook to process.");
      return;
    }

    if (!chargeCodes.trim()) {
      setError("Enter at least one rent charge code.");
      return;
    }

    setProcessing(true);

    try {
      const formData = new FormData();

      formData.append("file", file);
      formData.append("chargeCodes", chargeCodes);

      const response = await fetch("/api/automation/rent-roll", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        let message = "The Rent Roll could not be processed.";

        try {
          const data = (await response.json()) as {
            error?: string;
          };

          if (data.error) {
            message = data.error;
          }
        } catch {
          // Keep the fallback message.
        }

        throw new Error(message);
      }

      const blob = await response.blob();

      const disposition =
        response.headers.get("Content-Disposition") ?? "";

      const filenameMatch = disposition.match(
        /filename="([^"]+)"/i
      );

      const filename =
        filenameMatch?.[1] ?? "Rent_Roll_Clean.xlsx";

      const warningHeader =
        response.headers.get("X-Rent-Roll-Warnings");

      if (warningHeader) {
        try {
          const parsed = JSON.parse(
            decodeURIComponent(warningHeader)
          ) as string[];

          setWarnings(parsed);
        } catch {
          // A malformed warning header should not block the download.
        }
      }

      const unitCount =
        response.headers.get("X-Rent-Roll-Unit-Count");

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = filename;

      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      URL.revokeObjectURL(url);

      setSuccess(
        unitCount
          ? `Rent Roll processed successfully. ${unitCount} units were found and the clean workbook was downloaded.`
          : "Rent Roll processed successfully and the clean workbook was downloaded."
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The Rent Roll could not be processed."
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
          htmlFor="rent-roll-file"
          className="block text-sm font-medium text-slate-900"
        >
          Rent Roll Workbook
        </label>

        <input
          id="rent-roll-file"
          name="file"
          type="file"
          accept=".xlsx"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setError("");
            setSuccess("");
            setWarnings([]);
          }}
          className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        />

        <p className="mt-2 text-xs text-slate-500">
          Excel .xlsx files only. Maximum file size: 20 MB.
        </p>
      </div>

      <div>
        <label
          htmlFor="charge-code"
          className="block text-sm font-medium text-slate-900"
        >
          Rent Charge Code
        </label>

        <input
          id="charge-code"
          name="chargeCodes"
          type="text"
          value={chargeCodes}
          onChange={(event) => setChargeCodes(event.target.value)}
          placeholder="rent, erent"
          className="mt-2 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />

        <p className="mt-2 text-xs leading-5 text-slate-500">
          Separate multiple charge codes with commas. Spaces and
          capitalization do not matter.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-800">
            Processed with {warnings.length} warning
            {warnings.length === 1 ? "" : "s"}
          </p>

          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700">
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
        disabled={processing}
        className="inline-flex w-fit items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
      >
        {processing ? "Processing..." : "Process Rent Roll"}
      </button>
    </form>
  );
}