import type { IEVerificationDocument } from "./ieTypes";
import type { RentRollVerificationDocument } from "./rentRollTypes";
import type { AIVerificationSourceFile } from "./types";

export interface RentRollAIExtractionRequest {
  files: AIVerificationSourceFile[];
  chargeCodes?: string[];
}

export interface IEAIExtractionRequest {
  files: AIVerificationSourceFile[];
}

/**
 * Provider boundary for the optional automation verifier.
 *
 * Implementations must independently extract the expected result from the
 * original source file(s). They must not receive Keystone's deterministic
 * output as part of extraction, which prevents anchoring on Keystone's answer.
 */
export interface AIVerificationProvider {
  readonly name: string;

  extractRentRoll(
    request: RentRollAIExtractionRequest
  ): Promise<RentRollVerificationDocument>;

  extractIE(
    request: IEAIExtractionRequest
  ): Promise<IEVerificationDocument>;
}
