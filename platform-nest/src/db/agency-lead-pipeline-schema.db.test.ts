// M5-P1-a — migration 202610111425_agency_lead_pipeline.sql, proven against a REAL Postgres.
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §4 and the P1-a "accepted when" list in §9.
//
// TWO PARTS, because they answer two different questions:
//
//  A. SHAPE (the per-file database, already fully migrated, queried as `platform_app_test`, the
//     NOSUPERUSER NOBYPASSRLS runtime stand-in): the CHECKs, the FKs, the append-only history, the
//     purge hatch, RLS on the history, the global (RLS-free) vocabulary, the table comment.
//
//  B. APPLY (a scratch database built to the pre-migration head, seeded with live-shaped leads in two
//     tenants, then the migration's REAL file text applied as a NOSUPERUSER NOBYPASSRLS role that OWNS
//     the tables, which is what `platform_owner` is on live). CI migrates as a superuser, which bypasses
//     RLS, so the shared template can never show the zero-row backfill trap (migration-backfill-rls-trap).
//     B shows (1) the trap is real for that role, (2) the per-tenant backfill defeats it in BOTH
//     tenants, and (3) the CHECKs are a working net: the same migration with the GUC line removed fails
//     loudly instead of shipping.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { APP_ROLE, APP_PASSWORD, dbPrefix, urlWithDb } from "../testing/db-names";
import { createCompany, createUser, createClient } from "../testing/fixtures";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const MIGRATION = "202610111425_agency_lead_pipeline.sql";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_DIR, MIGRATION), "utf8");

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A. SHAPE
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!TEST_URL)("M5-P1-a — agency_leads pipeline schema (as the NOBYPASSRLS app role)", () => {
  let A: string;
  let B: string;
  let userA: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Pipeline Tenant A");
    B = await createCompany("Pipeline Tenant B");
    userA = await createUser("pipeline-a@schema.test");
  }, 120_000);
  afterAll(teardownTestDb);

  /** Insert a lead for `tenant`. `cols` overrides/extends the defaults; stage is omitted unless given
   *  so the column DEFAULT is what is exercised. Returns the id. */
  async function lead(tenant: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    const row: Record<string, unknown> = {
      id, tenant_id: tenant, org_name: `Pipeline Org ${String.fromCharCode(97 + (seq % 26))}${++seq}`,
      source: "staff", status: "new", origin_site: "test", ...cols,
    };
    const names = Object.keys(row);
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_leads (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => row[n]),
      ),
    );
    return id;
  }

  async function event(tenant: string, leadId: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    const row: Record<string, unknown> = {
      id, tenant_id: tenant, lead_id: leadId, from_stage: "enquiry", to_stage: "contacted", origin_site: "test", ...cols,
    };
    const names = Object.keys(row);
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_lead_stage_events (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((n) => row[n]),
      ),
    );
    return id;
  }

  const stageOf = async (leadId: string) =>
    (await adminPool().query<{ stage: string }>(`SELECT stage FROM agency_leads WHERE id = $1`, [leadId])).rows[0].stage;
  const eventCount = async (leadId: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM agency_lead_stage_events WHERE lead_id = $1`, [leadId])).rows[0].n;

  // ── vocabulary ───────────────────────────────────────────────────────────────────────────────
  describe("agency_lead_stages (global reference data)", () => {
    it("seeds the six stages, in order, with the right kinds", async () => {
      const { rows } = await withGlobal((c) => c.query(`SELECT key, position, kind, label FROM agency_lead_stages ORDER BY position`));
      expect(rows).toEqual([
        { key: "enquiry", position: 10, kind: "open", label: "Enquiry" },
        { key: "contacted", position: 20, kind: "open", label: "Contacted" },
        { key: "qualified", position: 30, kind: "open", label: "Qualified" },
        { key: "proposal", position: 40, kind: "open", label: "Proposal sent" },
        { key: "won", position: 90, kind: "won", label: "Won" },
        { key: "lost", position: 99, kind: "lost", label: "Lost" },
      ]);
    });

    it("is global: no tenant_id column and NO row security (the finance_currencies precedent)", async () => {
      const cols = await adminPool().query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agency_lead_stages' AND column_name = 'tenant_id'`,
      );
      expect(cols.rowCount).toBe(0);
      const rls = await adminPool().query<{ on: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'agency_lead_stages'::regclass`,
      );
      expect(rls.rows[0]).toEqual({ on: false, forced: false });
      // ...and so it reads with NO tenant context at all (a plain pooled connection, GUC unset).
      const { rows } = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM agency_lead_stages`));
      expect(rows[0].n).toBe(6);
    });

    it("exactly one won and one lost stage: a second terminal stage of a kind is refused", async () => {
      await expect(
        adminPool().query(`INSERT INTO agency_lead_stages (key, position, kind, label) VALUES ('won_two', 91, 'won', 'Won again')`),
      ).rejects.toThrow(/ux_agency_lead_stages_terminal/);
      await expect(
        adminPool().query(`INSERT INTO agency_lead_stages (key, position, kind, label) VALUES ('lost_two', 98, 'lost', 'Lost again')`),
      ).rejects.toThrow(/ux_agency_lead_stages_terminal/);
    });

    it("adding an OPEN stage is a plain INSERT that agency_leads accepts (no CHECK is ever rebuilt); key shape is enforced", async () => {
      const admin = adminPool();
      await admin.query(`INSERT INTO agency_lead_stages (key, position, kind, label) VALUES ('negotiation', 45, 'open', 'Negotiation')`);
      try {
        const id = await lead(A, { stage: "negotiation" });
        expect(await stageOf(id)).toBe("negotiation");
        await withTenants([A], (c) => c.query(`DELETE FROM agency_leads WHERE id = $1`, [id]));
      } finally {
        await admin.query(`DELETE FROM agency_lead_stages WHERE key = 'negotiation'`);
      }
      await expect(
        admin.query(`INSERT INTO agency_lead_stages (key, position, kind, label) VALUES ('Bad Key', 46, 'open', 'x')`),
      ).rejects.toThrow(/agency_lead_stages_key_check|violates check constraint/);
    });
  });

  // ── agency_leads columns and CHECKs ──────────────────────────────────────────────────────────
  describe("agency_leads.stage / deal_value / deal_currency", () => {
    it("a new lead defaults to stage 'enquiry' with no deal", async () => {
      const id = await lead(A);
      const { rows } = await adminPool().query(`SELECT stage, deal_value, deal_currency FROM agency_leads WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ stage: "enquiry", deal_value: null, deal_currency: null });
    });

    it("an unknown stage is refused (FK to the vocabulary)", async () => {
      await expect(lead(A, { stage: "negotiating" })).rejects.toThrow(/agency_leads_stage_fkey|foreign key/i);
    });

    it("won with status 'new' fails; lost with status 'new' fails", async () => {
      await expect(lead(A, { status: "new", stage: "won" })).rejects.toThrow(/lead_won_iff_converted/);
      await expect(lead(A, { status: "new", stage: "lost" })).rejects.toThrow(/lead_lost_iff_declined/);
    });

    it("converted needs won, declined needs lost (the reverse direction of each CHECK)", async () => {
      const client = await createClient(A, "Won-iff Client");
      await expect(lead(A, { status: "converted", converted_client_id: client })).rejects.toThrow(/lead_won_iff_converted/);
      await expect(lead(A, { status: "declined", declined_reason: "no budget" })).rejects.toThrow(/lead_lost_iff_declined/);
    });

    it("the two legal terminal pairings are accepted", async () => {
      const client = await createClient(A, "Won Client");
      const won = await lead(A, { status: "converted", stage: "won", converted_client_id: client });
      const lost = await lead(A, { status: "declined", stage: "lost", declined_reason: "no budget" });
      expect(await stageOf(won)).toBe("won");
      expect(await stageOf(lost)).toBe("lost");
    });

    it("every open status may sit at every open stage (parked is still in the pipeline)", async () => {
      for (const status of ["new", "invited", "submitted", "in_review", "nurturing"]) {
        for (const stage of ["enquiry", "contacted", "qualified", "proposal"]) {
          await expect(lead(A, { status, stage })).resolves.toBeTruthy();
        }
      }
    });

    it("a value without a currency fails; a currency without a value fails; both or neither pass", async () => {
      await expect(lead(A, { deal_value: "100.0000" })).rejects.toThrow(/lead_deal_pair/);
      await expect(lead(A, { deal_currency: "IDR" })).rejects.toThrow(/lead_deal_pair/);
      const id = await lead(A, { deal_value: "15000000", deal_currency: "IDR" });
      const { rows } = await adminPool().query(`SELECT deal_value::text AS v, deal_currency AS c FROM agency_leads WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ v: "15000000.0000", c: "IDR" });
    });

    it("currency XXX (not in finance_currencies) fails; a negative value fails; an over-wide value fails", async () => {
      await expect(lead(A, { deal_value: "1", deal_currency: "XXX" })).rejects.toThrow(/deal_currency_fkey|foreign key/i);
      await expect(lead(A, { deal_value: "-1", deal_currency: "USD" })).rejects.toThrow(/lead_deal_nonneg/);
      await expect(lead(A, { deal_value: "10000000000000000", deal_currency: "USD" })).rejects.toThrow(/numeric field overflow/);
    });

    it("zero is a legal value", async () => {
      await expect(lead(A, { deal_value: "0", deal_currency: "USD" })).resolves.toBeTruthy();
    });

    it("the AD-1 / L4 CHECKs are untouched: status still lists all seven values, source still lists web", async () => {
      const defs = await adminPool().query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'agency_leads'::regclass AND contype = 'c'`,
      );
      const byName = new Map(defs.rows.map((r) => [r.conname, r.def]));
      for (const v of ["new", "invited", "submitted", "in_review", "nurturing", "converted", "declined"]) {
        expect(byName.get("agency_leads_status_check")).toContain(`'${v}'`);
      }
      for (const v of ["invite", "open", "staff", "web"]) expect(byName.get("agency_leads_source_check")).toContain(`'${v}'`);
      for (const n of ["lead_converted_has_client", "lead_declined_has_reason", "lead_won_iff_converted", "lead_lost_iff_declined", "lead_deal_pair", "lead_deal_nonneg"]) {
        expect(byName.has(n), n).toBe(true);
      }
    });

    it("the stage index exists and is partial over live leads", async () => {
      const { rows } = await adminPool().query<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'agency_leads' AND indexname = 'ix_lead_stage'`,
      );
      expect(rows[0].def).toMatch(/tenant_id, stage/);
      expect(rows[0].def).toMatch(/deleted_at IS NULL/);
    });

    it("COMMENT ON TABLE agency_leads carries the rewritten header note (D69, both machines, the purge rule)", async () => {
      const { rows } = await adminPool().query<{ c: string }>(`SELECT obj_description('agency_leads'::regclass) AS c`);
      const c = rows[0].c;
      expect(c).toContain("D69");
      expect(c).toContain("two state machines");
      expect(c).toContain("won <=> converted, lost <=> declined");
      expect(c).toContain("agency_lead_stage_events");
      expect(c).toContain("not a general CRM");
      expect(c).toContain("Erasure (M5-G5) scrubs those fields");
      const t = await adminPool().query<{ c: string }>(`SELECT obj_description('agency_lead_stage_events'::regclass) AS c`);
      expect(t.rows[0].c).toContain("app.lead_purge");
    });
  });

  // ── history ──────────────────────────────────────────────────────────────────────────────────
  describe("agency_lead_stage_events (append-only, tenant-walled, no personal data)", () => {
    it("RLS is ENABLED and FORCED with a tenant_isolation policy and NO module wall", async () => {
      const r = await adminPool().query<{ on: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'agency_lead_stage_events'::regclass`,
      );
      expect(r.rows[0]).toEqual({ on: true, forced: true });
      const p = await adminPool().query<{ policyname: string; qual: string }>(
        `SELECT policyname, qual FROM pg_policies WHERE tablename = 'agency_lead_stage_events'`,
      );
      expect(p.rows.map((x) => x.policyname)).toEqual(["tenant_isolation"]);
      expect(p.rows[0].qual).not.toMatch(/app_module_allowed/);
    });

    it("the table has no free-text or personal-data column (an erasure never has to edit it)", async () => {
      const { rows } = await adminPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agency_lead_stage_events' ORDER BY ordinal_position`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        "id", "tenant_id", "lead_id", "from_stage", "to_stage", "deal_value", "deal_currency",
        "actor_id", "via_agent", "occurred_at", "origin_site",
      ]);
    });

    it("cross-tenant history is invisible; an unset GUC reads ZERO rows (fails closed, no error)", async () => {
      const lA = await lead(A);
      const lB = await lead(B);
      const eA = await event(A, lA);
      const eB = await event(B, lB);
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids((await withTenants([A], (c) => c.query(`SELECT id FROM agency_lead_stage_events WHERE id = ANY($1::uuid[])`, [[eA, eB]]))).rows)).toEqual([eA]);
      expect(ids((await withTenants([B], (c) => c.query(`SELECT id FROM agency_lead_stage_events WHERE id = ANY($1::uuid[])`, [[eA, eB]]))).rows)).toEqual([eB]);
      const none = await withGlobal((c) => c.query(`SELECT id FROM agency_lead_stage_events WHERE id = ANY($1::uuid[])`, [[eA, eB]]));
      expect(none.rowCount).toBe(0);
    });

    it("cannot write a row for another tenant (WITH CHECK), nor point at another tenant's lead (composite FK)", async () => {
      const lA = await lead(A);
      const lB = await lead(B);
      // Scoped to A, writing tenant_id = B: row security.
      await expect(
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO agency_lead_stage_events (id, tenant_id, lead_id, from_stage, to_stage, origin_site) VALUES ($1, $2, $3, 'enquiry', 'contacted', 'test')`,
            [newId(), B, lB],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
      // Scoped to A, tenant_id = A, but lead B: the FK is (lead_id, tenant_id), so it does not match.
      await expect(event(A, lB)).rejects.toThrow(/fk_stage_event_lead_tenant/);
      expect(await eventCount(lA)).toBe(0);
    });

    it("UPDATE raises, even with the purge hatch open", async () => {
      const l = await lead(A);
      const e = await event(A, l);
      await expect(
        withTenants([A], (c) => c.query(`UPDATE agency_lead_stage_events SET to_stage = 'qualified' WHERE id = $1`, [e])),
      ).rejects.toThrow(/append-only/);
      await expect(
        withTenants([A], async (c) => {
          await c.query(`SET LOCAL app.lead_purge = 'on'`);
          await c.query(`UPDATE agency_lead_stage_events SET to_stage = 'qualified' WHERE id = $1`, [e]);
        }),
      ).rejects.toThrow(/append-only/);
      const { rows } = await adminPool().query(`SELECT to_stage FROM agency_lead_stage_events WHERE id = $1`, [e]);
      expect(rows[0].to_stage).toBe("contacted");
    });

    it("DELETE of a history row raises without the hatch; any value other than 'on' does not open it", async () => {
      const l = await lead(A);
      const e = await event(A, l);
      await expect(
        withTenants([A], (c) => c.query(`DELETE FROM agency_lead_stage_events WHERE id = $1`, [e])),
      ).rejects.toThrow(/append-only/);
      for (const v of ["off", "true", "1", ""]) {
        await expect(
          withTenants([A], async (c) => {
            await c.query(`SELECT set_config('app.lead_purge', $1, true)`, [v]);
            await c.query(`DELETE FROM agency_lead_stage_events WHERE id = $1`, [e]);
          }),
        ).rejects.toThrow(/append-only/);
      }
      expect(await eventCount(l)).toBe(1);
    });

    it("deleting a lead WITHOUT app.lead_purge fails and leaves the lead and its history intact", async () => {
      const l = await lead(A);
      await event(A, l);
      await expect(
        withTenants([A], (c) => c.query(`DELETE FROM agency_leads WHERE id = $1`, [l])),
      ).rejects.toThrow(/append-only/);
      expect(await eventCount(l)).toBe(1);
      expect((await adminPool().query(`SELECT 1 FROM agency_leads WHERE id = $1`, [l])).rowCount).toBe(1);
    });

    it("deleting a lead WITH app.lead_purge='on' cascades its history away", async () => {
      const l = await lead(A);
      const other = await lead(A);
      await event(A, l);
      await event(A, l, { from_stage: "contacted", to_stage: "qualified" });
      await event(A, other);
      await withTenants([A], async (c) => {
        await c.query(`SET LOCAL app.lead_purge = 'on'`);
        await c.query(`DELETE FROM agency_leads WHERE id = $1`, [l]);
      });
      expect(await eventCount(l)).toBe(0);
      expect(await eventCount(other)).toBe(1); // the hatch is per-statement-scope data, not a blanket wipe
      // SET LOCAL ended with the transaction: the next transaction is closed again.
      await expect(
        withTenants([A], (c) => c.query(`DELETE FROM agency_lead_stage_events WHERE lead_id = $1`, [other])),
      ).rejects.toThrow(/append-only/);
    });

    it("row CHECKs: from <> to, deal value and currency together, via_agent <= 64, known stages and currency", async () => {
      const l = await lead(A);
      await expect(event(A, l, { from_stage: "proposal", to_stage: "proposal" })).rejects.toThrow(/stage_event_moves/);
      await expect(event(A, l, { deal_value: "5" })).rejects.toThrow(/stage_event_deal_pair/);
      await expect(event(A, l, { deal_currency: "USD" })).rejects.toThrow(/stage_event_deal_pair/);
      await expect(event(A, l, { via_agent: "x".repeat(65) })).rejects.toThrow(/via_agent|violates check constraint/);
      await expect(event(A, l, { to_stage: "nonsense" })).rejects.toThrow(/to_stage_fkey|foreign key/i);
      await expect(event(A, l, { from_stage: "nonsense" })).rejects.toThrow(/from_stage_fkey|foreign key/i);
      await expect(event(A, l, { deal_value: "1", deal_currency: "XXX" })).rejects.toThrow(/deal_currency_fkey|foreign key/i);
      await expect(
        event(A, l, { deal_value: "15000000.0000", deal_currency: "IDR", actor_id: userA, via_agent: "x".repeat(64) }),
      ).resolves.toBeTruthy();
    });
  });

  it("the migration's own self-assert block holds on the finished schema", async () => {
    const { rows } = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'agency_lead_stage_events'::regclass AND NOT tgisinternal`,
    );
    expect(rows[0].n).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// B. APPLY AS THE NOBYPASSRLS OWNER, over live-shaped data in two tenants
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!TEST_URL)("M5-P1-a — the migration applied as a NOSUPERUSER NOBYPASSRLS table owner", () => {
  const SCRATCH = `${dbPrefix()}_p1a_apply`;
  const NEG = `${dbPrefix()}_p1a_apply_neg`;
  const MIGRATOR = `${dbPrefix()}_p1a_migr`;
  const MIGRATOR_PW = "migr";

  interface Seeded { tenant: string; newLead: string; submitted: string; converted: string; convertedDeleted: string; declined: string }
  const seeded: Seeded[] = [];

  const maintenance = () => new Pool({ connectionString: TEST_URL, max: 1 });
  const poolFor = (db: string, user?: { name: string; pw: string }) => {
    const u = new URL(urlWithDb(TEST_URL, db));
    if (user) { u.username = user.name; u.password = user.pw; }
    return new Pool({ connectionString: u.toString(), max: 2 });
  };
  const asMigrator = (db: string) => poolFor(db, { name: MIGRATOR, pw: MIGRATOR_PW });
  const asApp = (db: string) => poolFor(db, { name: APP_ROLE, pw: APP_PASSWORD });

  async function dropAll(): Promise<void> {
    const m = maintenance();
    try {
      for (const db of [NEG, SCRATCH]) await m.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await m.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
    } finally {
      await m.end();
    }
  }

  /** Every migration BEFORE this one, in the runner's own order (readdir + lexicographic sort). */
  const priorMigrations = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().filter((f) => f < MIGRATION);

  beforeAll(async () => {
    await dropAll();
    const m = maintenance();
    try {
      await m.query(`CREATE DATABASE ${SCRATCH}`);
      await m.query(`CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PW}' NOSUPERUSER NOBYPASSRLS`);
    } finally {
      await m.end();
    }

    // 1. The database at the pre-migration head (L4's), built by the runner's own rules, as superuser.
    const su = poolFor(SCRATCH);
    try {
      for (const file of priorMigrations()) {
        const c = await su.connect();
        try {
          await c.query("BEGIN");
          await c.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK").catch(() => {});
          throw new Error(`pre-head migration ${file} failed: ${(err as Error).message}`);
        } finally {
          c.release();
        }
      }
      await su.query(`SELECT 1 FROM agency_leads LIMIT 0`);
      const pre = await su.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_leads' AND column_name = 'stage'`);
      expect(pre.rowCount, "the pre-migration head must not have the stage column yet").toBe(0);

      // 2. Live-shaped seed, in two tenants, written as superuser with explicit tenant ids:
      //    new, submitted, converted, converted-but-soft-deleted (RLS does not filter deleted_at, so the
      //    backfill must reach it too), declined.
      for (const name of ["Apply Tenant A", "Apply Tenant B"]) {
        const tenant = newId();
        await su.query(`INSERT INTO companies (id, name, origin_site) VALUES ($1, $2, 'test')`, [tenant, name]);
        const mkClient = async () => {
          const id = newId();
          await su.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1, $2, $3, 'test')`, [id, tenant, `${name} client ${id}`]);
          return id;
        };
        const mk = async (status: string, extra: { client?: string; reason?: string; deleted?: boolean } = {}) => {
          const id = newId();
          await su.query(
            `INSERT INTO agency_leads (id, tenant_id, org_name, source, status, converted_client_id, declined_reason, deleted_at, origin_site)
             VALUES ($1, $2, $3, 'staff', $4, $5, $6, $7, 'test')`,
            [id, tenant, `${name} ${status}`, status, extra.client ?? null, extra.reason ?? null, extra.deleted ? new Date() : null],
          );
          return id;
        };
        seeded.push({
          tenant,
          newLead: await mk("new"),
          submitted: await mk("submitted"),
          converted: await mk("converted", { client: await mkClient() }),
          convertedDeleted: await mk("converted", { client: await mkClient(), deleted: true }),
          declined: await mk("declined", { reason: "no budget" }),
        });
      }

      // 3. The migrator OWNS every table (what platform_owner is on live) and may create objects. It is
      //    NOSUPERUSER NOBYPASSRLS, so FORCE RLS binds it.
      await su.query(`
        GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR};
        DO $own$ DECLARE t record; BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('ALTER TABLE public.%I OWNER TO ${MIGRATOR}', t.tablename);
          END LOOP;
        END $own$;
        GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
      `);
    } finally {
      await su.end();
    }

    // 4. A pristine copy for the negative control (CREATE DATABASE ... TEMPLATE needs zero connections).
    const m2 = maintenance();
    try {
      await m2.query(`CREATE DATABASE ${NEG} TEMPLATE ${SCRATCH}`);
    } finally {
      await m2.end();
    }
  }, 600_000);

  afterAll(dropAll, 60_000);

  /** Apply `sql` as the migrator in one transaction (the runner's shape). Returns the error, if any. */
  async function applyAsMigrator(db: string, sql: string): Promise<Error | undefined> {
    const pool = asMigrator(db);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query("COMMIT");
      return undefined;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      return err as Error;
    } finally {
      c.release();
      await pool.end();
    }
  }

  it("PREMISE: the migrator cannot see the leads without a tenant GUC (the zero-row trap is real for this role)", async () => {
    const pool = asMigrator(SCRATCH);
    try {
      const blind = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM agency_leads`);
      expect(blind.rows[0].n).toBe(0);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.current_tenant_ids', $1, true)`, [seeded[0].tenant]);
        const seen = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM agency_leads`);
        expect(seen.rows[0].n).toBe(5);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
      const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await pool.end();
    }
  });

  it("NEGATIVE CONTROL: without the per-tenant GUC the backfill matches zero rows and the CHECKs abort the apply LOUDLY", async () => {
    const broken = MIGRATION_SQL.replace("PERFORM set_config('app.current_tenant_ids', co.id::text, true);", "PERFORM 1;");
    expect(broken).not.toBe(MIGRATION_SQL);
    const err = await applyAsMigrator(NEG, broken);
    expect(err, "the migration must refuse to apply over converted/declined leads it could not backfill").toBeDefined();
    expect(err!.message).toMatch(/lead_won_iff_converted|lead_lost_iff_declined/);
    // ...and the failed apply rolled back whole: no half-migrated table.
    const su = poolFor(NEG);
    try {
      const r = await su.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agency_leads' AND column_name = 'stage'`);
      expect(r.rowCount).toBe(0);
      const t = await su.query(`SELECT to_regclass('agency_lead_stage_events') AS t`);
      expect(t.rows[0].t).toBeNull();
    } finally {
      await su.end();
    }
  }, 120_000);

  it("the real migration applies cleanly as the NOBYPASSRLS owner over converted, declined and new leads", async () => {
    const err = await applyAsMigrator(SCRATCH, MIGRATION_SQL);
    expect(err?.message).toBeUndefined();
    // The migrator created these tables; give the runtime stand-in what default privileges give platform_app.
    const su = poolFor(SCRATCH);
    try {
      await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    } finally {
      await su.end();
    }
  }, 120_000);

  it("afterwards, in BOTH tenants: converted reads won, declined reads lost, new and submitted read enquiry (as the app role, per tenant)", async () => {
    const pool = asApp(SCRATCH);
    try {
      for (const s of seeded) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(`SELECT set_config('app.current_tenant_ids', $1, true)`, [s.tenant]);
          const { rows } = await c.query<{ id: string; stage: string; status: string }>(`SELECT id, stage, status FROM agency_leads`);
          await c.query("ROLLBACK");
          const stage = Object.fromEntries(rows.map((r) => [r.id, r.stage]));
          expect(rows).toHaveLength(5);
          expect(stage[s.converted]).toBe("won");
          expect(stage[s.convertedDeleted]).toBe("won");
          expect(stage[s.declined]).toBe("lost");
          expect(stage[s.newLead]).toBe("enquiry");
          expect(stage[s.submitted]).toBe("enquiry");
        } finally {
          c.release();
        }
      }
    } finally {
      await pool.end();
    }
  });

  it("no backfill history: zero stage events and no deal values on any pre-existing lead", async () => {
    const su = poolFor(SCRATCH);
    try {
      expect((await su.query(`SELECT count(*)::int AS n FROM agency_lead_stage_events`)).rows[0].n).toBe(0);
      expect((await su.query(`SELECT count(*)::int AS n FROM agency_leads WHERE deal_value IS NOT NULL OR deal_currency IS NOT NULL`)).rows[0].n).toBe(0);
    } finally {
      await su.end();
    }
  });
});
