import { AIVerificationError } from "./errors";
import type {
  IEAIExtractionRequest,
  IEAIVerificationProvider,
} from "./provider";
import type {
  IEVerificationDocument,
  IEVerificationReportType,
  IEVerificationRow,
  IEVerificationSource,
} from "./ieTypes";
import type {
  AIVerificationConfidence,
  AIVerificationEvidence,
  AIVerificationFailureReason,
  AIVerificationSourceFile,
} from "./types";
import {
  DEFAULT_OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS,
  DEFAULT_OPENAI_AUTOMATION_VERIFY_MODEL,
  DEFAULT_OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS,
} from "./openaiRentRollProvider";
import { normalizePeriodLabel } from "./normalize";

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

const REPORT_TYPES: IEVerificationReportType[] = [
  "annual",
  "t12",
  "separate_annual",
  "budget",
  "annualized",
  "unknown",
];

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

const IE_SCHEMA = {
  type: "object",
  properties: {
    propertyName: { type: ["string", "null"] },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filename: { type: "string" },
          reportType: { type: "string", enum: REPORT_TYPES },
          periodLabels: { type: "array", items: { type: "string" } },
        },
        required: ["filename", "reportType", "periodLabels"],
        additionalProperties: false,
      },
    },
    periodLabels: { type: "array", items: { type: "string" } },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          accountCode: { type: ["string", "null"] },
          internalNumber: { type: ["string", "number", "null"] },
          lineItem: { type: "string" },
          values: {
            type: "array",
            items: {
              type: "object",
              properties: {
                periodLabel: { type: "string" },
                value: { type: ["number", "string", "null"] },
              },
              required: ["periodLabel", "value"],
              additionalProperties: false,
            },
          },
          isSummary: { type: "boolean" },
          evidence: { type: "array", items: EVIDENCE_SCHEMA },
          explanation: { type: ["string", "null"] },
          confidence: {
            type: ["string", "null"],
            enum: ["high", "medium", "low", null],
          },
        },
        required: [
          "accountCode",
          "internalNumber",
          "lineItem",
          "values",
          "isSummary",
          "evidence",
          "explanation",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["propertyName", "sources", "periodLabels", "rows", "warnings"],
  additionalProperties: false,
} as const;

