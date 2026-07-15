-- =====================================================================
-- Migration: 0004_report_extraction.sql
-- Phase 4 — PDF Text Extraction
--
-- Adds the columns needed to record the outcome of the text-extraction
-- pipeline against an already-uploaded report. This phase ONLY extracts
-- text — it does not review, analyze, or generate findings. See
-- docs/architecture.md "Phase 4" for the full design rationale.
--
-- This migration also adds the first UPDATE policy on public.reports.
-- Phase 3 deliberately had none ("nothing about a report row is ever
-- edited, only created and deleted") because nothing needed to write
-- to an existing row yet. Phase 4 introduces the first legitimate
-- need: recording extraction results against the row after upload.
-- This does NOT weaken the Manifesto's "uploaded report is never
-- modified" guarantee (Manifesto 0.4.5, PRD Section 15) — the
-- uploaded PDF file in Storage is still never touched or overwritten;
-- only new metadata *about* that immutable file is attached to its
-- row. The policy is scoped identically to every other policy on this
-- table (owner-only, via auth.uid()).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.reports
  add column extraction_status text not null default 'pending',
  add column extracted_text text,
  add column page_count integer,
  add column extraction_completed_at timestamptz,
  add column extraction_version text;

alter table public.reports
  add constraint reports_extraction_status_check
  check (
    extraction_status in ('pending', 'processing', 'completed', 'ocr_required', 'failed')
  );

comment on column public.reports.extraction_status is
  'Lifecycle of the text-extraction pipeline for this report: pending (just uploaded, not yet picked up) -> processing -> completed | ocr_required | failed. This is independent of, and precedes, the future Review Lifecycle (PRD Section 16), which does not exist yet.';
comment on column public.reports.extracted_text is
  'Full extracted text, in page order, with page boundaries marked by a "--- Page N ---" delimiter line. Null until extraction_status = ''completed''. Never populated when extraction_status = ''ocr_required'' (no selectable text existed to extract).';
comment on column public.reports.page_count is
  'Total page count read from the PDF document itself, independent of whether any page had selectable text. Populated for ''completed'' and ''ocr_required'' outcomes; null for ''pending''/''processing''/''failed''.';
comment on column public.reports.extraction_completed_at is
  'Timestamp the extraction pipeline finished (in any terminal state: completed, ocr_required, or failed). Null while pending/processing.';
comment on column public.reports.extraction_version is
  'Identifies which version of the extraction pipeline produced this result (see src/lib/extraction/types.ts EXTRACTION_VERSION), so a future pipeline change can identify and selectively re-process reports extracted by an older version.';

-- ---------------------------------------------------------------------
-- 2. Row Level Security — add UPDATE
--
-- Scoped identically to the existing select/insert/delete policies:
-- a user may update only rows where user_id = auth.uid(). This is the
-- same ownership check, just extended to one more operation; it does
-- not change who can act on a report, only what they can do to a row
-- they already fully control.
-- ---------------------------------------------------------------------
create policy "Users can update their own reports"
  on public.reports
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
