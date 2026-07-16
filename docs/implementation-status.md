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
- **Phase 8 — Fourth Automated Review Check: Missing Supporting Documentation References (deterministic sub-case).** Finds in-text references to a named Addendum/Exhibit/Appendix/Attachment (e.g. "see Addendum C") and flags any whose section never actually appears in the document. Moderate severity, per PRD Section 19's own example. Only the deterministic half of PRD Section 18 category 6 — the inferential half (comp not appearing in a grid) needs Excel ingestion and/or model-based judgment, neither available.

Phases 6, 7, and 8 all reused the exact same pattern: one new pure-function check file, one more entry in `runReview.ts`'s check list, one migration extending `findings.category`'s check constraint — zero orchestrator, RLS, or UI changes needed in any of them. Full detail on every phase in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 8 is complete.** All four verification gates passed: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production). The check was sanity-tested against a synthetic sample with two references to sections that never appear (correctly flagged) and one reference to a section that does appear elsewhere in the document (correctly not flagged).

## Remaining phases (not yet started) — founder decision needed

**With Phase 8, every currently-unblocked deterministic PDF-only review category has been implemented** (PRD Section 18 categories 1, 2, 6-deterministic-half, and 7). What's left all requires a founder-level decision before any further review-category work can proceed safely:

- **PRD Section 18 category 3 (internal arithmetic verification)** and the **inferential half of category 6** — both want reliable access to the underlying numeric grids. The Company Bible names financial-grid parsing fidelity as the single hardest technical problem in the product. This needs a founder decision on Excel ingestion (Long-Term Roadmap item 3) — a new file-format/parsing capability, not a small addition.
- **PRD Section 18 categories 4–5 (narrative-to-data contradiction, missing standard assumptions)** — both explicitly model-based (PRD Section 13). This needs a founder decision on an LLM provider — a vendor/cost decision this codebase has deliberately never made unilaterally.

Neither dependency was resolved in Phase 8, per the explicit instruction not to select an LLM provider or add paid vendor dependencies without approval.

Other roadmap areas, unchanged from prior phases, any of which could also be the next milestone once specified:

- Re-review/diff comparison against a prior run (FR-5, PRD Section 8.7).
- Export findings report (FR-6).
- Account/data deletion (FR-7, PRD 8.9) and password reset — flagged as open risks since Phase 2, still not built.
- OCR support (still explicitly out of scope; `ocr_required` reports remain unreviewable until this exists).

**Recommendation for whoever picks Phase 9**: this is a genuine fork in the roadmap. The founder should decide between (a) committing to Excel ingestion to unblock arithmetic verification, (b) choosing and approving an LLM provider to unblock the model-based categories, or (c) moving to a non-review-category area (re-review/diff, export, account deletion). None of these should be started without that decision being made explicitly first.

## Important implementation decisions (Phase 8)

- **Category 6 was read as two sub-cases, not one** — the PRD's own text splits it ("Deterministic where possible ... Model-Based where inferential"). Phase 8 implements only the deterministic half, which needed no founder decision, and explicitly defers the inferential half alongside categories 3/4/5.
- **Two distinct regex roles** (reference vs. heading) are what let "see Addendum C" (a claim) be told apart from an actual "Addendum C" section start, without any layout/formatting metadata.
- **Conservative by design, same as every prior check**: a table-of-contents mention counts as "found" — there's no reliable way to distinguish a ToC entry from a real section start in flat text, so this errs toward under-flagging.
- **Severity `moderate`**, directly from PRD Section 19's own "an unreferenced addendum" example.
- **Same minimal migration pattern as Phases 6/7**: one migration extending `findings.category`'s check constraint (`0008_missing_documentation_findings.sql`). No other schema/RLS/UI change needed.
- **`REVIEW_VERSION` bumped** to `review-pipeline-v4`.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0008_missing_documentation_findings.sql` to every environment that already has migrations `0001`–`0007` applied.
- No new environment variables were introduced in Phase 8.
- No new dependencies were added in Phase 8.

## Known technical debt

- Pre-existing (not introduced by Phases 4–8): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself. No fix is available without a breaking Next.js downgrade.
- No retry action for `failed` extractions or `failed` reviews — today the only recovery path for either is delete + re-upload.
- No manual "re-run review" action — review runs automatically exactly once per report.
- All four deterministic checks (Phases 5–8) are reasonable-but-not-exhaustive starting sets, not validated against a large corpus of real appraisal reports — expect iteration as real reports surface edge cases.
- The missing-documentation check cannot distinguish a table-of-contents mention from a real section start — by design, but worth knowing if a report technically lists an addendum in its ToC without ever actually including it.
- `findings.category`'s check constraint only allows the four categories implemented so far; each future category needs its own migration to extend it (by design).

## Next phase to begin

Not yet specified by the founder, and — unlike Phases 6–8 — cannot be chosen autonomously next time either: Phase 9 requires an explicit founder decision on Excel ingestion vs. an LLM provider vs. a non-review-category roadmap area (see "Remaining phases" above). Await that decision before starting Phase 9.
