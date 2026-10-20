import type { PageText } from "@/lib/review/types";
import {
  parseFigureAt,
  classifyNumberFormat,
  compareFigure,
  type ReportFigure,
} from "@/lib/review/source/figures";
import { rangeReference, type CellRange } from "@/lib/review/source/cellRef";
import type { CellRecord, WorkbookModel } from "@/lib/review/source/workbookModel";
import type { DocEmbeddedReference } from "@/lib/extraction/docTextExtractor";

/**
 * Conservative report -> workbook correspondence. Strongest evidence wins:
 *   1. explicit defined-name identifiers (single cells OR bounded ranges),
 *   2. Excel table/row labels with header-aware ordered figures,
 *   3. unique contextual labels with one or more nearby figures.
 *
 * No value-only matching is performed. A number appearing in both files is
 * never evidence by itself.
 */
export const MAX_LABEL_CANDIDATES = 2500;
export const MAX_RANGE_LINK_CELLS = 64;
export const MAX_ROW_FIGURES = 12;

export type LinkStrategy = "defined_name" | "defined_range" | "table_row" | "context_label";

export interface LinkedFigure {
  strategy: LinkStrategy;
  key: string;
  reportFigure: ReportFigure;
  reportPages: number[];
  cell: CellRecord;
  definedName: string | null;
  label: string | null;
  table: string | null;
  /** Range that established the relationship, if broader than one cell. */
  sourceRange: string | null;
  /** Column/header context when a row contains several figures. */
  header: string | null;
}

export interface LinkingResult { links: LinkedFigure[]; ambiguous: number }

const DEFINED_NAME_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]{3,}$/;
const LOOKS_LIKE_CELL_REFERENCE = /^[A-Za-z]{1,3}\d+$/;
const NAME_SEPARATOR = /^[ \t\]\)\}»"'’:=|\-–—]{0,8}/;
const LABEL_SEPARATOR = /^[ \t.:\-–—|]{0,60}/;

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normalizeLabel(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function cellKey(cell: CellRecord): string { return `${cell.sheet}!${cell.row},${cell.col}`; }
function isLinkableCell(cell: CellRecord | undefined): cell is CellRecord {
  if (!cell) return false;
  return cell.type === "number" && typeof cell.value === "number" && !cell.uncached && !cell.externalFormula &&
    classifyNumberFormat(cell.numberFormat) !== "date" && classifyNumberFormat(cell.numberFormat) !== "text";
}
function sameFigure(a: ReportFigure, b: ReportFigure): boolean { return a.kind === b.kind && Math.abs(a.value - b.value) < 1e-9; }

function figuresOnLine(text: string, start: number, max = MAX_ROW_FIGURES): ReportFigure[] {
  const end = text.indexOf("\n", start);
  const stop = end === -1 ? text.length : end;
  const figures: ReportFigure[] = [];
  let cursor = start;
  while (cursor < stop && figures.length < max) {
    const parsed = parseFigureAt(text, cursor);
    if (parsed.ok) { figures.push(parsed.figure); cursor = parsed.end; continue; }
    cursor++;
  }
  return figures;
}

function cellsInRange(model: WorkbookModel, sheet: string, range: CellRange): CellRecord[] {
  const target = model.sheets.find((s) => s.name === sheet);
  if (!target) return [];
  return target.cells
    .filter((c) => c.row >= range.startRow && c.row <= range.endRow && c.col >= range.startCol && c.col <= range.endCol)
    .filter(isLinkableCell)
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

function findIdentifierOccurrences(pages: PageText[], name: string): { page: number; figures: ReportFigure[] }[] {
  const token = new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
  const out: { page: number; figures: ReportFigure[] }[] = [];
  for (const page of pages) {
    token.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = token.exec(page.text)) !== null) {
      const after = match.index + match[0].length;
      const separator = NAME_SEPARATOR.exec(page.text.slice(after))?.[0] ?? "";
      const figures = figuresOnLine(page.text, after + separator.length);
      out.push({ page: page.pageNumber, figures });
    }
  }
  return out;
}

