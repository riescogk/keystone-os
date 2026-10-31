import fs from "node:fs/promises";
import path from "node:path";
import { AIVerificationError } from "./errors";
import type { AIVerificationSourceFile } from "./types";

export const IE_INTERNAL_NUMBER_REFERENCE_FILENAME = "To add I&E.xlsx";

/** Load the same reference workbook used by deterministic I&E mapping. */
export async function loadIEInternalNumberReference(): Promise<AIVerificationSourceFile> {
  const referencePath = path.join(
    process.cwd(),
    "src",
    "lib",
    "automation",
    "ie",
    "reference",
    IE_INTERNAL_NUMBER_REFERENCE_FILENAME
  );

  try {
    const buffer = await fs.readFile(referencePath);
    return {
      name: IE_INTERNAL_NUMBER_REFERENCE_FILENAME,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: new Uint8Array(buffer),
    };
  } catch (error) {
    throw new AIVerificationError(
      "provider_error",
      error instanceof Error
        ? `AI verification could not load the I&E internal-number reference: ${error.message}`
        : "AI verification could not load the I&E internal-number reference."
    );
  }
}
