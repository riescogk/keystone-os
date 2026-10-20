"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { REPORTS_BUCKET } from "@/lib/reports/validation";
import { runTextExtraction } from "@/lib/extraction/runExtraction";
import {
  finalizeUpload,
  type FinalizeUploadInput,
} from "@/lib/reports/finalizeUpload";
import { WORKBOOK_BUCKET } from "@/lib/review/source/workbookFile";

export type ActionResult =
  { success: true } | { success: false; error: string };

/**
 * Finalizes a Review upload whose files the browser has already stored
 * directly in the private Storage buckets.
 *
 * The file bytes never pass through this action (Vercel rejects large
 * request bodies with HTTP 413): it receives only the two storage paths and
 * small metadata. Everything authoritative lives in `finalizeUpload`
 * (src/lib/reports/finalizeUpload.ts): ownership and path validation, then
 * downloading the stored objects for the size / magic-byte / workbook-package
 * checks, then the unchanged `reports` / `report_source_workbooks` inserts,
 * cleanup on failure, and the unchanged post-response text extraction.
 *
 * Ownership comes ONLY from the server-verified session, never from the
 * arguments. Runs under the caller's own RLS-scoped session; no service-role
 * key is involved.
 */
export async function finalizeReportUpload(
  input: FinalizeUploadInput
): Promise<ActionResult> {
  const supabase = await createClient();

  return finalizeUpload(supabase, input, {
    // Schedule text extraction to run after this response is sent, so the
    // upload never waits on it (per Phase 4 requirement). `after()` is the
    // minimal mechanism for this today; a future phase can swap this single
    // call for a real queue/background-job trigger without touching
    // runTextExtraction itself (see its own doc comment).
    scheduleExtraction: (reportId) => after(() => runTextExtraction(reportId)),
    revalidateDashboard: () => revalidatePath("/dashboard"),
  });
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