function validatedEmbeddedReferences(
  references: DocEmbeddedReference[],
  model: WorkbookModel
): Map<string, DocEmbeddedReference> {
  const validated = new Map<string, DocEmbeddedReference>();

  for (const reference of references) {
    const matches = model.definedNames.filter(
      (definition) =>
        definition.name.toLowerCase() === reference.definedName.toLowerCase() &&
        definition.resolved?.sheet.toLowerCase() === reference.sheet.toLowerCase()
    );

    if (matches.length !== 1) {
      continue;
    }

    const definition = matches[0];

    if (!definition.resolved) {
      continue;
    }

    const key = `${definition.resolved.sheet.toLowerCase()}!${definition.name.toLowerCase()}`;

    validated.set(key, {
      sheet: definition.resolved.sheet,
      definedName: definition.name,
    });
  }

  return validated;
}


function linkByDefinedNames(
  pages: PageText[],
  model: WorkbookModel,
  embeddedReferences: DocEmbeddedReference[] = []
): { links: LinkedFigure[]; ambiguous: number } {
  const links: LinkedFigure[] = [];
  let ambiguous = 0;

  const validatedEmbedded = validatedEmbeddedReferences(
    embeddedReferences,
    model
  );

  const byName = new Map<string, typeof model.definedNames>();

  for (const d of model.definedNames) {
    byName.set(
      d.name.toLowerCase(),
      [...(byName.get(d.name.toLowerCase()) ?? []), d]
    );
  }

  for (const definitions of byName.values()) {
    const name = definitions[0]?.name;

    if (
      !name ||
      !DEFINED_NAME_IDENTIFIER.test(name) ||
      LOOKS_LIKE_CELL_REFERENCE.test(name)
    ) {
      continue;
    }

    const occurrences = findIdentifierOccurrences(pages, name);

    const embeddedMatch = definitions.some((definition) => {
      if (!definition.resolved) {
        return false;
      }

      const key =
        `${definition.resolved.sheet.toLowerCase()}!${definition.name.toLowerCase()}`;

      return validatedEmbedded.has(key);
    });

    if (occurrences.length === 0 && !embeddedMatch) {
      continue;
    }

    if (definitions.length !== 1 || !definitions[0].resolved) {
      ambiguous++;
      continue;
    }

    const definition = definitions[0];
    const resolved = definition.resolved;

    if (!resolved) {
      ambiguous++;
      continue;
    }

    const { sheet, range } = resolved;
    const cells = cellsInRange(model, sheet, range);

    if (cells.length === 0 || cells.length > MAX_RANGE_LINK_CELLS) {
      continue;
    }

    const withFigures = occurrences.filter(
      (occurrence) => occurrence.figures.length > 0
    );

    // A validated embedded .doc reference proves that the named workbook
    // range is used by the report, but it does not by itself prove which
    // report figure corresponds to which cell in that range.
    if (withFigures.length === 0) {
      continue;
    }

    const first = withFigures[0].figures;

    // Repeated visible identifiers must expose the same ordered figures.
    if (
      !withFigures.every(
        (occurrence) =>
          occurrence.figures.length === first.length &&
          occurrence.figures.every((figure, index) =>
            sameFigure(figure, first[index])
          )
      )
    ) {
      ambiguous++;
      continue;
    }

    if (cells.length === 1 && first.length >= 1) {
      links.push({
        strategy: "defined_name",
        key: name,
        reportFigure: first[0],
        reportPages: [...new Set(withFigures.map((o) => o.page))],
        cell: cells[0],
        definedName: name,
        label: null,
        table: null,
        sourceRange: null,
        header: null,
      });

      continue;
    }

    // Multi-cell names are useful only when the report exposes exactly the
    // same number of ordered figures beside the visible identifier.
    if (first.length !== cells.length) {
      ambiguous++;
      continue;
    }

    const ref = rangeReference(range);

    cells.forEach((cell, index) => {
      links.push({
        strategy: "defined_range",
        key: name,
        reportFigure: first[index],
        reportPages: [...new Set(withFigures.map((o) => o.page))],
        cell,
        definedName: name,
        label: null,
        table: null,
        sourceRange: ref,
        header: null,
      });
    });
  }

  return { links, ambiguous };
}

type RowCandidate = { label: string; cells: CellRecord[]; table: string | null; range: string | null; headers: string[] };

