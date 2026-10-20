-- =====================================================================
-- Migration: 0013_source_workbook.sql
-- Milestone 14 — Optional Excel source-workbook cross-check for Review
--
-- The report PDF remains the primary, required review input. A reviewer
-- MAY also attach the Excel workbook (.xlsx / .xlsm) the report was built
-- from. That workbook is supporting evidence: it lets Keystone check
-- report figures against source-model values where the two can be linked
-- unambiguously. It never blocks, changes, or replaces a report review.
--
-- This migration adds, and changes nothing else:
--
--   1. public.report_source_workbooks — at most ONE workbook per report,
--      its storage location, its own check lifecycle, and summary counts.
--      Owner-scoped RLS, and an immutability trigger so the stored evidence
--      (file identity, format, macro flag, link count) cannot be rewritten
--      after upload. Only the check-status columns are ever updated.
--
--   2. A separate private Storage bucket, "review-workbooks", with its own
--      owner-folder policies. The existing "reports" bucket and its policies
--      are NOT modified.
--
--   3. public.delete_own_account() is REPLACED (same signature, same grants)
--      so the "no stored files left behind" safety net also covers the
--      workbook bucket. Account deletion can never orphan a workbook.
--
--   4. findings.category gains 'source_workbook_discrepancy'.
--
--   5. findings.source_reference (jsonb): the workbook location each
--      source-workbook finding was linked through (sheet, cell, defined name,
--      table, formula, value), so the evidence is traceable.
--
-- Migrations 0001–0012 are NOT edited.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. public.report_source_workbooks
-- ---------------------------------------------------------------------
create table public.report_source_workbooks (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null unique references public.reports (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  original_filename text not null,
  storage_path text not null unique,
  file_size_bytes bigint not null,
  workbook_format text not null,
  -- Recorded at upload from the package's directory listing. The VBA
  -- project is never read or executed; this flag is informational only.
  contains_macros boolean not null default false,
  external_link_count integer not null default 0,
  -- Check lifecycle (independent of reports.review_status).
  check_status text not null default 'pending',
  check_error text,
  check_version text,
  checked_at timestamptz,
  sheet_count integer,
  linked_figure_count integer,
  matched_figure_count integer,
  flagged_figure_count integer,
  ambiguous_count integer,
  created_at timestamptz not null default now(),

  constraint report_source_workbooks_format_check
    check (workbook_format in ('xlsx', 'xlsm')),
  constraint report_source_workbooks_status_check
    check (check_status in ('pending', 'processing', 'complete', 'failed')),
  constraint report_source_workbooks_error_check
    check (
      check_error is null
      or check_error in (
        'unreadable', 'encrypted', 'unsupported', 'too_large',
        'format_mismatch', 'download_failed', 'internal'
      )
    ),
  constraint report_source_workbooks_size_check
    check (file_size_bytes > 0),
  constraint report_source_workbooks_external_links_check
    check (external_link_count >= 0),
  constraint report_source_workbooks_counts_check
    check (
      (sheet_count is null or sheet_count >= 0)
      and (linked_figure_count is null or linked_figure_count >= 0)
      and (matched_figure_count is null or matched_figure_count >= 0)
      and (flagged_figure_count is null or flagged_figure_count >= 0)
      and (ambiguous_count is null or ambiguous_count >= 0)
    )
);

comment on table public.report_source_workbooks is
  'Optional supporting Excel workbook for one report (Milestone 14). Immutable evidence (file identity, format, macro flag, link count) plus a check lifecycle the review pipeline updates. Deleting the report or the account removes this row (cascade) and, in the application, its stored file.';
comment on column public.report_source_workbooks.storage_path is
  'Server-generated path in the private review-workbooks bucket: {user_id}/{report_id}.{xlsx|xlsm}. Never derived from the original filename.';
comment on column public.report_source_workbooks.original_filename is
  'Display metadata only. Never used to build a storage path.';
comment on column public.report_source_workbooks.contains_macros is
  'True if the package contains a VBA project. Keystone never reads, executes, or evaluates macros; the flag is recorded so the reviewer knows the file had them.';
comment on column public.report_source_workbooks.check_status is
  'none is represented by the absence of a row. pending -> processing -> complete | failed. A failed check never changes reports.review_status.';
comment on column public.report_source_workbooks.check_error is
  'Short reason code for a failed check (see src/lib/review/source/errors.ts). Never raw error text or workbook content.';
comment on column public.report_source_workbooks.linked_figure_count is
  'Report figures linked to a workbook cell by an explicit, unambiguous correspondence. Figures not linked are not checked, and the UI says so.';

create index report_source_workbooks_user_id_idx
  on public.report_source_workbooks (user_id);

-- ---------------------------------------------------------------------
-- 2. Row Level Security
--
-- Owner-scoped throughout. The insert and update checks also require that
-- the referenced report belongs to the same user, so a workbook can never
-- be attached to, or re-pointed at, someone else's report even by a client
-- that constructs the request itself.
-- ---------------------------------------------------------------------
alter table public.report_source_workbooks enable row level security;

create policy "Users can view their own source workbooks"
  on public.report_source_workbooks
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can attach a source workbook to their own report"
  on public.report_source_workbooks
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.reports r
      where r.id = report_id
        and r.user_id = (select auth.uid())
    )
  );

