-- =====================================================================
-- Migration: 0006_template_leftover_findings.sql
-- Phase 6 — Second Automated Review Check: Template Leftover Detection
--
-- Adds PRD Section 18 category 2 ("template leftover detection" —
-- deterministic, pattern-based) as an allowed `findings.category`
-- value. This is the exact "extend via migration as each new category
-- ships" step anticipated in 0005_findings.sql's comments — no other
-- schema change is needed, since `findings` was already shaped
-- generically enough (category/severity/confidence/description/
-- evidence/location) to hold this category's rows without
-- modification.
-- =====================================================================

alter table public.findings
  drop constraint findings_category_check;

alter table public.findings
  add constraint findings_category_check
  check (
    category in (
      'cross_document_identity_consistency',
      'template_leftover_detection'
    )
  );

comment on table public.findings is
  'One row per finding produced by the review pipeline. Phase 5 added category = cross_document_identity_consistency; Phase 6 added template_leftover_detection. Both are confidence = deterministic. Remaining PRD Section 18 categories and any confidence = model_based (PRD Section 13, AI Review Workflow) rows are later phases. The category check constraint intentionally lists only what has shipped and is extended via migration as each new category ships (see this migration for the pattern to repeat).';
