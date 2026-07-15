# Implementation Status

This file is the permanent, repository-resident memory of Keystone OS's progress. It exists so any future session — with no access to prior chat history — can reconstruct exactly where the project stands by reading the repository alone. Update this file at the end of every milestone/phase.

Note on numbering: the codebase and docs use "Phase N"; the founder-facing roadmap has also referred to the same units as "Milestone N". Phase N = Milestone N. They are the same unit of work.

## Completed phases

- **Phase 1/2 — Foundation & Authentication.** Next.js 16 App Router + TypeScript + Tailwind CSS v4 scaffold, ESLint/Prettier, Supabase Auth (signup/login/logout/email confirmation), route protection (`src/proxy.ts` + server-side re-check), protected dashboard shell, `public.users` table with auto-provisioning trigger and full RLS.
- **Phase 3 — Secure Commercial Appraisal Upload.** Private `reports` Storage bucket (25 MB, PDF-only), `public.reports` table with owner-scoped RLS (select/insert/delete), authoritative server-side upload validation (MIME + magic bytes + size), signed-URL viewing, delete with confirmation, real dashboard listing.
- **Phase 4 — PDF Text Extraction.** `unpdf`-based extraction pipeline triggered after upload via `after()`; `extraction_status` lifecycle (`pending → processing → completed | ocr_required | failed`); dashboard status badge with auto-refresh while in progress.
- **Phase 5 — First Automated Review Check: Cross-Document Identity Consistency.** Deterministic check (client name / property address / effective date matched across the document) chained after extraction; `public.findings` table; `review_status` lifecycle on `reports`; finding triage (acknowledge/dismiss with required reason); report detail page (`/dashboard/reports/[id]`).
- **Phase 6 — Second Automated Review Check: Template Leftover Detection.** Deterministic, pattern-based check for unresolved placeholders, template merge syntax, filler text, literal format placeholders, and blank-line runs, added as a second entry in the same `runReview` pipeline. `findings.category` constraint extended via migration; no other schema or UI change needed.
- **Phase 7 — Third Automated Review Check: Typo & Formatting Inconsistency Detection.** Deterministic, pattern-based check for doubled words, doubled punctuation, and non-ellipsis double periods; Low severity by default per PRD Section 19. Deliberately not a dictionary-based spellchecker (false-positive risk against real appraisal vocabulary judged too high). Added as a third entry in the same `runReview` pipeline; same minimal migration pattern as Phase 6.

Full detail on every phase in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 7 is complete.** All four verification gates passed on the final code: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production). The check was sanity-tested against a synthetic multi-page sample: a doubled word, doubled punctuation (`"??"`), and a double period were all correctly caught; a genuine `"..."` ellipsis and a comma-separated repeated word (`"consistent, consistent"`, intentional business phrasing) were both correctly _not_ flagged.

## Remaining phases (not yet started)

No phase has been specified by the founder yet. All seven PRD Section 18 review categories now stand as follows:

- **1–2, 7 — shipped** (Phases 5, 6, 7).
- **3 (arithmetic verification)** — deterministic, but the Company Bible names document-parsing fidelity for financial grids as the single hardest technical problem in the whole product; wants Excel grid ingestion (Long-Term Roadmap item 3) first for reliable results.
- **4–5 (narrative-to-data contradiction, missing assumptions)** — both model-based (PRD Section 13); blocked until an LLM provider is chosen. This is a real, standing blocker — flag it to the founder when ready to unblock the AI Review Workflow.
- **6 (missing supporting documentation references)** — partly deterministic, likely paired with category 3's future grid-parsing work.

With all currently-unblocked deterministic categories now shipped, the next milestone likely requires a founder decision on one of: (a) beginning Excel grid ingestion to unblock category 3, (b) choosing an LLM provider to unblock categories 4–5, or (c) moving to a different area of the roadmap entirely (re-review/diff, export, account/data deletion, OCR). Do not begin any of this until a phase is explicitly specified.

Other still-open items, unchanged from prior phases:

- Excel grid parsing (Company Bible Long-Term Roadmap item 3).
- Re-review/diff comparison against a prior run (FR-5, PRD Section 8.7).
- Export findings report (FR-6).
- Account/data deletion (FR-7, PRD 8.9) and password reset — flagged as open risks since Phase 2, still not built.
- OCR support (still explicitly out of scope; `ocr_required` reports remain unreviewable until this exists).

## Important implementation decisions (Phase 7)

- **No fixed milestone spec existed for Phase 7 either** — same situation as Phases 5–6. Typo/formatting detection (PRD Section 18 category 7) was the only remaining category with no unmet dependency. See `docs/architecture.md` Phase 7 "Scope decision."
- **Deliberately not a dictionary-based spellchecker.** A generic English wordlist would flag enormous numbers of legitimate proper nouns, addresses, and appraisal/financial jargon — the false-positive risk was judged worse than the value of the additional catches, especially damaging for a category whose whole point is credibility. Only subject-matter-independent, reliable signals are checked: doubled words, doubled punctuation, non-ellipsis double periods.
- **Severity default `low`**, the only category in PRD Section 18 with an explicit default stated directly in Section 19's text.
- **Same anti-duplication tradeoff as Phase 6**: a line is claimed by its first-matching pattern; two different issues on the same line only surface the first. Accepted for consistency/simplicity given this is a Low-severity category.
- **Schema change was the same minimal pattern as Phase 6**: one migration extending `findings.category`'s check constraint (`0007_typo_formatting_findings.sql`). No other schema/RLS/UI change needed.
- **`REVIEW_VERSION` bumped** to `review-pipeline-v3`.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0007_typo_formatting_findings.sql` to every environment that already has migrations `0001`–`0006` applied.
- No new environment variables were introduced in Phase 7.
- No new dependencies were added in Phase 7.

## Known technical debt

- Pre-existing (not introduced by Phases 4–7): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself. No fix is available without a breaking Next.js downgrade.
- No retry action for `failed` extractions or `failed` reviews — today the only recovery path for either is delete + re-upload.
- No manual "re-run review" action — review runs automatically exactly once per report.
- Phase 5/6/7 check patterns are all reasonable-but-not-exhaustive starting sets, not validated against a large corpus of real appraisal reports — expect iteration as real reports surface edge cases.
- The typo/formatting check only reports the first-matching issue per line; a line with two distinct problems only surfaces one finding.
- `findings.category`'s check constraint only allows the three categories implemented so far; each future category needs its own migration to extend it (by design).

## Next phase to begin

Not yet specified by the founder. With all unblocked deterministic categories shipped, the next milestone likely needs a founder decision (Excel ingestion, LLM provider choice, or a different roadmap area). Await explicit instruction before starting Phase 8.
