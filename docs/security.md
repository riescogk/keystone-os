# Security — Phase 2 (Project Foundation)

Running record of security decisions and open risks. Governed by Company Bible Section 0.7 and PRD Section 26.

## What's in place

- **Row Level Security enabled on every table that exists** (`public.users`) — no table is created without RLS enabled in the same migration.
- **Two-layer route protection**: Proxy-level (`src/proxy.ts`) redirect for unauthenticated requests to `/dashboard/*`, plus a server-side `getUser()` re-check in `(dashboard)/layout.tsx`. Neither layer alone is treated as sufficient.
- **No service-role key in any client-reachable code path.** Confirmed by inspection: `service_role` is not referenced anywhere in `src/`.
- **Secrets isolated to environment variables.** `.env.local` is gitignored; `.env.local.example` (committed) contains placeholders only, and explicitly documents that the service-role key must never be assigned to a `NEXT_PUBLIC_` variable.
- **Generic authentication failure messaging.** The login form never reveals whether a given email has an account (PRD Section 8.1, Section 26) — it relies on Supabase's own generic "Invalid login credentials" error rather than a custom message that could leak that information.
- **No cross-account data access is possible in Phase 2's data model** — the only table (`users`) has a select/update policy scoped to `auth.uid()`, and there is no other table yet that could leak data across accounts.

## Phase 3 additions

- **`public.reports` and the `reports` Storage bucket both enforce ownership via `auth.uid()`** — select/insert/delete on the table, and select/insert/delete on `storage.objects` scoped by the object path's leading `{user_id}` folder. Verified with the two-user test below, not assumed from the policy definitions alone.
- **The `reports` bucket is private** (`public = false`). The only way to read a file's bytes is a signed URL, generated server-side, expiring in 60 seconds, and only after the caller's ownership of the corresponding database row has been confirmed via RLS.
- **No `user_id` is ever accepted from the client.** Every server action (`uploadReport`, `getSignedReportUrl`, `deleteReport`) derives the acting user exclusively from `supabase.auth.getUser()` inside the action itself.
- **File type is verified against actual file bytes** (PDF magic number), not just the browser-reported MIME type, closing the trivial "rename a .exe to .pdf" spoof.
- **The service-role key is still not used anywhere** — Phase 3 upload/delete/signed-URL all run under the authenticated user's own RLS-scoped session.

### Two-user security test (run this before considering Phase 3 done)

1. Create two accounts (User A, User B) in the deployed/dev app.
2. As User A: upload a report, note its filename.
3. As User B: confirm the Dashboard report list does **not** show User A's report.
4. As User B, attempt to guess/construct a signed URL or call `getSignedReportUrl` with User A's report id (e.g., via browser dev tools if you want to simulate a malicious client) — confirm it returns an error, not a URL.
5. As User B, attempt to call `deleteReport` with User A's report id — confirm it returns "Report not found," and confirm afterward (as User A) that the report still exists.
6. In the Supabase Dashboard, confirm `storage.objects` for the `reports` bucket shows each file only under its owner's `{user_id}/` folder.

## Phase 4 additions

- **First UPDATE policy on `public.reports`**, added specifically so the text-extraction pipeline can write its result back to the row (`extraction_status`, `extracted_text`, `page_count`, `extraction_completed_at`, `extraction_version`). Scoped identically to the existing select/insert/delete policies (`user_id = auth.uid()`) — this does not open the row to any operation a user couldn't already do to their own data, and does not touch the uploaded file itself.
- **Still no service-role key.** Extraction runs via `runTextExtraction`, using the same session-scoped `createClient()` as every other server action — not an elevated-privilege client.
- **No new externally-reachable endpoint.** Extraction is triggered from inside the existing `uploadReport` Server Action via `after()`, not a new public route, so there is no new attack surface for triggering extraction on someone else's report.
- **Downloaded file bytes never leave the server.** `runTextExtraction` downloads the PDF from the private Storage bucket, extracts text in memory, and discards the buffer once the row is updated — no extracted text or file bytes are sent to the client from this pipeline (there is no UI reading `extracted_text` yet).

## Phase 5 additions

- **New `public.findings` table, RLS-scoped identically to `reports`** — select/insert/update all require `user_id = auth.uid()`. Ownership is denormalized directly onto each finding row (not just inherited via a join to `reports`), matching the existing convention (`reports.user_id`).
- **Still no service-role key.** The review pipeline (`runReview`) uses the same session-scoped `createClient()`; findings are inserted as the report owner's own session, subject to the same RLS as everything else.
- **No new externally-reachable endpoint for review.** Like extraction, review is chained from inside the existing background pipeline (`runTextExtraction` calling `runReview` directly) — not a new public route.
- **Finding triage (`acknowledgeFinding`, `dismissFinding`) never trusts a client-supplied owner check.** Ownership is enforced entirely by RLS; the application code only checks whether the update affected a row, and returns the same generic "Finding not found" error whether the finding doesn't exist or belongs to someone else — this avoids leaking which case it was, consistent with the login form's generic-failure pattern (Phase 2).
- **Dismissal reason is required at the database level**, not just the UI (`findings_dismissed_reason_required_check`), so a `dismissed` finding can never end up without a reason even via a direct API/SQL client that bypasses the Server Action.

### Two-user security test addendum (Phase 5)

Repeat the Phase 3 two-user test, extended to findings:

1. As User A: upload and let a report be reviewed; note a finding's id (via browser dev tools / network tab if simulating a malicious client).
2. As User B: confirm `/dashboard/reports/{User A's report id}` returns a 404 (via RLS returning no row, then `notFound()`), not User A's findings.
3. As User B, attempt to call `acknowledgeFinding`/`dismissFinding` with User A's finding id — confirm it returns "Finding not found," and confirm afterward (as User A) that the finding's status is unchanged.

