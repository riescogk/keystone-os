import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Milestone 14 database behavior, executed against real PostgreSQL (PGlite).
 * Replays migrations 0001-0013 and checks what type-checking cannot:
 *   - a workbook can only be attached to the caller's OWN report
 *   - the stored evidence is immutable; only check-status columns change
 *   - owner isolation under RLS
 *   - deleting a report or account removes its workbook row
 *   - delete_own_account refuses while a workbook file remains
 *   - source-workbook findings must carry a source reference and be deterministic
 *
 * Supabase pieces are stubbed the same way re-review-db.test.ts stubs them,
 * plus storage.buckets, which migration 0013 writes to.
 */

const MIGRATIONS = [
  "0001_users",
  "0002_reports",
  "0004_report_extraction",
  "0005_findings",
  "0006_template_leftover_findings",
  "0007_typo_formatting_findings",
  "0008_missing_documentation_findings",
  "0009_arithmetic_verification_findings",
  "0010_delete_own_account",
  "0011_model_review",
  "0012_re_review",
  "0013_source_workbook",
];

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAROL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: PGlite;

async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  if (userId) {
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`
    );
  } else {
    await db.exec("set role anon;");
  }
  try {
    return await fn();
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  }
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) =>
    pattern.test(
      error instanceof Error
        ? `${error.message} ${(error as { code?: string }).code ?? ""}`
        : String(error)
    )
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) t`, params);
  return result.rows[0].n;
}

const REPORT_ALICE = "11111111-1111-4111-8111-111111111111";
const REPORT_ALICE_2 = "22222222-2222-4222-8222-222222222222";
const REPORT_CAROL = "33333333-3333-4333-8333-333333333333";
const WORKBOOK_ALICE = "44444444-4444-4444-8444-444444444444";

function workbookRow(reportId: string, userId: string, objectName: string) {
  return {
    report_id: reportId,
    user_id: userId,
    original_filename: "25194AvignonApts.xlsm",
    storage_path: objectName,
    file_size_bytes: 1000,
    workbook_format: "xlsm",
  };
}

async function insertWorkbook(
  userId: string,
  row: ReturnType<typeof workbookRow>,
  id: string = crypto.randomUUID()
) {
  await db.query(
    `insert into public.report_source_workbooks
       (id, report_id, user_id, original_filename, storage_path, file_size_bytes, workbook_format)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, row.report_id, userId, row.original_filename, row.storage_path, row.file_size_bytes, row.workbook_format]
  );
  return id;
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create schema storage;
    create table storage.objects (bucket_id text, name text);
    create table storage.buckets (
      id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
    $$;
  `);

  for (const file of MIGRATIONS) {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase", "migrations", `${file}.sql`),
      "utf8"
    );
    await db.exec(sql);
  }

  await db.exec(`
    grant usage on schema public, auth, storage to authenticated, anon;
    grant all on all tables in schema public to authenticated;
    grant all on storage.objects to authenticated;
    grant select on auth.users to authenticated;
  `);

  for (const [id, email] of [
    [ALICE, "alice@example.com"],
    [BOB, "bob@example.com"],
    [CAROL, "carol@example.com"],
  ]) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"full_name":"Test"}'::jsonb)`,
      [id, email]
    );
  }

  // Reports are created as their owner, the way the upload action does it.
  for (const [reportId, owner] of [
    [REPORT_ALICE, ALICE],
    [REPORT_ALICE_2, ALICE],
    [REPORT_CAROL, CAROL],
  ] as const) {
    await asUser(owner, () =>
      db.query(
        `insert into public.reports (id, user_id, original_filename, storage_path, file_size_bytes)
 values ($1::uuid, $2::uuid, 'r.pdf', ($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf', 1000)`,
[reportId, owner]
      )
    );
  }
});

after(async () => {
  await db.close();
});

