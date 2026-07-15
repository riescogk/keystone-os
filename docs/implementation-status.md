# Implementation Status

This file is the permanent, repository-resident memory of Keystone OS's progress. It exists so any future session — with no access to prior chat history — can reconstruct exactly where the project stands by reading the repository alone. Update this file at the end of every milestone/phase.

Note on numbering: the codebase and docs use "Phase N"; the founder-facing roadmap has also referred to the same units as "Milestone N". Phase N = Milestone N. They are the same unit of work.

## Completed phases

- **Phase 1/2 — Foundation & Authentication.** Next.js 16 App Router + TypeScript + Tailwind CSS v4 scaffold, ESLint/Prettier, Supabase Auth (signup/login/logout/email confirmation), route protection (`src/proxy.ts` + server-side re-check), protected dashboard shell, `public.users` table with auto-provisioning trigger and full RLS.
- **Phase 3 — Secure Commercial Appraisal Upload.** Private `reports` Storage bucket (25 MB, PDF-only), `public.reports` table with owner-scoped RLS (select/insert/delete), authoritative server-side upload validation (MIME + magic bytes + size), signed-URL viewing, delete with confirmation, real dashboard listing.
- **Phase 4 — PDF Text Extraction.** `unpdf`-based extraction pipeline triggered after upload via `after()`; `extraction_status` lifecycle (`pending → processing → completed | ocr_required | failed`); dashboard status badge with auto-refresh while in progress.
- **Phase 5 — First Automated Review Check: Cross-Document Identity Consistency.** Deterministic check (client name / property address / effective date matched across the document) chained after extraction; `public.findings` table; `review_status` lifecycle on `reports`; finding triage (acknowledge/dismiss with required reason); report detail page (`/dashboard/reports/[id]`).
- **Phase 6 — Second Automated Review Check: Template Leftover Detection.** Deterministic, pattern-based check for unresolved placeholders, template merge syntax, filler text, literal format placeholders, and blank-line runs, added as a second entry in the same `runReview` pipeline. `findings.category` constraint extended via migration; no other schema or UI change needed.

Full detail on every phase in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 6 is complete.** All four verification gates passed on the final code: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production). The template-leftover check was sanity-tested against a synthetic multi-page sample covering every pattern (bracketed placeholder, template merge syntax, Lorem ipsum, literal date/number placeholders, blank-line run, bare TBD) plus a "TBD inside brackets" case confirming no duplicate/overlapping findings, and a normal paragraph confirming no false positives.

## Remaining phases (not yet started)

No phase has been specified by the founder yet. Candidates implied by the PRD, in the rough order the architecture docs suggest tackling them:

- PRD Section 18 category 3 (internal arithmetic verification) — deterministic, but the Company Bible names document-parsing fidelity for financial grids as the single hardest technical problem in the whole product; likely wants Excel grid ingestion (Long-Term Roadmap item 3) first for reliable results, rather than attempting it from narrative text alone.
- Categories 4–5 (narrative-to-data contradiction, missing assumptions) — both model-based (PRD Section 13); blocked until an LLM provider is chosen. This is a real, standing blocker, not an oversight — flag it to the founder when ready to unblock the AI Review Workflow.
- Category 6 (missing supporting documentation references) — partly deterministic, likely paired with category 3's future grid-parsing work.
- Category 7 (typo and formatting inconsistency detection) — deterministic/pattern-based, similar shape to Phase 6; judged lower priority so far.
- Excel grid parsing (Company Bible Long-Term Roadmap item 3).
- Re-review/diff comparison against a prior run (FR-5, PRD Section 8.7).
- Export findings report (FR-6).
- Account/data deletion (FR-7, PRD 8.9) and password reset — flagged as open risks since Phase 2, still not built.
- OCR support (still explicitly out of scope; `ocr_required` reports remain unreviewable until this exists).

Do not begin any of this until a phase is explicitly specified.

## Important implementation decisions (Phase 6)

- **No fixed milestone spec existed for Phase 6 either** — same situation as Phase 5. Template leftover detection (PRD Section 18 category 2) was chosen because it's the only remaining category that's both fully deterministic and has no unmet dependency (unlike arithmetic verification, which wants Excel ingestion, and categories 4–5, which need an LLM provider). See `docs/architecture.md` Phase 6 "Scope decision" for the full reasoning.
- **`runReview.ts` generalized to run a list of checks**, not hardcoded to one. Future categories (once their own dependencies are unblocked) are added the same way: one more array entry, no orchestrator changes.
- **`PageText`/`FindingDraft` moved into `src/lib/review/types.ts`** (previously defined only in `identityConsistencyCheck.ts`) now that two check modules need the same shapes — avoids one check file importing from a sibling check file.
- **Schema change was exactly the anticipated one**: extend `findings.category`'s check constraint via a new migration (`0006_template_leftover_findings.sql`). No other schema/RLS/UI change was needed, confirming Phase 5's "shared findings schema, forward-compatible" design decision paid off as intended.
- **`REVIEW_VERSION` bumped** to `review-pipeline-v2` since the pipeline's output for identical input has changed (a second check now runs). Historical reports keep their original version string; nothing auto-reprocesses.
- **Severity default for this category is `moderate`** — PRD Section 19 gives no explicit default for template leftovers (only typos are explicitly Low-by-default); an unresolved placeholder in a delivered report is a real, visible, client-facing defect but not inherently value-relevant, matching the Moderate definition.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0006_template_leftover_findings.sql` to every environment that already has migrations `0001`–`0005` applied.
- No new environment variables were introduced in Phase 6.
- No new dependencies were added in Phase 6.

## Known technical debt

- Pre-existing (not introduced by Phase 4/5/6): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself. No fix is available without a breaking Next.js downgrade.
- No retry action for `failed` extractions or `failed` reviews — today the only recovery path for either is delete + re-upload.
- No manual "re-run review" action — review runs automatically exactly once per report.
- The identity-consistency check's field-label patterns (Phase 5) are based on common commercial-appraisal-report conventions, not exhaustively validated against real-world report template diversity — expect to need to expand them as real reports surface conventions they don't yet recognize.
- The template-leftover check's patterns (Phase 6) are similarly a reasonable-but-not-exhaustive starting set; expect the same kind of iteration once real reports are run through it.
- `findings.category`'s check constraint only allows the two categories implemented so far; each future category will need its own migration to extend it (by design).

## Next phase to begin

Not yet specified by the founder. Await explicit instruction before starting Phase 7.
