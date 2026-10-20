import {
  hasCompoundFileMagic,
  hasZipMagic,
  isAllowedWorkbookSize,
  MAX_WORKBOOK_BYTES,
  workbookFormatFromFileName,
  workbookRejectionMessage,
  type WorkbookFormat,
} from "@/lib/review/source/workbookFile";
import { SourceWorkbookError, type SourceWorkbookFailureReason } from "@/lib/review/source/errors";
import { openZipArchive } from "@/lib/review/source/zipArchive";
import { inspectWorkbookPackage } from "@/lib/review/source/workbookPackage";

/**
 * Server-side checks on an uploaded workbook, run BEFORE anything is written
 * to Storage (Milestone 14). Authoritative: the browser's checks are only a
 * convenience.
 *
 * What this proves: the bytes are a well-formed OOXML package of the claimed
 * format, not encrypted, within size budgets, with the required parts. It
 * does NOT read any sheet. Deeper problems surface at review time and are
 * recorded without failing the report review.
 */

export type WorkbookUploadCheck =
  | {
      ok: true;
      format: WorkbookFormat;
      bytes: Uint8Array;
      containsMacros: boolean;
      externalLinkCount: number;
    }
  | { ok: false; reason: SourceWorkbookFailureReason; message: string };

function rejected(reason: SourceWorkbookFailureReason): WorkbookUploadCheck {
  return { ok: false, reason, message: workbookRejectionMessage(reason) };
}

export async function checkWorkbookUpload(file: File): Promise<WorkbookUploadCheck> {
  const format = workbookFormatFromFileName(file.name);
  if (!format) {
    return {
      ok: false,
      reason: "unsupported",
      message: "The source workbook must be an .xlsx or .xlsm Excel file.",
    };
  }

  if (!isAllowedWorkbookSize(file.size)) {
    return {
      ok: false,
      reason: "too_large",
      message: `The source workbook is too large. The limit is ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MB.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // A password-protected .xlsx is wrapped in an OLE container, which is not
  // a ZIP. Recognize it so the message can say what to do.
  if (hasCompoundFileMagic(bytes)) return rejected("encrypted");
  if (!hasZipMagic(bytes)) return rejected("unreadable");

  try {
    const archive = openZipArchive(bytes);
    const inspection = inspectWorkbookPackage(archive, format);
    return {
      ok: true,
      format,
      bytes,
      containsMacros: inspection.containsMacros,
      externalLinkCount: inspection.externalLinkCount,
    };
  } catch (error) {
    if (error instanceof SourceWorkbookError) return rejected(error.reason);
    // Truncated or otherwise malformed bytes can surface as range errors from
    // the binary reader. They are still just an unreadable file.
    return rejected("unreadable");
  }
}
