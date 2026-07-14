// Shared between client (for immediate UX feedback) and server (for
// the authoritative check). The server check is the one that
// actually matters — the client check only saves the user a round
// trip for an obviously-wrong file.

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
export const ALLOWED_MIME_TYPE = "application/pdf";
export const REPORTS_BUCKET = "reports";

const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function isAllowedFileSize(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}

export function isAllowedMimeType(mimeType: string): boolean {
  return mimeType === ALLOWED_MIME_TYPE;
}

/**
 * Confirms the file's actual bytes start with the PDF magic number.
 * A client-reported MIME type of "application/pdf" is trivial to
 * spoof (it's just a form field) — this checks the real content
 * instead, so a renamed .exe can't pass as a PDF.
 */
export function hasPdfMagicBytes(buffer: Uint8Array): boolean {
  if (buffer.length < PDF_MAGIC_BYTES.length) return false;
  return PDF_MAGIC_BYTES.every((byte, index) => buffer[index] === byte);
}
