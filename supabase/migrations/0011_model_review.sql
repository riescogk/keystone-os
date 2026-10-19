-- =====================================================================
-- Migration: 0011_model_review.sql
-- Phase 11 — Model-Based Review Foundation (PRD Section 13, Section 18
-- category 4: narrative-to-data contradiction detection)
--
-- Two changes, both required and nothing more:
--
-- 1. A SEPARATE lifecycle for the model-based stage on public.reports.
--    It is deliberately independent of `review_status` (the
--    deterministic review, Phases 5–9): a model-provider outage,
--    timeout, or missing API key must never change, fail, or hide a
--    completed deterministic review. `review_status` keeps meaning
--    "the deterministic checks finished"; `model_review_status` says
--    what happened to the optional model-based layer on top of it.
--
-- 2. `narrative_data_contradiction` added to the findings.category
--    check constraint (same extend-via-migration pattern as 0006–0009).
--    `findings.confidence` already allows 'model_based' (0005, PRD
--    Section 20), so no change is needed there.
--
-- Existing reports receive model_review_status = 'not_run': the
-- model layer is never applied retroactively or automatically to
-- reports reviewed before this phase (no surprise cost, no surprise
-- data transfer). A user can run it on demand from the report page.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Model-review lifecycle on public.reports
-- ---------------------------------------------------------------------
alter table public.reports
  add column model_review_status text not null default 'not_run',
  add column model_review_error text,
  add column model_review_started_at timestamptz,
  add column model_review_completed_at timestamptz,
  add column model_review_version text;

alter table public.reports
  add constraint reports_model_review_status_check
  check (
    model_review_status in (
      'not_run', 'processing', 'complete', 'failed', 'unavailable'
    )
  );

-- Short machine-readable reason codes only. Raw provider error text is
-- never stored (it is logged server-side), so this column can never
-- hold document content or provider internals.
alter table public.reports
  add constraint reports_model_review_error_check
  check (
    model_review_error is null
    or model_review_error in (
      'not_configured', 'timeout', 'provider_error', 'refused',
      'incomplete', 'invalid_output', 'save_failed'
    )
  );

comment on column public.reports.model_review_status is
  'Lifecycle of the OPTIONAL model-based review stage (PRD Section 13), independent of review_status (deterministic review): not_run (default; never run) -> processing -> complete | failed | unavailable (no provider configured on the server). A non-complete value never affects review_status or any deterministic finding.';
comment on column public.reports.model_review_error is
  'Why the model-based stage did not complete: a short reason code only (see check constraint). Null unless model_review_status is failed or unavailable.';
comment on column public.reports.model_review_started_at is
  'When the current/last model-based run was claimed. Used to recover a run that was killed mid-flight (a stale processing state can be re-run after a timeout window).';
comment on column public.reports.model_review_completed_at is
  'When the model-based stage last reached complete. Null otherwise.';
comment on column public.reports.model_review_version is
  'Which check version and model produced the model-based findings, e.g. "narrative-contradiction-v1:gpt-5.4-mini-2026-03-17". Recorded so provider model drift is auditable (Company Bible Section 21).';

-- ---------------------------------------------------------------------
-- 2. findings.category: allow the new model-based category
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
      'narrative_data_contradiction'
    )
  );

comment on table public.findings is
  'One row per finding produced by the review pipeline. Deterministic categories (confidence = deterministic): cross_document_identity_consistency (Phase 5), template_leftover_detection (6), typo_and_formatting_inconsistency (7), missing_supporting_documentation (8, deterministic sub-case), internal_arithmetic_verification (9, PDF-text Income Approach sub-case). Model-based category (confidence = model_based, PRD Section 13): narrative_data_contradiction (Phase 11) — never presented with deterministic certainty. Remaining PRD Section 18 categories (5, and the grid-dependent parts of 3 and 6) are later phases. The category check constraint lists only what has shipped and is extended via migration as each new category ships.';
