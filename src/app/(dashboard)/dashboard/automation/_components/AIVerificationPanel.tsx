"use client";

import { useState } from "react";
import type {
  AIVerificationDiscrepancy,
  AIVerificationFailureReason,
} from "@/lib/automation/ai-verification/types";

export type AutomationAIVerificationResult =
  | {
      status: "passed";
      provider: string;
      comparison: {
        comparedRecordCount: number;
        discrepancyCount: number;
        discrepancies: AIVerificationDiscrepancy[];
      };
      aiWarnings: string[];
    }
  | {
      status: "discrepancies";
      provider: string;
      comparison: {
        comparedRecordCount: number;
        discrepancyCount: number;
        discrepancies: AIVerificationDiscrepancy[];
      };
      aiWarnings: string[];
    }
  | {
      status: "unavailable";
      provider: string | null;
      failureReason: AIVerificationFailureReason;
      message: string;
    }
  | {
      status: "failed";
      provider: string | null;
      failureReason: AIVerificationFailureReason;
      message: string;
    };

export type AutomationAIVerificationState =
  | { status: "idle" }
  | { status: "not_requested" }
  | { status: "processing" }
  | AutomationAIVerificationResult;

interface AIVerificationPanelProps {
  state: AutomationAIVerificationState;
}

const INITIAL_DISCREPANCY_LIMIT = 25;

function failureLabel(reason: AIVerificationFailureReason): string {
  switch (reason) {
    case "not_configured":
      return "AI verification is not configured.";
    case "insufficient_credits":
      return "AI verification was not run because the OpenAI account has insufficient credits.";
    case "rate_limited":
      return "AI verification is temporarily unavailable because the provider rate limit was reached.";
    case "timeout":
      return "AI verification timed out before it could finish.";
    case "refused":
      return "AI verification could not complete because the provider refused the request.";
    case "incomplete":
      return "AI verification returned an incomplete result.";
    case "invalid_output":
      return "AI verification returned an invalid structured result.";
    case "provider_error":
    default:
      return "AI verification could not be completed because of a provider error.";
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "Blank";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : value.map((item) => displayValue(item)).join(", ");
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function evidenceText(discrepancy: AIVerificationDiscrepancy): string[] {
  return (discrepancy.aiEvidence ?? []).map((evidence) => {
    const location = [
      evidence.sourceName,
      evidence.page ? `page ${evidence.page}` : null,
      evidence.sheet ? `sheet ${evidence.sheet}` : null,
      evidence.row ? `row ${evidence.row}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const detail = evidence.excerpt || evidence.note || "";
    return [location, detail].filter(Boolean).join(": ");
  });
}

export default function AIVerificationPanel({ state }: AIVerificationPanelProps) {
  const [showAll, setShowAll] = useState(false);

  if (state.status === "idle") {
    return null;
  }

  if (state.status === "not_requested") {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3" role="status">
        <p className="text-sm font-medium text-slate-800">AI Verification: Not requested</p>
        <p className="mt-1 text-sm leading-5 text-slate-600">
          Keystone processing completed without using OpenAI API credits.
        </p>
      </div>
    );
  }

  if (state.status === "processing") {
    return (
      <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3" role="status">
        <p className="text-sm font-medium text-sky-900">AI Verification: Running</p>
        <p className="mt-1 text-sm leading-5 text-sky-700">
          Keystone processing is complete. AI is independently reviewing the original source now.
        </p>
      </div>
    );
  }

  if (state.status === "unavailable" || state.status === "failed") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3" role="status">
        <p className="text-sm font-medium text-amber-900">
          AI Verification: {state.status === "unavailable" ? "Not run" : "Not completed"}
        </p>
        <p className="mt-1 text-sm leading-5 text-amber-800">
          {failureLabel(state.failureReason)} Your Keystone workbook was still processed normally.
        </p>
        {state.message && state.message !== failureLabel(state.failureReason) && (
          <p className="mt-2 text-xs leading-5 text-amber-700">{state.message}</p>
        )}
      </div>
    );
  }

  if (state.status === "passed") {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3" role="status">
        <p className="text-sm font-medium text-emerald-900">AI Verification: Passed</p>
        <p className="mt-1 text-sm leading-5 text-emerald-700">
          AI independently reviewed the source and found no discrepancies across {state.comparison.comparedRecordCount} compared records.
        </p>
        {state.aiWarnings.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-emerald-700">
            {state.aiWarnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const discrepancies = state.comparison.discrepancies;
  const visibleDiscrepancies = showAll
    ? discrepancies
    : discrepancies.slice(0, INITIAL_DISCREPANCY_LIMIT);

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4" role="status">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-amber-900">
            AI Verification: {state.comparison.discrepancyCount} discrepanc{state.comparison.discrepancyCount === 1 ? "y" : "ies"} found
          </p>
          <p className="mt-1 text-sm leading-5 text-amber-800">
            Keystone processing succeeded. Review the differences below before using the numbers as production-ready.
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
          {state.comparison.comparedRecordCount} records compared
        </span>
      </div>

      {state.aiWarnings.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-200 bg-white/60 px-3 py-2">
          <p className="text-xs font-medium text-amber-900">AI notes</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-amber-800">
            {state.aiWarnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {visibleDiscrepancies.map((discrepancy, index) => {
          const evidence = evidenceText(discrepancy);

          return (
            <div
              key={`${discrepancy.recordKey}-${discrepancy.field}-${index}`}
              className="rounded-md border border-amber-200 bg-white p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-slate-900">{discrepancy.recordKey}</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600">{discrepancy.field}</span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{discrepancy.type}</span>
                {discrepancy.aiConfidence && (
                  <span className="text-slate-500">AI confidence: {discrepancy.aiConfidence}</span>
                )}
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-2.5">
                  <p className="text-xs font-medium text-slate-500">Keystone</p>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-slate-900">
                    {displayValue(discrepancy.keystoneValue)}
                  </pre>
                </div>
                <div className="min-w-0 rounded border border-sky-200 bg-sky-50 p-2.5">
                  <p className="text-xs font-medium text-sky-700">AI</p>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs leading-5 text-sky-950">
                    {displayValue(discrepancy.aiValue)}
                  </pre>
                </div>
              </div>

              {discrepancy.aiExplanation && (
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  <span className="font-medium text-slate-700">AI reason:</span> {discrepancy.aiExplanation}
                </p>
              )}

              {evidence.length > 0 && (
                <div className="mt-2 text-xs leading-5 text-slate-500">
                  <span className="font-medium text-slate-600">Source evidence:</span>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {evidence.map((item, evidenceIndex) => (
                      <li key={`${item}-${evidenceIndex}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!showAll && discrepancies.length > INITIAL_DISCREPANCY_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-4 text-sm font-medium text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700"
        >
          Show all {discrepancies.length} discrepancies
        </button>
      )}
    </div>
  );
}
