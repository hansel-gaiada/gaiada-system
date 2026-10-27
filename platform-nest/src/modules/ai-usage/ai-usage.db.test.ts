// AIP-01 — migration 202610271800_ai_usage_events.sql and the writer, against LIVE Postgres. Needs DATABASE_URL_TEST; skipped without it.
// initTestDb() hands us a fully migrated database and repoints the app at a NOSUPERUSER NOBYPASSRLS role (platform_app_test), so RLS is
// really exercised through withTenants. Seeding and "what is really stored" go through the superuser pool, which bypasses RLS but never a
// CHECK or a trigger.
//
// ⚠ The harness blanket-GRANTs SELECT/INSERT/UPDATE/DELETE on every table to platform_app_test AFTER migrating, and platform_app does not
// exist in a fresh database. So "the app role cannot UPDATE or DELETE" is proved two ways: by the trigger (fires for ANY role, whatever its
// grants), and by replaying the migration's own grant block against a throwaway role.
//
// Proves: RLS (A writes, B sees zero; no tenant context sees zero; a write for another company is refused; the daily view obeys the same);
// append-only (UPDATE and DELETE refused, only an identity going to NULL passes); erasure (user_id cleared, counts and amounts kept, caller's
// tenant context restored, works when the function's owner is NOBYPASSRLS so FORCE RLS applies to it); every CHECK; the daily view's sums
// across two UTC days and two people; the writer end to end.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { withGlobal, withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser } from "../../testing/fixtures";
import { APP_ROLE } from "../../testing/db-names";
import { eraseAiUsageForUser, recordAiUsage } from "./writer";

const MIGRATION = "202610271800_ai_usage_events.sql";

/** Columns a test may set; everything else takes the column default. Values are always parameters. */
type Row = Partial<{
  tenant_id: string; occurred_at: string; user_id: string | null; org_unit_id: string | null; surface: string; capability: string;
  task: string | null; tier: string | null; provider: string | null; model: string | null; prompt_tokens: number | null;
  completion_tokens: number | null; tokens_source: string; cost_usd: string | number | null; cost_source: string | null; outcome: string;
  thread_id: string | null; run_id: string | null; gateway_provider_hint: string | null;
}>;
const COLS = [
  "tenant_id", "occurred_at", "user_id", "org_unit_id", "surface", "capability", "task", "tier", "provider", "model", "prompt_tokens",
  "completion_tokens", "tokens_source", "cost_usd", "cost_source", "outcome", "thread_id", "run_id", "gateway_provider_hint",
] as const;

