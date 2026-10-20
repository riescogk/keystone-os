import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  finalizeUpload,
  type FinalizeResult,
} from "@/lib/reports/finalizeUpload";
import { uploadReportDirect } from "@/lib/reports/directUpload";
import {
  buildUploadPaths,
  parseOwnedReportPath,
  parseOwnedWorkbookPath,
} from "@/lib/reports/uploadPaths";
import { MAX_FILE_SIZE_BYTES } from "@/lib/reports/validation";
import {
  MAX_WORKBOOK_BYTES,
  WORKBOOK_MIME_BY_FORMAT,
} from "@/lib/review/source/workbookFile";

/**
 * Review upload hotfix: direct browser -> private Storage upload, then a
 * metadata-only finalize. These tests run the REAL browser module
 * (uploadReportDirect) and the REAL authoritative finalize logic
 * (finalizeUpload, including checkWorkbookUpload) against an in-memory
 * Supabase stand-in that enforces the same rules the migrations do: storage
 * writes/reads/removes only inside `{auth.uid()}/`, unique constraints on the
 * reports tables, and owner-scoped row visibility.
 */

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const PRIOR_ID = "99999999-9999-4999-8999-999999999999";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures");
const fixture = (name: string) =>
  new Uint8Array(readFileSync(path.join(FIXTURES, name)));

// ---------------------------------------------------------------------
// In-memory Supabase stand-in
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;

class Backend {
  objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string | undefined }
  >();
  tables: Record<string, Row[]> = { reports: [], report_source_workbooks: [] };
  failInsert = new Set<string>();
  /** Test seam: lets a test pause one client at a named storage/DB step. */
  hook?: (label: string, event: string) => Promise<void>;
  failUpload = new Set<string>(); // bucket names whose uploads fail
  removed: string[] = [];

  key(bucket: string, p: string) {
    return `${bucket}/${p}`;
  }
  has(bucket: string, p: string) {
    return this.objects.has(this.key(bucket, p));
  }
  seedReport(row: Row) {
    this.tables.reports.push({
      extraction_status: "pending",
      review_status: "pending",
      previous_report_id: null,
      ...row,
    });
  }
}

const ownsFolder = (p: string, userId: string | null) =>
  userId !== null && p.split("/").length >= 2 && p.split("/")[0] === userId;

