import type { FindingConfidence, FindingStatus } from "@/lib/review/types";

/**
 * Deterministic matching of findings across two runs of the same
 * engagement (PRD FR-5; Findings Lifecycle Section 17).
 *
 * The PRD says WHAT must happen — a finding whose underlying
 * condition still exists is "Carried Forward" and keeps its triage
 * status "unless the underlying evidence changed"; a finding whose
 * condition no longer exists is "Resolved" — but not HOW to decide
 * that two findings are "the same". This module is that rule. It is
 * plain code, never a model call, so the same two reviews always
 * produce the same comparison (PRD FR-2: reproducibility).
 *
 * Two parts:
 *  - KEY: what the finding is ABOUT (category + what it says).
 *  - FINGERPRINT: the evidence behind it, with page numbers removed.
 *
 *   same key + same fingerprint -> carried forward, triage RETAINED
 *   same key + different fingerprint -> carried forward, evidence
 *       changed, so it starts OPEN again (the user must re-look)
 *   no matching key -> new (or, from the other side, resolved)
 *
 * Page numbers are excluded from the fingerprint on purpose: revising
 * a report routinely shifts pagination, and a finding must not look
 * "changed" just because the text moved from page 21 to page 23.
 */

export interface StoredFindingLike {
  id: string;
  category: string;
  confidence: FindingConfidence;
  status: FindingStatus;
  description: string | null;
  evidence: string | null;
  dismissedReason: string | null;
  acknowledgedAt: string | null;
  dismissedAt: string | null;
}

export interface MatchableDraft {
  category: string;
  confidence: FindingConfidence;
  description: string | null;
  evidence: string | null;
}

export interface MatchResult {
  /** The previous-review finding this one continues, or null if new. */
  priorId: string | null;
  /** True when linked to a prior finding but the evidence differs. */
  evidenceChanged: boolean;
}

/** Fields written onto a new finding as a result of matching. */
export interface CarryFields {
  carried_forward_from: string | null;
  status: FindingStatus;
  dismissed_reason: string | null;
  acknowledged_at: string | null;
  dismissed_at: string | null;
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .replace(/[\s.]+$/, "")
    .trim();
}

/** Every quoted span in an evidence string, normalized and order-independent. */
function extractQuotes(evidence: string | null | undefined): string[] {
  const quotes: string[] = [];
  for (const match of (evidence ?? "").matchAll(/"([^"]+)"/g)) {
    const quote = normalizeText(match[1]);
    if (quote) quotes.push(quote);
  }
  return quotes.sort();
}

