import { openZipArchive } from "@/lib/review/source/zipArchive";
import { readWorkbookModel } from "@/lib/review/source/workbookModel";
import { crossValidateWorkbook, SOURCE_CHECK_VERSION } from "@/lib/review/source/crossValidate";
import { MAX_WORKBOOK_BYTES, type WorkbookFormat } from "@/lib/review/source/workbookFile";
import { SourceWorkbookError, type SourceWorkbookFailureReason } from "@/lib/review/source/errors";
import type { SourceCheckStatus } from "@/lib/review/provenance";
import type { FindingDraft, PageText } from "@/lib/review/types";
import type { DocEmbeddedReference } from "@/lib/extraction/docTextExtractor";

/**
 * The source-workbook check for one report (Milestone 14), written against
 * an injected STORE so the failure rules can be tested without a database.
 * The Supabase adapter lives in sourceCheckEntry.ts.
 *
 * ISOLATION GUARANTEE: this function never throws, and its failures never
 * change the report's review_status. Every problem with the workbook — missing
 * from storage, corrupt, encrypted, too large, unexpected — is recorded through
 * the store and reported to the user, and the report review continues with no
 * workbook findings. A failed check is never presented as a passed one.
 */

export interface SourceWorkbookRow {
  original_filename: string;
  storage_path: string;
  workbook_format: string;
  check_status: string;
}

export interface SourceCheckStore {
  /** Returns the workbook row for a report, or null. Throws on a database error. */
  loadRow(reportId: string): Promise<SourceWorkbookRow | null>;
  /** Writes check-lifecycle fields. Must not throw; log internally on failure. */
  record(reportId: string, fields: Record<string, string | number | boolean | null>): Promise<void>;
  /** Returns the stored workbook bytes. Throws SourceWorkbookError("download_failed") on failure. */
  download(storagePath: string): Promise<Blob>;
}

export interface SourceCheckOutcome {
  status: SourceCheckStatus;
  drafts: FindingDraft[];
  reason: SourceWorkbookFailureReason | null;
}

const NONE: SourceCheckOutcome = { status: "none", drafts: [], reason: null };

export async function runSourceWorkbookCheck(
  store: SourceCheckStore,
  reportId: string,
  pages: PageText[],
  embeddedReferences: DocEmbeddedReference[] = []
): Promise<SourceCheckOutcome> {
  let row: SourceWorkbookRow | null;
  try {
    row = await store.loadRow(reportId);
  } catch (error) {
    console.error(`[source-check] Could not load workbook row for ${reportId}:`, error);
    return NONE;
  }
  if (!row) return NONE;

  // Idempotency: a finished check is never re-run. A row still "processing"
  // was left behind by an interrupted run, so it is recorded as failed rather
  // than left looking like it is still going.
  if (row.check_status !== "pending") {
    if (row.check_status === "processing") {
      await store.record(reportId, { check_status: "failed", check_error: "internal" });
      return { status: "failed", drafts: [], reason: "internal" };
    }
    return { status: row.check_status as SourceCheckStatus, drafts: [], reason: null };
  }

  await store.record(reportId, { check_status: "processing" });

  try {
    const blob = await store.download(row.storage_path);
    if (blob.size > MAX_WORKBOOK_BYTES) {
      throw new SourceWorkbookError("too_large", "stored workbook exceeds the size limit");
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const archive = openZipArchive(bytes);
    const model = readWorkbookModel(archive, row.workbook_format as WorkbookFormat);
    const result = crossValidateWorkbook({
  pages,
  model,
  fileName: row.original_filename,
  embeddedReferences,
});

    await store.record(reportId, {
      check_status: "complete",
      check_error: null,
      check_version: SOURCE_CHECK_VERSION,
      checked_at: new Date().toISOString(),
      sheet_count: model.sheets.length,
      linked_figure_count: result.stats.linked,
      matched_figure_count: result.stats.matched,
      flagged_figure_count: result.stats.flagged,
      ambiguous_count: result.stats.ambiguous,
    });

    console.info("[source-check] Finished:", {
      reportId,
      sheets: model.sheets.length,
      stats: result.stats,
    });
    return { status: "complete", drafts: result.drafts, reason: null };
  } catch (error) {
    const reason: SourceWorkbookFailureReason =
      error instanceof SourceWorkbookError ? error.reason : "internal";
    if (reason === "internal") {
      console.error(`[source-check] Unexpected failure for ${reportId}:`, error);
    } else {
      console.info(`[source-check] Workbook not checked (${reason}) for ${reportId}.`);
    }
    await store.record(reportId, {
      check_status: "failed",
      check_error: reason,
      checked_at: new Date().toISOString(),
      check_version: SOURCE_CHECK_VERSION,
    });
    return { status: "failed", drafts: [], reason };
  }
}