function clientFor(
  backend: Backend,
  userId: string | null,
  label = "client"
): SupabaseClient {
  const storage = {
    from(bucket: string) {
      return {
        async upload(
          p: string,
          body: Blob | Uint8Array,
          opts?: { contentType?: string; upsert?: boolean }
        ) {
          if (backend.failUpload.has(bucket))
            return { data: null, error: { message: "boom" } };
          if (!ownsFolder(p, userId))
            return {
              data: null,
              error: { message: "new row violates row-level security policy" },
            };
          if (backend.has(bucket, p) && !opts?.upsert)
            return {
              data: null,
              error: { message: "The resource already exists" },
            };
          const bytes =
            body instanceof Uint8Array
              ? body
              : new Uint8Array(await body.arrayBuffer());
          backend.objects.set(backend.key(bucket, p), {
            bytes,
            contentType: opts?.contentType,
          });
          return { data: { path: p }, error: null };
        },
        async download(p: string) {
          await backend.hook?.(label, `download:${bucket}`);
          const object = backend.objects.get(backend.key(bucket, p));
          if (!ownsFolder(p, userId) || !object)
            return { data: null, error: { message: "Object not found" } };
          return { data: new Blob([object.bytes as BlobPart]), error: null };
        },
        async remove(paths: string[]) {
          const removed = paths.filter(
            (p) =>
              ownsFolder(p, userId) &&
              backend.objects.delete(backend.key(bucket, p))
          );
          backend.removed.push(...removed.map((p) => backend.key(bucket, p)));
          return { data: removed.map((name) => ({ name })), error: null };
        },
      };
    },
  };

  const from = (table: string) => {
    const visible = () =>
      backend.tables[table].filter((r) => r.user_id === userId);
    const query = (mode: "select" | "delete") => {
      const filters: Array<[string, unknown]> = [];
      let limitN = Infinity;
      const run = () => {
        const rows = visible().filter((r) =>
          filters.every(([c, v]) => r[c] === v)
        );
        if (mode === "delete") {
          backend.tables[table] = backend.tables[table].filter(
            (r) => !rows.includes(r)
          );
          return { data: null, error: null };
        }
        return { data: rows.slice(0, limitN), error: null };
      };
      const q: Record<string, unknown> = {
        eq(c: string, v: unknown) {
          filters.push([c, v]);
          return q;
        },
        limit(n: number) {
          limitN = n;
          return q;
        },
        async maybeSingle() {
          const r = run();
          return { data: (r.data as Row[] | null)?.[0] ?? null, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return q;
    };
    return {
      select: () => query("select"),
      delete: () => query("delete"),
      async insert(row: Row) {
        await backend.hook?.(label, `insert:${table}`);
        if (backend.failInsert.has(table))
          return { error: { code: "XX000", message: "forced failure" } };
        if (row.user_id !== userId)
          return { error: { code: "42501", message: "rls" } };
        const rows = backend.tables[table];
        const clash = (c: string) =>
          row[c] != null && rows.some((r) => r[c] === row[c]);
        if (
          clash("id") ||
          clash("storage_path") ||
          (table === "reports" && clash("previous_report_id")) ||
          (table === "report_source_workbooks" && clash("report_id"))
        ) {
          return { error: { code: "23505", message: "duplicate key" } };
        }
        rows.push({
          extraction_status: "pending",
          review_status: "pending",
          previous_report_id: null,
          ...row,
        });
        return { error: null };
      },
    };
  };

  return {
    auth: {
      async getUser() {
        return userId
          ? { data: { user: { id: userId } }, error: null }
          : { data: { user: null }, error: { message: "no session" } };
      },
    },
    storage,
    from,
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------
// Files and harness
// ---------------------------------------------------------------------
const PDF_BYTES = new Uint8Array([
  0x25,
  0x50,
  0x44,
  0x46,
  0x2d,
  0x31,
  0x2e,
  0x34,
  ...new Array(64).fill(0x20),
]);
const DOC_BYTES = new Uint8Array([
  0xd0,
  0xcf,
  0x11,
  0xe0,
  0xa1,
  0xb1,
  0x1a,
  0xe1,
  ...new Array(64).fill(0),
]);
const mkFile = (bytes: Uint8Array, name: string, type = "") =>
  new File([bytes as BlobPart], name, { type });

interface Run {
  backend: Backend;
  scheduled: string[];
  revalidated: number;
}

function harness(userId: string | null = ALICE) {
  const backend = new Backend();
  const run: Run = { backend, scheduled: [], revalidated: 0 };
  const hooks = {
    scheduleExtraction: (id: string) => run.scheduled.push(id),
    revalidateDashboard: () => {
      run.revalidated++;
    },
  };
  const client = clientFor(backend, userId);
  const finalize = (input: Parameters<typeof finalizeUpload>[1]) =>
    finalizeUpload(client, input, hooks);
  const upload = (params: {
    report: File;
    workbook?: File | null;
    revisesReportId?: string | null;
    finalize?: (
      i: Parameters<typeof finalizeUpload>[1]
    ) => Promise<FinalizeResult>;
  }) =>
    uploadReportDirect({
      supabase: client,
      newId: () => REPORT_ID,
      finalize,
      ...params,
    });
  return { run, backend, client, hooks, finalize, upload };
}

const reportsRows = (b: Backend) => b.tables.reports;
const workbookRows = (b: Backend) => b.tables.report_source_workbooks;
const noObjects = (b: Backend) =>
  assert.equal(
    b.objects.size,
    0,
    `leftover objects: ${[...b.objects.keys()].join(", ")}`
  );
const failure = (r: FinalizeResult) =>
  r.success ? assert.fail("expected failure") : r.error;

// ---------------------------------------------------------------------
describe("direct upload: happy paths", () => {
  it("report-only upload finalizes: record created, extraction scheduled once, workbook stays optional", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Appraisal.pdf", "application/pdf"),
    });

    assert.deepEqual(result, { success: true });
    assert.equal(reportsRows(h.backend).length, 1);
    const row = reportsRows(h.backend)[0];
    assert.equal(row.id, REPORT_ID);
    assert.equal(row.user_id, ALICE);
    assert.equal(row.storage_path, `${ALICE}/${REPORT_ID}.pdf`);
    assert.equal(row.original_filename, "Appraisal.pdf");
    assert.equal(row.file_size_bytes, PDF_BYTES.length);
    assert.equal(row.previous_report_id, null);
    assert.equal(workbookRows(h.backend).length, 0);
    assert.deepEqual(h.run.scheduled, [REPORT_ID]);
    assert.equal(h.run.revalidated, 1);
    assert.equal(
      h.backend.objects.get(`reports/${ALICE}/${REPORT_ID}.pdf`)?.contentType,
      "application/pdf"
    );
  });

  it("legacy .doc report finalizes", async () => {
    const h = harness();
    const result = await h.upload({ report: mkFile(DOC_BYTES, "Legacy.doc") });
    assert.deepEqual(result, { success: true });
    assert.equal(
      reportsRows(h.backend)[0].storage_path,
      `${ALICE}/${REPORT_ID}.doc`
    );
    assert.equal(
      h.backend.objects.get(`reports/${ALICE}/${REPORT_ID}.doc`)?.contentType,
      "application/msword"
    );
  });

  it("report + .xlsm workbook finalizes with both records, real sizes and macro flag", async () => {
    const h = harness();
    const xlsm = fixture("source-model.xlsm");
    const result = await h.upload({
      report: mkFile(DOC_BYTES, "Avignon.doc"),
      workbook: mkFile(xlsm, "Avignon.xlsm"), // browsers often report no type for .xlsm
    });

    assert.deepEqual(result, { success: true });
    assert.equal(reportsRows(h.backend).length, 1);
    assert.equal(workbookRows(h.backend).length, 1);
    const wb = workbookRows(h.backend)[0];
    assert.equal(wb.report_id, REPORT_ID);
    assert.equal(wb.user_id, ALICE);
    assert.equal(wb.storage_path, `${ALICE}/${REPORT_ID}.xlsm`);
    assert.equal(wb.workbook_format, "xlsm");
    assert.equal(wb.file_size_bytes, xlsm.length);
    assert.equal(wb.contains_macros, true);
    assert.equal(wb.original_filename, "Avignon.xlsm");
    assert.equal(
      h.backend.objects.get(`review-workbooks/${ALICE}/${REPORT_ID}.xlsm`)
        ?.contentType,
      WORKBOOK_MIME_BY_FORMAT.xlsm
    );
    assert.deepEqual(h.run.scheduled, [REPORT_ID]);
  });

  it("report + .xlsx workbook finalizes", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "R.xlsx"),
    });
    assert.deepEqual(result, { success: true });
    assert.equal(workbookRows(h.backend)[0].workbook_format, "xlsx");
    assert.equal(workbookRows(h.backend)[0].contains_macros, false);
  });

  it("an empty-string / null workbook path means no workbook", async () => {
    for (const workbookStoragePath of [null, "", undefined]) {
      const h = harness();
      await h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
        bytes: PDF_BYTES,
        contentType: "application/pdf",
      });
      const result = await h.finalize({
        reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
        reportFilename: "R.pdf",
        workbookStoragePath,
        workbookFilename: null,
      });
      assert.deepEqual(result, { success: true });
      assert.equal(workbookRows(h.backend).length, 0);
    }
  });
});

