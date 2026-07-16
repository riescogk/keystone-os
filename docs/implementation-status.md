# Implementation Status

This file is the permanent, repository-resident memory of Keystone OS's progress. It exists so any future session — with no access to prior chat history — can reconstruct exactly where the project stands by reading the repository alone. Update this file at the end of every milestone/phase.

Note on numbering: the codebase and docs use "Phase N"; the founder-facing roadmap has also referred to the same units as "Milestone N". Phase N = Milestone N. They are the same unit of work.

## Completed phases

- **Phase 1/2 — Foundation & Authentication.** Next.js 16 App Router + TypeScript + Tailwind CSS v4 scaffold, ESLint/Prettier, Supabase Auth (signup/login/logout/email confirmation), route protection (`src/proxy.ts` + server-side re-check), protected dashboard shell, `public.users` table with auto-provisioning trigger and full RLS.
- **Phase 3 — Secure Commercial Appraisal Upload.** Private `reports` Storage bucket (25 MB, PDF-only), `public.reports` table with owner-scoped RLS (select/insert/delete), authoritative server-side upload validation (MIME + magic bytes + size), signed-URL viewing, delete with confirmation, real dashboard listing.
- **Phase 4 — PDF Text Extraction.** `unpdf`-based extraction pipeline triggered after upload via `after()`; `extraction_status` lifecycle (`pending → processing → completed | ocr_required | failed`); dashboard status badge with auto-refresh while in progress.
- **Phase 5 — First Automated Review Check: Cross-Document Identity Consistency.** Deterministic check (client name / property address / effective date matched across the document) chained after extraction; `public.findings` table; `review_status` lifecycle on `reports`; finding triage (acknowledge/dismiss with required reason); report detail page (`/dashboard/reports/[id]`).
- **Phase 6 — Second Automated Review Check: Template Leftover Detection.** Deterministic, pattern-based check for unresolved placeholders, template merge syntax, filler text, literal format placeholders, and blank-line runs.
- **Phase 7 — Third Automated Review Check: Typo & Formatting Inconsistency Detection.** Deterministic check for doubled words, doubled punctuation, and non-ellipsis double periods; Low severity by default. Deliberately not a dictionary-based spellchecker.
- **Phase 8 — Fourth Automated Review Check: Missing Supporting Documentation References (deterministic sub-case).** Finds in-text references to a named Addendum/Exhibit/Appendix/Attachment (e.g. "see Addendum C") and flags any whose section never actually appears in the document. Moderate severity.
- **Phase 9 — Fifth Automated Review Check: Internal Arithmetic Verification (PDF-text-only sub-case).** Recalculates the Income Approach chain (PGI − vacancy/collection loss = EGI; EGI − operating expenses = NOI; NOI ÷ cap rate = indicated value) against what the report states, using only figures already present in the PDF's extracted text — **no Excel file required or used**. Critical severity. Tolerance-based comparison absorbs normal rounding.

Phases 6 through 9 all reused the exact same pattern: one new pure-function check file, one more entry in `runReview.ts`'s check list, one migration extending `findings.category`'s check constraint — zero orchestrator, RLS, or UI changes needed in any of them. Full detail on every phase in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 9 is complete.** All four verification gates passed: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production). The check was sanity-tested with: (1) a report where every Income Approach figure ties out correctly (zero findings), (2) a report with deliberately wrong figures at every step of the chain (all three caught, with accurate diagnostic evidence for each), (3) a report with no income approach section at all (zero findings — the check never guesses), and (4) a report with a normal rounding-scale difference (~0.015% on a $10M value, correctly not flagged).

## Important correction from the prior session's assessment

Phase 8's writeup declared category 3 (arithmetic verification) blocked on an Excel-ingestion decision. **This was reassessed and found to be an overly cautious reading.** The PRD's own category-3 text says figures should be checked "wherever the underlying figures are extractable from the document **or** supporting Excel file" — Excel was always optional, never required, for this category. Phase 9 implements the PDF-text-only half, which needed no founder decision at all. This correction matters for future sessions: **read each blocked-seeming category's exact PRD wording closely before assuming a founder decision is required** — the blocker may only apply to part of the category, as it did here.

