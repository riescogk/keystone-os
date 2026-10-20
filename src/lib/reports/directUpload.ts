import type { SupabaseClient } from "@supabase/supabase-js";
import {
  REPORTS_BUCKET,
  mimeTypeForReportFormat,
  reportFormatFromFileName,
} from "@/lib/reports/validation";
import { buildUploadPaths } from "@/lib/reports/uploadPaths";
import {
  WORKBOOK_BUCKET,
  WORKBOOK_MIME_BY_FORMAT,
  workbookFormatFromFileName,
} from "@/lib/review/source/workbookFile";
import type {
  FinalizeResult,
  FinalizeUploadInput,
} from "@/lib/reports/finalizeUpload";

/**
 * Browser side of the Review upload (hotfix for Vercel HTTP 413).
 *
 * The file bytes go straight from the browser to the existing PRIVATE
 * Storage buckets using the caller's own authenticated session (the anon-key
 * browser client; Storage RLS limits writes to `{auth.uid()}/…`). Only a
 * small metadata object is then sent to the finalize Server Action, which
 * re-validates everything from the stored objects.
 *
 * Never imports a service-role key; takes the client as a parameter.
 */

export type DirectUploadResult = FinalizeResult;

export interface DirectUploadParams {
  /** The authenticated browser Supabase client (`createClient()` from lib/supabase/client). */
  supabase: SupabaseClient;
  report: File;
  workbook?: File | null;
  revisesReportId?: string | null;
  /** The Server Action (injected so this module stays framework-free). */
  finalize: (input: FinalizeUploadInput) => Promise<FinalizeResult>;
  /** Injectable for tests; defaults to crypto.randomUUID(). */
  newId?: () => string;
}

const UPLOAD_FAILED = "Upload failed. Please try again.";

/**
 * Uploads the report (and optional workbook) directly, then finalizes.
 *
 * Always resolves (never rejects), so callers can reset their UI in one
 * place. Cleanup rules:
 * - Direct upload fails part-way: objects this call already stored are
 *   removed here (they exist nowhere else yet).
 * - Finalize returns `success: false`: the server has already removed any
 *   objects no row claims, so nothing is removed from the browser.
 * - Finalize throws / the response is lost: the outcome is unknown (the
 *   report may have been created). Nothing is removed. If a report row with
 *   this id is visible to the caller, the upload actually succeeded.
 */
export async function uploadReportDirect(
  params: DirectUploadParams
): Promise<DirectUploadResult> {
  const { supabase, report, workbook, revisesReportId, finalize } = params;

  const reportFormat = reportFormatFromFileName(report.name);
  if (!reportFormat) {
    return {
      success: false,
      error: "Only PDF and Microsoft Word .doc files are supported.",
    };
  }
  if (workbook && !workbookFormatFromFileName(workbook.name)) {
    return {
      success: false,
      error: "The source workbook must be an .xlsx or .xlsm file.",
    };
  }

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

  const reportId = (params.newId ?? (() => crypto.randomUUID()))();
  const paths = buildUploadPaths({
    userId: user.id,
    reportId,
    reportFileName: report.name,
    workbookFileName: workbook?.name ?? null,
  });
  if (!paths) {
    return { success: false, error: UPLOAD_FAILED };
  }

  const stored: Array<{ bucket: string; path: string }> = [];
  const removeStored = async () => {
    for (const object of stored) {
      try {
        await supabase.storage.from(object.bucket).remove([object.path]);
      } catch {
        // Best effort: the server never creates a record for these.
      }
    }
  };

  try {
    // contentType is set explicitly: browsers often report an empty type for
    // .xlsm, and the buckets only accept the exact MIME types in migrations
    // 0003 / 0013.
    const { error: reportError } = await supabase.storage
      .from(REPORTS_BUCKET)
      .upload(paths.reportPath, report, {
        contentType: mimeTypeForReportFormat(reportFormat),
        upsert: false,
      });
    if (reportError) {
      console.error("[review-upload] report upload failed:", reportError);
      return { success: false, error: UPLOAD_FAILED };
    }
    stored.push({ bucket: REPORTS_BUCKET, path: paths.reportPath });

    if (workbook && paths.workbookPath) {
      const workbookFormat = workbookFormatFromFileName(workbook.name)!;
      const { error: workbookError } = await supabase.storage
        .from(WORKBOOK_BUCKET)
        .upload(paths.workbookPath, workbook, {
          contentType: WORKBOOK_MIME_BY_FORMAT[workbookFormat],
          upsert: false,
        });
      if (workbookError) {
        console.error("[review-upload] workbook upload failed:", workbookError);
        await removeStored();
        return { success: false, error: UPLOAD_FAILED };
      }
      stored.push({ bucket: WORKBOOK_BUCKET, path: paths.workbookPath });
    }
  } catch (error) {
    console.error("[review-upload] direct upload threw:", error);
    await removeStored();
    return { success: false, error: UPLOAD_FAILED };
  }

  try {
    return await finalize({
      reportStoragePath: paths.reportPath,
      reportFilename: report.name,
      workbookStoragePath: paths.workbookPath,
      workbookFilename: workbook?.name ?? null,
      revisesReportId: revisesReportId ?? null,
    });
  } catch (error) {
    console.error("[review-upload] finalize call failed:", error);

    // Outcome unknown. Did the report get created anyway (lost response)?
    try {
      const { data } = await supabase
        .from("reports")
        .select("id")
        .eq("id", reportId)
        .maybeSingle();
      if (data) return { success: true };
    } catch {
      // Fall through to the error below.
    }

    // Objects are deliberately NOT removed here: if the request is still
    // running server-side, deleting them could leave a report without its
    // file. They sit in the caller's private folder, and an upload retry
    // uses fresh ids.
    return {
      success: false,
      error:
        "We couldn't confirm the upload. Check your dashboard, and if the report isn't there, please try again.",
    };
  }
}
