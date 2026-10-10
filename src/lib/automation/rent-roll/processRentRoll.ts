import ExcelJS from "exceljs";

export interface ProcessRentRollOptions {
  chargeCodes: string[];
}

export interface RentRollUnit {
  unit: string;
  unitType: string;
  sqft: number | string | null;
  unitCategory: string;
  residentName: string;
  marketRent: number | null;
  chargeCode: string;
  rentAmount: number;
}

export interface ProcessRentRollResult {
  buffer: Buffer;
  outputFilename: string;
  warnings: string[];
  unitCount: number;
}

interface CategoryDefinition {
  key: string;
  sqft: number | string | null;
}

interface CategorySummary {
  category: string;
  sqft: number | string | null;
  totalCount: number;
  occupiedCount: number;
  vacantCount: number;
  modelCount: number;
}

const CURRENT_RESIDENTS_MARKER = "current/notice/vacant residents";
const FUTURE_RESIDENTS_MARKER = "future residents/applicants";

function getCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  if (value instanceof Date) {
    return value.toISOString().trim();
  }

  if (typeof value === "object") {
    // Formula cell
    if ("result" in value) {
      const result = value.result;

      if (result === null || result === undefined) {
        return "";
      }

      return String(result).trim();
    }

    // Rich text cell
    if (
      "richText" in value &&
      Array.isArray(value.richText)
    ) {
      return value.richText
        .map((part) => part?.text ?? "")
        .join("")
        .trim();
    }

    // Hyperlink cell
    if ("text" in value) {
      const text = value.text;

      if (text === null || text === undefined) {
        return "";
      }

      return String(text).trim();
    }

    // Excel error cell
    if ("error" in value) {
      const error = value.error;

      if (error === null || error === undefined) {
        return "";
      }

      return String(error).trim();
    }
  }

  return "";
}

function normalizeChargeCodes(values: string[]): Set<string> {
  const normalized = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error("Enter at least one rent charge code before processing.");
  }

  return new Set(normalized);
}

function rowContainsMarker(
  row: ExcelJS.Row,
  marker: string,
  maxColumns = 14
): boolean {
  const target = marker.toLowerCase();

  for (let column = 1; column <= maxColumns; column += 1) {
    const value = getCellText(row.getCell(column)).toLowerCase();

    if (value.includes(target)) {
      return true;
    }
  }

  return false;
}

function findResidentDataBounds(
  worksheet: ExcelJS.Worksheet
): { startRow: number; endRow: number } {
  let startRow: number | null = null;
  let endRow = worksheet.rowCount;

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);

    if (
      startRow === null &&
      rowContainsMarker(row, CURRENT_RESIDENTS_MARKER)
    ) {
      startRow = rowNumber + 1;
      continue;
    }

    if (
      startRow !== null &&
      rowContainsMarker(row, FUTURE_RESIDENTS_MARKER)
    ) {
      endRow = rowNumber - 1;
      break;
    }
  }

  if (startRow === null) {
    throw new Error(
      'The workbook does not contain the required "Current/Notice/Vacant Residents" section.'
    );
  }

  return { startRow, endRow };
}

function isValidUnit(value: string): boolean {
  const normalized = value.trim();

  if (!normalized) {
    return false;
  }

  /*
   * The source Rent Roll can repeat its table headers throughout the
   * resident section. "Unit" matches the normal unit-character regex,
   * so explicitly reject it.
   */
  if (normalized.toLowerCase() === "unit") {
    return false;
  }

  return /^[A-Za-z0-9-]+$/.test(normalized);
}

function numericCellValue(cell: ExcelJS.Cell): number | null {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return cell.value;
  }

  const text = getCellText(cell)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();

  if (!text) {
    return null;
  }

  const parsed = Number(text);

  return Number.isFinite(parsed) ? parsed : null;
}