function workbookRowCandidates(model: WorkbookModel): Map<string, RowCandidate[]> {
  const out = new Map<string, RowCandidate[]>();
  for (const sheet of model.sheets) {
    const rows = new Map<number, CellRecord[]>();
    for (const cell of sheet.cells) rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell]);
    for (const [rowNo, rowCells] of rows) {
      const numeric = rowCells.filter(isLinkableCell).sort((a,b)=>a.col-b.col).slice(0, MAX_ROW_FIGURES + 1);
      if (numeric.length === 0 || numeric.length > MAX_ROW_FIGURES) continue;
      const firstNumericCol = numeric[0].col;
      const labelCell = rowCells.filter(c => c.type === "string" && typeof c.value === "string" && c.col < firstNumericCol && c.col >= firstNumericCol - 5).sort((a,b)=>b.col-a.col)[0];
      if (!labelCell || typeof labelCell.value !== "string") continue;
      const label = labelCell.value.trim();
      const normalized = normalizeLabel(label);
      if (normalized.length < 8 || normalized.split(" ").length < 2) continue;

      const table = sheet.tables.find(t => rowNo >= t.range.startRow && rowNo <= t.range.endRow && numeric.every(c => c.col >= t.range.startCol && c.col <= t.range.endCol));
      const headers = numeric.map(c => {
        if (!table) return "";
        const idx = c.col - table.range.startCol;
        return table.headers[idx] ?? "";
      });
      const candidate: RowCandidate = { label: label.slice(0,120), cells: numeric, table: table?.name ?? null, range: table ? rangeReference(table.range) : null, headers };
      out.set(normalized, [...(out.get(normalized) ?? []), candidate]);
      if (out.size > MAX_LABEL_CANDIDATES) return out;
    }
  }
  return out;
}