// ---------------------------------------------------------------------
describe("direct upload: authoritative server validation", () => {
  it("rejects a report whose bytes are not a PDF, and removes the stored object", async () => {
    const h = harness();
    const fake = new TextEncoder().encode(
      "This is plain text, not a PDF at all."
    );
    const result = await h.upload({
      report: mkFile(fake, "Fake.pdf", "application/pdf"),
    });
    assert.equal(failure(result), "This file doesn't look like a valid PDF.");
    assert.equal(reportsRows(h.backend).length, 0);
    assert.deepEqual(h.run.scheduled, []);
    noObjects(h.backend);
  });

  it("rejects a .doc whose bytes are not a Word document", async () => {
    const h = harness();
    const result = await h.upload({ report: mkFile(PDF_BYTES, "Wrong.doc") });
    assert.match(failure(result), /valid Microsoft Word \.doc/);
    noObjects(h.backend);
  });

  it("rejects an invalid workbook, creates no records, and removes BOTH objects", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(
        new TextEncoder().encode("not a zip package"),
        "Bad.xlsx"
      ),
    });
    assert.match(failure(result), /valid Excel workbook/);
    assert.equal(reportsRows(h.backend).length, 0);
    assert.equal(workbookRows(h.backend).length, 0);
    assert.deepEqual(h.run.scheduled, []);
    noObjects(h.backend);
  });

  it("rejects a password-protected (OLE-wrapped) workbook with the encrypted message", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(DOC_BYTES, "Locked.xlsx"),
    });
    assert.match(failure(result), /password-protected/);
    noObjects(h.backend);
  });

  it("rejects a workbook whose contents contradict its extension", async () => {
    const h = harness();
    // A valid .xlsm package uploaded under an .xlsx name.
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsm"), "Renamed.xlsx"),
    });
    assert.equal(result.success, false);
    assert.equal(reportsRows(h.backend).length, 0);
    noObjects(h.backend);
  });

  it("enforces the 25 MB report limit on the stored object, not on a client claim", async () => {
    const h = harness();
    const big = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    big.set(PDF_BYTES);
    const result = await h.upload({ report: mkFile(big, "Huge.pdf") });
    assert.match(failure(result), /too large.*25 MB/);
    noObjects(h.backend);

    // Exactly at the limit is accepted.
    const h2 = harness();
    const atLimit = new Uint8Array(MAX_FILE_SIZE_BYTES);
    atLimit.set(PDF_BYTES);
    const ok = await h2.upload({ report: mkFile(atLimit, "Max.pdf") });
    assert.deepEqual(ok, { success: true });
    assert.equal(
      reportsRows(h2.backend)[0].file_size_bytes,
      MAX_FILE_SIZE_BYTES
    );
  });

  it("still enforces the workbook size limit server-side", async () => {
    const h = harness();
    const big = new Uint8Array(MAX_WORKBOOK_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(big, "Big.xlsx"),
    });
    assert.match(failure(result), /too large/);
    noObjects(h.backend);
  });

  it("rejects when the stored report object is missing", async () => {
    const h = harness();
    const result = await h.finalize({
      reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
      reportFilename: "R.pdf",
    });
    assert.match(failure(result), /could not be found/);
    assert.equal(reportsRows(h.backend).length, 0);
  });

  it("rejects a file name whose extension disagrees with the stored path", async () => {
    const h = harness();
    h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    const result = await h.finalize({
      reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
      reportFilename: "R.doc",
    });
    assert.equal(result.success, false);
    assert.equal(reportsRows(h.backend).length, 0);
    noObjects(h.backend);
  });

  it("rejects an unauthenticated caller and touches nothing", async () => {
    const h = harness(null);
    h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    const result = await h.finalize({
      reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
      reportFilename: "R.pdf",
    });
    assert.match(failure(result), /logged in/);
    assert.equal(h.backend.objects.size, 1);
    assert.equal(reportsRows(h.backend).length, 0);
  });
});

