import { createClient } from "@/lib/supabase/server";
import { REPORTS_BUCKET } from "@/lib/reports/validation";
import {
  extractDocText,
  type DocEmbeddedReference,
} from "@/lib/extraction/docTextExtractor";
import {
  runSourceWorkbookCheck,
  type SourceCheckOutcome,
  type SourceCheckStore,
  type SourceWorkbookRow,
} from "@/lib/review/source/runSourceCheck";
import { WORKBOOK_BUCKET } from "@/lib/review/source/workbookFile";
import { SourceWorkbookError } from "@/lib/review/source/errors";
import type { PageText } from "@/lib/review/types";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Supabase adapter for the source-workbook check. Runs under the report
 * owner's RLS session, exactly like every other pipeline stage, so no
 * service-role key is involved and ownership is enforced by the database.
 */
function supabaseStore(supabase: SupabaseServerClient): SourceCheckStore {
  return {
    async loadRow(reportId) {
      const { data, error } = await supabase
        .from("report_source_workbooks")
        .select("original_filename, storage_path, workbook_format, check_status")
        .eq("report_id", reportId)
        .maybeSingle();
      if (error) throw error;
      return (data as SourceWorkbookRow | null) ?? null;
    },

    async record(reportId, fields) {
      const { error } = await supabase
        .from("report_source_workbooks")
        .update(fields)
        .eq("report_id", reportId);
      if (error) {
        console.error(`[source-check] Could not record status for ${reportId}:`, error);
      }
    },

    async download(storagePath) {
      const { data, error } = await supabase.storage
        .from(WORKBOOK_BUCKET)
        .download(storagePath);
      if (error || !data) {
        throw new SourceWorkbookError("download_failed", error?.message);
      }
      return data;
    },
  };
}

async function loadDocEmbeddedReferences(
  supabase: SupabaseServerClient,
  reportId: string
): Promise<DocEmbeddedReference[]> {
  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select("storage_path")
    .eq("id", reportId)
    .single();

  if (reportError || !report?.storage_path) {
    return [];
  }

  if (!report.storage_path.toLowerCase().endsWith(".doc")) {
    return [];
  }

  const { data: reportBlob, error: downloadError } = await supabase.storage
    .from(REPORTS_BUCKET)
    .download(report.storage_path);

  if (downloadError || !reportBlob) {
    console.error(
      `[source-check] Could not download .doc report ${reportId} for embedded references:`,
      downloadError
    );
    return [];
  }

  try {
    const buffer = new Uint8Array(await reportBlob.arrayBuffer());
    const { embeddedReferences } = await extractDocText(buffer);
    return embeddedReferences;
  } catch (error) {
    console.error(
      `[source-check] Could not extract .doc references for ${reportId}:`,
      error
    );
    return [];
  }
}


const NONE: SourceCheckOutcome = { status: "none", drafts: [], reason: null };

/** Entry point used by the review pipeline. Never throws. */
export async function runSourceWorkbookCheckForReport(
  reportId: string,
  pages: PageText[]
): Promise<SourceCheckOutcome> {
  let supabase: SupabaseServerClient;

  try {
    supabase = await createClient();
  } catch (error) {
    console.error(
      `[source-check] Could not create a client for ${reportId}:`,
      error
    );
    return NONE;
  }

  const embeddedReferences = await loadDocEmbeddedReferences(
    supabase,
    reportId
  );

  return runSourceWorkbookCheck(
    supabaseStore(supabase),
    reportId,
    pages,
    embeddedReferences
  );
}