/** Evidence with page references removed, so pagination shifts don't count as change. */
export function evidenceFingerprint(
  evidence: string | null | undefined
): string {
  return normalizeText(evidence)
    .replace(/\bpages?\s+\d+(?:\s*(?:,|and|&)\s*\d+)*/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+([,;:])/g, "$1")
    .replace(/[,;:]\s*(?=[,;:]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What a finding is ABOUT.
 *
 * - Deterministic findings: category + normalized description. The
 *   deterministic checks put the identifying detail in the
 *   description (which placeholder, which word, which exhibit, which
 *   figure), and keep it constant across runs while the condition
 *   exists.
 * - Model-based findings: category + the verbatim quotes they cite.
 *   The model's own wording of the description varies from run to
 *   run, so it must never decide identity; the quoted report text
 *   does.
 */
export function findingMatchKey(finding: MatchableDraft): string {
  if (finding.confidence === "model_based") {
    const quotes = extractQuotes(finding.evidence);
    if (quotes.length > 0) {
      return `${finding.category}|model|${quotes.join("||")}`;
    }
  }
  return `${finding.category}|${finding.confidence}|${normalizeText(finding.description)}`;
}

function fingerprintFor(finding: MatchableDraft): string {
  if (finding.confidence === "model_based") {
    const quotes = extractQuotes(finding.evidence);
    if (quotes.length > 0) return quotes.join("||");
  }
  return evidenceFingerprint(finding.evidence);
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pairs each new draft with at most one previous finding, and each
 * previous finding with at most one draft (one-to-one).
 *
 * Two passes make the result correct when several findings share a
 * key (e.g. the same kind of issue found twice): first pair findings
 * whose key AND evidence both match, then pair what is left by key
 * alone (those are "evidence changed"). A draft is never matched to a
 * finding of a different confidence group — deterministic and
 * model-based findings are compared only within their own kind.
 */
export function matchFindings(
  drafts: MatchableDraft[],
  priors: StoredFindingLike[]
): MatchResult[] {
  const results: MatchResult[] = drafts.map(() => ({
    priorId: null,
    evidenceChanged: false,
  }));
  const used = new Set<number>();

  const draftKeys = drafts.map(findingMatchKey);
  const draftPrints = drafts.map(fingerprintFor);
  const priorKeys = priors.map(findingMatchKey);
  const priorPrints = priors.map(fingerprintFor);

  // Pass 1: same key AND same evidence.
  drafts.forEach((_, i) => {
    for (let j = 0; j < priors.length; j++) {
      if (used.has(j)) continue;
      if (priorKeys[j] === draftKeys[i] && priorPrints[j] === draftPrints[i]) {
        results[i] = { priorId: priors[j].id, evidenceChanged: false };
        used.add(j);
        return;
      }
    }
  });

  // Pass 2: same key, evidence differs.
  drafts.forEach((_, i) => {
    if (results[i].priorId !== null) return;
    for (let j = 0; j < priors.length; j++) {
      if (used.has(j)) continue;
      if (priorKeys[j] === draftKeys[i]) {
        results[i] = { priorId: priors[j].id, evidenceChanged: true };
        used.add(j);
        return;
      }
    }
  });

  return results;
}

/**
 * What to store on a new finding, given how it matched.
 *
 * - No match: a normal new, Open finding.
 * - Match, evidence unchanged: linked AND the user's earlier
 *   acknowledge/dismiss decision (with its reason and timestamps) is
 *   carried over, so nothing already handled has to be re-triaged
 *   (PRD 17).
 * - Match, evidence changed: linked, but starts Open — the PRD only
 *   retains prior status "unless the underlying evidence changed".
 */
export function carryFieldsFor(
  match: MatchResult,
  prior: StoredFindingLike | undefined
): CarryFields {
  if (!match.priorId || !prior) {
    return {
      carried_forward_from: null,
      status: "open",
      dismissed_reason: null,
      acknowledged_at: null,
      dismissed_at: null,
    };
  }
  if (match.evidenceChanged) {
    return {
      carried_forward_from: prior.id,
      status: "open",
      dismissed_reason: null,
      acknowledged_at: null,
      dismissed_at: null,
    };
  }
  return {
    carried_forward_from: prior.id,
    status: prior.status,
    dismissed_reason: prior.dismissedReason,
    acknowledged_at: prior.acknowledgedAt,
    dismissed_at: prior.dismissedAt,
  };
}

export interface PlannedInsert<TDraft extends MatchableDraft> {
  draft: TDraft;
  carry: CarryFields;
  match: MatchResult;
}

/**
 * Convenience used by both review stages: match drafts against the
 * previous review's findings (already filtered to the same confidence
 * group by the caller) and return the fields to store with each.
 * With no previous findings, every draft is simply new.
 */
export function planFindingInserts<TDraft extends MatchableDraft>(
  drafts: TDraft[],
  priors: StoredFindingLike[]
): PlannedInsert<TDraft>[] {
  const sameGroupPriors = priors.filter((prior) =>
    drafts.some((draft) => draft.confidence === prior.confidence)
  );
  const matches = matchFindings(drafts, sameGroupPriors);
  const byId = new Map(sameGroupPriors.map((prior) => [prior.id, prior]));

  return drafts.map((draft, index) => ({
    draft,
    match: matches[index],
    carry: carryFieldsFor(
      matches[index],
      matches[index].priorId ? byId.get(matches[index].priorId!) : undefined
    ),
  }));
}
