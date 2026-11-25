"use client";

import { useEffect, useRef, useState } from "react";

type Summary = {
  tables_identified?: number;
  matching_tables?: number;
  tables_with_discrepancies?: number;
  unverified?: number;
  partial?: number;
  discrepancies?: number;
  discrepancy_occurrences?: number;
};
type TableResult = {
  id: string;
  title: string;
  status: string;
  mismatches: number;
};
type Status = {
  state: "running" | "done" | "error";
  message?: string;
  summary?: Summary;
};
type Session =
  | { mode: "local" }
  | { mode: "hosted"; backend: string; ticket: string; expiresAt: number };

type DownloadFormat = "html" | "json" | "csv" | "tables.csv" | "cells.csv";

async function readJson<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error?: unknown }).error) : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  return payload as T;
}

function endpoint(session: Session, action: "run" | "status" | "download", job?: string, format?: DownloadFormat) {
  if (session.mode === "hosted") {
    const base = `${session.backend}/api/table-verification`;
    if (action === "run") return `${base}/run`;
    if (action === "status") return `${base}/status?job=${encodeURIComponent(job ?? "")}`;
    return `${base}/download/${encodeURIComponent(job ?? "")}.${format ?? "html"}`;
  }
  const base = "/api/automation/table-verification";
  if (action === "run") return base;
  if (action === "status") return `${base}?action=status&job=${encodeURIComponent(job ?? "")}`;
  return `${base}?action=download&job=${encodeURIComponent(job ?? "")}&format=${format ?? "html"}`;
}

function authHeaders(session: Session): HeadersInit {
  return session.mode === "hosted" ? { Authorization: `Bearer ${session.ticket}` } : {};
}

