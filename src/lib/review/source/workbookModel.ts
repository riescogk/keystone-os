import { SourceWorkbookError } from "@/lib/review/source/errors";
import type { WorkbookFormat } from "@/lib/review/source/workbookFile";
import type { ZipArchive } from "@/lib/review/source/zipArchive";
import { inspectWorkbookPackage, readXmlPart } from "@/lib/review/source/workbookPackage";
import {
  childrenNamed,
  firstChild,
  textOf,
  type XmlElement,
} from "@/lib/review/source/xmlTree";
import { parseA1, parseRangeText, type CellRange } from "@/lib/review/source/cellRef";

/**
 * Reads a workbook into a compact, bounded model: populated cells (value,
 * formula, number format), sheets, defined names, and Excel tables.
 *
 * It reads ONLY the parts it needs. It never executes a formula (cached
 * results are used where Excel stored them), never follows external links,
 * and never opens the VBA project.
 */

/** Hard cap on populated cells across the whole workbook. */
export const MAX_POPULATED_CELLS = 250_000;
const MAX_MERGED_RANGES_PER_SHEET = 2000;
const MAX_FORMULA_CHARS = 500;

export type CellValueType = "number" | "string" | "boolean" | "error";

export interface CellRecord {
  sheet: string;
  ref: string;
  row: number;
  col: number;
  type: CellValueType;
  /** Number for "number", string for "string"/"error", boolean for "boolean". */
  value: number | string | boolean | null;
  formula: string | null;
  /** Formula references another workbook. Its cached value is not trusted for matching. */
  externalFormula: boolean;
  /** A formula exists but Excel stored no usable cached result. */
  uncached: boolean;
  /** Raw number format code, e.g. "0.00%" or "$#,##0". Null for non-numeric cells. */
  numberFormat: string | null;
}

export interface TableModel {
  name: string;
  displayName: string | null;
  sheet: string;
  range: CellRange;
  headers: string[];
}

export interface SheetModel {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  cells: CellRecord[];
  mergedRanges: string[];
  tables: TableModel[];
}

export interface DefinedNameModel {
  name: string;
  /** Sheet the name is scoped to, or null for a workbook-level name. */
  scopeSheet: string | null;
  /** The name's definition as written in the workbook, truncated. */
  target: string;
  /** Resolved location, or null when the definition is not a plain reference. */
  resolved: { sheet: string; range: CellRange } | null;
}

export interface WorkbookModel {
  format: WorkbookFormat;
  sheets: SheetModel[];
  definedNames: DefinedNameModel[];
  /** Counts only, for the upload/UI summary. Never used for matching. */
  externalLinkCount: number;
  containsMacros: boolean;
}

/* ------------------------------------------------------------------ */
/* Number formats                                                      */
/* ------------------------------------------------------------------ */

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: "$#,##0",
  6: "$#,##0",
  7: "$#,##0.00",
  8: "$#,##0.00",
  9: "0%",
  10: "0.00%",
  14: "m/d/yyyy",
  49: "@",
};

function loadNumberFormats(styles: XmlElement | null): {
  custom: Map<number, string>;
  xfNumFmtIds: number[];
} {
  const custom = new Map<number, string>();
  const xfNumFmtIds: number[] = [];
  if (!styles) return { custom, xfNumFmtIds };

  for (const numFmt of childrenNamed(firstChild(styles, "numFmts"), "numFmt")) {
    const id = Number(numFmt.attributes.numFmtId);
    if (Number.isInteger(id) && numFmt.attributes.formatCode !== undefined) {
      custom.set(id, numFmt.attributes.formatCode);
    }
  }
  for (const xf of childrenNamed(firstChild(styles, "cellXfs"), "xf")) {
    xfNumFmtIds.push(Number(xf.attributes.numFmtId ?? 0) || 0);
  }
  return { custom, xfNumFmtIds };
}

function formatCodeFor(
  styleIndex: number | null,
  formats: { custom: Map<number, string>; xfNumFmtIds: number[] }
): string | null {
  if (styleIndex === null) return null;
  const numFmtId = formats.xfNumFmtIds[styleIndex] ?? 0;
  return formats.custom.get(numFmtId) ?? BUILTIN_FORMATS[numFmtId] ?? "General";
}

/* ------------------------------------------------------------------ */
/* Relationships                                                       */
/* ------------------------------------------------------------------ */

interface Relationship {
  type: string;
  /** Resolved package path, e.g. "xl/worksheets/sheet1.xml". */
  path: string;
}