/*
 * Unit types ending in letters + number + optional suffix are treated
 * as floor plans.
 *
 * Examples:
 *   A1   -> A1
 *   A1r  -> A1
 *   A1a  -> A1a
 *
 * A trailing "r" means renovated and joins the base floor plan.
 * Other suffixes remain separate.
 *
 * Unit types that do not match the expected floor-plan pattern fall
 * back to grouping by square footage.
 */
function getCategoryDefinition(
  unitType: string,
  sqft: number | string | null
): CategoryDefinition {
  const normalized = unitType.trim();

  const match = normalized.match(/([A-Za-z]+)(\d+)([A-Za-z]*)$/);

  if (match) {
    const letters = match[1].toUpperCase();
    const number = match[2];
    const rawSuffix = match[3] ?? "";

    const suffix =
      rawSuffix.toLowerCase() === "r"
        ? ""
        : rawSuffix.toLowerCase();

    return {
      key: `PLAN:${letters}:${number}:${suffix}`,
      sqft,
    };
  }

  return {
    key: `SQFT:${String(sqft ?? "").trim()}`,
    sqft,
  };
}

function excelColumnLabel(index: number): string {
  let number = index + 1;
  let result = "";

  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }

  return result;
}

function floorPlanSortParts(key: string): {
  fallback: boolean;
  letters: string;
  number: number;
  suffix: string;
  sqft: number;
} {
  if (key.startsWith("PLAN:")) {
    const [, letters = "", number = "0", suffix = ""] = key.split(":");

    return {
      fallback: false,
      letters,
      number: Number(number),
      suffix,
      sqft: 0,
    };
  }

  const rawSqft = key.replace(/^SQFT:/, "");
  const parsedSqft = Number(rawSqft);

  return {
    fallback: true,
    letters: "",
    number: 0,
    suffix: "",
    sqft: Number.isFinite(parsedSqft)
      ? parsedSqft
      : Number.MAX_SAFE_INTEGER,
  };
}

function compareCategoryKeys(a: string, b: string): number {
  const left = floorPlanSortParts(a);
  const right = floorPlanSortParts(b);

  if (left.fallback !== right.fallback) {
    return left.fallback ? 1 : -1;
  }

  if (!left.fallback && !right.fallback) {
    const letterComparison = left.letters.localeCompare(right.letters);

    if (letterComparison !== 0) {
      return letterComparison;
    }

    if (left.number !== right.number) {
      return left.number - right.number;
    }

    return left.suffix.localeCompare(right.suffix);
  }

  return left.sqft - right.sqft;
}

function assignUnitCategories(units: RentRollUnit[]): void {
  const definitions = new Map<string, CategoryDefinition>();

  for (const unit of units) {
    const definition = getCategoryDefinition(unit.unitType, unit.sqft);

    if (!definitions.has(definition.key)) {
      definitions.set(definition.key, definition);
    }
  }

  const orderedKeys = Array.from(definitions.keys()).sort(compareCategoryKeys);

  const categoryByKey = new Map<string, string>();

  orderedKeys.forEach((key, index) => {
    categoryByKey.set(key, excelColumnLabel(index));
  });

  for (const unit of units) {
    const definition = getCategoryDefinition(unit.unitType, unit.sqft);

    unit.unitCategory = categoryByKey.get(definition.key) ?? "";
  }
}

