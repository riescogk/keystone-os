import ExcelJS from "exceljs";
import {
  extractPdfIE,
  type PdfIEExtractionResult,
} from "@/lib/automation/ie/extractPdfIE";
import fs from "node:fs/promises";
import path from "node:path";

const CURRENCY_FORMAT = '$#,##0.00;[Red]($#,##0.00);-';

export interface IEInputFile {
  name: string;
  buffer: Buffer;
}

export interface IEProcessResult {
  buffer: Buffer;
  outputFilename: string;
  propertyName: string;
  rowCount: number;
  warnings: string[];
}

type ReportType =
  | "annual"
  | "t12"
  | "separate_annual"
  | "budget"
  | "annualized";

interface FileInfo {
  file: IEInputFile;
  reportType: ReportType;
  propertyName: string;
  propertyKey: string;
}

interface AnnualRow {
  key: string;
  name: string;
  values: Array<number | null>;
}

interface T12Row {
  key: string;
  accountCode: string | null;
  name: string;
  total: number | null;
}

interface AnnualReport {
  file: IEInputFile;
  propertyName: string;
  years: string[];
  rows: AnnualRow[];
}

interface T12Report {
  file: IEInputFile;
  propertyName: string;
  label: string;
  rows: T12Row[];
}

interface BudgetReport {
  file: IEInputFile;
  propertyName: string;
  label: string;
  rows: T12Row[];
}

interface AnnualizedReport {
  file: IEInputFile;
  propertyName: string;
  label: string;
  rows: T12Row[];
}

interface InternalNumberMapping {
  exact: Map<string, string | number>;
  candidates: Array<[string, string | number]>;
}

interface ParsedWorkbook {
  workbook: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
}

interface PropertyGroup {
  displayName: string;
  annualFiles: IEInputFile[];
  t12Files: IEInputFile[];
  separateAnnualFiles: IEInputFile[];
  budgetFiles: IEInputFile[];
  annualizedFiles: IEInputFile[];
}

interface MergedRow {
  accountCode: string | null;
  name: string;
  values: Array<number | null>;
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    const maybeRichText = value as {
      richText?: Array<{ text?: string }>;
      text?: string;
      result?: unknown;
    };

    if (Array.isArray(maybeRichText.richText)) {
      return maybeRichText.richText
        .map((part) => part.text ?? "")
        .join("")
        .trim()
        .replace(/\s+/g, " ");
    }

    if (typeof maybeRichText.text === "string") {
      return maybeRichText.text.trim().replace(/\s+/g, " ");
    }

    if (maybeRichText.result !== undefined) {
      return cleanText(maybeRichText.result);
    }
  }

  return String(value).trim().replace(/\s+/g, " ");
}

function normalizeName(value: unknown): string {
  return cleanText(value).toLocaleLowerCase();
}

function cleanPropertyName(value: unknown): string {
  return cleanText(value)
    .replace(/\s*\([^()]*\d[^()]*\)\s*$/i, "")
    .trim();
}

function normalizePropertyName(value: unknown): string {
  return cleanPropertyName(value)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bapartments?\b\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "");

  return cleaned || "Combined IE";
}

function normalizeMappingName(value: unknown): string {
  return cleanText(value)
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function numericCellValue(cell: ExcelJS.Cell): number | null {
  const value = cell.value;

  if (isNumber(value)) {
    return value;
  }

  if (value && typeof value === "object" && "result" in value) {
    const result = (value as { result?: unknown }).result;

    if (isNumber(result)) {
      return result;
    }
  }

  return null;
}

function rawCellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;

  if (value && typeof value === "object" && "result" in value) {
    const result = (value as { result?: unknown }).result;

    if (result !== undefined && result !== null) {
      return result;
    }
  }

  return value;
}

function excelDateToYear(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return String(value.getFullYear());
  }

  const text = cleanText(value);
  const match = text.match(/\b(?:19|20)\d{2}\b/);

  return match?.[0] ?? null;
}

function monthYearFromValue(
  value: unknown
): { month: string; year: string } | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = value.toLocaleString("en-US", { month: "short" });
    return {
      month,
      year: String(value.getFullYear()),
    };
  }

  const text = cleanText(value);

  const match = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{2,4})\b/i
  );

  if (!match) {
    return null;
  }

  const month = match[1].slice(0, 3);
  const formattedMonth =
    month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();

  let year = match[2];

  if (year.length === 2) {
    year = `20${year}`;
  }

  return {
    month: formattedMonth,
    year,
  };
}

function occurrenceKey(name: string, occurrence: number): string {
  return `${normalizeName(name)}\u0000${occurrence}`;
}

async function loadWorkbook(
  buffer: Buffer
): Promise<ParsedWorkbook> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(
    buffer as unknown as Parameters<
      typeof workbook.xlsx.load
    >[0]
  );

  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw new Error(
      "The workbook does not contain a worksheet."
    );
  }

  return {
    workbook,
    worksheet,
  };
}

function getFirstCellsText(worksheet: ExcelJS.Worksheet): string[] {
  const values: string[] = [];
  const maxRow = Math.min(worksheet.rowCount, 12);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);

    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      const text = cleanText(rawCellValue(row.getCell(columnNumber)));

      if (text) {
        values.push(text.toLocaleLowerCase());
      }
    }
  }

  return values;
}

function parsePeriod(
  text: string
): {
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
} | null {
  const match = text.match(
    /period\s*=\s*([a-z]{3,9})\s+(\d{4})\s*[-–]\s*([a-z]{3,9})\s+(\d{4})/i
  );

  if (!match) {
    return null;
  }

  return {
    startMonth: match[1],
    startYear: match[2],
    endMonth: match[3],
    endYear: match[4],
  };
}

async function inspectFile(file: IEInputFile): Promise<FileInfo | null> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    const extraction = await extractPdfIE(file.buffer);

if (
  extraction.reportType !== "annual" &&
  extraction.reportType !== "t12" &&
  extraction.reportType !== "budget" &&
  extraction.reportType !== "annualized"
) {
  return null;
}

    const propertyName = cleanPropertyName(
      extraction.propertyName
    );

    const propertyKey = normalizePropertyName(
      extraction.propertyName
    );

    if (!propertyKey) {
      throw new Error(
        `${file.name}: could not find a usable property name.`
      );
    }

    return {
      file,
      reportType: extraction.reportType,
      propertyName,
      propertyKey,
    };
  }

  const { worksheet } = await loadWorkbook(file.buffer);

  const firstCells = getFirstCellsText(worksheet);
  const text = firstCells.join(" | ");

  let rawPropertyName: unknown;
  let reportType: ReportType;

