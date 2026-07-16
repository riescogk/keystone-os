-- =====================================================================
-- Migration: 0008_missing_documentation_findings.sql
-- Phase 8 — Fourth Automated Review Check: Missing Supporting
-- Documentation References (deterministic sub-case)
--
-- Adds the deterministic half of PRD Section 18 category 6 ("missing
-- supporting documentation references") as an allowed
-- `findings.category` value: an in-text reference to a named
-- Addendum/Exhibit/Appendix/Attachment that never appears elsewhere
-- in the document as its own section. The category's other half
-- ("a referenced comp not appearing in the grid") is explicitly
-- model-based/inferential per the PRD and is not implemented here —
-- see docs/architecture.md Phase 8 "Scope decision".
--
-- Same minimal-migration pattern as 0006 and 0007 — no other schema
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
      'missing_supporting_documentation'
    )
  );

comment on table public.findings is
  'One row per finding produced by the review pipeline. Phase 5 added category = cross_document_identity_consistency; Phase 6 added template_leftover_detection; Phase 7 added typo_and_formatting_inconsistency; Phase 8 added missing_supporting_documentation (the deterministic sub-case of PRD Section 18 category 6 only — referenced-but-absent addenda/exhibits/appendices/attachments; the inferential sub-case, comps not appearing in a grid, is not implemented and needs Excel ingestion and/or model-based judgment). All four categories so far are confidence = deterministic. Remaining PRD Section 18 categories and any confidence = model_based rows are later phases, currently blocked on either Excel grid ingestion or an LLM provider decision (see docs/implementation-status.md). The category check constraint intentionally lists only what has shipped and is extended via migration as each new category ships.';
