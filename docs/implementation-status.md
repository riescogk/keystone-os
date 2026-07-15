# Implementation Status

This file is the permanent, repository-resident memory of Keystone OS's progress. It exists so any future session — with no access to prior chat history — can reconstruct exactly where the project stands by reading the repository alone. Update this file at the end of every milestone/phase.

Note on numbering: the codebase and docs use "Phase N"; the founder-facing roadmap has also referred to the same units as "Milestone N". Phase N = Milestone N. They are the same unit of work.

## Completed phases

- **Phase 1/2 — Foundation & Authentication.** Next.js 16 App Router + TypeScript + Tailwind CSS v4 scaffold, ESLint/Prettier, Supabase Auth (signup/login/logout/email confirmation), route protection (`src/proxy.ts` + server-side re-check), protected dashboard shell, `public.users` table with auto-provisioning trigger and full RLS.
- **Phase 3 — Secure Commercial Appraisal Upload.** Private `reports` Storage bucket (25 MB, PDF-only), `public.reports` table with owner-scoped RLS (select/insert/delete), authoritative server-side upload validation (MIME + magic bytes + size), signed-URL viewing, delete with confirmation, real dashboard listing.
- **Phase 4 — PDF Text Extraction.** `unpdf`-based extraction pipeline triggered after upload via `after()`; `extraction_status` lifecycle (`pending → processing → completed | ocr_required | failed`); dashboard status badge with auto-refresh while in progress.
- **Phase 5 — First Automated Review Check: Cross-Document Identity Consistency.** Deterministic check (client name / property address / effective date matched across the document) chained after extraction; `public.findings` table; `review_status` lifecycle on `reports`; finding triage (acknowledge/dismiss with required reason); new report detail page (`/dashboard/reports/[id]`).

Full detail on every phase in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 5 is complete.** All four verification gates passed on the final code: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production). The identity-consistency check logic was also sanity-tested against a synthetic multi-page sample, confirming it correctly flags genuine mismatches (a name typo, a differing date) while not false-flagging a normalized-equivalent address ("123 Main Street" vs "123 Main St.").

## Remaining phases (not yet started)

No phase has been specified by the founder yet. Candidates implied by the PRD and explicitly deferred by Phase 5's scope decision (see `docs/architecture.md` Phase 5 "Scope decision" and `docs/CHANGELOG.md` "Explicitly not shipped"):

- The remaining six PRD Section 18 review categories (template leftovers, arithmetic verification, narrative-to-data contradiction, missing assumptions, missing supporting documentation, typo detection).
- Any AI/model-based check (PRD Section 13) — requires an LLM provider to be chosen first, which has not happened yet.
- Excel grid parsing (Company Bible Long-Term Roadmap item 3).
- Re-review/diff comparison against a prior run (FR-5, PRD Section 8.7).
- Export findings report (FR-6).
- Account/data deletion (FR-7, PRD 8.9) and password reset — flagged as open risks since Phase 2, still not built.
- OCR support (still explicitly out of scope; `ocr_required` reports remain unreviewable until this exists).

Do not begin any of this until a phase is explicitly specified.

## Important implementation decisions (Phase 5)

- **No fixed milestone spec existed for Phase 5** — the PRD/Company Bible describe the full review engine but explicitly defer engineering sequencing to per-phase founder decisions (Company Bible Section 14). Phase 5 was scoped as the smallest complete vertical slice: one deterministic category + the findings data model + triage + minimal UI. See `docs/architecture.md` Phase 5 "Scope decision" for the full reasoning.
- **Deterministic, pattern-based check — not AI/NER.** Looks for known labeled-field conventions (`Client:`, `Property Address:`, `Effective Date:`, etc.) line-by-line, normalizes (whitespace/case, address abbreviations, date formats), and only flags a field with two or more distinct normalized values. Zero or one occurrence produces no finding — this check does not claim to detect _missing_ fields.
- **Chained, not separately triggered.** `runTextExtraction` calls `runReview` directly right after marking extraction `completed` — no new `after()`/queue/infrastructure. A report whose extraction is `ocr_required`/`failed` leaves `review_status` at `pending` indefinitely (nothing invented beyond the PRD's actual lifecycle).
- **Findings schema is shared, forward-compatible with future model-based checks** (PRD Section 14 point 4): `category`/`severity`/`confidence`/`description`/`evidence`/`location` are generic; only the `category` check constraint is scoped tightly to what's implemented today and will need a migration per new category, matching the same convention as `extraction_status`.
- **RLS extended following the exact Phase 4 precedent**: `findings` gets select/insert/update policies scoped to `user_id = auth.uid()` (denormalized directly onto the row). No delete policy — findings are only removed via cascade when their parent report is deleted.
- **Dismissal reason required at the DB level**, not just the UI, via `findings_dismissed_reason_required_check`.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0005_findings.sql` to every environment (local, staging, production) that already has migrations `0001`–`0004` applied.
- No new environment variables were introduced in Phase 5.
- No new dependencies were added in Phase 5 (review runs on plain TypeScript/regex logic, no new package).

## Known technical debt

- Pre-existing (not introduced by Phase 4/5): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself. No fix is available without a breaking Next.js downgrade.
- No retry action for `failed` extractions or `failed` reviews — today the only recovery path for either is delete + re-upload.
- No manual "re-run review" action — review runs automatically exactly once per report.
- The identity-consistency check's field-label patterns are based on common commercial-appraisal-report conventions, not exhaustively validated against real-world report template diversity (the Company Bible names this as a genuine, hard, ongoing risk — see Sections 20/21). Expect to need to expand the label patterns in `src/lib/review/identityConsistencyCheck.ts` as real reports surface conventions it doesn't yet recognize.
- `findings.category`'s check constraint only allows the one category implemented so far; each future category will need its own migration to extend it (by design, matching how `extraction_status` was scoped).

## Next phase to begin

Not yet specified by the founder. Await explicit instruction before starting Phase 6.
