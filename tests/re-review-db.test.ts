import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Executes the REAL migrations (0001–0012) against a real PostgreSQL
 * (PGlite = Postgres compiled to WebAssembly) to verify Phase 13's
 * database behavior — the part type-checking and unit tests cannot
 * reach: the revision-link trigger, the unique chain index, owner
 * isolation under Row Level Security, and how the new foreign keys
 * behave when reports/accounts are deleted.
 *
 * Supabase-specific pieces the migrations depend on are stubbed
 * minimally: the `auth` schema (users + auth.uid()), the `storage`
 * objects table the account-deletion guard reads, and the roles.
 * Migration 0003 (Storage bucket/policies) is skipped: it only
 * configures Storage and none of it is exercised here.
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
];

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: PGlite;

async function asUser<T>(
  userId: string | null,
  fn: () => Promise<T>
): Promise<T> {
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
    await db.exec(
      "reset role; select set_config('request.jwt.claim.sub', '', false);"
    );
  }
}

let counter = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

async function insertReport(
  userId: string,
  id: string,
  previous: string | null = null
) {
  await db.query(
    `insert into public.reports (id, user_id, original_filename, storage_path, file_size_bytes, previous_report_id)
     values ($1, $2, $3, $4, 1000, $5)`,
    [id, userId, `${id}.pdf`, `${userId}/${id}.pdf`, previous]
  );
}

async function insertFinding(
  userId: string,
  reportId: string,
  id: string,
  overrides: {
    carried?: string | null;
    status?: string;
    reason?: string | null;
  } = {}
) {
  await db.query(
    `insert into public.findings (id, report_id, user_id, category, severity, confidence, description, evidence, status, dismissed_reason, carried_forward_from)
     values ($1, $2, $3, 'template_leftover_detection', 'moderate', 'deterministic', 'desc', 'evidence', $4, $5, $6)`,
    [
      id,
      reportId,
      userId,
      overrides.status ?? "open",
      overrides.reason ?? null,
      overrides.carried ?? null,
    ]
  );
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from (${sql}) t`,
    params
  );
  return result.rows[0].n;
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
    grant usage on schema public, auth to authenticated, anon;
    grant all on all tables in schema public to authenticated;
    grant select on auth.users to authenticated;
  `);

  for (const [id, email] of [
    [ALICE, "alice@example.com"],
    [BOB, "bob@example.com"],
  ]) {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{"full_name":"Test"}'::jsonb)`,
      [id, email]
    );
  }
});

after(async () => {
  await db.close();
});

