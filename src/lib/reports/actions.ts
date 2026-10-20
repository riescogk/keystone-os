"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_FILE_SIZE_BYTES,
  REPORTS_BUCKET,
  isAllowedFileSize,
  isAllowedMimeType,
  reportFormatFromFileName,
  hasValidReportMagicBytes,
  mimeTypeForReportFormat,
} from "@/lib/reports/validation";
import { runTextExtraction } from "@/lib/extraction/runExtraction";
import {
  checkRevisionTarget,
  isUuid,
} from "@/lib/review/comparison/revisionEligibility";
import { checkWorkbookUpload } from "@/lib/review/source/workbookUpload";
import {
  WORKBOOK_BUCKET,
  WORKBOOK_MIME_BY_FORMAT,
  type WorkbookFormat,
} from "@/lib/review/source/workbookFile";

export type ActionResult =
  { success: true } | { success: false; error: string };

/**
 * Uploads a report PDF and creates its database record.
 *
 * Security-critical properties, all enforced here, not on the client:
 * - Ownership (`user_id`) comes ONLY from the server-verified session
 *   (`supabase.auth.getUser()`), never from anything in the FormData.
 * - The storage path is generated server-side from a fresh UUID and
 *   the verified user id — the original filename never touches the
 *   storage path, only the database row (as display metadata).
 * - File type is checked twice: the browser-reported MIME type, and
 *   the actual file bytes (PDF magic number), since the reported type
 *   is just a spoofable form field.
 * - File size is checked against the same limit enforced by the
 *   Storage bucket's own `file_size_limit`, so a mismatch here would
 *   be a bug, not a security gap either way.
 */
export async function uploadReport(formData: FormData): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return {
      success: false,
      error: "You must be logged in to upload a report.",
    };
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { success: false, error: "No file was provided." };
  }

  const reportFormat = reportFormatFromFileName(file.name);

