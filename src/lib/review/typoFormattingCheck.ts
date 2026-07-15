import type {
  FindingCategory,
  FindingSeverity,
  PageText,
  FindingDraft,
} from "@/lib/review/types";

interface FormattingPattern {
  name: string;
  /** Matched against a single line at a time. */
  pattern: RegExp;
  describe: (matchText: string) => string;
}

const CATEGORY: FindingCategory = "typo_and_formatting_inconsistency";
const SEVERITY: FindingSeverity = "low";

/**
 * Deliberately NOT a dictionary-based spellchecker. A generic English
 * wordlist would flag huge numbers of legitimate proper nouns,
 * addresses, legal/financial jargon, and abbreviations that are
 * completely normal in a commercial appraisal report, producing
 * exactly the kind of noisy, unreliable output the Manifesto (0.2)
 * warns against — especially damaging for a category whose whole
 * point is document *credibility*. Instead, this check looks only for
 * patterns that are genuinely reliable, low-noise signals of a real
 * typo regardless of subject matter: an accidentally doubled word, or
 * doubled punctuation that's essentially never intentional (unlike
 * "..." ellipsis, which is excluded).
 */
const FORMATTING_PATTERNS: FormattingPattern[] = [
  {
    name: "doubled_word",
    pattern: /\b(\w+)\s+\1\b/i,
    describe: (match) =>
      `A word appears to be accidentally repeated: "${match}"`,
  },
  {
    name: "doubled_punctuation",
    // Two or more of the same mark in a row (excluding periods, which
    // need ellipsis-aware handling below).
    pattern: /([!?,;:])\1+/,
    describe: (match) => `Repeated punctuation was found: "${match}"`,
  },
  {
    name: "double_period",
    // Exactly two periods — not part of a "..." ellipsis.
    pattern: /(?<!\.)\.\.(?!\.)/,
    describe: () =>
      `A double period ("..") was found where a single period or an ellipsis ("...") was likely intended.`,
  },
];

const MAX_LOCATION_PAGES = 5;

interface FormattingOccurrence {
  matchedText: string;
  pageNumber: number;
}

/**
 * Runs PRD Section 18 category 7 ("typo and formatting inconsistency
 * detection") against a document's extracted text. Low severity by
 * default (PRD Section 19) — these are cosmetic/credibility issues,
 * not value-relevant ones, "included because of its effect on
 * document credibility" (PRD Section 18).
 *
 * Deterministic and pattern-based only (PRD Section 14): no spelling
 * dictionary, no language-model judgment — see the module-level
 * comment on FORMATTING_PATTERNS for why. Patterns are tried
 * most-specific-first per line and a claimed line is skipped by the
 * rest, matching the same anti-duplication approach as
 * templateLeftoverCheck.ts.
 */
export function checkTypoAndFormattingIssues(
  pages: PageText[]
): FindingDraft[] {
  const occurrencesByKey = new Map<string, FormattingOccurrence[]>();
  const patternNameByKey = new Map<string, string>();

  for (const page of pages) {
    const lines = page.text.split("\n");
    for (const line of lines) {
      for (const { name, pattern } of FORMATTING_PATTERNS) {
        const match = line.match(pattern);
        if (!match) continue;

        const matchedText = match[0];
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

        break;
      }
    }
  }

  const findings: FindingDraft[] = [];

  for (const [key, occurrences] of occurrencesByKey) {
    const patternName = patternNameByKey.get(key)!;
    const patternDef = FORMATTING_PATTERNS.find((p) => p.name === patternName)!;

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