// ---------------------------------------------------------------------
describe("direct upload: ownership and storage-path trust", () => {
  it("path parsers accept only {own user}/{uuid}.{allowed ext}", () => {
    const ok = parseOwnedReportPath(`${ALICE}/${REPORT_ID}.pdf`, ALICE);
    assert.equal(ok?.reportId, REPORT_ID);
    assert.equal(ok?.format, "pdf");
    assert.equal(
      parseOwnedReportPath(`${ALICE}/${REPORT_ID}.doc`, ALICE)?.format,
      "doc"
    );
    assert.equal(
      parseOwnedWorkbookPath(`${ALICE}/${REPORT_ID}.xlsm`, ALICE)?.format,
      "xlsm"
    );

    const bad: unknown[] = [
      `${BOB}/${REPORT_ID}.pdf`, // someone else's folder
      `${ALICE}/../${BOB}/${REPORT_ID}.pdf`, // traversal
      `${ALICE}/${REPORT_ID}.pdf/extra`, // extra segment
      `${ALICE}/nested/${REPORT_ID}.pdf`, // nested folder
      `/${ALICE}/${REPORT_ID}.pdf`, // leading slash
      `${ALICE}/not-a-uuid.pdf`, // non-uuid id
      `${ALICE}/${REPORT_ID}.exe`, // disallowed extension
      `${ALICE}/${REPORT_ID}.xlsx`, // workbook ext on a report path
      `${ALICE}/${REPORT_ID}`, // no extension
      `${ALICE}/${REPORT_ID}.pdf.pdf`, // double extension
      `${ALICE}\\${REPORT_ID}.pdf`, // backslash
      "",
      null,
      undefined,
      42,
      {},
    ];
    for (const value of bad) {
      assert.equal(
        parseOwnedReportPath(value, ALICE),
        null,
        `report path accepted: ${String(value)}`
      );
    }
    assert.equal(
      parseOwnedWorkbookPath(`${ALICE}/${REPORT_ID}.pdf`, ALICE),
      null
    );
    assert.equal(
      parseOwnedWorkbookPath(`${BOB}/${REPORT_ID}.xlsx`, ALICE),
      null
    );
  });

  it("another user's object cannot be finalized, and is left untouched", async () => {
    const bobHarness = harness(BOB);
    // Alice's valid, private upload.
    bobHarness.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });

    const result = await bobHarness.finalize({
      reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
      reportFilename: "Stolen.pdf",
    });

    assert.equal(result.success, false);
    assert.equal(reportsRows(bobHarness.backend).length, 0);
    assert.deepEqual(bobHarness.run.scheduled, []);
    assert.equal(
      bobHarness.backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`),
      true,
      "victim's object must survive"
    );
    assert.deepEqual(bobHarness.backend.removed, []);
  });

  it("another user's workbook path is rejected; the caller's own report object is cleaned up", async () => {
    const h = harness(BOB);
    h.backend.objects.set(`reports/${BOB}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    h.backend.objects.set(`review-workbooks/${ALICE}/${REPORT_ID}.xlsx`, {
      bytes: fixture("source-model.xlsx"),
      contentType: WORKBOOK_MIME_BY_FORMAT.xlsx,
    });

    const result = await h.finalize({
      reportStoragePath: `${BOB}/${REPORT_ID}.pdf`,
      reportFilename: "Mine.pdf",
      workbookStoragePath: `${ALICE}/${REPORT_ID}.xlsx`,
      workbookFilename: "Theirs.xlsx",
    });

    assert.equal(result.success, false);
    assert.equal(reportsRows(h.backend).length, 0);
    assert.equal(workbookRows(h.backend).length, 0);
    assert.equal(
      h.backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true,
      "other user's workbook untouched"
    );
    assert.equal(h.backend.has("reports", `${BOB}/${REPORT_ID}.pdf`), false);
  });

  it("malformed or mismatched paths create no records", async () => {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const cases: Array<Parameters<typeof finalizeUpload>[1]> = [
      {
        reportStoragePath: `${ALICE}/../${BOB}/${REPORT_ID}.pdf`,
        reportFilename: "R.pdf",
      },
      {
        reportStoragePath: `${ALICE}/${REPORT_ID}.exe`,
        reportFilename: "R.pdf",
      },
      { reportStoragePath: "not a path", reportFilename: "R.pdf" },
      // workbook paired with a DIFFERENT report id
      {
        reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
        reportFilename: "R.pdf",
        workbookStoragePath: `${ALICE}/${otherId}.xlsx`,
        workbookFilename: "W.xlsx",
      },
      // workbook path without a name
      {
        reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
        reportFilename: "R.pdf",
        workbookStoragePath: `${ALICE}/${REPORT_ID}.xlsx`,
        workbookFilename: "",
      },
      // junk input
      null as unknown as Parameters<typeof finalizeUpload>[1],
      { reportStoragePath: 5, reportFilename: {} } as unknown as Parameters<
        typeof finalizeUpload
      >[1],
    ];
    for (const input of cases) {
      const h = harness();
      h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
        bytes: PDF_BYTES,
        contentType: "application/pdf",
      });
      h.backend.objects.set(`review-workbooks/${ALICE}/${REPORT_ID}.xlsx`, {
        bytes: fixture("source-model.xlsx"),
        contentType: WORKBOOK_MIME_BY_FORMAT.xlsx,
      });
      const result = await h.finalize(input);
      assert.equal(result.success, false, JSON.stringify(input));
      assert.equal(reportsRows(h.backend).length, 0);
      assert.equal(workbookRows(h.backend).length, 0);
      assert.deepEqual(h.run.scheduled, []);
    }
  });

  it("the browser cannot upload into another user's folder (storage RLS stand-in)", async () => {
    const h = harness(BOB);
    const { error } = await clientFor(h.backend, BOB)
      .storage.from("reports")
      .upload(`${ALICE}/${REPORT_ID}.pdf`, new Blob([PDF_BYTES as BlobPart]));
    assert.ok(error);
  });

  it("builds collision-safe paths: per-upload id under the caller's folder, never from the file name", () => {
    const paths = buildUploadPaths({
      userId: ALICE,
      reportId: REPORT_ID,
      reportFileName: "../../evil name.PDF",
      workbookFileName: "x.XLSM",
    });
    assert.deepEqual(paths, {
      reportPath: `${ALICE}/${REPORT_ID}.pdf`,
      workbookPath: `${ALICE}/${REPORT_ID}.xlsm`,
    });
    assert.equal(
      buildUploadPaths({
        userId: ALICE,
        reportId: REPORT_ID,
        reportFileName: "a.exe",
      }),
      null
    );
  });

  it("two uploads never share a path (upsert is off, so a clash fails instead of overwriting)", async () => {
    const h = harness();
    const first = await h.upload({ report: mkFile(PDF_BYTES, "A.pdf") });
    assert.deepEqual(first, { success: true });
    const before = h.backend.objects.get(`reports/${ALICE}/${REPORT_ID}.pdf`);

    // Same id again (forced): the direct upload must fail, not overwrite.
    const second = await h.upload({ report: mkFile(DOC_BYTES, "B.doc") }); // different ext, same id
    assert.equal(second.success, false);
    assert.equal(
      h.backend.objects.get(`reports/${ALICE}/${REPORT_ID}.pdf`),
      before
    );
    assert.equal(reportsRows(h.backend).length, 1);
  });
});

