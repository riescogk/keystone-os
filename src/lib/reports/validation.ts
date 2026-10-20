// Shared between client (for immediate UX feedback) and server (for
// the authoritative check). The server check is the one that
// actually matters — the client check only saves the user a round
// trip for an obviously-wrong file.

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export const PDF_MIME_TYPE = "application/pdf";
export const DOC_MIME_TYPE = "application/msword";

export const REPORT_ACCEPT = ".pdf,.doc,application/pdf,application/msword";

export const REPORTS_BUCKET = "reports";

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const DOC_MAGIC_BYTES = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type ReportFormat = "pdf" | "doc";

export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function isAllowedFileSize(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}

export function reportFormatFromFileName(
  fileName: string
): ReportFormat | null {
  const lower = fileName.toLowerCase();

  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".doc")) return "doc";

  return null;
}

export function isAllowedMimeType(mimeType: string): boolean {
  return mimeType === PDF_MIME_TYPE || mimeType === DOC_MIME_TYPE;
}

export function hasPdfMagicBytes(buffer: Uint8Array): boolean {
  if (buffer.length < PDF_MAGIC_BYTES.length) return false;
  return PDF_MAGIC_BYTES.every((byte, index) => buffer[index] === byte);
}

export function hasDocMagicBytes(buffer: Uint8Array): boolean {
  if (buffer.length < DOC_MAGIC_BYTES.length) return false;
  return DOC_MAGIC_BYTES.every((byte, index) => buffer[index] === byte);
}

export function hasValidReportMagicBytes(
  buffer: Uint8Array,
  format: ReportFormat
): boolean {
  return format === "pdf"
    ? hasPdfMagicBytes(buffer)
    : hasDocMagicBytes(buffer);
}

export function mimeTypeForReportFormat(format: ReportFormat): string {
  return format === "pdf" ? PDF_MIME_TYPE : DOC_MIME_TYPE;
}