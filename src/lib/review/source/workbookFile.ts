/**
 * Client-safe checks for an uploaded source workbook (Milestone 14).
 *
 * These run in the browser for immediate feedback and again on the server,
 * where they are authoritative. Nothing here parses workbook contents: the
 * server-side package inspection (workbookPackage.ts) does that.
 */

import type { SourceWorkbookFailureReason } from "@/lib/review/source/errors";

export type WorkbookFormat = "xlsx" | "xlsm";

/** Hard cap on the uploaded workbook. Separate from the 25 MB report cap. */
export const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024; // 20 MB

/** Storage bucket for workbooks. Private; see migration 0013. */
export const WORKBOOK_BUCKET = "review-workbooks";

/**
 * The MIME type each format is stored under. These must match the
 * bucket's allowed_mime_types in migration 0013 exactly. `.xlsm` is
 * stored under its macro-enabled type so the bucket can tell the two
 * apart; the bytes are never executed either way.
 */
export const WORKBOOK_MIME_BY_FORMAT: Record<WorkbookFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
};

/** The OOXML content type a valid package declares for its workbook part. */
export const MAIN_CONTENT_TYPE_BY_FORMAT: Record<WorkbookFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
};

export function workbookFormatFromFileName(
  fileName: string
): WorkbookFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx")) return "xlsx";
  if (lower.endsWith(".xlsm")) return "xlsm";
  return null;
}

export function isAllowedWorkbookSize(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_WORKBOOK_BYTES;
}

/** Every .xlsx/.xlsm is a ZIP package: "PK\x03\x04" (or an empty "PK\x05\x06"). */
export function hasZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const isLocal =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isEmpty =
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06;
  return isLocal || isEmpty;
}

/**
 * OLE2 / Compound File magic. Password-protected .xlsx files are stored
 * inside this container, and legacy .xls files use it too. Keystone cannot
 * read either, so detecting it lets us say so plainly.
 */
export function hasCompoundFileMagic(bytes: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** Maps a reason to the message shown when an upload is rejected. */
export function workbookRejectionMessage(
  reason: SourceWorkbookFailureReason
): string {
  switch (reason) {
    case "encrypted":
      return "This workbook is password-protected or encrypted, so Keystone can't read it. Remove the password, save it as .xlsx or .xlsm, and upload it again. You can also upload the report without the workbook.";
    case "format_mismatch":
      return "This file's extension doesn't match its contents. Re-save the workbook as .xlsx or .xlsm and upload it again.";
    case "too_large":
      return "This workbook is too large or complex for Keystone to check. You can upload the report without it.";
    case "unsupported":
      return "This file isn't a supported Excel workbook. Save it as .xlsx or .xlsm (not .xls) and upload it again.";
    case "unreadable":
    default:
      return "This doesn't look like a valid Excel workbook. Re-save it as .xlsx or .xlsm and upload it again.";
  }
}