// ---------------------------------------------------------------------
describe("direct upload: revisions (revisesReportId)", () => {
  const seedPrior = (
    h: ReturnType<typeof harness>,
    overrides: Row = {},
    owner = ALICE
  ) =>
    h.backend.seedReport({
      id: PRIOR_ID,
      user_id: owner,
      original_filename: "Prior.pdf",
      storage_path: `${owner}/${PRIOR_ID}.pdf`,
      file_size_bytes: 10,
      extraction_status: "completed",
      review_status: "complete",
      ...overrides,
    });

  it("links the new report to the reviewed one it revises", async () => {
    const h = harness();
    seedPrior(h);
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev2.pdf"),
      revisesReportId: PRIOR_ID,
    });
    assert.deepEqual(result, { success: true });
    const created = reportsRows(h.backend).find((r) => r.id === REPORT_ID)!;
    assert.equal(created.previous_report_id, PRIOR_ID);
    assert.deepEqual(h.run.scheduled, [REPORT_ID]);
  });

  it("revision with a workbook keeps both records", async () => {
    const h = harness();
    seedPrior(h);
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev2.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "Rev2.xlsx"),
      revisesReportId: PRIOR_ID,
    });
    assert.deepEqual(result, { success: true });
    assert.equal(workbookRows(h.backend).length, 1);
  });

  it("rejects revising someone else's report as 'not found' and cleans up", async () => {
    const h = harness(BOB);
    seedPrior(h, {}, ALICE);
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev.pdf"),
      revisesReportId: PRIOR_ID,
    });
    assert.equal(
      failure(result),
      "The report you are revising could not be found."
    );
    assert.equal(
      reportsRows(h.backend).filter((r) => r.user_id === BOB).length,
      0
    );
    noObjects(h.backend);
  });

  it("rejects a revision of a report whose review has not finished", async () => {
    const h = harness();
    seedPrior(h, { review_status: "processing" });
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev.pdf"),
      revisesReportId: PRIOR_ID,
    });
    assert.match(
      failure(result),
      /after the earlier report's review has finished/
    );
    noObjects(h.backend);
  });

  it("rejects a second revision of the same report", async () => {
    const h = harness();
    seedPrior(h);
    h.backend.seedReport({
      id: "55555555-5555-4555-8555-555555555555",
      user_id: ALICE,
      original_filename: "Rev1.pdf",
      storage_path: `${ALICE}/55555555-5555-4555-8555-555555555555.pdf`,
      file_size_bytes: 10,
      previous_report_id: PRIOR_ID,
    });
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev2.pdf"),
      revisesReportId: PRIOR_ID,
    });
    assert.match(failure(result), /already been uploaded/);
    noObjects(h.backend);
  });

  it("rejects a malformed revisesReportId", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "Rev.pdf"),
      revisesReportId: "not-a-uuid",
    });
    assert.equal(
      failure(result),
      "The report you are revising could not be found."
    );
    noObjects(h.backend);
  });

  it("a concurrent revision that loses the unique-index race reports the friendly error and cleans up", async () => {
    const h = harness();
    seedPrior(h);
    // Simulate the race: the pre-check sees no revision, but the insert hits
    // the unique index because another tab won in between.
    const realClient = h.client;
    let injected = false;
    const racing = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (table: string) => {
            const t = (
              target.from as unknown as (
                t: string
              ) => Record<string, (...a: unknown[]) => unknown>
            )(table);
            if (table !== "reports") return t;
            return {
              ...t,
              insert: async (row: Row) => {
                if (!injected && row.previous_report_id === PRIOR_ID) {
                  injected = true;
                  return { error: { code: "23505", message: "duplicate" } };
                }
                return t.insert(row);
              },
              select: t.select,
              delete: t.delete,
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    const result = await finalizeUpload(
      racing,
      {
        reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
        reportFilename: "Rev2.pdf",
        revisesReportId: PRIOR_ID,
      },
      h.hooks
    );
    assert.match(failure(result), /already been uploaded/);
    noObjects(h.backend);
    assert.deepEqual(h.run.scheduled, []);
  });
});