create policy "Users can update their own source workbook status"
  on public.report_source_workbooks
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.reports r
      where r.id = report_id
        and r.user_id = (select auth.uid())
    )
  );

create policy "Users can delete their own source workbooks"
  on public.report_source_workbooks
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 3. Immutability of the stored evidence
--
-- Only the check lifecycle and its summary counts may change after upload.
-- Anything that identifies or describes the file is fixed. (Cascade deletes
-- are not UPDATEs and are unaffected.)
-- ---------------------------------------------------------------------
create function public.report_source_workbooks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.report_id is distinct from old.report_id
     or new.user_id is distinct from old.user_id
     or new.original_filename is distinct from old.original_filename
     or new.storage_path is distinct from old.storage_path
     or new.file_size_bytes is distinct from old.file_size_bytes
     or new.workbook_format is distinct from old.workbook_format
     or new.contains_macros is distinct from old.contains_macros
     or new.external_link_count is distinct from old.external_link_count
     or new.created_at is distinct from old.created_at
  then
    raise exception 'Source workbook evidence is immutable after upload'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger report_source_workbooks_guard
  before update on public.report_source_workbooks
  for each row
  execute function public.report_source_workbooks_guard();

-- ---------------------------------------------------------------------
-- 4. Private Storage bucket for workbooks
--
-- Separate from "reports" so its size and MIME rules can differ and the
-- reports bucket stays exactly as it was. The MIME list must match
-- WORKBOOK_MIME_BY_FORMAT in src/lib/review/source/workbookFile.ts.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'review-workbooks',
  'review-workbooks',
  false,                        -- private: no public URL access, ever
  20971520,                     -- 20 MB, matches MAX_WORKBOOK_BYTES
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Users can read their own review workbook objects"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'review-workbooks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can upload their own review workbook objects"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'review-workbooks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users can delete their own review workbook objects"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'review-workbooks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------
-- 5. delete_own_account(): also refuse while workbook files remain
--
-- Same signature, same owner-only behavior, and the same grants as
-- migration 0010. The only change is the storage check, which now covers
-- both buckets.
-- ---------------------------------------------------------------------
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

  -- Safety net: never delete the account while stored files remain in any
  -- bucket the application writes to.
  if exists (
    select 1
    from storage.objects
    where bucket_id in ('reports', 'review-workbooks')
      and (storage.foldername(name))[1] = caller_id::text
  ) then
    raise exception 'Stored report files still exist; remove them before deleting the account'
      using errcode = 'P0001';
  end if;

  -- Cascades remove public.users, public.reports, public.findings and
  -- public.report_source_workbooks.
  delete from auth.users where id = caller_id;
end;
$$;

comment on function public.delete_own_account() is
  'Permanently deletes the calling user''s auth account (auth.uid()); public.users, reports, findings and report_source_workbooks follow via ON DELETE CASCADE. Takes no arguments by design. Refuses to run while any of the caller''s files remain in the reports or review-workbooks buckets. See docs/security.md Phase 10 and Milestone 14.';

revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;

-- ---------------------------------------------------------------------
-- 6. findings.category: allow the source-workbook category
-- ---------------------------------------------------------------------
alter table public.findings
  drop constraint findings_category_check;

alter table public.findings
  add constraint findings_category_check
  check (
    category in (
      'cross_document_identity_consistency',
      'template_leftover_detection',
      'typo_and_formatting_inconsistency',
      'missing_supporting_documentation',
      'internal_arithmetic_verification',
      'narrative_data_contradiction',
      'source_workbook_discrepancy'
    )
  );

-- ---------------------------------------------------------------------
-- 7. findings.source_reference: where a workbook finding's evidence lives
-- ---------------------------------------------------------------------
alter table public.findings
  add column source_reference jsonb;

alter table public.findings
  add constraint findings_source_reference_object_check
  check (source_reference is null or jsonb_typeof(source_reference) = 'object');

-- A source-workbook finding always says where in the workbook it came from.
-- Most are deterministic; a bounded model-assisted contextual investigation may
-- also create model_based findings, but only with the same traceable source reference.
alter table public.findings
  add constraint findings_source_workbook_integrity_check
  check (
    category <> 'source_workbook_discrepancy'
    or (source_reference is not null and confidence in ('deterministic', 'model_based'))
  );

comment on column public.findings.source_reference is
  'Milestone 14: for category source_workbook_discrepancy, the workbook location the finding was linked through (workbook file name, sheet, cell, defined name, label, table, formula, displayed value, and the linking method). Null for every other finding. Written once at insert and never edited.';
