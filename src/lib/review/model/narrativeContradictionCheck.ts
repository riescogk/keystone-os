import type {
  ModelFindingDraft,
  ModelReviewFailureReason,
  PageText,
} from "@/lib/review/types";
import type { ModelReviewProvider } from "@/lib/review/model/provider";
import {
  eligibleChecks,
  selectPassages,
  type ContradictionCheckType,
  type Passage,
  type SelectedPassages,
} from "@/lib/review/model/passageSelection";

/**
 * PRD Section 18 category 4 — narrative-to-data contradiction
 * detection (Model-Based), implemented per PRD Section 13's workflow:
 *
 *   1. input assembly      -> selectPassages() (deterministic, capped)
 *   2. narrow check        -> INSTRUCTIONS below (two named comparisons)
 *   3. evidence required   -> verifyQuote(): a finding whose quotes are
 *                             not found verbatim in the supplied text
 *                             is DISCARDED, never shown as a vague flag
 *   4. model-based label   -> every draft carries confidence "model_based"
 *   5. judgment boundary   -> violatesJudgmentBoundary(): findings that
 *                             imply a view on value / cap rate /
 *                             adjustment correctness are DISCARDED
 *   6. output              -> ModelFindingDraft (same shape as every
 *                             deterministic finding, plus confidence)
 *
 * The model is only trusted to *notice* a candidate inconsistency. All
 * grounding, labeling, severity, and boundary enforcement is ordinary
 * deterministic code that does not depend on the model behaving.
 */

export const NARRATIVE_CHECK_VERSION = "narrative-contradiction-v1";

/**
 * Severity is fixed by code, never chosen by the model. PRD Section 19
 * lists value-relevant condition/HBU contradictions as Critical, but
 * the Company Bible (Section 21) calls this "the highest-risk check
 * category" and asks for "conservative severity labeling until
 * real-world precision is measured." Until precision is measured on
 * real reports, model-based findings are capped at Moderate. Raising
 * this is a one-line change, deliberately left to a founder decision.
 */
export const MODEL_FINDING_SEVERITY = "moderate" as const;

export const MAX_FINDINGS = 3;
export const MAX_OUTPUT_TOKENS = 4000;
export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_CHARS = 320;
const MAX_QUOTE_CHARS = 240;
const MIN_QUOTE_CHARS = 8;

const SCHEMA_NAME = "narrative_contradiction_findings";

function evidenceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["passage_id", "quote"],
    properties: {
      passage_id: { type: "string" },
      quote: { type: "string" },
    },
  };
}

/** Strict JSON Schema sent to the provider; validated again locally. */
export const RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check_type", "description", "evidence_a", "evidence_b"],
        properties: {
          check_type: { type: "string", enum: ["condition", "zoning_hbu"] },
          description: { type: "string" },
          evidence_a: evidenceSchema(),
          evidence_b: evidenceSchema(),
        },
      },
    },
  },
};

export const INSTRUCTIONS = `You are a second reader checking ONE narrow thing in a commercial appraisal report. You are given short passages that were extracted from the report text. You do not appraise anything and you do not rewrite anything.

Run only the checks for which passages are provided:

CHECK "condition" (passages labeled A1, A2, ...): Report a finding ONLY if two passages describe the SUBJECT property's overall physical condition, or its deferred-maintenance status, in ways that cannot both be true as written (for example, one passage says the improvements are in good condition with no deferred maintenance, and another says there is significant deferred maintenance).

CHECK "zoning_hbu" (passages labeled B1, B2, ...): Report a finding ONLY if two passages state facts about the SUBJECT property's zoning, or about whether a use is legally permitted, in ways that cannot both be true as written (for example, two different zoning designations for the subject, or one passage saying the use is conforming/permitted while another says it is non-conforming/not permitted).

Rules:
- Use ONLY the passages provided. Do not use outside knowledge. Do not guess what the report "means".
- Consider statements about the subject property only. Ignore statements about comparable properties, markets, or neighborhoods.
- Statements may legitimately differ because they refer to different buildings, units, dates, or scenarios (for example "as is" versus "as complete", or "current" versus "proposed"). If the passages could be describing different things, do NOT report a finding.
- Never say which statement is right or wrong. Never comment on value, market value, capitalization rates, discount rates, adjustments, or whether any conclusion is reasonable or appropriate. Describe only that two stated passages do not agree.
- Each finding must cite exactly two passages by id, each with a short quote copied EXACTLY, word for word, from that passage.
- The description must be one neutral sentence of at most 40 words that states what the two passages say differently.
- If evidence is insufficient, ambiguous, or you are unsure, return an empty findings array. Returning no findings is the correct answer in most reports.
- Return at most ${MAX_FINDINGS} findings. Respond with JSON only, matching the provided schema.`;