const IE_INSTRUCTIONS = `You are Keystone's independent I&E verification analyst.

You are a second reader. You MUST form your answer only from the original I&E source files and the separate Internal Number reference workbook supplied to you. You are not being shown Keystone's output and must not assume what Keystone produced.

Goal: independently reconstruct the canonical Combined I&E table that should result from the supplied property statements.

SOURCE CLASSIFICATION
- Classify each original property source as annual, separate_annual, t12, budget, annualized, or unknown.
- The Internal Number mapping/reference workbook is NOT a property source. Never include it in sources.
- All property sources should belong to one property. If names differ slightly, use the best property name supported by the documents and note meaningful uncertainty in warnings.

CANONICAL PERIOD LABELS
- Annual actual years: YYYY, for example 2024.
- T12: format as T12 Mon 'YY using the ENDING month/year, for example T12 Oct '26.
- Budget: format as YYYY Budget.
- Annualized: use the concise report label supported by the source; for the known T8 format use T8 Annualized.
- periodLabels must contain the final output periods in column order.

ROW UNIVERSE AND MERGING
- The base row universe is the union of valued rows from Annual/separate annual sources and the T12 source.
- Budget and Annualized sources contribute values only to matching base rows; they do NOT introduce brand-new rows absent from Annual/T12.
- Preserve duplicate line-item occurrences in source order. Never collapse duplicate names into one row.
- Keep the line item text faithfully, trimming only incidental whitespace.
- When a T12 row supplies an explicit account code, use it. If the final base row has no supported account code, use null rather than guessing.
- For every output row include one value entry for EVERY final periodLabel. Use null when that row has no value for a period. Zero is a real zero and must not become null.

INTERNAL NUMBER MAPPING
- Use the separate Internal Number reference workbook as the authoritative mapping aid.
- Summary rows (Total..., Net...) MUST have internalNumber null.
- For ordinary rows, choose an Internal Number only when the reference workbook supports the mapping with high confidence. Exact/obvious semantic matches are acceptable. If ambiguous, use null instead of guessing.
- Do not copy account codes into Internal Number unless the reference explicitly supports that mapping.

KEYSTONE BUSINESS RULES TO RECONSTRUCT INDEPENDENTLY
- A summary row is a line item equal to Total or Net, or beginning with Total / Net (case-insensitive).
- For line items containing Model Unit(s), flip the sign of every non-zero output value.
- For line items containing Employee Discount(s), flip the sign of every non-zero output value.
- Preserve accounting negatives. Preserve blank/null versus zero.
- Do not invent values that are not present in the source.

EVIDENCE / CONFIDENCE
- Keep evidence compact. Add sourceName plus page/sheet/row/excerpt when it materially helps verify a difficult extraction or mapping. An empty evidence array is fine for obvious rows.
- explanation should be null for straightforward rows; use a short explanation only for a non-obvious mapping/extraction.
- confidence is high, medium, low, or null.

Return the COMPLETE table. Do not omit rows merely because they are totals, repeated, zero-valued in one period, or difficult to map.`;

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mimeTypeFor(file: AIVerificationSourceFile): string {
  if (file.mimeType?.trim()) {
    return file.mimeType;
  }

  const lower = file.name.toLocaleLowerCase();
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".xlsm")) {
    return "application/vnd.ms-excel.sheet.macroEnabled.12";
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

function failureReasonForHttp(
  status: number,
  body: OpenAIErrorBody
): AIVerificationFailureReason {
  const code = body.error?.code?.toLocaleLowerCase() ?? "";
  const type = body.error?.type?.toLocaleLowerCase() ?? "";
  const message = body.error?.message?.toLocaleLowerCase() ?? "";

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
      `OpenAI returned an incomplete I&E response${body.incomplete_details?.reason ? `: ${body.incomplete_details.reason}` : "."}`
    );
  }

  const refusals = (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "refusal" || item.refusal)
    .map((item) => item.refusal)
    .filter((item): item is string => Boolean(item));

  if (refusals.length > 0) {
    throw new AIVerificationError("refused", refusals.join(" "));
  }

  const text = (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new AIVerificationError(
      "incomplete",
      "OpenAI returned no structured I&E output."
    );
  }

  return text;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AIVerificationError("invalid_output", `${field} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AIVerificationError("invalid_output", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AIVerificationError("invalid_output", `${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function evidenceArray(value: unknown): AIVerificationEvidence[] | undefined {
  if (!Array.isArray(value)) {
    throw new AIVerificationError("invalid_output", "evidence must be an array.");
  }

  if (value.length === 0) {
    return undefined;
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AIVerificationError("invalid_output", `evidence[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const page = record.page;
    const row = record.row;

    if (page !== null && !(typeof page === "number" && Number.isInteger(page) && page > 0)) {
      throw new AIVerificationError("invalid_output", `evidence[${index}].page is invalid.`);
    }
    if (row !== null && !(typeof row === "number" && Number.isInteger(row) && row > 0)) {
      throw new AIVerificationError("invalid_output", `evidence[${index}].row is invalid.`);
    }

    return {
      sourceName: nullableString(record.sourceName, `evidence[${index}].sourceName`) ?? undefined,
      page: page === null ? undefined : page as number,
      sheet: nullableString(record.sheet, `evidence[${index}].sheet`) ?? undefined,
      row: row === null ? undefined : row as number,
      excerpt: nullableString(record.excerpt, `evidence[${index}].excerpt`) ?? undefined,
      note: nullableString(record.note, `evidence[${index}].note`) ?? undefined,
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
  throw new AIVerificationError(
    "invalid_output",
    "confidence must be high, medium, low, or null."
  );
}

function parseSource(value: unknown, index: number): IEVerificationSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIVerificationError("invalid_output", `sources[${index}] must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const reportType = record.reportType;
  if (typeof reportType !== "string" || !REPORT_TYPES.includes(reportType as IEVerificationReportType)) {
    throw new AIVerificationError("invalid_output", `sources[${index}].reportType is invalid.`);
  }

  return {
    filename: requiredString(record.filename, `sources[${index}].filename`),
    reportType: reportType as IEVerificationReportType,
    periodLabels: stringArray(record.periodLabels, `sources[${index}].periodLabels`),
  };
}

function parseRow(
  value: unknown,
  index: number,
  periodLabels: string[]
): IEVerificationRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AIVerificationError("invalid_output", `rows[${index}] must be an object.`);
  }

  const record = value as Record<string, unknown>;
  const accountCode = nullableString(record.accountCode, `rows[${index}].accountCode`);
  const internalNumber = record.internalNumber;

  if (
    internalNumber !== null &&
    typeof internalNumber !== "string" &&
    !(typeof internalNumber === "number" && Number.isFinite(internalNumber))
  ) {
    throw new AIVerificationError(
      "invalid_output",
      `rows[${index}].internalNumber must be a string, number, or null.`
    );
  }

  if (typeof record.isSummary !== "boolean") {
    throw new AIVerificationError("invalid_output", `rows[${index}].isSummary must be boolean.`);
  }

  if (!Array.isArray(record.values)) {
    throw new AIVerificationError("invalid_output", `rows[${index}].values must be an array.`);
  }

  const values: Record<string, number | string | null> = {};
  const normalizedExpected = new Map<string, string>();

  for (const period of periodLabels) {
    const normalized = normalizePeriodLabel(period);
    if (!normalized) {
      throw new AIVerificationError("invalid_output", "periodLabels contains a blank label.");
    }
    if (normalizedExpected.has(normalized)) {
      throw new AIVerificationError("invalid_output", `periodLabels contains duplicate period '${period}'.`);
    }
    normalizedExpected.set(normalized, period);
  }

  const seen = new Set<string>();

  for (let valueIndex = 0; valueIndex < record.values.length; valueIndex += 1) {
    const item = record.values[valueIndex];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AIVerificationError(
        "invalid_output",
        `rows[${index}].values[${valueIndex}] must be an object.`
      );
    }

    const valueRecord = item as Record<string, unknown>;
    const periodLabel = requiredString(
      valueRecord.periodLabel,
      `rows[${index}].values[${valueIndex}].periodLabel`
    );
    const normalized = normalizePeriodLabel(periodLabel);

    if (!normalized || !normalizedExpected.has(normalized)) {
      throw new AIVerificationError(
        "invalid_output",
        `rows[${index}] contains unknown period '${periodLabel}'.`
      );
    }
    if (seen.has(normalized)) {
      throw new AIVerificationError(
        "invalid_output",
        `rows[${index}] contains duplicate period '${periodLabel}'.`
      );
    }
    seen.add(normalized);

    const rawValue = valueRecord.value;
    if (
      rawValue !== null &&
      typeof rawValue !== "string" &&
      !(typeof rawValue === "number" && Number.isFinite(rawValue))
    ) {
      throw new AIVerificationError(
        "invalid_output",
        `rows[${index}].values[${valueIndex}].value must be number, string, or null.`
      );
    }

    values[normalizedExpected.get(normalized) as string] = rawValue as number | string | null;
  }

  if (seen.size !== normalizedExpected.size) {
    const missing = [...normalizedExpected.keys()].filter((period) => !seen.has(period));
    throw new AIVerificationError(
      "invalid_output",
      `rows[${index}] is missing period values: ${missing.join(", ")}. Use null for unavailable values.`
    );
  }

  return {
    accountCode,
    internalNumber: internalNumber as string | number | null,
    lineItem: requiredString(record.lineItem, `rows[${index}].lineItem`),
    values,
    isSummary: record.isSummary,
    evidence: evidenceArray(record.evidence),
    explanation: nullableString(record.explanation, `rows[${index}].explanation`) ?? undefined,
    confidence: confidenceValue(record.confidence),
  };
}

export function parseIEAIOutput(text: string): IEVerificationDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AIVerificationError("invalid_output", "OpenAI returned invalid JSON for I&E verification.");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AIVerificationError("invalid_output", "OpenAI I&E output must be an object.");
  }

  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.sources) || !Array.isArray(record.rows)) {
    throw new AIVerificationError("invalid_output", "OpenAI I&E output is missing sources or rows.");
  }

  const periodLabels = stringArray(record.periodLabels, "periodLabels");
  const warnings = stringArray(record.warnings, "warnings");

  return {
    propertyName: nullableString(record.propertyName, "propertyName"),
    sources: record.sources.map(parseSource),
    periodLabels,
    rows: record.rows.map((row, index) => parseRow(row, index, periodLabels)),
    warnings,
  };
}

