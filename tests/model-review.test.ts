import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PASSAGES_PER_CHECK,
  eligibleChecks,
  selectPassages,
} from "@/lib/review/model/passageSelection";
import {
  MAX_FINDINGS,
  groundFindings,
  parseModelResponse,
  runNarrativeContradictionCheck,
  verifyQuote,
  violatesJudgmentBoundary,
} from "@/lib/review/model/narrativeContradictionCheck";
import { isClaimable } from "@/lib/review/model/runModelReview";
import {
  DEFAULT_OPENAI_REVIEW_MODEL,
  createOpenAIProvider,
} from "@/lib/review/model/openaiProvider";
import type {
  ModelReviewProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "@/lib/review/model/provider";
import type { PageText } from "@/lib/review/types";

/** A document with two condition statements and two zoning/HBU statements. */
const PAGES: PageText[] = [
  {
    pageNumber: 3,
    text: "Client: Acme Capital Partners\nThe improvements are in good condition with no deferred maintenance observed.\nThe lobby was recently renovated.",
  },
  {
    pageNumber: 8,
    text: "Unrelated narrative about the neighborhood, schools and transit access.\nSecret internal note that must not be sent anywhere.",
  },
  {
    pageNumber: 12,
    text: "Physical inspection findings\nThe roof shows significant deferred maintenance and is in poor repair.\nRepairs are needed.",
  },
  {
    pageNumber: 20,
    text: "The subject is zoned C-2 General Commercial.\nRetail use is a legally permissible use.",
  },
  {
    pageNumber: 31,
    text: "Highest and best use analysis\nThe subject is zoned I-1 Light Industrial; retail use is non-conforming.",
  },
];

function fakeProvider(
  respond: (req: StructuredModelRequest) => StructuredModelResult
): ModelReviewProvider & { calls: StructuredModelRequest[] } {
  const calls: StructuredModelRequest[] = [];
  return {
    id: "fake",
    modelId: "fake-model",
    calls,
    async generateStructured(req) {
      calls.push(req);
      return respond(req);
    },
  };
}

function json(findings: unknown[]): StructuredModelResult {
  return { ok: true, text: JSON.stringify({ findings }) };
}

const GOOD_FINDING = {
  check_type: "condition",
  description:
    "One passage describes the improvements as having no deferred maintenance while another describes significant deferred maintenance.",
  evidence_a: {
    passage_id: "A1",
    quote: "in good condition with no deferred maintenance observed",
  },
  evidence_b: {
    passage_id: "A2",
    quote: "significant deferred maintenance and is in poor repair",
  },
};

describe("passage selection (what may leave the system)", () => {
  it("selects only passages relevant to the two checks, with page numbers", () => {
    const selected = selectPassages(PAGES);
    assert.ok(selected.condition.length >= 2);
    assert.ok(selected.zoning_hbu.length >= 2);
    assert.deepEqual(eligibleChecks(selected).sort(), [
      "condition",
      "zoning_hbu",
    ]);
    const all = [...selected.condition, ...selected.zoning_hbu];
    assert.ok(all.every((p) => p.pageNumber > 0 && p.text.length > 0));
  });

  it("never selects unrelated page text", () => {
    const sent = JSON.stringify(selectPassages(PAGES));
    assert.ok(!sent.includes("Secret internal note"));
    assert.ok(!sent.includes("schools and transit"));
  });

  it("is not eligible when fewer than two comparable passages exist", () => {
    const one: PageText[] = [
      { pageNumber: 1, text: "The property is in good condition." },
    ];
    assert.deepEqual(eligibleChecks(selectPassages(one)), []);
  });

  it("caps the number of passages and samples across the whole document", () => {
    const many: PageText[] = Array.from({ length: 60 }, (_, i) => ({
      pageNumber: i + 1,
      text: `Filler line ${i}\nCondition note number ${i} for the building.\nMore filler ${i}`,
    }));
    const { condition } = selectPassages(many);
    assert.equal(condition.length, MAX_PASSAGES_PER_CHECK);
    const pages = condition.map((p) => p.pageNumber);
    assert.ok(Math.min(...pages) <= 6, "includes early pages");
    assert.ok(Math.max(...pages) >= 50, "includes late pages");
  });

  it("is deterministic", () => {
    assert.deepEqual(selectPassages(PAGES), selectPassages(PAGES));
  });
});

describe("response parsing (malformed output is rejected)", () => {
  it("accepts a valid response and an empty one", () => {
    assert.equal(
      parseModelResponse(JSON.stringify({ findings: [] }))?.length,
      0
    );
    assert.equal(
      parseModelResponse(JSON.stringify({ findings: [GOOD_FINDING] }))?.length,
      1
    );
  });

  it("rejects non-JSON, wrong shapes, extra keys, bad items, too many findings", () => {
    assert.equal(parseModelResponse("not json"), null);
    assert.equal(parseModelResponse("[]"), null);
    assert.equal(parseModelResponse(JSON.stringify({ findings: "x" })), null);
    assert.equal(
      parseModelResponse(JSON.stringify({ findings: [], extra: 1 })),
      null
    );
    assert.equal(
      parseModelResponse(
        JSON.stringify({ findings: [{ check_type: "other" }] })
      ),
      null
    );
    assert.equal(
      parseModelResponse(
        JSON.stringify({
          findings: [{ ...GOOD_FINDING, check_type: "severity_high" }],
        })
      ),
      null
    );
    const tooMany = Array.from(
      { length: MAX_FINDINGS + 1 },
      () => GOOD_FINDING
    );
    assert.equal(
      parseModelResponse(JSON.stringify({ findings: tooMany })),
      null
    );
  });
});

describe("evidence grounding and the judgment boundary", () => {
  const selected = selectPassages(PAGES);
  const checks = eligibleChecks(selected);
  const raw = (f: unknown) =>
    parseModelResponse(JSON.stringify({ findings: [f] }))!;

  it("accepts a grounded finding and labels it model-based, moderate, with page evidence", () => {
    const { drafts } = groundFindings(raw(GOOD_FINDING), selected, checks);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].confidence, "model_based");
    assert.equal(drafts[0].severity, "moderate");
    assert.equal(drafts[0].category, "narrative_data_contradiction");
    assert.match(drafts[0].description, /worth a second look/);
    assert.match(drafts[0].evidence, /Page 3: ".*" vs\. Page 12: ".*"/);
    assert.equal(drafts[0].location, "Page 3, Page 12");
  });

  it("discards a finding whose quote is not verbatim in the supplied text", () => {
    const bad = {
      ...GOOD_FINDING,
      evidence_b: {
        passage_id: "A2",
        quote: "the roof is collapsing and unsafe",
      },
    };
    const { drafts, stats } = groundFindings(raw(bad), selected, checks);
    assert.equal(drafts.length, 0);
    assert.equal(stats.discarded, 1);
  });

  it("discards findings citing an unknown passage, or the same quote twice", () => {
    const unknown = {
      ...GOOD_FINDING,
      evidence_a: {
        passage_id: "A99",
        quote: "in good condition with no deferred maintenance",
      },
    };
    assert.equal(
      groundFindings(raw(unknown), selected, checks).drafts.length,
      0
    );
    const same = { ...GOOD_FINDING, evidence_b: GOOD_FINDING.evidence_a };
    assert.equal(groundFindings(raw(same), selected, checks).drafts.length, 0);
  });

  it("discards findings for a check that was not eligible", () => {
    const f = { ...GOOD_FINDING, check_type: "zoning_hbu" };
    assert.equal(
      groundFindings(raw(f), selected, ["condition"]).drafts.length,
      0
    );
  });

  it("discards findings that imply a view on value, rates, adjustments or correctness", () => {
    for (const description of [
      "The condition statements conflict, which means the market value is overstated.",
      "The cap rate should be higher given the roof condition.",
      "The first statement is incorrect compared to the second.",
      "The adjustment for condition appears inappropriate.",
      "It is more likely that the poor repair statement is accurate.",
    ]) {
      assert.ok(violatesJudgmentBoundary(description), description);
      const { drafts } = groundFindings(
        raw({ ...GOOD_FINDING, description }),
        selected,
        checks
      );
      assert.equal(drafts.length, 0, description);
    }
    assert.ok(
      !violatesJudgmentBoundary(
        "One passage reports no deferred maintenance; another reports significant deferred maintenance."
      )
    );
  });

  it("verifyQuote tolerates case, whitespace and curly quotes but not paraphrase", () => {
    const passage = {
      id: "A1",
      pageNumber: 1,
      text: "The owner's building is in GOOD   condition.",
    };
    assert.ok(
      verifyQuote(passage, "the owner\u2019s building is in good condition")
    );
    assert.ok(!verifyQuote(passage, "the building is in great shape"));
    assert.ok(!verifyQuote(passage, "good"));
  });
});