describe.skipIf(!TEST_URL)("AIP-01 · ai_usage_events", () => {
  let A: string;
  let B: string;
  let u1: string;
  let u2: string;
  let unitA: string;

  const admin = () => adminPool();

  /** A row through the superuser pool (bypasses RLS, not CHECKs or triggers). Returns its id. */
  async function put(over: Row & { tenant_id: string }): Promise<string> {
    const row: Row = { surface: "assistant", capability: "chat", tokens_source: "provider", outcome: "ok", ...over };
    const cols = COLS.filter((c) => row[c] !== undefined);
    const id = newId();
    await admin().query(
      `INSERT INTO ai_usage_events (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
      [id, ...cols.map((c) => row[c])],
    );
    return id;
  }

  /** The row as really stored, read around RLS. */
  const stored = async (id: string) =>
    (await admin().query(`SELECT user_id, org_unit_id, tenant_id, prompt_tokens, completion_tokens, cost_usd::text AS cost_usd, outcome FROM ai_usage_events WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("AIP Company A");
    B = await createCompany("AIP Company B");
    u1 = await createUser("aip01-u1@mock.test", "AIP One");
    u2 = await createUser("aip01-u2@mock.test", "AIP Two");
    unitA = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1, $2, 'd-aip', 'department', 'AIP Dept')`, [unitA, A]),
    );
  });
  afterAll(async () => { await teardownTestDb(); });

  // ── RLS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("RLS", () => {
    it("is ENABLED and FORCED with exactly one tenant_isolation policy, FOR ALL, over app_current_tenants()", async () => {
      const c = await admin().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'ai_usage_events'::regclass`);
      expect(c.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const p = await admin().query(`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'ai_usage_events'`);
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].policyname).toBe("tenant_isolation");
      expect(p.rows[0].cmd).toBe("ALL");
      expect(p.rows[0].qual).toContain("app_current_tenants()");
      expect(p.rows[0].with_check).toContain("app_current_tenants()");
    });

    it("company A writes and company B sees zero rows; A sees its own", async () => {
      const id = newId();
      await withTenants([A], (c) =>
        c.query(`INSERT INTO ai_usage_events (id, tenant_id, surface, capability, tokens_source, outcome) VALUES ($1, $2, 'assistant', 'chat', 'provider', 'ok')`, [id, A]),
      );
      const seenByB = await withTenants([B], (c) => c.query(`SELECT id FROM ai_usage_events WHERE id = $1`, [id]));
      expect(seenByB.rows).toHaveLength(0);
      const countB = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events`));
      expect(countB.rows[0].n).toBe(0);
      const seenByA = await withTenants([A], (c) => c.query(`SELECT id FROM ai_usage_events WHERE id = $1`, [id]));
      expect(seenByA.rows).toHaveLength(1);
      expect((await stored(id)).tenant_id).toBe(A); // really there, around RLS
    });

    it("no tenant context reads zero rows (fail-closed)", async () => {
      await put({ tenant_id: A });
      const r = await withGlobal((c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_usage_events`));
      expect(r.rows[0].n).toBe(0);
    });

    it("a company cannot write a row for another company (WITH CHECK)", async () => {
      await expect(
        withTenants([A], (c) =>
          c.query(`INSERT INTO ai_usage_events (id, tenant_id, surface, capability, tokens_source, outcome) VALUES ($1, $2, 'assistant', 'chat', 'provider', 'ok')`, [newId(), B]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("the daily view applies the READER's RLS (security_invoker)", async () => {
      await put({ tenant_id: B, occurred_at: "2026-02-01T10:00:00Z", model: "rls-probe-model" });
      const underA = await withTenants([A], (c) => c.query(`SELECT model FROM ai_usage_daily WHERE model = 'rls-probe-model'`));
      expect(underA.rows).toHaveLength(0);
      const underB = await withTenants([B], (c) => c.query(`SELECT model FROM ai_usage_daily WHERE model = 'rls-probe-model'`));
      expect(underB.rows).toHaveLength(1);
      const none = await withGlobal((c) => c.query(`SELECT model FROM ai_usage_daily WHERE model = 'rls-probe-model'`));
      expect(none.rows).toHaveLength(0);
      const opt = await admin().query(`SELECT reloptions FROM pg_class WHERE oid = 'ai_usage_daily'::regclass`);
      expect(opt.rows[0].reloptions).toContain("security_invoker=true");
    });
  });

  // ── append-only ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("append-only", () => {
    it("the app role cannot UPDATE a count, an amount, an outcome, the time or the tenant", async () => {
      const id = await put({ tenant_id: A, user_id: u1, prompt_tokens: 10, cost_usd: "0.01", cost_source: "table" });
      for (const set of ["prompt_tokens = 999", "cost_usd = 0", "outcome = 'error'", "occurred_at = now() - interval '1 day'", "surface = 'bot'", `tenant_id = '${B}'`]) {
        await expect(withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET ${set} WHERE id = $1`, [id])), set).rejects.toThrow(/append-only|row-level security/);
      }
      const row = await stored(id);
      expect(row.prompt_tokens).toBe(10);
      expect(row.cost_usd).toBe("0.01000000");
      expect(row.tenant_id).toBe(A);
    });

    it("the app role cannot DELETE a row", async () => {
      const id = await put({ tenant_id: A });
      await expect(withTenants([A], (c) => c.query(`DELETE FROM ai_usage_events WHERE id = $1`, [id]))).rejects.toThrow(/append-only/);
      expect(await stored(id)).toBeTruthy();
    });

    it("an identity may be cleared, but never set or changed to another value", async () => {
      const id = await put({ tenant_id: A, user_id: u1, org_unit_id: unitA });
      await expect(withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET user_id = $2 WHERE id = $1`, [id, u2]))).rejects.toThrow(/append-only/);
      expect((await stored(id)).user_id).toBe(u1);
      await withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET user_id = NULL WHERE id = $1`, [id]));
      expect((await stored(id)).user_id).toBeNull();
      const bare = await put({ tenant_id: A });
      await expect(withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET user_id = $2 WHERE id = $1`, [bare, u1]))).rejects.toThrow(/append-only/);
      await expect(withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET org_unit_id = $2 WHERE id = $1`, [bare, unitA]))).rejects.toThrow(/append-only/);
    });

    it("clearing an identity AND changing a count in one UPDATE is refused", async () => {
      const id = await put({ tenant_id: A, user_id: u1, prompt_tokens: 1 });
      await expect(withTenants([A], (c) => c.query(`UPDATE ai_usage_events SET user_id = NULL, prompt_tokens = 2 WHERE id = $1`, [id]))).rejects.toThrow(/append-only/);
      expect((await stored(id)).user_id).toBe(u1);
    });

    it("deleting a user clears user_id through the FK and keeps the row (the trigger lets the FK's SET NULL through)", async () => {
      const doomed = await createUser("aip01-doomed@mock.test", "Doomed");
      const id = await put({ tenant_id: A, user_id: doomed, prompt_tokens: 42, cost_usd: "0.5", cost_source: "provider" });
      await admin().query(`DELETE FROM users WHERE id = $1`, [doomed]);
      const row = await stored(id);
      expect(row.user_id).toBeNull();
      expect(row.prompt_tokens).toBe(42);
    });

    it("deleting a department clears org_unit_id through the FK and keeps the row", async () => {
      const unit = newId();
      await withTenants([A], (c) => c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1, $2, 'd-gone', 'department', 'Gone')`, [unit, A]));
      const id = await put({ tenant_id: A, org_unit_id: unit });
      await admin().query(`DELETE FROM org_units WHERE id = $1`, [unit]);
      expect((await stored(id)).org_unit_id).toBeNull();
    });

    it("the migration's own grant block leaves a runtime role with SELECT and INSERT only (replayed against a throwaway role)", async () => {
      const role = "aiu_probe_app";
      const other = "aiu_probe_other";
      const sql = readFileSync(join(__dirname, "..", "..", "..", "migrations", MIGRATION), "utf8");
      const start = sql.indexOf("-- ══ (6) grants");
      const end = sql.indexOf("-- ══ (7) self-check");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const block = sql.slice(start, end).replace(/platform_app/g, role);
      const a = admin();
      try {
        await a.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await a.query(`DO $$ BEGIN CREATE ROLE ${other} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        // What the owner's default privileges hand every new table, before the migration narrows it.
        await a.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ai_usage_events, ai_usage_daily TO ${role}`);
        await a.query(block);
        const priv = async (r: string, p: string) => (await a.query(`SELECT has_table_privilege($1, 'ai_usage_events', $2) AS ok`, [r, p])).rows[0].ok as boolean;
        expect(await priv(role, "SELECT")).toBe(true);
        expect(await priv(role, "INSERT")).toBe(true);
        expect(await priv(role, "UPDATE")).toBe(false);
        expect(await priv(role, "DELETE")).toBe(false);
        expect(await priv(role, "TRUNCATE")).toBe(false);
        const view = async (p: string) => (await a.query(`SELECT has_table_privilege($1, 'ai_usage_daily', $2) AS ok`, [role, p])).rows[0].ok as boolean;
        expect(await view("SELECT")).toBe(true);
        expect(await view("INSERT")).toBe(false);
        expect(await view("DELETE")).toBe(false);
        const fn = async (r: string) => (await a.query(`SELECT has_function_privilege($1, 'ai_usage_erase_user(uuid)', 'EXECUTE') AS ok`, [r])).rows[0].ok as boolean;
        expect(await fn(role)).toBe(true);
        expect(await fn(other)).toBe(false); // revoked from PUBLIC
      } finally {
        await a.query(`GRANT EXECUTE ON FUNCTION ai_usage_erase_user(uuid) TO PUBLIC`).catch(() => {});
        await a.query(`DROP OWNED BY ${role}`).catch(() => {});
        await a.query(`DROP OWNED BY ${other}`).catch(() => {});
        await a.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        await a.query(`DROP ROLE IF EXISTS ${other}`).catch(() => {});
      }
    });
  });

  // ── erasure ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("erasure", () => {
    it("ai_usage_erase_user nulls user_id in every company and keeps every count, amount and department", async () => {
      const eraseMe = await createUser("aip01-erase@mock.test", "Erase Me");
      const keep = await createUser("aip01-keep@mock.test", "Keep Me");
      const a1 = await put({ tenant_id: A, user_id: eraseMe, org_unit_id: unitA, prompt_tokens: 100, completion_tokens: 50, cost_usd: "0.0123", cost_source: "table", model: "m1" });
      const a2 = await put({ tenant_id: A, user_id: eraseMe, prompt_tokens: 7, tokens_source: "estimate" });
      const b1 = await put({ tenant_id: B, user_id: eraseMe, prompt_tokens: 3, completion_tokens: 1, cost_usd: "0.5", cost_source: "provider" });
      const k1 = await put({ tenant_id: A, user_id: keep, prompt_tokens: 9 });
      const before = await Promise.all([a1, a2, b1].map(stored));

      const r = await admin().query<{ n: string }>(`SELECT ai_usage_erase_user($1) AS n`, [eraseMe]);
      expect(Number(r.rows[0].n)).toBe(3);

      const after = await Promise.all([a1, a2, b1].map(stored));
      for (let i = 0; i < 3; i++) {
        expect(after[i].user_id).toBeNull();
        expect({ ...after[i], user_id: null }).toEqual({ ...before[i], user_id: null }); // everything else byte-identical
      }
      expect(after[0].org_unit_id).toBe(unitA);
      expect((await stored(k1)).user_id).toBe(keep);

      const again = await admin().query<{ n: string }>(`SELECT ai_usage_erase_user($1) AS n`, [eraseMe]);
      expect(Number(again.rows[0].n)).toBe(0); // idempotent
    });

    it("the company's daily totals are unchanged by an erasure (only the person's identity goes)", async () => {
      const gone = await createUser("aip01-gone@mock.test", "Gone");
      await put({ tenant_id: A, user_id: gone, occurred_at: "2026-04-01T09:00:00Z", model: "totals-probe", prompt_tokens: 40, completion_tokens: 10, cost_usd: "0.2", cost_source: "table" });
      await put({ tenant_id: A, user_id: null, occurred_at: "2026-04-01T09:30:00Z", model: "totals-probe", prompt_tokens: 60, completion_tokens: 20, cost_usd: "0.3", cost_source: "table" });
      const total = async () =>
        (await admin().query(`SELECT sum(calls)::int AS calls, sum(prompt_tokens)::int AS p, sum(completion_tokens)::int AS c, sum(cost_usd)::text AS cost FROM ai_usage_daily WHERE model = 'totals-probe'`)).rows[0];
      const before = await total();
      await admin().query(`SELECT ai_usage_erase_user($1)`, [gone]);
      expect(await total()).toEqual(before);
      expect(before).toEqual({ calls: 2, p: 100, c: 30, cost: "0.50000000" });
    });

    it("refuses a null user id", async () => {
      await expect(admin().query(`SELECT ai_usage_erase_user(NULL)`)).rejects.toThrow(/user id is required/);
    });

    it("restores the caller's tenant context after it runs (the widening does not leak)", async () => {
      const probe = await createUser("aip01-ctx@mock.test", "Ctx");
      await put({ tenant_id: A, user_id: probe });
      await admin().query(`GRANT EXECUTE ON FUNCTION ai_usage_erase_user(uuid) TO ${APP_ROLE}`); // what the migration grants platform_app
      const seen = await withTenants([A], async (c) => {
        const r = await c.query<{ n: string }>(`SELECT ai_usage_erase_user($1) AS n`, [probe]);
        const ctx = await c.query<{ v: string }>(`SELECT current_setting('app.current_tenant_ids', true) AS v`);
        return { n: Number(r.rows[0].n), ctx: ctx.rows[0].v };
      });
      expect(seen).toEqual({ n: 1, ctx: A });
    });

    it("the TypeScript wrapper erases through the app role with no tenant context, and a non-uuid is refused", async () => {
      const w = await createUser("aip01-wrap@mock.test", "Wrap");
      const id = await put({ tenant_id: B, user_id: w, prompt_tokens: 5 });
      await admin().query(`GRANT EXECUTE ON FUNCTION ai_usage_erase_user(uuid) TO ${APP_ROLE}`);
      expect(await eraseAiUsageForUser(w)).toBe(1);
      expect((await stored(id)).user_id).toBeNull();
      expect((await stored(id)).prompt_tokens).toBe(5);
      await expect(eraseAiUsageForUser("not-a-uuid")).rejects.toThrow(/uuid/);
    });

    it("works when the function's owner is NOSUPERUSER NOBYPASSRLS, as platform_owner is live (FORCE RLS applies to the owner)", async () => {
      const a = admin();
      const owner = "aiu_owner_probe";
      const victim = await createUser("aip01-owner@mock.test", "Owner Probe");
      const id = await put({ tenant_id: A, user_id: victim, prompt_tokens: 11 });
      const orig = (await a.query<{ u: string }>(`SELECT current_user AS u`)).rows[0].u;
      try {
        await a.query(`DO $$ BEGIN CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await a.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${owner}`);
        await a.query(`GRANT SELECT ON companies TO ${owner}`);
        await a.query(`ALTER TABLE ai_usage_events OWNER TO ${owner}`);
        await a.query(`ALTER FUNCTION ai_usage_erase_user(uuid) OWNER TO ${owner}`);

        // Negative control: as that owner with no tenant context, FORCE RLS hides every row, so a plain UPDATE clears NOTHING and reports success.
        const c = await a.connect();
        try {
          await c.query(`SET ROLE ${owner}`);
          const plain = await c.query(`UPDATE ai_usage_events SET user_id = NULL WHERE user_id = $1`, [victim]);
          expect(plain.rowCount).toBe(0);
          await c.query(`RESET ROLE`);
        } finally {
          c.release();
        }
        expect((await stored(id)).user_id).toBe(victim);

        // The function, running with the owner's rights, still clears it: it sets the tenant context itself.
        const r = await a.query<{ n: string }>(`SELECT ai_usage_erase_user($1) AS n`, [victim]);
        expect(Number(r.rows[0].n)).toBe(1);
        expect((await stored(id)).user_id).toBeNull();
      } finally {
        await a.query(`ALTER FUNCTION ai_usage_erase_user(uuid) OWNER TO ${orig}`).catch(() => {});
        await a.query(`ALTER TABLE ai_usage_events OWNER TO ${orig}`).catch(() => {});
        await a.query(`DROP OWNED BY ${owner}`).catch(() => {});
        await a.query(`DROP ROLE IF EXISTS ${owner}`).catch(() => {});
      }
    });
  });

  // ── CHECKs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("CHECKs (through the superuser pool, which bypasses RLS but never a CHECK)", () => {
    it("admits a minimal row and a full row", async () => {
      await expect(put({ tenant_id: A })).resolves.toBeTruthy();
      await expect(
        put({
          tenant_id: A, user_id: u1, org_unit_id: unitA, task: "title.generate", tier: "cheap", provider: "openai", model: "glm-5.3-flash",
          prompt_tokens: 0, completion_tokens: 0, tokens_source: "estimate", cost_usd: "0", cost_source: "provider", outcome: "incurred",
          thread_id: newId(), run_id: newId(), gateway_provider_hint: "openrouter",
        }),
      ).resolves.toBeTruthy();
    });

    const cases: Array<[string, Row, RegExp]> = [
      ["a bad surface", { surface: "email" }, /ck_ai_usage_events_surface/],
      ["a bad capability", { capability: "image" }, /ck_ai_usage_events_capability/],
      ["a bad tokens_source", { tokens_source: "guess" }, /ck_ai_usage_events_tokens_source/],
      ["a bad outcome", { outcome: "done" }, /ck_ai_usage_events_outcome/],
      ["a bad cost_source", { cost_usd: "1", cost_source: "invoice" }, /ck_ai_usage_events_cost_source/],
      ["a cost with no cost_source", { cost_usd: "1", cost_source: null }, /ck_ai_usage_events_cost_source_required/],
      ["a negative prompt_tokens", { prompt_tokens: -1 }, /ck_ai_usage_events_prompt_tokens/],
      ["a negative completion_tokens", { completion_tokens: -5 }, /ck_ai_usage_events_completion_tokens/],
      ["a negative cost_usd", { cost_usd: "-0.01", cost_source: "table" }, /ck_ai_usage_events_cost/],
      ["a model label over 120 characters (a sentence cannot ride in)", { model: "x".repeat(121) }, /ck_ai_usage_events_labels/],
      ["a task label over 120 characters", { task: "y".repeat(500) }, /ck_ai_usage_events_labels/],
    ];
    for (const [name, over, re] of cases) {
      it(`refuses ${name}`, async () => {
        await expect(put({ tenant_id: A, ...over })).rejects.toThrow(re);
      });
    }

    it("refuses a NULL in each NOT NULL column (a CHECK alone would pass a NULL)", async () => {
      for (const col of ["surface", "capability", "tokens_source", "outcome", "occurred_at"]) {
        await expect(put({ tenant_id: A, [col]: null } as Row & { tenant_id: string }), col).rejects.toThrow(/null value|not-null/);
      }
    });

    it("refuses a user or a company that does not exist", async () => {
      await expect(put({ tenant_id: A, user_id: newId() })).rejects.toThrow(/foreign key/);
      await expect(put({ tenant_id: newId() })).rejects.toThrow(/foreign key/);
    });

    it("the column set is closed: exactly 20 columns, none text-shaped", async () => {
      const r = await admin().query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ai_usage_events' ORDER BY column_name`,
      );
      expect(r.rows).toHaveLength(20);
      for (const c of r.rows) expect(c.column_name).not.toMatch(/prompt$|answer|content|message|body|text|transcript|args|payload/);
      expect(r.rows.filter((c) => c.data_type === "jsonb" || c.data_type === "json")).toHaveLength(0);
    });
  });

  // ── the daily view ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("ai_usage_daily", () => {
    it("sums correctly across two UTC days and two people, whatever the session time zone", async () => {
      const m = "view-probe-model";
      const base = { tenant_id: A, provider: "openai", model: m } as const;
      await put({ ...base, user_id: u1, occurred_at: "2026-03-01T10:00:00Z", prompt_tokens: 100, completion_tokens: 50, cost_usd: "0.01", cost_source: "provider", tokens_source: "provider" });
      await put({ ...base, user_id: u1, occurred_at: "2026-03-01T23:30:00Z", prompt_tokens: 10, completion_tokens: 5, cost_usd: "0.005", cost_source: "table", tokens_source: "estimate" });
      await put({ ...base, user_id: u1, occurred_at: "2026-03-02T00:30:00Z", prompt_tokens: 7, completion_tokens: 3, tokens_source: "estimate" });
      await put({ ...base, user_id: u2, occurred_at: "2026-03-01T12:00:00Z", prompt_tokens: 1, completion_tokens: 1, cost_usd: "0.02", cost_source: "provider" });
      await put({ ...base, user_id: u2, occurred_at: "2026-03-01T12:00:00Z", surface: "agent", prompt_tokens: 4, completion_tokens: 4, cost_usd: "0.04", cost_source: "provider" });
      await put({ ...base, tenant_id: B, user_id: u1, occurred_at: "2026-03-01T12:00:00Z", prompt_tokens: 1000 }); // another company: its own group

      const c = await admin().connect();
      try {
        await c.query(`SET TIME ZONE 'Asia/Makassar'`); // UTC+8: 23:30Z is already the next day here, and must still count on the UTC day
        const r = await c.query(
          `SELECT tenant_id, to_char(day, 'YYYY-MM-DD') AS day, user_id, surface, calls, prompt_tokens, completion_tokens, cost_usd::text AS cost_usd, estimated_calls
             FROM ai_usage_daily WHERE model = $1 ORDER BY tenant_id, day, user_id, surface`,
          [m],
        );
        const byKey = new Map(r.rows.map((x) => [`${x.tenant_id}|${x.day}|${x.user_id}|${x.surface}`, x]));
        expect(r.rows).toHaveLength(5);

        expect(byKey.get(`${A}|2026-03-01|${u1}|assistant`)).toMatchObject({ calls: "2", prompt_tokens: "110", completion_tokens: "55", cost_usd: "0.01500000", estimated_calls: "1" });
        expect(byKey.get(`${A}|2026-03-02|${u1}|assistant`)).toMatchObject({ calls: "1", prompt_tokens: "7", completion_tokens: "3", cost_usd: null, estimated_calls: "1" }); // unknown cost stays NULL, not 0
        expect(byKey.get(`${A}|2026-03-01|${u2}|assistant`)).toMatchObject({ calls: "1", prompt_tokens: "1", completion_tokens: "1", cost_usd: "0.02000000", estimated_calls: "0" });
        expect(byKey.get(`${A}|2026-03-01|${u2}|agent`)).toMatchObject({ calls: "1", prompt_tokens: "4", completion_tokens: "4", cost_usd: "0.04000000", estimated_calls: "0" });
        expect(byKey.get(`${B}|2026-03-01|${u1}|assistant`)).toMatchObject({ calls: "1", prompt_tokens: "1000" });
      } finally {
        await c.query(`RESET TIME ZONE`).catch(() => {});
        c.release();
      }
    });
  });

  // ── the writer, end to end ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("recordAiUsage against the database", () => {
    it("writes one row under the event's own company, with the right values", async () => {
      const thread = newId();
      const r = await recordAiUsage({
        tenantId: A, userId: u1, orgUnitId: unitA, surface: "assistant", capability: "chat", task: "chat.reply", tier: "standard",
        provider: "openai", model: "glm-5.3-flash", promptTokens: 120, completionTokens: 30, tokensSource: "estimate",
        costUsd: 0.0123, costSource: "table", outcome: "ok", threadId: thread, gatewayProviderHint: "openrouter",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const row = (await admin().query(`SELECT * FROM ai_usage_events WHERE id = $1`, [r.id])).rows[0];
      expect(row).toMatchObject({
        tenant_id: A, user_id: u1, org_unit_id: unitA, surface: "assistant", capability: "chat", task: "chat.reply", tier: "standard",
        provider: "openai", model: "glm-5.3-flash", prompt_tokens: 120, completion_tokens: 30, tokens_source: "estimate",
        cost_usd: "0.01230000", cost_source: "table", outcome: "ok", thread_id: thread, run_id: null, gateway_provider_hint: "openrouter",
      });
      expect(row.occurred_at).toBeInstanceOf(Date);
      // company B cannot see it
      expect((await withTenants([B], (c) => c.query(`SELECT 1 FROM ai_usage_events WHERE id = $1`, [r.id]))).rows).toHaveLength(0);
    });

    it("a database failure (a user that does not exist) returns { ok: false }, warns once with ids only, and stores nothing", async () => {
      const warn = vi.fn();
      const ghost = newId();
      const r = await recordAiUsage({ tenantId: A, userId: ghost, surface: "bot", capability: "llm", model: "ghost-model-x", tokensSource: "none", outcome: "error" }, { warn });
      expect(r).toEqual({ ok: false, reason: "database error 23503" });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain(`tenantId=${A}`);
      expect(line).toContain(`userId=${ghost}`);
      expect(line).not.toMatch(/ghost-model-x|bot|violates/);
      expect((await admin().query(`SELECT 1 FROM ai_usage_events WHERE model = 'ghost-model-x'`)).rows).toHaveLength(0);
    });

    it("an event for a company that does not exist is refused by the database, not thrown", async () => {
      const warn = vi.fn();
      const r = await recordAiUsage({ tenantId: newId(), surface: "other", capability: "embed", tokensSource: "none", outcome: "ok" }, { warn });
      expect(r.ok).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});
