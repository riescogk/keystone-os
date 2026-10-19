"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/lib/clsx";
import { acknowledgeFinding, dismissFinding } from "@/lib/findings/actions";
import {
  FINDING_CATEGORY_LABEL,
  FINDING_SEVERITY_LABEL,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
  type FindingStatus,
} from "@/lib/review/types";

interface FindingCardProps {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  status: FindingStatus;
  description: string;
  evidence: string;
  location: string | null;
  dismissedReason: string | null;
}

const SEVERITY_CLASSES: Record<FindingSeverity, string> = {
  critical: "border-red-200 bg-red-50",
  moderate: "border-amber-200 bg-amber-50",
  low: "border-slate-200 bg-white",
};

const SEVERITY_BADGE_CLASSES: Record<FindingSeverity, string> = {
  critical: "bg-red-100 text-red-700",
  moderate: "bg-amber-100 text-amber-700",
  low: "bg-slate-100 text-slate-600",
};

/**
 * PRD FR-3 (Finding Presentation) + FR-4 (Finding Triage).
 *
 * Confidence is always shown, and per PRD Section 20, is never given
 * the same visual weight as the deterministic/critical framing — this
 * phase only ever produces `confidence: "deterministic"` findings, so
 * that label is a statement of fact here, not a "trust me" claim.
 */
export function FindingCard({
  id,
  category,
  severity,
  confidence,
  status,
  description,
  evidence,
  location,
  dismissedReason,
}: FindingCardProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDismissForm, setShowDismissForm] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleAcknowledge() {
    setError(null);
    setIsSubmitting(true);
    const result = await acknowledgeFinding(id);
    setIsSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function handleDismiss() {
    setError(null);
    setIsSubmitting(true);
    const result = await dismissFinding(id, reason);
    setIsSubmitting(false);

    if (!result.success) {
      setError(result.error);
      return;
    }
    setShowDismissForm(false);
    router.refresh();
  }

  const isModelBased = confidence === "model_based";

  return (
    <li
      className={clsx(
        "flex flex-col gap-3 rounded-lg border px-5 py-4",
        // PRD Section 20: a model-based finding must never carry the
        // same visual certainty as a deterministic one — dashed border
        // and a distinct tint, regardless of severity.
        isModelBased
          ? "border-dashed border-indigo-300 bg-indigo-50/60"
          : SEVERITY_CLASSES[severity]
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={clsx(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
            SEVERITY_BADGE_CLASSES[severity]
          )}
        >
          {FINDING_SEVERITY_LABEL[severity]}
        </span>
        <span className="text-xs text-slate-500">
          {FINDING_CATEGORY_LABEL[category]}
        </span>
        {isModelBased ? (
          <span className="inline-flex items-center rounded-full border border-indigo-300 bg-white px-2.5 py-0.5 text-xs font-medium text-indigo-700">
            Model-based · possible conflict
          </span>
        ) : (
          <span className="text-xs text-slate-400">· Deterministic</span>
        )}
        {status !== "open" && (
          <span className="ml-auto text-xs font-medium text-slate-500">
            {status === "acknowledged" ? "Acknowledged" : "Dismissed"}
          </span>
        )}
      </div>

      <p className="text-sm text-slate-900">{description}</p>
      <p className="text-sm text-slate-600">{evidence}</p>
      {location && <p className="text-xs text-slate-400">{location}</p>}
      {isModelBased && (
        <p className="text-xs text-indigo-700">
          Identified by a language model from the report text, not by an exact
          check. It may be mistaken or may have missed context — please verify
          against your report.
        </p>
      )}

      {status === "dismissed" && dismissedReason && (
        <p className="rounded-md bg-white/60 px-3 py-2 text-xs text-slate-600">
          Dismissed: {dismissedReason}
        </p>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {status === "open" && !showDismissForm && (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={handleAcknowledge}
            isLoading={isSubmitting}
          >
            Acknowledge
          </Button>
          <Button
            variant="ghost"
            onClick={() => setShowDismissForm(true)}
            disabled={isSubmitting}
          >
            Dismiss
          </Button>
        </div>
      )}

      {status === "open" && showDismissForm && (
        <div className="flex flex-col gap-2">
          <Textarea
            label="Reason for dismissing"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="e.g. Confirmed this is intentional, not an error."
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              onClick={handleDismiss}
              isLoading={isSubmitting}
            >
              Confirm dismiss
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowDismissForm(false);
                setError(null);
              }}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
