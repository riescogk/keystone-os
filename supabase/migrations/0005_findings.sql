-- =====================================================================
-- Migration: 0005_findings.sql
-- Phase 5 — First Automated Review Check: Cross-Document Identity
-- Consistency (Deterministic)
--
-- Scope of this phase (see docs/architecture.md "Phase 5" for the
-- full rationale): PRD Section 14 (Deterministic Review Workflow),
-- Section 18 category 1 (cross-document identity consistency), and
-- the parts of Section 17 (Findings Lifecycle) that don't depend on
-- re-review (FR-5, not built yet): Open / Acknowledged / Dismissed.
--
-- This migration:
--   1. Adds a `review_status` lifecycle to `public.reports`, distinct
--      from `extraction_status` (Phase 4) — review can only begin
--      once extraction has produced text to check.
--   2. Creates `public.findings`, one row per finding produced by a
--      review, shaped identically for deterministic and (future)
--      model-based checks per PRD Section 14 point 4 — this phase
--      only ever writes confidence = 'deterministic' rows, but the
--      column allows 'model_based' since PRD Section 20 defines both
--      as a fixed, permanent two-value taxonomy, not something that
--      grows over time the way categories will.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Review lifecycle columns on public.reports
-- ---------------------------------------------------------------------
alter table public.reports
  add column review_status text not null default 'pending',
  add column review_completed_at timestamptz,
  add column review_version text;

alter table public.reports
  add constraint reports_review_status_check
  check (review_status in ('pending', 'processing', 'complete', 'failed'));

comment on column public.reports.review_status is
  'Lifecycle of the automated review pipeline (PRD Section 16), scoped in this phase to: pending -> processing -> complete | failed. Review can only start once extraction_status = ''completed''; a report whose extraction is ocr_required or failed has no text to review and review_status simply stays ''pending'' until a future phase (e.g. OCR) unblocks it. ''queued''/''cancelled'' from the full PRD lifecycle are not modeled yet — there is no manual review queue or cancel action in this phase.';
comment on column public.reports.review_completed_at is
  'Timestamp the review pipeline reached a terminal state (complete or failed). Null while pending/processing.';
comment on column public.reports.review_version is
  'Identifies which version of the review pipeline produced this report''s findings (see src/lib/review/types.ts REVIEW_VERSION), analogous to extraction_version.';

-- ---------------------------------------------------------------------
-- 2. public.findings
-- ---------------------------------------------------------------------
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  category text not null,
  severity text not null,
  confidence text not null,
  status text not null default 'open',
  description text not null,
  evidence text not null,
  location text,
  dismissed_reason text,
  acknowledged_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.findings
  add constraint findings_category_check
  check (category in ('cross_document_identity_consistency'));

alter table public.findings
  add constraint findings_severity_check
  check (severity in ('critical', 'moderate', 'low'));

alter table public.findings
  add constraint findings_confidence_check
  check (confidence in ('deterministic', 'model_based'));

alter table public.findings
  add constraint findings_status_check
  check (status in ('open', 'acknowledged', 'dismissed'));

alter table public.findings
  add constraint findings_dismissed_reason_required_check
  check (status <> 'dismissed' or dismissed_reason is not null);

comment on table public.findings is
  'One row per finding produced by the review pipeline. Phase 5 only produces category = cross_document_identity_consistency, confidence = deterministic rows; other PRD Section 18 categories and confidence = model_based (PRD Section 13, AI Review Workflow) are later phases. The category check constraint intentionally lists only what this phase implements and will need extending via migration as each new category ships (matching how extraction_status was scoped exactly to Phase 4, not preemptively).';
comment on column public.findings.user_id is
  'Denormalized from reports.user_id (same convention as report ownership) so RLS here does not need to join through reports.';
comment on column public.findings.location is
  'Human-readable page reference(s) where the finding was found, e.g. "Page 3, Page 47". Free text rather than a structured page-number array, matching this phase''s scope (no per-page structured storage exists yet — see extraction Phase 4 architecture note).';
comment on column public.findings.status is
  'PRD Section 17 Findings Lifecycle, scoped to this phase: open (default) -> acknowledged | dismissed. ''Carried Forward'' and ''Resolved'' only apply on re-review (FR-5), which is not built yet.';

create index findings_report_id_idx on public.findings (report_id);
create index findings_user_id_idx on public.findings (user_id);

-- ---------------------------------------------------------------------
-- 3. Row Level Security
--
-- Same ownership model as every other table: a user may act on a
-- finding only if user_id = auth.uid(). Insert is included because
-- the review pipeline (src/lib/review/runReview.ts) writes findings
-- using the report owner's own session — no service-role key, same
-- as the extraction pipeline (Phase 4).
-- ---------------------------------------------------------------------
alter table public.findings enable row level security;

create policy "Users can view their own findings"
  on public.findings
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can insert their own findings"
  on public.findings
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can update their own findings"
  on public.findings
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No delete policy: individual findings are never deleted directly by
-- a user in this phase. They are removed only as a side effect of
-- deleting the parent report (on delete cascade above).