if (text.includes("annual statement")) {
  rawPropertyName = rawCellValue(worksheet.getCell("A1"));
  reportType = "annual";
} else if (text.includes("statement of operations")) {
  rawPropertyName =
    rawCellValue(worksheet.getCell("A1")) ||
    rawCellValue(worksheet.getCell("B1")) ||
    rawCellValue(worksheet.getCell("C1"));

  reportType = "separate_annual";
} else if (text.includes("cash flow (12 months)")) {
    rawPropertyName = rawCellValue(worksheet.getCell("A1"));
    reportType = "t12";
  } else if (text.includes("budget") && text.includes("period")) {
    rawPropertyName = rawCellValue(worksheet.getCell("A3"));
    reportType = "budget";
  } else if (
    text.includes("statement (12 months)") &&
    text.includes("period")
  ) {
    rawPropertyName = rawCellValue(worksheet.getCell("A3"));

    const period = parsePeriod(firstCells.join(" "));

    if (
      period &&
      period.startYear === period.endYear &&
      period.startMonth.slice(0, 3).toLocaleLowerCase() === "jan" &&
      period.endMonth.slice(0, 3).toLocaleLowerCase() === "dec"
    ) {
      reportType = "separate_annual";
    } else {
      reportType = "t12";
    }
  } else {
    return null;
  }

  const propertyName = cleanPropertyName(rawPropertyName);
  const propertyKey = normalizePropertyName(rawPropertyName);

  if (!propertyKey) {
    throw new Error(
      `${file.name}: could not find a usable property name.`
    );
  }

  return {
    file,
    reportType,
    propertyName: propertyName || cleanText(rawPropertyName),
    propertyKey,
  };
}

function findAnnualHeader(
  worksheet: ExcelJS.Worksheet
): {
  headerRow: number;
  yearColumns: number[];
  years: string[];
} {
  let best:
    | {
        headerRow: number;
        yearColumns: number[];
        years: string[];
      }
    | undefined;

  const maxRow = Math.min(worksheet.rowCount, 30);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const yearColumns: number[] = [];
    const years: string[] = [];

    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      const cell = worksheet.getRow(rowNumber).getCell(columnNumber);
      const year = excelDateToYear(rawCellValue(cell));

      if (year) {
        yearColumns.push(columnNumber);
        years.push(year);
      }
    }

    if (
      yearColumns.length > 0 &&
      (!best || yearColumns.length > best.yearColumns.length)
    ) {
      best = {
        headerRow: rowNumber,
        yearColumns,
        years,
      };
    }
  }

  if (!best) {
    throw new Error(
      "Could not find any annual year columns in the Annual Statement."
    );
  }

  return best;
}

async function readAnnualReport(
  file: IEInputFile
): Promise<AnnualReport> {
  const { worksheet } = await loadWorkbook(file.buffer);

  const propertyName = cleanPropertyName(
    rawCellValue(worksheet.getCell("A1"))
  );

  const { headerRow, yearColumns, years } =
    findAnnualHeader(worksheet);

  const occurrenceCounts = new Map<string, number>();
  const rows: AnnualRow[] = [];

  for (
    let rowNumber = headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    const name = cleanText(rawCellValue(row.getCell(1)));

    if (!name) {
      continue;
    }

    const values = yearColumns.map((columnNumber) =>
      numericCellValue(row.getCell(columnNumber))
    );

    if (!values.some((value) => value !== null)) {
      continue;
    }

    const normalized = normalizeName(name);
    const occurrence = (occurrenceCounts.get(normalized) ?? 0) + 1;

    occurrenceCounts.set(normalized, occurrence);

    rows.push({
      key: occurrenceKey(name, occurrence),
      name,
      values,
    });
  }

  return {
    file,
    propertyName,
    years,
    rows,
  };
}

function findT12Columns(
  worksheet: ExcelJS.Worksheet
): {
  headerRow: number;
  nameColumn: number;
  totalColumn: number;
  monthColumns: number[];
} {
  const maxRow = Math.min(worksheet.rowCount, 30);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);

    let totalColumn: number | null = null;

    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      if (
        cleanText(rawCellValue(row.getCell(columnNumber))).toLocaleLowerCase() ===
        "total"
      ) {
        totalColumn = columnNumber;
        break;
      }
    }

    if (totalColumn === null) {
      continue;
    }

    const monthColumns: number[] = [];

    for (
      let columnNumber = 1;
      columnNumber < totalColumn;
      columnNumber += 1
    ) {
      const value = rawCellValue(row.getCell(columnNumber));

      if (
        value instanceof Date ||
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*\b\d{2,4}\b/i.test(
          cleanText(value)
        )
      ) {
        monthColumns.push(columnNumber);
      }
    }

    if (monthColumns.length === 0) {
      continue;
    }

    const firstMonthColumn = Math.min(...monthColumns);
    const nameColumn = firstMonthColumn - 1;

    if (nameColumn < 1) {
      throw new Error(
        "Could not determine the T12 line-item column."
      );
    }

    return {
      headerRow: rowNumber,
      nameColumn,
      totalColumn,
      monthColumns,
    };
  }

  throw new Error(
    "Could not find the T12 Total column and monthly headers."
  );
}

function findT12Label(
  worksheet: ExcelJS.Worksheet,
  headerRow: number,
  monthColumns: number[]
): string {
  const maxRow = Math.min(headerRow, 15);
  const maxColumn = Math.min(worksheet.columnCount, 5);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    for (
      let columnNumber = 1;
      columnNumber <= maxColumn;
      columnNumber += 1
    ) {
      const text = cleanText(
        rawCellValue(
          worksheet.getRow(rowNumber).getCell(columnNumber)
        )
      );

      const match = text.match(
        /Period\s*=\s*([A-Za-z]{3,9})\s+(\d{4})\s*[-–]/i
      );

      if (match) {
        const month =
          match[1].charAt(0).toUpperCase() +
          match[1].slice(1, 3).toLowerCase();

        return `T12 ${month} '${match[2].slice(-2)}`;
      }
    }
  }

  const firstMonthColumn = Math.min(...monthColumns);
  const firstMonthValue = rawCellValue(
    worksheet.getRow(headerRow).getCell(firstMonthColumn)
  );

  const parsed = monthYearFromValue(firstMonthValue);

  if (parsed) {
    return `T12 ${parsed.month} '${parsed.year.slice(-2)}`;
  }

  return "T12";
}

function readT12Rows(
  worksheet: ExcelJS.Worksheet,
  headerRow: number,
  nameColumn: number,
  totalColumn: number
): T12Row[] {
  const occurrenceCounts = new Map<string, number>();
  const rows: T12Row[] = [];

  const accountColumn =
    nameColumn > 1 ? nameColumn - 1 : null;

  for (
    let rowNumber = headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);

    const name = cleanText(
      rawCellValue(row.getCell(nameColumn))
    );

    if (!name) {
      continue;
    }

    const total = numericCellValue(row.getCell(totalColumn));

    if (total === null) {
      continue;
    }

    const accountCode =
      accountColumn !== null
        ? cleanText(rawCellValue(row.getCell(accountColumn)))
        : "";

    const normalized = normalizeName(name);
    const occurrence = (occurrenceCounts.get(normalized) ?? 0) + 1;

    occurrenceCounts.set(normalized, occurrence);

    rows.push({
      key: occurrenceKey(name, occurrence),
      accountCode: accountCode || null,
      name,
      total,
    });
  }

  return rows;
}

