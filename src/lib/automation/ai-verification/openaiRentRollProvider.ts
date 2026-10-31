import { AIVerificationError } from "./errors";
import type {
  RentRollAIExtractionRequest,
  RentRollAIVerificationProvider,
} from "./provider";
import type {
  RentRollVerificationDocument,
  RentRollVerificationUnit,
} from "./rentRollTypes";
import type {
  AIVerificationConfidence,
  AIVerificationEvidence,
  AIVerificationFailureReason,
  AIVerificationSourceFile,
} from "./types";

export const DEFAULT_OPENAI_AUTOMATION_VERIFY_MODEL = "gpt-6.1-sol";
export const DEFAULT_OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS = 120_000;
export const DEFAULT_OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS = 32_768;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

interface OpenAIProviderEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_AUTOMATION_VERIFY_MODEL?: string;
  OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS?: string;
  OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS?: string;
}

interface OpenAIResponseContent {
  type?: string;
  text?: string;
  refusal?: string;
}

interface OpenAIResponseOutputItem {
  type?: string;
  content?: OpenAIResponseContent[];
}

interface OpenAIResponseBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: OpenAIResponseOutputItem[];
  error?: {
    message?: string;
    type?: string;
    code?: string | null;
  };
}

interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string | null;
  };
}

const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    sourceName: { type: ["string", "null"] },
    page: { type: ["integer", "null"] },
    sheet: { type: ["string", "null"] },
    row: { type: ["integer", "null"] },
    excerpt: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
  },
  required: ["sourceName", "page", "sheet", "row", "excerpt", "note"],
  additionalProperties: false,
} as const;

const RENT_ROLL_SCHEMA = {
  type: "object",
  properties: {
    propertyName: { type: ["string", "null"] },
    asOfDate: { type: ["string", "null"] },
    expectedUnitCount: { type: ["integer", "null"] },
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit: { type: "string" },
          unitType: { type: ["string", "null"] },
          sqft: { type: ["number", "string", "null"] },
          unitCategory: { type: ["string", "null"] },
          residentName: { type: ["string", "null"] },
          marketRent: { type: ["number", "string", "null"] },
          chargeCodes: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" },
              { type: "null" },
            ],
          },
          rentAmount: { type: ["number", "string", "null"] },
          evidence: {
            type: "array",
            items: EVIDENCE_SCHEMA,
          },
          explanation: { type: ["string", "null"] },
          confidence: {
            anyOf: [
              { type: "string", enum: ["high", "medium", "low"] },
              { type: "null" },
            ],
          },
        },
        required: [
          "unit",
          "unitType",
          "sqft",
          "unitCategory",
          "residentName",
          "marketRent",
          "chargeCodes",
          "rentAmount",
          "evidence",
          "explanation",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["propertyName", "asOfDate", "expectedUnitCount", "units", "warnings"],
  additionalProperties: false,
} as const;

const RENT_ROLL_INSTRUCTIONS = `You are an independent quality-control extractor for a property Rent Roll.

Your job is to reconstruct the expected clean Rent Roll directly from the ORIGINAL source file. Do not assume any other software output is correct; you will not be shown Keystone's result.

Extract every real unit exactly once, preserving unit identifiers as strings including leading zeroes.

For each unit extract:
- unit
- unitType / floorplan
- square footage
- resident name or vacancy/model label
- market rent
- qualifying rent charge code(s)
- total qualifying rent amount

The user will provide the allowed rent charge codes. Only those codes contribute to rentAmount. If more than one qualifying charge exists for a unit (for example RENT + SUBRENT), include all matching codes and SUM their amounts.

Former residents, applicants, future residents, historical charge rows, report totals, headers, and footers must not become extra units. A former/applicant row attached to a real unit must not replace the current unit/resident record.

expectedUnitCount should come from a trustworthy source summary/count when the document provides one. Otherwise use null; do not merely copy units.length unless the document itself supports that count.

unitCategory is a derived display category. If the source does not explicitly provide the category, leave it null. Keystone will derive the category consistently after extraction.

Use null rather than inventing values. Distinguish a blank value from numeric zero.

Evidence should be compact: normally use an empty array. Add at most one or two evidence entries only for ambiguous rows, unusual exclusions, or low/medium-confidence extraction. Keep excerpts short.

Warnings should call out meaningful uncertainty, unreadable sections, ambiguous unit boundaries, suspicious duplicate units, or totals that do not reconcile. Do not add generic disclaimers.`;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mimeTypeFor(file: AIVerificationSourceFile): string {
  if (file.mimeType.trim()) {
    return file.mimeType.trim();
  }

  const lower = file.name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  return "application/octet-stream";
}

