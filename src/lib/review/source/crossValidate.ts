import type { FindingDraft, PageText, SourceReference } from "@/lib/review/types";
import {
  classifyNumberFormat,
  compareFigure,
  formatWorkbookValue,
  type WorkbookFigure,
  type WorkbookValueKind,
} from "@/lib/review/source/figures";
import { linkReportToWorkbook, type LinkedFigure } from "@/lib/review/source/linking";
import type { WorkbookModel } from "@/lib/review/source/workbookModel";
import { evaluateSimpleFormula } from "@/lib/review/source/simpleFormula";
import type { DocEmbeddedReference } from "@/lib/extraction/docTextExtractor";

/**
 * Turns linked figures into findings (pure).
 *
 * Only a MISMATCH on a linked, comparable pair becomes a finding. Matches,
 * scale ambiguities, and incompatible pairs are counted and then dropped, so
 * the report can say how much was checked without inventing issues.
 */

/** Version of this check's rules. Stored per report for auditability. */
export const SOURCE_CHECK_VERSION = "source-workbook-v2";

/**
 * Source-workbook findings are capped at moderate severity until precision
 * is measured on real reports, consistent with the model-based layer
 * (see MODEL_FINDING_SEVERITY in narrativeContradictionCheck.ts).
 */
export const SOURCE_FINDING_SEVERITY = "moderate" as const;

/** A flood of findings would bury the real ones. Extra mismatches are counted, not shown. */
export const MAX_SOURCE_FINDINGS = 25;

const MAX_DISPLAY_CHARS = 120;

export interface SourceCheckStats {
  /** Report figures linked to a workbook cell with a stated correspondence. */
  linked: number;
  /** Linked pairs that agree within the report's rounding. */
  matched: number;
  /** Linked pairs that disagree beyond rounding (all become findings, up to the cap). */
  flagged: number;
  /** Linked pairs that could not be compared (units or format ambiguity). */
  skipped: number;
  /** Candidates dropped before linking because correspondence was ambiguous. */
  ambiguous: number;
}

export interface SourceCheckResult {
  drafts: FindingDraft[];
  stats: SourceCheckStats;
}

function shorten(value: string, max = MAX_DISPLAY_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function workbookFigureOf(link: LinkedFigure, model: WorkbookModel): WorkbookFigure | null {
  const kind = classifyNumberFormat(link.cell.numberFormat) as WorkbookValueKind;
  if (kind === "date" || kind === "text") return null;
  if (typeof link.cell.value !== "number") return null;
  // For a deliberately small safe subset of formulas, independently recompute
  // the result from same-sheet source cells. This catches stale cached totals
  // without pretending Keystone is a full Excel calculation engine.
  const recomputed = evaluateSimpleFormula(link.cell, model);
  return { value: recomputed ?? link.cell.value, kind };
}

function pagesPhrase(pages: number[]): string {
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;
}

function buildDraft(
  link: LinkedFigure,
  workbook: WorkbookFigure,
  fileName: string
): FindingDraft {
  const displayValue = formatWorkbookValue(workbook);
  const linkedBy =
    link.strategy === "defined_name"
      ? `the defined name "${shorten(link.key)}"`
      : link.strategy === "defined_range"
        ? `the defined range "${shorten(link.key)}"`
        : link.strategy === "table_row"
          ? `the Excel table row "${shorten(link.key)}"`
          : `the contextual label "${shorten(link.key)}" (matched in both documents)`;
  const subject =
    link.strategy === "defined_name"
      ? `the defined name "${shorten(link.key)}"`
      : link.header
        ? `"${shorten(link.key)}" / "${shorten(link.header)}"`
        : `"${shorten(link.key)}"`;

  const sourceReference: SourceReference = {
    workbook: shorten(fileName, 200),
    sheet: shorten(link.cell.sheet),
    cell: link.cell.ref,
    definedName: link.definedName ? shorten(link.definedName) : null,
    label: link.label ? shorten(link.label) : null,
    table: link.table ? shorten(link.table) : null,
    formula: link.cell.formula ? shorten(link.cell.formula, 200) : null,
    value: displayValue,
    linkedBy: link.strategy,
    range: link.sourceRange,
    header: link.header,
  };

  return {
    category: "source_workbook_discrepancy",
    severity: SOURCE_FINDING_SEVERITY,
    description: `The report's figure for ${subject} does not match the value in the source workbook.`,
    evidence: `Report: "${link.reportFigure.raw}" (${pagesPhrase(link.reportPages)}). Workbook ${shorten(
      fileName,
      200
    )}, sheet "${shorten(link.cell.sheet)}", cell ${link.cell.ref}: ${displayValue}. Linked by ${linkedBy}.`,
    location: link.reportPages.map((page) => `Page ${page}`).join(", "),
    sourceReference,
  };
}

export function crossValidateWorkbook(input: {
  pages: PageText[];
  model: WorkbookModel;
  fileName: string;
  embeddedReferences?: DocEmbeddedReference[];
}): SourceCheckResult {
  const { links, ambiguous } = linkReportToWorkbook(
    input.pages,
    input.model,
    input.embeddedReferences ?? []
  );

  const stats: SourceCheckStats = {
    linked: links.length,
    matched: 0,
    flagged: 0,
    skipped: 0,
    ambiguous,
  };
  const drafts: FindingDraft[] = [];

  for (const link of links) {
    const workbook = workbookFigureOf(link, input.model);
    if (!workbook) {
      stats.skipped++;
      continue;
    }

    const outcome = compareFigure(link.reportFigure, workbook);
    if (outcome === "match") {
      stats.matched++;
    } else if (outcome === "mismatch") {
      stats.flagged++;
      if (drafts.length < MAX_SOURCE_FINDINGS) {
        drafts.push(buildDraft(link, workbook, input.fileName));
      }
    } else {
      stats.skipped++;
    }
  }

  return { drafts, stats };
}