async function readT12Report(
  file: IEInputFile
): Promise<T12Report> {
  const { worksheet } = await loadWorkbook(file.buffer);

  const propertyName = cleanPropertyName(
    rawCellValue(worksheet.getCell("A1"))
  );

  const {
    headerRow,
    nameColumn,
    totalColumn,
    monthColumns,
  } = findT12Columns(worksheet);

  const label = findT12Label(
    worksheet,
    headerRow,
    monthColumns
  );

  const rows = readT12Rows(
    worksheet,
    headerRow,
    nameColumn,
    totalColumn
  );

  return {
    file,
    propertyName,
    label,
    rows,
  };
}

async function readOSStatement(
  file: IEInputFile,
  kind: "annual" | "t12" | "budget"
): Promise<{
  propertyName: string;
  label: string;
  rows: T12Row[];
}> {
  const { worksheet } = await loadWorkbook(file.buffer);

  const propertyName = cleanPropertyName(
    rawCellValue(worksheet.getCell("A3"))
  );

  const {
    headerRow,
    nameColumn,
    totalColumn,
    monthColumns,
  } = findT12Columns(worksheet);

  const periodParts: string[] = [];

  for (
    let rowNumber = 1;
    rowNumber <= Math.min(headerRow, 10);
    rowNumber += 1
  ) {
    const text = cleanText(
      rawCellValue(worksheet.getRow(rowNumber).getCell(1))
    );

    if (text) {
      periodParts.push(text);
    }
  }

  const period = parsePeriod(periodParts.join(" "));

  let label: string;

  if (kind === "budget") {
    const fallbackYear = excelDateToYear(
      rawCellValue(
        worksheet
          .getRow(headerRow)
          .getCell(monthColumns[monthColumns.length - 1])
      )
    );

    const year = period?.endYear ?? fallbackYear ?? "";
    label = `${year} Budget`.trim();
  } else if (kind === "annual") {
    const fallbackYear = excelDateToYear(
      rawCellValue(
        worksheet
          .getRow(headerRow)
          .getCell(monthColumns[monthColumns.length - 1])
      )
    );

    label = period?.endYear ?? fallbackYear ?? "";
  } else {
    if (period) {
      const month =
        period.endMonth.charAt(0).toUpperCase() +
        period.endMonth.slice(1, 3).toLowerCase();

      label = `T12 ${month} '${period.endYear.slice(-2)}`;
    } else {
      label = findT12Label(
        worksheet,
        headerRow,
        monthColumns
      );
    }
  }

  const rows = readT12Rows(
    worksheet,
    headerRow,
    nameColumn,
    totalColumn
  );

  return {
    propertyName,
    label,
    rows,
  };
}

async function readStatementOfOperationsAnnual(
  file: IEInputFile
): Promise<{
  propertyName: string;
  label: string;
  rows: T12Row[];
}> {
  const { worksheet } = await loadWorkbook(file.buffer);

  // Property name can be in A1, B1, or C1 depending on the year.
  const propertyName = cleanPropertyName(
    rawCellValue(worksheet.getCell("A1")) ||
      rawCellValue(worksheet.getCell("B1")) ||
      rawCellValue(worksheet.getCell("C1"))
  );

  let ytdActualColumn: number | null = null;
  let headerRow: number | null = null;
  let year: string | null = null;

  const maxHeaderRow = Math.min(worksheet.rowCount, 15);

  for (
    let rowNumber = 1;
    rowNumber <= maxHeaderRow;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);

    for (
      let columnNumber = 1;
      columnNumber <= worksheet.columnCount;
      columnNumber += 1
    ) {
      const text = cleanText(
        rawCellValue(row.getCell(columnNumber))
      ).toLocaleLowerCase();

      if (text !== "year to date") {
        continue;
      }

      // The YTD Actual column is normally immediately
      // to the left of the "Year To Date" heading.
      const possibleActualColumn = columnNumber - 1;

      if (possibleActualColumn < 1) {
        continue;
      }

      // Look below the Year To Date heading for ACTUAL.
      for (
        let checkRow = rowNumber + 1;
        checkRow <= Math.min(rowNumber + 3, worksheet.rowCount);
        checkRow += 1
      ) {
        const actualText = cleanText(
          rawCellValue(
            worksheet
              .getRow(checkRow)
              .getCell(possibleActualColumn)
          )
        ).toLocaleLowerCase();

        if (actualText === "actual") {
          ytdActualColumn = possibleActualColumn;
          headerRow = checkRow;

          // Find the year near the YTD heading.
          for (
            let yearRow = rowNumber;
            yearRow <= Math.min(rowNumber + 2, worksheet.rowCount);
            yearRow += 1
          ) {
            for (
              let yearColumn = possibleActualColumn;
              yearColumn <= Math.min(
                possibleActualColumn + 2,
                worksheet.columnCount
              );
              yearColumn += 1
            ) {
              const foundYear = excelDateToYear(
                rawCellValue(
                  worksheet
                    .getRow(yearRow)
                    .getCell(yearColumn)
                )
              );

              if (foundYear) {
                year = foundYear;
                break;
              }
            }

            if (year) {
              break;
            }
          }

          break;
        }
      }

      if (ytdActualColumn !== null) {
        break;
      }
    }

    if (ytdActualColumn !== null) {
      break;
    }
  }

  if (
    ytdActualColumn === null ||
    headerRow === null ||
    !year
  ) {
    throw new Error(
      `${file.name}: could not find the Year To Date ACTUAL column.`
    );
  }

  const occurrenceCounts = new Map<string, number>();
  const rows: T12Row[] = [];

  for (
    let rowNumber = headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);

    const rawName = cleanText(
      rawCellValue(row.getCell(1))
    );

    if (!rawName) {
      continue;
    }

    const total = numericCellValue(
      row.getCell(ytdActualColumn)
    );

    if (total === null) {
      continue;
    }

    // High Pointe stores account code and line item together:
    // 500000 - Market Rent
    const match = rawName.match(
      /^\s*(\d+)\s*[-–—]\s*(.+?)\s*$/
    );

    const accountCode = match ? match[1] : null;
    const name = match ? match[2].trim() : rawName;

    const normalized = normalizeName(name);
    const occurrence =
      (occurrenceCounts.get(normalized) ?? 0) + 1;

    occurrenceCounts.set(normalized, occurrence);

    rows.push({
      key: occurrenceKey(name, occurrence),
      accountCode,
      name,
      total,
    });
  }

  if (rows.length === 0) {
    throw new Error(
      `${file.name}: no valued Year To Date ACTUAL rows were found.`
    );
  }

  return {
    propertyName,
    label: year,
    rows,
  };
}