export function createOpenAIIEVerificationProvider(
  env: OpenAIProviderEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_AUTOMATION_VERIFY_MODEL: process.env.OPENAI_AUTOMATION_VERIFY_MODEL,
    OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS: process.env.OPENAI_AUTOMATION_VERIFY_TIMEOUT_MS,
    OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS: process.env.OPENAI_AUTOMATION_VERIFY_MAX_OUTPUT_TOKENS,
  }
): IEAIVerificationProvider | null {
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

    async extractIE(request: IEAIExtractionRequest): Promise<IEVerificationDocument> {
      if (request.files.length === 0) {
        throw new AIVerificationError("provider_error", "I&E AI verification requires at least one source file.");
      }
      if (!request.mappingReference) {
        throw new AIVerificationError(
          "provider_error",
          "I&E AI verification requires the Internal Number reference workbook."
        );
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const content = [
          ...request.files.map(inputFilePart),
          inputFilePart(request.mappingReference),
          {
            type: "input_text",
            text: `Original property source files: ${request.files.map((file) => file.name).join(", ")}. The file named '${request.mappingReference.name}' is ONLY the Internal Number mapping/reference workbook and must not be listed as a property source. Independently reconstruct the complete canonical Combined I&E table.`,
          },
        ];

        const response = await fetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            instructions: IE_INSTRUCTIONS,
            input: [{ role: "user", content }],
            max_output_tokens: maxOutputTokens,
            text: {
              format: {
                type: "json_schema",
                name: "keystone_ie_verification",
                strict: true,
                schema: IE_SCHEMA,
              },
            },
          }),
          signal: controller.signal,
        });

        let body: OpenAIResponseBody | OpenAIErrorBody = {};
        try {
          body = (await response.json()) as OpenAIResponseBody | OpenAIErrorBody;
        } catch {
          // Non-JSON provider failures are mapped below.
        }

        if (!response.ok) {
          const reason = failureReasonForHttp(response.status, body as OpenAIErrorBody);
          const message =
            (body as OpenAIErrorBody).error?.message ||
            `OpenAI I&E request failed with HTTP ${response.status}.`;
          throw new AIVerificationError(reason, message);
        }

        return parseIEAIOutput(outputTextFrom(body as OpenAIResponseBody));
      } catch (error) {
        if (error instanceof AIVerificationError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new AIVerificationError("timeout", "OpenAI I&E verification timed out.");
        }
        throw new AIVerificationError(
          "provider_error",
          error instanceof Error ? error.message : "OpenAI I&E verification failed."
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
