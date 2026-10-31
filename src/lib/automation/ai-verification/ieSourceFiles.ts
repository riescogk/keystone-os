import ExcelJS from "exceljs";
import { AIVerificationError } from "./errors";
import type { AIVerificationSourceFile } from "./types";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Responses file inputs support the data-bearing workbook we need. For .xlsm
 * uploads, create an in-memory .xlsx copy so AI verification does not depend
 * on macro-enabled file support. The deterministic source file is untouched.
 */
export async function prepareIESourceFilesForAI(
  files: AIVerificationSourceFile[]
): Promise<AIVerificationSourceFile[]> {
  const prepared: AIVerificationSourceFile[] = [];

  for (const file of files) {
    if (!file.name.toLocaleLowerCase().endsWith(".xlsm")) {
      prepared.push(file);
      continue;
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        Buffer.from(file.bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]
      );
      const output = await workbook.xlsx.writeBuffer();

      prepared.push({
        name: file.name.replace(/\.xlsm$/i, ".xlsx"),
        mimeType: XLSX_MIME,
        bytes: new Uint8Array(output),
      });
    } catch (error) {
      throw new AIVerificationError(
        "provider_error",
        error instanceof Error
          ? `${file.name}: could not create the .xlsx copy required for AI verification: ${error.message}`
          : `${file.name}: could not create the .xlsx copy required for AI verification.`
      );
    }
  }

  return prepared;
}