describe("runNarrativeContradictionCheck (fake provider, no paid call)", () => {
  it("makes NO model call when nothing comparable exists", async () => {
    const provider = fakeProvider(() => json([]));
    const result = await runNarrativeContradictionCheck(
      [{ pageNumber: 1, text: "Nothing relevant here." }],
      provider
    );
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(result.status === "ok" && result.modelCalled, false);
  });

  it("sends only instructions + selected passages with a strict schema and bounded output", async () => {
    const provider = fakeProvider(() => json([GOOD_FINDING]));
    const result = await runNarrativeContradictionCheck(PAGES, provider);
    assert.equal(provider.calls.length, 1, "exactly one call for both checks");
    const req = provider.calls[0];
    assert.ok(req.maxOutputTokens > 0 && req.maxOutputTokens <= 4000);
    assert.ok(req.timeoutMs > 0 && req.timeoutMs <= 30_000);
    assert.equal(
      (req.jsonSchema as { additionalProperties: boolean })
        .additionalProperties,
      false
    );
    // Privacy: nothing but passage text/ids/pages reaches the provider.
    assert.ok(!req.input.includes("Secret internal note"));
    assert.ok(!req.input.includes("schools and transit"));
    assert.ok(
      !/(uuid|report_id|user_id|token|apikey|supabase)/i.test(
        req.input + req.instructions
      )
    );
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.findings.length, 1);
      assert.equal(result.modelCalled, true);
    }
  });

  it("maps every provider failure to a typed failure (never throws)", async () => {
    for (const reason of [
      "timeout",
      "provider_error",
      "refused",
      "incomplete",
    ] as const) {
      const result = await runNarrativeContradictionCheck(
        PAGES,
        fakeProvider(() => ({ ok: false, reason }))
      );
      assert.deepEqual(result, { status: "failed", reason });
    }
  });

  it("treats malformed model output as invalid_output", async () => {
    for (const text of [
      "I think there is a conflict.",
      "{}",
      '{"findings":[{"x":1}]}',
    ]) {
      const result = await runNarrativeContradictionCheck(
        PAGES,
        fakeProvider(() => ({ ok: true, text }))
      );
      assert.deepEqual(result, { status: "failed", reason: "invalid_output" });
    }
  });

  it("returns ok with zero findings when the model finds nothing", async () => {
    const result = await runNarrativeContradictionCheck(
      PAGES,
      fakeProvider(() => json([]))
    );
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.findings.length, 0);
  });
});

