# Implementation Status

This file is the permanent, repository-resident memory of Keystone OS's progress. It exists so any future session — with no access to prior chat history — can reconstruct exactly where the project stands by reading the repository alone. Update this file at the end of every milestone/phase.

Note on numbering: the codebase and docs use "Phase N"; the founder-facing roadmap has also referred to the same units as "Milestone N". Phase 4 = Milestone 4. They are the same unit of work.

## Completed phases

- **Phase 1/2 — Foundation & Authentication.** Next.js 16 App Router + TypeScript + Tailwind CSS v4 scaffold, ESLint/Prettier, Supabase Auth (signup/login/logout/email confirmation), route protection (`src/proxy.ts` + server-side re-check), protected dashboard shell, `public.users` table with auto-provisioning trigger and full RLS.
- **Phase 3 — Secure Commercial Appraisal Upload.** Private `reports` Storage bucket (25 MB, PDF-only), `public.reports` table with owner-scoped RLS (select/insert/delete), authoritative server-side upload validation (MIME + magic bytes + size), signed-URL viewing, delete with confirmation, real dashboard listing.
- **Phase 4 — PDF Text Extraction.** `unpdf`-based extraction pipeline triggered after upload via `after()`; `extraction_status` lifecycle (`pending → processing → completed | ocr_required | failed`); dashboard status badge with auto-refresh while in progress. Full detail in `docs/CHANGELOG.md` and `docs/architecture.md`.

## Current phase

**Phase 4 is complete.** All four verification gates passed on the final code: `tsc --noEmit`, ESLint (flat config), Prettier `--check`, and `next build` (production).

## Remaining phases (not yet started)

The next phase has not been specified by the founder yet. Candidates implied by the PRD's Review Lifecycle (Section 16) and not yet built: the rule engine / AI review, findings, report summaries, and everything else explicitly excluded from Phase 4's scope (see `docs/CHANGELOG.md` "Explicitly not shipped"). Do not begin any of this until a phase is explicitly specified.

## Important implementation decisions (Phase 4)

- **Library:** `unpdf` (wraps `pdfjs-dist`), chosen over `pdf-parse` and direct `pdfjs-dist` use — see `docs/architecture.md` "Phase 4 — PDF Text Extraction" for the full comparison and rationale.
- **Trigger mechanism:** Next.js `after()` inside the existing `uploadReport` Server Action — no new queue/cron/worker infrastructure introduced. Deliberately designed so a future real background-job system can replace just the trigger call; `runTextExtraction(reportId)` itself would not need to change.
- **RLS:** Added the first UPDATE policy on `public.reports`, scoped identically to the existing owner-only policies. This was necessary and intentional — extraction results have to be written back to the row somehow — and does not weaken the "uploaded file is never modified" guarantee (only new metadata columns are written; the file in Storage is untouched).
- **Storage shape:** `extracted_text` is one delimited string per report (`--- Page N ---` markers), not a per-page table. No feature in this phase needs to query individual pages; a per-page table was deliberately deferred to avoid overengineering ahead of actual need (Company Bible 0.5).
- **OCR boundary:** A PDF is marked `ocr_required` when no page anywhere in the document has any selectable text. OCR itself is explicitly out of scope and not implemented.
- **No retry action yet.** A `failed` report's only recovery path today is delete + re-upload. Adding a retry action was deliberately treated as out of this phase's scope (it borders on review-lifecycle territory) and left for the founder to explicitly request.

## Manual deployment steps still pending

- Apply migration `supabase/migrations/0004_report_extraction.sql` to every environment (local, staging, production) that already has migrations `0001`–`0003` applied. See the final Phase 4 report for exact commands.
- No new environment variables were introduced in Phase 4.
- `npm install` must be run wherever the repo is deployed from, to pick up the new `unpdf` dependency (already present in `package.json` / `package-lock.json`).

## Known technical debt

- Pre-existing (not introduced by Phase 4): `npm audit` reports 2 moderate-severity advisories against the `postcss` version bundled transitively by Next.js itself (`node_modules/next/node_modules/postcss`). No fix is available without a breaking Next.js downgrade; not addressed here as it is out of Phase 4's scope and unrelated to this phase's changes.
- Extraction currently runs synchronously within the `after()` callback of the same serverless invocation that handled the upload. For very large PDFs (near the 300-page/25 MB ceiling) this is acceptably fast today, but if invocation time limits ever become a constraint, this is the intended seam to swap in a real background job (see "Trigger mechanism" above) — no other code changes needed.
- No retry action for `failed` extractions (see above) — tracked here so it isn't forgotten, not treated as a defect.

## Next phase to begin

Not yet specified by the founder. Await explicit instruction before starting Phase 5.
