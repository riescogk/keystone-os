import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_FILE_SIZE_BYTES,
  REPORTS_BUCKET,
  hasValidReportMagicBytes,
  isAllowedFileSize,
  reportFormatFromFileName,
} from "@/lib/reports/validation";
import {
  isUsableOriginalFilename,
  parseOwnedReportPath,
  parseOwnedWorkbookPath,
} from "@/lib/reports/uploadPaths";
import {
  checkRevisionTarget,
  isUuid,
} from "@/lib/review/comparison/revisionEligibility";
import { checkWorkbookUpload } from "@/lib/review/source/workbookUpload";
import {
  WORKBOOK_BUCKET,
  workbookRejectionMessage,
  type WorkbookFormat,
} from "@/lib/review/source/workbookFile";

/**
 * Finalizes a Review upload whose files the browser has ALREADY stored
 * directly in the private Storage buckets (Review upload hotfix: the file
 * bytes no longer pass through Vercel, which rejects large request bodies
 * with HTTP 413).
 *
 * This function receives only small metadata and the two storage paths. It is
 * the authoritative gate, exactly as the old FormData action was:
 *
 * - Ownership comes ONLY from the server-verified session. A path is accepted
 *   only if it is `{caller's user id}/{uuid}.{ext}` in the right bucket; any
 *   other shape, folder, or extension is rejected. Storage RLS (folder =
 *   auth.uid()) backs this up, since every read/remove below runs under the
 *   caller's own session, never a service-role key.
 * - The objects are downloaded from private Storage and validated here with
 *   the same checks as before: size limit, report magic bytes, and
 *   `checkWorkbookUpload` for the workbook package (never executes macros,
 *   never follows external links). The sizes stored in the database are the
 *   real object sizes, not client-claimed ones.
 * - Nothing is written to the database until everything has validated.
 * - On ANY failure after the files were stored, objects that no database row
 *   claims are removed. While a `reports` row with the same id exists (another
 *   finalize of the same upload won the insert and may still be finalizing),
 *   a failing request never removes the workbook object or the object that
 *   row owns, so a replayed, double-submitted or simultaneous finalize cannot
 *   delete a real report's files.
 *
 * Kept free of Next.js imports (the Server Action wrapper in actions.ts
 * supplies `after()` and `revalidatePath` as hooks) so it is unit-testable.
 */

export type FinalizeResult =
  { success: true } | { success: false; error: string };

export interface FinalizeUploadInput {
  /** `{user_id}/{report_id}.pdf|doc` in the reports bucket. */
  reportStoragePath: string;
  /** Display metadata only; its extension must match the path's. */
  reportFilename: string;
  /** `{user_id}/{report_id}.xlsx|xlsm` in review-workbooks; omit for none. */
  workbookStoragePath?: string | null;
  workbookFilename?: string | null;
  /** Previous report id when this upload is a revised draft. */
  revisesReportId?: string | null;
}

export interface FinalizeUploadHooks {
  /** Schedules the existing text extraction (`after(() => runTextExtraction(id))`). */
  scheduleExtraction: (reportId: string) => void;
  /** Revalidates /dashboard. */
  revalidateDashboard: () => void;
}

const FAILED_GENERIC = "Upload failed. Please try again.";

function fail(error: string): FinalizeResult {
  return { success: false, error };
}

async function downloadObject(
  supabase: SupabaseClient,
  bucket: string,
  path: string
): Promise<Blob | null> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;
  return data;
}

