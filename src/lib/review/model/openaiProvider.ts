import OpenAI from "openai";
import type {
  ModelReviewProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/lib/review/model/provider";

/**
 * Default model: a DATED SNAPSHOT, not the moving "gpt-5.4-mini"
 * alias. The Company Bible (Section 21) names silent provider model
 * drift as a real risk — an alias can change behavior with no code
 * change on our side. Pinning a snapshot makes behavior stable until
 * we deliberately change it. Override with OPENAI_REVIEW_MODEL.
 */
export const DEFAULT_OPENAI_REVIEW_MODEL = "gpt-5.4-mini-2026-03-17";

/** The subset of the environment this provider reads (injectable for tests). */
type ProviderEnv = Record<string, string | undefined>;

/** Reasoning models accept `reasoning.effort`; others reject the parameter. */
function supportsReasoningEffort(modelId: string): boolean {
  return /^(gpt-5|o\d)/.test(modelId);
}

/**
 * Builds the OpenAI-backed provider, or returns null when
 * OPENAI_API_KEY is not set. Null is a normal, expected state (the
 * model layer is optional): the caller records it as "unavailable"
 * and the deterministic review is unaffected.
 *
 * The key is read from the server environment only. This module must
 * only ever be imported from server code; the key is never placed in
 * a NEXT_PUBLIC_ variable and never reaches the browser.
 */
export function createOpenAIProvider(
  env: ProviderEnv = process.env
): ModelReviewProvider | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const modelId =
    env.OPENAI_REVIEW_MODEL?.trim() || DEFAULT_OPENAI_REVIEW_MODEL;

  return {
    id: "openai",
    modelId,

    async generateStructured(
      request: StructuredModelRequest
    ): Promise<StructuredModelResult> {
      // maxRetries: 0 — a retry would silently double the wall-clock
      // time inside a serverless invocation that has a hard limit;
      // failing fast and recording the failure is the safer behavior.
      const client = new OpenAI({
        apiKey,
        timeout: request.timeoutMs,
        maxRetries: 0,
      });

      try {
        const response = await client.responses.create({
          model: modelId,
          instructions: request.instructions,
          input: request.input,
          // The Responses API stores application state for 30 days by
          // default. Appraisal text is sensitive client data (PRD
          // Section 26): do not ask OpenAI to retain it.
          store: false,
          max_output_tokens: request.maxOutputTokens,
          ...(supportsReasoningEffort(modelId)
            ? { reasoning: { effort: "low" as const } }
            : {}),
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              schema: request.jsonSchema,
              strict: true,
            },
          },
        });

        if (response.status === "incomplete") {
          return { ok: false, reason: "incomplete" };
        }
        if (response.status !== "completed") {
          return { ok: false, reason: "provider_error" };
        }

        const refused = response.output.some(
          (item) =>
            item.type === "message" &&
            item.content.some((part) => part.type === "refusal")
        );
        if (refused) {
          return { ok: false, reason: "refused" };
        }

        const text = response.output_text;
        if (!text) {
          return { ok: false, reason: "provider_error" };
        }

        return {
          ok: true,
          text,
          usage: response.usage
            ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
              }
            : undefined,
        };
      } catch (error) {
        // Log the error class/status only — never request content.
        console.error("[model-review] OpenAI request failed:", {
          name: error instanceof Error ? error.name : "unknown",
          status: error instanceof OpenAI.APIError ? error.status : undefined,
        });
        if (error instanceof OpenAI.APIConnectionTimeoutError) {
          return { ok: false, reason: "timeout" };
        }
        return { ok: false, reason: "provider_error" };
      }
    },
  };
}
