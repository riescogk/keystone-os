import { createClient } from "@/lib/supabase/server";
import { splitPagesFromStorage } from "@/lib/extraction/pdfTextExtractor";
import { checkCrossDocumentIdentityConsistency } from "@/lib/review/identityConsistencyCheck";
import { checkTemplateLeftovers } from "@/lib/review/templateLeftoverCheck";
import { checkTypoAndFormattingIssues } from "@/lib/review/typoFormattingCheck";
import { checkMissingSupportingDocumentation } from "@/lib/review/missingDocumentationCheck";
import { checkArithmeticVerification } from "@/lib/review/arithmeticVerificationCheck";
import { runModelReview } from "@/lib/review/model/runModelReview";
import { REVIEW_VERSION } from "@/lib/review/types";

/**
 * Runs every deterministic review check registered so far (Phase 5:
 * cross-document identity consistency; Phase 6: template leftover
 * detection; Phase 7: typo and formatting inconsistency; Phase 8:
 * missing supporting documentation references; Phase 9: internal
 * arithmetic verification) for a single report, writes any resulting
 * findings, then marks the report's review as complete. Adding a
 * future check means adding one more entry to the array below — this
 * function's lifecycle/idempotency/error-handling logic doesn't
 * change.
 *
 * Called from runExtraction.ts immediately after extraction succeeds
 * — review has a hard dependency on extracted text, so it makes sense
 * as the next stage of the same background pipeline rather than a
 * separately triggered job. Like runTextExtraction, this function
 * doesn't know or care *how* it was invoked, so a future phase can
 * move both stages to a real queue without changing this function.
 *
 * Never throws, for the same reason as runTextExtraction: this runs
 * outside the request/response cycle, so there is no caller left to
 * hand a thrown error to.
 */
export async function runReview(reportId: string): Promise<void> {
  const supabase = await createClient();

  const { data: report, error: fetchError } = await supabase
    .from("reports")
    .select("user_id, extraction_status, extracted_text, review_status")
    .eq("id", reportId)
    .single();

  if (fetchError || !report) {
    console.error(
      `[review] Could not load report ${reportId} to review:`,
      fetchError
    );
    return;
  }

  // Review can only run once extraction has produced text. If
  // extraction is ocr_required/failed, there's nothing to check yet —
  // leave review_status at 'pending' rather than inventing a state
  // the PRD doesn't define.
  if (report.extraction_status !== "completed" || !report.extracted_text) {
    return;
  }

  // Idempotency guard, same rationale as runTextExtraction.
  if (report.review_status !== "pending") {
    return;
  }

  const markStatus = async (fields: Record<string, string | null>) => {
    const { error } = await supabase
      .from("reports")
      .update(fields)
      .eq("id", reportId);
    if (error) {
      console.error(
        `[review] Failed to update review status for report ${reportId}:`,
        error
      );
    }
  };

  await markStatus({ review_status: "processing" });

  // Set only once the DETERMINISTIC review has fully completed. The
  // optional model-based stage below is gated on this, and runs outside
  // the try/catch so nothing it does can ever mark this review failed.
  let deterministicReviewComplete = false;

  try {
    const pages = splitPagesFromStorage(report.extracted_text);
    const findingDrafts = [
      ...checkCrossDocumentIdentityConsistency(pages),
      ...checkTemplateLeftovers(pages),
      ...checkTypoAndFormattingIssues(pages),
      ...checkMissingSupportingDocumentation(pages),
      ...checkArithmeticVerification(pages),
    ];

    if (findingDrafts.length > 0) {
      const { error: insertError } = await supabase.from("findings").insert(
        findingDrafts.map((draft) => ({
          report_id: reportId,
          user_id: report.user_id,
          category: draft.category,
          severity: draft.severity,
          confidence: "deterministic",
          description: draft.description,
          evidence: draft.evidence,
          location: draft.location,
        }))
      );

      if (insertError) {
        throw new Error(`Failed to insert findings: ${insertError.message}`);
      }
    }

    await markStatus({
      review_status: "complete",
      review_completed_at: new Date().toISOString(),
      review_version: REVIEW_VERSION,
    });
    deterministicReviewComplete = true;
  } catch (error) {
    console.error(`[review] Review failed for report ${reportId}:`, error);
    await markStatus({
      review_status: "failed",
      review_completed_at: new Date().toISOString(),
      review_version: REVIEW_VERSION,
    });
  }

  // Phase 11: the optional model-based layer supplements a finished
  // deterministic review (PRD Section 13). runModelReview never throws,
  // records its own outcome in the separate model_review_* columns, and
  // never touches review_status or any deterministic finding — so an
  // outage, timeout, bad response, or missing API key leaves everything
  // above exactly as it is.
  if (deterministicReviewComplete) {
    await runModelReview(reportId, "auto");
  }
}
