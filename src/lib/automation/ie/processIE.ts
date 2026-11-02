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
  includedFileNames: string[];
  skippedFileNames: string[];
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
  accountCode: string | null;
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
      accountCode: null,
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
        /Period\s*=\s*[A-Za-z]{3,9}\s+\d{4}\s*[-–]\s*([A-Za-z]{3,9})\s+(\d{4})/i
      );

      if (match) {
        const month =
          match[1].charAt(0).toUpperCase() +
          match[1].slice(1, 3).toLowerCase();

        return `T12 ${month} '${match[2].slice(-2)}`;
      }
    }
  }

  const lastMonthColumn = Math.max(...monthColumns);
  const lastMonthValue = rawCellValue(
    worksheet.getRow(headerRow).getCell(lastMonthColumn)
  );

  const parsed = monthYearFromValue(lastMonthValue);

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
  const accountCodes = new Map<string, string | null>();

  const byYear = reports.map((report) => {
    const map = new Map<string, T12Row>();

    for (const row of report.rows) {
      map.set(row.key, row);

      if (!names.has(row.key)) {
        names.set(row.key, row.name);
      }

      if (
        row.accountCode &&
        !accountCodes.get(row.key)
      ) {
        accountCodes.set(row.key, row.accountCode);
      } else if (!accountCodes.has(row.key)) {
        accountCodes.set(row.key, null);
      }

      if (!order.includes(row.key)) {
        order.push(row.key);
      }
    }

    return map;
  });

  const rows: AnnualRow[] = order.map((key) => ({
    key,
    accountCode: accountCodes.get(key) ?? null,
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
      accountCode: row.accountCode,
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
   * Annual row identity rules:
   *
   * 1. An explicit account code is the strongest identity across years.
   *    The same code should merge even when wording changes.
   *
   * 2. If a normalized line-item name appears at most once in every
   *    report, that exact name may bridge rows whose account code changed
   *    between years. When different explicit codes are bridged this way,
   *    the final Account Code is left blank rather than implying one code
   *    applied consistently to every year.
   *
   * 3. Duplicate names inside a single report are never merged by name.
   *    They stay distinct and are matched by account code + occurrence, or
   *    by their existing name occurrence when no account code is present.
   */
  const nameCountsByReport = new Map<
    AnnualReport,
    Map<string, number>
  >();

  const globalRowsByName = new Map<
    string,
    AnnualRow[]
  >();

  for (const report of reports) {
    const counts = new Map<string, number>();

    for (const row of report.rows) {
      const normalizedName = normalizeName(row.name);
      counts.set(
        normalizedName,
        (counts.get(normalizedName) ?? 0) + 1
      );

      const existing =
        globalRowsByName.get(normalizedName) ?? [];
      existing.push(row);
      globalRowsByName.set(normalizedName, existing);
    }

    nameCountsByReport.set(report, counts);
  }

  const safeNameBridge = new Set<string>();

  for (const [normalizedName, matchingRows] of globalRowsByName) {
    if (matchingRows.length < 2) {
      continue;
    }

    const uniqueWithinEveryReport = reports.every(
      (report) =>
        (nameCountsByReport
          .get(report)
          ?.get(normalizedName) ?? 0) <= 1
    );

    if (!uniqueWithinEveryReport) {
      continue;
    }

    const distinctCodes = new Set(
      matchingRows
        .map((row) =>
          row.accountCode
            ? cleanText(row.accountCode)
                .toLocaleLowerCase()
                .replace(/\s+/g, "")
            : ""
        )
        .filter(Boolean)
    );

    if (distinctCodes.size > 1) {
      safeNameBridge.add(normalizedName);
    }
  }

  const reportEntries = new Map<
    AnnualReport,
    Array<{ mergeKey: string; row: AnnualRow }>
  >();

  for (const report of reports) {
    const codeOccurrences = new Map<string, number>();

    const entries = report.rows.map((row) => {
      const normalizedName = normalizeName(row.name);
      const normalizedCode = row.accountCode
        ? cleanText(row.accountCode)
            .toLocaleLowerCase()
            .replace(/\s+/g, "")
        : "";

      if (safeNameBridge.has(normalizedName)) {
        return {
          mergeKey: `name:${normalizedName}`,
          row,
        };
      }

      if (normalizedCode) {
        const occurrence =
          (codeOccurrences.get(normalizedCode) ?? 0) + 1;

        codeOccurrences.set(normalizedCode, occurrence);

        return {
          mergeKey: `account:${normalizedCode}\u0000${occurrence}`,
          row,
        };
      }

      return {
        mergeKey: `name-occurrence:${row.key}`,
        row,
      };
    });

    reportEntries.set(report, entries);
  }

  const order: string[] = [];
  const names = new Map<string, string>();
  const codesByKey = new Map<string, Set<string>>();
  const displayCodeByKey = new Map<string, string>();

  for (const report of reports) {
    for (const { mergeKey, row } of
      reportEntries.get(report) ?? []) {
      if (!names.has(mergeKey)) {
        names.set(mergeKey, row.name);
      }

      if (row.accountCode) {
        const normalizedCode = cleanText(row.accountCode)
          .toLocaleLowerCase()
          .replace(/\s+/g, "");

        const codes = codesByKey.get(mergeKey) ?? new Set<string>();
        codes.add(normalizedCode);
        codesByKey.set(mergeKey, codes);

        if (!displayCodeByKey.has(mergeKey)) {
          displayCodeByKey.set(mergeKey, row.accountCode);
        }
      }

      if (!order.includes(mergeKey)) {
        order.push(mergeKey);
      }
    }
  }

  const reportMaps = new Map<
    AnnualReport,
    Map<string, AnnualRow>
  >();

  for (const report of reports) {
    reportMaps.set(
      report,
      new Map(
        (reportEntries.get(report) ?? []).map(
          ({ mergeKey, row }) => [mergeKey, row]
        )
      )
    );
  }

  const finalOccurrenceCounts = new Map<string, number>();

  const rows: AnnualRow[] = order.map((mergeKey) => {
    const name = names.get(mergeKey) ?? "";
    const normalizedName = normalizeName(name);
    const occurrence =
      (finalOccurrenceCounts.get(normalizedName) ?? 0) + 1;

    finalOccurrenceCounts.set(normalizedName, occurrence);

    const codes = codesByKey.get(mergeKey) ?? new Set<string>();
    const accountCode =
      codes.size === 1
        ? displayCodeByKey.get(mergeKey) ?? null
        : null;

    const values = periods.map((period) => {
      const row = reportMaps
        .get(period.report)
        ?.get(mergeKey);

      return (
        row?.values[period.valueIndex] ?? null
      );
    });

    return {
      key: occurrenceKey(name, occurrence),
      accountCode,
      name,
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


function buildAnnualKeyRemap(
  annual: AnnualReport,
  t12: T12Report
): Map<string, string> {
  /*
   * Annual statements can omit account codes and may omit
   * unvalued section-heading rows that are present in the T12.
   * If that creates duplicate same-name T12 occurrences, align a
   * single valued annual row to the single valued T12 occurrence
   * instead of blindly using occurrence #1.
   */
  const annualKeyRemap = new Map<string, string>();
  const annualRowsByName = new Map<string, AnnualRow[]>();
  const t12RowsByName = new Map<string, T12Row[]>();

  for (const row of annual.rows) {
    const normalized = normalizeName(row.name);
    const existing = annualRowsByName.get(normalized) ?? [];
    existing.push(row);
    annualRowsByName.set(normalized, existing);
  }

  for (const row of t12.rows) {
    const normalized = normalizeName(row.name);
    const existing = t12RowsByName.get(normalized) ?? [];
    existing.push(row);
    t12RowsByName.set(normalized, existing);
  }

  for (const [normalizedName, annualMatches] of annualRowsByName) {
    const t12Matches = t12RowsByName.get(normalizedName) ?? [];

    if (annualMatches.length !== 1 || t12Matches.length <= 1) {
      continue;
    }

    const annualRow = annualMatches[0];

    if (!annualRow.values.some((value) => value !== null)) {
      continue;
    }

    const valuedT12Matches = t12Matches.filter(
      (row) => row.total !== null
    );

    if (valuedT12Matches.length === 1) {
      annualKeyRemap.set(
        annualRow.key,
        valuedT12Matches[0].key
      );
    }
  }

  return annualKeyRemap;
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
      accountCode: row.accountCode,
      name: row.name,
      values: [...row.values],
    }));
  }

  if (!annual || !t12) {
    throw new Error("Could not merge the supplied reports.");
  }

  const annualKeyRemap = buildAnnualKeyRemap(annual, t12);

  const annualByKey = new Map(
    annual.rows.map((row) => [
      annualKeyRemap.get(row.key) ?? row.key,
      row,
    ])
  );

  const t12ByKey = new Map(
    t12.rows.map((row) => [row.key, row])
  );

  const annualOrder = annual.rows.map(
    (row) => annualKeyRemap.get(row.key) ?? row.key
  );
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
      accountCode:
        t12Row?.accountCode ??
        annualRow?.accountCode ??
        null,
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

  const annualKeyRemap =
    annual && t12
      ? buildAnnualKeyRemap(annual, t12)
      : new Map<string, string>();

  if (annual) {
    for (const row of annual.rows) {
      expectedKeys.add(
        annualKeyRemap.get(row.key) ?? row.key
      );
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

const INTERNAL_NUMBER_REFERENCE_ALIASES = new Map<string, string>([
  ["5345-00\u0000legal fees", "Collection Agency/Attorney"],
  ["5377-00\u0000pest control", "Pest Control Fee"],
  ["5379-00\u0000work order charge", "Miscellaneous Income"],
  ["6140-00\u0000legal fees", "Legal & Professional Services"],
  ["6208-00\u0000leasing staff", "Leasing Salaries"],
  ["6259-00\u0000referral fees", "Locator Fees"],
  ["6262-00\u0000creative production", "Marketing Collateral"],
  ["6350-00\u0000cable/satellite", "Bulk Cable"],
  ["6364-00\u0000landscaping/irrigation", "Lawn Irrigation Repairs"],
  ["6372-00\u0000pest control", "Exterminating"],
  ["6385-00\u0000hvac/chiller", "HVAC Contract"],
  ["6423-00\u0000roof repair/maint", "Roofing Repairs"],
  ["6515-00\u0000window coverings parts/accessories", "Blinds"],
  ["6713-00\u0000personal property taxes", "Misc Taxes"],
  ["5216-00\u0000less renewal concessions", "Renewal Concessions"],
  ["5378-00\u0000unit transfer fee", "Transfer Fees"],
  ["42050-000\u0000lease cancellation fee", "Cancellation Fees"],
  ["43030-000\u0000cable provider payments", "Cable TV Income"],
  ["51360-000\u0000entertainment expense", "Entertainment"],
  ["51430-000\u0000force placed coverage expense", "Forced Place Coverage Expense"],
  ["51620-000\u0000bulk cable expense", "Bulk Cable"],
  ["52625-000\u0000carpet/flooring repair", "Carpet Floor Repair"],
]);

function internalNumberAliasKey(
  accountCode: string | null,
  lineItem: string
): string | null {
  if (!accountCode) {
    return null;
  }

  return `${accountCode.trim()}\u0000${normalizeName(lineItem)}`;
}

function findInternalNumberForRow(
  row: Pick<MergedRow, "accountCode" | "name">,
  mapping: InternalNumberMapping
): string | number | null {
  const aliasKey = internalNumberAliasKey(
    row.accountCode,
    row.name
  );

  if (aliasKey) {
    const referenceName =
      INTERNAL_NUMBER_REFERENCE_ALIASES.get(aliasKey);

    if (referenceName) {
      const mapped = mapping.exact.get(
        normalizeMappingName(referenceName)
      );

      if (mapped !== undefined) {
        return mapped;
      }
    }
  }

  return findInternalNumber(row.name, mapping);
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

  /*
   * Budget matching is intentionally conservative.
   *
   * The Combined I&E must not lose a valid Budget value merely because the
   * Budget uses different wording than Annual/T12. We only merge a Budget row
   * into an existing base row when the identity is unambiguous. Every other
   * Budget row is preserved later as its own Budget-only row.
   *
   * This also prevents duplicate code-less labels from different sections
   * (for example Landscaping/Irrigation in Major Expenses vs Capital
   * Expenditures) from being attached to the wrong operating row.
   */
  const baseNameCounts = new Map<string, number>();
  const budgetRowsByName = new Map<string, T12Row[]>();
  const budgetRowsByAccountAndName = new Map<string, T12Row[]>();
  const usedBudgetRows = new Set<T12Row>();

  for (const row of rows) {
    if (row.accountCode) {
      continue;
    }

    const normalized = normalizeName(row.name);
    baseNameCounts.set(
      normalized,
      (baseNameCounts.get(normalized) ?? 0) + 1
    );
  }

  if (budget) {
    for (const row of budget.rows) {
      const normalized = normalizeName(row.name);
      const byName = budgetRowsByName.get(normalized) ?? [];
      byName.push(row);
      budgetRowsByName.set(normalized, byName);

      if (row.accountCode) {
        const accountAndName =
          `${row.accountCode.trim()}\u0000${normalized}`;
        const byAccountAndName =
          budgetRowsByAccountAndName.get(accountAndName) ?? [];
        byAccountAndName.push(row);
        budgetRowsByAccountAndName.set(
          accountAndName,
          byAccountAndName
        );
      }
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
      : findInternalNumberForRow(row, mapping);

    let budgetValue: number | null = null;

    if (budget) {
      let budgetRow: T12Row | undefined;

      if (row.accountCode) {
        const candidates =
          budgetRowsByAccountAndName.get(
            `${row.accountCode.trim()}\u0000${normalizeName(row.name)}`
          ) ?? [];

        budgetRow = candidates.find(
          (candidate) => !usedBudgetRows.has(candidate)
        );
      } else {
        const normalized = normalizeName(row.name);
        const candidates = budgetRowsByName.get(normalized) ?? [];

        /*
         * For code-less rows, exact name matching is allowed only when that
         * name occurs exactly once in BOTH the base universe and the Budget.
         * Otherwise the relationship is ambiguous, so preserve the Budget
         * row separately instead of guessing by occurrence or section.
         */
        if (
          (baseNameCounts.get(normalized) ?? 0) === 1 &&
          candidates.length === 1 &&
          !usedBudgetRows.has(candidates[0])
        ) {
          budgetRow = candidates[0];
        }
      }

      if (budgetRow) {
        usedBudgetRows.add(budgetRow);
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

  /*
   * Preserve every Budget row that could not be matched unambiguously to an
   * Annual/T12 base row. The Annual/T12 columns stay blank and the Budget
   * value is written in the Budget column. This makes the conversion
   * lossless without forcing semantic naming decisions into the parser.
   */
  if (budget) {
    for (const budgetRow of budget.rows) {
      if (usedBudgetRows.has(budgetRow)) {
        continue;
      }

      const summary = isSummaryLine(budgetRow.name);
      const signFlipNote = getSignFlipNote(budgetRow.name);
      const shouldFlipSign = signFlipNote !== null;
      const internalNumber = summary
        ? null
        : findInternalNumberForRow(
            {
              accountCode: budgetRow.accountCode,
              name: budgetRow.name,
            },
            mapping
          );

      const outputValues: Array<string | number | null> = [
        budgetRow.accountCode,
        internalNumber,
        budgetRow.name,
        ...new Array(years.length).fill(null),
      ];

      if (t12) {
        outputValues.push(null);
      }

      outputValues.push(
        flipSignIfNeeded(budgetRow.total, shouldFlipSign)
      );

      if (annualized) {
        outputValues.push(null);
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : fallback;
}

function addFileWarning(
  file: IEInputFile,
  reason: string,
  warnings: string[]
): void {
  warnings.push(`${file.name}: ${reason}`);
}

function markFileIncluded(
  file: IEInputFile,
  includedFileNames: string[]
): void {
  if (!includedFileNames.includes(file.name)) {
    includedFileNames.push(file.name);
  }
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
      addFileWarning(
        file,
        "temporary Excel files are not processed.",
        warnings
      );
      continue;
    }

    const lowerName = file.name.toLocaleLowerCase();

    if (
  !lowerName.endsWith(".xlsx") &&
  !lowerName.endsWith(".xlsm") &&
  !lowerName.endsWith(".pdf")
) {
      addFileWarning(
        file,
        "this file type is not supported.",
        warnings
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

  addFileWarning(
    file,
    errorMessage(error, "The workbook could not be read."),
    warnings
  );
  continue;
}

    if (!info) {
      addFileWarning(
        file,
        "this is not a recognized Annual Statement, T12, Budget, or Annualized report.",
        warnings
      );
      continue;
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

  const includedFileNames: string[] = [];

  const mapping = await loadInternalNumberMapping();

let annual: AnnualReport | null = null;

if (group.separateAnnualFiles.length > 0) {
  const usableSeparateAnnualFiles: IEInputFile[] = [];

  for (const file of group.separateAnnualFiles) {
    try {
      const { worksheet } = await loadWorkbook(file.buffer);
      const firstCells = getFirstCellsText(worksheet);
      const text = firstCells.join(" | ");

      const report = text.includes("statement of operations")
        ? await readStatementOfOperationsAnnual(file)
        : await readOSStatement(file, "annual");

      const year = Number.parseInt(report.label, 10);
      if (!Number.isFinite(year)) {
        throw new Error("could not determine the annual year.");
      }

      usableSeparateAnnualFiles.push(file);
      markFileIncluded(file, includedFileNames);
    } catch (error) {
      addFileWarning(
        file,
        errorMessage(error, "The annual statement could not be read."),
        warnings
      );
    }
  }

  if (usableSeparateAnnualFiles.length > 0) {
    annual = await combineSeparateAnnuals(usableSeparateAnnualFiles);
  }
} else if (group.annualFiles.length > 0) {
  const usableAnnualFiles: IEInputFile[] = [];

  for (const file of group.annualFiles) {
    try {
      if (file.name.toLowerCase().endsWith(".pdf")) {
        await readPdfAnnualReport(file);
      } else {
        await readAnnualReport(file);
      }

      usableAnnualFiles.push(file);
      markFileIncluded(file, includedFileNames);
    } catch (error) {
      addFileWarning(
        file,
        errorMessage(error, "The Annual Statement could not be read."),
        warnings
      );
    }
  }

  if (usableAnnualFiles.length > 0) {
    annual = await combineAnnualReports(usableAnnualFiles);
  }
}
  let t12: T12Report | null = null;

if (group.t12Files.length === 1) {
  const t12File = group.t12Files[0];

  try {
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

    if (t12) {
      markFileIncluded(t12File, includedFileNames);
    }
  } catch (error) {
    addFileWarning(
      t12File,
      errorMessage(error, "The T12 could not be read."),
      warnings
    );
    t12 = null;
  }
}

  let budget: BudgetReport | null = null;

if (group.budgetFiles.length === 1) {
  const budgetFile = group.budgetFiles[0];

  try {
    budget = budgetFile.name
      .toLowerCase()
      .endsWith(".pdf")
      ? await readPdfBudgetReport(budgetFile)
      : await readBudgetReport(budgetFile);

    if (budget) {
      markFileIncluded(budgetFile, includedFileNames);
    }
  } catch (error) {
    addFileWarning(
      budgetFile,
      errorMessage(error, "The Budget could not be read."),
      warnings
    );
    budget = null;
  }
}

let annualized: AnnualizedReport | null = null;

if (group.annualizedFiles.length === 1) {
  const annualizedFile = group.annualizedFiles[0];

  try {
    annualized = await readPdfAnnualizedReport(
      annualizedFile
    );

    if (annualized) {
      markFileIncluded(annualizedFile, includedFileNames);
    }
  } catch (error) {
    addFileWarning(
      annualizedFile,
      errorMessage(error, "The Annualized report could not be read."),
      warnings
    );
    annualized = null;
  }
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
      "At least one Annual Statement or T12 report must be successfully processed. A Budget cannot be processed by itself."
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

  const includedNameSet = new Set(includedFileNames);
  const skippedFileNames = Array.from(
    new Set(
      files
        .filter((file) => !includedNameSet.has(file.name))
        .map((file) => file.name)
    )
  );

  if (skippedFileNames.length > 0) {
    warnings.unshift(
      `Keystone did not process ${skippedFileNames.length} file${
        skippedFileNames.length === 1 ? "" : "s"
      }: ${skippedFileNames.join(", ")}. The workbook was created using the remaining ${includedFileNames.length} file${
        includedFileNames.length === 1 ? "" : "s"
      }.`
    );
  }

  if (!annual && t12) {
    warnings.push(
      `${group.displayName}: no usable Annual Statement was included. A T12-only output was created.`
    );
  }

  if (annual && !t12) {
    warnings.push(
      `${group.displayName}: no usable T12 was included. An Annual-only output was created.`
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
    includedFileNames,
    skippedFileNames,
  };
}