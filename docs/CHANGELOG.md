# Changelog

## Phase 2 — Project Foundation

**Shipped:**

- Next.js 16 (App Router, TypeScript, Turbopack) project scaffold.
- Tailwind CSS v4 configured.
- ESLint + Prettier (with `prettier-plugin-tailwindcss`) configured.
- Recommended folder structure (`src/app`, `src/components/{layout,ui}`, `src/lib/supabase`, `src/types`, `supabase/migrations`).
- Supabase Auth: sign up, log in, log out, email-confirmation callback route.
- Route protection via `src/proxy.ts` (Next.js 16's renamed Middleware convention) + a server-side re-check in the dashboard layout.
- Protected dashboard shell: `AppShell`, `Navbar`, empty-state Dashboard page, read-only Account Settings page.
- Reusable UI primitives: `Button`, `Input`.
- Database: `public.users` table, auto-provisioning trigger, `updated_at` trigger, full Row Level Security.
- `docs/` folder established with the Manifesto, Company Bible, PRD, architecture, schema, and security docs.

**Explicitly not shipped (by design, per Phase 2 instruction):**

- Report upload, review engine, findings, billing, teams, notifications.
- Password reset, account/data deletion, profile editing.

## Phase 3 — Secure Report Upload

**Shipped:**

- `public.reports` table + Row Level Security (select/insert/delete scoped to `auth.uid()`).
- Private `reports` Storage bucket (25 MB limit, PDF-only) + `storage.objects` RLS policies scoped to the `{user_id}/` path prefix.
- New Review page (`/dashboard/new`) with client-side + authoritative server-side PDF validation (MIME type, magic-number check, file size).
- Server Actions: `uploadReport`, `getSignedReportUrl` (60-second signed URL), `deleteReport` — all deriving ownership exclusively from the verified session, never from client input.
- Dashboard now lists real uploaded reports (empty state preserved for zero-report accounts), each with working Open and Delete (with a confirm step) actions.
- Navbar's "New Review" link now points to a real, working route.
- `next.config.ts`: Server Actions body size limit raised to accommodate 25 MB uploads.

**Explicitly not shipped (by design, per Phase 3 instruction):**

- Text extraction, review engine, findings, AI, OCR, billing, teams, exports, notifications.
- Any report status/lifecycle beyond "exists" or "deleted" (row presence/absence).

## Phase 4 — PDF Text Extraction

**Shipped:**

- `unpdf`-based text extraction pipeline: `src/lib/extraction/{types.ts,pdfTextExtractor.ts,runExtraction.ts}`.
- Migration `0004_report_extraction.sql`: adds `extraction_status`, `extracted_text`, `page_count`, `extraction_completed_at`, `extraction_version` to `public.reports`, plus the table's first UPDATE Row Level Security policy (scoped identically to the existing owner-only policies).
- `uploadReport` now schedules extraction via Next.js `after()` immediately after the row insert, so the upload response never waits on it.
- Extraction lifecycle: `pending` → `processing` → one of `completed` / `ocr_required` / `failed`. A document with zero selectable text anywhere is marked `ocr_required` rather than guessed at; OCR itself is not implemented (by design, per Phase 4 instruction).
- Dashboard: `ExtractionStatusBadge` shows each report's status; `ReportRow` polls (every 4s, client-side) while a report is `pending`/`processing`, stopping automatically once it reaches a terminal state.

**Explicitly not shipped (by design, per Phase 4 instruction):**

- OCR, AI review, rule engine, findings, report summary, chat, embeddings, vector database, search, AI analysis, review suggestions.
- A retry action for `failed` extractions — today the only recovery path is deleting and re-uploading the report.
- A structured per-page storage table — `extracted_text` stores the full document as one delimited string (`--- Page N ---`), sufficient for this phase's scope.

## Phase 5 — First Automated Review Check: Cross-Document Identity Consistency

**Shipped:**

- `public.findings` table (migration `0005_findings.sql`) with owner-scoped select/insert/update RLS, plus `review_status`/`review_completed_at`/`review_version` added to `public.reports`.
- Deterministic identity-consistency check (`src/lib/review/identityConsistencyCheck.ts`): client name, property address, and effective date are matched across every page using common labeled-field conventions, normalized (whitespace/case, address abbreviations, multiple date formats), and flagged when two or more distinct values are found anywhere in the document. Zero AI/LLM involvement, per PRD Section 14.
- Review runs automatically immediately after a successful extraction (`runExtraction.ts` now calls `runReview.ts`), chained within the same background pipeline — no new trigger/infrastructure.
- `splitPagesFromStorage` added (inverse of Phase 4's `joinPagesForStorage`) so the review pipeline can recover per-page text and cite page numbers in evidence.
- Finding triage (FR-4): `acknowledgeFinding` / `dismissFinding` Server Actions, dismissal requires a non-empty reason (enforced in the UI and via a DB check constraint).
- Dashboard: `ReviewStatusBadge` alongside the extraction badge, polling extended to cover review in-progress states.
- New report detail page (`/dashboard/reports/[id]`, PRD 8.5/8.6 minimal slice): shows extraction/review status and the findings list, with inline acknowledge/dismiss actions per finding.

**Explicitly not shipped (by design — see `docs/architecture.md` Phase 5 "Scope decision" for the full reasoning):**

- The remaining six PRD Section 18 review categories (template leftovers, arithmetic verification, narrative-to-data contradiction, missing assumptions, missing supporting documentation, typo detection).
- Any AI/model-based check (PRD Section 13) — no LLM provider has been chosen yet.
- Excel grid parsing, re-review/diff comparison (FR-5), export (FR-6), a numeric confidence score (permanently rejected per PRD Section 20), and a manual "re-run review" action.

## Phase 6 — Second Automated Review Check: Template Leftover Detection

**Shipped:**

- Deterministic template-leftover check (`src/lib/review/templateLeftoverCheck.ts`, PRD Section 18 category 2): scans extracted text for unresolved bracketed instructions (`[Insert Client Name]`), template merge syntax (`{{field}}`/`<<field>>`), literal "Lorem ipsum" filler, un-filled-in date/number-format placeholders (`MM/DD/YYYY`, `XXX,XXX`), unfilled blank-line runs (`____`), and bare "TBD"/"to be determined." Zero AI/LLM involvement. Patterns matched most-specific-first per line so one artifact never produces overlapping duplicate findings; repeated occurrences of the same value are grouped into one finding listing every page found (capped, "and N more page(s)").
- `runReview.ts` now runs a list of checks (identity consistency + template leftovers) rather than one — adding this check required no change to the orchestrator's lifecycle/idempotency/error handling.
- Migration `0006_template_leftover_findings.sql`: extends `findings.category`'s check constraint to allow the new category — the only schema change needed, since `findings` was already shaped generically.
- `PageText`/`FindingDraft` moved from `identityConsistencyCheck.ts` into the shared `src/lib/review/types.ts`, now that two checks need them.
- `REVIEW_VERSION` bumped (`identity-consistency-v1` → `review-pipeline-v2`) to reflect the pipeline producing different findings for the same input now that a second check runs.
- No UI changes were needed — the existing `FindingCard`/dashboard components already render any `FindingCategory`/`FindingSeverity` generically via the shared label maps in `types.ts`.

**Explicitly not shipped (by design — see `docs/architecture.md` Phase 6 "Scope decision"):**

- PRD Section 18 category 3 (arithmetic verification) — deferred until Excel grid ingestion exists, since narrative-text-only arithmetic checking on commercial appraisal reports is named by the Company Bible as the hardest technical risk in the product.
- Categories 4–5 (model-based) — still blocked on an LLM provider decision.
- Category 6 — more naturally paired with category 3's future grid-parsing work.
- Category 7 (typo detection) — judged lower priority than leftovers for now.

## Phase 7 — Third Automated Review Check: Typo & Formatting Inconsistency Detection

**Shipped:**

- Deterministic typo/formatting check (`src/lib/review/typoFormattingCheck.ts`, PRD Section 18 category 7, Low severity by default per PRD Section 19): detects accidentally doubled words (`"the the"`), doubled punctuation (`"??"`, `"!!"`, etc.), and double periods (`".."`) that aren't part of a `"..."` ellipsis. Deliberately **not** a dictionary-based spellchecker — a generic wordlist would flag huge numbers of legitimate proper nouns, addresses, and financial/legal jargon, producing exactly the kind of noisy output that would undermine the category's own purpose (document credibility).
- `runReview.ts` now runs a third check — again, zero orchestrator changes required.
- Migration `0007_typo_formatting_findings.sql`: extends `findings.category`'s check constraint — the only schema change needed.
- `REVIEW_VERSION` bumped (`review-pipeline-v2` → `review-pipeline-v3`).
- No UI changes needed, same as Phase 6.

**Explicitly not shipped (by design — see `docs/architecture.md` Phase 7 "Scope decision"):**

- A dictionary/spellchecker-based approach — judged too high false-positive risk against real appraisal-report vocabulary.
- Categories 3–6 — still blocked on Excel ingestion (3, 6) or an LLM provider decision (4–5).
- Multi-issue-per-line detection within this check — a line is claimed by its first-matching pattern only, same tradeoff as Phase 6.
- Re-review/diff, export, or a manual re-run action.

## Phase 8 — Fourth Automated Review Check: Missing Supporting Documentation References (deterministic sub-case)

**Shipped:**

- Deterministic missing-documentation check (`src/lib/review/missingDocumentationCheck.ts`, PRD Section 18 category 6's deterministic sub-case, Moderate severity per PRD Section 19's own "an unreferenced addendum" example): finds every in-text reference to a named Addendum/Exhibit/Appendix/Attachment (e.g. "see Addendum C") and flags it if no section titled that way appears anywhere else in the document. Conservative by design — a table-of-contents mention is enough to count as "found," since flat extracted text has no layout metadata to distinguish a ToC line from a real section start.
- `runReview.ts` now runs a fourth check — zero orchestrator changes required, same as every prior addition.
- Migration `0008_missing_documentation_findings.sql`: extends `findings.category`'s check constraint — the only schema change needed.
- `REVIEW_VERSION` bumped (`review-pipeline-v3` → `review-pipeline-v4`).
- No UI changes needed.

**Explicitly not shipped (by design — see `docs/architecture.md` Phase 8 "Scope decision"):**

- This category's own _inferential_ sub-case (a referenced comp not appearing in the grid) — the PRD itself marks this half as model-based/needing Excel grid data, neither of which exists yet.
- Categories 3, 4, 5 — still blocked on Excel ingestion or an LLM provider decision.
- Any attempt to distinguish a real section heading from a table-of-contents entry without layout metadata.
