/**
 * Failure reasons for the optional source-workbook check (Milestone 14).
 *
 * Shared by the client and the server, so this file must stay free of
 * Node-only imports. The reason strings are persisted in
 * report_source_workbooks.check_error, which is constrained by migration
 * 0013 — extend both together.
 */

export type SourceWorkbookFailureReason =
  | "unreadable"
  | "encrypted"
  | "unsupported"
  | "too_large"
  | "format_mismatch"
  | "download_failed"
  | "internal";

/**
 * Thrown by the workbook reader for any problem with the file itself.
 * Callers never let it escape into the report review: it is converted to
 * a recorded `failed` status with one of the reasons above.
 */
export class SourceWorkbookError extends Error {
  readonly reason: SourceWorkbookFailureReason;

  constructor(reason: SourceWorkbookFailureReason, detail?: string) {
    super(detail ?? reason);
    this.name = "SourceWorkbookError";
    this.reason = reason;
  }
}

/** Plain-language explanation shown to the user for a stored failure. */
export const FAILURE_COPY: Record<SourceWorkbookFailureReason, string> = {
  unreadable: "the file could not be read as an Excel workbook",
  encrypted: "the workbook is password-protected or encrypted",
  unsupported:
    "its structure is not supported (for example a legacy .xls file or an unusual layout)",
  too_large: "the workbook is too large or complex to check",
  format_mismatch: "the file extension does not match the file's contents",
  download_failed: "the workbook could not be retrieved from storage",
  internal: "an unexpected error occurred",
};