async function combineSeparateAnnuals(
  files: IEInputFile[]
): Promise<AnnualReport> {
  if (files.length === 0) {
    throw new Error(
      "No separate annual statements were supplied."
    );
  }

  const reports: Array<{
    year: number;
    file: IEInputFile;
    propertyName: string;
    rows: T12Row[];
  }> = [];

 for (const file of files) {
  const { worksheet } = await loadWorkbook(file.buffer);
  const firstCells = getFirstCellsText(worksheet);
  const text = firstCells.join(" | ");

  const report = text.includes("statement of operations")
    ? await readStatementOfOperationsAnnual(file)
    : await readOSStatement(file, "annual");

  const year = Number.parseInt(report.label, 10);

    if (!Number.isFinite(year)) {
      throw new Error(
        `${file.name}: could not determine the annual year.`
      );
    }

    reports.push({
      year,
      file,
      propertyName: report.propertyName,
      rows: report.rows,
    });
  }

  reports.sort((a, b) => a.year - b.year);

  const propertyName = reports[0].propertyName;
  const propertyKey = normalizePropertyName(propertyName);

  for (const report of reports.slice(1)) {
    if (
      normalizePropertyName(report.propertyName) !== propertyKey
    ) {
      throw new Error(
        "Separate YE property names do not match."
      );
    }
  }

  const years = reports.map((report) =>
    String(report.year)
  );

  const order: string[] = [];
  const names = new Map<string, string>();

  const byYear = reports.map((report) => {
    const map = new Map<string, T12Row>();

    for (const row of report.rows) {
      map.set(row.key, row);

      if (!names.has(row.key)) {
        names.set(row.key, row.name);
      }

      if (!order.includes(row.key)) {
        order.push(row.key);
      }
    }

    return map;
  });

  const rows: AnnualRow[] = order.map((key) => ({
    key,
    name: names.get(key) ?? "",
    values: byYear.map(
      (yearMap) => yearMap.get(key)?.total ?? null
    ),
  }));

  return {
    file: reports[0].file,
    propertyName,
    years,
    rows,
  };
}

async function readBudgetReport(
  file: IEInputFile
): Promise<BudgetReport> {
  const report = await readOSStatement(file, "budget");

  return {
    file,
    propertyName: report.propertyName,
    label: report.label,
    rows: report.rows,
  };
}

function pdfRowsToAnnualRows(
  extraction: PdfIEExtractionResult
): AnnualRow[] {
  const occurrenceCounts = new Map<string, number>();

  return extraction.rows.map((row) => {
    const normalized = normalizeName(row.name);
    const occurrence =
      (occurrenceCounts.get(normalized) ?? 0) + 1;

    occurrenceCounts.set(normalized, occurrence);

    return {
      key: occurrenceKey(row.name, occurrence),
      name: row.name,
      values: [...row.values],
    };
  });
}

function pdfRowsToT12Rows(
  extraction: PdfIEExtractionResult
): T12Row[] {
  const occurrenceCounts = new Map<string, number>();

  return extraction.rows.map((row) => {
    const normalized = normalizeName(row.name);
    const occurrence =
      (occurrenceCounts.get(normalized) ?? 0) + 1;

    occurrenceCounts.set(normalized, occurrence);

    return {
      key: occurrenceKey(row.name, occurrence),
      accountCode: row.accountCode,
      name: row.name,
      total: row.values[0] ?? null,
    };
  });
}

async function readPdfAnnualReport(
  file: IEInputFile
): Promise<AnnualReport> {
  const extraction = await extractPdfIE(file.buffer);

  if (extraction.reportType !== "annual") {
    throw new Error(
      `${file.name} is not a recognized Annual I&E PDF.`
    );
  }

  return {
    file,
    propertyName: extraction.propertyName,
    years: extraction.labels,
    rows: pdfRowsToAnnualRows(extraction),
  };
}

async function combineAnnualReports(
  files: IEInputFile[]
): Promise<AnnualReport> {
  if (files.length === 0) {
    throw new Error(
      "No Annual Statements were supplied."
    );
  }

  const reports: AnnualReport[] = [];

  for (const file of files) {
    const report = file.name
      .toLowerCase()
      .endsWith(".pdf")
      ? await readPdfAnnualReport(file)
      : await readAnnualReport(file);

    reports.push(report);
  }

  const propertyName =
    reports[0].propertyName;

  const propertyKey =
    normalizePropertyName(propertyName);

  for (const report of reports.slice(1)) {
    if (
      normalizePropertyName(
        report.propertyName
      ) !== propertyKey
    ) {
      throw new Error(
        `Annual Statement property names do not match: '${propertyName}' vs '${report.propertyName}'.`
      );
    }
  }

  /*
   * Flatten every annual period into an individual
   * year so this works for BOTH:
   *
   * - one multi-year Annual Statement
   * - multiple one-year Annual Statements
   */
  const periods: Array<{
    year: string;
    report: AnnualReport;
    valueIndex: number;
  }> = [];

  for (const report of reports) {
    for (
      let index = 0;
      index < report.years.length;
      index += 1
    ) {
      periods.push({
        year: report.years[index],
        report,
        valueIndex: index,
      });
    }
  }

  periods.sort(
    (a, b) =>
      Number(a.year) - Number(b.year)
  );

  /*
   * Do not silently accept two sources for
   * the same year.
   */
  const seenYears = new Set<string>();

  for (const period of periods) {
    if (seenYears.has(period.year)) {
      throw new Error(
        `Multiple Annual Statements contain year ${period.year}.`
      );
    }

    seenYears.add(period.year);
  }

  const years =
    periods.map((period) => period.year);

  /*
   * Build the master row order from all reports.
   */
  const order: string[] = [];
  const names =
    new Map<string, string>();

  for (const report of reports) {
    for (const row of report.rows) {
      if (!names.has(row.key)) {
        names.set(
          row.key,
          row.name
        );
      }

      if (!order.includes(row.key)) {
        order.push(row.key);
      }
    }
  }

  /*
   * One lookup map per annual report.
   */
  const reportMaps =
    new Map<
      AnnualReport,
      Map<string, AnnualRow>
    >();

  for (const report of reports) {
    reportMaps.set(
      report,
      new Map(
        report.rows.map(
          (row) => [row.key, row]
        )
      )
    );
  }

  const rows: AnnualRow[] =
    order.map((key) => {
      const values =
        periods.map((period) => {
          const row =
            reportMaps
              .get(period.report)
              ?.get(key);

          return (
            row?.values[
              period.valueIndex
            ] ?? null
          );
        });

      return {
        key,
        name:
          names.get(key) ?? "",
        values,
      };
    });

  return {
    file: reports[0].file,
    propertyName,
    years,
    rows,
  };
}


async function readPdfT12Report(
  file: IEInputFile
): Promise<T12Report> {
  const extraction = await extractPdfIE(file.buffer);

  if (extraction.reportType !== "t12") {
    throw new Error(
      `${file.name} is not a recognized T12 I&E PDF.`
    );
  }

  return {
    file,
    propertyName: extraction.propertyName,
    label: extraction.labels[0] ?? "T12",
    rows: pdfRowsToT12Rows(extraction),
  };
}

