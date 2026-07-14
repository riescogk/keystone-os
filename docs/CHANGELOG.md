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
