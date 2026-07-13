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
