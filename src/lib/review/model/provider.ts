/**
 * The only thing the model-based review layer knows about a model
 * provider. Deliberately tiny: the review logic hands over fixed
 * instructions, already-selected passages, and a JSON Schema, and
 * gets back raw JSON text (or a typed failure). It never sees an SDK
 * object, an API key, or provider-specific response shapes — so
 * swapping OpenAI for another provider means writing one new file
 * that implements this interface, with no change to the review logic.
 *
 * Output validation is intentionally NOT the provider's job: even with
 * provider-side strict schema enforcement, the review layer re-validates
 * everything itself (src/lib/review/model/narrativeContradictionCheck.ts),
 * so correctness never depends on a vendor feature.
 */

export interface StructuredModelRequest {
  /** Fixed, category-specific task instructions (contains no document content). */
  instructions: string;
  /** The extracted report passages for this check — the only document content sent. */
  input: string;
  /** Identifier for the schema (a-z, A-Z, 0-9, _ and -). */
  schemaName: string;
  /** JSON Schema the response must follow. */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
}

export type ModelFailureReason =
  "timeout" | "provider_error" | "refused" | "incomplete";

export type StructuredModelResult =
  | {
      ok: true;
      /** Raw JSON text from the model. Not yet trusted or parsed. */
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; reason: ModelFailureReason };

export interface ModelReviewProvider {
  /** Provider name, e.g. "openai". */
  readonly id: string;
  /** Exact model identifier used, recorded for auditability. */
  readonly modelId: string;
  generateStructured(
    request: StructuredModelRequest
  ): Promise<StructuredModelResult>;
}
