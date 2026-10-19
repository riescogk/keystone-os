import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  carryFieldsFor,
  evidenceFingerprint,
  findingMatchKey,
  matchFindings,
  planFindingInserts,
  type MatchableDraft,
  type StoredFindingLike,
} from "@/lib/review/comparison/findingMatching";
import {
  buildComparison,
  isChange,
  type ComparableFinding,
  type ComparableReview,
} from "@/lib/review/comparison/buildComparison";
import { checkRevisionTarget } from "@/lib/review/comparison/revisionEligibility";
import { checkCrossDocumentIdentityConsistency } from "@/lib/review/identityConsistencyCheck";
import { checkTemplateLeftovers } from "@/lib/review/templateLeftoverCheck";
import { checkTypoAndFormattingIssues } from "@/lib/review/typoFormattingCheck";
import { checkArithmeticVerification } from "@/lib/review/arithmeticVerificationCheck";
import type { FindingDraft, PageText } from "@/lib/review/types";

let n = 0;
const id = () => `f-${++n}`;

function stored(overrides: Partial<StoredFindingLike> = {}): StoredFindingLike {
  return {
    id: id(),
    category: "internal_arithmetic_verification",
    confidence: "deterministic",
    status: "open",
    description:
      "Net Operating Income does not match Effective Gross Income minus Total Operating Expenses.",
    evidence:
      "Stated Net Operating Income: $700,000 (Page 21). Effective Gross Income ($950,000, Page 20) minus Total Operating Expenses ($350,000, Page 20) equals $600,000 — a difference of $100,000.",
    dismissedReason: null,
    acknowledgedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function draft(overrides: Partial<MatchableDraft> = {}): MatchableDraft {
  const base = stored();
  return {
    category: base.category,
    confidence: base.confidence,
    description: base.description,
    evidence: base.evidence,
    ...overrides,
  };
}

describe("matching: what counts as 'the same finding' (PRD FR-5, Section 17)", () => {
  it("carries a finding forward and RETAINS the user's dismissal, reason and timestamps", () => {
    const prior = stored({
      status: "dismissed",
      dismissedReason: "Lender pro forma confirms these figures.",
      dismissedAt: "2026-10-12T10:05:00Z",
    });
    const [match] = matchFindings([draft()], [prior]);
    assert.deepEqual(match, { priorId: prior.id, evidenceChanged: false });
    assert.deepEqual(carryFieldsFor(match, prior), {
      carried_forward_from: prior.id,
      status: "dismissed",
      dismissed_reason: "Lender pro forma confirms these figures.",
      acknowledged_at: null,
      dismissed_at: "2026-10-12T10:05:00Z",
    });
  });

  it("retains an acknowledgement too", () => {
    const prior = stored({
      status: "acknowledged",
      acknowledgedAt: "2026-10-12T10:00:00Z",
    });
    const [planned] = planFindingInserts([draft()], [prior]);
    assert.equal(planned.carry.status, "acknowledged");
    assert.equal(planned.carry.acknowledged_at, "2026-10-12T10:00:00Z");
  });

  it("ignores page-number shifts: pagination changing between drafts is not a change", () => {
    const prior = stored({ status: "dismissed", dismissedReason: "ok" });
    const shifted = draft({
      evidence: prior
        .evidence!.replace("Page 21", "Page 24")
        .replace(/Page 20/g, "Page 23"),
    });
    const [match] = matchFindings([shifted], [prior]);
    assert.equal(match.evidenceChanged, false);
    assert.equal(
      planFindingInserts([shifted], [prior])[0].carry.status,
      "dismissed"
    );
  });

  it("when the evidence changed, links the finding but REOPENS it (PRD: retained 'unless the underlying evidence changed')", () => {
    const prior = stored({ status: "dismissed", dismissedReason: "Verified." });
    const changed = draft({
      evidence:
        "Stated Net Operating Income: $710,000 (Page 21). Effective Gross Income ($950,000, Page 20) minus Total Operating Expenses ($350,000, Page 20) equals $600,000 — a difference of $110,000.",
    });
    const [planned] = planFindingInserts([changed], [prior]);
    assert.equal(planned.match.priorId, prior.id);
    assert.equal(planned.match.evidenceChanged, true);
    assert.deepEqual(planned.carry, {
      carried_forward_from: prior.id,
      status: "open",
      dismissed_reason: null,
      acknowledged_at: null,
      dismissed_at: null,
    });
  });

  it("treats an unmatched finding as new and Open", () => {
    const prior = stored({ description: "Something else entirely." });
    const [planned] = planFindingInserts([draft()], [prior]);
    assert.equal(planned.match.priorId, null);
    assert.equal(planned.carry.carried_forward_from, null);
    assert.equal(planned.carry.status, "open");
  });

  it("with no previous review every finding is simply new (first-review behavior is unchanged)", () => {
    const planned = planFindingInserts(
      [draft(), draft({ description: "Another." })],
      []
    );
    assert.ok(
      planned.every(
        (p) =>
          p.carry.carried_forward_from === null && p.carry.status === "open"
      )
    );
  });

  it("matching is one-to-one: a previous finding is never claimed twice", () => {
    const prior = stored();
    const matches = matchFindings([draft(), draft()], [prior]);
    assert.equal(matches.filter((m) => m.priorId === prior.id).length, 1);
    assert.equal(matches.filter((m) => m.priorId === null).length, 1);
  });

  it("resolves DUPLICATE/CONFLICTING same-key findings by evidence first, regardless of order", () => {
    const k = {
      category: "template_leftover_detection",
      description: 'An unresolved "TBD" placeholder was found.',
    };
    const priorA = stored({
      ...k,
      evidence: '"TBD" — found 1 time(s) across the document.',
      status: "dismissed",
      dismissedReason: "A",
    });
    const priorB = stored({
      ...k,
      evidence: '"TBD" — found 4 time(s) across the document.',
      status: "acknowledged",
      acknowledgedAt: "2026-10-12T10:00:00Z",
    });
    const draftsInOtherOrder = [
      draft({ ...k, evidence: '"TBD" — found 4 time(s) across the document.' }),
      draft({ ...k, evidence: '"TBD" — found 1 time(s) across the document.' }),
    ];
    const matches = matchFindings(draftsInOtherOrder, [priorA, priorB]);
    assert.deepEqual(matches[0], {
      priorId: priorB.id,
      evidenceChanged: false,
    });
    assert.deepEqual(matches[1], {
      priorId: priorA.id,
      evidenceChanged: false,
    });
  });

  it("falls back to key-only pairing for conflicting duplicates whose evidence all changed", () => {
    const k = {
      category: "template_leftover_detection",
      description: 'An unresolved "TBD" placeholder was found.',
    };
    const priors = [
      stored({
        ...k,
        evidence: '"TBD" — found 1 time(s).',
        status: "dismissed",
        dismissedReason: "x",
      }),
      stored({ ...k, evidence: '"TBD" — found 2 time(s).' }),
    ];
    const matches = matchFindings(
      [draft({ ...k, evidence: '"TBD" — found 9 time(s).' })],
      priors
    );
    assert.equal(matches[0].priorId, priors[0].id);
    assert.equal(matches[0].evidenceChanged, true);
  });

  it("never matches across confidence groups, even with identical wording", () => {
    const deterministicPrior = stored({
      category: "narrative_data_contradiction",
      confidence: "deterministic",
      description: "Same words.",
    });
    const modelDraft = draft({
      category: "narrative_data_contradiction",
      confidence: "model_based",
      description: "Same words.",
      evidence: 'Page 3: "alpha beta" vs. Page 9: "gamma delta"',
    });
    assert.equal(
      matchFindings([modelDraft], [deterministicPrior])[0].priorId,
      null
    );
    assert.notEqual(
      findingMatchKey(modelDraft),
      findingMatchKey({ ...modelDraft, confidence: "deterministic" })
    );
  });

  it("matches MODEL-BASED findings by the verbatim text they cite, not by the model's wording", () => {
    const prior = stored({
      category: "narrative_data_contradiction",
      confidence: "model_based",
      description:
        "Possible conflict in the stated property condition — worth a second look: One passage says X, another says Y.",
      evidence:
        'Page 3: "in good condition with no deferred maintenance" vs. Page 12: "significant deferred maintenance and poor repair"',
      status: "dismissed",
      dismissedReason: "Different buildings.",
    });
    const rerun = draft({
      category: "narrative_data_contradiction",
      confidence: "model_based",
      // Different description wording AND different page numbers AND reversed quote order:
      description:
        "Possible conflict in the stated property condition — worth a second look: The text disagrees about maintenance.",
      evidence:
        'Page 15: "significant deferred maintenance and poor repair" vs. Page 4: "in good condition with no deferred maintenance"',
    });
    const [planned] = planFindingInserts([rerun], [prior]);
    assert.equal(planned.match.priorId, prior.id);
    assert.equal(planned.match.evidenceChanged, false);
    assert.equal(planned.carry.status, "dismissed");
  });

  it("a model finding whose cited text changed is NOT the same finding", () => {
    const prior = stored({
      category: "narrative_data_contradiction",
      confidence: "model_based",
      evidence:
        'Page 3: "in good condition" vs. Page 12: "poor repair throughout"',
    });
    const rerun = draft({
      category: "narrative_data_contradiction",
      confidence: "model_based",
      evidence:
        'Page 3: "in average condition" vs. Page 12: "poor repair throughout"',
    });
    assert.equal(matchFindings([rerun], [prior])[0].priorId, null);
  });

  it("is deterministic: identical inputs always give identical results", () => {
    const priors = [stored(), stored({ description: "Other." })];
    const drafts = [draft(), draft({ description: "Other." })];
    assert.deepEqual(
      matchFindings(drafts, priors),
      matchFindings(drafts, priors)
    );
  });

  it("survives malformed or incomplete data without throwing", () => {
    const sparse = {
      id: "x",
      category: "typo_and_formatting_inconsistency",
      confidence: "deterministic" as const,
      status: "open" as const,
      description: null,
      evidence: null,
      dismissedReason: null,
      acknowledgedAt: null,
      dismissedAt: null,
    };
    assert.doesNotThrow(() =>
      matchFindings(
        [
          {
            category: "c",
            confidence: "deterministic",
            description: null,
            evidence: null,
          },
        ],
        [sparse]
      )
    );
    assert.doesNotThrow(() => matchFindings([], []));
    assert.doesNotThrow(() => planFindingInserts([], [sparse]));
    assert.equal(evidenceFingerprint(null), "");
    assert.equal(evidenceFingerprint(undefined), "");
    assert.equal(evidenceFingerprint("Page 3, Page 47"), "");
  });
});

describe("comparison: resolved / still present / new (PRD Section 8.7)", () => {
  const cf = (
    o: Partial<ComparableFinding> & { id: string }
  ): ComparableFinding => ({
    category: "template_leftover_detection",
    severity: "moderate",
    confidence: "deterministic",
    status: "open",
    description: "d",
    evidence: "e",
    location: null,
    dismissedReason: null,
    carriedForwardFrom: null,
    ...o,
  });
  const review = (
    findings: ComparableFinding[],
    o: Partial<ComparableReview> = {}
  ): ComparableReview => ({
    findings,
    reviewVersion: "review-pipeline-v5",
    modelReviewStatus: "not_run",
    ...o,
  });

  it("derives resolved, still present, evidence-changed and new correctly", () => {
    const prev = review([
      cf({ id: "p1", evidence: "same" }),
      cf({ id: "p2", evidence: "old figures" }),
      cf({ id: "p3" }),
    ]);
    const cur = review([
      cf({ id: "c1", evidence: "same", carriedForwardFrom: "p1" }),
      cf({ id: "c2", evidence: "new figures", carriedForwardFrom: "p2" }),
      cf({ id: "c4" }),
    ]);
    const result = buildComparison(cur, prev);
    assert.deepEqual(result.labels, {
      c1: "still_open",
      c2: "still_open_evidence_changed",
      c4: "new",
    });
    assert.deepEqual(
      result.resolved.map((f) => f.id),
      ["p3"]
    );
    assert.deepEqual(result.counts, {
      resolved: 1,
      stillOpen: 2,
      evidenceChanged: 1,
      new: 1,
      notCompared: 0,
    });
  });

  it("a fully fixed draft shows every previous finding as resolved (good news, not silence)", () => {
    const result = buildComparison(
      review([]),
      review([cf({ id: "p1" }), cf({ id: "p2" })])
    );
    assert.equal(result.counts.resolved, 2);
    assert.equal(result.counts.new + result.counts.stillOpen, 0);
  });

  it("never claims model-based findings were fixed when the model pass did not complete in both reviews", () => {
    const modelFinding = (id: string, extra: Partial<ComparableFinding> = {}) =>
      cf({
        id,
        category: "narrative_data_contradiction",
        confidence: "model_based",
        ...extra,
      });
    for (const [curStatus, prevStatus] of [
      ["failed", "complete"],
      ["complete", "not_run"],
      ["unavailable", "complete"],
      ["processing", "complete"],
    ] as const) {
      const result = buildComparison(
        review([modelFinding("c1")], { modelReviewStatus: curStatus }),
        review([modelFinding("p1")], { modelReviewStatus: prevStatus })
      );
      assert.equal(
        result.resolved.length,
        0,
        `${curStatus}/${prevStatus}: must not report model findings as resolved`
      );
      assert.equal(
        result.labels.c1,
        "not_compared",
        `${curStatus}/${prevStatus}: must not label as new`
      );
      assert.ok(result.notes.some((note) => /not compared/i.test(note)));
    }
  });

  it("compares model-based findings when both passes completed", () => {
    const m = (id: string, extra: Partial<ComparableFinding> = {}) =>
      cf({
        id,
        category: "narrative_data_contradiction",
        confidence: "model_based",
        ...extra,
      });
    const result = buildComparison(
      review([m("c1", { carriedForwardFrom: "p1" })], {
        modelReviewStatus: "complete",
      }),
      review([m("p1"), m("p2")], { modelReviewStatus: "complete" })
    );
    assert.equal(result.labels.c1, "still_open");
    assert.deepEqual(
      result.resolved.map((f) => f.id),
      ["p2"]
    );
    assert.equal(result.notes.length, 0);
  });

  it("keeps deterministic comparison intact even when the model pass failed (degradation)", () => {
    const result = buildComparison(
      review([cf({ id: "c1", carriedForwardFrom: "p1" })], {
        modelReviewStatus: "failed",
      }),
      review([cf({ id: "p1" }), cf({ id: "p2" })], {
        modelReviewStatus: "complete",
      })
    );
    assert.equal(result.labels.c1, "still_open");
    assert.deepEqual(
      result.resolved.map((f) => f.id),
      ["p2"]
    );
  });

  it("flags a review-engine version change so 'new' findings aren't misattributed to the user's edits", () => {
    const result = buildComparison(
      review([], { reviewVersion: "review-pipeline-v5" }),
      review([], { reviewVersion: "review-pipeline-v3" })
    );
    assert.ok(
      result.notes.some(
        (note) =>
          note.includes("review-pipeline-v3") &&
          note.includes("review-pipeline-v5")
      )
    );
  });

  it("treats a carry link to a finding that no longer exists as new, without crashing", () => {
    const result = buildComparison(
      review([cf({ id: "c1", carriedForwardFrom: "deleted-or-foreign-id" })]),
      review([])
    );
    assert.equal(result.labels.c1, "new");
  });

  it("'Changes only' hides only plain unchanged carry-overs", () => {
    assert.equal(isChange("still_open"), false);
    for (const label of [
      "new",
      "still_open_evidence_changed",
      "not_compared",
    ] as const)
      assert.equal(isChange(label), true);
  });
});

describe("revision eligibility and user isolation (PRD FR-5)", () => {
  const complete = {
    review_status: "complete",
    extraction_status: "completed",
  };
  const UUID = "11111111-2222-4333-8444-555555555555";
  const NOT_FOUND = "The report you are revising could not be found.";

  it("a normal upload (no revision requested) is unaffected", () => {
    for (const v of [null, undefined, "", "   "]) {
      assert.deepEqual(
        checkRevisionTarget({
          revisesReportId: v,
          target: null,
          alreadyRevised: false,
        }),
        { ok: true, previousReportId: null }
      );
    }
  });

  it("accepts a valid, reviewed, not-yet-revised report", () => {
    assert.deepEqual(
      checkRevisionTarget({
        revisesReportId: ` ${UUID} `,
        target: complete,
        alreadyRevised: false,
      }),
      { ok: true, previousReportId: UUID }
    );
  });

  it("USER ISOLATION: someone else's report, a missing report and a malformed id are indistinguishable", () => {
    // Callers look the report up under the user's own RLS session, so another
    // user's report arrives as null — exactly like one that does not exist.
    const results = [
      checkRevisionTarget({
        revisesReportId: UUID,
        target: null,
        alreadyRevised: false,
      }),
      checkRevisionTarget({
        revisesReportId: "not-a-uuid",
        target: complete,
        alreadyRevised: false,
      }),
      checkRevisionTarget({
        revisesReportId: "'; drop table reports;--",
        target: complete,
        alreadyRevised: false,
      }),
    ];
    for (const result of results)
      assert.deepEqual(result, { ok: false, error: NOT_FOUND });
  });

  it("rejects a report whose review has not finished", () => {
    for (const target of [
      { review_status: "processing", extraction_status: "completed" },
      { review_status: "failed", extraction_status: "completed" },
      { review_status: "pending", extraction_status: "ocr_required" },
      { review_status: "complete", extraction_status: "failed" },
    ]) {
      const result = checkRevisionTarget({
        revisesReportId: UUID,
        target,
        alreadyRevised: false,
      });
      assert.equal(result.ok, false);
    }
  });

  it("rejects revising a report that already has a revision (chain, not tree)", () => {
    const result = checkRevisionTarget({
      revisesReportId: UUID,
      target: complete,
      alreadyRevised: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /already been uploaded/);
  });
});

describe("end to end with the REAL deterministic checks (regression for M5–M9 + FR-5)", () => {
  const runChecks = (pages: PageText[]): FindingDraft[] => [
    ...checkCrossDocumentIdentityConsistency(pages),
    ...checkTemplateLeftovers(pages),
    ...checkTypoAndFormattingIssues(pages),
    ...checkArithmeticVerification(pages),
  ];

  // Draft 1 of an appraisal: a client-name typo, an NOI error, and a TBD placeholder.
  const DRAFT_1: PageText[] = [
    {
      pageNumber: 1,
      text: "Client: Acme Capital Partners\nProperty Address: 123 Main Street",
    },
    { pageNumber: 12, text: "Adjustment: TBD" },
    {
      pageNumber: 20,
      text: "Potential Gross Income: $1,000,000\nVacancy and Collection Loss: $50,000\nEffective Gross Income: $950,000",
    },
    {
      pageNumber: 21,
      text: "Total Operating Expenses: $350,000\nNet Operating Income: $700,000",
    },
    { pageNumber: 92, text: "Client: Acme Capital Prtners" },
  ];
  // Draft 2: typo FIXED; NOI error still there (pagination shifted by 3); TBD still there; a NEW doubled-word typo.
  const DRAFT_2: PageText[] = [
    {
      pageNumber: 1,
      text: "Client: Acme Capital Partners\nProperty Address: 123 Main Street",
    },
    {
      pageNumber: 15,
      text: "Adjustment: TBD\nThe the subject is well located.",
    },
    {
      pageNumber: 23,
      text: "Potential Gross Income: $1,000,000\nVacancy and Collection Loss: $50,000\nEffective Gross Income: $950,000",
    },
    {
      pageNumber: 24,
      text: "Total Operating Expenses: $350,000\nNet Operating Income: $700,000",
    },
    { pageNumber: 95, text: "Client: Acme Capital Partners" },
  ];

  it("fixed issues resolve, unchanged ones carry forward (with the user's dismissal), new ones are new", () => {
    // --- Review of draft 1, as the pipeline stores it (user later dismisses the TBD) ---
    const draft1 = runChecks(DRAFT_1);
    assert.ok(draft1.length >= 3, "draft 1 produces the expected findings");
    const stored1: StoredFindingLike[] = draft1.map((d, i) => ({
      id: `d1-${i}`,
      category: d.category,
      confidence: "deterministic",
      status: "open",
      description: d.description,
      evidence: d.evidence,
      dismissedReason: null,
      acknowledgedAt: null,
      dismissedAt: null,
    }));
    const tbdPrior = stored1.find((f) => /TBD/.test(f.description ?? ""))!;
    tbdPrior.status = "dismissed";
    tbdPrior.dismissedReason =
      "Pending client confirmation; noted in engagement letter.";
    tbdPrior.dismissedAt = "2026-10-12T10:05:00Z";

    // --- Re-review of draft 2: match, carry, then derive the comparison ---
    const draft2 = runChecks(DRAFT_2).map((d) => ({
      ...d,
      confidence: "deterministic" as const,
    }));
    const planned = planFindingInserts(draft2, stored1);

    const stored2: ComparableFinding[] = planned.map((p, i) => ({
      id: `d2-${i}`,
      category: p.draft.category,
      severity: p.draft.severity,
      confidence: "deterministic",
      status: p.carry.status,
      description: p.draft.description,
      evidence: p.draft.evidence,
      location: p.draft.location,
      dismissedReason: p.carry.dismissed_reason,
      carriedForwardFrom: p.carry.carried_forward_from,
    }));
    const comparison = buildComparison(
      {
        findings: stored2,
        reviewVersion: "review-pipeline-v5",
        modelReviewStatus: "not_run",
      },
      {
        findings: stored1.map((f, i) => ({
          id: f.id,
          category: f.category,
          severity: draft1[i].severity,
          confidence: "deterministic",
          status: f.status,
          description: f.description ?? "",
          evidence: f.evidence ?? "",
          location: draft1[i].location,
          dismissedReason: f.dismissedReason,
          carriedForwardFrom: null,
        })),
        reviewVersion: "review-pipeline-v5",
        modelReviewStatus: "not_run",
      }
    );

    const byDesc = (re: RegExp) => stored2.find((f) => re.test(f.description))!;

    // The fixed client-name typo is RESOLVED, and shown rather than dropped.
    assert.ok(
      comparison.resolved.some((f) =>
        /client name appears inconsistently/.test(f.description)
      )
    );
    assert.equal(
      stored2.some((f) =>
        /client name appears inconsistently/.test(f.description)
      ),
      false
    );

    // The NOI error persists; moving pages did not make it look changed or new.
    const noi = byDesc(/Net Operating Income does not match/);
    assert.equal(comparison.labels[noi.id], "still_open");
    assert.ok(noi.carriedForwardFrom);

    // The TBD persists AND the user's earlier dismissal (with reason) was carried forward.
    const tbd = byDesc(/TBD/);
    assert.equal(comparison.labels[tbd.id], "still_open");
    assert.equal(tbd.status, "dismissed");
    assert.equal(
      tbd.dismissedReason,
      "Pending client confirmation; noted in engagement letter."
    );

    // The doubled word introduced in draft 2 is NEW.
    const typo = byDesc(/the the/i);
    assert.equal(comparison.labels[typo.id], "new");
    assert.equal(typo.status, "open");

    assert.equal(comparison.counts.resolved, 1);
    assert.equal(comparison.counts.new, 1);
    assert.equal(comparison.counts.stillOpen, 2);
  });

  it("is reproducible: re-running the same two drafts gives the same comparison (FR-2)", () => {
    const run = () => {
      const priors: StoredFindingLike[] = runChecks(DRAFT_1).map((d, i) => ({
        id: `p${i}`,
        category: d.category,
        confidence: "deterministic",
        status: "open",
        description: d.description,
        evidence: d.evidence,
        dismissedReason: null,
        acknowledgedAt: null,
        dismissedAt: null,
      }));
      return planFindingInserts(
        runChecks(DRAFT_2).map((d) => ({
          ...d,
          confidence: "deterministic" as const,
        })),
        priors
      ).map((p) => ({
        k: p.draft.description,
        c: p.carry.carried_forward_from,
        e: p.match.evidenceChanged,
      }));
    };
    assert.deepEqual(run(), run());
  });
});
