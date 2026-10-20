import {
  reportFormatFromFileName,
  type ReportFormat,
} from "@/lib/reports/validation";
import {
  workbookFormatFromFileName,
  type WorkbookFormat,
} from "@/lib/review/source/workbookFile";
import { isUuid } from "@/lib/review/comparison/revisionEligibility";

/**
 * Storage-path rules for direct browser uploads (Review upload hotfix).
 *
 * Both private buckets use ONE path convention, fixed by migrations
 * 0003 and 0013 (their RLS policies check the first path segment):
 *
 *   {user_id}/{report_id}.{pdf|doc}      in "reports"
 *   {user_id}/{report_id}.{xlsx|xlsm}    in "review-workbooks"
 *
 * The browser generates `report_id` and builds the paths; the server never
 * trusts them. It re-parses every path with `parseOwnedStoragePath`, which
 * only accepts a path inside the caller's own folder with exactly this
 * shape. Pure and client-safe: no server-only imports.
 */

export interface ParsedStoragePath<F extends string> {
  userId: string;
  reportId: string;
  format: F;
  path: string;
}

/** Longest original file name accepted (display metadata only). */
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

function parseOwnedPath(
  path: unknown,
  expectedUserId: string
): { reportId: string; extension: string } | null {
  if (typeof path !== "string") return null;

  // Exactly "{user}/{uuid}.{ext}": two segments, no traversal, no extras.
  const match = /^([^/]+)\/([^/.]+)\.([a-z]+)$/.exec(path);
  if (!match) return null;

  const [, folder, reportId, extension] = match;
  if (folder !== expectedUserId) return null;
  if (!isUuid(reportId)) return null;

  return { reportId: reportId.toLowerCase(), extension };
}

/** Parses a report path; null unless it is the caller's own `{uid}/{uuid}.pdf|doc`. */
export function parseOwnedReportPath(
  path: unknown,
  expectedUserId: string
): ParsedStoragePath<ReportFormat> | null {
  const parsed = parseOwnedPath(path, expectedUserId);
  if (!parsed) return null;
  if (parsed.extension !== "pdf" && parsed.extension !== "doc") return null;
  return {
    userId: expectedUserId,
    reportId: parsed.reportId,
    format: parsed.extension,
    path: path as string,
  };
}

/** Parses a workbook path; null unless it is the caller's own `{uid}/{uuid}.xlsx|xlsm`. */
export function parseOwnedWorkbookPath(
  path: unknown,
  expectedUserId: string
): ParsedStoragePath<WorkbookFormat> | null {
  const parsed = parseOwnedPath(path, expectedUserId);
  if (!parsed) return null;
  if (parsed.extension !== "xlsx" && parsed.extension !== "xlsm") return null;
  return {
    userId: expectedUserId,
    reportId: parsed.reportId,
    format: parsed.extension,
    path: path as string,
  };
}

/** A usable original file name: non-empty string within a sane length. */
export function isUsableOriginalFilename(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    name.length <= MAX_ORIGINAL_FILENAME_LENGTH
  );
}

/**
 * Builds the storage paths for one upload from a fresh report id. The report
 * and workbook share the id, so a workbook can never be paired with another
 * report's object.
 */
export function buildUploadPaths(input: {
  userId: string;
  reportId: string;
  reportFileName: string;
  workbookFileName?: string | null;
}): { reportPath: string; workbookPath: string | null } | null {
  const reportFormat = reportFormatFromFileName(input.reportFileName);
  if (!reportFormat) return null;

  let workbookPath: string | null = null;
  if (input.workbookFileName) {
    const workbookFormat = workbookFormatFromFileName(input.workbookFileName);
    if (!workbookFormat) return null;
    workbookPath = `${input.userId}/${input.reportId}.${workbookFormat}`;
  }

  return {
    reportPath: `${input.userId}/${input.reportId}.${reportFormat}`,
    workbookPath,
  };
}