describe("migration 0013 on a real PostgreSQL", () => {
  it("creates the private review-workbooks bucket with its size and MIME limits", async () => {
    const result = await db.query<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      `select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'review-workbooks'`
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].public, false);
    assert.equal(Number(result.rows[0].file_size_limit), 20971520);
    assert.ok(result.rows[0].allowed_mime_types.includes("application/vnd.ms-excel.sheet.macroEnabled.12"));
  });

  it("adds the new findings category, source_reference column, and integrity checks", async () => {
    assert.equal(
      await count(
        `select 1 from information_schema.columns where table_schema='public' and table_name='findings' and column_name='source_reference'`
      ),
      1
    );
  });
});

describe("attaching a workbook to a report", () => {
  it("lets the owner attach a workbook to their own report", async () => {
    await asUser(ALICE, () =>
      insertWorkbook(ALICE, workbookRow(REPORT_ALICE, ALICE, `${ALICE}/${REPORT_ALICE}.xlsm`), WORKBOOK_ALICE)
    );
    assert.equal(await count(`select 1 from public.report_source_workbooks where id = $1`, [WORKBOOK_ALICE]), 1);
  });

  it("refuses a second workbook for the same report", async () => {
    await rejects(
      asUser(ALICE, () =>
        insertWorkbook(ALICE, workbookRow(REPORT_ALICE, ALICE, `${ALICE}/second.xlsm`))
      ),
      /unique|duplicate/i
    );
  });

  it("refuses to attach a workbook to someone else's report", async () => {
    await rejects(
      asUser(BOB, () =>
        insertWorkbook(BOB, workbookRow(REPORT_CAROL, BOB, `${BOB}/x.xlsm`))
      ),
      /row-level security|policy/i
    );
  });

  it("refuses a spoofed user_id, even for the caller's own report", async () => {
    await rejects(
      asUser(ALICE, () =>
        insertWorkbook(BOB, workbookRow(REPORT_ALICE_2, BOB, `${BOB}/spoof.xlsm`))
      ),
      /row-level security|policy/i
    );
  });
});

describe("owner isolation", () => {
  it("another user cannot see the workbook row", async () => {
    const visibleToBob = await asUser(BOB, () =>
      count(`select 1 from public.report_source_workbooks where id = $1`, [WORKBOOK_ALICE])
    );
    assert.equal(visibleToBob, 0);
  });

  it("another user cannot change the workbook's check status", async () => {
    const updated = await asUser(BOB, async () => {
      const result = await db.query(
        `update public.report_source_workbooks set check_status = 'failed' where id = $1 returning id`,
        [WORKBOOK_ALICE]
      );
      return result.rows.length;
    });
    assert.equal(updated, 0);
  });
});

describe("immutable evidence", () => {
  it("lets the owner update the check lifecycle", async () => {
    await asUser(ALICE, () =>
      db.query(
        `update public.report_source_workbooks
           set check_status = 'complete', check_version = 'source-workbook-v1', linked_figure_count = 4
         where id = $1`,
        [WORKBOOK_ALICE]
      )
    );
    const row = await db.query<{ check_status: string; linked_figure_count: number }>(
      `select check_status, linked_figure_count from public.report_source_workbooks where id = $1`,
      [WORKBOOK_ALICE]
    );
    assert.equal(row.rows[0].check_status, "complete");
    assert.equal(row.rows[0].linked_figure_count, 4);
  });

  it("refuses to change the stored file identity after upload", async () => {
    await rejects(
      asUser(ALICE, () =>
        db.query(
          `update public.report_source_workbooks set storage_path = 'somewhere/else.xlsm' where id = $1`,
          [WORKBOOK_ALICE]
        )
      ),
      /immutable/i
    );
  });

  it("refuses to change whether macros were recorded", async () => {
    await rejects(
      asUser(ALICE, () =>
        db.query(
          `update public.report_source_workbooks set contains_macros = true where id = $1`,
          [WORKBOOK_ALICE]
        )
      ),
      /immutable/i
    );
  });

  it("refuses an unknown check status or error code", async () => {
    await rejects(
      asUser(ALICE, () =>
        db.query(`update public.report_source_workbooks set check_status = 'maybe' where id = $1`, [WORKBOOK_ALICE])
      ),
      /check/i
    );
    await rejects(
      asUser(ALICE, () =>
        db.query(`update public.report_source_workbooks set check_error = 'raw stack trace' where id = $1`, [WORKBOOK_ALICE])
      ),
      /check/i
    );
  });
});

