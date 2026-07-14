-- =====================================================================
-- Migration: 0003_storage.sql
-- Phase 3 — Secure Report Upload
--
-- Creates a PRIVATE Storage bucket ("reports") and locks it down with
-- RLS policies on storage.objects, mirroring the ownership model used
-- for public.reports: a user may only read/write/delete objects whose
-- path begins with their own auth.uid().
--
-- Path convention (enforced by the application, not the database):
--   {user_id}/{report_id}.pdf
-- The first path segment is what these policies check via
-- storage.foldername(name), so this convention is load-bearing —
-- do not change it without updating these policies.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Bucket
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reports',
  'reports',
  false,                       -- private: no public URL access, ever
  26214400,                    -- 25 MB, matches app-level MAX_FILE_SIZE_BYTES
  array['application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 2. Storage RLS policies
--
-- storage.objects already has RLS enabled by default in Supabase.
-- These policies scope every operation to the "reports" bucket and to
-- objects whose top-level folder equals the caller's own auth.uid().
-- ---------------------------------------------------------------------

create policy "Users can read their own report objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can upload their own report objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'reports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete their own report objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'reports'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- No update policy: uploaded files are never modified in place. A
-- "revised draft" (PRD Section 15, future phase) is a new upload, new
-- report row, new storage object — never an overwrite of an existing
-- one, which keeps the audit trail intact.
