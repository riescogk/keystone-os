import { createClient } from "@/lib/supabase/server";
import { REPORTS_BUCKET } from "@/lib/reports/validation";
import {
  extractPdfText,
  joinPagesForStorage,
} from "@/lib/extraction/pdfTextExtractor";
import { EXTRACTION_VERSION } from "@/lib/extraction/types";
import { runReview } from "@/lib/review/runReview";

/**
 * Runs text extraction for a single report and writes the outcome
 * back to its row. On success, also kicks off the review pipeline
 * (Phase 5's runReview), since review can't start until extraction
 * has produced text.
 *
 * This function is intentionally the ONLY place that knows how a
 * report goes from "just uploaded" to "text extracted" — it does not
 * know or care *when* or *how* it gets invoked. Today it's called
 * inline via `after()` in the upload Server Action (see
 * src/lib/reports/actions.ts) so uploads never block on extraction.
 * A future phase can move the trigger to a proper background job
 * (a queue consumer, a Supabase Edge Function, a cron sweep of
 * `pending` rows) by calling this exact function from the new
 * trigger — nothing in here needs to change for that swap.
 *
 * Never throws: every failure path is caught and written to the row
 * as `extraction_status = 'failed'`, because this runs outside the
 * request/response cycle (via `after()`) where there is no caller
 * left to catch or surface a thrown error to.
 */
export async function runTextExtraction(reportId: string): Promise<void> {
  const supabase = await createClient();

  const { data: report, error: fetchError } = await supabase
    .from("reports")
    .select("storage_path, extraction_status")
    .eq("id", reportId)
    .single();

  if (fetchError || !report) {
    console.error(
      `[extraction] Could not load report ${reportId} to extract:`,
      fetchError
    );
    return;
  }

  // Idempotency guard: if this report has already moved past
  // "pending" (e.g. a duplicate trigger, or a retry firing twice),
  // don't redo the work or clobber a result that's already there.
  if (report.extraction_status !== "pending") {
    return;
  }

  const markStatus = async (fields: Record<string, string | number | null>) => {
    const { error } = await supabase
      .from("reports")
      .update(fields)
      .eq("id", reportId);
    if (error) {
      console.error(
        `[extraction] Failed to update status for report ${reportId}:`,
        error
      );
    }
  };

  await markStatus({ extraction_status: "processing" });

  try {
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from(REPORTS_BUCKET)
      .download(report.storage_path);

    if (downloadError || !fileBlob) {
      throw new Error(
        `Storage download failed: ${downloadError?.message ?? "no file returned"}`
      );
    }

    const buffer = new Uint8Array(await fileBlob.arrayBuffer());
    const { pageCount, pages, hasSelectableText } =
      await extractPdfText(buffer);

    if (!hasSelectableText) {
      await markStatus({
        extraction_status: "ocr_required",
        page_count: pageCount,
        extraction_completed_at: new Date().toISOString(),
        extraction_version: EXTRACTION_VERSION,
      });
      return;
    }

    await markStatus({
      extraction_status: "completed",
      extracted_text: joinPagesForStorage(pages),
      page_count: pageCount,
      extraction_completed_at: new Date().toISOString(),
      extraction_version: EXTRACTION_VERSION,
    });

    // Review (Phase 5) has a hard dependency on extracted text, so it
    // runs as the next stage of this same background pipeline rather
    // than needing its own separate trigger. Called directly (not via
    // another after()) since we're already inside the deferred
    // execution scheduled by the upload action's after() call.
    await runReview(reportId);
  } catch (error) {
    console.error(
      `[extraction] Extraction failed for report ${reportId}:`,
      error
    );
    await markStatus({
      extraction_status: "failed",
      extraction_completed_at: new Date().toISOString(),
      extraction_version: EXTRACTION_VERSION,
    });
  }
}