async function readPdfBudgetReport(
  file: IEInputFile
): Promise<BudgetReport> {
  const extraction = await extractPdfIE(file.buffer);

  /*
   * Normal PDF Budget:
   * the primary extraction itself is the budget.
   */
  if (extraction.reportType === "budget") {
    return {
      file,
      propertyName: extraction.propertyName,
      label: extraction.labels[0] ?? "Budget",
      rows: pdfRowsToT12Rows(extraction),
    };
  }

  /*
   * Combined Actual + Budget PDF:
   * the primary report is Annual and the Budget
   * is stored in additionalReports.
   */
  const additionalBudget =
    extraction.additionalReports?.find(
      (report) => report.reportType === "budget"
    );

  if (additionalBudget) {
    const budgetExtraction: PdfIEExtractionResult = {
      propertyName: extraction.propertyName,
      reportType: "budget",
      labels: additionalBudget.labels,
      rows: additionalBudget.rows,
      pageCount: extraction.pageCount,
      warnings: extraction.warnings,
    };

    return {
      file,
      propertyName: extraction.propertyName,
      label:
        additionalBudget.labels[0] ??
        "Budget",
      rows:
        pdfRowsToT12Rows(
          budgetExtraction
        ),
    };
  }

  throw new Error(
    `${file.name} is not a recognized Budget I&E PDF.`
  );
}

async function readPdfAnnualizedReport(
  file: IEInputFile
): Promise<AnnualizedReport> {
  const extraction = await extractPdfIE(file.buffer);

  if (extraction.reportType !== "annualized") {
    throw new Error(
      `${file.name} is not a recognized Annualized I&E PDF.`
    );
  }

  return {
    file,
    propertyName: extraction.propertyName,
    label: extraction.labels[0] ?? "T8 Annualized",
    rows: pdfRowsToT12Rows(extraction),
  };
}


function mergeReports(
  annual: AnnualReport | null,
  t12: T12Report | null
): MergedRow[] {
  if (!annual && !t12) {
    throw new Error(
      "At least one Annual Statement or T12 report is required."
    );
  }

  if (!annual && t12) {
    return t12.rows.map((row) => ({
      accountCode: row.accountCode,
      name: row.name,
      values: [row.total],
    }));
  }

  if (annual && !t12) {
    return annual.rows.map((row) => ({
      accountCode: null,
      name: row.name,
      values: [...row.values],
    }));
  }

  if (!annual || !t12) {
    throw new Error("Could not merge the supplied reports.");
  }

  const annualByKey = new Map(
    annual.rows.map((row) => [row.key, row])
  );

  const t12ByKey = new Map(
    t12.rows.map((row) => [row.key, row])
  );

  const annualOrder = annual.rows.map((row) => row.key);
  const t12Order = t12.rows.map((row) => row.key);

  const combinedOrder = [...annualOrder];

  for (
    let index = 0;
    index < t12Order.length;
    index += 1
  ) {
    const key = t12Order[index];

    if (annualByKey.has(key)) {
      continue;
    }

    let insertAt = combinedOrder.length;

    for (
      let nextIndex = index + 1;
      nextIndex < t12Order.length;
      nextIndex += 1
    ) {
      const nextKey = t12Order[nextIndex];
      const existingIndex = combinedOrder.indexOf(nextKey);

      if (existingIndex !== -1) {
        insertAt = existingIndex;
        break;
      }
    }

    combinedOrder.splice(insertAt, 0, key);
  }

  return combinedOrder.map((key) => {
    const annualRow = annualByKey.get(key);
    const t12Row = t12ByKey.get(key);

    return {
      accountCode: t12Row?.accountCode ?? null,
      name: annualRow?.name ?? t12Row?.name ?? "",
      values: [
        ...(annualRow?.values ??
          new Array(annual.years.length).fill(null)),
        t12Row?.total ?? null,
      ],
    };
  });
}

function validateOutput(
  annual: AnnualReport | null,
  t12: T12Report | null,
  rows: MergedRow[]
): void {
  const expectedKeys = new Set<string>();

  if (annual) {
    for (const row of annual.rows) {
      expectedKeys.add(row.key);
    }
  }

  if (t12) {
    for (const row of t12.rows) {
      expectedKeys.add(row.key);
    }
  }

  if (rows.length !== expectedKeys.size) {
    throw new Error(
      `Validation failed: expected ${expectedKeys.size} unique valued lines, but produced ${rows.length} output rows.`
    );
  }

  if (annual && t12 && rows.length > 0) {
    const finalName = normalizeName(
      rows[rows.length - 1].name
    );

    const annualFinal =
      annual.rows.length > 0
        ? annual.rows[annual.rows.length - 1].name
        : "";

    const t12Final =
      t12.rows.length > 0
        ? t12.rows[t12.rows.length - 1].name
        : "";

    if (
      normalizeName(annualFinal) === normalizeName(t12Final) &&
      finalName !== normalizeName(annualFinal)
    ) {
      throw new Error(
        `Validation failed: the shared final line '${annualFinal}' is not last.`
      );
    }
  }
}

function levenshteinDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

/*
 * Python's difflib.SequenceMatcher is not the same algorithm as
 * Levenshtein similarity. This implementation follows the matching-block
 * approach closely enough for the conservative 0.90 mapping threshold.
 */
function longestCommonSubstring(
  a: string,
  b: string,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): {
  aIndex: number;
  bIndex: number;
  size: number;
} {
  let bestA = aStart;
  let bestB = bStart;
  let bestSize = 0;

  let previous = new Map<number, number>();

  for (let i = aStart; i < aEnd; i += 1) {
    const current = new Map<number, number>();

    for (let j = bStart; j < bEnd; j += 1) {
      if (a[i] !== b[j]) {
        continue;
      }

      const size = (previous.get(j - 1) ?? 0) + 1;
      current.set(j, size);

      if (size > bestSize) {
        bestSize = size;
        bestA = i - size + 1;
        bestB = j - size + 1;
      }
    }

    previous = current;
  }

  return {
    aIndex: bestA,
    bIndex: bestB,
    size: bestSize,
  };
}

function sequenceMatcherRatio(a: string, b: string): number {
  if (!a && !b) {
    return 1;
  }

  if (!a || !b) {
    return 0;
  }

  const blocks: Array<{
    aStart: number;
    aEnd: number;
    bStart: number;
    bEnd: number;
  }> = [
    {
      aStart: 0,
      aEnd: a.length,
      bStart: 0,
      bEnd: b.length,
    },
  ];

  let matchingCharacters = 0;

  while (blocks.length > 0) {
    const block = blocks.pop();

    if (!block) {
      continue;
    }

    const match = longestCommonSubstring(
      a,
      b,
      block.aStart,
      block.aEnd,
      block.bStart,
      block.bEnd
    );

    if (match.size === 0) {
      continue;
    }

    matchingCharacters += match.size;

    if (
      block.aStart < match.aIndex &&
      block.bStart < match.bIndex
    ) {
      blocks.push({
        aStart: block.aStart,
        aEnd: match.aIndex,
        bStart: block.bStart,
        bEnd: match.bIndex,
      });
    }

    const afterA = match.aIndex + match.size;
    const afterB = match.bIndex + match.size;

    if (
      afterA < block.aEnd &&
      afterB < block.bEnd
    ) {
      blocks.push({
        aStart: afterA,
        aEnd: block.aEnd,
        bStart: afterB,
        bEnd: block.bEnd,
      });
    }
  }

  return (2 * matchingCharacters) / (a.length + b.length);
}

