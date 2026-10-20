import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildComparison, type ComparableFinding } from "@/lib/review/comparison/buildComparison";
import {
  describeSourceWorkbookCoverage,
  deterministicCheckLabels,
  type ExportSourceWorkbook,
} from "@/lib/export/findingsReportData";
import { findingProvenance, PROVENANCE_LABEL } from "@/lib/review/provenance";
import { FINDING_CATEGORY_LABEL } from "@/lib/review/types";

const WORKBOOK_FINDING: ComparableFinding = {
  id: "w1",
  category: "source_workbook_discrepancy",
  severity: "moderate",
  confidence: "deterministic",
  status: "open",
  description: 'The report\'s figure for "Net Operating Income" does not match the value in the source workbook.',
  evidence: 'Report: "$1,000,000" (page 9). Workbook a.xlsx, sheet "Pro Forma", cell C9: $1,234,567.',
  location: "Page 9",
  dismissedReason: null,
  carriedForwardFrom: null,
};

const OTHER_FINDING: ComparableFinding = {
  ...WORKBOOK_FINDING,
  id: "d1",
  category: "template_leftover_detection",
  description: "Unrelated deterministic finding",
  evidence: 'Found "XX.XX" on page 2.',
};

describe("comparison: source-workbook findings are compared only when both reviews ran the check", () => {
  it("labels a workbook finding 'not compared' when the earlier review had no workbook", () => {
    const result = buildComparison(
      { findings: [WORKBOOK_FINDING], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "complete" },
      { findings: [], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "none" }
    );
    assert.equal(result.labels.w1, "not_compared");
    assert.equal(result.counts.new, 0);
    assert.equal(result.counts.notCompared, 1);
  });

  it("never calls an earlier workbook finding 'resolved' when the new review did not check the workbook", () => {
    const earlierOnly = { ...WORKBOOK_FINDING, id: "p1" };
    const result = buildComparison(
      { findings: [], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "none" },
      { findings: [earlierOnly], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "complete" }
    );
    assert.equal(result.resolved.length, 0, "a missing cross-check must not read as a fixed one");
    assert.ok(result.notes.some((note) => /Source-workbook cross-checks were not compared/.test(note)));
  });

  it("reports an earlier workbook finding as resolved when both checks ran and it no longer appears", () => {
    const earlierOnly = { ...WORKBOOK_FINDING, id: "p1" };
    const result = buildComparison(
      { findings: [], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "complete" },
      { findings: [earlierOnly], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "complete" }
    );
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].id, "p1");
  });

  it("does not treat a failed workbook check as comparable", () => {
    const result = buildComparison(
      { findings: [WORKBOOK_FINDING], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "failed" },
      { findings: [], reviewVersion: "v5", modelReviewStatus: "not_run", sourceCheckStatus: "complete" }
    );
    assert.equal(result.labels.w1, "not_compared");
  });

  it("leaves reviews without any workbook exactly as they were (no new notes, same counts)", () => {
    const result = buildComparison(
      { findings: [OTHER_FINDING], reviewVersion: "v5", modelReviewStatus: "complete" },
      { findings: [], reviewVersion: "v5", modelReviewStatus: "complete" }
    );
    assert.equal(result.labels.d1, "new");
    assert.deepEqual(result.notes, []);
  });
});

describe("export: workbook coverage is stated honestly", () => {
  const base: ExportSourceWorkbook = {
    fileName: "25194AvignonApts.xlsm",
    containsMacros: true,
    checkStatus: "complete",
    checkError: null,
    linkedCount: 4,
    matchedCount: 3,
    flaggedCount: 1,
    ambiguousCount: 0,
  };

  it("says nothing when no workbook was attached", () => {
    assert.equal(describeSourceWorkbookCoverage(null), null);
    assert.equal(describeSourceWorkbookCoverage(undefined), null);
    assert.equal(describeSourceWorkbookCoverage({ ...base, checkStatus: "none" }), null);
  });

  it("states what was linked, matched, and differed, and that unlinked figures were not checked", () => {
    const text = describeSourceWorkbookCoverage(base)!;
    assert.match(text, /25194AvignonApts\.xlsm/);
    assert.match(text, /4 report figures linked/);
    assert.match(text, /3 matched within rounding, 1 differ/);
    assert.match(text, /not linked are not checked/);
    assert.match(text, /contains macros, which were not run/);
  });

  it("does not claim a comparison when nothing could be linked", () => {
    const text = describeSourceWorkbookCoverage({ ...base, linkedCount: 0, matchedCount: 0, flaggedCount: 0 })!;
    assert.match(text, /no report figures could be linked/i);
    assert.doesNotMatch(text, /matched within rounding/);
  });

  it("reports a failed check as failed, never as passed", () => {
    const text = describeSourceWorkbookCoverage({ ...base, checkStatus: "failed", checkError: "encrypted" })!;
    assert.match(text, /could not be completed/);
    assert.match(text, /password-protected or encrypted/);
    assert.doesNotMatch(text, /matched/);
  });

  it("states an in-progress check as in progress", () => {
    const text = describeSourceWorkbookCoverage({ ...base, checkStatus: "processing" })!;
    assert.match(text, /still in progress/);
  });

  it("keeps the source-workbook category OUT of the always-run deterministic check list", () => {
    const labels = deterministicCheckLabels();
    assert.equal(labels.includes(FINDING_CATEGORY_LABEL.source_workbook_discrepancy), false);
    assert.equal(labels.includes(FINDING_CATEGORY_LABEL.narrative_data_contradiction), false);
    assert.ok(labels.includes(FINDING_CATEGORY_LABEL.template_leftover_detection));
  });
});

describe("provenance: where a finding's evidence came from", () => {
  it("labels workbook-backed, model-based, and report-only findings distinctly", () => {
    assert.equal(findingProvenance("source_workbook_discrepancy", "deterministic"), "source_workbook");
    assert.equal(findingProvenance("narrative_data_contradiction", "model_based"), "model_narrative");
    assert.equal(findingProvenance("template_leftover_detection", "deterministic"), "report_review");
    assert.equal(PROVENANCE_LABEL.source_workbook, "Excel-supported cross-check");
  });
});

describe("migration 0013: structural checks (executed against a real database by source-workbook-db.test.ts)", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "0013_source_workbook.sql"),
    "utf8"
  );

  it("creates the owner-scoped table with row level security enabled", () => {
    assert.match(sql, /create table public\.report_source_workbooks/);
    assert.match(sql, /alter table public\.report_source_workbooks enable row level security/);
  });

  it("adds a separate private workbook bucket and leaves the reports bucket alone", () => {
    assert.match(sql, /'review-workbooks'/);
    assert.doesNotMatch(sql, /update storage\.buckets/);
    assert.doesNotMatch(sql, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+values \(\s+'reports'/);
  });

  it("extends the account-deletion guard to the workbook bucket", () => {
    assert.match(sql, /bucket_id in \('reports', 'review-workbooks'\)/);
  });

  it("adds the new category, and never edits migrations 0001-0012", () => {
    assert.match(sql, /'source_workbook_discrepancy'/);
    assert.doesNotMatch(sql, /alter table public\.reports\s+add column review_status/);
  });
});