function extractUnits(
  worksheet: ExcelJS.Worksheet,
  chargeCodes: Set<string>
): { units: RentRollUnit[]; warnings: string[] } {
  const { startRow, endRow } = findResidentDataBounds(worksheet);

  const units: RentRollUnit[] = [];
  const warnings: string[] = [];

  let rowNumber = startRow;

  while (rowNumber <= endRow) {
    const row = worksheet.getRow(rowNumber);
    const unit = getCellText(row.getCell(1));

    if (!unit || !isValidUnit(unit)) {
      rowNumber += 1;
      continue;
    }

    const unitType = getCellText(row.getCell(2));
    const sqftText = getCellText(row.getCell(3));
    const residentName = getCellText(row.getCell(5));
    const marketRent = numericCellValue(row.getCell(6));

    let matchedChargeCode = "";
    let rentAmount = 0;

    /*
     * A unit can occupy several source rows because recurring charges
     * can appear below the main unit row.
     */
    let chargeRowNumber = rowNumber;

    while (chargeRowNumber <= endRow) {
      const chargeRow = worksheet.getRow(chargeRowNumber);

      if (chargeRowNumber > rowNumber) {
        const possibleNextUnit = getCellText(chargeRow.getCell(1));

        if (possibleNextUnit && isValidUnit(possibleNextUnit)) {
          break;
        }
      }

      const sourceChargeCode = getCellText(chargeRow.getCell(7));
      const normalizedCode = sourceChargeCode.toLowerCase();

      if (chargeCodes.has(normalizedCode)) {
        /*
         * Match the OG output: write the normalized/lowercase charge
         * code rather than preserving source capitalization such as RENT.
         */
        matchedChargeCode = normalizedCode;
        rentAmount = numericCellValue(chargeRow.getCell(8)) ?? 0;
        break;
      }

      chargeRowNumber += 1;
    }

    const residentUpper = residentName.toUpperCase();

    const occupied =
      residentName.length > 0 &&
      !residentUpper.includes("VACANT") &&
      !residentUpper.includes("MODEL");

    if (occupied && !matchedChargeCode) {
      warnings.push(
        `Unit ${unit} appears occupied but no matching rent charge code was found. Rent Amount was set to $0.`
      );
    }

    units.push({
      unit,
      unitType,
      sqft: numericCellValue(row.getCell(3)) ?? (sqftText || null),
      unitCategory: "",
      residentName,
      marketRent,
      chargeCode: matchedChargeCode,
      rentAmount,
    });

    rowNumber =
      chargeRowNumber > rowNumber
        ? chargeRowNumber
        : rowNumber + 1;
  }

  if (units.length === 0) {
    throw new Error(
      "No valid units were found in the Current/Notice/Vacant Residents section."
    );
  }

  assignUnitCategories(units);

  return { units, warnings };
}

function buildCategorySummary(units: RentRollUnit[]): CategorySummary[] {
  const summaries = new Map<string, CategorySummary>();

  for (const unit of units) {
    let summary = summaries.get(unit.unitCategory);

    if (!summary) {
      summary = {
        category: unit.unitCategory,
        sqft: unit.sqft,
        totalCount: 0,
        occupiedCount: 0,
        vacantCount: 0,
        modelCount: 0,
      };

      summaries.set(unit.unitCategory, summary);
    }

    summary.totalCount += 1;

    const resident = unit.residentName.toUpperCase();

    if (resident.includes("VACANT")) {
      summary.vacantCount += 1;
    } else if (resident.includes("MODEL")) {
      summary.modelCount += 1;
    } else {
      summary.occupiedCount += 1;
    }
  }

  return Array.from(summaries.values()).sort((a, b) => {
    return a.category.localeCompare(b.category, undefined, {
      numeric: true,
    });
  });
}

function findSummaryGroupsBounds(
  worksheet: ExcelJS.Worksheet
): { startRow: number; endRow: number } | null {
  let startRow: number | null = null;

  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const value = getCellText(
      worksheet.getRow(rowNumber).getCell(1)
    );

    if (value.toLowerCase() === "summary groups") {
      startRow = rowNumber;
      break;
    }
  }

  if (startRow === null) {
    return null;
  }

  let endRow = Math.min(startRow + 7, worksheet.rowCount);

  for (
    let rowNumber = startRow;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const value = getCellText(
      worksheet.getRow(rowNumber).getCell(1)
    );

    if (value.toLowerCase() === "totals:") {
      endRow = rowNumber;
      break;
    }
  }

  return { startRow, endRow };
}

