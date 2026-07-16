import type {
  FindingCategory,
  FindingSeverity,
  PageText,
  FindingDraft,
} from "@/lib/review/types";

const CATEGORY: FindingCategory = "internal_arithmetic_verification";
const SEVERITY: FindingSeverity = "critical";

interface LabeledFigure {
  key: "pgi" | "vcl" | "egi" | "opex" | "noi" | "capRate" | "indicatedValue";
  label: string;
  pattern: RegExp;
  isPercent?: boolean;
}

/**
 * Canonical Income Approach line items, matched line-anchored (same
 * convention as identityConsistencyCheck.ts). Deliberately restricted
 * to this one well-defined, narrowly-scoped calculation chain — see
 * the module-level comment below for why grid adjustment totals and
 * reconciliation weighting are NOT attempted here.
 */
const LABELED_FIGURES: LabeledFigure[] = [
  {
    key: "pgi",
    label: "Potential Gross Income",
    pattern:
      /^(?:potential gross income|gross potential income)\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  },
  {
    key: "vcl",
    label: "Vacancy and Collection Loss",
    pattern:
      /^(?:vacancy (?:and|&|\/) collection loss|vacancy loss|vacancy (?:and|&) credit loss)\s*:?\s*\(?\$?\s*([\d,]+(?:\.\d+)?)\)?/i,
  },
  {
    key: "egi",
    label: "Effective Gross Income",
    pattern: /^effective gross income\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  },
  {
    key: "opex",
    label: "Total Operating Expenses",
    pattern:
      /^(?:total operating expenses|operating expenses)\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  },
  {
    key: "noi",
    label: "Net Operating Income",
    pattern: /^net operating income\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  },
  {
    key: "capRate",
    label: "Capitalization Rate",
    pattern:
      /^(?:overall capitalization rate|capitalization rate|cap rate|overall rate)\s*:?\s*([\d]+(?:\.\d+)?)\s*%/i,
    isPercent: true,
  },
  {
    key: "indicatedValue",
    label: "Indicated Value",
    pattern:
      /^(?:indicated value(?:\s+by\s+income\s+capitalization)?|value indication(?:\s+by\s+income\s+capitalization)?|indicated value by the income approach)\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  },
];

interface FoundFigure {
  value: number;
  pageNumber: number;
}

