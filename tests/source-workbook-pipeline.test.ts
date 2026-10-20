import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  runSourceWorkbookCheck,
  type SourceCheckStore,
  type SourceWorkbookRow,
} from "@/lib/review/source/runSourceCheck";
import { MAX_WORKBOOK_BYTES } from "@/lib/review/source/workbookFile";
import { SourceWorkbookError } from "@/lib/review/source/errors";
import type { PageText } from "@/lib/review/types";

/**
 * The review pipeline's failure rules for the optional workbook (Milestone 14),
 * exercised against an in-memory store. The guarantee under test: NOTHING
 * about a workbook can throw out of the check, and a failed check is recorded
 * as failed, never as passed.
 */

const SOURCE_MODEL = new Uint8Array(
  readFileSync(path.join(process.cwd(), "tests", "fixtures", "source-model.xlsx"))
);
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const FLAGGED_PAGES: PageText[] = [{ pageNumber: 3, text: "Subject_Value: $15,000,000" }];

type Behavior = { bytes: Uint8Array } | { downloadError: unknown } | { oversize: true };

function fakeStore(row: SourceWorkbookRow | null, behavior: Behavior, loadError = false) {
  const updates: Record<string, string | number | boolean | null>[] = [];
  let current = row ? { ...row } : null;

  const store: SourceCheckStore = {
    async loadRow() {
      if (loadError) throw new Error("database unavailable");
      return current ? { ...current } : null;
    },
    async record(_reportId, fields) {
      updates.push(fields);
      if (current && typeof fields.check_status === "string") {
        current = { ...current, check_status: fields.check_status };
      }
    },
    async download() {
      if ("downloadError" in behavior) throw behavior.downloadError;
      if ("oversize" in behavior) return new Blob([new Uint8Array(MAX_WORKBOOK_BYTES + 1)]);
      return new Blob([new Uint8Array(behavior.bytes)]);
    },
  };

  return { store, updates };
}

// The bytes used by most cases are an .xlsx, so the row must say so: the
// package's content type is checked against the stored format.
const PENDING_XLSM: SourceWorkbookRow = {
  original_filename: "source-model.xlsx",
  storage_path: "u/r.xlsx",
  workbook_format: "xlsx",
  check_status: "pending",
};

describe("source-workbook check: the report review is never put at risk", () => {
  it("reports 'none' when no workbook was attached, without writing anything", async () => {
    const { store, updates } = fakeStore(null, { bytes: SOURCE_MODEL });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "none");
    assert.deepEqual(outcome.drafts, []);
    assert.equal(updates.length, 0);
  });

  it("treats a database error while looking for the workbook as 'none', never a throw", async () => {
    const { store } = fakeStore(PENDING_XLSM, { bytes: SOURCE_MODEL }, true);
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "none");
  });

  it("completes a good workbook and returns its traceable findings", async () => {
    const { store, updates } = fakeStore(PENDING_XLSM, { bytes: SOURCE_MODEL });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.drafts.length, 1);
    assert.equal(outcome.drafts[0].category, "source_workbook_discrepancy");
    const final = updates[updates.length - 1];
    assert.equal(final.check_status, "complete");
    assert.equal(final.flagged_figure_count, 1);
    assert.equal(final.check_error, null);
    assert.equal(final.check_version, "source-workbook-v2");
  });

  it("records a corrupt workbook as failed and returns normally", async () => {
    const { store, updates } = fakeStore(PENDING_XLSM, {
      bytes: new TextEncoder().encode("this is not a spreadsheet"),
    });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "unreadable");
    assert.deepEqual(outcome.drafts, []);
    const final = updates[updates.length - 1];
    assert.equal(final.check_status, "failed");
    assert.equal(final.check_error, "unreadable");
  });

  it("records a storage download failure as failed", async () => {
    const { store, updates } = fakeStore(PENDING_XLSM, {
      downloadError: new SourceWorkbookError("download_failed", "gone"),
    });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.reason, "download_failed");
    assert.equal(updates[updates.length - 1].check_error, "download_failed");
  });

  it("refuses an oversized stored file before reading it", async () => {
    const { store } = fakeStore(PENDING_XLSM, { oversize: true });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.reason, "too_large");
  });

  it("maps an unexpected error to 'internal' and still does not throw", async () => {
    const { store, updates } = fakeStore(PENDING_XLSM, { downloadError: new TypeError("boom") });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "internal");
    assert.equal(updates[updates.length - 1].check_error, "internal");
  });

  it("survives every kind of hostile byte stream without throwing", async () => {
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      new Uint8Array(4096).map((_, i) => (i * 73) & 0xff),
      SOURCE_MODEL.slice(0, Math.floor(SOURCE_MODEL.length / 2)),
      SOURCE_MODEL.map((byte, i) => (i % 97 === 0 ? byte ^ 0xff : byte)),
    ];
    for (const bytes of inputs) {
      const { store } = fakeStore(PENDING_XLSM, { bytes });
      const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
      assert.ok(
        outcome.status === "failed" || outcome.status === "complete",
        `unexpected status ${outcome.status}`
      );
      assert.ok(Array.isArray(outcome.drafts));
    }
  });

  it("never re-runs a finished check", async () => {
    const complete: SourceWorkbookRow = { ...PENDING_XLSM, check_status: "complete" };
    const { store, updates } = fakeStore(complete, { bytes: SOURCE_MODEL });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "complete");
    assert.deepEqual(outcome.drafts, []);
    assert.equal(updates.length, 0);
  });

  it("records an interrupted (stale 'processing') check as failed, not as still running", async () => {
    const stale: SourceWorkbookRow = { ...PENDING_XLSM, check_status: "processing" };
    const { store, updates } = fakeStore(stale, { bytes: SOURCE_MODEL });
    const outcome = await runSourceWorkbookCheck(store, REPORT_ID, FLAGGED_PAGES);
    assert.equal(outcome.status, "failed");
    assert.equal(updates[0].check_status, "failed");
  });
});