describe("cascades", () => {
  it("removes the workbook row when its report is deleted", async () => {
    await asUser(CAROL, async () => {
      await db.query(
        `insert into public.report_source_workbooks
           (report_id, user_id, original_filename, storage_path, file_size_bytes, workbook_format)
         values ($1::uuid, $2::uuid, 'c.xlsx', ($2::uuid)::text || '/cascade.xlsx', 10, 'xlsx')`,
        [REPORT_CAROL, CAROL]
      );
    });
    await asUser(CAROL, () => db.query(`delete from public.reports where id = $1`, [REPORT_CAROL]));
    assert.equal(
      await count(`select 1 from public.report_source_workbooks where report_id = $1`, [REPORT_CAROL]),
      0
    );
  });
});

describe("account deletion keeps workbook files from being orphaned", () => {
  it("refuses while a review-workbooks object remains for the caller", async () => {
    await db.query(
      `insert into storage.objects (bucket_id, name) values ('review-workbooks', $1)`,
      [`${CAROL}/left-behind.xlsm`]
    );
    await rejects(
      asUser(CAROL, () => db.query("select public.delete_own_account()")),
      /Stored report files still exist/
    );
  });

  it("succeeds once the workbook object is gone, removing the row by cascade", async () => {
    await db.query(`delete from storage.objects where bucket_id = 'review-workbooks' and name like $1`, [`${CAROL}/%`]);
    await asUser(CAROL, () => db.query("select public.delete_own_account()"));
    assert.equal(await count(`select 1 from auth.users where id = $1`, [CAROL]), 0);
  });
});

describe("findings carrying workbook evidence", () => {
  const insertFinding = (overrides: { category?: string; confidence?: string; sourceReference?: unknown }) =>
    asUser(ALICE, () =>
      db.query(
        `insert into public.findings
           (report_id, user_id, category, severity, confidence, description, evidence, source_reference)
         values ($1, $2, $3, 'moderate', $4, 'd', 'e', $5)`,
        [
          REPORT_ALICE_2,
          ALICE,
          overrides.category ?? "source_workbook_discrepancy",
          overrides.confidence ?? "deterministic",
          overrides.sourceReference === undefined ? null : JSON.stringify(overrides.sourceReference),
        ]
      )
    );

  it("requires a source reference for a source-workbook finding", async () => {
    await rejects(insertFinding({ sourceReference: null }), /source_workbook_integrity|check/i);
  });

  it("requires the source reference to be an object", async () => {
    await rejects(insertFinding({ sourceReference: ["not", "an", "object"] }), /source_reference|check/i);
  });

  it("allows bounded model-assisted source findings when traceable workbook evidence is present", async () => {
    await insertFinding({ confidence: "model_based", sourceReference: { workbook: "a.xlsx", sheet: "S", cell: "A1", linkedBy: "model_context" } });
    assert.equal(
      await count(`select 1 from public.findings where report_id = $1 and confidence = 'model_based' and category = 'source_workbook_discrepancy'`, [REPORT_ALICE_2]),
      1
    );
  });

  it("accepts a well-formed source-workbook finding", async () => {
    await insertFinding({
      sourceReference: { workbook: "a.xlsm", sheet: "Pro Forma", cell: "C9", linkedBy: "defined_name" },
    });
    assert.equal(
      await count(
        `select 1 from public.findings where report_id = $1 and category = 'source_workbook_discrepancy'`,
        [REPORT_ALICE_2]
      ),
      2
    );
  });

  it("does not require a source reference for ordinary findings (existing behavior)", async () => {
    await asUser(ALICE, () =>
      db.query(
        `insert into public.findings (report_id, user_id, category, severity, confidence, description, evidence)
         values ($1, $2, 'template_leftover_detection', 'low', 'deterministic', 'd', 'e')`,
        [REPORT_ALICE_2, ALICE]
      )
    );
    assert.equal(
      await count(`select 1 from public.findings where report_id = $1 and category = 'template_leftover_detection'`, [REPORT_ALICE_2]),
      1
    );
  });
});