/* ------------------------------------------------------------------ */
/* Input assembly                                                      */
/* ------------------------------------------------------------------ */

const CHECK_HEADINGS: Record<ContradictionCheckType, string> = {
  condition: 'CHECK "condition" — passages about the property\'s condition',
  zoning_hbu:
    'CHECK "zoning_hbu" — passages about zoning, permitted use, and highest and best use',
};

/**
 * The user-visible payload sent to the provider. It contains ONLY the
 * selected passage text and their ids/page numbers — no report id, no
 * filename, no user or account information, no credentials.
 */
export function buildModelInput(
  selected: SelectedPassages,
  checks: ContradictionCheckType[]
): string {
  return checks
    .map((check) => {
      const lines = selected[check].map(
        (passage) =>
          `[${passage.id}] (page ${passage.pageNumber}) ${passage.text}`
      );
      return `${CHECK_HEADINGS[check]}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/* ------------------------------------------------------------------ */
/* Judgment-boundary guard (PRD Section 13 step 5, Manifesto 0.4)      */
/* ------------------------------------------------------------------ */

/**
 * Words/phrases that would imply a view on value, rates, adjustments,
 * or correctness. Applied to the MODEL-AUTHORED description only (an
 * appraiser's own quoted text may legitimately mention a cap rate).
 * A finding that trips this is discarded rather than rewritten: PRD
 * Section 13 allows "rejected/rewritten", and rejecting is the
 * option that cannot accidentally let a judgment through.
 */
const JUDGMENT_PATTERNS: RegExp[] = [
  /\bmarket value\b/i,
  /\bappraised value\b/i,
  /\bvalue (?:conclusion|estimate|opinion|range)\b/i,
  /\b(?:over|under)(?:stated|valued|estimated)\b/i,
  /\bcap(?:italization)? rates?\b/i,
  /\bdiscount rates?\b/i,
  /\badjustments?\b/i,
  /\bshould (?:be|have|use|reflect)\b/i,
  /\b(?:in)?correct(?:ly)?\b/i,
  /\bwrong(?:ly)?\b/i,
  /\b(?:un)?reasonabl[ey]\b/i,
  /\b(?:in)?appropriate(?:ly)?\b/i,
  /\bmore (?:likely|accurate|credible)\b/i,
  /\brecommend\w*\b/i,
  /\b(?:supports?|unsupported|justif\w+)\b/i,
  /\berror\b/i,
];

export function violatesJudgmentBoundary(description: string): boolean {
  return JUDGMENT_PATTERNS.some((pattern) => pattern.test(description));
}

/* ------------------------------------------------------------------ */
/* Evidence grounding (PRD Section 13 step 3)                          */
/* ------------------------------------------------------------------ */

function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A quote counts as evidence only if it appears, verbatim (ignoring
 * case, curly-vs-straight quotes, and whitespace), inside the passage
 * the model said it came from. This is what makes a hallucinated or
 * paraphrased "quote" unable to reach the user.
 */
export function verifyQuote(passage: Passage, quote: string): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  if (
    normalizedQuote.length < MIN_QUOTE_CHARS ||
    normalizedQuote.length > MAX_QUOTE_CHARS
  ) {
    return false;
  }
  return normalizeForMatch(passage.text).includes(normalizedQuote);
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

interface RawEvidence {
  passage_id: string;
  quote: string;
}

interface RawFinding {
  check_type: ContradictionCheckType;
  description: string;
  evidence_a: RawEvidence;
  evidence_b: RawEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvidence(value: unknown): RawEvidence | null {
  if (!isRecord(value)) return null;
  if (typeof value.passage_id !== "string") return null;
  if (typeof value.quote !== "string") return null;
  return { passage_id: value.passage_id, quote: value.quote };
}

function parseRawFinding(value: unknown): RawFinding | null {
  if (!isRecord(value)) return null;
  const { check_type, description } = value;
  if (check_type !== "condition" && check_type !== "zoning_hbu") return null;
  if (typeof description !== "string") return null;
  const evidenceA = parseEvidence(value.evidence_a);
  const evidenceB = parseEvidence(value.evidence_b);
  if (!evidenceA || !evidenceB) return null;
  return {
    check_type,
    description,
    evidence_a: evidenceA,
    evidence_b: evidenceB,
  };
}

/**
 * Parses the model's raw text into findings, or returns null if the
 * response is malformed (not JSON, wrong shape, too many findings, or
 * any item with the wrong shape). Malformed responses are rejected as
 * a whole — a partially-wrong response is not trusted.
 */
export function parseModelResponse(rawText: string): RawFinding[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (Object.keys(parsed).some((key) => key !== "findings")) return null;
  if (!Array.isArray(parsed.findings)) return null;
  if (parsed.findings.length > MAX_FINDINGS) return null;

  const findings: RawFinding[] = [];
  for (const item of parsed.findings) {
    const finding = parseRawFinding(item);
    if (!finding) return null;
    findings.push(finding);
  }
  return findings;
}

const FINDING_PREFIX: Record<ContradictionCheckType, string> = {
  condition:
    "Possible conflict in the stated property condition — worth a second look: ",
  zoning_hbu:
    "Possible conflict between stated zoning and highest-and-best-use statements — worth a second look: ",
};

export interface GroundingStats {
  returned: number;
  accepted: number;
  discarded: number;
}

/**
 * Turns validated raw findings into drafts, discarding (never
 * repairing) any that fail grounding or the judgment boundary.
 */
export function groundFindings(
  rawFindings: RawFinding[],
  selected: SelectedPassages,
  checks: ContradictionCheckType[]
): { drafts: ModelFindingDraft[]; stats: GroundingStats } {
  const drafts: ModelFindingDraft[] = [];
  const seen = new Set<string>();

  for (const raw of rawFindings) {
    if (!checks.includes(raw.check_type)) continue;

    const passages = selected[raw.check_type];
    const passageA = passages.find((p) => p.id === raw.evidence_a.passage_id);
    const passageB = passages.find((p) => p.id === raw.evidence_b.passage_id);
    if (!passageA || !passageB) continue;

    if (!verifyQuote(passageA, raw.evidence_a.quote)) continue;
    if (!verifyQuote(passageB, raw.evidence_b.quote)) continue;

    // Two statements to compare: the quotes themselves must differ.
    if (
      normalizeForMatch(raw.evidence_a.quote) ===
      normalizeForMatch(raw.evidence_b.quote)
    ) {
      continue;
    }

    const description = raw.description.replace(/\s+/g, " ").trim();
    if (
      description.length === 0 ||
      description.length > MAX_DESCRIPTION_CHARS ||
      violatesJudgmentBoundary(description)
    ) {
      continue;
    }

    const dedupeKey = [raw.check_type, passageA.id, passageB.id]
      .sort()
      .join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const quoteA = raw.evidence_a.quote.trim();
    const quoteB = raw.evidence_b.quote.trim();
    const pages = [passageA.pageNumber, passageB.pageNumber];

    drafts.push({
      category: "narrative_data_contradiction",
      severity: MODEL_FINDING_SEVERITY,
      confidence: "model_based",
      description: `${FINDING_PREFIX[raw.check_type]}${description}`,
      evidence: `Page ${passageA.pageNumber}: "${quoteA}" vs. Page ${passageB.pageNumber}: "${quoteB}"`,
      location: [...new Set(pages)]
        .sort((a, b) => a - b)
        .map((p) => `Page ${p}`)
        .join(", "),
    });
  }

  return {
    drafts,
    stats: {
      returned: rawFindings.length,
      accepted: drafts.length,
      discarded: rawFindings.length - drafts.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type NarrativeCheckResult =
  | {
      status: "ok";
      findings: ModelFindingDraft[];
      /** False when no comparable passages existed, so no paid call was made. */
      modelCalled: boolean;
      stats: GroundingStats;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { status: "failed"; reason: ModelReviewFailureReason };

/**
 * Runs the whole check against a document. The provider is injected,
 * so this function is fully testable without a real (paid) API call.
 * Never throws for provider failures — they are returned as typed
 * results so the caller can record them without losing anything else.
 */
export async function runNarrativeContradictionCheck(
  pages: PageText[],
  provider: ModelReviewProvider
): Promise<NarrativeCheckResult> {
  const selected = selectPassages(pages);
  const checks = eligibleChecks(selected);

  // Cost control: nothing comparable in the report -> no model call.
  if (checks.length === 0) {
    return {
      status: "ok",
      findings: [],
      modelCalled: false,
      stats: { returned: 0, accepted: 0, discarded: 0 },
    };
  }

  const result = await provider.generateStructured({
    instructions: INSTRUCTIONS,
    input: buildModelInput(selected, checks),
    schemaName: SCHEMA_NAME,
    jsonSchema: RESPONSE_JSON_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (!result.ok) {
    return { status: "failed", reason: result.reason };
  }

  const rawFindings = parseModelResponse(result.text);
  if (rawFindings === null) {
    return { status: "failed", reason: "invalid_output" };
  }

  const { drafts, stats } = groundFindings(rawFindings, selected, checks);
  return {
    status: "ok",
    findings: drafts,
    modelCalled: true,
    stats,
    usage: result.usage,
  };
}
