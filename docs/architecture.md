# Architecture — Phase 2 (Project Foundation)

Governed by `docs/chapter-0-the-manifesto.md`, `docs/company-bible.md`, and `docs/prd-v1.md`. This document records _what was built and why_ — it does not redefine the product.

## Stack

- **Next.js 16 (App Router, TypeScript, Turbopack)** — per existing team experience (Company Bible 0.6).
- **Tailwind CSS v4** — utility CSS, no design-system library added in Phase 2 (avoids overengineering a design system before there are more than 6 screens).
- **Supabase** (Auth + Postgres) — identity and data store. No custom auth system (Company Bible security posture, 0.7).
- **Vercel** — hosting/deploy target.

## Key decisions

1. **`@supabase/ssr` over the older `@supabase/auth-helpers-nextjs`.** `@supabase/ssr` is Supabase's current, actively maintained package for Next.js App Router cookie-based sessions.
2. **Three separate Supabase client factories** (`lib/supabase/client.ts`, `server.ts`, `middleware.ts`) rather than one shared client. Browser, Server Component/Action, and Proxy(middleware) contexts each have different cookie-handling requirements in Next.js — collapsing them into one file makes the cookie-sync bugs (a well-known class of bug in Supabase+Next.js integrations) more likely, not less.
3. **`src/proxy.ts`, not `src/middleware.ts`.** Next.js 16 renamed the "Middleware" file convention to "Proxy" (same functionality, new file name and export name — confirmed against the Next.js 16 docs bundled with the installed package, not assumed from prior training knowledge, since this is a very recent rename).
4. **Two layers of route protection** (Proxy-level redirect + a server-side `getUser()` check in the `(dashboard)/layout.tsx`): consistent with the project's RLS-first, defense-in-depth security principle (Company Bible 0.5) — no single layer is trusted as the only gate.
5. **`public.users` row is provisioned by a `security definer` Postgres trigger on `auth.users` insert, not by a client-side insert call.** This is the standard, documented Supabase pattern and means the client's session can never insert an arbitrary profile row — enforced at the database layer, not just in application code.
6. **No service-role key anywhere in Phase 2.** Every Supabase call in this phase runs as the authenticated user, subject to RLS. This is intentional and should remain true until a specific, later, justified need requires the service-role key (e.g., an admin operation) — and even then it must never be used from a client-reachable code path.
7. **No custom font loading (`next/font/google`) in the root layout.** Removed the create-next-app default because it introduces a build-time external network dependency for no product-relevant benefit at this stage; system font stack via Tailwind is used instead. Revisit only if/when visual design work (a future phase) has a specific typographic reason to.
8. **No design system / component library dependency added.** `Button` and `Input` are small, hand-written components. Per Company Bible 0.5 ("do not overengineer"), a component library is not justified for 6 screens and 2 reusable primitives.

## What Phase 2 deliberately does not include

Per the founder's explicit Phase 2 instruction: no PDF upload, no review engine, no findings, no billing, no teams, no notifications. Any code that appears to anticipate these (e.g., table names, route names) should be treated as accidental scope creep and flagged, not treated as "getting ahead of the next phase."
