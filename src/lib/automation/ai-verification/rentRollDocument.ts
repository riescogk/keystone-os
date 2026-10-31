import ExcelJS from "exceljs";
import type { RentRollVerificationDocument, RentRollVerificationUnit } from "./rentRollTypes";

function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;

  if (value && typeof value === "object") {
    if ("result" in value) {
      return (value as { result?: unknown }).result ?? null;
    }
    if ("text" in value) {
      return (value as { text?: string }).text ?? null;
    }
  }

  return value ?? null;
}

function textValue(cell: ExcelJS.Cell): string | null {
  const value = cellValue(cell);
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

/**
 * Reads Keystone's generated Clean Rent Roll sheet into the neutral comparison
 * contract. This does not re-run or alter parser logic; it reads the workbook
 * that Keystone already produced.
 */
export async function rentRollDocumentFromKeystoneWorkbook(
  workbookBuffer: Buffer | Uint8Array
): Promise<RentRollVerificationDocument> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(workbookBuffer as unknown as ExcelJS.Buffer);

  const sheet = workbook.getWorksheet("Clean Rent Roll");
  if (!sheet) {
    throw new Error('Keystone output does not contain a "Clean Rent Roll" worksheet.');
  }

  const header = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const name = textValue(cell)?.toLowerCase();
    if (name) {
      header.set(name, columnNumber);
    }
  });

  const required = [
    "unit",
    "unit type",
    "sq ft",
    "unit category",
    "resident name",
    "market rent",
    "charge code",
    "rent amount",
  ];

  for (const name of required) {
    if (!header.has(name)) {
      throw new Error(`Keystone Clean Rent Roll is missing the "${name}" column.`);
    }
  }

  const units: RentRollVerificationUnit[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const unit = textValue(row.getCell(header.get("unit")!));
    if (!unit) {
      continue;
    }

    units.push({
      unit,
      unitType: textValue(row.getCell(header.get("unit type")!)),
      sqft: cellValue(row.getCell(header.get("sq ft")!)) as number | string | null,
      unitCategory: textValue(row.getCell(header.get("unit category")!)),
      residentName: textValue(row.getCell(header.get("resident name")!)),
      marketRent: cellValue(row.getCell(header.get("market rent")!)) as number | string | null,
      chargeCodes: textValue(row.getCell(header.get("charge code")!)),
      rentAmount: cellValue(row.getCell(header.get("rent amount")!)) as number | string | null,
    });
  }

  return {
    propertyName: null,
    asOfDate: null,
    expectedUnitCount: units.length,
    units,
    warnings: [],
  };
}