// ---------------------------------------------------------------------
describe("direct upload: cleanup and rollback", () => {
  it("removes both objects when the report record insert fails", async () => {
    const h = harness();
    h.backend.failInsert.add("reports");
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "R.xlsx"),
    });
    assert.match(failure(result), /saving the report record/);
    assert.equal(reportsRows(h.backend).length, 0);
    assert.deepEqual(h.run.scheduled, []);
    noObjects(h.backend);
  });

  it("when the workbook record insert fails: report row deleted, both objects removed, no extraction", async () => {
    const h = harness();
    h.backend.failInsert.add("report_source_workbooks");
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "R.xlsx"),
    });
    assert.match(failure(result), /saving the workbook/);
    assert.equal(
      reportsRows(h.backend).length,
      0,
      "report must not exist without its workbook"
    );
    assert.equal(workbookRows(h.backend).length, 0);
    assert.deepEqual(h.run.scheduled, []);
    noObjects(h.backend);
  });

  it("a replayed finalize cannot delete the files of the report it duplicates", async () => {
    const h = harness();
    const input = {
      reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
      reportFilename: "R.pdf",
      workbookStoragePath: `${ALICE}/${REPORT_ID}.xlsx`,
      workbookFilename: "R.xlsx",
    };
    const first = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "R.xlsx"),
    });
    assert.deepEqual(first, { success: true });

    const replay = await h.finalize(input);
    assert.match(failure(replay), /already been submitted/);
    assert.equal(h.backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);
    assert.equal(
      h.backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true
    );
    assert.equal(reportsRows(h.backend).length, 1);
    assert.deepEqual(
      h.run.scheduled,
      [REPORT_ID],
      "extraction must run once, not twice"
    );
  });

  it("browser: a failed workbook upload removes the already-stored report and never calls finalize", async () => {
    const h = harness();
    h.backend.failUpload.add("review-workbooks");
    let finalizeCalls = 0;
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(fixture("source-model.xlsx"), "R.xlsx"),
      finalize: async () => {
        finalizeCalls++;
        return { success: true };
      },
    });
    assert.equal(failure(result), "Upload failed. Please try again.");
    assert.equal(finalizeCalls, 0);
    noObjects(h.backend);
  });

  it("browser: a failed report upload never calls finalize", async () => {
    const h = harness();
    h.backend.failUpload.add("reports");
    let finalizeCalls = 0;
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      finalize: async () => {
        finalizeCalls++;
        return { success: true };
      },
    });
    assert.equal(result.success, false);
    assert.equal(finalizeCalls, 0);
  });

  it("browser: a finalize call that throws resolves with an error (UI cannot stay stuck) and keeps the objects", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      finalize: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(result.success, false);
    assert.match(failure(result), /couldn't confirm the upload/);
    assert.equal(h.backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);
  });

  it("browser: a lost finalize response is treated as success when the report was in fact created", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      finalize: async (input) => {
        await h.finalize(input); // server did the work...
        throw new Error("response lost"); // ...but the reply never arrived
      },
    });
    assert.deepEqual(result, { success: true });
    assert.equal(reportsRows(h.backend).length, 1);
    assert.equal(h.backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);
  });

  it("browser: finalize validation errors surface to the UI unchanged", async () => {
    const h = harness();
    const result = await h.upload({
      report: mkFile(new TextEncoder().encode("nope"), "X.pdf"),
    });
    assert.equal(failure(result), "This file doesn't look like a valid PDF.");
  });

  it("browser: refuses unsupported file types before uploading anything", async () => {
    const h = harness();
    const bad = await h.upload({ report: mkFile(PDF_BYTES, "R.txt") });
    assert.equal(bad.success, false);
    const badWb = await h.upload({
      report: mkFile(PDF_BYTES, "R.pdf"),
      workbook: mkFile(PDF_BYTES, "W.xls"),
    });
    assert.equal(badWb.success, false);
    noObjects(h.backend);
  });

  it("browser: requires a signed-in session", async () => {
    const h = harness(null);
    const result = await h.upload({ report: mkFile(PDF_BYTES, "R.pdf") });
    assert.match(failure(result), /logged in/);
    noObjects(h.backend);
  });
});

