import type {
  FindingCategory,
  FindingSeverity,
  PageText,
  FindingDraft,
} from "@/lib/review/types";

const CATEGORY: FindingCategory = "missing_supporting_documentation";
const SEVERITY: FindingSeverity = "moderate";

const DOCUMENT_TYPES = "addendum|exhibit|appendix|attachment";

/**
 * A mention like "see Addendum C", "refer to Exhibit B", "as shown in
 * Appendix A", embedded in a sentence — this is what the report
 * *claims* exists, not proof that it does.
 */
const REFERENCE_PATTERN = new RegExp(
  `\\b(?:see|refer to|shown in|attached as|included as|please see)\\s+(${DOCUMENT_TYPES})\\s+([A-Z0-9]{1,3})\\b`,
  "gi"
);

/**
 * A line that *starts* with the document type + label (optionally
 * followed by a colon/dash and a short title) — the closest a flat
 * text extraction can get to detecting an actual section heading,
 * since no layout/formatting metadata survives extraction. A
 * reference sentence like "See Addendum C for details" starts with
 * "See", not "Addendum", so it does not also match this pattern —
 * that separation is what lets the two patterns be told apart.
 */
function buildHeadingPattern(type: string, label: string): RegExp {
  return new RegExp(`^${type}\\s+${label}\\b`, "im");
}

interface ReferenceOccurrence {
  type: string;
  label: string;
  pageNumber: number;
}

/**
 * Runs the deterministic sub-case of PRD Section 18 category 6
 * ("missing supporting documentation references"): finds every
 * in-text reference to a named Addendum/Exhibit/Appendix/Attachment
 * (e.g. "see Addendum C") and checks whether a section actually
 * titled that way appears anywhere in the document. If it never
 * does, that's a finding — PRD Section 19 explicitly gives "an
 * unreferenced addendum" as a Moderate-severity example.
 *
 * Deliberately excludes the category's *inferential* sub-case (PRD
 * Section 18: "a referenced comp not appearing in the grid") — that
 * requires either Excel grid ingestion or model-based judgment,
 * neither of which is available yet (see docs/architecture.md Phase
 * 8 "Scope decision").
 *
 * Deliberately conservative, same philosophy as every prior check: a
 * table-of-contents line naming the addendum is enough to count as
 * "found" (there's no way to distinguish a real section start from a
 * ToC entry without layout metadata), so this only flags references
 * where the label appears *nowhere* else in the document at all —
 * under-flagging rather than risking a false positive.
 */
export function checkMissingSupportingDocumentation(
  pages: PageText[]
): FindingDraft[] {
  const referencesByKey = new Map<string, ReferenceOccurrence[]>();

  for (const page of pages) {
    for (const match of page.text.matchAll(REFERENCE_PATTERN)) {
      const type = match[1].toLowerCase();
      const label = match[2].toUpperCase();
      const key = `${type}:${label}`;

      const existing = referencesByKey.get(key);
      if (existing) {
        existing.push({ type, label, pageNumber: page.pageNumber });
      } else {
        referencesByKey.set(key, [
          { type, label, pageNumber: page.pageNumber },
        ]);
      }
    }
  }

  const findings: FindingDraft[] = [];

  for (const [, occurrences] of referencesByKey) {
    const { type, label } = occurrences[0];
    const headingPattern = buildHeadingPattern(type, label);

    const headingFound = pages.some((page) => headingPattern.test(page.text));
    if (headingFound) {
      continue;
    }

    const referencePages = [
      ...new Set(occurrences.map((o) => o.pageNumber)),
    ].sort((a, b) => a - b);
    const typeLabel = `${type.charAt(0).toUpperCase()}${type.slice(1)} ${label}`;

    findings.push({
      category: CATEGORY,
      severity: SEVERITY,
      description: `${typeLabel} is referenced in the report, but no section titled "${typeLabel}" was found anywhere in the document.`,
      evidence: `Referenced on ${referencePages.map((p) => `Page ${p}`).join(", ")}; no matching "${typeLabel}" section heading was found.`,
      location: referencePages.map((p) => `Page ${p}`).join(", "),
    });
  }

  return findings;
}
