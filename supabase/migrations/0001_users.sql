-- =====================================================================
-- Migration: 0001_users.sql
-- Phase 2 — Project Foundation
--
-- Creates the ONLY table in this phase: public.users, a profile row
-- mirroring auth.users (which Supabase manages and we never edit
-- directly). Row Level Security ensures a user can only ever see or
-- modify their own row. No other tables (reports, reviews, findings)
-- exist yet — those are out of scope for Phase 2.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  firm_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is
  'One profile row per Supabase auth user. Phase 2 scope only — no firm/team table yet (PRD Section 27, deferred).';

-- ---------------------------------------------------------------------
-- 2. updated_at maintenance
-- ---------------------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_users_updated_at
  before update on public.users
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 3. Auto-provision a public.users row whenever a new auth.users row
--    is created (i.e. on sign-up). Runs as the function owner
--    (security definer) because the client's own role does not have
--    insert rights on auth.users' companion table by default — this
--    is the standard, documented Supabase pattern for profile tables.
-- ---------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, firm_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'firm_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 4. Row Level Security
--
-- Default posture: deny everything, then allow exactly what the PRD
-- requires (Section 10 — Permissions: a user may only view/act on
-- their own data; Section 26 — Security Requirements: no cross-
-- account visibility of any kind).
-- ---------------------------------------------------------------------
alter table public.users enable row level security;

create policy "Users can view their own profile"
  on public.users
  for select
  to authenticated
  using (id = (select auth.uid()));

create policy "Users can update their own profile"
  on public.users
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No insert policy for the 'authenticated' role: rows are created
-- exclusively by the handle_new_user() trigger above, which runs with
-- elevated privilege. A user's own session can never insert an
-- arbitrary profile row for themselves or anyone else.

-- No delete policy: account deletion in Phase 2 is not yet built
-- (PRD Section 8.9 is a future-phase screen). When it is built, it
-- should delete the auth.users row via the Supabase Admin API, which
-- cascades to this table via the foreign key's ON DELETE CASCADE —
-- not via a client-facing delete policy on this table.
