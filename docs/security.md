# Security — Phase 2 (Project Foundation)

Running record of security decisions and open risks. Governed by Company Bible Section 0.7 and PRD Section 26.

## What's in place

- **Row Level Security enabled on every table that exists** (`public.users`) — no table is created without RLS enabled in the same migration.
- **Two-layer route protection**: Proxy-level (`src/proxy.ts`) redirect for unauthenticated requests to `/dashboard/*`, plus a server-side `getUser()` re-check in `(dashboard)/layout.tsx`. Neither layer alone is treated as sufficient.
- **No service-role key in any client-reachable code path.** Confirmed by inspection: `service_role` is not referenced anywhere in `src/`.
- **Secrets isolated to environment variables.** `.env.local` is gitignored; `.env.local.example` (committed) contains placeholders only, and explicitly documents that the service-role key must never be assigned to a `NEXT_PUBLIC_` variable.
- **Generic authentication failure messaging.** The login form never reveals whether a given email has an account (PRD Section 8.1, Section 26) — it relies on Supabase's own generic "Invalid login credentials" error rather than a custom message that could leak that information.
- **No cross-account data access is possible in Phase 2's data model** — the only table (`users`) has a select/update policy scoped to `auth.uid()`, and there is no other table yet that could leak data across accounts.

## Open risks / explicitly deferred (not yet resolved, tracked here so they aren't forgotten)

- **Account/data deletion (PRD Section 8.9) is not built yet.** A user cannot currently self-delete their account. This must be built before real customer data is stored, not treated as a nice-to-have.
- **Password reset flow is not built yet.** Only sign-up and login are implemented in Phase 2.
- **Rate limiting on auth endpoints** relies entirely on Supabase's built-in defaults in Phase 2 — no additional application-level rate limiting has been added or evaluated.
- **No monitoring/alerting** is configured yet for auth failures, RLS policy violations, or anomalous access patterns. Acceptable for Phase 2's zero-real-user state; must be revisited before launch.
- **Email confirmation requirement** is a Supabase project _dashboard setting_, not code — whoever configures the Supabase project must explicitly decide whether to require email confirmation before this ships to real users, and record that decision here once made.
