-- =====================================================================
-- Migration: 0007_typo_formatting_findings.sql
-- Phase 7 — Third Automated Review Check: Typo & Formatting
-- Inconsistency Detection
--
-- Adds PRD Section 18 category 7 ("typo and formatting inconsistency
-- detection" — deterministic/pattern-based, Low severity by default
-- per PRD Section 19) as an allowed `findings.category` value. Same
-- minimal-migration pattern as 0006_template_leftover_findings.sql —
-- no other schema change is needed.
-- =====================================================================

alter table public.findings
  drop constraint findings_category_check;

alter table public.findings
  add constraint findings_category_check
  check (
    category in (
      'cross_document_identity_consistency',
      'template_leftover_detection',
      'typo_and_formatting_inconsistency'
    )
  );

comment on table public.findings is
  'One row per finding produced by the review pipeline. Phase 5 added category = cross_document_identity_consistency; Phase 6 added template_leftover_detection; Phase 7 added typo_and_formatting_inconsistency. All three are confidence = deterministic. Remaining PRD Section 18 categories and any confidence = model_based (PRD Section 13, AI Review Workflow) rows are later phases, currently blocked on either Excel grid ingestion or an LLM provider decision (see docs/implementation-status.md). The category check constraint intentionally lists only what has shipped and is extended via migration as each new category ships.';
