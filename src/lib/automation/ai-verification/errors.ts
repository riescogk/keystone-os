import type {
  AIVerificationFailureReason,
  AIVerificationFailureState,
} from "./types";

const UNAVAILABLE_REASONS = new Set<AIVerificationFailureReason>([
  "not_configured",
  "insufficient_credits",
  "rate_limited",
]);

export class AIVerificationError extends Error {
  readonly reason: AIVerificationFailureReason;

  constructor(reason: AIVerificationFailureReason, message?: string) {
    super(message ?? reason);
    this.name = "AIVerificationError";
    this.reason = reason;
  }
}

export function verificationFailureState(
  reason: AIVerificationFailureReason
): AIVerificationFailureState {
  return {
    status: UNAVAILABLE_REASONS.has(reason) ? "unavailable" : "failed",
    failureReason: reason,
  };
}
