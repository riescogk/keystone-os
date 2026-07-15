import { extractText, getDocumentProxy } from "unpdf";

export interface PdfTextExtractionResult {
  pageCount: number;
  /** One entry per page, in document order. */
  pages: string[];
  /** False when every page's extracted text is empty/whitespace-only. */
  hasSelectableText: boolean;
}

/**
 * Extracts text from a PDF, page by page, preserving reading order.
 *
 * Deliberately pure: takes bytes, returns structured text. It does not
 * know about Supabase, report ids, or database rows — that belongs in
 * runExtraction.ts. Keeping this function pure means it can be unit
 * tested directly with a sample PDF buffer, and means a future switch
 * to a different extraction library only requires changes here.
 *
 * "Has selectable text" is a document-level judgment (not per-page):
 * if the PDF has a text layer at all, at least some pages will carry
 * real content even if a few pages are blank/image-only (e.g. a cover
 * page). A PDF is only flagged as needing OCR when NO page anywhere
 * in the document has extractable text — i.e. it's fully scanned.
 */
export async function extractPdfText(
  buffer: Uint8Array
): Promise<PdfTextExtractionResult> {
  const pdf = await getDocumentProxy(buffer);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  // unpdf returns `text` as a single string when mergePages is true and
  // as string[] when false; the `false` branch is what we requested,
  // but we normalize defensively in case that ever changes upstream.
  const pages = Array.isArray(text) ? text : [text];

  const hasSelectableText = pages.some((page) => page.trim().length > 0);

  return {
    pageCount: totalPages,
    pages,
    hasSelectableText,
  };
}

/**
 * Joins per-page text into the single string stored in
 * `reports.extracted_text`, marking page boundaries so page order and
 * page attribution survive being flattened into one column. This
 * format (not a separate per-page table) matches this milestone's
 * scope: text extraction only, no findings/citations yet that would
 * need structured per-page storage.
 */
export function joinPagesForStorage(pages: string[]): string {
  return pages
    .map((pageText, index) => `--- Page ${index + 1} ---\n${pageText.trim()}`)
    .join("\n\n");
}

const PAGE_DELIMITER_PATTERN = /--- Page (\d+) ---\n/g;

/**
 * Inverse of joinPagesForStorage: recovers per-page text (with page
 * numbers) from the single delimited string stored in
 * `reports.extracted_text`. Used by the review pipeline (Phase 5),
 * which needs to know which page a finding's evidence came from.
 *
 * Deliberately tolerant: if the text doesn't contain any recognizable
 * delimiters (e.g. it predates this format, or was hand-edited), the
 * whole string is returned as a single unnumbered "page" rather than
 * throwing, since a review check should degrade gracefully rather
 * than fail outright over a formatting mismatch.
 */
export function splitPagesFromStorage(
  extractedText: string
): { pageNumber: number; text: string }[] {
  const matches = [...extractedText.matchAll(PAGE_DELIMITER_PATTERN)];

  if (matches.length === 0) {
    return [{ pageNumber: 1, text: extractedText.trim() }];
  }

  return matches.map((match, index) => {
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? extractedText.length;
    return {
      pageNumber: Number(match[1]),
      text: extractedText.slice(start, end).trim(),
    };
  });
}
