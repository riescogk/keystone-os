export type AIVerificationKind = "rent_roll" | "ie";

export type AIVerificationStatus =
  | "not_requested"
  | "pending"
  | "processing"
  | "passed"
  | "discrepancies"
  | "unavailable"
  | "failed";

export type AIVerificationFailureReason =
  | "not_configured"
  | "insufficient_credits"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "refused"
  | "incomplete"
  | "invalid_output";

export type AIVerificationConfidence = "high" | "medium" | "low";

export type AIVerificationDiscrepancyType =
  | "value_mismatch"
  | "blank_vs_zero"
  | "missing_in_keystone"
  | "missing_in_ai"
  | "unit_count_mismatch"
  | "mapping_mismatch"
  | "period_mismatch"
  | "total_mismatch";

export interface AIVerificationEvidence {
  sourceName?: string;
  page?: number;
  sheet?: string;
  row?: number;
  excerpt?: string;
  note?: string;
}

export interface AIVerificationDiscrepancy {
  recordKey: string;
  field: string;
  keystoneValue: unknown;
  aiValue: unknown;
  type: AIVerificationDiscrepancyType;
  aiEvidence?: AIVerificationEvidence[];
  aiExplanation?: string;
  aiConfidence?: AIVerificationConfidence;
}

export interface AIVerificationComparisonResult {
  status: "passed" | "discrepancies";
  comparedRecordCount: number;
  discrepancyCount: number;
  discrepancies: AIVerificationDiscrepancy[];
}

export interface AIVerificationFailureState {
  status: "unavailable" | "failed";
  failureReason: AIVerificationFailureReason;
}

export interface AIVerificationSourceFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
