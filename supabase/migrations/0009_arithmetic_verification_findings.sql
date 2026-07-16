-- =====================================================================
-- Migration: 0009_arithmetic_verification_findings.sql
-- Phase 9 — Fifth Automated Review Check: Internal Arithmetic
-- Verification (PDF-text-only sub-case)
--
-- Adds PRD Section 18 category 3 ("internal arithmetic verification")
-- as an allowed `findings.category` value, scoped to the sub-case the
-- PRD itself sanctions without Excel: "recalculation of extractable
-- numeric totals ... wherever the underlying figures are extractable
-- from the document or supporting Excel file." This phase implements
-- the "extractable from the document" half only — no Excel file is
-- required or used, preserving the single-PDF upload workflow. See
-- docs/architecture.md Phase 9 "Scope decision" for the full
-- reasoning, including why grid-adjustment-total and reconciliation
-- math are NOT attempted here.
--
-- Same minimal-migration pattern as 0006/0007/0008 — no other schema
-- change is needed.
-- =====================================================================

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
      'internal_arithmetic_verification'
    )
  );

comment on table public.findings is
  'One row per finding produced by the review pipeline. Phase 5 added category = cross_document_identity_consistency; Phase 6 added template_leftover_detection; Phase 7 added typo_and_formatting_inconsistency; Phase 8 added missing_supporting_documentation (deterministic sub-case only); Phase 9 added internal_arithmetic_verification (PDF-text-only sub-case only — recalculates the Income Approach chain: PGI minus vacancy/collection loss = EGI, EGI minus operating expenses = NOI, NOI divided by cap rate = indicated value; sales-comparison grid adjustment totals and reconciliation weighting are not attempted, since those require reliable table/grid parsing that flat PDF text extraction cannot provide). All five categories so far are confidence = deterministic. Remaining PRD Section 18 categories (4, 5, and the inferential half of 6) are later phases, currently blocked on an LLM provider decision (see docs/implementation-status.md). The category check constraint intentionally lists only what has shipped and is extended via migration as each new category ships.';
