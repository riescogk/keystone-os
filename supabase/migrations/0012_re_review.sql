-- =====================================================================
-- Migration: 0012_re_review.sql
-- Phase 13 — Re-Review on a Revised Draft (PRD FR-5, Sections 8.5/8.7,
-- Report Lifecycle Section 15, Review Lifecycle Section 16, Findings
-- Lifecycle Section 17)
--
-- The PRD fixes the behavior ("a re-review on a revised draft is a NEW
-- review, linked to the prior review ... never an in-place mutation")
-- but not the mechanism. This migration defines it with two columns:
--
--   reports.previous_report_id
--       The report this upload is a revised draft of. Each upload is
--       already "exactly one uploaded report version" with its own
--       review (Section 16), so linking report rows IS linking reviews.
--       Set once, at upload, and never edited afterwards.
--
--   findings.carried_forward_from
--       On a re-review, the finding in the PRIOR review that this
--       finding continues (PRD Section 17 "Carried Forward"). Written
--       at insert time by the review pipeline; never edited.
--
-- DERIVED, deliberately NOT stored (so a prior review is never mutated):
--   * Superseded (Section 15): a report is superseded when another
--     report has previous_report_id = its id.
--   * Resolved (Section 17): a prior-review finding that no finding in
--     the re-review carries forward from.
--   * New: a re-review finding with carried_forward_from IS NULL.
--
-- "Carried Forward" is a link rather than a new findings.status value
-- because the PRD says a carried-forward finding RETAINS its prior
-- acknowledged/dismissed status; one status column cannot hold both
-- "carried forward" and "dismissed". findings.status is unchanged.
--
-- No RLS policy is added or changed: both columns live on rows already
-- protected by the existing owner-scoped policies.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. reports.previous_report_id
-- ---------------------------------------------------------------------
alter table public.reports
  add column previous_report_id uuid
    references public.reports (id) on delete set null;

alter table public.reports
  add constraint reports_previous_report_not_self_check
  check (previous_report_id is null or previous_report_id <> id);

-- A report can be revised at most once: revisions form a straight chain
-- (v1 -> v2 -> v3), never a tree. This also makes "double submit" and
-- "two tabs" races safe — the second insert fails on this index.
create unique index reports_previous_report_id_key
  on public.reports (previous_report_id)
  where previous_report_id is not null;

comment on column public.reports.previous_report_id is
  'The report this upload is a revised draft of (PRD FR-5). Set once at upload from the "Upload a revised draft" action; immutable afterwards except that deleting the earlier report sets it to NULL (comparison is then simply no longer available). Unique: a report has at most one revision. A report is "Superseded" (PRD 15) iff some other report points at it.';

-- Owner + immutability guard.
--
-- * INSERT: the referenced report must belong to the same user. The
--   existing RLS insert policy only checks the new row's own user_id,
--   which on its own would let a client attach a revision link to
--   someone else's report id.
-- * UPDATE: the link may not be changed to a different report (that
--   could create cycles or re-point history). Setting it to NULL IS
--   allowed — that is exactly what the ON DELETE SET NULL foreign key
--   does when the earlier report is deleted, and it must not be
--   blocked or deleting a report (or an account, Phase 10) would fail.
create function public.reports_enforce_revision_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.previous_report_id is not null
       and not exists (
         select 1
         from public.reports p
         where p.id = new.previous_report_id
           and p.user_id = new.user_id
       ) then
      raise exception 'The report being revised was not found'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE of previous_report_id
  if new.previous_report_id is not null
     and new.previous_report_id is distinct from old.previous_report_id then
    raise exception 'previous_report_id cannot be changed after upload'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger reports_enforce_revision_link
  before insert or update of previous_report_id on public.reports
  for each row
  execute function public.reports_enforce_revision_link();

-- ---------------------------------------------------------------------
-- 2. findings.carried_forward_from
-- ---------------------------------------------------------------------
alter table public.findings
  add column carried_forward_from uuid
    references public.findings (id) on delete set null;

alter table public.findings
  add constraint findings_carried_forward_not_self_check
  check (carried_forward_from is null or carried_forward_from <> id);

create index findings_carried_forward_from_idx
  on public.findings (carried_forward_from)
  where carried_forward_from is not null;

comment on column public.findings.carried_forward_from is
  'PRD Section 17 "Carried Forward": on a re-review, the finding in the previous review that this finding continues. NULL means the finding is new in this review. When set and the underlying evidence is unchanged, the prior acknowledged/dismissed status (and reason) is copied onto this finding at insert time so the user does not re-triage it; when the evidence changed, the finding is linked but starts Open again. "Resolved" is derived (a previous-review finding nothing carries forward from) and never stored.';
