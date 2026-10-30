// SCP-5 W5-A1 — 202610301300_social_reports_periodic.sql (BFF §63.24.2, with §63.24.1, §63.24.5, §63.24.9 and §63.30.3's rules_ref)
// against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it (the file-text checks at the top always run). initTestDb() hands us
// a fully migrated database of our own (a copy of the template); the CHECKs, keys and FKs are proved through the superuser pool, which
// bypasses RLS but never a CHECK, a NOT NULL, a unique index or a foreign key; the WALL is proved through `withTenants` / `withGlobal`
// (the runtime role, which RLS binds).
//
// Proves: the file applies onto existing monthly, campaign and adhoc rows (a repeated monthly period and NULL periods among them) and
// changes none of them, and applies again cleanly; the kind CHECK swap keeps every kind the old CHECK admitted and refuses to replace
// a CHECK it does not understand; every CHECK refuses its bad combination and admits its good one, the NULL cases written out; each
// kind's period format; the partial UNIQUEs (and NULLs and the old kinds not colliding); the composite FK refuses another company's
// schedule; an unset tenant GUC reads ZERO rows with no error; the third wall.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createClient, createCompany, createUser } from "../testing/fixtures";
import { APP_ROLE } from "../testing/db-names";
import { socialModule } from "../modules/social/index";

const FILE = "202610301300_social_reports_periodic.sql";
const PATH = join(__dirname, "..", "..", "migrations", FILE);
const TABLES = ["social_report_schedules", "social_report_runs"] as const;
const EIGHT = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly", "campaign", "adhoc"];

describe("SCP-5 W5-A1 · the migration file (no database needed)", () => {
  it("is registered in the social module after the wave-5 files before it, in landing order", () => {
    const m = socialModule.migrations as string[];
    const at = m.indexOf(FILE);
    expect(at).toBeGreaterThan(m.indexOf("202610301201_social_settings_onboarding.sql"));
    expect(at).toBeGreaterThan(m.indexOf("202610301000_social_rules.sql"));
    expect(m.indexOf("202610301201_social_settings_onboarding.sql")).toBeGreaterThanOrEqual(0);
  });

  it("holds no data change, no grant and no ledger write, takes the third wall, and is LF only", () => {
    const sql = readFileSync(PATH, "utf8");
    const code = sql.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");
    expect(code).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(code).not.toMatch(/^\s*UPDATE\s+\S+\s+SET\b/im);
    expect(code).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(code).not.toMatch(/set_config|current_tenant_ids/i);
    expect(code).toMatch(/USING \(tenant_id = ANY\(app_current_tenants\(\)\) AND app_module_allowed\(''social''\)\)/);
    expect(code).toMatch(/WITH CHECK \(tenant_id = ANY\(app_current_tenants\(\)\) AND app_module_allowed\(''social''\)\)/);
    expect(code).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/\r/);
  });
});

