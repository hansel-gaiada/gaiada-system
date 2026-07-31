// TR-14 — report_periods/report_documents (0067) RLS: tenant isolation + THE THIRD WALL, plus the
// shape requirements that carry correctness weight for sealing (§0057 in the tracker-reporting
// design doc, migrations/README.md §"TR-14" entry for the real migration number).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised
// (a superuser-run migrate() bypasses RLS and would prove nothing — see the migration-backfill-rls
// trap in project memory).
//
// This is a DEDICATED third-wall test file for these two tables, separate from
// module-reports-rls.test.ts (which only covers 0056's three tables). The estate-wide rls.test.ts
// sweep proves tenant isolation for every FORCE-RLS table but CANNOT catch a missing module wall —
// it would pass even if app_module_allowed('reports') were never composed into these two tables'
// policies. This file is that missing guard for report_periods/report_documents specifically.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

const TABLES = ["report_periods", "report_documents"];

// withTenants + declare the reports module scope for the transaction (models
// withTenants([t], {modules:['reports']}) — the app-side wiring TR-15's service will use).
async function withReports<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'reports', true)");
    return fn(c);
  });
}

async function insertPeriod(
  c: PoolClient,
  args: {
    id?: string;
    tenantId: string;
    kind: string;
    start: string;
    end: string;
    label?: string | null;
  },
): Promise<string> {
  const id = args.id ?? newId();
  await c.query(
    `INSERT INTO report_periods (id, tenant_id, period_kind, label, period_start, period_end, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,'central')`,
    [id, args.tenantId, args.kind, args.label ?? null, args.start, args.end],
  );
  return id;
}