describe("claim rules (no repeated paid calls)", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const fresh = "2026-10-10T11:59:00Z";
  const stale = "2026-10-10T11:00:00Z";

  it("automatic runs start only from not_run", () => {
    assert.ok(isClaimable("not_run", null, "auto", now));
    for (const s of [
      "processing",
      "complete",
      "failed",
      "unavailable",
    ] as const) {
      assert.ok(!isClaimable(s, stale, "auto", now), s);
    }
  });

  it("manual runs may retry failed/unavailable and recover only STALE processing", () => {
    assert.ok(isClaimable("not_run", null, "manual", now));
    assert.ok(isClaimable("failed", null, "manual", now));
    assert.ok(isClaimable("unavailable", null, "manual", now));
    assert.ok(!isClaimable("processing", fresh, "manual", now));
    assert.ok(isClaimable("processing", stale, "manual", now));
    assert.ok(!isClaimable("complete", null, "manual", now));
  });
});

describe("OpenAI provider configuration", () => {
  it("is null (feature unavailable) without an API key", () => {
    assert.equal(createOpenAIProvider({}), null);
    assert.equal(createOpenAIProvider({ OPENAI_API_KEY: "   " }), null);
  });

  it("defaults to the pinned snapshot and allows an override", () => {
    assert.equal(
      createOpenAIProvider({ OPENAI_API_KEY: "sk-test" })?.modelId,
      DEFAULT_OPENAI_REVIEW_MODEL
    );
    assert.match(
      DEFAULT_OPENAI_REVIEW_MODEL,
      /\d{4}-\d{2}-\d{2}$/,
      "pinned, dated snapshot"
    );
    assert.equal(
      createOpenAIProvider({
        OPENAI_API_KEY: "sk-test",
        OPENAI_REVIEW_MODEL: "custom-model",
      })?.modelId,
      "custom-model"
    );
  });
});