function copySummaryGroups(
  sourceWorksheet: ExcelJS.Worksheet,
  targetWorksheet: ExcelJS.Worksheet
): number {
  const bounds = findSummaryGroupsBounds(sourceWorksheet);

  if (!bounds) {
    targetWorksheet.addRow(["Summary Groups"]);
    targetWorksheet.addRow([
      "Summary Groups section was not found in the source workbook.",
    ]);

    return 5;
  }

  for (
    let sourceRowNumber = bounds.startRow;
    sourceRowNumber <= bounds.endRow;
    sourceRowNumber += 1
  ) {
    const sourceRow = sourceWorksheet.getRow(sourceRowNumber);
    const values: unknown[] = [];

    for (let column = 1; column <= 14; column += 1) {
      values.push(sourceRow.getCell(column).value);
    }

    targetWorksheet.addRow(values);
  }

  /*
   * Match the OG workbook spacing:
   * leave two blank rows between Summary Groups and Unit Category.
   */
  return targetWorksheet.rowCount + 3;
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true };

  row.eachCell((cell) => {
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
    };
  });
}

function createCleanRentRollSheet(
  workbook: ExcelJS.Workbook,
  units: RentRollUnit[]
): void {
  const worksheet = workbook.addWorksheet("Clean Rent Roll");

  const header = worksheet.addRow([
    "Unit",
    "Unit Type",
    "Sq Ft",
    "Unit Category",
    "Resident Name",
    "Market Rent",
    "Charge Code",
    "Rent Amount",
  ]);

  styleHeader(header);

  for (const unit of units) {
    const row = worksheet.addRow([
      unit.unit,
      unit.unitType,
      unit.sqft,
      unit.unitCategory,
      unit.residentName,
      unit.marketRent,
      unit.chargeCode,
      unit.rentAmount,
    ]);

    /*
     * Keep unit identifiers as text so leading zeroes are not lost.
     */
    row.getCell(1).value = unit.unit;
    row.getCell(1).numFmt = "@";

    row.getCell(6).numFmt = '$#,##0.00';
    row.getCell(8).numFmt = '$#,##0.00';
  }

  /*
   * Match the OG output more closely.
   * No autofilter and no frozen header.
   */
  worksheet.getColumn(1).width = 7.14;
  worksheet.getColumn(2).width = 11.86;
  worksheet.getColumn(3).width = 7.57;
  worksheet.getColumn(4).width = 15.57;
  worksheet.getColumn(5).width = 34.43;
  worksheet.getColumn(6).width = 14.43;
  worksheet.getColumn(7).width = 14.43;
  worksheet.getColumn(8).width = 15;
}

function createSummarySheet(
  workbook: ExcelJS.Workbook,
  sourceWorksheet: ExcelJS.Worksheet,
  units: RentRollUnit[]
): void {
  const worksheet = workbook.addWorksheet("Summary");

  const categoryStartRow = copySummaryGroups(
    sourceWorksheet,
    worksheet
  );

  while (worksheet.rowCount < categoryStartRow - 1) {
    worksheet.addRow([]);
  }

  const header = worksheet.addRow([
    "Unit Category",
    "SQFT",
    "TotalCount",
    "OccupiedCount",
    "VacantCount",
    "ModelCount",
  ]);

  styleHeader(header);

  const summaries = buildCategorySummary(units);

  for (const summary of summaries) {
    worksheet.addRow([
      summary.category,
      summary.sqft,
      summary.totalCount,
      summary.occupiedCount,
      summary.vacantCount,
      summary.modelCount,
    ]);
  }

  const totalRow = worksheet.addRow([
    "TOTAL",
    "",
    summaries.reduce(
      (sum, item) => sum + item.totalCount,
      0
    ),
    summaries.reduce(
      (sum, item) => sum + item.occupiedCount,
      0
    ),
    summaries.reduce(
      (sum, item) => sum + item.vacantCount,
      0
    ),
    summaries.reduce(
      (sum, item) => sum + item.modelCount,
      0
    ),
  ]);

  totalRow.font = { bold: true };

  worksheet.getColumn(1).width = 22;
  worksheet.getColumn(2).width = 14;
  worksheet.getColumn(3).width = 14;
  worksheet.getColumn(4).width = 16;
  worksheet.getColumn(5).width = 14;
  worksheet.getColumn(6).width = 14;
}