// ---------------------------------------------------------------------
describe("direct upload: simultaneous finalize of the same report id", () => {
  /** A promise whose resolution the test controls. */
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  };

  const FULL_INPUT = {
    reportStoragePath: `${ALICE}/${REPORT_ID}.pdf`,
    reportFilename: "R.pdf",
    workbookStoragePath: `${ALICE}/${REPORT_ID}.xlsx`,
    workbookFilename: "R.xlsx",
  };

  function setup() {
    const backend = new Backend();
    const scheduled: string[] = [];
    const hooks = {
      scheduleExtraction: (id: string) => scheduled.push(id),
      revalidateDashboard: () => {},
    };
    backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    backend.objects.set(`review-workbooks/${ALICE}/${REPORT_ID}.xlsx`, {
      bytes: fixture("source-model.xlsx"),
      contentType: WORKBOOK_MIME_BY_FORMAT.xlsx,
    });
    const requestA = () =>
      finalizeUpload(clientFor(backend, ALICE, "A"), FULL_INPUT, hooks);
    const requestB = () =>
      finalizeUpload(clientFor(backend, ALICE, "B"), FULL_INPUT, hooks);
    return { backend, scheduled, requestA, requestB };
  }

  it("a late duplicate cannot delete the workbook while the winner is between its report insert and workbook insert", async () => {
    const { backend, scheduled, requestA, requestB } = setup();
    const aPaused = gate();
    const releaseA = gate();

    // A (the winner) stops right after its report row exists, before its
    // workbook row is inserted: the window in which nothing yet "claims"
    // the workbook object by path.
    backend.hook = async (label, event) => {
      if (label === "A" && event === "insert:report_source_workbooks") {
        aPaused.open();
        await releaseA.promise;
      }
    };

    const a = requestA();
    await aPaused.promise;
    assert.equal(reportsRows(backend).length, 1, "A's report row exists");
    assert.equal(
      workbookRows(backend).length,
      0,
      "A's workbook row does not yet"
    );

    // B, the duplicate, runs to completion inside that window.
    const b = await requestB();
    assert.equal(b.success, false);
    assert.equal(
      backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true,
      "duplicate B must not delete the workbook A is still finalizing"
    );
    assert.equal(backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);

    releaseA.open();
    assert.deepEqual(await a, { success: true });
    assert.equal(workbookRows(backend).length, 1);
    assert.equal(
      backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true
    );
    assert.equal(backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);
    assert.deepEqual(scheduled, [REPORT_ID], "extraction runs exactly once");
  });

  it("a duplicate that passed its pre-check but loses the report insert cannot delete the winner's objects", async () => {
    const { backend, scheduled, requestA, requestB } = setup();
    const bAtDownload = gate();
    const releaseB = gate();
    const aPaused = gate();
    const releaseA = gate();

    backend.hook = async (label, event) => {
      // B passes its "already submitted" pre-check (no row yet), then waits.
      if (label === "B" && event === "download:reports") {
        bAtDownload.open();
        await releaseB.promise;
      }
      if (label === "A" && event === "insert:report_source_workbooks") {
        aPaused.open();
        await releaseA.promise;
      }
    };

    const b = requestB();
    await bAtDownload.promise;
    assert.equal(
      reportsRows(backend).length,
      0,
      "B is past its pre-check; no row yet"
    );

    const a = requestA();
    await aPaused.promise; // A has won the report insert and paused
    assert.equal(reportsRows(backend).length, 1);

    releaseB.open(); // B validates, then loses the unique id on insert
    const bResult = await b;
    assert.equal(bResult.success, false);
    assert.equal(
      backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true,
      "loser B must not delete the workbook A is still finalizing"
    );
    assert.equal(backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);

    releaseA.open();
    assert.deepEqual(await a, { success: true });
    assert.equal(reportsRows(backend).length, 1);
    assert.equal(workbookRows(backend).length, 1);
    assert.equal(
      backend.has("review-workbooks", `${ALICE}/${REPORT_ID}.xlsx`),
      true
    );
    assert.deepEqual(scheduled, [REPORT_ID]);
  });

  it("genuinely unclaimed uploads are still cleaned up (no row with this id)", async () => {
    const { backend, requestA } = setup();
    // Corrupt the workbook so validation fails with nobody else involved.
    backend.objects.set(`review-workbooks/${ALICE}/${REPORT_ID}.xlsx`, {
      bytes: new TextEncoder().encode("not a zip"),
      contentType: WORKBOOK_MIME_BY_FORMAT.xlsx,
    });
    const result = await requestA();
    assert.equal(result.success, false);
    assert.equal(reportsRows(backend).length, 0);
    noObjects(backend);
  });

  it("an object at a path the existing report does not own is still cleaned up", async () => {
    const h = harness();
    // An existing report with this id owns {id}.pdf ...
    h.backend.seedReport({
      id: REPORT_ID,
      user_id: ALICE,
      original_filename: "Existing.pdf",
      storage_path: `${ALICE}/${REPORT_ID}.pdf`,
      file_size_bytes: 10,
    });
    h.backend.objects.set(`reports/${ALICE}/${REPORT_ID}.pdf`, {
      bytes: PDF_BYTES,
      contentType: "application/pdf",
    });
    // ... so a stray upload of {id}.doc is nobody's and is removed, while
    // the existing report's file is left alone.
    const result = await h.upload({ report: mkFile(DOC_BYTES, "Stray.doc") });
    assert.equal(result.success, false);
    assert.equal(h.backend.has("reports", `${ALICE}/${REPORT_ID}.doc`), false);
    assert.equal(h.backend.has("reports", `${ALICE}/${REPORT_ID}.pdf`), true);
  });
});

