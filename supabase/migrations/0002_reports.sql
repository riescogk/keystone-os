-- =====================================================================
-- Migration: 0002_reports.sql
-- Phase 3 — Secure Report Upload
--
-- Creates public.reports: one row per uploaded PDF, owned by exactly
-- one user. Ownership is enforced by RLS using auth.uid() — never by
-- a client-supplied value. No status/lifecycle column is added yet
-- (PRD Section 15's full Report Lifecycle — Processing/Reviewed/
-- Superseded — is a later phase; this phase only has "uploaded" and
-- "deleted", and "deleted" is represented by row removal, not a flag).
-- =====================================================================

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  original_filename text not null,
  storage_path text not null unique,
  file_size_bytes bigint not null,
  created_at timestamptz not null default now()
);

comment on table public.reports is
  'One row per uploaded PDF. Phase 3 scope only — no review/findings/status columns yet.';
comment on column public.reports.storage_path is
  'Generated internal path in the private "reports" Storage bucket, always {user_id}/{report_id}.pdf. Never derived from the original filename.';
comment on column public.reports.original_filename is
  'Preserved as display metadata only (PRD/Phase 3 requirement). Never used to construct a storage path.';

create index reports_user_id_idx on public.reports (user_id);

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- A user may select, insert, and delete only rows where user_id
-- matches their own session (auth.uid()). There is no update policy
-- in this phase — nothing about an uploaded report is ever edited,
-- only created and deleted.
-- ---------------------------------------------------------------------
alter table public.reports enable row level security;

create policy "Users can view their own reports"
  on public.reports
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can insert their own reports"
  on public.reports
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can delete their own reports"
  on public.reports
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- No update policy: report rows are immutable after creation in
-- Phase 3. No delete-cascade-to-storage trigger either — deleting the
-- Storage object is handled explicitly by the application (see
-- src/lib/reports/actions.ts), in the same server action that deletes
-- this row, so a failure on either side is visible to the user rather
-- than silently orphaning one side.
