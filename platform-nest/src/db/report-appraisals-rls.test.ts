// TR-23 — report_appraisal_cycles / report_appraisals / report_appraisal_acks (0068) RLS: tenant
// isolation + THE THIRD WALL, plus the shape requirements that carry ETHICAL weight for this
// program's most consequential surface (§5.2 anti-gaming design, §11 privacy & ethics, §15
// amendment log — see migration 0068's header for the full reasoning behind each shape decision).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised
// (a superuser-run migrate() bypasses RLS and would prove nothing — see the migration-backfill-rls
// trap in project memory).
//
// This is a DEDICATED third-wall test file for these three tables, separate from
// module-reports-rls.test.ts (0056's three tables) and report-periods-rls.test.ts (0067's two).
// The estate-wide rls.test.ts sweep proves tenant isolation for every FORCE-RLS table but CANNOT
// catch a missing module wall — it would pass even if app_module_allowed('reports') were never
// composed into these three tables' policies. This file is that missing guard, on all three tables.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { PoolClient } from "pg";

const TABLES = ["report_appraisal_cycles", "report_appraisals", "report_appraisal_acks"];

// withTenants + declare the reports module scope for the transaction (models
// withTenants([t], {modules:['reports']}) — the app-side wiring TR-24's engine will use).
async function withReports<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'reports', true)");
    return fn(c);
  });
}