describe("direct upload: security posture of the shipped sources", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  // Comments may legitimately mention what the code must NOT do.
  const code = (p: string) =>
    read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("the browser path never references a service-role key or makes a bucket public", () => {
    for (const file of [
      "src/lib/reports/directUpload.ts",
      "src/lib/reports/uploadPaths.ts",
      "src/app/(dashboard)/dashboard/new/UploadForm.tsx",
      "src/lib/supabase/client.ts",
    ]) {
      const source = code(file);
      assert.doesNotMatch(source, /service[_-]?role/i, file);
      assert.doesNotMatch(
        source,
        /createSignedUploadUrl|getPublicUrl|public:\s*true/,
        file
      );
    }
  });

  it("the form no longer posts file bytes to a Server Action", () => {
    const form = read("src/app/(dashboard)/dashboard/new/UploadForm.tsx");
    assert.doesNotMatch(form, /FormData/);
    assert.doesNotMatch(form, /uploadReport\(/);
    assert.match(form, /uploadReportDirect/);
    assert.match(form, /finally/);
  });

  it("the Server Action accepts metadata only (no File / FormData)", () => {
    const actions = read("src/lib/reports/actions.ts");
    assert.doesNotMatch(actions, /FormData/);
    assert.match(actions, /finalizeReportUpload/);
    assert.match(actions, /after\(\(\) => runTextExtraction\(reportId\)\)/);
  });
});
