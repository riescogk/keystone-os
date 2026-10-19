import { createClient } from "@/lib/supabase/server";
import { splitPagesFromStorage } from "@/lib/extraction/pdfTextExtractor";
import {
  NARRATIVE_CHECK_VERSION,
  runNarrativeContradictionCheck,
} from "@/lib/review/model/narrativeContradictionCheck";
import { createOpenAIProvider } from "@/lib/review/model/openaiProvider";
import type { ModelReviewProvider } from "@/lib/review/model/provider";
import type {
  ModelReviewFailureReason,
  ModelReviewStatus,
} from "@/lib/review/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * A run still marked "processing" after this long is treated as dead
 * (the serverless invocation was killed mid-call) and may be re-run.
 * Must be comfortably longer than the provider timeout.
 */
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

export type ModelReviewMode =
  /** Triggered automatically right after a successful deterministic review. */
  | "auto"
  /** Triggered by the user from the report page (first run, or retry). */
  | "manual";

/**
 * Pure claimability rule (unit-tested). Automatic runs only ever start
 * from "not_run" — so an automatic trigger can never repeat a paid
 * call that was already attempted. Manual runs may also retry a
 * failed/unavailable run, or recover a stale "processing" one.
 */
export function isClaimable(
  status: ModelReviewStatus,
  startedAt: string | null,
  mode: ModelReviewMode,
  now: Date = new Date()
): boolean {
  if (status === "not_run") return true;
  if (mode === "auto") return false;
  if (status === "failed" || status === "unavailable") return true;
  if (status === "processing" && startedAt) {
    return now.getTime() - new Date(startedAt).getTime() > STALE_PROCESSING_MS;
  }
  return false;
}

/**
 * Atomically moves a report's model review into "processing".
 * Returns true only if THIS caller won the claim, so two concurrent
 * triggers (double click, duplicate invocation) can never both spend
 * money on the same report. Requires the deterministic review to be
 * complete — the model layer only ever supplements a finished review.
 */
export async function claimModelReview(
  reportId: string,
  mode: ModelReviewMode
): Promise<boolean> {
  const supabase = await createClient();

  const { data: report, error } = await supabase
    .from("reports")
    .select(
      "extraction_status, review_status, model_review_status, model_review_started_at"
    )
    .eq("id", reportId)
    .single();

  if (error || !report) {
    return false;
  }
  if (
    report.extraction_status !== "completed" ||
    report.review_status !== "complete"
  ) {
    return false;
  }
  if (
    !isClaimable(
      report.model_review_status as ModelReviewStatus,
      report.model_review_started_at,
      mode
    )
  ) {
    return false;
  }

  // Compare-and-set on the status (and start time, for stale recovery)
  // we just read: if anyone else changed it in between, zero rows match.
  let update = supabase
    .from("reports")
    .update({
      model_review_status: "processing",
      model_review_started_at: new Date().toISOString(),
      model_review_completed_at: null,
      model_review_error: null,
    })
    .eq("id", reportId)
    .eq("model_review_status", report.model_review_status);

  update = report.model_review_started_at
    ? update.eq("model_review_started_at", report.model_review_started_at)
    : update.is("model_review_started_at", null);

  const { data: claimed, error: claimError } = await update.select("id");
  if (claimError) {
    console.error("[model-review] Claim failed:", claimError);
    return false;
  }
  return (claimed?.length ?? 0) === 1;
}

async function recordOutcome(
  supabase: SupabaseServerClient,
  reportId: string,
  fields: Record<string, string | null>
): Promise<void> {
  const { error } = await supabase
    .from("reports")
    .update(fields)
    .eq("id", reportId);
  if (error) {
    console.error("[model-review] Failed to record outcome:", error);
  }
}

function failureFields(reason: ModelReviewFailureReason) {
  return {
    model_review_status: reason === "not_configured" ? "unavailable" : "failed",
    model_review_error: reason,
    model_review_completed_at: null,
  };
}

/**
 * Executes a model review that has ALREADY been claimed.
 *
 * Isolation guarantees (PRD Section 22 + the milestone's failure rules):
 * - Reads only `user_id` and `extracted_text`. Writes ONLY the
 *   `model_review_*` columns and new `confidence = 'model_based'`
 *   findings. It never updates `review_status`, never deletes or edits
 *   any finding, so a provider failure cannot corrupt the report or
 *   erase deterministic results.
 * - Never throws: every failure is recorded as a reason code.
 *
 * `provider` is injectable for tests. `undefined` means "use the
 * configured OpenAI provider"; `null` means "none configured".
 */
export async function executeModelReview(
  reportId: string,
  provider?: ModelReviewProvider | null
): Promise<void> {
  const supabase = await createClient();

  try {
    const resolvedProvider =
      provider === undefined ? createOpenAIProvider() : provider;

    if (!resolvedProvider) {
      await recordOutcome(supabase, reportId, failureFields("not_configured"));
      return;
    }

    const { data: report, error: fetchError } = await supabase
      .from("reports")
      .select("user_id, extracted_text")
      .eq("id", reportId)
      .single();

    if (fetchError || !report || !report.extracted_text) {
      console.error("[model-review] Could not load report text:", fetchError);
      await recordOutcome(supabase, reportId, failureFields("save_failed"));
      return;
    }

    const pages = splitPagesFromStorage(report.extracted_text);
    const result = await runNarrativeContradictionCheck(
      pages,
      resolvedProvider
    );

    if (result.status === "failed") {
      await recordOutcome(supabase, reportId, failureFields(result.reason));
      return;
    }

    console.info("[model-review] Check finished:", {
      modelCalled: result.modelCalled,
      returned: result.stats.returned,
      accepted: result.stats.accepted,
      discarded: result.stats.discarded,
      usage: result.usage,
    });

    if (result.findings.length > 0) {
      // A stale-run recovery could re-run a check that had already
      // saved findings before dying; skip any already stored.
      const { data: existing } = await supabase
        .from("findings")
        .select("evidence")
        .eq("report_id", reportId)
        .eq("category", "narrative_data_contradiction");
      const existingEvidence = new Set(
        (existing ?? []).map((row) => row.evidence)
      );

      const fresh = result.findings.filter(
        (draft) => !existingEvidence.has(draft.evidence)
      );

      if (fresh.length > 0) {
        const { error: insertError } = await supabase.from("findings").insert(
          fresh.map((draft) => ({
            report_id: reportId,
            user_id: report.user_id,
            category: draft.category,
            severity: draft.severity,
            confidence: draft.confidence,
            description: draft.description,
            evidence: draft.evidence,
            location: draft.location,
          }))
        );
        if (insertError) {
          console.error("[model-review] Saving findings failed:", insertError);
          await recordOutcome(supabase, reportId, failureFields("save_failed"));
          return;
        }
      }
    }

    await recordOutcome(supabase, reportId, {
      model_review_status: "complete",
      model_review_error: null,
      model_review_completed_at: new Date().toISOString(),
      model_review_version: `${NARRATIVE_CHECK_VERSION}:${resolvedProvider.modelId}`,
    });
  } catch (error) {
    console.error("[model-review] Unexpected failure:", error);
    await recordOutcome(supabase, reportId, failureFields("provider_error"));
  }
}

/** Claim + execute, for the automatic post-review trigger. Never throws. */
export async function runModelReview(
  reportId: string,
  mode: ModelReviewMode = "auto"
): Promise<void> {
  try {
    const claimed = await claimModelReview(reportId, mode);
    if (!claimed) return;
    await executeModelReview(reportId);
  } catch (error) {
    console.error("[model-review] runModelReview failed:", error);
  }
}