export async function finalizeUpload(
  supabase: SupabaseClient,
  rawInput: FinalizeUploadInput,
  hooks: FinalizeUploadHooks
): Promise<FinalizeResult> {
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return fail("You must be logged in to upload a report.");
  }

  // Server Action arguments are untrusted JSON: check shapes before use.
  const input: Partial<FinalizeUploadInput> =
    rawInput && typeof rawInput === "object" ? rawInput : {};

  const reportPath = parseOwnedReportPath(input.reportStoragePath, user.id);
  const hasWorkbookPath =
    input.workbookStoragePath !== undefined &&
    input.workbookStoragePath !== null &&
    input.workbookStoragePath !== "";
  const workbookPath = hasWorkbookPath
    ? parseOwnedWorkbookPath(input.workbookStoragePath, user.id)
    : null;

  // Objects this request may remove if it fails: only well-formed paths
  // inside the caller's own folder. Anything else is never touched.
  const owned: Array<
    | { bucket: typeof REPORTS_BUCKET; table: "reports"; path: string }
    | {
        bucket: typeof WORKBOOK_BUCKET;
        table: "report_source_workbooks";
        path: string;
      }
  > = [];
  if (reportPath) {
    owned.push({
      bucket: REPORTS_BUCKET,
      table: "reports",
      path: reportPath.path,
    });
  }
  if (workbookPath) {
    owned.push({
      bucket: WORKBOOK_BUCKET,
      table: "report_source_workbooks",
      path: workbookPath.path,
    });
  }

  // Removes the owned objects this request may safely delete. The report id
  // is the claim: it is the primary key of `reports`, and every storage path
  // embeds it, so a `reports` row with this id means ANOTHER finalize of the
  // same upload won the insert and may still be mid-way (its report row is
  // written before its workbook row, so for a moment nothing claims the
  // workbook object by path). While such a row exists this request:
  //   - never removes the workbook object, and
  //   - removes the report object only if the row does not own that path.
  // With no row for the id there is no winner, and unclaimed objects are
  // removed as before. If the check itself errors, nothing is removed (an
  // orphan in the caller's private folder is safer than deleting a real
  // report's file). The request that wins the insert and later rolls back
  // deletes its own row first, so its own cleanup still removes everything.
  const claimId = reportPath?.reportId ?? workbookPath?.reportId ?? null;
  const removeUnclaimedObjects = async () => {
    if (owned.length === 0 || !claimId) return;
    const { data: claim, error: claimError } = await supabase
      .from("reports")
      .select("storage_path")
      .eq("id", claimId)
      .limit(1);
    if (claimError) return;
    const winner = claim?.[0] ?? null;

    for (const object of owned) {
      if (winner) {
        if (object.table === "report_source_workbooks") continue;
        if (winner.storage_path === object.path) continue;
      }
      await supabase.storage.from(object.bucket).remove([object.path]);
    }
  };

  const reject = async (message: string): Promise<FinalizeResult> => {
    await removeUnclaimedObjects();
    return fail(message);
  };

  // ---- Paths and names -------------------------------------------------
  if (!reportPath || (hasWorkbookPath && !workbookPath)) {
    return reject("The upload could not be verified. Please try again.");
  }

  if (!isUsableOriginalFilename(input.reportFilename)) {
    return reject("The upload could not be verified. Please try again.");
  }
  const reportFilename = input.reportFilename;

  if (reportFormatFromFileName(reportFilename) !== reportPath.format) {
    return reject("Only PDF and Microsoft Word .doc files are supported.");
  }

  let workbookFilename: string | null = null;
  if (workbookPath) {
    if (!isUsableOriginalFilename(input.workbookFilename)) {
      return reject("The upload could not be verified. Please try again.");
    }
    workbookFilename = input.workbookFilename;
    // The workbook must belong to THIS report: same id, so it can never be
    // paired with some other upload's object.
    if (workbookPath.reportId !== reportPath.reportId) {
      return reject("The upload could not be verified. Please try again.");
    }
  }

  const reportId = reportPath.reportId;

  // A report with this id already exists (replayed or double-submitted
  // finalize): nothing to create. Objects it claims are left untouched.
  const { data: existing, error: existingError } = await supabase
    .from("reports")
    .select("id")
    .eq("id", reportId)
    .limit(1);
  if (existingError) {
    return reject(FAILED_GENERIC);
  }
  if ((existing?.length ?? 0) > 0) {
    return reject("This upload has already been submitted.");
  }

  // ---- Report: authoritative validation of the stored object ----------
  const reportBlob = await downloadObject(
    supabase,
    REPORTS_BUCKET,
    reportPath.path
  );
  if (!reportBlob) {
    return reject(
      "The uploaded report could not be found. Please upload it again."
    );
  }

  if (!isAllowedFileSize(reportBlob.size)) {
    return reject(
      reportBlob.size === 0
        ? "The uploaded report is empty."
        : `File is too large. The limit is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`
    );
  }

  // Only the signature bytes are needed for the magic-number check.
  const head = new Uint8Array(await reportBlob.slice(0, 16).arrayBuffer());
  if (!hasValidReportMagicBytes(head, reportPath.format)) {
    return reject(
      reportPath.format === "pdf"
        ? "This file doesn't look like a valid PDF."
        : "This file doesn't look like a valid Microsoft Word .doc file."
    );
  }

  // ---- Revision (PRD FR-5): same rules and RLS-scoped lookups as before --
  const revisesReportId =
    typeof input.revisesReportId === "string" ? input.revisesReportId : null;

  let target: { review_status: string; extraction_status: string } | null =
    null;
  let alreadyRevised = false;

  if (revisesReportId?.trim() && isUuid(revisesReportId.trim())) {
    const { data: previous } = await supabase
      .from("reports")
      .select("review_status, extraction_status")
      .eq("id", revisesReportId.trim())
      .maybeSingle();
    target = previous ?? null;

    if (target) {
      const { data: existingRevision } = await supabase
        .from("reports")
        .select("id")
        .eq("previous_report_id", revisesReportId.trim())
        .limit(1);
      alreadyRevised = (existingRevision?.length ?? 0) > 0;
    }
  }

  const revision = checkRevisionTarget({
    revisesReportId,
    target,
    alreadyRevised,
  });
  if (!revision.ok) {
    return reject(revision.error);
  }

  // ---- Optional workbook: same authoritative package check as before ----
  let workbook: {
    format: WorkbookFormat;
    sizeBytes: number;
    containsMacros: boolean;
    externalLinkCount: number;
  } | null = null;

  if (workbookPath && workbookFilename) {
    const workbookBlob = await downloadObject(
      supabase,
      WORKBOOK_BUCKET,
      workbookPath.path
    );
    if (!workbookBlob) {
      return reject(
        "The uploaded workbook could not be found. Please upload it again."
      );
    }
    if (workbookBlob.size === 0) {
      return reject(workbookRejectionMessage("unreadable"));
    }

    const check = await checkWorkbookUpload(
      new File([workbookBlob], workbookFilename)
    );
    if (!check.ok) {
      return reject(check.message);
    }
    // The stored object's extension (its path) and the name the package was
    // checked under must agree on the format.
    if (check.format !== workbookPath.format) {
      return reject(workbookRejectionMessage("format_mismatch"));
    }

    workbook = {
      format: check.format,
      sizeBytes: check.bytes.length,
      containsMacros: check.containsMacros,
      externalLinkCount: check.externalLinkCount,
    };
  }

  // ---- Database records (unchanged behavior) ---------------------------
  const { error: insertError } = await supabase.from("reports").insert({
    id: reportId,
    user_id: user.id,
    original_filename: reportFilename,
    storage_path: reportPath.path,
    file_size_bytes: reportBlob.size,
    // Only sent for a revision, so ordinary uploads are unchanged.
    ...(revision.previousReportId
      ? { previous_report_id: revision.previousReportId }
      : {}),
  });

  if (insertError) {
    // Removes only objects no row claims, so a concurrent duplicate finalize
    // that lost the race for this id never deletes the winner's files.
    await removeUnclaimedObjects();
    if (insertError.code === "23505" && revision.previousReportId) {
      return fail(
        "A revised draft of this report has already been uploaded. Upload your newest revision from the latest draft instead."
      );
    }
    return fail(
      "Upload failed while saving the report record. Please try again."
    );
  }

  if (workbook && workbookPath && workbookFilename) {
    const { error: workbookInsertError } = await supabase
      .from("report_source_workbooks")
      .insert({
        report_id: reportId,
        user_id: user.id,
        original_filename: workbookFilename,
        storage_path: workbookPath.path,
        file_size_bytes: workbook.sizeBytes,
        workbook_format: workbook.format,
        contains_macros: workbook.containsMacros,
        external_link_count: workbook.externalLinkCount,
      });

    if (workbookInsertError) {
      // The report must not exist without the workbook the user attached:
      // undo the report row (it is ours, just inserted), then the objects.
      await supabase.from("reports").delete().eq("id", reportId);
      await removeUnclaimedObjects();
      return fail("Upload failed while saving the workbook. Please try again.");
    }
  }

  // The existing pipeline, unchanged: extraction runs after the response.
  hooks.scheduleExtraction(reportId);
  hooks.revalidateDashboard();
  return { success: true };
}
