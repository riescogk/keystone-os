import type {
  FindingCategory,
  FindingSeverity,
  PageText,
  FindingDraft,
} from "@/lib/review/types";

interface LeftoverPattern {
  name: string;
  /** Matched against a single line at a time. */
  pattern: RegExp;
  describe: (matchText: string) => string;
}

const CATEGORY: FindingCategory = "template_leftover_detection";
const SEVERITY: FindingSeverity = "moderate";

/**
 * Ordered most-specific-first: once a line is claimed by an earlier
 * pattern, later patterns skip it, so a single leftover artifact
 * (e.g. "[TBD]") never produces two overlapping findings (one for
 * the bracket, one for the bare "TBD" inside it).
 */
const LEFTOVER_PATTERNS: LeftoverPattern[] = [
  {
    name: "bracketed_instruction",
    pattern:
      /\[(?:insert|enter|fill in|placeholder|tbd|to be determined|xxx+)[^\]]*\]/i,
    describe: (match) =>
      `An unresolved bracketed placeholder was found: ${match}`,
  },
  {
    name: "template_syntax",
    pattern: /\{\{[^}]+\}\}|<<[^>]+>>/,
    describe: (match) =>
      `Unresolved template merge syntax was found in the delivered text: ${match}`,
  },
  {
    name: "lorem_ipsum",
    pattern: /lorem ipsum/i,
    describe: () => `Placeholder "Lorem ipsum" filler text was found.`,
  },
  {
    name: "literal_date_placeholder",
    pattern: /\b(?:MM\/DD\/YYYY|DD\/MM\/YYYY|YYYY-MM-DD)\b/i,
    describe: (match) =>
      `A literal date-format placeholder was found instead of an actual date: "${match}"`,
  },
  {
    name: "masked_number_placeholder",
    pattern: /\bX{3,}\b/,
    describe: (match) =>
      `A masked/placeholder number was found instead of an actual figure: "${match}"`,
  },
  {
    name: "blank_line_run",
    pattern: /_{4,}/,
    describe: () => `An unfilled blank-line template artifact was found.`,
  },
  {
    name: "bare_tbd",
    pattern: /\bto be determined\b|\btbd\b/i,
    describe: (match) => `An unresolved "${match}" placeholder was found.`,
  },
];

const MAX_LOCATION_PAGES = 5;

interface LeftoverOccurrence {
  matchedText: string;
  pageNumber: number;
}

/**
 * Runs PRD Section 18 category 2 ("template leftover detection")
 * against a document's extracted text: scans every line for known
 * unresolved-placeholder conventions (bracketed instructions, template
 * merge syntax, filler text, literal date/number placeholders, blank-
 * line runs, bare "TBD") and produces one finding per distinct
 * leftover value found, listing every page it appears on.
 *
 * Deterministic and pattern-based only, per PRD Section 14 — no
 * language-model judgment is involved in deciding whether something
 * is a leftover artifact. Patterns are applied in priority order per
 * line (most-specific first) so a single artifact is never reported
 * as two separate, overlapping findings.
 */
export function checkTemplateLeftovers(pages: PageText[]): FindingDraft[] {
  const occurrencesByKey = new Map<string, LeftoverOccurrence[]>();
  const patternNameByKey = new Map<string, string>();

  for (const page of pages) {
    const lines = page.text.split("\n");
    for (const line of lines) {
      for (const { name, pattern } of LEFTOVER_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;

        const matchedText = match[0].trim();
        const key = `${name}:${matchedText.toLowerCase()}`;

        const existing = occurrencesByKey.get(key);
        if (existing) {
          existing.push({ matchedText, pageNumber: page.pageNumber });
        } else {
          occurrencesByKey.set(key, [
            { matchedText, pageNumber: page.pageNumber },
          ]);
        }
        patternNameByKey.set(key, name);

        // This line is claimed — don't let a lower-priority pattern
        // also match it.
        break;
      }
    }
  }

  const findings: FindingDraft[] = [];

  for (const [key, occurrences] of occurrencesByKey) {
    const patternName = patternNameByKey.get(key)!;
    const patternDef = LEFTOVER_PATTERNS.find((p) => p.name === patternName)!;

    const pageNumbers = [...new Set(occurrences.map((o) => o.pageNumber))].sort(
      (a, b) => a - b
    );

    const shownPages = pageNumbers.slice(0, MAX_LOCATION_PAGES);
    const remainingCount = pageNumbers.length - shownPages.length;
    const location =
      shownPages.map((p) => `Page ${p}`).join(", ") +
      (remainingCount > 0 ? `, and ${remainingCount} more page(s)` : "");

    findings.push({
      category: CATEGORY,
      severity: SEVERITY,
      description: patternDef.describe(occurrences[0].matchedText),
      evidence: `"${occurrences[0].matchedText}" — found ${occurrences.length} time(s) across the document.`,
      location,
    });
  }

  return findings;
}