async function loadInternalNumberMapping(): Promise<InternalNumberMapping> {
  const mappingPath = path.join(
    process.cwd(),
    "src",
    "lib",
    "automation",
    "ie",
    "reference",
    "To add I&E.xlsx"
  );

  let buffer: Buffer;

  try {
    buffer = await fs.readFile(mappingPath);
  } catch {
    throw new Error(
      "The internal-number reference workbook could not be found."
    );
  }

  const { worksheet } = await loadWorkbook(buffer);

  let headerRow: number | null = null;
  let numberColumn: number | null = null;
  let nameColumn: number | null = null;

  const maxRows = Math.min(worksheet.rowCount, 25);
  const maxColumns = Math.min(worksheet.columnCount, 20);

  for (
    let rowNumber = 1;
    rowNumber <= maxRows;
    rowNumber += 1
  ) {
    const headers = new Map<string, number>();

    for (
      let columnNumber = 1;
      columnNumber <= maxColumns;
      columnNumber += 1
    ) {
      const text = cleanText(
        rawCellValue(
          worksheet.getRow(rowNumber).getCell(columnNumber)
        )
      ).toLocaleLowerCase();

      if (text) {
        headers.set(text, columnNumber);
      }
    }

    if (headers.has("number") && headers.has("name")) {
      headerRow = rowNumber;
      numberColumn = headers.get("number") ?? null;
      nameColumn = headers.get("name") ?? null;
      break;
    }
  }

  if (
    headerRow === null ||
    numberColumn === null ||
    nameColumn === null
  ) {
    throw new Error(
      "Could not find columns named 'Number' and 'Name' in the internal-number reference workbook."
    );
  }

  const exact = new Map<string, string | number>();

  for (
    let rowNumber = headerRow + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);

    const numberCell = rawCellValue(
      row.getCell(numberColumn)
    );

    const name = cleanText(
      rawCellValue(row.getCell(nameColumn))
    );

    if (
      numberCell === null ||
      numberCell === undefined ||
      typeof numberCell === "boolean" ||
      !name
    ) {
      continue;
    }

    let internalNumber: string | number | null = null;

    if (typeof numberCell === "number") {
      internalNumber = Number.isInteger(numberCell)
        ? Math.trunc(numberCell)
        : numberCell;
    } else {
      const text = cleanText(numberCell);

      if (text) {
        internalNumber = text;
      }
    }

    if (internalNumber === null) {
      continue;
    }

    const normalized = normalizeMappingName(name);

    if (!normalized) {
      continue;
    }

    // Same behavior as Python: later duplicates override earlier ones.
    exact.set(normalized, internalNumber);
  }

  if (exact.size === 0) {
    throw new Error(
      "No usable Number/Name mappings were found in the internal-number reference workbook."
    );
  }

  return {
    exact,
    candidates: Array.from(exact.entries()),
  };
}

function findInternalNumber(
  lineItem: unknown,
  mapping: InternalNumberMapping
): string | number | null {
  const normalized = normalizeMappingName(lineItem);

  if (!normalized) {
    return null;
  }

  const exactMatch = mapping.exact.get(normalized);

  if (exactMatch !== undefined) {
    return exactMatch;
  }

  if (normalized.length < 6) {
    return null;
  }

  const sourceTokens = new Set(
    normalized.split(" ").filter(Boolean)
  );

  const scored: Array<{
    ratio: number;
    number: string | number;
  }> = [];

  for (const [candidateName, internalNumber] of mapping.candidates) {
    const candidateTokens = new Set(
      candidateName.split(" ").filter(Boolean)
    );

    if (candidateTokens.size === 0) {
      continue;
    }

    const intersection = Array.from(sourceTokens).filter(
      (token) => candidateTokens.has(token)
    ).length;

    const union = new Set([
      ...Array.from(sourceTokens),
      ...Array.from(candidateTokens),
    ]).size;

    const overlap =
      union > 0 ? intersection / union : 0;

    const contains =
      normalized.includes(candidateName) ||
      candidateName.includes(normalized);

    const lengthRatio =
      Math.min(normalized.length, candidateName.length) /
      Math.max(normalized.length, candidateName.length);

    if (
      overlap < 0.6 &&
      !(contains && lengthRatio >= 0.75)
    ) {
      continue;
    }

    const ratio = sequenceMatcherRatio(
      normalized,
      candidateName
    );

    scored.push({
      ratio,
      number: internalNumber,
    });
  }

  if (scored.length === 0) {
    return null;
  }

  scored.sort((a, b) => b.ratio - a.ratio);

  const best = scored[0];
  const secondRatio =
    scored.length > 1 ? scored[1].ratio : 0;

  if (
    best.ratio >= 0.9 &&
    best.ratio - secondRatio >= 0.03
  ) {
    return best.number;
  }

  return null;
}

function getSignFlipNote(lineItem: string): string | null {
  const normalized = normalizeMappingName(lineItem);

  if (normalized.includes("model unit")) {
    return "Sign flipped - Model Units";
  }

  if (normalized.includes("employee discount")) {
    return "Sign flipped - Employee Discount";
  }

  return null;
}

function flipSignIfNeeded(
  value: number | null,
  shouldFlip: boolean
): number | null {
  if (value === null || !shouldFlip) {
    return value;
  }

  return value === 0 ? 0 : -value;
}


function isSummaryLine(lineItem: string): boolean {
  const normalized = cleanText(lineItem).toLocaleLowerCase();

  return (
    normalized === "total" ||
    normalized.startsWith("total ") ||
    normalized === "net" ||
    normalized.startsWith("net ")
  );
}

function findAnnualizedValue(
  lineItem: string,
  rows: T12Row[],
  usedIndexes: Set<number>
): number | null {
  const target = normalizeMappingName(lineItem);

  if (!target) {
    return null;
  }

  /*
   * 1. Exact match first.
   */
  for (let index = 0; index < rows.length; index += 1) {
    if (usedIndexes.has(index)) {
      continue;
    }

    const candidate = normalizeMappingName(
      rows[index].name
    );

    if (candidate === target) {
      usedIndexes.add(index);
      return rows[index].total;
    }
  }

  /*
   * 2. The annualized PDF truncates some descriptions.
   * Accept a prefix match when it is sufficiently specific.
   *
   * Example:
   * "NSF Fees Collec"
   * matches
   * "NSF Fees Collected"
   */
  const candidates: Array<{
    index: number;
    score: number;
  }> = [];

  for (let index = 0; index < rows.length; index += 1) {
    if (usedIndexes.has(index)) {
      continue;
    }

    const candidate = normalizeMappingName(
      rows[index].name
    );

    if (!candidate) {
      continue;
    }

    const shorter =
      target.length <= candidate.length
        ? target
        : candidate;

    const longer =
      target.length > candidate.length
        ? target
        : candidate;

    const prefixMatch =
      shorter.length >= 6 &&
      longer.startsWith(shorter);

    if (prefixMatch) {
      candidates.push({
        index,
        score: shorter.length / longer.length,
      });

      continue;
    }

    const score = sequenceMatcherRatio(
      target,
      candidate
    );

    if (score >= 0.85) {
      candidates.push({
        index,
        score,
      });
    }
  }

  candidates.sort(
    (a, b) => b.score - a.score
  );

  if (candidates.length === 0) {
    return null;
  }

  /*
   * Don't guess when two candidates are nearly identical.
   */
  if (
    candidates.length > 1 &&
    candidates[0].score - candidates[1].score < 0.03
  ) {
    return null;
  }

  const best = candidates[0];

  usedIndexes.add(best.index);

  return rows[best.index].total;
}