function linkEmbeddedNamedRangeStatistics(
  pages: PageText[],
  model: WorkbookModel,
  embeddedReferences: DocEmbeddedReference[],
  already: Set<string>
): { links: LinkedFigure[]; ambiguous: number } {
  const links: LinkedFigure[] = [];
  let ambiguous = 0;

  const validated = validatedEmbeddedReferences(
    embeddedReferences,
    model
  );

  const pattern =
    /\bfrom\s+(\$?\(?-?[\d,.]+\)?%?)\s+to\s+(\$?\(?-?[\d,.]+\)?%?)\s+with\s+an?\s+average\s+of\s+(\$?\(?-?[\d,.]+\)?%?)/gi;

  for (const definition of model.definedNames) {
    if (!definition.resolved) continue;

    const { sheet, range } = definition.resolved;

    const referenceKey =
      `${sheet.toLowerCase()}!${definition.name.toLowerCase()}`;

    if (!validated.has(referenceKey)) continue;

    const targetSheet = model.sheets.find(
      (candidate) => candidate.name === sheet
    );

    if (!targetSheet) continue;

    const rangeCells = targetSheet.cells.filter(
      (cell) =>
        cell.row >= range.startRow &&
        cell.row <= range.endRow &&
        cell.col >= range.startCol &&
        cell.col <= range.endCol
    );

    const rows = new Map<number, CellRecord[]>();

    for (const cell of rangeCells) {
      rows.set(
        cell.row,
        [...(rows.get(cell.row) ?? []), cell]
      );
    }

    /*
     * Locate the unique Low / High / Average rows first.
     *
     * Do NOT choose a numeric cell yet. Real appraisal summary rows
     * can contain multiple numeric columns (for example NOI and
     * capitalization rate).
     */
    const summaryRows = new Map<
      "low" | "high" | "average",
      CellRecord[]
    >();

    const duplicateLabels = new Set<
      "low" | "high" | "average"
    >();

    for (const rowCells of rows.values()) {
      for (const cell of rowCells) {
        if (
          cell.type !== "string" ||
          typeof cell.value !== "string"
        ) {
          continue;
        }

        const label = normalizeLabel(cell.value);

        if (
          label !== "low" &&
          label !== "high" &&
          label !== "average"
        ) {
          continue;
        }

        if (summaryRows.has(label)) {
          duplicateLabels.add(label);
          continue;
        }

        summaryRows.set(label, rowCells);
      }
    }

    if (duplicateLabels.size > 0) {
      ambiguous++;
      continue;
    }

    const lowRow = summaryRows.get("low");
    const highRow = summaryRows.get("high");
    const averageRow = summaryRows.get("average");

    if (!lowRow || !highRow || !averageRow) {
      continue;
    }

    /*
     * Parse report constructions such as:
     *
     *   from 4.77% to 5.81% with an average of 5.22%
     *
     * The exact hidden .doc reference has already limited this
     * investigation to this specific workbook named range.
     */
    const occurrences: {
      page: number;
      figures: [ReportFigure, ReportFigure, ReportFigure];
    }[] = [];

    for (const page of pages) {
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;

      while ((match = pattern.exec(page.text)) !== null) {
        const parsed: ReportFigure[] = [];

        for (let group = 1; group <= 3; group++) {
          const figure = parseFigureAt(match[group], 0);

          if (!figure.ok) {
            parsed.length = 0;
            break;
          }

          parsed.push(figure.figure);
        }

        if (parsed.length === 3) {
          occurrences.push({
            page: page.pageNumber,
            figures: [
              parsed[0],
              parsed[1],
              parsed[2],
            ],
          });
        }
      }
    }

if (occurrences.length === 0) {
  continue;
}

/*
 * Find numeric columns represented in all three summary rows.
 */
const lowByCol = new Map(
  lowRow
    .filter(isLinkableCell)
    .map((cell) => [cell.col, cell] as const)
);

const highByCol = new Map(
  highRow
    .filter(isLinkableCell)
    .map((cell) => [cell.col, cell] as const)
);

const averageByCol = new Map(
  averageRow
    .filter(isLinkableCell)
    .map((cell) => [cell.col, cell] as const)
);

/*
 * Evaluate every report occurrence against every structurally
 * compatible workbook column.
 *
 * The hidden .doc reference already anchors us to this exact named
 * range. We accept a mapping only when exactly one occurrence/column
 * combination matches all three workbook values.
 */
const matches: Array<{
  occurrence: (typeof occurrences)[number];
  low: CellRecord;
  high: CellRecord;
  average: CellRecord;
}> = [];

for (const occurrence of occurrences) {
  const reportKinds = occurrence.figures.map(
    (figure) => figure.kind
  );

  const reportIsPercent = reportKinds.every(
    (kind) => kind === "percent"
  );

  const reportIsAmount = reportKinds.every(
    (kind) => kind === "amount"
  );

  if (!reportIsPercent && !reportIsAmount) {
    continue;
  }

  for (const [col, low] of lowByCol) {
    const high = highByCol.get(col);
    const average = averageByCol.get(col);

    if (!high || !average) continue;

    const lowKind = classifyNumberFormat(low.numberFormat);
    const highKind = classifyNumberFormat(high.numberFormat);
    const averageKind = classifyNumberFormat(
      average.numberFormat
    );

    if (
      lowKind !== highKind ||
      lowKind !== averageKind
    ) {
      continue;
    }

    if (reportIsPercent && lowKind !== "percent") {
      continue;
    }

    if (reportIsAmount && lowKind === "percent") {
      continue;
    }

const comparisons = [
  compareFigure(occurrence.figures[0], {
    value: low.value as number,
    kind: lowKind,
  }),
  compareFigure(occurrence.figures[1], {
    value: high.value as number,
    kind: highKind,
  }),
  compareFigure(occurrence.figures[2], {
    value: average.value as number,
    kind: averageKind,
  }),
];

if (comparisons.every((comparison) => comparison === "match")) {
      matches.push({
        occurrence,
        low,
        high,
        average,
      });
    }
  }
}

/*
 * Zero matches means the report statistics do not correspond to this
 * named range. Multiple matches remain ambiguous. Never guess.
 */
if (matches.length !== 1) {
  if (matches.length > 1) {
    ambiguous++;
  }

  continue;
}

const selected = matches[0];
const occurrence = selected.occurrence;

const candidate = {
  low: selected.low,
  high: selected.high,
  average: selected.average,
};

if (
  already.has(cellKey(candidate.low)) ||
  already.has(cellKey(candidate.high)) ||
  already.has(cellKey(candidate.average))
) {
  continue;
}
    const pairs: Array<{
      label: string;
      cell: CellRecord;
      figure: ReportFigure;
    }> = [
      {
        label: "Low",
        cell: candidate.low,
        figure: occurrence.figures[0],
      },
      {
        label: "High",
        cell: candidate.high,
        figure: occurrence.figures[1],
      },
      {
        label: "Average",
        cell: candidate.average,
        figure: occurrence.figures[2],
      },
    ];

    for (const pair of pairs) {
      links.push({
        strategy: "defined_range",
        key: definition.name,
        reportFigure: pair.figure,
        reportPages: [occurrence.page],
        cell: pair.cell,
        definedName: definition.name,
        label: pair.label,
        table: null,
        sourceRange: rangeReference(range),
        header: null,
      });

      already.add(cellKey(pair.cell));
    }
  }

  return { links, ambiguous };
}

