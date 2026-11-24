
"use client";

import { useEffect, useState, type FormEvent } from "react";

type JobStatus = {
  state: string;
  message?: string;
  error?: string;
  summary?: Record<string, unknown>;
};


type VerificationTable = {
  id: string;
  title: string;
  status: string;
  mismatches: number;
};


export default function TableVerificationForm() {
  const [word, setWord] = useState<File | null>(null);
  const [excel, setExcel] = useState<File | null>(null);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

const [reportTables, setReportTables] = useState<VerificationTable[] | null>(null);


  useEffect(() => {
    if (!jobId) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function checkStatus() {
      try {
        const response = await fetch(
          `/api/automation/table-verification?action=status&job=${jobId}`,
          { cache: "no-store" }
        );

        const result = (await response.json()) as JobStatus;

        if (!response.ok) {
          throw new Error(result.error || "Unable to check job status.");
        }

        if (!active) return;

        setStatus(result);


if (result.state === "done") {
  const reportResponse = await fetch(
    `/api/automation/table-verification?action=download&job=${jobId}&format=json`,
    { cache: "no-store" }
  );

  if (!reportResponse.ok) {
    throw new Error("Unable to load table-level results.");
  }

  const report = (await reportResponse.json()) as {
    tables?: VerificationTable[];
  };

  if (!Array.isArray(report.tables)) {
    throw new Error("The verification report contains no table results.");
  }

  if (active) {
    setReportTables(report.tables);
  }
}


        if (result.state === "running" || result.state === "queued") {
          timer = setTimeout(checkStatus, 2000);
        } else if (result.state === "error") {
          setError(result.message || "Verification failed.");
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Status check failed."
          );
        }
      }
    }

    void checkStatus();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!word || !excel) return;

    setError("");
    setStatus(null);
    setReportTables(null);
    setJobId("");
    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("word", word);
      formData.append("excel", excel);

      const response = await fetch("/api/automation/table-verification", {
        method: "POST",
        body: formData,
      });

      const result = (await response.json()) as {
        job?: string;
        error?: string;
      };

      if (!response.ok || !result.job) {
        throw new Error(result.error || "Unable to start verification.");
      }

      setJobId(result.job);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Upload failed."
      );
    } finally {
      setSubmitting(false);
    }
  }

  const running =
    status?.state === "running" || status?.state === "queued";

  const finished =
    status !== null &&
    !running &&
    status.state !== "error";

  function downloadUrl(format: string) {
    return `/api/automation/table-verification?action=download&job=${jobId}&format=${format}`;
  }


const matchingTables =
  reportTables?.filter(
    (table) => table.status === "FULL" && table.mismatches === 0
  ) ?? [];

const discrepantTables =
  reportTables?.filter(
    (table) => table.mismatches > 0
  ) ?? [];

const unverifiedTables =
  reportTables?.filter(
    (table) => table.status === "UNVERIFIED"
  ) ?? [];

const partialTables =
  reportTables?.filter(
    (table) => table.status === "PARTIAL"
  ) ?? [];


  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-slate-200 bg-white p-6"
      >
        <h2 className="text-base font-semibold text-slate-900">
          Upload Files
        </h2>

        <p className="mt-2 text-sm text-slate-600">
          Select one Word appraisal report and one Excel source workbook.
          Original files will not be modified.
        </p>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <label
              htmlFor="word-file"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Word Appraisal Report
            </label>

            <div className="flex flex-wrap items-center gap-3">
  <input
    id="word-file"
    type="file"
    accept=".doc,.docx"
    required
    onChange={(e) => setWord(e.target.files?.[0] ?? null)}
    className="peer sr-only"
  />

  <label
    htmlFor="word-file"
    className="inline-flex cursor-pointer items-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-500 peer-focus-visible:ring-offset-2"
  >
    Choose Word File
  </label>

  <span className="break-all text-sm text-slate-600">
    {word?.name ?? "No file selected"}
  </span>
</div>
            <p className="mt-1 text-xs text-slate-500">
              Supported: .doc, .docx
            </p>
          </div>

          <div>
            <label
              htmlFor="excel-file"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Excel Source Workbook
            </label>

            <div className="flex flex-wrap items-center gap-3">
  <input
    id="excel-file"
    type="file"
    accept=".xlsx,.xlsm"
    required
    onChange={(e) => setExcel(e.target.files?.[0] ?? null)}
    className="peer sr-only"
  />

  <label
    htmlFor="excel-file"
    className="inline-flex cursor-pointer items-center rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-500 peer-focus-visible:ring-offset-2"
  >
    Choose Excel File
  </label>

  <span className="break-all text-sm text-slate-600">
    {excel?.name ?? "No file selected"}
  </span>
</div>
            <p className="mt-1 text-xs text-slate-500">
              Supported: .xlsx, .xlsm
            </p>
          </div>
        </div>

        <button
          type="submit"
          disabled={!word || !excel || submitting || running}
          className="mt-6 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "Uploading..."
            : running
              ? "Verifying..."
              : "Run Table Verification"}
        </button>
      </form>

      {(jobId || error) && (
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">
            Verification Results
          </h2>

          {running && (
            <p className="mt-3 text-sm text-slate-600">
              {status?.message || "Comparing Word and Excel tables..."}
            </p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {error}
            </p>
          )}

          {finished && !error && (
            <>
              <p className="mt-3 text-sm font-medium text-slate-900">
                Verification completed.
              </p>

              <p className="mt-1 text-sm text-slate-600">
                Tables without a reliable Excel match remain unverified.
              </p>


{reportTables ? (
  <>
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      {[
        { label: "Matching Tables", count: matchingTables.length },
        { label: "Tables with Discrepancies", count: discrepantTables.length },
        { label: "Not Verified", count: unverifiedTables.length },
      ].map((item) => (
        <div key={item.label} className="rounded-md bg-slate-50 p-4">
          <p className="text-xs text-slate-600">{item.label}</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {item.count}
          </p>
        </div>
      ))}
    </div>

    {partialTables.length > 0 && (
      <p className="mt-4 text-sm text-amber-700">
        {partialTables.length} table(s) were only partially compared.
      </p>
    )}

    {discrepantTables.length > 0 && (
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-red-700">
          Tables Requiring Attention
        </h3>

        <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
          {discrepantTables.map((table) => (
            <div key={table.id} className="flex gap-3 p-3 text-sm">
              <span className="font-semibold text-red-700">
                {table.id}
              </span>
              <span className="text-slate-800">
                {table.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    )}
  </>
) : (
  <p className="mt-4 text-sm text-slate-500">
    Loading table-level results...
  </p>
)}


              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href={downloadUrl("html")}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
                >
                  Download Detailed Report
                </a>

                <a
                  href={downloadUrl("tables.csv")}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
                >
                  Download Table Results
                </a>

                <a
                  href={downloadUrl("json")}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
                >
                  Download JSON
                </a>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