function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function formatMoney(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * $500 or 1% of the expected figure, whichever is larger. Real
 * appraisal reports round intermediate numbers, so an exact-equality
 * check would produce constant false positives; this tolerance is
 * generous enough to absorb normal rounding while still catching a
 * genuine, material error (PRD Section 19: "arithmetic errors
 * affecting a stated value-relevant figure" are Critical precisely
 * because they're material, not because they're off by a dollar).
 */
function isWithinTolerance(actual: number, expected: number): boolean {
  const tolerance = Math.max(500, Math.abs(expected) * 0.01);
  return Math.abs(actual - expected) <= tolerance;
}

function findFirstOccurrence(
  pages: PageText[],
  figure: LabeledFigure
): FoundFigure | null {
  for (const page of pages) {
    for (const line of page.text.split("\n")) {
      const match = line.match(figure.pattern);
      if (match) {
        return { value: parseNumber(match[1]), pageNumber: page.pageNumber };
      }
    }
  }
  return null;
}

/**
 * Runs the PDF-text-only sub-case of PRD Section 18 category 3
 * ("internal arithmetic verification"): recalculates the standard
 * Income Approach chain — Effective Gross Income (PGI − vacancy/
 * collection loss), Net Operating Income (EGI − operating expenses),
 * and Indicated Value (NOI ÷ cap rate) — against what the report
 * itself states, using only figures the PDF's own extracted text
 * already contains. No Excel file is required or used.
 *
 * Deliberately scoped to this one calculation chain and nothing more:
 * - Sales-comparison grid adjustment totals and reconciliation
 *   weighting are NOT attempted. The Company Bible names financial-
 *   grid parsing fidelity from PDF text as the single hardest
 *   technical problem in the product (CRE reports frequently embed
 *   these grids as images or complex multi-column tables that flat
 *   text extraction cannot reliably reconstruct into rows/columns).
 *   The Income Approach chain above is different: appraisers commonly
 *   state it as a simple labeled narrative sequence (one figure per
 *   line), which is reliably recoverable from flat text — that
 *   reliability difference is exactly why this chain was chosen and
 *   the grid math was not.
 * - Reconciliation (weighting the three approaches into a final value
 *   conclusion) is a professional judgment call, not a sum — nothing
 *   here checks it, nor claims to.
 * - Only the FIRST occurrence of each labeled figure is used. Reports
 *   with more than one Income Approach section (rare) or that don't
 *   use the income approach at all (common) simply produce no
 *   finding for a step whose inputs aren't both present — this check
 *   never guesses at figures it can't find.
 */
export function checkArithmeticVerification(pages: PageText[]): FindingDraft[] {
  const found = new Map<LabeledFigure["key"], FoundFigure>();
  for (const figure of LABELED_FIGURES) {
    const occurrence = findFirstOccurrence(pages, figure);
    if (occurrence) {
      found.set(figure.key, occurrence);
    }
  }

  const findings: FindingDraft[] = [];

  const pgi = found.get("pgi");
  const vcl = found.get("vcl");
  const egi = found.get("egi");
  const opex = found.get("opex");
  const noi = found.get("noi");
  const capRate = found.get("capRate");
  const indicatedValue = found.get("indicatedValue");

  if (pgi && vcl && egi) {
    const expectedEgi = pgi.value - vcl.value;
    if (!isWithinTolerance(egi.value, expectedEgi)) {
      findings.push({
        category: CATEGORY,
        severity: SEVERITY,
        description: `Effective Gross Income does not match Potential Gross Income minus Vacancy and Collection Loss.`,
        evidence: `Stated Effective Gross Income: ${formatMoney(egi.value)} (Page ${egi.pageNumber}). Potential Gross Income (${formatMoney(pgi.value)}, Page ${pgi.pageNumber}) minus Vacancy and Collection Loss (${formatMoney(vcl.value)}, Page ${vcl.pageNumber}) equals ${formatMoney(expectedEgi)} — a difference of ${formatMoney(Math.abs(egi.value - expectedEgi))}.`,
        location: [...new Set([pgi.pageNumber, vcl.pageNumber, egi.pageNumber])]
          .sort((a, b) => a - b)
          .map((p) => `Page ${p}`)
          .join(", "),
      });
    }
  }

  if (egi && opex && noi) {
    const expectedNoi = egi.value - opex.value;
    if (!isWithinTolerance(noi.value, expectedNoi)) {
      findings.push({
        category: CATEGORY,
        severity: SEVERITY,
        description: `Net Operating Income does not match Effective Gross Income minus Total Operating Expenses.`,
        evidence: `Stated Net Operating Income: ${formatMoney(noi.value)} (Page ${noi.pageNumber}). Effective Gross Income (${formatMoney(egi.value)}, Page ${egi.pageNumber}) minus Total Operating Expenses (${formatMoney(opex.value)}, Page ${opex.pageNumber}) equals ${formatMoney(expectedNoi)} — a difference of ${formatMoney(Math.abs(noi.value - expectedNoi))}.`,
        location: [
          ...new Set([egi.pageNumber, opex.pageNumber, noi.pageNumber]),
        ]
          .sort((a, b) => a - b)
          .map((p) => `Page ${p}`)
          .join(", "),
      });
    }
  }

  if (noi && capRate && indicatedValue && capRate.value > 0) {
    const expectedValue = noi.value / (capRate.value / 100);
    if (!isWithinTolerance(indicatedValue.value, expectedValue)) {
      findings.push({
        category: CATEGORY,
        severity: SEVERITY,
        description: `The Indicated Value does not match Net Operating Income divided by the stated Capitalization Rate.`,
        evidence: `Stated Indicated Value: ${formatMoney(indicatedValue.value)} (Page ${indicatedValue.pageNumber}). Net Operating Income (${formatMoney(noi.value)}, Page ${noi.pageNumber}) divided by the Capitalization Rate (${capRate.value}%, Page ${capRate.pageNumber}) equals ${formatMoney(expectedValue)} — a difference of ${formatMoney(Math.abs(indicatedValue.value - expectedValue))}.`,
        location: [
          ...new Set([
            noi.pageNumber,
            capRate.pageNumber,
            indicatedValue.pageNumber,
          ]),
        ]
          .sort((a, b) => a - b)
          .map((p) => `Page ${p}`)
          .join(", "),
      });
    }
  }

  return findings;
}
