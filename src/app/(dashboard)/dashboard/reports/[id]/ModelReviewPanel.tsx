"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { runModelReviewAction } from "@/lib/review/model/actions";
import type {
  ModelReviewFailureReason,
  ModelReviewStatus,
} from "@/lib/review/types";

interface ModelReviewPanelProps {
  reportId: string;
  status: ModelReviewStatus;
  failureReason: ModelReviewFailureReason | null;
  /** Computed server-side: whether starting/retrying is currently allowed. */
  canRun: boolean;
}

const POLL_INTERVAL_MS = 4000;

const FAILURE_COPY: Record<ModelReviewFailureReason, string> = {
  not_configured: "Model-based checks are not enabled on this deployment.",
  timeout: "The model provider took too long to respond.",
  provider_error: "The model provider returned an error.",
  refused: "The model provider declined to process this content.",
  incomplete: "The model's response was cut off before it finished.",
  invalid_output:
    "The model returned a response in an unexpected format, so it was discarded.",
  save_failed: "The results could not be saved.",
};

/**
 * Shows the state of the OPTIONAL model-based review (PRD Section 13),
 * which is independent of the deterministic review shown above it.
 * Every failure state says what happened and what the user can do next
 * (PRD Section 22) and states that the deterministic findings are
 * unaffected.
 */
export function ModelReviewPanel({
  reportId,
  status,
  failureReason,
  canRun,
}: ModelReviewPanelProps) {
  const router = useRouter();
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A run happens in the background after the click; refresh the
  // server-rendered page until it leaves "processing".
  useEffect(() => {
    if (status !== "processing") {
      return;
    }
    const intervalId = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [status, router]);

  async function handleRun() {
    setError(null);
    setIsStarting(true);
    const result = await runModelReviewAction(reportId);
    setIsStarting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  const isFailure = status === "failed" || status === "unavailable";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-6 py-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">
          Model-based checks
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          An additional, language-model pass that compares the report&apos;s
          statements about property condition and about zoning versus highest
          and best use. Its findings are possible conflicts, labeled
          &ldquo;Model-based&rdquo;, and are never presented as exact checks.
        </p>
      </div>

      {status === "not_run" && (
        <p className="text-sm text-slate-600">
          Model-based checks haven&apos;t been run for this report. Running them
          sends a few short excerpts of the report text (condition, zoning, and
          highest-and-best-use passages) to a third-party model provider.
        </p>
      )}

      {status === "processing" && (
        <p className="text-sm text-blue-700">
          Model-based checks are running. This page will update when they
          finish.
        </p>
      )}

      {status === "complete" && (
        <p className="text-sm text-green-700">
          Model-based checks finished. Any possible conflicts appear in the
          findings above, labeled &ldquo;Model-based&rdquo;. If none appear,
          nothing was flagged in the passages examined.
        </p>
      )}

      {isFailure && (
        <p className="text-sm text-red-700">
          Model-based checks could not be completed
          {failureReason ? `: ${FAILURE_COPY[failureReason]}` : "."} Your
          deterministic findings above are not affected.
          {canRun ? " You can try again." : ""}
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {canRun && (
        <div>
          <Button
            variant="secondary"
            onClick={handleRun}
            isLoading={isStarting}
          >
            {isFailure
              ? "Try model-based checks again"
              : "Run model-based checks"}
          </Button>
        </div>
      )}
    </div>
  );
}
