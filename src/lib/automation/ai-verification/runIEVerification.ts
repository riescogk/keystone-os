import { compareIEDocuments } from "./compare";
import { AIVerificationError, verificationFailureState } from "./errors";
import { ieDocumentFromKeystoneWorkbook } from "./ieDocument";
import { prepareIESourceFilesForAI } from "./ieSourceFiles";
import { createOpenAIIEVerificationProvider } from "./openaiIEProvider";
import type { IEAIVerificationProvider } from "./provider";
import type {
  AIVerificationComparisonResult,
  AIVerificationFailureReason,
  AIVerificationSourceFile,
} from "./types";

export type IEVerificationRunResult =
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

export interface RunIEVerificationOptions {
  sourceFiles: AIVerificationSourceFile[];
  keystoneWorkbookBuffer: Buffer | Uint8Array;
  keystonePropertyName?: string | null;
  provider?: IEAIVerificationProvider | null;
  mappingReference?: AIVerificationSourceFile;
}

/**
 * Optional independent second-reader for a completed I&E conversion.
 * It never mutates the Keystone workbook and never throws an AI/provider
 * failure back into the deterministic processing path.
 */
export async function runIEAIVerification(
  options: RunIEVerificationOptions
): Promise<IEVerificationRunResult> {
  const provider =
    options.provider === undefined
      ? createOpenAIIEVerificationProvider()
      : options.provider;

  if (!provider) {
    return {
      ...verificationFailureState("not_configured"),
      provider: null,
      message: "AI verification is not configured on this deployment.",
    };
  }

  try {
    if (options.sourceFiles.length === 0) {
      throw new AIVerificationError(
        "provider_error",
        "I&E AI verification requires at least one original source file."
      );
    }

    const preparedSourceFiles = await prepareIESourceFilesForAI(
      options.sourceFiles
    );

    const [keystoneDocument, aiDocument] = await Promise.all([
      ieDocumentFromKeystoneWorkbook(options.keystoneWorkbookBuffer, {
        propertyName: options.keystonePropertyName,
        sourceFiles: options.sourceFiles,
      }),
      provider.extractIE({
        files: preparedSourceFiles,
      }),
    ]);

    const comparison = compareIEDocuments(keystoneDocument, aiDocument);

    return {
      status: comparison.status,
      provider: provider.name,
      comparison,
      aiWarnings: aiDocument.warnings,
    };
  } catch (error) {
    const verificationError =
      error instanceof AIVerificationError
        ? error
        : new AIVerificationError(
            "provider_error",
            error instanceof Error ? error.message : "AI I&E verification failed."
          );

    return {
      ...verificationFailureState(verificationError.reason),
      provider: provider.name,
      message: verificationError.message,
    };
  }
}
