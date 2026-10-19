import type { PageText } from "@/lib/review/types";

/**
 * Deterministic selection of the ONLY report text that may be sent to
 * a model provider for the narrative-to-data contradiction check.
 *
 * Why this exists (privacy + cost, both from the project's own rules):
 * - PRD Section 13 step 1: "the relevant extracted text ... is
 *   assembled for a given check category" — not the whole report.
 * - Company Bible Section 25 (least data necessary) and Section 21
 *   (cost per review): a 100-page report must not be shipped to a
 *   third party when a few short passages answer the question.
 *
 * Selection is plain keyword matching — no model involved — so what
 * leaves the system is predictable, auditable, and capped by
 * constants below.
 */

export type ContradictionCheckType = "condition" | "zoning_hbu";

export interface Passage {
  /** Stable id used in the prompt, e.g. "A1" (condition) or "B2" (zoning/HBU). */
  id: string;
  pageNumber: number;
  /** Whitespace-normalized text; quotes are verified against exactly this string. */
  text: string;
}

export interface SelectedPassages {
  condition: Passage[];
  zoning_hbu: Passage[];
}

/** Lines of context kept on each side of a matching line. */
const CONTEXT_LINES = 1;
const MAX_PASSAGE_CHARS = 500;
export const MAX_PASSAGES_PER_CHECK = 10;
export const MAX_CHARS_PER_CHECK = 5000;
/** A comparison needs at least two statements to compare. */
export const MIN_PASSAGES_TO_COMPARE = 2;

const CHECK_PATTERNS: Record<ContradictionCheckType, RegExp> = {
  condition:
    /\b(?:condition|deferred maintenance|state of repair|physical deterioration|well[- ]maintained|poor repair|dilapidat\w*|functional obsolescence)\b/i,
  zoning_hbu:
    /\b(?:zoning|zoned|zone|highest and best use|legally permissible|permitted use|conforming|nonconforming|non-conforming|variance)\b/i,
};

const ID_PREFIX: Record<ContradictionCheckType, string> = {
  condition: "A",
  zoning_hbu: "B",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Candidate passages for one check, in document order, de-duplicated. */
function collectCandidates(
  pages: PageText[],
  pattern: RegExp
): { pageNumber: number; text: string }[] {
  const candidates: { pageNumber: number; text: string }[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const lines = page.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Merge overlapping context windows around matching lines.
    let windowStart = -1;
    let windowEnd = -1;
    const flush = () => {
      if (windowStart < 0) return;
      const text = normalizeWhitespace(
        lines.slice(windowStart, windowEnd + 1).join(" ")
      ).slice(0, MAX_PASSAGE_CHARS);
      const key = text.toLowerCase();
      if (text && !seen.has(key)) {
        seen.add(key);
        candidates.push({ pageNumber: page.pageNumber, text });
      }
      windowStart = -1;
      windowEnd = -1;
    };

    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      const start = Math.max(0, index - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
      if (windowStart >= 0 && start <= windowEnd + 1) {
        windowEnd = Math.max(windowEnd, end);
      } else {
        flush();
        windowStart = start;
        windowEnd = end;
      }
    });
    flush();
  }

  return candidates;
}

/**
 * If there are more candidates than the cap allows, take an evenly
 * spaced sample across the whole document (deterministically) rather
 * than the first N — a highest-and-best-use conclusion near the end of
 * a report must be as likely to be included as a zoning mention near
 * the start. Then enforce the total character budget.
 */
function applyCaps<T extends { text: string }>(candidates: T[]): T[] {
  let chosen = candidates;
  if (candidates.length > MAX_PASSAGES_PER_CHECK) {
    chosen = Array.from({ length: MAX_PASSAGES_PER_CHECK }, (_, k) => {
      const index = Math.floor(
        (k * candidates.length) / MAX_PASSAGES_PER_CHECK
      );
      return candidates[index];
    });
  }

  const withinBudget: T[] = [];
  let used = 0;
  for (const passage of chosen) {
    if (used + passage.text.length > MAX_CHARS_PER_CHECK) break;
    used += passage.text.length;
    withinBudget.push(passage);
  }
  return withinBudget;
}

export function selectPassages(pages: PageText[]): SelectedPassages {
  const result: SelectedPassages = { condition: [], zoning_hbu: [] };

  (Object.keys(CHECK_PATTERNS) as ContradictionCheckType[]).forEach((check) => {
    const capped = applyCaps(collectCandidates(pages, CHECK_PATTERNS[check]));
    result[check] = capped.map((candidate, index) => ({
      id: `${ID_PREFIX[check]}${index + 1}`,
      pageNumber: candidate.pageNumber,
      text: candidate.text,
    }));
  });

  return result;
}

/** Checks that have enough comparable passages to be worth a model call. */
export function eligibleChecks(
  selected: SelectedPassages
): ContradictionCheckType[] {
  return (Object.keys(selected) as ContradictionCheckType[]).filter(
    (check) => selected[check].length >= MIN_PASSAGES_TO_COMPARE
  );
}
