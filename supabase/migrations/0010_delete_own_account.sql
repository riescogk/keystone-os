-- =====================================================================
-- Migration: 0010_delete_own_account.sql
-- Phase 10 — Account & Data Deletion (PRD Section 8.9, FR-7)
--
-- Adds ONE function, public.delete_own_account(), which permanently
-- deletes the calling user's Supabase Auth account. Everything else
-- the user owns is removed by the foreign-key cascades that already
-- exist:
--
--   auth.users
--     └─ public.users        (0001: on delete cascade)
--          └─ public.reports (0002: on delete cascade)
--               └─ public.findings (0005: on delete cascade, also
--                                   cascades directly from users)
--
-- WHY A DATABASE FUNCTION INSTEAD OF THE ADMIN API
-- Deleting an auth.users row normally requires the service-role key
-- (supabase.auth.admin.deleteUser). Keystone has deliberately never
-- put that key in application code (docs/security.md). This function
-- gives the same capability with a far smaller blast radius:
--   * It takes NO arguments. The only account it can ever delete is
--     auth.uid() — the caller's own, taken from the verified JWT. There
--     is no user-id parameter to tamper with, so "delete an arbitrary
--     user" is not expressible.
--   * It is executable only by the `authenticated` role.
--   * No service-role credential exists anywhere in the app.
--
-- STORAGE FILES
-- Deleting rows from storage.objects with SQL does NOT delete the
-- underlying files, so file removal must go through the Storage API
-- (done by the server action, under the user's own session and the
-- existing "Users can delete their own report objects" RLS policy,
-- BEFORE this function is called). As a hard safety net, this function
-- refuses to delete the account while ANY object under the user's
-- storage folder still exists — so an account can never be removed
-- while leaving orphaned, now-unreachable files behind.
-- =====================================================================

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  -- Safety net: never delete the account while stored files remain.
  if exists (
    select 1
    from storage.objects
    where bucket_id = 'reports'
      and (storage.foldername(name))[1] = caller_id::text
  ) then
    raise exception 'Stored report files still exist; remove them before deleting the account'
      using errcode = 'P0001';
  end if;

  -- Cascades remove public.users, public.reports, public.findings.
  delete from auth.users where id = caller_id;
end;
$$;

comment on function public.delete_own_account() is
  'Permanently deletes the calling user''s auth account (auth.uid()); public.users, reports and findings follow via ON DELETE CASCADE. Takes no arguments by design. Refuses to run while any of the caller''s files remain in the reports bucket. See docs/security.md Phase 10.';

-- Lock down execution: nobody by default, then only signed-in users.
revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;
