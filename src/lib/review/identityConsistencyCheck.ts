import type { PageText, FindingDraft } from "@/lib/review/types";

interface IdentityField {
  key: "client_name" | "property_address" | "effective_date";
  label: string;
  /** Line-anchored: matches a labeled field at the start of a line. */
  pattern: RegExp;
  normalize: (raw: string) => string;
}

function normalizeGeneric(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

const ADDRESS_ABBREVIATIONS: [RegExp, string][] = [
  [/\bstreet\b/g, "st"],
  [/\bavenue\b/g, "ave"],
  [/\broad\b/g, "rd"],
  [/\bdrive\b/g, "dr"],
  [/\bboulevard\b/g, "blvd"],
  [/\bsuite\b/g, "ste"],
  [/\bhighway\b/g, "hwy"],
  [/[.,]/g, ""],
];

function normalizeAddress(raw: string): string {
  let value = normalizeGeneric(raw);
  for (const [pattern, replacement] of ADDRESS_ABBREVIATIONS) {
    value = value.replace(pattern, replacement);
  }
  return value.replace(/\s+/g, " ").trim();
}

const MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december";

function normalizeDate(raw: string): string {
  const value = raw.trim();

  // "Month D, YYYY" or "Month D YYYY" (e.g. "January 5, 2026")
  const longForm = value.match(
    new RegExp(`^(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i")
  );
  if (longForm) {
    const month = longForm[1].toLowerCase();
    const day = longForm[2].padStart(2, "0");
    return `${longForm[3]}-${month}-${day}`;
  }

  // "MM/DD/YYYY" or "M/D/YYYY"
  const slashForm = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashForm) {
    return `${slashForm[3]}-${slashForm[1].padStart(2, "0")}-${slashForm[2].padStart(2, "0")}`;
  }

  // Fall back to generic normalization if the format isn't recognized;
  // this means an unrecognized date format simply won't be compared
  // against other unrecognized formats unless they're textually
  // identical — an honest limitation, not a silent false match.
  return normalizeGeneric(value);
}

const IDENTITY_FIELDS: IdentityField[] = [
  {
    key: "client_name",
    label: "client name",
    pattern: /^(?:client|prepared for|intended user)\s*:\s*(.+)$/im,
    normalize: normalizeGeneric,
  },
  {
    key: "property_address",
    label: "property address",
    pattern:
      /^(?:subject property address|property address|subject property)\s*:\s*(.+)$/im,
    normalize: normalizeAddress,
  },
  {
    key: "effective_date",
    label: "effective date",
    pattern:
      /^(?:effective date of (?:the )?appraisal|effective date of value|date of value|effective date)\s*:\s*(.+)$/im,
    normalize: normalizeDate,
  },
];

const MAX_CAPTURED_VALUE_LENGTH = 120;

interface FieldOccurrence {
  raw: string;
  normalized: string;
  pageNumber: number;
}

/**
 * Runs PRD Section 18 category 1 ("cross-document identity
 * consistency") against a document's extracted text: client name,
 * property address, and effective date are each searched for across
 * every page using known field-label conventions, normalized, and
 * compared. If a field has two or more distinct normalized values
 * anywhere in the document, that's a finding.
 *
 * Deliberately pure and deterministic (PRD Section 14): no AI model
 * is involved in deciding whether values match — comparison is exact,
 * after normalization rules that are fixed and documented above, so
 * the same input always produces the same output (PRD Section 12,
 * "Consistency").
 *
 * Deliberately conservative: a field with zero or one occurrence
 * produces no finding — there is nothing to cross-check, and this
 * check does not attempt to judge whether a field is *missing*
 * (that's Section 18 category 5, model-based, a later phase). This
 * also means reports using field labels/conventions this function
 * doesn't recognize will simply not be checked for that field, rather
 * than producing a false read — an intentional, honestly-scoped
 * limitation given the format diversity risk named in the Company
 * Bible (Section 20/21).
 */
export function checkCrossDocumentIdentityConsistency(
  pages: PageText[]
): FindingDraft[] {
  const findings: FindingDraft[] = [];

  for (const field of IDENTITY_FIELDS) {
    const occurrences: FieldOccurrence[] = [];

    for (const page of pages) {
      const lines = page.text.split("\n");
      for (const line of lines) {
        const match = line.match(field.pattern);
        if (!match) continue;
        const raw = match[1].trim().slice(0, MAX_CAPTURED_VALUE_LENGTH);
        if (!raw) continue;
        occurrences.push({
          raw,
          normalized: field.normalize(raw),
          pageNumber: page.pageNumber,
        });
      }
    }

    const distinctByNormalized = new Map<string, FieldOccurrence[]>();
    for (const occurrence of occurrences) {
      const existing = distinctByNormalized.get(occurrence.normalized);
      if (existing) {
        existing.push(occurrence);
      } else {
        distinctByNormalized.set(occurrence.normalized, [occurrence]);
      }
    }

    if (distinctByNormalized.size < 2) {
      continue;
    }

    // One representative occurrence per distinct value, in first-seen
    // page order, for evidence and location display.
    const representatives = [...distinctByNormalized.values()].map(
      (group) => group[0]
    );
    representatives.sort((a, b) => a.pageNumber - b.pageNumber);

    const evidence = representatives
      .map(
        (occurrence) => `"${occurrence.raw}" (Page ${occurrence.pageNumber})`
      )
      .join(" vs. ");

    const location = [
      ...new Set(representatives.map((o) => `Page ${o.pageNumber}`)),
    ].join(", ");

    findings.push({
      category: "cross_document_identity_consistency",
      severity: "critical",
      description: `The ${field.label} appears inconsistently across the document.`,
      evidence,
      location,
    });
  }

  return findings;
}
