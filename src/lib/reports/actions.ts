"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPE,
  REPORTS_BUCKET,
  isAllowedFileSize,
  isAllowedMimeType,
  hasPdfMagicBytes,
} from "@/lib/reports/validation";
import { runTextExtraction } from "@/lib/extraction/runExtraction";

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

  if (!isAllowedMimeType(file.type)) {
    return {
      success: false,
      error: "Only PDF files are supported right now.",
    };
  }

  if (!isAllowedFileSize(file.size)) {
    return {
      success: false,
      error: `File is too large. The limit is ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const buffer = new Uint8Array(await file.arrayBuffer());

  if (!hasPdfMagicBytes(buffer)) {
    return {
      success: false,
      error:
        "This file doesn't look like a valid PDF. Please upload an unmodified PDF export.",
    };
  }

  // Generate the report id ourselves (rather than letting the DB
  // default it) so the same id can be used for the storage path
  // before the row exists.
  const reportId = crypto.randomUUID();
  const storagePath = `${user.id}/${reportId}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: ALLOWED_MIME_TYPE,
      upsert: false,
    });

  if (uploadError) {
    return {
      success: false,
      error: "Upload failed. Please try again.",
    };
  }

  const { error: insertError } = await supabase.from("reports").insert({
    id: reportId,
    user_id: user.id,
    original_filename: file.name,
    storage_path: storagePath,
    file_size_bytes: file.size,
  });

  if (insertError) {
    // Roll back the orphaned storage object so a failed upload
    // doesn't silently consume storage with no visible record.
    await supabase.storage.from(REPORTS_BUCKET).remove([storagePath]);
    return {
      success: false,
      error: "Upload failed while saving the report record. Please try again.",
    };
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
 * Deletes a report the caller owns: the Storage object first, then
 * the database row. If the row delete fails after the object is
 * already gone, the user sees an error and can retry — retrying is
 * safe because removing an already-removed Storage object is a no-op,
 * not an error.
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
