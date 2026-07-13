# Schema — Phase 2 (Project Foundation)

Kept in sync with `supabase/migrations/`. Phase 2 introduces exactly one table.

## `public.users`

One profile row per Supabase Auth user. Created automatically by a trigger when a new `auth.users` row is inserted (i.e., on sign-up) — never inserted directly by client code.

| Column       | Type          | Notes                                             |
| ------------ | ------------- | ------------------------------------------------- |
| `id`         | `uuid` (PK)   | References `auth.users(id)`, `on delete cascade`. |
| `email`      | `text`        | Copied from `auth.users` at sign-up time.         |
| `full_name`  | `text`        | Required. Collected at sign-up.                   |
| `firm_name`  | `text`        | Optional. Collected at sign-up.                   |
| `created_at` | `timestamptz` | Defaults to `now()`.                              |
| `updated_at` | `timestamptz` | Maintained by trigger on every update.            |

### Row Level Security

RLS is enabled. Policies:

- **Select:** a user may select only the row where `id = auth.uid()`.
- **Update:** a user may update only the row where `id = auth.uid()`.
- **Insert:** no policy for the `authenticated` role — rows are created exclusively by the `handle_new_user()` trigger, which runs as `security definer`.
- **Delete:** no policy yet — account deletion (PRD Section 8.9) is a future phase and will be implemented via the Supabase Admin API against `auth.users`, cascading to this table, not via a client-facing delete policy.

### Tables that do NOT exist yet (by design, not oversight)

`reports`, `reviews`, `findings`, `firms`, `notifications`, any billing-related table. These belong to later phases per the PRD roadmap (Section 27) and must not be created ahead of the phase that actually needs them.