if (!reportFormat || !isAllowedMimeType(file.type)) {
  return {
    success: false,
    error: "Only PDF and Microsoft Word .doc files are supported.",
  };
}

  if (!isAllowedFileSize(file.size)) {
    return {
      success: false,
      error: `File is too large. The limit is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  if (!hasValidReportMagicBytes(buffer, reportFormat)) {
  return {
    success: false,
    error:
      reportFormat === "pdf"
        ? "This file doesn't look like a valid PDF."
        : "This file doesn't look like a valid Microsoft Word .doc file.",
  };
}

  // Phase 13 (PRD FR-5): an upload may be a revised draft of a report
  // the user already had reviewed. Validated BEFORE anything is written
  // to Storage, so a rejected revision can never leave an orphaned
  // file. The previous report is looked up under the caller's own RLS
  // session: someone else's report id arrives as "not found",
  // indistinguishable from one that does not exist.
  const revisesValue = formData.get("revisesReportId");
  const revisesReportId =
    typeof revisesValue === "string" ? revisesValue : null;

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
    return { success: false, error: revision.error };
  }

  // Milestone 14: the OPTIONAL source workbook. Validated here, before any
  // write, so a rejected workbook never leaves an orphaned PDF behind. An
  // empty file input arrives as a zero-byte File and means "no workbook".
  const workbookValue = formData.get("workbook");
  let workbook: {
    file: File;
    format: WorkbookFormat;
    bytes: Uint8Array;
    containsMacros: boolean;
    externalLinkCount: number;
  } | null = null;

  if (workbookValue instanceof File && workbookValue.size > 0) {
    const check = await checkWorkbookUpload(workbookValue);
    if (!check.ok) {
      return { success: false, error: check.message };
    }
    workbook = {
      file: workbookValue,
      format: check.format,
      bytes: check.bytes,
      containsMacros: check.containsMacros,
      externalLinkCount: check.externalLinkCount,
    };
  }

  // Generate the report id ourselves (rather than letting the DB
  // default it) so the same id can be used for the storage path
  // before the row exists.
  const reportId = crypto.randomUUID();
  const storagePath = `${user.id}/${reportId}.${reportFormat}`;
  const workbookPath = workbook
    ? `${user.id}/${reportId}.${workbook.format}`
    : null;

  // Removes everything this request stored. Each removal is a no-op for an
  // object that was never written, so this is safe at every failure point.
  const removeStoredFiles = async () => {
    await supabase.storage.from(REPORTS_BUCKET).remove([storagePath]);
    if (workbookPath) {
      await supabase.storage.from(WORKBOOK_BUCKET).remove([workbookPath]);
    }
  };

  const { error: uploadError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeTypeForReportFormat(reportFormat),
      upsert: false,
    });

if (uploadError) {
  return {
    success: false,
    error: "Upload failed. Please try again.",
  };
}

  if (workbook && workbookPath) {
    const { error: workbookUploadError } = await supabase.storage
      .from(WORKBOOK_BUCKET)
      .upload(workbookPath, workbook.bytes, {
        contentType: WORKBOOK_MIME_BY_FORMAT[workbook.format],
        upsert: false,
      });
    if (workbookUploadError) {
      await removeStoredFiles();
      return {
        success: false,
        error: "Upload failed. Please try again.",
      };
    }
  }

  const { error: insertError } = await supabase.from("reports").insert({
    id: reportId,
    user_id: user.id,
    original_filename: file.name,
    storage_path: storagePath,
    file_size_bytes: file.size,
    // Only sent for a revision, so ordinary uploads are unchanged.
    ...(revision.previousReportId
      ? { previous_report_id: revision.previousReportId }
      : {}),
  });

  if (insertError) {
    // Roll back the orphaned storage objects so a failed upload
    // doesn't silently consume storage with no visible record.
    await removeStoredFiles();
    if (insertError.code === "23505" && revision.previousReportId) {
      // Unique index on previous_report_id: someone (another tab, a
      // double submit) already uploaded this report's revision.
      return {
        success: false,
        error:
          "A revised draft of this report has already been uploaded. Upload your newest revision from the latest draft instead.",
      };
    }
    return {
      success: false,
      error: "Upload failed while saving the report record. Please try again.",
    };
  }

  if (workbook && workbookPath) {
    const { error: workbookInsertError } = await supabase
      .from("report_source_workbooks")
      .insert({
        report_id: reportId,
        user_id: user.id,
        original_filename: workbook.file.name,
        storage_path: workbookPath,
        file_size_bytes: workbook.file.size,
        workbook_format: workbook.format,
        contains_macros: workbook.containsMacros,
        external_link_count: workbook.externalLinkCount,
      });

    if (workbookInsertError) {
      // The report must not exist without the workbook the user attached:
      // undo both the storage objects and the report row.
      await removeStoredFiles();
      await supabase.from("reports").delete().eq("id", reportId);
      return {
        success: false,
        error: "Upload failed while saving the workbook. Please try again.",
      };
    }
  }

  // Schedule text extraction to run after this response is sent, so
  // the upload never waits on it (per Phase 4 requirement). `after()`
  // is the minimal mechanism for this today; a future phase can swap
  // this single call for a real queue/background-job trigger without
  // touching runTextExtraction itself (see its own doc comment).
  after(() => runTextExtraction(reportId));

  revalidatePath("/dashboard");
  return { success: true };
}

/**
 * Returns a short-lived signed URL for a report the caller owns.
 *
 * Ownership is never assumed from the reportId alone: the select
 * against `public.reports` is subject to RLS (auth.uid() = user_id),
 * so a report id belonging to another user simply returns no row,
 * and this function returns an error rather than a URL.
 */
export async function getSignedReportUrl(
  reportId: string
): Promise<{ url: string } | { error: string }> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be logged in." };
  }

  const { data: report, error: fetchError } = await supabase
    .from("reports")
    .select("storage_path")
    .eq("id", reportId)
    .single();

  if (fetchError || !report) {
    return { error: "Report not found." };
  }

  const { data, error: signError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .createSignedUrl(report.storage_path, 60); // 60 seconds

  if (signError || !data) {
    return { error: "Could not generate a link for this report." };
  }

  return { url: data.signedUrl };
}

/**
 * Deletes a report the caller owns: its stored files first (the PDF and,
 * if one was attached, the source workbook), then the database row. If the
 * row delete fails after the files are gone, the user sees an error and can
 * retry — retrying is safe because removing an already-removed Storage
 * object is a no-op, not an error.
 */
export async function deleteReport(reportId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { success: false, error: "You must be logged in." };
  }

  const { data: report, error: fetchError } = await supabase
    .from("reports")
    .select("storage_path")
    .eq("id", reportId)
    .single();

  if (fetchError || !report) {
    return { success: false, error: "Report not found." };
  }

  // Milestone 14: the optional workbook is removed with its report, so
  // deleting a report can never orphan a workbook file.
  const { data: workbook } = await supabase
    .from("report_source_workbooks")
    .select("storage_path")
    .eq("report_id", reportId)
    .maybeSingle();

  if (workbook) {
    const { error: workbookRemoveError } = await supabase.storage
      .from(WORKBOOK_BUCKET)
      .remove([workbook.storage_path]);
    if (workbookRemoveError) {
      return {
        success: false,
        error: "Could not delete the stored file. Please try again.",
      };
    }
  }

  const { error: removeError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .remove([report.storage_path]);

  if (removeError) {
    return {
      success: false,
      error: "Could not delete the stored file. Please try again.",
    };
  }

  const { error: deleteError } = await supabase
    .from("reports")
    .delete()
    .eq("id", reportId);

  if (deleteError) {
    return {
      success: false,
      error:
        "The file was deleted but the record could not be removed. Please try again.",
    };
  }

  revalidatePath("/dashboard");
  return { success: true };
}