function resolvePackagePath(baseDirectory: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${baseDirectory}${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}

function loadRelationships(
  archive: ZipArchive,
  relsPath: string,
  baseDirectory: string
): Map<string, Relationship> {
  const map = new Map<string, Relationship>();
  if (!archive.has(relsPath)) return map;
  const root = readXmlPart(archive, relsPath);
  for (const rel of childrenNamed(root, "Relationship")) {
    const id = rel.attributes.Id;
    const target = rel.attributes.Target;
    if (!id || !target || rel.attributes.TargetMode === "External") continue;
    map.set(id, {
      type: rel.attributes.Type ?? "",
      path: resolvePackagePath(baseDirectory, target),
    });
  }
  return map;
}

function relationshipsOfType(
  relationships: Map<string, Relationship>,
  typeSuffix: string
): Relationship[] {
  return [...relationships.values()].filter((rel) => rel.type.endsWith(typeSuffix));
}

/* ------------------------------------------------------------------ */
/* Cells                                                               */
/* ------------------------------------------------------------------ */

function loadSharedStrings(archive: ZipArchive, path: string | undefined): string[] {
  if (!path || !archive.has(path)) return [];
  const root = readXmlPart(archive, path);
  return childrenNamed(root, "si").map((si) => textOf(si));
}

function readSheetCells(
  sheetName: string,
  sheetRoot: XmlElement,
  sharedStrings: string[],
  formats: { custom: Map<number, string>; xfNumFmtIds: number[] },
  budget: { remaining: number }
): CellRecord[] {
  const cells: CellRecord[] = [];
  const sheetData = firstChild(sheetRoot, "sheetData");

  for (const row of childrenNamed(sheetData, "row")) {
    for (const cell of childrenNamed(row, "c")) {
      const ref = cell.attributes.r;
      if (!ref) continue;
      const address = parseA1(ref);
      if (!address) {
        throw new SourceWorkbookError("unreadable", "invalid cell reference");
      }

      const formulaElement = firstChild(cell, "f");
      const hasFormula = formulaElement !== undefined;
      let formula: string | null = null;
      if (hasFormula) {
        const text = textOf(formulaElement).slice(0, MAX_FORMULA_CHARS);
        // A shared-formula child has no text of its own; keep the marker
        // so the cell still reads as "a formula" rather than a constant.
        formula = text.length > 0 ? `=${text}` : "=(shared formula)";
      }
      const externalFormula = formula !== null && /\[\d+\]/.test(formula);

      const valueElement = firstChild(cell, "v");
      const rawValue = valueElement ? textOf(valueElement) : null;
      const styleIndex =
        cell.attributes.s !== undefined ? Number(cell.attributes.s) : null;
      const kind = cell.attributes.t ?? "n";

      let type: CellValueType;
      let value: CellRecord["value"] = null;
      let uncached = false;

      switch (kind) {
        case "s": {
          const index = Number(rawValue);
          value = sharedStrings[index] ?? null;
          type = "string";
          break;
        }
        case "inlineStr": {
          const inline = firstChild(cell, "is");
          value = inline ? textOf(inline) : null;
          type = "string";
          break;
        }
        case "str": {
          value = rawValue;
          type = "string";
          uncached = hasFormula && rawValue === null;
          break;
        }
        case "b": {
          value = rawValue === null ? null : rawValue === "1";
          type = "boolean";
          uncached = hasFormula && rawValue === null;
          break;
        }
        case "e": {
          value = rawValue ?? "#ERROR";
          type = "error";
          break;
        }
        default: {
          type = "number";
          if (rawValue !== null && rawValue.trim() !== "") {
            const numeric = Number(rawValue);
            if (Number.isFinite(numeric)) {
              value = numeric;
            } else {
              uncached = hasFormula;
            }
          } else {
            uncached = hasFormula;
          }
        }
      }

      // Skip cells that carry nothing: style-only cells, empty strings.
      if (value === null && !hasFormula) continue;
      if (value === "" && !hasFormula) continue;

      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw new SourceWorkbookError("too_large", "too many populated cells");
      }

      cells.push({
        sheet: sheetName,
        ref,
        row: address.row,
        col: address.col,
        type,
        value,
        formula,
        externalFormula,
        uncached,
        numberFormat: type === "number" ? formatCodeFor(styleIndex, formats) : null,
      });
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function readTable(archive: ZipArchive, path: string, sheet: string): TableModel | null {
  const root = readXmlPart(archive, path);
  const range = parseRangeText(root.attributes.ref ?? "");
  const name = root.attributes.name ?? root.attributes.displayName;
  if (!range || !name) return null;
  const headers = childrenNamed(firstChild(root, "tableColumns"), "tableColumn").map(
    (column) => column.attributes.name ?? ""
  );
  return {
    name,
    displayName: root.attributes.displayName ?? null,
    sheet,
    range,
    headers,
  };
}

/* ------------------------------------------------------------------ */
/* Defined names                                                       */
/* ------------------------------------------------------------------ */

const TARGET_PATTERN =
  /^(?:'((?:[^']|'')+)'|([^'!\s][^'!]*))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/;

function resolveNameTarget(
  text: string,
  sheetNames: Set<string>
): { sheet: string; range: CellRange } | null {
  const match = TARGET_PATTERN.exec(text.trim());
  if (!match) return null;
  const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
  if (!sheetNames.has(sheet)) return null;
  const range = parseRangeText(match[3]);
  return range ? { sheet, range } : null;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export function readWorkbookModel(
  archive: ZipArchive,
  format: WorkbookFormat,
  options: { maxPopulatedCells?: number } = {}
): WorkbookModel {
  const inspection = inspectWorkbookPackage(archive, format);

  const workbook = readXmlPart(archive, "xl/workbook.xml");
  const workbookRels = loadRelationships(archive, "xl/_rels/workbook.xml.rels", "xl/");

  const sharedStringsRel = relationshipsOfType(workbookRels, "/sharedStrings")[0];
  const stylesRel = relationshipsOfType(workbookRels, "/styles")[0];
  const sharedStrings = loadSharedStrings(archive, sharedStringsRel?.path);
  const formats = loadNumberFormats(
    stylesRel && archive.has(stylesRel.path) ? readXmlPart(archive, stylesRel.path) : null
  );

  const sheetElements = childrenNamed(firstChild(workbook, "sheets"), "sheet");
  const sheetNames = sheetElements.map((element) => element.attributes.name ?? "");
  const sheetNameSet = new Set(sheetNames);
  const budget = { remaining: options.maxPopulatedCells ?? MAX_POPULATED_CELLS };

  const sheets: SheetModel[] = sheetElements.map((element, index) => {
    const name = sheetNames[index];
    const relId = element.attributes.id;
    const relationship = relId ? workbookRels.get(relId) : undefined;
    const state = (element.attributes.state ?? "visible") as SheetModel["state"];
    const sheetPath = relationship?.path;
    if (!sheetPath || !archive.has(sheetPath)) {
      throw new SourceWorkbookError("unreadable", `sheet "${name}" has no part`);
    }

    const sheetRoot = readXmlPart(archive, sheetPath);
    const cells = readSheetCells(name, sheetRoot, sharedStrings, formats, budget);

    const mergedRanges = childrenNamed(firstChild(sheetRoot, "mergeCells"), "mergeCell")
      .map((merge) => merge.attributes.ref ?? "")
      .filter((ref) => ref.length > 0)
      .slice(0, MAX_MERGED_RANGES_PER_SHEET);

    const sheetDirectory = sheetPath.slice(0, sheetPath.lastIndexOf("/") + 1);
    const sheetFile = sheetPath.slice(sheetDirectory.length);
    const sheetRels = loadRelationships(
      archive,
      `${sheetDirectory}_rels/${sheetFile}.rels`,
      sheetDirectory
    );
    const tables: TableModel[] = [];
    for (const part of childrenNamed(firstChild(sheetRoot, "tableParts"), "tablePart")) {
      const relationship = part.attributes.id
        ? sheetRels.get(part.attributes.id)
        : undefined;
      if (!relationship || !archive.has(relationship.path)) continue;
      const table = readTable(archive, relationship.path, name);
      if (table) tables.push(table);
    }

    return { name, state, cells, mergedRanges, tables };
  });

  const definedNames: DefinedNameModel[] = [];
  for (const element of childrenNamed(firstChild(workbook, "definedNames"), "definedName")) {
    const name = element.attributes.name;
    if (!name || name.startsWith("_xlnm.") || name.startsWith("_xlfn.")) continue;
    const localSheetId =
      element.attributes.localSheetId !== undefined
        ? Number(element.attributes.localSheetId)
        : null;
    const scopeSheet =
      localSheetId !== null && Number.isInteger(localSheetId)
        ? sheetNames[localSheetId] ?? null
        : null;
    const target = textOf(element).trim();
    definedNames.push({
      name,
      scopeSheet,
      target: target.slice(0, 300),
      resolved: resolveNameTarget(target, sheetNameSet),
    });
  }

  return {
    format,
    sheets,
    definedNames,
    externalLinkCount: inspection.externalLinkCount,
    containsMacros: inspection.containsMacros,
  };
}