describe.skipIf(!TEST_URL)("SCP-5 W5-A1 · social_reports_periodic", () => {
  let A: string;
  let C: string;
  let user: string;
  let user2: string;
  let engA: string;
  let engA2: string;
  let engC: string;
  const db = () => adminPool();
  const q = (sql: string, params: unknown[] = []) => db().query(sql, params);
  const apply = () => q(readFileSync(PATH, "utf8"));
  const refusedWith = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
  };
  const CHECK = "23514";
  const NOT_NULL = "23502";
  const FK = "23503";
  const UNIQUE = "23505";
  let seq = 0;
  /** A fresh four-digit year, so rows that must not collide never do. */
  const year = () => String(1000 + ++seq);

  async function engagement(tenant: string, name: string): Promise<string> {
    const id = newId();
    const client = await createClient(tenant, name);
    await q(`INSERT INTO social_engagements (id, tenant_id, client_id, name) VALUES ($1, $2, $3, 'Mock engagement')`, [id, tenant, client]);
    return id;
  }
  /** A row of `table` from the default columns, `over` replacing columns by SQL literals ("NULL" writes NULL). */
  async function insert(table: string, base: Record<string, string>, over: Record<string, string>): Promise<string> {
    const id = newId();
    const cols: Record<string, string> = { id: `'${id}'`, ...base, ...over };
    await q(`INSERT INTO ${table} (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`);
    return id;
  }
  const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);
  const report = (kind: string, period: string | null, over: Record<string, string> = {}) =>
    insert("social_reports", { tenant_id: `'${A}'`, engagement_id: `'${engA}'`, kind: lit(kind), period: lit(period) }, over);
  const sched = (over: Record<string, string> = {}) =>
    insert("social_report_schedules", { tenant_id: `'${A}'`, owner_id: `'${user}'`, kind: "'weekly'", scope: "'chosen'",
      engagement_ids: `ARRAY['${engA}']::uuid[]`, timing: `'{"weekday": 1, "at": "08:00"}'::jsonb`, next_run_at: "now() + interval '1 day'",
      next_period: "'2026-W46'", updated_by: `'${user}'` }, over);
  /** A paused schedule's columns: off, the reason, when, who (a manual pause only), no next run. */
  const paused = (reason: string, by: string | null): Record<string, string> => ({ enabled: "false", paused_reason: `'${reason}'`,
    paused_at: "now()", paused_by: by ? `'${by}'` : "NULL", next_run_at: "NULL", next_period: "NULL" });
  const run = (over: Record<string, string> = {}) =>
    insert("social_report_runs", { tenant_id: `'${A}'`, kind: "'yearly'", period: `'${year()}'`, requested_by: `'${user}'`,
      rules_ref: "'company:1'", total: "3" }, over);
  const done = (): Record<string, string> => ({ status: "'done'", started_at: "now()", finished_at: "now()", done_count: "3" });

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Mock Agency", ["social"]);
    C = await createCompany("Mock Other", ["social"]);
    user = await createUser("w5a1-mig@mock.test", "Mock Lead");
    user2 = await createUser("w5a1-mig2@mock.test", "Mock Head");
    engA = await engagement(A, "Mock Client A");
    engA2 = await engagement(A, "Mock Client A2");
    engC = await engagement(C, "Mock Client C");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  // ── Rollout: the file lands on a database that already holds reports of the old kinds, and changes none of them ────────────
  it("applies onto existing monthly, campaign and adhoc rows (objects dropped first), changes none of them, and applies again", async () => {
    // Back to the state before W5-A1: 0105's kind CHECK, no period CHECKs, no next_period, no report_kinds, no new tables.
    await q(`DROP TABLE social_report_runs, social_report_schedules CASCADE`);
    await q(`DROP INDEX ux_social_reports_periodic`);
    await q(`ALTER TABLE social_reports DROP CONSTRAINT social_reports_period_ck, DROP CONSTRAINT social_reports_next_period_ck,
               DROP COLUMN next_period, DROP CONSTRAINT social_reports_kind_ck,
               ADD CONSTRAINT social_reports_kind_check CHECK (kind IN ('monthly','campaign','adhoc'))`);
    await q(`ALTER TABLE social_engagements DROP COLUMN report_kinds`);
    // The live shapes SMM-23 and SCP-5a left: a monthly, the same monthly period twice, NULL periods, a free-text campaign period.
    await report("monthly", "2026-09");
    await report("monthly", "2026-09");
    await report("monthly", null);
    await report("campaign", "Launch week");
    await report("adhoc", null);
    await report("adhoc", "2026-W54");

    const snapshot = async () => ({
      reports: (await q(`SELECT to_jsonb(r) - 'next_period' AS j FROM social_reports r ORDER BY id`)).rows.map((r) => r.j),
      engagements: (await q(`SELECT to_jsonb(e) - 'report_kinds' AS j FROM social_engagements e ORDER BY id`)).rows.map((r) => r.j),
    });
    const before = await snapshot();
    expect(before.reports.length).toBeGreaterThanOrEqual(6);
    await apply(); // the file's own DO block asserts its catalogue
    // The harness grants the runtime role DML on every table once, after the template migrates; tables re-created here by the
    // superuser get no such grant, so restore exactly that harness step (live grants come from the owner's default privileges).
    await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON social_report_schedules, social_report_runs TO ${APP_ROLE}`);
    expect(await snapshot()).toEqual(before);
    expect((await q(`SELECT count(*)::int AS n FROM social_reports WHERE next_period IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM social_engagements WHERE report_kinds <> '{}'::text[]`)).rows[0].n).toBe(0);
    await apply();
    expect(await snapshot()).toEqual(before);

    // Exactly one CHECK on `kind` alone, admitting the eight; 0105's is gone.
    const checks = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'social_reports'::regclass AND contype = 'c'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'social_reports'::regclass AND attname = 'kind')]`)).rows;
    expect(checks).toEqual([{ conname: "social_reports_kind_ck" }]);
  });

  it("replaces the old kind CHECK only when it understands it and keeps every kind it admitted; otherwise nothing changes", async () => {
    const swapTo = (def: string) =>
      q(`ALTER TABLE social_reports DROP CONSTRAINT social_reports_kind_ck, ADD CONSTRAINT social_reports_kind_check CHECK (${def})`);
    const restore = () => q(`ALTER TABLE social_reports DROP CONSTRAINT social_reports_kind_check,
        ADD CONSTRAINT social_reports_kind_ck CHECK (kind IN ('daily','weekly','monthly','quarterly','semester','yearly','campaign','adhoc'))`);
    const names = async () => (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'social_reports'::regclass
        AND conname IN ('social_reports_kind_check', 'social_reports_kind_ck') ORDER BY conname`)).rows.map((r) => r.conname);

    // A list holding a kind the new CHECK would drop: refused, the old CHECK kept (one implicit transaction).
    await swapTo(`kind IN ('monthly','campaign','adhoc','legacy')`);
    await expect(apply()).rejects.toThrow(/admits a kind the new list would drop/);
    expect(await names()).toEqual(["social_reports_kind_check"]);
    await restore();
    // A shape it does not understand: refused too.
    await swapTo(`kind <> 'retired'`);
    await expect(apply()).rejects.toThrow(/unexpected shape/);
    expect(await names()).toEqual(["social_reports_kind_check"]);
    await restore();
    // Restored, the file applies cleanly again (0105's own three-value list being replaced is the rollout test above).
    await apply();
    expect(await names()).toEqual(["social_reports_kind_ck"]);
  });

  // ── social_reports ────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_reports", () => {
    it("admits the eight kinds and refuses any other; kind is NOT NULL", async () => {
      const periods: Record<string, string | null> = { daily: "2026-11-09", weekly: "2026-W45", monthly: "2026-11", quarterly: "2026-Q3",
        semester: "2026-H1", yearly: "2024", campaign: "Launch", adhoc: null };
      for (const k of EIGHT) await report(k, periods[k], { engagement_id: `'${engA2}'` });
      for (const bad of ["biweekly", "Monthly", "", "half_year"]) await refusedWith(report(bad, "2026"), CHECK);
      await refusedWith(insert("social_reports", { tenant_id: `'${A}'`, engagement_id: `'${engA}'`, kind: "NULL" }, {}), NOT_NULL);
    });

    it("each new kind takes only its period format, and a NULL period fails for each of them", async () => {
      const cases: Record<string, { good: string[]; bad: (string | null)[] }> = {
        // The format only: whether the day exists (Feb 31) is the route's check.
        daily: { good: ["2026-11-09", "2026-01-31", "2026-12-01", "2026-02-31"],
          bad: [null, "", "2026-11-9", "2026-13-01", "2026-00-10", "2026-11-32", "2026-11-00", "20261109", "2026-11-09 ", "2026-11"] },
        weekly: { good: ["2026-W01", "2026-W09", "2026-W10", "2026-W53"],
          bad: [null, "", "2026-W54", "2026-W00", "2026-W1", "2026W01", "2026-w01", "2026-W60", "2026-11"] },
        quarterly: { good: ["2026-Q1", "2026-Q4"], bad: [null, "", "2026-Q5", "2026-Q0", "2026Q1", "2026-q1", "2026-Q12"] },
        semester: { good: ["2026-H1", "2026-H2"], bad: [null, "", "2026-H3", "2026-H0", "2026H1", "2026-h1"] },
        yearly: { good: ["2026", "1999"], bad: [null, "", "26", "20266", "2026-01", " 2026"] },
      };
      for (const [kind, { good, bad }] of Object.entries(cases)) {
        for (const p of good) await report(kind, p, { engagement_id: `'${engA2}'`, deleted_at: "now()" });
        for (const p of bad) await refusedWith(report(kind, p), CHECK);
      }
    });

    it("monthly, campaign and adhoc keep any period, NULL included (SMM-23's live rows)", async () => {
      for (const k of ["monthly", "campaign", "adhoc"]) {
        for (const p of [null, "", "2026-11", "2026-W54", "Launch week", "26"]) await report(k, p);
      }
    });

    it("next_period: only on daily and weekly, at most 1,000 characters", async () => {
      await report("daily", "2026-10-01", { next_period: `'${"n".repeat(1000)}'` });
      await report("weekly", "2026-W40", { next_period: "'Two reels and a carousel'" });
      await report("daily", "2026-10-02", { next_period: "NULL" });
      await refusedWith(report("daily", "2026-10-03", { next_period: `'${"n".repeat(1001)}'` }), CHECK);
      for (const [k, p] of [["monthly", "2026-10"], ["quarterly", "2025-Q1"], ["semester", "2025-H1"], ["yearly", "2023"],
        ["campaign", "Launch"], ["adhoc", null]] as const) {
        await refusedWith(report(k, p, { next_period: "'Next time'" }), CHECK);
      }
    });

    it("one live report per client, kind and period for the five new kinds; a deleted one, another client or period do not collide", async () => {
      for (const [k, p] of [["daily", "2026-08-03"], ["weekly", "2026-W31"], ["quarterly", "2025-Q2"], ["semester", "2025-H2"], ["yearly", "2022"]]) {
        const first = await report(k, p);
        await refusedWith(report(k, p), UNIQUE);
        await report(k, p, { engagement_id: `'${engA2}'` });
        await insert("social_reports", { tenant_id: `'${C}'`, engagement_id: `'${engC}'`, kind: lit(k), period: lit(p) }, {});
        await q(`UPDATE social_reports SET deleted_at = now() WHERE id = $1`, [first]);
        await report(k, p);
        await refusedWith(report(k, p), UNIQUE);
      }
      // Two kinds with the same text never collide either (the kind is in the key).
      await report("yearly", "2021");
      await report("adhoc", "2021");
      await report("adhoc", "2021");
    });

    it("the index covers no monthly, campaign or adhoc row: those may repeat a period", async () => {
      for (const k of ["monthly", "campaign", "adhoc"]) {
        await report(k, "2026-07");
        await report(k, "2026-07");
      }
      const def = (await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_social_reports_periodic'`)).rows[0].indexdef as string;
      expect(def).toMatch(/WHERE \(\(kind = ANY \(ARRAY\['daily'::text, 'weekly'::text, 'quarterly'::text, 'semester'::text, 'yearly'::text\]\)\) AND \(deleted_at IS NULL\)\)/);
    });
  });

  // ── social_engagements.report_kinds ──────────────────────────────────────────────────────────────────────────────────────────
  describe("social_engagements.report_kinds", () => {
    it("defaults to none; takes any subset of the five periodic kinds", async () => {
      const e = await engagement(A, "Mock Client Kinds");
      expect((await q(`SELECT report_kinds FROM social_engagements WHERE id = $1`, [e])).rows[0].report_kinds).toEqual([]);
      for (const ok of ["{}", "{weekly}", "{daily,weekly,quarterly,semester,yearly}"]) {
        await q(`UPDATE social_engagements SET report_kinds = $1::text[] WHERE id = $2`, [ok, e]);
      }
    });

    it("refuses the monthly (always due), the other kinds, an unknown one, a NULL element and NULL", async () => {
      for (const bad of ["{monthly}", "{weekly,campaign}", "{adhoc}", "{fortnightly}", "{Weekly}", "{weekly,NULL}", "{NULL}"]) {
        await refusedWith(q(`UPDATE social_engagements SET report_kinds = $1::text[] WHERE id = $2`, [bad, engA2]), CHECK);
      }
      await refusedWith(q(`UPDATE social_engagements SET report_kinds = NULL WHERE id = $1`, [engA2]), NOT_NULL);
    });
  });

  // ── social_report_schedules ─────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_report_schedules", () => {
    it("admits each good shape: chosen, all, the six kinds, paused by hand or by the job, a last run, a soft delete", async () => {
      const id = await sched();
      const r = (await q(`SELECT enabled, engagement_ids, paused_reason, last_run_at FROM social_report_schedules WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ enabled: true, engagement_ids: [engA], paused_reason: null, last_run_at: null });
      const next: Record<string, string> = { daily: "2026-11-09", weekly: "2026-W45", monthly: "2026-10", quarterly: "2026-Q3",
        semester: "2026-H1", yearly: "2025" };
      for (const [k, p] of Object.entries(next)) await sched({ kind: `'${k}'`, next_period: `'${p}'`, last_run_at: "now()", last_period: `'${p}'` });
      await sched({ kind: "'monthly'", scope: "'all'", engagement_ids: "'{}'::uuid[]", next_period: "'2026-10'",
        timing: `'{"on": "working_day", "n": 3, "at": "08:00"}'::jsonb` });
      await sched(paused("manual", user2));
      for (const reason of ["owner_not_allowed", "owner_inactive", "kind_off", "ai_drafting_off"]) await sched(paused(reason, null));
      await sched({ engagement_ids: `ARRAY[${Array.from({ length: 200 }, () => `'${newId()}'`).join(", ")}]::uuid[]` });
      await sched({ deleted_at: "now()", deleted_by: `'${user}'` });
    });

    it("refuses a bad kind, scope, timing or pause reason, and the NULL ones", async () => {
      for (const k of ["'campaign'", "'adhoc'", "'hourly'"]) await refusedWith(sched({ kind: k }), CHECK);
      await refusedWith(sched({ scope: "'some'" }), CHECK);
      for (const t of ["'[]'::jsonb", "'null'::jsonb", "'\"08:00\"'::jsonb"]) await refusedWith(sched({ timing: t }), CHECK);
      await refusedWith(sched({ ...paused("manual", user), paused_reason: "'bored'" }), CHECK);
      for (const col of ["tenant_id", "owner_id", "kind", "scope", "engagement_ids", "timing", "enabled", "created_at", "updated_at", "origin_site"]) {
        await refusedWith(sched({ [col]: "NULL" }), NOT_NULL);
      }
    });

    it("chosen exactly when it lists clients: 1 to 200, no NULL element", async () => {
      await refusedWith(sched({ engagement_ids: "'{}'::uuid[]" }), CHECK);
      await refusedWith(sched({ scope: "'all'", kind: "'daily'", next_period: "'2026-11-09'" }), CHECK); // 'all' with a list
      await refusedWith(sched({ engagement_ids: `ARRAY[${Array.from({ length: 201 }, () => `'${newId()}'`).join(", ")}]::uuid[]` }), CHECK);
      await refusedWith(sched({ engagement_ids: "ARRAY[NULL]::uuid[]" }), CHECK);
      await refusedWith(sched({ engagement_ids: `ARRAY['${engA}', NULL]::uuid[]` }), CHECK);
    });

    it("on exactly when there is no pause reason and no pause time; a manual pause names who, the job's pauses nobody", async () => {
      await refusedWith(sched({ paused_reason: "'manual'", paused_by: `'${user}'` }), CHECK); // on, with a reason
      await refusedWith(sched({ paused_at: "now()" }), CHECK); // on, with a pause time
      await refusedWith(sched({ ...paused("manual", user), paused_reason: "NULL", paused_by: "NULL" }), CHECK); // off, no reason
      await refusedWith(sched({ ...paused("manual", user), paused_at: "NULL" }), CHECK); // off, no time
      await refusedWith(sched(paused("manual", null)), CHECK); // a manual pause without who
      await refusedWith(sched(paused("owner_not_allowed", user)), CHECK); // the job's pause naming a person
      await refusedWith(sched({ paused_by: `'${user}'` }), CHECK); // the NULL trap: on, no reason, but a paused_by
    });

    it("the next run while on, always with its period; the last run with its period", async () => {
      await refusedWith(sched({ next_run_at: "NULL", next_period: "NULL" }), CHECK); // on, no next run
      await refusedWith(sched({ ...paused("manual", user), next_run_at: "now()", next_period: "'2026-W46'" }), CHECK); // off, a next run
      await refusedWith(sched({ next_period: "NULL" }), CHECK);
      await refusedWith(sched({ ...paused("manual", user), next_period: "'2026-W46'" }), CHECK);
      await refusedWith(sched({ last_run_at: "now()" }), CHECK);
      await refusedWith(sched({ last_period: "'2026-W45'" }), CHECK);
    });

    it("next_period and last_period in the schedule's kind's format (the monthly too)", async () => {
      await refusedWith(sched({ next_period: "'2026-11'" }), CHECK); // a month on a weekly
      await refusedWith(sched({ next_period: "'2026-W54'" }), CHECK);
      await refusedWith(sched({ last_run_at: "now()", last_period: "'2026-W00'" }), CHECK);
      await refusedWith(sched({ kind: "'monthly'", next_period: "'2026-13'" }), CHECK);
      await refusedWith(sched({ kind: "'monthly'", next_period: "'2026-W45'" }), CHECK);
      await refusedWith(sched({ kind: "'quarterly'", next_period: "'2026-Q5'" }), CHECK);
      await refusedWith(sched({ kind: "'semester'", next_period: "'2026-H3'" }), CHECK);
      await refusedWith(sched({ kind: "'yearly'", next_period: "'26'" }), CHECK);
      await refusedWith(sched({ kind: "'daily'", next_period: "'2026-11-32'" }), CHECK);
    });

    it("deleted_at with deleted_by", async () => {
      await refusedWith(sched({ deleted_at: "now()" }), CHECK);
      await refusedWith(sched({ deleted_by: `'${user}'` }), CHECK);
    });

    it("at most one live company-wide schedule per kind; chosen ones, a deleted one, another kind or company do not collide", async () => {
      const all = (over: Record<string, string> = {}) =>
        sched({ kind: "'quarterly'", scope: "'all'", engagement_ids: "'{}'::uuid[]", next_period: "'2026-Q4'", ...over });
      const first = await all();
      await refusedWith(all(), UNIQUE);
      await refusedWith(all(paused("manual", user)), UNIQUE); // paused still counts
      await all({ kind: "'semester'", next_period: "'2026-H2'" });
      await all({ tenant_id: `'${C}'`, engagement_ids: "'{}'::uuid[]" });
      await sched({ kind: "'quarterly'", next_period: "'2026-Q4'" });
      await sched({ kind: "'quarterly'", next_period: "'2026-Q4'" });
      await q(`UPDATE social_report_schedules SET deleted_at = now(), deleted_by = $1 WHERE id = $2`, [user, first]);
      await all();
    });
  });

  // ── social_report_runs ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("social_report_runs", () => {
    let schedA: string;
    let schedC: string;
    beforeAll(async () => {
      schedA = await sched({ kind: "'yearly'", next_period: "'2026'" });
      schedC = await insert("social_report_schedules", { tenant_id: `'${C}'`, owner_id: `'${user}'`, kind: "'yearly'", scope: "'chosen'",
        engagement_ids: `ARRAY['${engC}']::uuid[]`, timing: `'{"on": "day", "day": 2, "at": "08:00"}'::jsonb`, next_run_at: "now()",
        next_period: "'2026'" }, {});
    });

    it("admits each good shape: queued by a person, done, failed, a scheduled run and a Run now, each periodic kind", async () => {
      const id = await run();
      const r = (await q(`SELECT status, trigger, done_count, results, via, schedule_id, started_at FROM social_report_runs WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ status: "queued", trigger: "person", done_count: 0, results: [], via: null, schedule_id: null, started_at: null });
      await run({ ...done(), results: `'[{"engagementId": "${engA}", "clientName": "Mock Client A", "status": "created", "draftedVia": "ai"}]'::jsonb` });
      await run({ status: "'failed'", started_at: "now()", finished_at: "now()", done_count: "1" });
      await run({ ...done(), trigger: "'schedule'", schedule_id: `'${schedA}'`,
        via: `'{"automation": "report_schedule", "scheduleId": "${schedA}", "missed": 2}'::jsonb` });
      await run({ ...done(), trigger: "'run_now'", schedule_id: `'${schedA}'` });
      await run({ via: `'{"agent": "mock-agent"}'::jsonb`, rules_ref: "'default:scp-5a'", total: "0" });
      const periods: Record<string, string> = { daily: "2026-11-09", weekly: "2026-W53", monthly: "2026-10", quarterly: "2026-Q4",
        semester: "2026-H2", yearly: "2026" };
      for (const [k, p] of Object.entries(periods)) await run({ ...done(), kind: `'${k}'`, period: `'${p}'` });
    });

    it("refuses campaign and adhoc, a period out of its kind's format, and the NULL ones", async () => {
      for (const k of ["'campaign'", "'adhoc'", "'hourly'"]) await refusedWith(run({ kind: k, period: "'2026'" }), CHECK);
      for (const [k, p] of [["daily", "2026-11-32"], ["weekly", "2026-W54"], ["monthly", "2026-13"], ["monthly", "Oct 2026"],
        ["quarterly", "2026-Q5"], ["semester", "2026-H3"], ["yearly", "26"], ["weekly", "2026-11"]]) {
        await refusedWith(run({ kind: `'${k}'`, period: `'${p}'` }), CHECK);
      }
      for (const col of ["tenant_id", "kind", "period", "requested_by", "rules_ref", "trigger", "status", "total", "done_count", "results",
        "created_at", "origin_site"]) {
        await refusedWith(run({ [col]: "NULL" }), NOT_NULL);
      }
    });

    it("rules_ref is 'company:<version>' or 'default:<defaultsVersion>' (§63.30's fixed format)", async () => {
      for (const ok of ["'company:1'", "'company:4294967295'", "'default:scp-5a'", "'default:2026.10.30'"]) await run({ rules_ref: ok });
      for (const bad of ["''", "'company:0'", "'company:'", "'company:01'", "'default:'", "'default:-x'", "'v1'", "'company:1 '"]) {
        await refusedWith(run({ rules_ref: bad }), CHECK);
      }
    });

    it("trigger: person without a schedule, schedule and run_now with one; a scheduled run says via; via is an object", async () => {
      await refusedWith(run({ trigger: "'cron'" }), CHECK);
      await refusedWith(run({ schedule_id: `'${schedA}'` }), CHECK); // person with a schedule
      await refusedWith(run({ trigger: "'schedule'", via: `'{"automation": "report_schedule"}'::jsonb` }), CHECK); // no schedule
      await refusedWith(run({ trigger: "'run_now'" }), CHECK);
      await refusedWith(run({ trigger: "'schedule'", schedule_id: `'${schedA}'` }), CHECK); // via NULL
      for (const v of ["'[]'::jsonb", "'\"agent\"'::jsonb", "'null'::jsonb"]) await refusedWith(run({ via: v }), CHECK);
    });

    it("status and its times: finished exactly when done or failed; started once past queued", async () => {
      await refusedWith(run({ status: "'paused'" }), CHECK);
      await refusedWith(run({ ...done(), finished_at: "NULL" }), CHECK);
      await refusedWith(run({ status: "'failed'", started_at: "now()" }), CHECK);
      await refusedWith(run({ finished_at: "now()" }), CHECK); // queued, finished
      await refusedWith(run({ status: "'running'" }), CHECK); // running, never started
      await refusedWith(run({ ...done(), started_at: "NULL" }), CHECK);
      await refusedWith(run({ status: "'running'", started_at: "now()", finished_at: "now()" }), CHECK);
    });

    it("done_count between 0 and total; results an array", async () => {
      await refusedWith(run({ done_count: "4" }), CHECK);
      await refusedWith(run({ done_count: "-1" }), CHECK);
      await refusedWith(run({ total: "-1" }), CHECK);
      for (const r of ["'{}'::jsonb", "'null'::jsonb", "'3'::jsonb"]) await refusedWith(run({ results: r }), CHECK);
    });

    it("the composite FK refuses another company's schedule and an unknown one; a schedule with runs cannot be removed", async () => {
      await refusedWith(run({ ...done(), trigger: "'run_now'", schedule_id: `'${schedC}'` }), FK);
      await refusedWith(run({ ...done(), trigger: "'run_now'", schedule_id: `'${newId()}'` }), FK);
      await insert("social_report_runs", { tenant_id: `'${C}'`, kind: "'yearly'", period: "'2026'", requested_by: `'${user}'`,
        rules_ref: "'company:1'", total: "3", trigger: "'run_now'", schedule_id: `'${schedC}'` }, done());
      await refusedWith(q(`DELETE FROM social_report_schedules WHERE id = $1`, [schedC]), FK);
    });

    it("one queued-or-running run per company, kind and period; a finished one, another period, kind or company do not collide", async () => {
      const p = year();
      const first = await run({ period: `'${p}'` });
      await refusedWith(run({ period: `'${p}'` }), UNIQUE);
      await refusedWith(run({ period: `'${p}'`, status: "'running'", started_at: "now()" }), UNIQUE);
      await run({ period: `'${p}'`, ...done() });
      await run({ period: `'${p}'`, status: "'failed'", started_at: "now()", finished_at: "now()" });
      await run({ period: `'${p}'`, tenant_id: `'${C}'` });
      await run({ period: `'${year()}'` });
      await run({ kind: "'quarterly'", period: "'2025-Q1'" });
      await q(`UPDATE social_report_runs SET status = 'done', started_at = now(), finished_at = now() WHERE id = $1`, [first]);
      await run({ period: `'${p}'` });
    });

    it("one running run per company; queued ones wait beside it; another company runs at the same time", async () => {
      const running = await run({ status: "'running'", started_at: "now()", heartbeat_at: "now()" });
      await refusedWith(run({ status: "'running'", started_at: "now()" }), UNIQUE);
      await run();
      await run();
      const theirs = await run({ tenant_id: `'${C}'`, status: "'running'", started_at: "now()" });
      // The current one ends; the next may start.
      await q(`UPDATE social_report_runs SET status = 'done', finished_at = now() WHERE id = $1`, [running]);
      const next = await run({ status: "'running'", started_at: "now()" });
      await q(`UPDATE social_report_runs SET status = 'done', finished_at = now() WHERE id = ANY($1::uuid[])`, [[next, theirs]]);
    });

    it("one run per schedule and period, by the job or by Run now; person runs (no schedule) never collide", async () => {
      const s = await sched({ kind: "'yearly'", next_period: "'2026'" });
      const via = `'{"automation": "report_schedule", "scheduleId": "${s}"}'::jsonb`;
      const p = year();
      await run({ ...done(), period: `'${p}'`, trigger: "'schedule'", schedule_id: `'${s}'`, via });
      await refusedWith(run({ ...done(), period: `'${p}'`, trigger: "'run_now'", schedule_id: `'${s}'` }), UNIQUE);
      await refusedWith(run({ period: `'${p}'`, trigger: "'schedule'", schedule_id: `'${s}'`, via }), UNIQUE);
      await run({ ...done(), period: `'${year()}'`, trigger: "'run_now'", schedule_id: `'${s}'` });
      await run({ ...done(), period: `'${p}'` });
      await run({ ...done(), period: `'${p}'` });
    });
  });

  // ── The third wall, on both new tables ────────────────────────────────────────────────────────────────────────────────────────
  describe("the third wall", () => {
    const ids: Record<string, { mine: string; theirs: string }> = {};
    beforeAll(async () => {
      const theirSchedule = await insert("social_report_schedules", { tenant_id: `'${C}'`, owner_id: `'${user}'`, kind: "'daily'",
        scope: "'chosen'", engagement_ids: `ARRAY['${engC}']::uuid[]`, timing: `'{"at": "07:00"}'::jsonb`, next_run_at: "now()",
        next_period: "'2026-11-09'" }, {});
      ids.social_report_schedules = { mine: await sched({ kind: "'daily'", next_period: "'2026-11-09'" }), theirs: theirSchedule };
      ids.social_report_runs = {
        mine: await run(done()),
        theirs: await insert("social_report_runs", { tenant_id: `'${C}'`, kind: "'yearly'", period: `'${year()}'`, requested_by: `'${user}'`,
          rules_ref: "'company:1'", total: "3" }, done()),
      };
    });

    it.each(TABLES)("%s: RLS enabled and forced, one policy", async (t) => {
      const r = (await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)`, [t])).rows[0];
      expect(r).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(Number((await q(`SELECT count(*) FROM pg_policies WHERE tablename = $1`, [t])).rows[0].count)).toBe(1);
    });

    it.each(TABLES)("%s: an unset GUC reads ZERO rows with no error; no module scope reads zero; a company reads only its own", async (t) => {
      const both = [ids[t].mine, ids[t].theirs];
      const count = `SELECT count(*)::int AS n FROM ${t} WHERE id = ANY($1::uuid[])`;
      expect((await q(count, [both])).rows[0].n, "truth, as the superuser").toBe(2);
      const unset = await withGlobal((c) => c.query<{ n: number }>(count, [both]));
      expect(unset.rows[0].n, "unset GUC").toBe(0);
      const noModule = await withTenants([A], (c) => c.query<{ n: number }>(count, [both]));
      expect(noModule.rows[0].n, "no module scope").toBe(0);
      const list = `SELECT id::text AS id FROM ${t} WHERE id = ANY($1::uuid[])`;
      const scoped = await withTenants([A], (c) => c.query<{ id: string }>(list, [both]), { modules: ["social"] });
      expect(scoped.rows).toEqual([{ id: ids[t].mine }]);
      const other = await withTenants([C], (c) => c.query<{ id: string }>(list, [both]), { modules: ["social"] });
      expect(other.rows).toEqual([{ id: ids[t].theirs }]);
      // Neither an update nor a delete reaches the other company's row.
      const touched = await withTenants([A], (c) => c.query(`UPDATE ${t} SET origin_site = origin_site WHERE id = $1`, [ids[t].theirs]),
        { modules: ["social"] });
      expect(touched.rowCount).toBe(0);
      const removed = await withTenants([A], (c) => c.query(`DELETE FROM ${t} WHERE id = $1`, [ids[t].theirs]), { modules: ["social"] });
      expect(removed.rowCount).toBe(0);
    });

    it("a write into another company is refused by WITH CHECK; the company's own write in scope goes through", async () => {
      const insertSchedule = (tenant: string) => withTenants([A], (c) => c.query(
        `INSERT INTO social_report_schedules (tenant_id, owner_id, kind, scope, timing, next_run_at, next_period)
         VALUES ($1, $2, 'yearly', 'all', '{"on": "day", "day": 5, "at": "09:00"}'::jsonb, now(), '2026')`, [tenant, user]),
      { modules: ["social"] });
      const insertRun = (tenant: string) => withTenants([A], (c) => c.query(
        `INSERT INTO social_report_runs (tenant_id, kind, period, requested_by, rules_ref, total) VALUES ($1, 'yearly', $2, $3, 'company:1', 2)`,
        [tenant, year(), user]), { modules: ["social"] });
      await expect(insertSchedule(C)).rejects.toMatchObject({ code: "42501" });
      await expect(insertRun(C)).rejects.toMatchObject({ code: "42501" });
      await insertSchedule(A);
      await insertRun(A);
      // And the allocation's report_kinds, written as the runtime role in scope.
      const set = await withTenants([A], (c) => c.query(`UPDATE social_engagements SET report_kinds = '{weekly}' WHERE id = $1`, [engA2]),
        { modules: ["social"] });
      expect(set.rowCount).toBe(1);
    });
  });

  // ── Re-run with rows in every table ─────────────────────────────────────────────────────────────────────────────────────────
  it("applying the file again changes no row of the new tables or of the tables it touches", async () => {
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      for (const t of [...TABLES, "social_reports", "social_engagements"]) {
        out[t] = (await q(`SELECT to_jsonb(r) AS j FROM ${t} r ORDER BY id`)).rows.map((r) => r.j);
      }
      return out;
    };
    const before = await snapshot();
    for (const t of TABLES) expect(before[t].length, t).toBeGreaterThan(3);
    expect(before.social_reports.some((r) => (r as { kind: string }).kind === "daily")).toBe(true);
    await apply();
    expect(await snapshot()).toEqual(before);
  });
});