async function insertPeriod(
  c: PoolClient,
  args: { tenantId: string; kind?: string; start: string; end: string },
): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO report_periods (id, tenant_id, period_kind, period_start, period_end, origin_site)
     VALUES ($1,$2,$3,$4,$5,'central')`,
    [id, args.tenantId, args.kind ?? "month", args.start, args.end],
  );
  return id;
}

async function insertCycle(
  c: PoolClient,
  args: { tenantId: string; createdBy: string; name?: string; start?: string; end?: string },
): Promise<string> {
  const id = newId();
  await c.query(
    `INSERT INTO report_appraisal_cycles (id, tenant_id, name, period_start, period_end, created_by, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,'central')`,
    [id, args.tenantId, args.name ?? "2026 H2", args.start ?? "2026-07-01", args.end ?? "2026-12-31", args.createdBy],
  );
  return id;
}

const COMMENTARY_50 = "Consistently delivered on time with high quality and strong collaboration.";

async function insertAppraisal(
  c: PoolClient,
  args: {
    id?: string;
    tenantId: string;
    cycleId: string;
    subjectUserId: string;
    managerUserId: string;
    periodId: string;
    revision?: number;
    status?: string;
    commentary?: string | null;
  },
): Promise<string> {
  const id = args.id ?? newId();
  await c.query(
    `INSERT INTO report_appraisals
       (id, tenant_id, cycle_id, subject_user_id, manager_user_id, weights, period_id, revision, status, commentary, origin_site)
     VALUES ($1,$2,$3,$4,$5,'{"delivery":0.35,"quality":0.30,"effort":0.10,"collaboration":0.25}'::jsonb,$6,$7,$8,$9,'central')`,
    [
      id,
      args.tenantId,
      args.cycleId,
      args.subjectUserId,
      args.managerUserId,
      args.periodId,
      args.revision ?? 0,
      args.status ?? "draft",
      args.commentary ?? null,
    ],
  );
  return id;
}

describe.skipIf(!TEST_URL)("report_appraisal_* RLS + shape (0068, TR-23)", () => {
  let B: string; // tenant under test
  let C: string; // unrelated tenant
  let hrAdmin: string;
  let subject: string;
  let manager: string;
  let periodB: string;
  let cycleB: string;

  beforeAll(async () => {
    await initTestDb();
    // Deliberately NOT put 'reports' in enabled_modules — the wall is scope-declaration-based
    // (mirrors 0028/0056/0067's own precedent), not enablement-based.
    B = await createCompany("Tenant B");
    C = await createCompany("Tenant C");
    hrAdmin = await createUser("hr-admin@b.test");
    subject = await createUser("subject@b.test");
    manager = await createUser("manager@b.test");

    periodB = await withReports([B], (c) => insertPeriod(c, { tenantId: B, start: "2026-07-01", end: "2026-07-31" }));
    cycleB = await withReports([B], (c) => insertCycle(c, { tenantId: B, createdBy: hrAdmin }));
  });
  afterAll(teardownTestDb);

  // `report_appraisals` has UNIQUE(tenant_id, cycle_id, subject_user_id) — a real, correctly-working
  // constraint (one appraisal per subject per cycle). Every test below that needs a SUCCESSFUL
  // insert against the fixed `subject` user therefore needs its OWN cycle, never the shared `cycleB`
  // (which is reserved for the tests that exercise the cycles table itself / deliberately-rejected
  // insert attempts, where the transaction never commits a row anyway).
  async function freshCycle(): Promise<string> {
    return withReports([B], (c) => insertCycle(c, { tenantId: B, createdBy: hrAdmin, name: `cycle-${newId()}` }));
  }

  // ── (c) rls.test.ts invariant: every table FORCE RLS ──────────────────────────────────────────
  it("all three report_appraisal_* tables FORCE RLS (rls.test.ts sweep invariant)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE relkind='r' AND relname = ANY($1)`,
        [TABLES],
      ),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each table has exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1) ORDER BY tablename`,
        [TABLES],
      ),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── tenant isolation ──────────────────────────────────────────────────────────────────────────
  it("tenant B's cycle is visible under withReports([B]) only", async () => {
    const res = await withReports([B], (c) => c.query(`SELECT tenant_id FROM report_appraisal_cycles WHERE id=$1`, [cycleB]));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);
  });

  it("B's cycle is invisible to unrelated tenant C (even with reports scope declared)", async () => {
    const res = await withReports([C], (c) => c.query(`SELECT id FROM report_appraisal_cycles WHERE id=$1`, [cycleB]));
    expect(res.rows.length).toBe(0);
  });

  it("cannot INSERT a report_appraisal_cycles row into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withReports([B], (c) => insertCycle(c, { tenantId: C, createdBy: hrAdmin })),
    ).rejects.toThrow(/row-level security/);
  });

  // ── THE REQUIRED DEDICATED TEST: right tenant WITHOUT the reports module scope -> ZERO rows,
  //    on ALL THREE tables ─────────────────────────────────────────────────────────────────────
  it("right tenant WITHOUT the reports module scope declared -> ZERO rows, on all three tables", async () => {
    const cycles = await withTenants([B], (c) => c.query(`SELECT id FROM report_appraisal_cycles WHERE id=$1`, [cycleB]));
    expect(cycles.rows.length).toBe(0);

    for (const t of TABLES) {
      const res = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withTenants([B]) with no reports scope must be zero`).toBe(0);
    }
  });

  it("right tenant with a DIFFERENT module scope (e.g. 'hr') -> ZERO rows, on all three tables", async () => {
    for (const t of TABLES) {
      const res = await withTenants([B], async (c) => {
        await c.query("SELECT set_config('app.scopes', 'hr,pm', true)");
        return c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
      });
      expect(res.rows[0].n, `${t} under 'hr,pm' scope (not 'reports') must be zero`).toBe(0);
    }
  });

  it("WITH CHECK: cannot INSERT into any of the three tables without declaring the reports scope (write wall)", async () => {
    await expect(
      withTenants([B], (c) => insertCycle(c, { tenantId: B, createdBy: hrAdmin, name: "unscoped" })),
    ).rejects.toThrow(/row-level security/);

    await expect(
      withTenants([B], (c) => insertAppraisal(c, { tenantId: B, cycleId: cycleB, subjectUserId: subject, managerUserId: manager, periodId: periodB })),
    ).rejects.toThrow(/row-level security/);

    const cycleForAckCheck = await freshCycle();
    const appraisalForAck = await withReports([B], (c) =>
      insertAppraisal(c, { tenantId: B, cycleId: cycleForAckCheck, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
    );
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
           VALUES (gen_random_uuid(),$1,$2,$3,'acknowledged','central')`,
          [B, appraisalForAck, subject],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── empty tenant set -> zero rows, never an error (0025 fail-closed, preserved) ─────────────────
  it("empty tenant set -> zero rows on every table, no error (even with reports scope)", async () => {
    for (const t of TABLES) {
      const res = await withReports([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withReports([]) must be empty, not error`).toBe(0);
    }
  });

  // ── ruling (1): origin_site NOT NULL with NO default ────────────────────────────────────────────
  it("origin_site has NO default on report_appraisal_cycles — omitting it fails loudly", async () => {
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_cycles (id, tenant_id, name, period_start, period_end, created_by)
           VALUES (gen_random_uuid(), $1, 'no origin', '2027-01-01', '2027-06-30', $2)`,
          [B, hrAdmin],
        ),
      ),
    ).rejects.toThrow(/null value in column "origin_site"/);
  });

  // ── ruling (2): composite FK cycle_id — cross-tenant attribution smuggling is impossible ────────
  it("report_appraisals.cycle_id rejects a cycle belonging to a DIFFERENT tenant (composite FK)", async () => {
    const cycleC = await withReports([C], (c) => insertCycle(c, { tenantId: C, createdBy: hrAdmin }));
    await expect(
      withReports([B], (c) =>
        insertAppraisal(c, { tenantId: B, cycleId: cycleC, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
      ),
    ).rejects.toThrow(/violates foreign key constraint "fk_report_appraisals_cycle_tenant"/);
  });

  it("report_appraisals.cycle_id accepts a cycle belonging to the SAME tenant", async () => {
    const cycle = await freshCycle();
    const id = await withReports([B], (c) =>
      insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
    );
    expect(id).toBeTruthy();
  });

  // ── composite FK period_id — cross-tenant smuggling impossible, proven both ways ────────────────
  it("report_appraisals.period_id rejects a period belonging to a DIFFERENT tenant (composite FK)", async () => {
    const periodC = await withReports([C], (c) => insertPeriod(c, { tenantId: C, start: "2026-07-01", end: "2026-07-31" }));
    await expect(
      withReports([B], (c) =>
        insertAppraisal(c, { tenantId: B, cycleId: cycleB, subjectUserId: subject, managerUserId: manager, periodId: periodC }),
      ),
    ).rejects.toThrow(/violates foreign key constraint "fk_report_appraisals_period_tenant"/);
  });

  it("report_appraisals.period_id accepts a period belonging to the SAME tenant", async () => {
    const cycle = await freshCycle();
    const id = await withReports([B], (c) =>
      insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
    );
    expect(id).toBeTruthy();
  });

  // ── composite FK appraisal_id (acks) — cross-tenant smuggling impossible, proven both ways ──────
  it("report_appraisal_acks.appraisal_id rejects an appraisal belonging to a DIFFERENT tenant (composite FK)", async () => {
    const subjectC = await createUser("subject@c.test");
    const managerC = await createUser("manager@c.test");
    const hrC = await createUser("hr@c.test");
    const cycleC = await withReports([C], (c) => insertCycle(c, { tenantId: C, createdBy: hrC }));
    const periodC = await withReports([C], (c) => insertPeriod(c, { tenantId: C, start: "2026-08-01", end: "2026-08-31" }));
    const appraisalC = await withReports([C], (c) =>
      insertAppraisal(c, { tenantId: C, cycleId: cycleC, subjectUserId: subjectC, managerUserId: managerC, periodId: periodC }),
    );
    await expect(
      withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
           VALUES (gen_random_uuid(), $1, $2, $3, 'acknowledged', 'central')`,
          [B, appraisalC, subject],
        ),
      ),
    ).rejects.toThrow(/violates foreign key constraint "fk_report_appraisal_acks_appraisal_tenant"/);
  });

  it("report_appraisal_acks.appraisal_id accepts an appraisal belonging to the SAME tenant", async () => {
    const cycle = await freshCycle();
    const appraisalB = await withReports([B], (c) =>
      insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
    );
    const res = await withReports([B], (c) =>
      c.query(
        `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
         VALUES (gen_random_uuid(), $1, $2, $3, 'acknowledged', 'central') RETURNING id`,
        [B, appraisalB, subject],
      ),
    );
    expect(res.rows.length).toBe(1);
  });

  // ── THE MANDATORY-COMMENTARY CHECK — proven by test, both the rejection and the acceptance ──────
  describe("mandatory commentary CHECK (report_appraisals_commentary_required)", () => {
    it("a DRAFT row with no commentary is accepted (draft is exempt)", async () => {
      const cycle = await freshCycle();
      const id = await withReports([B], (c) =>
        insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB, status: "draft", commentary: null }),
      );
      expect(id).toBeTruthy();
    });

    it("a SUBMITTED row with NO commentary is REJECTED (commentary-free non-draft is structurally impossible)", async () => {
      const cycle = await freshCycle();
      await expect(
        withReports([B], (c) =>
          insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB, status: "submitted", commentary: null }),
        ),
      ).rejects.toThrow(/report_appraisals_commentary_required/);
    });

    it("a SUBMITTED row with commentary UNDER 50 chars (after trim) is REJECTED", async () => {
      const cycle = await freshCycle();
      await expect(
        withReports([B], (c) =>
          insertAppraisal(c, {
            tenantId: B,
            cycleId: cycle,
            subjectUserId: subject,
            managerUserId: manager,
            periodId: periodB,
            status: "submitted",
            commentary: "   too short   ",
          }),
        ),
      ).rejects.toThrow(/report_appraisals_commentary_required/);
    });

    it("a SUBMITTED row with commentary >= 50 chars (after trim) is ACCEPTED", async () => {
      const cycle = await freshCycle();
      const id = await withReports([B], (c) =>
        insertAppraisal(c, {
          tenantId: B,
          cycleId: cycle,
          subjectUserId: subject,
          managerUserId: manager,
          periodId: periodB,
          status: "submitted",
          commentary: COMMENTARY_50,
        }),
      );
      expect(id).toBeTruthy();
    });
  });

  // ── THE APPEND-ONLY ACK TRAIL — proven by test: coexistence + UPDATE/DELETE rejection ────────────
  describe("append-only ack trail (report_appraisal_acks)", () => {
    let appraisalForAcks: string;

    beforeAll(async () => {
      const cycle = await freshCycle();
      appraisalForAcks = await withReports([B], (c) =>
        insertAppraisal(c, { tenantId: B, cycleId: cycle, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
      );
    });

    it("two acks on the same appraisal coexist as separate rows (acknowledged then disputed)", async () => {
      const ack1 = newId();
      const ack2 = newId();
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
           VALUES ($1,$2,$3,$4,'acknowledged','central')`,
          [ack1, B, appraisalForAcks, subject],
        ),
      );
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, comment, origin_site)
           VALUES ($1,$2,$3,$4,'disputed',$5,'central')`,
          [ack2, B, appraisalForAcks, subject, "actually I disagree with the quality score"],
        ),
      );
      const res = await withReports([B], (c) =>
        c.query<{ id: string; action: string }>(
          `SELECT id, action FROM report_appraisal_acks WHERE appraisal_id=$1 ORDER BY created_at`,
          [appraisalForAcks],
        ),
      );
      expect(res.rows.map((r) => r.id)).toEqual([ack1, ack2]);
      expect(res.rows.map((r) => r.action)).toEqual(["acknowledged", "disputed"]);
    });

    it("UPDATE on an existing ack row is REJECTED by the append-only trigger", async () => {
      const ackId = newId();
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
           VALUES ($1,$2,$3,$4,'acknowledged','central')`,
          [ackId, B, appraisalForAcks, subject],
        ),
      );
      await expect(
        withReports([B], (c) =>
          c.query(`UPDATE report_appraisal_acks SET action = 'disputed' WHERE id = $1`, [ackId]),
        ),
      ).rejects.toThrow(/report_appraisal_acks is append-only/);
    });

    it("DELETE on an existing ack row is REJECTED by the append-only trigger", async () => {
      const ackId = newId();
      await withReports([B], (c) =>
        c.query(
          `INSERT INTO report_appraisal_acks (id, tenant_id, appraisal_id, actor_user_id, action, origin_site)
           VALUES ($1,$2,$3,$4,'acknowledged','central')`,
          [ackId, B, appraisalForAcks, subject],
        ),
      );
      await expect(
        withReports([B], (c) => c.query(`DELETE FROM report_appraisal_acks WHERE id = $1`, [ackId])),
      ).rejects.toThrow(/report_appraisal_acks is append-only/);
    });
  });

  // ── shape requirement: one appraisal per (cycle, subject) ───────────────────────────────────────
  it("rejects a second appraisal for the same (tenant, cycle, subject)", async () => {
    const cycle2 = await withReports([B], (c) => insertCycle(c, { tenantId: B, createdBy: hrAdmin, name: "dedicated-uq-cycle" }));
    await withReports([B], (c) =>
      insertAppraisal(c, { tenantId: B, cycleId: cycle2, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
    );
    await expect(
      withReports([B], (c) =>
        insertAppraisal(c, { tenantId: B, cycleId: cycle2, subjectUserId: subject, managerUserId: manager, periodId: periodB }),
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});