function linkEmbeddedNamedRangeSummaries(
  pages: PageText[],
  model: WorkbookModel,
  embeddedReferences: DocEmbeddedReference[],
  already: Set<string>
): { links: LinkedFigure[]; ambiguous: number } {
  const links: LinkedFigure[] = [];
  let ambiguous = 0;

  const validated = validatedEmbeddedReferences(
    embeddedReferences,
    model
  );

  for (const definition of model.definedNames) {
    if (!definition.resolved) {
      continue;
    }

    const { sheet, range } = definition.resolved;

    const referenceKey =
      `${sheet.toLowerCase()}!${definition.name.toLowerCase()}`;

    if (!validated.has(referenceKey)) {
      continue;
    }

    const targetSheet = model.sheets.find(
      (candidate) => candidate.name === sheet
    );

    if (!targetSheet) {
      continue;
    }

    const rangeCells = targetSheet.cells.filter(
      (cell) =>
        cell.row >= range.startRow &&
        cell.row <= range.endRow &&
        cell.col >= range.startCol &&
        cell.col <= range.endCol
    );

    const rows = new Map<number, CellRecord[]>();

    for (const cell of rangeCells) {
      rows.set(
        cell.row,
        [...(rows.get(cell.row) ?? []), cell]
      );
    }

    for (const rowCells of rows.values()) {
      const strings = rowCells
        .filter(
          (cell) =>
            cell.type === "string" &&
            typeof cell.value === "string" &&
            cell.value.trim().length >= 3
        )
        .sort((a, b) => a.col - b.col);

      const numeric = rowCells
        .filter(isLinkableCell)
        .sort((a, b) => a.col - b.col);

      // This bridge is intentionally limited to a simple labeled summary
      // row: one meaningful label and one numeric result.
      if (strings.length !== 1 || numeric.length !== 1) {
        continue;
      }

      const label = String(strings[0].value).trim();
      const cell = numeric[0];

      if (already.has(cellKey(cell))) {
        continue;
      }

      const normalized = normalizeLabel(label);

      if (
        normalized.length < 3 ||
        normalized.split(" ").length > 8
      ) {
        continue;
      }

      const words = normalized
        .split(" ")
        .map(escapeRegExp);

      const phrase = new RegExp(
        `(?<![A-Za-z0-9])${words.join("[^A-Za-z0-9]+")}(?![A-Za-z0-9])`,
        "gi"
      );

      const occurrences: {
        page: number;
        figures: ReportFigure[];
      }[] = [];

      let mentions = 0;

      for (const page of pages) {
        phrase.lastIndex = 0;

        let match: RegExpExecArray | null;

        while ((match = phrase.exec(page.text)) !== null) {
          mentions++;

          const lineStart =
            page.text.lastIndexOf("\n", match.index) + 1;

          const lineEndIndex =
            page.text.indexOf("\n", match.index);

          const lineEnd =
            lineEndIndex === -1
              ? page.text.length
              : lineEndIndex;

          const line = page.text.slice(lineStart, lineEnd);

          const figures: ReportFigure[] = [];

          for (
            let cursor = 0;
            cursor < line.length &&
            figures.length < MAX_ROW_FIGURES;
            cursor++
          ) {
            const parsed = parseFigureAt(line, cursor);

            if (parsed.ok) {
              figures.push(parsed.figure);
              cursor = parsed.end - 1;
            }
          }

          if (figures.length === 1) {
            occurrences.push({
              page: page.pageNumber,
              figures,
            });
          }
        }
      }

      // The label itself must identify one unambiguous place in the report.
      if (mentions !== 1 || occurrences.length !== 1) {
        if (mentions > 1) {
          ambiguous++;
        }

        continue;
      }

      links.push({
        strategy: "defined_range",
        key: definition.name,
        reportFigure: occurrences[0].figures[0],
        reportPages: [occurrences[0].page],
        cell,
        definedName: definition.name,
        label,
        table: null,
        sourceRange: rangeReference(range),
        header: null,
      });

      already.add(cellKey(cell));
    }
  }

  return { links, ambiguous };
}