async function createOutputWorkbook(
  annual: AnnualReport | null,
  t12: T12Report | null,
  budget: BudgetReport | null,
  annualized: AnnualizedReport | null,
  rows: MergedRow[],
  mapping: InternalNumberMapping
): Promise<{
  buffer: Buffer;
  unmatchedCount: number;
}> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Combined I&E");

  const years = annual?.years ?? [];
  const t12Headers = t12 ? [t12.label] : [];
  const budgetHeaders = budget ? [budget.label] : [];

  const annualizedHeaders = annualized
  ? [annualized.label]
  : [];

const headers = [
  "Account Code",
  "Internal Number",
  "Line Item",
  ...years,
  ...t12Headers,
  ...budgetHeaders,
  ...annualizedHeaders,
  "Notes",
];

  worksheet.addRow(headers);

  const budgetOccurrence = new Map<string, number>();
  const budgetByKey = new Map<string, T12Row>();

  if (budget) {
    for (const row of budget.rows) {
      budgetByKey.set(row.key, row);
    }
  }

  const usedAnnualizedIndexes = new Set<number>();

  let unmatchedCount = 0;

  for (const row of rows) {
  const summary = isSummaryLine(row.name);
  const signFlipNote = getSignFlipNote(row.name);
  const shouldFlipSign = signFlipNote !== null;

    const internalNumber = summary
      ? null
      : findInternalNumber(row.name, mapping);

    let budgetValue: number | null = null;

    if (budget) {
      const normalized = normalizeName(row.name);
      const occurrence =
        (budgetOccurrence.get(normalized) ?? 0) + 1;

      budgetOccurrence.set(normalized, occurrence);

      const budgetRow = budgetByKey.get(
        occurrenceKey(row.name, occurrence)
      );

      if (budgetRow) {
        budgetValue = budgetRow.total;
      }
    }

    let annualizedValue: number | null = null;

    if (annualized) {
      annualizedValue = findAnnualizedValue(
        row.name,
        annualized.rows,
        usedAnnualizedIndexes
      );
    }

const outputValues: Array<
  string | number | null
> = [
  row.accountCode,
  internalNumber,
  row.name,
  ...row.values.map((value) =>
    flipSignIfNeeded(value, shouldFlipSign)
  ),
];

if (budget) {
  outputValues.push(
    flipSignIfNeeded(budgetValue, shouldFlipSign)
  );
}

if (annualized) {
  outputValues.push(
    flipSignIfNeeded(annualizedValue, shouldFlipSign)
  );
}

outputValues.push(signFlipNote);

    const writtenRow = worksheet.addRow(outputValues);

    if (summary) {
      for (
        let columnNumber = 1;
        columnNumber <= headers.length;
        columnNumber += 1
      ) {
        writtenRow.getCell(columnNumber).font = {
          ...writtenRow.getCell(columnNumber).font,
          bold: true,
        };
      }

      worksheet.addRow(
        new Array(headers.length).fill(null)
      );
    } else if (internalNumber === null) {
      unmatchedCount += 1;

      writtenRow.getCell(2).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: {
          argb: "FFFFF2CC",
        },
      };
    }
  }

  const headerRow = worksheet.getRow(1);

  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb: "FF1F4E78",
      },
    };

    cell.font = {
      color: {
        argb: "FFFFFFFF",
      },
      bold: true,
    };

    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
    };
  });

  const firstValueColumn = 4;
const lastValueColumn = headers.length - 1;

  for (
    let rowNumber = 2;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    for (
      let columnNumber = firstValueColumn;
      columnNumber <= lastValueColumn;
      columnNumber += 1
    ) {
      worksheet
        .getRow(rowNumber)
        .getCell(columnNumber).numFmt = CURRENCY_FORMAT;
    }
  }

  worksheet.views = [
    {
      state: "frozen",
      ySplit: 1,
    },
  ];

  worksheet.autoFilter = {
    from: {
      row: 1,
      column: 1,
    },
    to: {
      row: worksheet.rowCount,
      column: headers.length,
    },
  };

worksheet.getColumn(1).width = 16;
worksheet.getColumn(2).width = 18;
worksheet.getColumn(3).width = 38;

for (
  let columnNumber = 4;
  columnNumber <= lastValueColumn;
  columnNumber += 1
) {
  worksheet.getColumn(columnNumber).width = 16;
}

worksheet.getColumn(headers.length).width = 30;

  const output = await workbook.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(output),
    unmatchedCount,
  };
}