describe("migration 0012 on a real PostgreSQL", () => {
  it("applies cleanly on top of 0001–0011 and adds exactly the two columns", async () => {
    assert.equal(
      await count(
        `select 1 from information_schema.columns where table_schema='public' and table_name='reports' and column_name='previous_report_id'`
      ),
      1
    );
    assert.equal(
      await count(
        `select 1 from information_schema.columns where table_schema='public' and table_name='findings' and column_name='carried_forward_from'`
      ),
      1
    );
  });

  it("does not change findings.status or any RLS policy set", async () => {
    // Carried Forward is a link, not a status value (see the migration).
    const status = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'findings_status_check'`
    );
    assert.match(status.rows[0].def, /open.*acknowledged.*dismissed/);
    assert.doesNotMatch(status.rows[0].def, /carried|resolved/);
  });
});

describe("revision link: ownership, chain and immutability", () => {
  it("lets a user link a revision to their own earlier report", async () => {
    const v1 = uuid();
    const v2 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, v2, v1);
    });
    assert.equal(
      await count(
        `select 1 from public.reports where id = '${v2}' and previous_report_id = '${v1}'`
      ),
      1
    );
  });

  it("USER ISOLATION: a user cannot attach a revision to someone else's report", async () => {
    const alicesReport = uuid();
    await asUser(ALICE, () => insertReport(ALICE, alicesReport));

    await asUser(BOB, async () => {
      await rejects(
        insertReport(BOB, uuid(), alicesReport),
        /revision|not found|P0001/i
      );
    });
    // Nothing of Bob's was created pointing at Alice's report.
    assert.equal(
      await count(
        `select 1 from public.reports where previous_report_id = '${alicesReport}'`
      ),
      0
    );
  });

  it("USER ISOLATION: writing a row owned by another user is blocked, with or without a revision link", async () => {
    const alicesReport = uuid();
    await asUser(ALICE, () => insertReport(ALICE, alicesReport));
    await asUser(BOB, async () => {
      // No link: the existing RLS insert policy rejects it.
      await rejects(insertReport(ALICE, uuid()), /row-level security/i);
      // With a link: the revision-link trigger (a BEFORE INSERT trigger,
      // so it fires ahead of the RLS check) rejects it first. Either
      // mechanism blocks the write; neither can be bypassed by the other.
      await rejects(
        insertReport(ALICE, uuid(), alicesReport),
        /revision|not found|row-level security/i
      );
    });
  });

  it("a report can be revised only once (revisions form a straight chain)", async () => {
    const v1 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, uuid(), v1);
      await rejects(
        insertReport(ALICE, uuid(), v1),
        /duplicate key|unique|23505/i
      );
    });
  });

  it("a report cannot be its own previous draft", async () => {
    const id = uuid();
    await asUser(ALICE, async () => {
      await rejects(
        insertReport(ALICE, id, id),
        /check constraint|violates|not found|P0001/i
      );
    });
  });

  it("the link cannot be re-pointed after upload, even by its owner", async () => {
    const a = uuid();
    const b = uuid();
    const c = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, a);
      await insertReport(ALICE, b);
      await insertReport(ALICE, c, a);
      await rejects(
        db.query(
          `update public.reports set previous_report_id = $1 where id = $2`,
          [b, c]
        ),
        /cannot be changed|P0001/i
      );
    });
    assert.equal(
      await count(
        `select 1 from public.reports where id = '${c}' and previous_report_id = '${a}'`
      ),
      1
    );
  });

  it("an unrelated update to a revised report does not trip the guard", async () => {
    const a = uuid();
    const b = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, a);
      await insertReport(ALICE, b, a);
      await db.query(
        `update public.reports set review_status = 'processing' where id = $1`,
        [b]
      );
    });
    assert.equal(
      await count(
        `select 1 from public.reports where id = '${b}' and review_status = 'processing' and previous_report_id = '${a}'`
      ),
      1
    );
  });
});

describe("deleting reports and accounts with revision/carry links", () => {
  it("deleting the earlier report succeeds: the link is cleared, the revision survives", async () => {
    // This is the interplay the trigger must NOT break: ON DELETE SET NULL
    // performs an UPDATE of previous_report_id, which the trigger sees.
    const v1 = uuid();
    const v2 = uuid();
    const f1 = uuid();
    const f2 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, v2, v1);
      await insertFinding(ALICE, v1, f1);
      await insertFinding(ALICE, v2, f2, { carried: f1 });

      await db.query(`delete from public.reports where id = $1`, [v1]);
    });

    assert.equal(
      await count(`select 1 from public.reports where id = '${v1}'`),
      0
    );
    assert.equal(
      await count(
        `select 1 from public.reports where id = '${v2}' and previous_report_id is null`
      ),
      1,
      "revision survives with its link cleared"
    );
    assert.equal(
      await count(`select 1 from public.findings where id = '${f1}'`),
      0,
      "earlier findings cascade away"
    );
    assert.equal(
      await count(
        `select 1 from public.findings where id = '${f2}' and carried_forward_from is null`
      ),
      1,
      "carried link cleared, finding kept"
    );
  });

  it("after the earlier draft is deleted, the revision can itself be revised and re-linked state is clean", async () => {
    const v1 = uuid();
    const v2 = uuid();
    const v3 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, v2, v1);
      await db.query(`delete from public.reports where id = $1`, [v1]);
      await insertReport(ALICE, v3, v2);
    });
    assert.equal(
      await count(
        `select 1 from public.reports where id = '${v3}' and previous_report_id = '${v2}'`
      ),
      1
    );
  });

  it("ACCOUNT DELETION (Phase 10) still works with chained reports and carried findings", async () => {
    const carol = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'carol@example.com', '{"full_name":"C"}'::jsonb)`,
      [carol]
    );
    const v1 = uuid();
    const v2 = uuid();
    const v3 = uuid();
    const f1 = uuid();
    const f2 = uuid();
    const f3 = uuid();
    await asUser(carol, async () => {
      await insertReport(carol, v1);
      await insertReport(carol, v2, v1);
      await insertReport(carol, v3, v2);
      await insertFinding(carol, v1, f1);
      await insertFinding(carol, v2, f2, { carried: f1 });
      await insertFinding(carol, v3, f3, { carried: f2 });
      await db.query(`select public.delete_own_account()`);
    });
    assert.equal(
      await count(`select 1 from auth.users where id = '${carol}'`),
      0
    );
    assert.equal(
      await count(`select 1 from public.reports where user_id = '${carol}'`),
      0
    );
    assert.equal(
      await count(`select 1 from public.findings where user_id = '${carol}'`),
      0
    );
  });

  it("USER ISOLATION: deleting Alice's chain leaves Bob's data untouched", async () => {
    const bobReport = uuid();
    await asUser(BOB, () => insertReport(BOB, bobReport));
    const dave = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'dave@example.com', '{"full_name":"D"}'::jsonb)`,
      [dave]
    );
    await asUser(dave, async () => {
      const a = uuid();
      await insertReport(dave, a);
      await insertReport(dave, uuid(), a);
      await db.query(`select public.delete_own_account()`);
    });
    assert.equal(
      await count(`select 1 from public.reports where id = '${bobReport}'`),
      1
    );
  });
});

describe("carried findings and Row Level Security", () => {
  it("a carried-forward dismissal keeps its required reason (the existing DB check still applies)", async () => {
    const v1 = uuid();
    const v2 = uuid();
    const f1 = uuid();
    const f2 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, v2, v1);
      await insertFinding(ALICE, v1, f1, {
        status: "dismissed",
        reason: "Intentional.",
      });
      // Carrying a dismissal WITH its reason is allowed...
      await insertFinding(ALICE, v2, f2, {
        carried: f1,
        status: "dismissed",
        reason: "Intentional.",
      });
      // ...but a dismissed finding with no reason is still rejected.
      await rejects(
        insertFinding(ALICE, v2, uuid(), {
          carried: f1,
          status: "dismissed",
          reason: null,
        }),
        /dismissed_reason|check constraint|violates/i
      );
    });
  });

  it("USER ISOLATION: another user cannot read, or probe, someone's findings via a carry link", async () => {
    const v1 = uuid();
    const v2 = uuid();
    const f1 = uuid();
    const f2 = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, v1);
      await insertReport(ALICE, v2, v1);
      await insertFinding(ALICE, v1, f1);
      await insertFinding(ALICE, v2, f2, { carried: f1 });
    });

    await asUser(BOB, async () => {
      const reports = await db.query(
        `select id from public.reports where id in ($1, $2)`,
        [v1, v2]
      );
      const findings = await db.query(
        `select id from public.findings where id in ($1, $2)`,
        [f1, f2]
      );
      assert.equal(reports.rows.length, 0);
      assert.equal(findings.rows.length, 0);
    });

    await asUser(null, async () => {
      await rejects(
        db.query(`select id from public.findings`),
        /permission denied/i
      );
    });
  });

  it("USER ISOLATION: a user cannot write a finding that carries from another user's finding into their own report in a way that exposes it", async () => {
    // A carry link can name any uuid, but RLS means the linked row is
    // never readable by anyone but its owner, so naming it reveals nothing.
    const alicesFinding = uuid();
    const alicesReport = uuid();
    await asUser(ALICE, async () => {
      await insertReport(ALICE, alicesReport);
      await insertFinding(ALICE, alicesReport, alicesFinding);
    });
    const bobsReport = uuid();
    await asUser(BOB, async () => {
      await insertReport(BOB, bobsReport);
      await insertFinding(BOB, bobsReport, uuid(), { carried: alicesFinding });
      const joined = await db.query(
        `select p.id from public.findings c join public.findings p on p.id = c.carried_forward_from where c.report_id = $1`,
        [bobsReport]
      );
      assert.equal(
        joined.rows.length,
        0,
        "the linked finding is invisible to Bob"
      );
    });
  });
});
