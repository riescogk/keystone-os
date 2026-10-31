import { compareRentRollDocuments } from "./compare";
import { AIVerificationError, verificationFailureState } from "./errors";
import { createOpenAIRentRollVerificationProvider } from "./openaiRentRollProvider";
import type { RentRollAIVerificationProvider } from "./provider";
import { rentRollDocumentFromKeystoneWorkbook } from "./rentRollDocument";
import { deriveRentRollCategoriesFromAI } from "./rentRollPostProcess";
import type {
  AIVerificationComparisonResult,
  AIVerificationFailureReason,
  AIVerificationSourceFile,
} from "./types";

export type RentRollVerificationRunResult =
  | {
      status: "passed" | "discrepancies";
      provider: string;
      comparison: AIVerificationComparisonResult;
      aiWarnings: string[];
    }
  | {
      status: "unavailable" | "failed";
      provider: string | null;
      failureReason: AIVerificationFailureReason;
      message: string;
    };

export interface RunRentRollVerificationOptions {
  sourceFile: AIVerificationSourceFile;
  keystoneWorkbookBuffer: Buffer | Uint8Array;
  chargeCodes: string[];
  provider?: RentRollAIVerificationProvider | null;
}

/**
 * Optional independent second-reader for a completed Rent Roll.
 * Never mutates the Keystone workbook and never throws provider failures back
 * into the deterministic processing path.
 */
export async function runRentRollAIVerification(
  options: RunRentRollVerificationOptions
): Promise<RentRollVerificationRunResult> {
  const provider = options.provider === undefined
    ? createOpenAIRentRollVerificationProvider()
    : options.provider;

  if (!provider) {
    return {
      ...verificationFailureState("not_configured"),
      provider: null,
      message: "AI verification is not configured on this deployment.",
    };
  }

  try {
    const [keystoneDocument, aiRawDocument] = await Promise.all([
      rentRollDocumentFromKeystoneWorkbook(options.keystoneWorkbookBuffer),
      provider.extractRentRoll({
        files: [options.sourceFile],
        chargeCodes: options.chargeCodes,
      }),
    ]);

    const aiDocument = deriveRentRollCategoriesFromAI(aiRawDocument);
    const comparison = compareRentRollDocuments(keystoneDocument, aiDocument);

    return {
      status: comparison.status,
      provider: provider.name,
      comparison,
      aiWarnings: aiDocument.warnings,
    };
  } catch (error) {
    const verificationError = error instanceof AIVerificationError
      ? error
      : new AIVerificationError(
          "provider_error",
          error instanceof Error ? error.message : "AI Rent Roll verification failed."
        );

    return {
      ...verificationFailureState(verificationError.reason),
      provider: provider.name,
      message: verificationError.message,
    };
  }
}