/*
 * Copy the uploaded source worksheet into the generated workbook so the
 * final file always contains the original Rent Roll for reference.
 *
 * We copy:
 * - cell values and formulas
 * - cell styles
 * - number formats
 * - row heights
 * - row visibility
 * - column widths
 * - column visibility
 * - merged cells
 *
 * ExcelJS cannot guarantee a byte-for-byte clone of every Excel-specific
 * feature, but this preserves the worksheet content and normal formatting.
 */
function createOriginalRentRollSheet(
  workbook: ExcelJS.Workbook,
  sourceWorksheet: ExcelJS.Worksheet
): void {
  const worksheet = workbook.addWorksheet("Original Rent Roll");

  sourceWorksheet.columns.forEach((sourceColumn, index) => {
    const targetColumn = worksheet.getColumn(index + 1);

    if (sourceColumn.width !== undefined) {
      targetColumn.width = sourceColumn.width;
    }

    targetColumn.hidden = sourceColumn.hidden ?? false;
  });

  sourceWorksheet.eachRow(
    { includeEmpty: true },
    (sourceRow, rowNumber) => {
      const targetRow = worksheet.getRow(rowNumber);

      if (sourceRow.height !== undefined) {
        targetRow.height = sourceRow.height;
      }

      targetRow.hidden = sourceRow.hidden;

      sourceRow.eachCell(
        { includeEmpty: true },
        (sourceCell, columnNumber) => {
          const targetCell = targetRow.getCell(columnNumber);

          targetCell.value = sourceCell.value;

          if (sourceCell.style) {
            targetCell.style = {
              ...sourceCell.style,
            };
          }

          if (sourceCell.numFmt) {
            targetCell.numFmt = sourceCell.numFmt;
          }
        }
      );

      targetRow.commit();
    }
  );

  /*
   * Recreate merged ranges from the source worksheet.
   */
  const sourceModel = sourceWorksheet.model;

  for (const merge of sourceModel.merges ?? []) {
    try {
      worksheet.mergeCells(merge);
    } catch {
      /*
       * A malformed or unsupported merge should not prevent the Rent Roll
       * from being processed.
       */
    }
  }
}

export async function processRentRoll(
  input: Buffer,
  originalFilename: string,
  options: ProcessRentRollOptions
): Promise<ProcessRentRollResult> {
  const chargeCodes = normalizeChargeCodes(options.chargeCodes);

  const sourceWorkbook = new ExcelJS.Workbook();

  await sourceWorkbook.xlsx.load(
    input as unknown as ExcelJS.Buffer
  );

  const sourceWorksheet = sourceWorkbook.worksheets[0];

  if (!sourceWorksheet) {
    throw new Error(
      "The uploaded workbook does not contain a worksheet."
    );
  }

  const { units, warnings } = extractUnits(
    sourceWorksheet,
    chargeCodes
  );

  const outputWorkbook = new ExcelJS.Workbook();

  /*
   * Sheet order intentionally matches the OG workflow:
   *
   * 1. Summary
   * 2. Clean Rent Roll
   * 3. Original Rent Roll
   */
  createSummarySheet(
    outputWorkbook,
    sourceWorksheet,
    units
  );

  createCleanRentRollSheet(
    outputWorkbook,
    units
  );


createOriginalRentRollSheet(
  outputWorkbook,
  sourceWorksheet
);


  const output = await outputWorkbook.xlsx.writeBuffer();

  const sourceBaseName = originalFilename.replace(
    /\.xlsx$/i,
    ""
  );

  return {
    buffer: Buffer.from(output),
    outputFilename: `${sourceBaseName}_Clean.xlsx`,
    warnings,
    unitCount: units.length,
  };
}