## Remaining phases (not yet started) — founder decision still needed for what's left

With Phase 9, the PDF-text-only portion of every deterministic category with no genuine LLM/vendor dependency is now implemented. What remains is genuinely blocked:

- **Sales-comparison grid adjustment totals and reconciliation weighting** (part of category 3, and the inferential half of category 6 — "a referenced comp not appearing in the grid") — these need reliable table/grid data. The Company Bible names financial-grid parsing fidelity from PDF text as the single hardest technical problem in the product; a founder decision on Excel ingestion (Long-Term Roadmap item 3) is the honest path to making these reliable, rather than attempting them from flat PDF text and risking unreliable output.
- **PRD Section 18 categories 4–5 (narrative-to-data contradiction, missing standard assumptions)** — both explicitly model-based (PRD Section 13). Needs a founder decision on an LLM provider — a vendor/cost decision this codebase has deliberately never made unilaterally, per explicit standing instruction.

Other roadmap areas, unchanged from prior phases, any of which could also be the next milestone once specified:

- Re-review/diff comparison against a prior run (FR-5, PRD Section 8.7).
- Export findings report (FR-6).
- Account/data deletion (FR-7, PRD 8.9) and password reset — flagged as open risks since Phase 2, still not built.
- OCR support (still explicitly out of scope; `ocr_required` reports remain unreviewable until this exists).

**Recommendation for whoever picks Phase 10**: before assuming any of the above needs a founder decision, re-read its exact PRD wording the way Phase 9 did for category 3 — there may be a PDF-only, no-vendor sub-case still available that a quick pass would miss.

## Important implementation decisions (Phase 9)

- **The Income Approach chain was chosen, not grid adjustments**, specifically because appraisers commonly state it as a simple one-figure-per-line narrative sequence that flat PDF text extraction recovers reliably — unlike true row/column grids, which the Company Bible names as unreliable to parse from flat text.
- **Only the first occurrence of each labeled figure is used**; a step is checked only when all of its inputs are present. A report using only the sales-comparison approach (no income approach) produces zero findings.
- **Tolerance-based, not exact-equality, comparison** (`max($500, 1%)`) — necessary because real reports round intermediate figures.
- **Severity `critical`**, directly from PRD Section 19's own example.
- **Reconciliation is not checked** — it's a professional judgment weighting, not arithmetic.
- **Same minimal migration pattern as Phases 6–8**: one migration extending `findings.category`'s check constraint (`0009_arithmetic_verification_findings.sql`).
- **`REVIEW_VERSION` bumped** to `review-pipeline-v5`.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0009_arithmetic_verification_findings.sql` to every environment that already has migrations `0001`–`0008` applied.
- No new environment variables were introduced in Phase 9.
- No new dependencies were added in Phase 9.

## Known technical debt

- Pre-existing (not introduced by Phases 4–9): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself. No fix is available without a breaking Next.js downgrade.
- No retry action for `failed` extractions or `failed` reviews — today the only recovery path for either is delete + re-upload.
- No manual "re-run review" action — review runs automatically exactly once per report.
- All five deterministic checks (Phases 5–9) are reasonable-but-not-exhaustive starting sets, not validated against a large corpus of real appraisal reports — expect iteration as real reports surface edge cases (e.g. label wording variants the arithmetic check's patterns don't yet recognize).
- The arithmetic check only recognizes one specific set of Income Approach labels; a report using unusual terminology for PGI/EGI/NOI/cap rate/indicated value simply won't be checked, rather than misreading it.
- `findings.category`'s check constraint only allows the five categories implemented so far; each future category needs its own migration to extend it (by design).

## Next phase to begin

Not yet specified by the founder. Genuinely blocked areas (grid/table parsing, LLM-based categories) still need an explicit founder decision. Before assuming that's the only path forward, re-check each remaining category's exact PRD wording the way Phase 9 did — there may be more unblocked, PDF-only ground still available. Await explicit instruction before starting Phase 10.
