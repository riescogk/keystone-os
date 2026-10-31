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
export interface RentRollAIVerificationProvider {
  readonly name: string;

  extractRentRoll(
    request: RentRollAIExtractionRequest
  ): Promise<RentRollVerificationDocument>;
}

export interface IEAIVerificationProvider {
  readonly name: string;

  extractIE(
    request: IEAIExtractionRequest
  ): Promise<IEVerificationDocument>;
}

export interface AIVerificationProvider
  extends RentRollAIVerificationProvider, IEAIVerificationProvider {}