async function buildPropertyGroup(
  files: IEInputFile[]
): Promise<{
  group: PropertyGroup;
  warnings: string[];
}> {
  const groups = new Map<string, PropertyGroup>();
  const warnings: string[] = [];

  for (const file of files) {
    if (file.name.startsWith("~$")) {
      warnings.push(
        `Temporary Excel file skipped: ${file.name}`
      );
      continue;
    }

    const lowerName = file.name.toLocaleLowerCase();

    if (
  !lowerName.endsWith(".xlsx") &&
  !lowerName.endsWith(".xlsm") &&
  !lowerName.endsWith(".pdf")
) {
      warnings.push(
        `Unsupported file skipped: ${file.name}`
      );
      continue;
    }

    let info: FileInfo | null;

try {
  info = await inspectFile(file);
} catch (error) {
  console.error(
    "===== I&E INSPECT ERROR =====",
    error
  );

  const message =
    error instanceof Error
      ? error.message
      : "The workbook could not be read.";

  throw new Error(`${file.name}: ${message}`);
}

    if (!info) {
      throw new Error(
        `${file.name} is not a recognized Annual Statement, T12, or Budget workbook.`
      );
    }

    let group = groups.get(info.propertyKey);

    if (!group) {
group = {
  displayName: info.propertyName,
  annualFiles: [],
  t12Files: [],
  separateAnnualFiles: [],
  budgetFiles: [],
  annualizedFiles: [],
};

      groups.set(info.propertyKey, group);
    }

    if (
      info.propertyName.length > group.displayName.length
    ) {
      group.displayName = info.propertyName;
    }

switch (info.reportType) {
  case "annual":
    group.annualFiles.push(file);

    /*
     * Some PDF Annual reports also contain
     * a Budget as an additional report.
     */
    if (
      file.name.toLowerCase().endsWith(".pdf")
    ) {
      const extraction =
        await extractPdfIE(file.buffer);

      const hasAdditionalBudget =
        extraction.additionalReports?.some(
          (report) =>
            report.reportType === "budget"
        ) ?? false;

      if (hasAdditionalBudget) {
        group.budgetFiles.push(file);
      }
    }

    break;

  case "t12":
    group.t12Files.push(file);
    break;

  case "separate_annual":
    group.separateAnnualFiles.push(file);
    break;

  case "budget":
    group.budgetFiles.push(file);
    break;

  case "annualized":
    group.annualizedFiles.push(file);
    break;
}
  }

  if (groups.size === 0) {
    throw new Error(
      "No recognized I&E workbooks were supplied."
    );
  }

  if (groups.size > 1) {
    const names = Array.from(groups.values())
      .map((group) => group.displayName)
      .join(", ");

    throw new Error(
      `The uploaded files appear to contain multiple properties: ${names}. Process one property at a time.`
    );
  }

  const group = Array.from(groups.values())[0];


  if (group.t12Files.length > 1) {
    throw new Error(
      `Multiple T12 files were supplied: ${group.t12Files
        .map((file) => file.name)
        .join(", ")}.`
    );
  }

  if (group.budgetFiles.length > 1) {
    throw new Error(
      `Multiple Budget files were supplied: ${group.budgetFiles
        .map((file) => file.name)
        .join(", ")}.`
    );
  }

if (group.annualizedFiles.length > 1) {
  throw new Error(
    `Multiple Annualized files were supplied: ${group.annualizedFiles
      .map((file) => file.name)
      .join(", ")}.`
  );
}


  /*
   * The original script allows multiple OS/Yardi separate YE statements
   * because each file represents a different year.
   *
   * A legacy multi-year Annual Statement and separate YE files are not
   * expected together. Refuse to guess which source should win.
   */
  if (
    group.annualFiles.length > 0 &&
    group.separateAnnualFiles.length > 0
  ) {
    throw new Error(
      "Both a legacy Annual Statement and separate annual-year statements were supplied. Use one annual format for the property."
    );
  }

  return {
    group,
    warnings,
  };
}

export async function processIE(
  files: IEInputFile[]
): Promise<IEProcessResult> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      "Select at least one I&E workbook to process."
    );
  }

  const { group, warnings } =
    await buildPropertyGroup(files);

  const mapping = await loadInternalNumberMapping();

let annual: AnnualReport | null = null;

if (group.separateAnnualFiles.length > 0) {
  annual = await combineSeparateAnnuals(
    group.separateAnnualFiles
  );
} else if (group.annualFiles.length > 0) {
  annual = await combineAnnualReports(
    group.annualFiles
  );
}
  let t12: T12Report | null = null;

if (group.t12Files.length === 1) {
  const t12File = group.t12Files[0];

  if (
    t12File.name
      .toLowerCase()
      .endsWith(".pdf")
  ) {
    t12 = await readPdfT12Report(t12File);
  } else {
    const info = await inspectFile(t12File);

    if (!info) {
      throw new Error(
        `${t12File.name} could not be identified.`
      );
    }

    if (info.reportType === "t12") {
      const { worksheet } =
        await loadWorkbook(t12File.buffer);

      const row4A = cleanText(
        rawCellValue(worksheet.getCell("A4"))
      ).toLocaleLowerCase();

      if (row4A === "statement (12 months)") {
        const report = await readOSStatement(
          t12File,
          "t12"
        );

        t12 = {
          file: t12File,
          propertyName: report.propertyName,
          label: report.label,
          rows: report.rows,
        };
      } else {
        t12 = await readT12Report(t12File);
      }
    }
  }
}

  let budget: BudgetReport | null = null;

if (group.budgetFiles.length === 1) {
  const budgetFile = group.budgetFiles[0];

  budget = budgetFile.name
    .toLowerCase()
    .endsWith(".pdf")
    ? await readPdfBudgetReport(budgetFile)
    : await readBudgetReport(budgetFile);
}

let annualized: AnnualizedReport | null = null;

if (group.annualizedFiles.length === 1) {
  const annualizedFile = group.annualizedFiles[0];

  annualized = await readPdfAnnualizedReport(
    annualizedFile
  );
}

if (annualized) {
  const basePropertyName =
    annual?.propertyName ??
    t12?.propertyName ??
    budget?.propertyName;

  if (
    basePropertyName &&
    normalizePropertyName(basePropertyName) !==
      normalizePropertyName(annualized.propertyName)
  ) {
    throw new Error(
      `The Annualized property '${annualized.propertyName}' does not match '${basePropertyName}'.`
    );
  }
}

  if (annual && t12) {
    if (
      normalizePropertyName(annual.propertyName) !==
      normalizePropertyName(t12.propertyName)
    ) {
      throw new Error(
        `Property names do not match after normalization: '${annual.propertyName}' vs '${t12.propertyName}'.`
      );
    }
  }

  if (annual && budget) {
    if (
      normalizePropertyName(annual.propertyName) !==
      normalizePropertyName(budget.propertyName)
    ) {
      throw new Error(
        `The Budget property '${budget.propertyName}' does not match '${annual.propertyName}'.`
      );
    }
  }

  if (t12 && budget) {
    if (
      normalizePropertyName(t12.propertyName) !==
      normalizePropertyName(budget.propertyName)
    ) {
      throw new Error(
        `The Budget property '${budget.propertyName}' does not match '${t12.propertyName}'.`
      );
    }
  }

  /*
   * This intentionally preserves the original script's rule:
   * a Budget by itself is not enough to create the base output rows.
   */
  if (!annual && !t12) {
    throw new Error(
      "At least one Annual Statement or T12 report is required. A Budget cannot be processed by itself."
    );
  }

  const rows = mergeReports(annual, t12);

  validateOutput(annual, t12, rows);

  const {
    buffer,
    unmatchedCount,
  } = await createOutputWorkbook(
    annual,
    t12,
    budget,
    annualized,
    rows,
    mapping
  );

  if (!annual && t12) {
    warnings.push(
      `${group.displayName}: no Annual Statement was provided. A T12-only output was created.`
    );
  }

  if (annual && !t12) {
    warnings.push(
      `${group.displayName}: no T12 was provided. An Annual-only output was created.`
    );
  }

  if (unmatchedCount > 0) {
    warnings.push(
      `${unmatchedCount} itemized line item${
        unmatchedCount === 1 ? "" : "s"
      } could not be matched to an Internal Number. The unmatched Internal Number cells are highlighted in yellow.`
    );
  }

  return {
    buffer,
    outputFilename: `${safeFilename(
      group.displayName
    )} I&E Combined.xlsx`,
    propertyName: group.displayName,
    rowCount: rows.length,
    warnings,
  };
}