function inputFilePart(file: AIVerificationSourceFile) {
  const mimeType = mimeTypeFor(file);
  const base64 = Buffer.from(file.bytes).toString("base64");

  return {
    type: "input_file",
    filename: file.name,
    file_data: `data:${mimeType};base64,${base64}`,
    ...(mimeType === "application/pdf" ? { detail: "high" } : {}),
  };
}

function failureReasonForHttp(status: number, body: OpenAIErrorBody): AIVerificationFailureReason {
  const code = body.error?.code?.toLowerCase() ?? "";
  const type = body.error?.type?.toLowerCase() ?? "";
  const message = body.error?.message?.toLowerCase() ?? "";

  if (status === 429) {
    if (
      code.includes("insufficient_quota") ||
      code.includes("billing") ||
      type.includes("insufficient_quota") ||
      message.includes("quota") ||
      message.includes("billing") ||
      message.includes("credit")
    ) {
      return "insufficient_credits";
    }
    return "rate_limited";
  }

  if (status === 408 || status === 504) {
    return "timeout";
  }

  return "provider_error";
}

function outputTextFrom(body: OpenAIResponseBody): string {
  if (body.status === "incomplete") {
    throw new AIVerificationError(
      "incomplete",
      `OpenAI returned an incomplete response${body.incomplete_details?.reason ? `: ${body.incomplete_details.reason}` : "."}`
    );
  }

  for (const item of body.output ?? []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content.type === "refusal") {
        throw new AIVerificationError(
          "refused",
          content.refusal || "OpenAI declined to process the Rent Roll."
        );
      }
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  throw new AIVerificationError(
    "invalid_output",
    "OpenAI returned no structured Rent Roll output."
  );
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AIVerificationError("invalid_output", `${field} must be a string or null.`);
  }
  return value;
}

function evidenceArray(value: unknown): AIVerificationEvidence[] {
  if (!Array.isArray(value)) {
    throw new AIVerificationError("invalid_output", "evidence must be an array.");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AIVerificationError("invalid_output", "evidence entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    return {
      sourceName: record.sourceName === null ? undefined : nullableString(record.sourceName, "evidence.sourceName") ?? undefined,
      page: record.page === null ? undefined : typeof record.page === "number" ? record.page : undefined,
      sheet: record.sheet === null ? undefined : nullableString(record.sheet, "evidence.sheet") ?? undefined,
      row: record.row === null ? undefined : typeof record.row === "number" ? record.row : undefined,
      excerpt: record.excerpt === null ? undefined : nullableString(record.excerpt, "evidence.excerpt") ?? undefined,
      note: record.note === null ? undefined : nullableString(record.note, "evidence.note") ?? undefined,
    };
  });
}

function confidenceValue(value: unknown): AIVerificationConfidence | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  throw new AIVerificationError("invalid_output", "confidence must be high, medium, low, or null.");
}

function parseUnit(value: unknown, index: number): RentRollVerificationUnit {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIVerificationError("invalid_output", `units[${index}] must be an object.`);
  }

  const unit = value as Record<string, unknown>;
  if (typeof unit.unit !== "string" || !unit.unit.trim()) {
    throw new AIVerificationError("invalid_output", `units[${index}].unit must be a non-empty string.`);
  }

  const numericOrStringOrNull = (input: unknown, field: string) => {
    if (input === null || typeof input === "number" || typeof input === "string") {
      return input;
    }
    throw new AIVerificationError("invalid_output", `${field} must be a number, string, or null.`);
  };

  let chargeCodes: string[] | string | null;
  if (unit.chargeCodes === null || typeof unit.chargeCodes === "string") {
    chargeCodes = unit.chargeCodes;
  } else if (Array.isArray(unit.chargeCodes) && unit.chargeCodes.every((item) => typeof item === "string")) {
    chargeCodes = unit.chargeCodes as string[];
  } else {
    throw new AIVerificationError("invalid_output", `units[${index}].chargeCodes is invalid.`);
  }

  return {
    unit: unit.unit,
    unitType: nullableString(unit.unitType, `units[${index}].unitType`),
    sqft: numericOrStringOrNull(unit.sqft, `units[${index}].sqft`),
    unitCategory: nullableString(unit.unitCategory, `units[${index}].unitCategory`),
    residentName: nullableString(unit.residentName, `units[${index}].residentName`),
    marketRent: numericOrStringOrNull(unit.marketRent, `units[${index}].marketRent`),
    chargeCodes,
    rentAmount: numericOrStringOrNull(unit.rentAmount, `units[${index}].rentAmount`),
    evidence: evidenceArray(unit.evidence),
    explanation: nullableString(unit.explanation, `units[${index}].explanation`) ?? undefined,
    confidence: confidenceValue(unit.confidence),
  };
}

