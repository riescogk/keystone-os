import ExcelJS from "exceljs";
import { AIVerificationError } from "./errors";
import type {
  IEVerificationDocument,
  IEVerificationRow,
  IEVerificationSource,
} from "./ieTypes";
import type { AIVerificationSourceFile } from "./types";

function cellPrimitive(cell: ExcelJS.Cell): string | number | null {
  const value = cell.value;

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as {
      result?: unknown;
      text?: string;
      richText?: Array<{ text?: string }>;
    };

    if (record.result !== undefined && record.result !== null) {
      const result = record.result;
      if (typeof result === "number") {
        return Number.isFinite(result) ? result : null;
      }
      if (typeof result === "string") {
        const trimmed = result.trim();
        return trimmed || null;
      }
    }

    if (typeof record.text === "string") {
      const trimmed = record.text.trim();
      return trimmed || null;
    }

    if (Array.isArray(record.richText)) {
      const text = record.richText.map((part) => part.text ?? "").join("").trim();
      return text || null;
    }
  }

  const text = String(value).trim();
  return text || null;
}

function headerText(cell: ExcelJS.Cell): string {
  const value = cellPrimitive(cell);
  return value === null ? "" : String(value).trim();
}

function isSummaryLine(lineItem: string): boolean {
  const normalized = lineItem.trim().toLocaleLowerCase();
  return (
    normalized === "total" ||
    normalized.startsWith("total ") ||
    normalized === "net" ||
    normalized.startsWith("net ")
  );
}

function sourceMetadata(files: AIVerificationSourceFile[]): IEVerificationSource[] {
  return files.map((file) => ({
    filename: file.name,
    reportType: "unknown",
    periodLabels: [],
  }));
}

export interface IEKeystoneDocumentOptions {
  propertyName?: string | null;
  sourceFiles?: AIVerificationSourceFile[];
}

/**
 * Reads Keystone's already-produced Combined I&E workbook into the canonical
 * verification model. This does not rerun or alter deterministic I&E parsing.
 */
export async function ieDocumentFromKeystoneWorkbook(
  buffer: Buffer | Uint8Array,
  options: IEKeystoneDocumentOptions = {}
): Promise<IEVerificationDocument> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(
      Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    );
  } catch (error) {
    throw new AIVerificationError(
      "invalid_output",
      error instanceof Error
        ? `Keystone I&E workbook could not be read: ${error.message}`
        : "Keystone I&E workbook could not be read."
    );
  }

  const worksheet =
    workbook.getWorksheet("Combined I&E") ?? workbook.worksheets[0];

  if (!worksheet) {
    throw new AIVerificationError(
      "invalid_output",
      "Keystone I&E workbook does not contain a worksheet."
    );
  }

  const headerRow = worksheet.getRow(1);
  const headers = new Map<string, number>();

  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    const text = headerText(headerRow.getCell(column));
    if (text) {
      headers.set(text.toLocaleLowerCase(), column);
    }
  }

  const accountCodeColumn = headers.get("account code");
  const internalNumberColumn = headers.get("internal number");
  const lineItemColumn = headers.get("line item");
  const notesColumn = headers.get("notes");

  if (
    accountCodeColumn === undefined ||
    internalNumberColumn === undefined ||
    lineItemColumn === undefined ||
    notesColumn === undefined
  ) {
    throw new AIVerificationError(
      "invalid_output",
      "Keystone I&E workbook is missing one or more required Combined I&E columns."
    );
  }

  const valueColumns: Array<{ column: number; label: string }> = [];

  for (let column = lineItemColumn + 1; column < notesColumn; column += 1) {
    const label = headerText(headerRow.getCell(column));
    if (label) {
      valueColumns.push({ column, label });
    }
  }

  const rows: IEVerificationRow[] = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rawLineItem = cellPrimitive(row.getCell(lineItemColumn));
    const lineItem = rawLineItem === null ? "" : String(rawLineItem).trim();

    if (!lineItem) {
      continue;
    }

    const accountCodeValue = cellPrimitive(row.getCell(accountCodeColumn));
    const internalNumberValue = cellPrimitive(row.getCell(internalNumberColumn));
    const values: Record<string, number | string | null> = {};

    for (const { column, label } of valueColumns) {
      values[label] = cellPrimitive(row.getCell(column));
    }

    rows.push({
      accountCode:
        accountCodeValue === null ? null : String(accountCodeValue).trim() || null,
      internalNumber: internalNumberValue,
      lineItem,
      values,
      isSummary: isSummaryLine(lineItem),
    });
  }

  return {
    propertyName: options.propertyName ?? null,
    sources: sourceMetadata(options.sourceFiles ?? []),
    periodLabels: valueColumns.map((item) => item.label),
    rows,
    warnings: [],
  };
}