function linkByContextLabels(pages: PageText[], model: WorkbookModel, already: Set<string>): { links: LinkedFigure[]; ambiguous: number } {
  const links: LinkedFigure[] = [];
  let ambiguous = 0;
  for (const [normalized, list] of workbookRowCandidates(model)) {
    if (list.length !== 1) continue;
    const candidate = list[0];
    if (candidate.cells.every(c => already.has(cellKey(c)))) continue;
    const words = normalized.split(" ").map(escapeRegExp);
    const phrase = new RegExp(`(?<![A-Za-z0-9])${words.join("[^A-Za-z0-9]+")}(?![A-Za-z0-9])`, "gi");
    const occurrences: { page: number; figures: ReportFigure[] }[] = [];
    let mentions = 0;
    for (const page of pages) {
      phrase.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = phrase.exec(page.text)) !== null) {
        mentions++;
        const after = match.index + match[0].length;
        const sep = LABEL_SEPARATOR.exec(page.text.slice(after))?.[0] ?? "";
        const figs = figuresOnLine(page.text, after + sep.length);
        if (figs.length) occurrences.push({ page: page.pageNumber, figures: figs });
      }
    }
    if (mentions !== 1 || occurrences.length !== 1) { if (mentions > 1) ambiguous++; continue; }
    const figures = occurrences[0].figures;
    if (figures.length !== candidate.cells.length) { ambiguous++; continue; }
    const strategy: LinkStrategy = candidate.table ? "table_row" : "context_label";
    candidate.cells.forEach((cell, i) => {
      if (already.has(cellKey(cell))) return;
      links.push({ strategy, key: candidate.label, reportFigure: figures[i], reportPages: [occurrences[0].page], cell, definedName: null, label: candidate.label, table: candidate.table, sourceRange: candidate.range, header: candidate.headers[i] || null });
    });
  }
  return { links, ambiguous };
}

export function linkReportToWorkbook(
  pages: PageText[],
  model: WorkbookModel,
  embeddedReferences: DocEmbeddedReference[] = []
): LinkingResult {
  const tableOf = new Map<string,string>();
  for (const sheet of model.sheets) for (const table of sheet.tables) for (let r=table.range.startRow;r<=table.range.endRow;r++) for (let c=table.range.startCol;c<=table.range.endCol;c++) tableOf.set(`${sheet.name}!${r},${c}`, table.name);
  const named = linkByDefinedNames(
  pages,
  model,
  embeddedReferences
);

const linked = new Set(
  named.links.map((link) => cellKey(link.cell))
);

const statistics = linkEmbeddedNamedRangeStatistics(
  pages,
  model,
  embeddedReferences,
  linked
);

const embedded = linkEmbeddedNamedRangeSummaries(
  pages,
  model,
  embeddedReferences,
  linked
);

const contextual = linkByContextLabels(
  pages,
  model,
  linked
);

const links = [
  ...named.links,
  ...statistics.links,
  ...embedded.links,
  ...contextual.links,
].map((link) => ({
  ...link,
  table:
    link.table ??
    tableOf.get(cellKey(link.cell)) ??
    null,
}));

return {
  links,
  ambiguous:
    named.ambiguous +
    statistics.ambiguous +
    embedded.ambiguous +
    contextual.ambiguous,
};
}