export function parseRentRollAIOutput(text: string): RentRollVerificationDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AIVerificationError("invalid_output", "OpenAI returned invalid JSON for the Rent Roll.");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AIVerificationError("invalid_output", "OpenAI Rent Roll output must be an object.");
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.units) || !Array.isArray(record.warnings)) {
    throw new AIVerificationError("invalid_output", "OpenAI Rent Roll output is missing units or warnings.");
  }
  if (!record.warnings.every((item) => typeof item === "string")) {
    throw new AIVerificationError("invalid_output", "OpenAI Rent Roll warnings must be strings.");
  }

  const expectedUnitCount = record.expectedUnitCount;
  if (
    expectedUnitCount !== null &&
    !(typeof expectedUnitCount === "number" && Number.isInteger(expectedUnitCount) && expectedUnitCount >= 0)
  ) {
    throw new AIVerificationError("invalid_output", "expectedUnitCount must be a non-negative integer or null.");
  }

  return {
    propertyName: nullableString(record.propertyName, "propertyName"),
    asOfDate: nullableString(record.asOfDate, "asOfDate"),
    expectedUnitCount: expectedUnitCount as number | null,
    units: record.units.map(parseUnit),
    warnings: record.warnings as string[],
  };
}

export function createOpenAIRentRollVerificationProvider(
  env: OpenAIProviderEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AUTOMATION_VERIFY_MODEL:
      process.env.OPENAI_AUTOMATION_VERIFY_MODEL,
    OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS:
      process.env.OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS,
    OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS:
      process.env.OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS,
  }
): RentRollAIVerificationProvider | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const model = env.OPENAI_AUTOMATION_VERIFY_MODEL?.trim() || DEFAULT_OPENAI_AUTOMATION_VERIFY_MODEL;
  const timeoutMs = parsePositiveInteger(
    env.OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS,
    DEFAULT_OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS
  );
  const maxOutputTokens = parsePositiveInteger(
    env.OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS,
    DEFAULT_OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS
  );

  return {
    name: `openai:${model}`,

    async extractRentRoll(request: RentRollAIExtractionRequest): Promise<RentRollVerificationDocument> {
      if (request.files.length !== 1) {
        throw new AIVerificationError(
          "provider_error",
          "Rent Roll AI verification currently expects exactly one source file."
        );
      }

      const sourceFile = request.files[0];
      const allowedCodes = (request.chargeCodes ?? []).map((code) => code.trim()).filter(Boolean);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            instructions: RENT_ROLL_INSTRUCTIONS,
            input: [
              {
                role: "user",
                content: [
                  inputFilePart(sourceFile),
                  {
                    type: "input_text",
                    text: `Allowed rent charge codes: ${allowedCodes.join(", ") || "none supplied"}. Independently extract the complete Rent Roll into the required schema.`,
                  },
                ],
              },
            ],
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: "json_schema",
                name: "keystone_rent_roll_verification",
                strict: true,
                schema: RENT_ROLL_SCHEMA,
              },
            },
          }),
          signal: controller.signal,
        });

        let body: OpenAIResponseBody | OpenAIErrorBody = {};
        try {
          body = (await response.json()) as OpenAIResponseBody | OpenAIErrorBody;
        } catch {
          // A non-JSON provider failure is still a provider error below.
        }

        if (!response.ok) {
          const reason = failureReasonForHttp(response.status, body as OpenAIErrorBody);
          const message = (body as OpenAIErrorBody).error?.message || `OpenAI request failed with HTTP ${response.status}.`;
          throw new AIVerificationError(reason, message);
        }

        const outputText = outputTextFrom(body as OpenAIResponseBody);
        return parseRentRollAIOutput(outputText);
      } catch (error) {
        if (error instanceof AIVerificationError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new AIVerificationError("timeout", "OpenAI Rent Roll verification timed out.");
        }
        throw new AIVerificationError(
          "provider_error",
          error instanceof Error ? error.message : "OpenAI Rent Roll verification failed."
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