## Phase 6

No new security surface. Template leftover detection reuses the exact same `findings` table, RLS policies, and orchestrator (`runReview.ts`) introduced in Phase 5 — the only change was extending the `category` check constraint (migration `0006_template_leftover_findings.sql`) to allow one more value. No new tables, no new endpoints, no new client-reachable code path.

## Phase 7

Same as Phase 6: no new security surface. Typo/formatting detection reuses the identical `findings` table, RLS, and orchestrator; the only change is extending the `category` check constraint again (migration `0007_typo_formatting_findings.sql`).

## Phase 8

Same pattern again: no new security surface. Missing-documentation detection reuses the identical `findings` table, RLS, and orchestrator; the only change is extending the `category` check constraint once more (migration `0008_missing_documentation_findings.sql`).

## Phase 9

Same pattern again: no new security surface, no new dependency, no Excel file handling (and therefore no new file-parsing attack surface beyond what Phase 4's PDF extraction already introduced). Arithmetic verification reuses the identical `findings` table, RLS, and orchestrator; the only change is extending the `category` check constraint once more (migration `0009_arithmetic_verification_findings.sql`).

## Phase 10 — Account & Data Deletion

- **Still no service-role key in `src/`.** Deleting an `auth.users` row normally requires the admin API and therefore the service-role key. Instead, migration `0010_delete_own_account.sql` adds `public.delete_own_account()`, a `SECURITY DEFINER` function that takes **no arguments** and deletes only `auth.uid()` — the caller's own account, taken from the verified JWT. There is no user-id parameter anywhere in the chain, so "delete an arbitrary user" is not expressible. This was chosen over the admin API specifically to preserve the project invariant above.
- **Execution is locked down.** `EXECUTE` is revoked from `public` and `anon` and granted only to `authenticated`. The function sets `search_path = ''` and uses fully-qualified names (standard hardening for `SECURITY DEFINER` functions).
- **File removal runs under the user's own session** through the Storage API, authorized by the existing "Users can delete their own report objects" RLS policy (`0003`). No policy was added or weakened.
- **The database refuses to orphan files.** `delete_own_account()` raises an exception if any object under the caller's `{user_id}/` folder still exists in the `reports` bucket, so even a buggy or bypassed application path cannot delete an account while leaving unreachable files behind.
- **Confirmation is enforced server-side.** The Server Action re-checks the typed confirmation phrase; the UI check only enables the button.
- **Failure is never reported as success.** Success is returned only after the RPC succeeds. Any earlier failure returns an explicit "account was NOT deleted" error and the account still exists.
- **Server Actions' built-in same-origin protection** applies to `deleteAccount` like every other action; no new route handler or public endpoint was added.

### Two-user security test addendum (Phase 10)

1. As User A and User B, each upload a report.
2. As User A, delete the account. Confirm: A is sent to `/login`; A's credentials no longer work; A's rows are gone from `public.users`, `public.reports`, `public.findings`; A's folder in the `reports` bucket is empty.
3. Confirm User B is completely unaffected: B's profile, reports, findings and files all still exist and open normally.
4. As User B, in the browser console or via the Supabase client, call `supabase.rpc("delete_own_account")` only if you intend to delete B — it can only ever delete B, never A. (It accepts no arguments; there is nothing to point at another user.)
5. Signed out / anonymous: `supabase.rpc("delete_own_account")` must fail with a permission error.

### Known limitations / unresolved items (Phase 10)

- **Storage and database are two systems; deletion cannot be one atomic transaction.** Files are removed first, then the account. If the file step fails midway, some files may already be gone while the account remains intact; the user sees an explicit error and can safely retry (removal is idempotent). The reverse — account deleted but files left — is blocked by the database guard above.
- **Infrastructure-provider backups are outside this action.** Supabase platform backups (if enabled on the project's plan) retain data on the provider's own schedule. PRD 8.9 says retention details belong in a future privacy policy; the deletion UI states honestly that provider backups follow the provider's retention. **Decision for the founder:** confirm the project's backup/PITR settings and state the retention window in the privacy policy before launch ("within a stated timeframe," PRD FR-7).
- **No re-authentication step.** Deletion requires an active session plus the typed confirmation, but not a fresh password entry. A hijacked live session could therefore delete the account. Acceptable for the current single-user v1; consider requiring a recent re-auth once password change/reset exists.
- **Active sessions on other devices** stop working because the auth user no longer exists (the server rejects their tokens), though already-issued access tokens are not cryptographically revoked before their normal expiry. They cannot read data: every row and file is gone.
- **No email notification or audit record** of deletion is produced (no email infrastructure exists yet; creating a deletion log would retain data about a deleted user, which needs a deliberate privacy decision).

## Open risks / explicitly deferred (not yet resolved, tracked here so they aren't forgotten)

- ~~Account/data deletion (PRD Section 8.9) is not built yet.~~ **Resolved in Phase 10** — see "Phase 10 — Account & Data Deletion" above, including its known limitations (provider backups, no re-auth step).
- **Password reset flow is not built yet.** Only sign-up and login are implemented in Phase 2.
- **Rate limiting on auth endpoints** relies entirely on Supabase's built-in defaults in Phase 2 — no additional application-level rate limiting has been added or evaluated.
- **No monitoring/alerting** is configured yet for auth failures, RLS policy violations, or anomalous access patterns. Acceptable for Phase 2's zero-real-user state; must be revisited before launch.
- **Email confirmation requirement** is a Supabase project _dashboard setting_, not code — whoever configures the Supabase project must explicitly decide whether to require email confirmation before this ships to real users, and record that decision here once made.
