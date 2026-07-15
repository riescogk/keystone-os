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