export default function TableVerificationForm() {
  const [word, setWord] = useState<File | null>(null);
  const [excel, setExcel] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [tables, setTables] = useState<TableResult[] | null>(null);
  const current = useRef<{ session: Session; job: string } | null>(null);
  const cancelled = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    cancelled.current = true;
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  async function fetchReport(session: Session, job: string) {
    try {
      const response = await fetch(endpoint(session, "download", job, "json"), {
        headers: authHeaders(session), cache: "no-store",
      });
      const report = await readJson<{ tables?: TableResult[] }>(response);
      if (!cancelled.current) setTables(Array.isArray(report.tables) ? report.tables : []);
    } catch (cause) {
      if (!cancelled.current) setMessage(`Verification completed, but table details could not be loaded: ${String(cause)}`);
    }
  }

  async function poll(session: Session, job: string) {
    if (cancelled.current) return;
    try {
      const response = await fetch(endpoint(session, "status", job), {
        headers: authHeaders(session), cache: "no-store",
      });
      const next = await readJson<Status>(response);
      if (cancelled.current) return;
      setStatus(next);
      setMessage(next.message ?? "");
      if (next.state === "running") {
        timeout.current = setTimeout(() => void poll(session, job), 1300);
      } else if (next.state === "done") {
        setRunning(false);
        await fetchReport(session, job);
      } else if (next.state === "error") {
        setRunning(false);
        setError(next.message ?? "Verification failed.");
      } else {
        throw new Error("Unexpected verification state.");
      }
    } catch (cause) {
      if (!cancelled.current) {
        setRunning(false);
        setError(cause instanceof Error ? cause.message : "Could not check verification status.");
      }
    }
  }

  async function runVerification() {
    if (!word || !excel || running) return;
    if (!/\.(doc|docx)$/i.test(word.name) || !/\.(xlsx|xlsm)$/i.test(excel.name)) {
      setError("Please select a Word .doc/.docx and an Excel .xlsx/.xlsm file.");
      return;
    }
    if (word.size + excel.size > 80 * 1024 * 1024) {
      setError("The combined file size must be under 80 MB.");
      return;
    }
    setRunning(true); setError(""); setStatus(null); setTables(null);
    setMessage("Authorizing your verification..."); current.current = null;
    if (timeout.current) clearTimeout(timeout.current);
    try {
      const ticketResponse = await fetch("/api/automation/table-verification/session", { method: "POST", cache: "no-store" });
      const session = await readJson<Session>(ticketResponse);
      const data = new FormData(); data.append("word", word); data.append("excel", excel);
      setMessage("Uploading your Word and Excel files...");
      const upload = await fetch(endpoint(session, "run"), {
        method: "POST", body: data, headers: authHeaders(session), cache: "no-store",
      });
      const result = await readJson<{ job: string }>(upload);
      if (!result.job) throw new Error("The verification server did not return a job ID.");
      current.current = { session, job: result.job };
      setMessage("Comparing Word tables with Excel...");
      await poll(session, result.job);
    } catch (cause) {
      setRunning(false);
      setError(cause instanceof Error ? cause.message : "Could not start verification.");
    }
  }

  async function download(format: DownloadFormat) {
    if (!current.current) return;
    const { session, job } = current.current;
    try {
      const response = await fetch(endpoint(session, "download", job, format), {
        headers: authHeaders(session), cache: "no-store",
      });
      if (!response.ok) {
        await readJson(response);
        throw new Error("Report could not be downloaded.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `table-verification.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Report download failed.");
    }
  }

  const summary = status?.summary;
  const matching = summary?.matching_tables ?? tables?.filter(t => t.status === "FULL" && t.mismatches === 0).length ?? 0;
  const differing = summary?.tables_with_discrepancies ?? tables?.filter(t => t.mismatches > 0).length ?? 0;
  const unverified = summary?.unverified ?? tables?.filter(t => t.status === "UNVERIFIED").length ?? 0;
  const attention = tables?.filter(t => t.mismatches > 0) ?? [];
  const completed = status?.state === "done";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-2 text-base font-semibold text-slate-950">Upload files</h2>
        <p className="mb-5 text-sm text-slate-600">Compare Word report tables with the Excel workbook used to prepare them. Narrative text is not reviewed.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-800">
            Word report (.doc or .docx)
            <input aria-label="Word report" type="file" accept=".doc,.docx" disabled={running}
              onChange={e => setWord(e.target.files?.[0] ?? null)}
              className="mt-2 block w-full rounded-md border border-slate-300 p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2" />
            {word && <span className="mt-1 block truncate text-xs text-slate-600">{word.name}</span>}
          </label>
          <label className="block text-sm font-medium text-slate-800">
            Excel workbook (.xlsx or .xlsm)
            <input aria-label="Excel workbook" type="file" accept=".xlsx,.xlsm" disabled={running}
              onChange={e => setExcel(e.target.files?.[0] ?? null)}
              className="mt-2 block w-full rounded-md border border-slate-300 p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2" />
            {excel && <span className="mt-1 block truncate text-xs text-slate-600">{excel.name}</span>}
          </label>
        </div>
        <button type="button" disabled={!word || !excel || running} onClick={() => void runVerification()}
          className="mt-5 rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          {running ? "Verifying..." : "Run Table Verification"}
        </button>
        {message && <p aria-live="polite" className="mt-3 text-sm text-slate-600">{message}</p>}
        {error && <p role="alert" className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      </div>

      {completed && (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-2 text-base font-semibold text-slate-950">Verification Results</h2>
          <p className="text-sm text-slate-900">Verification completed.</p>
          <p className="mb-5 text-sm text-slate-600">Tables without a reliable Excel match remain unverified.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {([ ["Matching Tables", matching], ["Tables with Discrepancies", differing], ["Not Verified", unverified] ] as const).map(([label, value]) => (
              <div key={label} className="rounded-md bg-slate-50 px-4 py-5">
                <div className="text-xs text-slate-600">{label}</div>
                <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
              </div>
            ))}
          </div>
          {attention.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-semibold text-red-700">Tables Requiring Attention</h3>
              <div className="overflow-hidden rounded-md border border-slate-200">
                {attention.map(table => (
                  <div key={table.id} className="flex gap-3 border-b border-slate-200 px-3 py-3 text-sm last:border-b-0">
                    <strong className="text-red-700">{table.id}</strong>
                    <span className="text-slate-900">{table.title}</span>
                    <span className="ml-auto whitespace-nowrap text-slate-600">{table.mismatches} difference{table.mismatches === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" onClick={() => void download("html")}
              className="rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white">Download Detailed Report</button>
            <button type="button" onClick={() => void download("tables.csv")}
              className="rounded-md border border-slate-300 px-4 py-3 text-sm font-medium text-slate-950">Download Table Results</button>
            <button type="button" onClick={() => void download("json")}
              className="rounded-md border border-slate-300 px-4 py-3 text-sm font-medium text-slate-950">Download JSON</button>
            <button type="button" onClick={() => void download("csv")}
              className="rounded-md border border-slate-300 px-4 py-3 text-sm font-medium text-slate-950">Download Discrepancies CSV</button>
          </div>
          <p className="mt-3 text-xs text-slate-500">Generated reports are temporary and may become unavailable after one hour or a backend restart. Download anything you need to keep.</p>
        </div>
      )}
    </div>
  );
}