describe.skipIf(!TEST_URL)("report_periods / report_documents RLS + shape (0067, TR-14)", () => {
  let B: string; // tenant under test
  let C: string; // unrelated tenant
  let user: string;
  let periodB: string;

  beforeAll(async () => {
    await initTestDb();
    // Deliberately NOT put 'reports' in enabled_modules — the wall is scope-declaration-based
    // (mirrors 0028's HR precedent / 0056's own reports-module suite), not enablement-based.
    B = await createCompany("Tenant B");
    C = await createCompany("Tenant C");
    user = await createUser("sealer@b.test");

    periodB = await withReports([B], (c) =>
      insertPeriod(c, { tenantId: B, kind: "month", start: "2026-07-01", end: "2026-07-31" }),
    );
  });
  afterAll(teardownTestDb);

  // ── FORCE RLS + policy shape (rls.test.ts invariant, proven directly for these two tables) ──────
  it("both tables FORCE RLS", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname = ANY($1)`,
        [TABLES],
      ),
    );
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each table has exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename`,
        [TABLES],
      ),
    );
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── tenant isolation ─────────────────────────────────────────────────────────────────────────────
  it("tenant B's period is visible under withReports([B]) only", async () => {
    const res = await withReports([B], (c) => c.query(`SELECT tenant_id FROM report_periods WHERE id=$1`, [periodB]));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);
  });

  it("B's period is invisible to unrelated tenant C (even with reports scope declared)", async () => {
    const res = await withReports([C], (c) => c.query(`SELECT id FROM report_periods WHERE id=$1`, [periodB]));
    expect(res.rows.length).toBe(0);
  });

  it("cannot INSERT a report_periods row into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withReports([B], (c) => insertPeriod(c, { tenantId: C, kind: "day", start: "2026-08-01", end: "2026-08-01" })),
    ).rejects.toThrow(/row-level security/);
  });

  // ── THE REQUIRED DEDICATED TEST: right tenant WITHOUT the reports module scope -> ZERO rows ─────
  // This is the only guard for the missing-module-wall defect class on THESE two tables specifically
  // — the rls.test.ts sweep proves tenant isolation only and would pass even if
  // app_module_allowed('reports') were never wired into report_periods/report_documents' policies.
  it("right tenant WITHOUT the reports module scope declared -> ZERO rows, on both tables", async () => {
    const periods = await withTenants([B], (c) => c.query(`SELECT id FROM report_periods WHERE id=$1`, [periodB]));
    expect(periods.rows.length).toBe(0);

    for (const t of TABLES) {
      const res = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withTenants([B]) with no reports scope must be zero`).toBe(0);
    }
  });

  it("right tenant with a DIFFERENT module scope (e.g. 'hr') -> ZERO rows", async () => {
    const res = await withTenants([B], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'hr,pm', true)");
      return c.query(`SELECT id FROM report_periods WHERE id=$1`, [periodB]);
    });
    expect(res.rows.length).toBe(0);
  });

  it("WITH CHECK: cannot INSERT into report_periods without declaring the reports scope (write wall)", async () => {
    await expect(
      withTenants([B], (c) => insertPeriod(c, { tenantId: B, kind: "day", start: "2026-09-01", end: "2026-09-01" })),
    ).rejects.toThrow(/row-level security/);
  });

  it("WITH CHECK: cannot INSERT into report_documents without declaring the reports scope (write wall)", async () => {
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
           VALUES (gen_random_uuid(),$1,$2,0,'company',$3,'{}'::jsonb,'central')`,
          [B, periodB, B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── empty tenant set -> zero rows, never an error (0025 fail-closed, preserved) ──────────────────
  it("empty tenant set -> zero rows on both tables, no error (even with reports scope)", async () => {
    for (const t of TABLES) {
      const res = await withReports([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withReports([]) must be empty, not error`).toBe(0);
    }
  });

  // ── ruling (1): origin_site NOT NULL with NO default — proves no silent site mislabeling ────────
  it("origin_site has NO default on report_periods — omitting it fails loudly", async () => {
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_periods (id, tenant_id, period_kind, period_start, period_end)
           VALUES (gen_random_uuid(), $1, 'day', '2026-10-01', '2026-10-01')`,
          [B],
        ),
      ),
    ).rejects.toThrow(/null value in column "origin_site"/);
  });

  it("origin_site has NO default on report_documents — omitting it fails loudly", async () => {
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document)
           VALUES (gen_random_uuid(), $1, $2, 0, 'company', $3, '{}'::jsonb)`,
          [B, periodB, B],
        ),
      ),
    ).rejects.toThrow(/null value in column "origin_site"/);
  });

  // ── ruling (2): composite FK on report_documents.period_id — cross-tenant smuggling impossible ──
  it("report_documents.period_id rejects a period belonging to a DIFFERENT tenant (composite FK)", async () => {
    const periodC = await withReports([C], (c) =>
      insertPeriod(c, { tenantId: C, kind: "month", start: "2026-07-01", end: "2026-07-31" }),
    );
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
           VALUES (gen_random_uuid(), $1, $2, 0, 'company', $3, '{}'::jsonb, 'central')`,
          [B, periodC, B],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "fk_report_documents_period_tenant"/);
  });

  it("report_documents.period_id accepts a period belonging to the SAME tenant", async () => {
    const id = newId();
    const res = await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
         VALUES ($1, $2, $3, 0, 'company', $4, '{}'::jsonb, 'central') RETURNING id`,
        [id, B, periodB, B],
      ),
    );
    expect(res.rows[0].id).toBe(id);
  });

  // ── shape requirement: the custom-label CHECK ─────────────────────────────────────────────────────
  it("a period_kind='custom' row WITHOUT a label is rejected", async () => {
    await expect(
      withReports([B], (c) =>
        insertPeriod(c, { tenantId: B, kind: "custom", start: "2026-11-01", end: "2026-11-15" }),
      ),
    ).rejects.toThrow(/report_periods_custom_needs_label/);
  });

  it("a period_kind='custom' row WITH a label is accepted", async () => {
    const id = await withReports([B], (c) =>
      insertPeriod(c, { tenantId: B, kind: "custom", start: "2026-11-01", end: "2026-11-15", label: "Board pack Nov" }),
    );
    expect(id).toBeTruthy();
  });

  // ── shape requirement THE TWO PARTIAL UNIQUE INDEXES, not one plain UNIQUE ───────────────────────
  describe("the two partial unique indexes (report_periods_calendar_uq / report_periods_custom_uq)", () => {
    it("rejects a second CALENDAR period sharing (tenant, kind, start)", async () => {
      await withReports([B], (c) =>
        insertPeriod(c, { tenantId: B, kind: "week", start: "2026-12-07", end: "2026-12-13" }),
      );
      await expect(
        withReports([B], (c) =>
          // same tenant/kind/start, different end -- must still collide on the calendar index,
          // which keys on (tenant, kind, start) only.
          insertPeriod(c, { tenantId: B, kind: "week", start: "2026-12-07", end: "2026-12-14" }),
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint "report_periods_calendar_uq"/);
    });

    it("accepts TWO custom ranges that share a start date but differ in end date (Jan 1-31 vs Jan 1-Mar 31)", async () => {
      const id1 = await withReports([B], (c) =>
        insertPeriod(c, { tenantId: B, kind: "custom", start: "2027-01-01", end: "2027-01-31", label: "January" }),
      );
      const id2 = await withReports([B], (c) =>
        insertPeriod(c, { tenantId: B, kind: "custom", start: "2027-01-01", end: "2027-03-31", label: "Q1" }),
      );
      expect(id1).not.toBe(id2);
      const res = await withReports([B], (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM report_periods
             WHERE tenant_id=$1 AND period_kind='custom' AND period_start='2027-01-01'`,
          [B],
        ),
      );
      expect(res.rows[0].n).toBe(2);
    });

    it("re-pinning the identical custom range is idempotent (ON CONFLICT on the partial index, no error, no new row)", async () => {
      await withReports([B], (c) =>
        insertPeriod(c, { tenantId: B, kind: "custom", start: "2027-02-01", end: "2027-02-14", label: "Sprint 1" }),
      );
      // Models the pin endpoint's real dedup contract: INSERT ... ON CONFLICT targeting the
      // partial unique index DOES NOT ERROR and does not create a second row.
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_periods (id, tenant_id, period_kind, label, period_start, period_end, origin_site)
           VALUES (gen_random_uuid(), $1, 'custom', 'Sprint 1 (re-pin)', '2027-02-01', '2027-02-14', 'central')
           ON CONFLICT (tenant_id, period_start, period_end) WHERE period_kind = 'custom' DO NOTHING`,
          [B],
        ),
      );
      const res = await withReports([B], (c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM report_periods
             WHERE tenant_id=$1 AND period_kind='custom' AND period_start='2027-02-01' AND period_end='2027-02-14'`,
          [B],
        ),
      );
      expect(res.rows[0].n).toBe(1);
    });

    it("a plain UNIQUE(tenant,kind,start) would have wrongly rejected the two-custom-ranges case (sanity check of the fixture above)", async () => {
      // Belt-and-braces: prove the two rows from the earlier test really do share a start date,
      // so the "two partial indexes, not one plain unique" shape requirement is actually exercised
      // and not accidentally vacuous.
      const res = await withReports([B], (c) =>
        c.query<{ period_end: string }>(
          `SELECT period_end::text FROM report_periods
             WHERE tenant_id=$1 AND period_kind='custom' AND period_start='2027-01-01' ORDER BY period_end`,
          [B],
        ),
      );
      expect(res.rows.map((r) => r.period_end)).toEqual(["2027-01-31", "2027-03-31"]);
    });
  });

  // ── shape requirement: report_documents pins (period_id, revision, grain, scope_ref); amendment
  //    writes a NEW revision alongside the old rows, never an UPDATE ──────────────────────────────
  describe("report_documents revision pinning (amendment writes a new revision, never an UPDATE)", () => {
    it("two revisions of the same (period, grain, scope) coexist as separate rows", async () => {
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
           VALUES (gen_random_uuid(), $1, $2, 1, 'person', $3, '{"v":1}'::jsonb, 'central')`,
          [B, periodB, user],
        ),
      );
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
           VALUES (gen_random_uuid(), $1, $2, 2, 'person', $3, '{"v":2}'::jsonb, 'central')`,
          [B, periodB, user],
        ),
      );
      const res = await withReports([B], (c) =>
        c.query<{ revision: number; document: { v: number } }>(
          `SELECT revision, document FROM report_documents
             WHERE tenant_id=$1 AND period_id=$2 AND grain='person' AND scope_ref=$3
             ORDER BY revision`,
          [B, periodB, user],
        ),
      );
      expect(res.rows.map((r) => r.revision)).toEqual([1, 2]);
      expect(res.rows.map((r) => r.document.v)).toEqual([1, 2]);
    });

    it("rejects a second document at the SAME (period, revision, grain, scope) key", async () => {
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
           VALUES (gen_random_uuid(), $1, $2, 5, 'company', $3, '{}'::jsonb, 'central')`,
          [B, periodB, B],
        ),
      );
      await expect(
        withReports([B], (c) =>
          c.query(
            `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, origin_site)
             VALUES (gen_random_uuid(), $1, $2, 5, 'company', $3, '{}'::jsonb, 'central')`,
            [B, periodB, B],
          ),
        ),
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
    });
  });

  // ── ux_report_periods_id_tenant exists and is the composite-FK target ───────────────────────────
  it("ux_report_periods_id_tenant is a real UNIQUE constraint on (id, tenant_id)", async () => {
    const res = await withGlobal((c) =>
      c.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
           WHERE conrelid = 'report_periods'::regclass AND contype = 'u' AND conname = 'ux_report_periods_id_tenant'`,
      ),
    );
    expect(res.rows.length).toBe(1);
  });
});
