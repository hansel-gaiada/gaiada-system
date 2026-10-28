// SCP-Sa2 — 202610280100_social_account_kind.sql (owner ruling SCP-D9; BFF §63.1 file 8) against LIVE Postgres. Needs
// DATABASE_URL_TEST; skipped without it (the file-text checks at the top always run). initTestDb() gives this file its own
// fully migrated database, which this file REWINDS to the pre-migration shape (no CHECK, no triggers), plants the live
// shapes the migration must handle, and then applies the REAL migration text as a NOSUPERUSER NOBYPASSRLS owner of the two
// tables, the way the live migration role (platform_owner) meets them (the 202610160500 test's idiom).
//
// Proves:
//   (M1) PREMISE: that owner reads ZERO social_accounts rows with no tenant set (why the backfill walks the companies);
//   (M2) the backfill gives every simulated row with no integration id `simulated:<network>`, in every company, soft-deleted
//        rows included, leaves `updated_at` and every real row byte-for-byte as they were, and the CHECK and triggers land;
//   (M3) it applies again without error and changes nothing;
//   (M4) social_accounts_kind_ck in both directions, NULL shapes included, on INSERT and UPDATE;
//   (M5) trg_social_accounts_kind_guard: simulated -> real never; real -> simulated only for a row that never reached an
//        engine (and only with the simulated id in the same statement); ordinary writes untouched;
//   (M6) trg_social_oauth_tokens_real_account_only: no grant row (INSERT or a moving UPDATE) on a simulated account;
//   (M7) `simulation.ts#ACCOUNT_KIND_VIOLATION_SQL` (what boot and the prepare script count) is exactly NOT the CHECK;
//   (M8) a shape the file will not guess at (a simulated row with an engine id, a real row with a simulated id, a grant on a
//        simulated account) makes it RAISE with the counts and change nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient, createUser } from "../testing/fixtures";
import { socialModule } from "../modules/social/index";
import { ACCOUNT_KIND_VIOLATION_SQL } from "../modules/social/publisher/simulation";

const MIGRATION = "202610280100_social_account_kind.sql";
const PATH = join(__dirname, "..", "..", "migrations", MIGRATION);
const MIGRATION_SQL = readFileSync(PATH, "utf8");
const OWNER = "sk_migrator_test";

describe("SCP-Sa2 · the migration file (no database needed)", () => {
  const code = MIGRATION_SQL.split("\n").map((l) => (l.includes("--") ? l.slice(0, l.indexOf("--")) : l)).join("\n");

  it("is registered in the social module, after 202610271600", () => {
    const m = socialModule.migrations as string[];
    expect(m).toContain(MIGRATION);
    expect(m.indexOf(MIGRATION)).toBeGreaterThan(m.indexOf("202610271600_social_simulation.sql"));
  });

  it("is LF only, grants nothing, defines nothing SECURITY DEFINER, and never writes the ledger", () => {
    expect(MIGRATION_SQL).not.toMatch(/\r/);
    expect(code).not.toMatch(/^\s*GRANT\b/im); // statement-leading: the RAISE text says "OAuth grant(s)"
    expect(code).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).not.toMatch(/\bBYPASSRLS\b/i);
    expect(code).not.toMatch(/schema_migrations/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("the one data change touches simulated rows with no id only, after BOTH GUCs are set for the company", () => {
    const updates = [...code.matchAll(/\bUPDATE\s+social_accounts\b[\s\S]*?;/g)].map((m) => m[0]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET postiz_integration_id = 'simulated:' \|\| network\s+WHERE simulated AND postiz_integration_id IS NULL;/);
    const at = code.indexOf(updates[0]);
    expect(code.lastIndexOf("set_config('app.current_tenant_ids'", at)).toBeGreaterThan(-1);
    expect(code.lastIndexOf("set_config('app.scopes', 'social'", at)).toBeGreaterThan(-1);
  });

  it("declares the CHECK the contract names, and both triggers", () => {
    expect(code).toMatch(/ADD CONSTRAINT social_accounts_kind_ck CHECK/);
    expect(code).toMatch(/CREATE TRIGGER trg_social_accounts_kind_guard\s+BEFORE UPDATE OF simulated ON social_accounts/);
    expect(code).toMatch(/CREATE TRIGGER trg_social_oauth_tokens_real_account_only\s+BEFORE INSERT OR UPDATE OF account_id, tenant_id ON social_oauth_tokens/);
  });
});

describe.skipIf(!TEST_URL)("SCP-Sa2 · migration 202610280100 over live shapes (NOBYPASSRLS owner, applied twice)", () => {
  let A: string;
  let B: string;
  let clientA: string;
  let clientB: string;
  let orgA: string;
  let orgB: string;
  let person: string;
  const ids: Record<string, string> = {};
  let seq = 0;
  const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);

  /** Run `sql` in one transaction, as `role` when given (SET LOCAL ROLE: RLS then applies to it like to any non-bypass role). */
  async function runAs(sql: string, role?: string): Promise<{ notices: string[] }> {
    const client = await adminPool().connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await client.query("BEGIN");
      if (role) await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { notices };
  }

  async function account(tenant: string, o: {
    simulated?: boolean; integration?: string | null; connectedBy?: string | null; deleted?: boolean; network?: string;
  } = {}): Promise<string> {
    const id = newId();
    const [client, org] = tenant === A ? [clientA, orgA] : [clientB, orgB];
    await q(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site, simulated,
                                    postiz_integration_id, connected_by, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,'connected','central',$7,$8,$9,$10)`,
      [id, tenant, client, org, o.network ?? "instagram", `@kind-${++seq}`, o.simulated ?? false, o.integration ?? null,
        o.connectedBy ?? null, o.deleted ? new Date() : null],
    );
    return id;
  }
  const revokedToken = (tenant: string, accountId: string) => q(
    `INSERT INTO social_oauth_tokens (tenant_id, account_id, network, status, expires_at, revoked_at, revoked_reason)
     VALUES ($1,$2,'linkedin','revoked',now(),now(),'SCP-Sa2 test')`,
    [tenant, accountId],
  );
  const refusesCheck = (p: Promise<unknown>) => expect(p).rejects.toThrow(/violates check constraint "social_accounts_kind_ck"/);
  const rows = async (where = "TRUE") => (await q(
    `SELECT id, simulated, postiz_integration_id, connected_by, deleted_at, updated_at FROM social_accounts WHERE ${where} ORDER BY id`,
  )).rows;

  const REWIND = `
    DROP TRIGGER IF EXISTS trg_social_accounts_kind_guard ON social_accounts;
    DROP TRIGGER IF EXISTS trg_social_oauth_tokens_real_account_only ON social_oauth_tokens;
    DROP FUNCTION IF EXISTS social_accounts_kind_guard();
    DROP FUNCTION IF EXISTS social_oauth_tokens_real_account_only();
    ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_kind_ck;`;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("SCP-Sa2 Kind Agency A", ["social"]);
    B = await createCompany("SCP-Sa2 Kind Agency B", ["social"]);
    clientA = await createClient(A, "Kind Client A");
    clientB = await createClient(B, "Kind Client B");
    person = await createUser(`kind-${newId()}@example.test`);
    orgA = newId();
    orgB = newId();
    for (const [org, t, c] of [[orgA, A, clientA], [orgB, B, clientB]]) {
      await q(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
               VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`, [org, t, c, `kind-org-${org}`]);
    }

    // (1) REWIND to the pre-migration shape, then plant every live shape.
    await q(REWIND);
    ids.seeded = await account(A, { simulated: true, integration: "simulated:instagram" });        // SCP-Sb's seed
    ids.cp21 = await account(A, { simulated: true, network: "facebook" });                         // prepare --apply before this file
    ids.ownerMarked = await account(B, { simulated: true, network: "tiktok", deleted: true });     // the three live rows' shape
    ids.realNull = await account(A);                                                               // CP-21 demo row, not marked
    ids.realEngine = await account(A, { integration: "ig_1234" });                                 // a Postiz account
    ids.realDirect = await account(B, { integration: "direct:linkedin", connectedBy: person, network: "linkedin" });
    await q(`UPDATE social_accounts SET updated_at = '2026-10-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [Object.values(ids)]);

    // (2) The migration role: owns both tables, no BYPASSRLS, no superuser.
    await q(`
      DO $$ BEGIN CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      ALTER ROLE ${OWNER} NOSUPERUSER NOBYPASSRLS;
      ALTER TABLE social_accounts OWNER TO ${OWNER};
      ALTER TABLE social_oauth_tokens OWNER TO ${OWNER};
      GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER};
      GRANT SELECT ON companies TO ${OWNER};
    `);
  }, 120_000);
  afterAll(teardownTestDb);

  it("(M1) PREMISE: the owner is subject to FORCE RLS, so with no tenant set it sees NONE of the accounts", async () => {
    const client = await adminPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${OWNER}`);
      expect((await client.query(`SELECT count(*)::int AS n FROM social_accounts`)).rows[0].n).toBe(0);
      await client.query(`SELECT set_config('app.current_tenant_ids', $1, true), set_config('app.scopes', 'social', true)`, [A]);
      expect((await client.query(`SELECT count(*)::int AS n FROM social_accounts`)).rows[0].n).toBe(4);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("(M2) as that owner: simulated rows with no id get simulated:<network> in EVERY company (deleted included); nothing else moves", async () => {
    const realBefore = await rows(`id = ANY('{${[ids.realNull, ids.realEngine, ids.realDirect, ids.seeded].join(",")}}'::uuid[])`);
    const { notices } = await runAs(MIGRATION_SQL, OWNER);
    expect(notices.join("\n")).toMatch(/\[SCP-Sa2\] simulated accounts given their simulated:<network> integration id: 2 row\(s\)/);
    const after = await rows(`id = ANY('{${Object.values(ids).join(",")}}'::uuid[])`);
    const by = (id: string) => after.find((r) => r.id === id)!;
    expect(by(ids.cp21).postiz_integration_id).toBe("simulated:facebook");
    expect(by(ids.ownerMarked).postiz_integration_id).toBe("simulated:tiktok");
    expect(by(ids.ownerMarked).deleted_at).not.toBeNull();
    // updated_at untouched on the backfilled rows; every other row byte-for-byte.
    for (const id of [ids.cp21, ids.ownerMarked]) expect((by(id).updated_at as Date).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(await rows(`id = ANY('{${[ids.realNull, ids.realEngine, ids.realDirect, ids.seeded].join(",")}}'::uuid[])`)).toEqual(realBefore);
    // The CHECK is validated over every row, and both triggers are enabled.
    expect((await q(`SELECT convalidated FROM pg_constraint WHERE conname = 'social_accounts_kind_ck'`)).rows).toEqual([{ convalidated: true }]);
    expect((await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
                       AND tgname IN ('trg_social_accounts_kind_guard', 'trg_social_oauth_tokens_real_account_only') ORDER BY tgname`)).rows)
      .toEqual([{ tgname: "trg_social_accounts_kind_guard" }, { tgname: "trg_social_oauth_tokens_real_account_only" }]);
    for (const t of ["social_accounts", "social_oauth_tokens"]) {
      expect((await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t])).rows[0])
        .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("(M3) applies again (as the owner, and with plain psql semantics) without error, and changes nothing", async () => {
    const before = await rows();
    const { notices } = await runAs(MIGRATION_SQL, OWNER);
    expect(notices.join("\n")).toMatch(/: 0 row\(s\)/);
    await q(MIGRATION_SQL);
    expect(await rows()).toEqual(before);
    expect((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'social_accounts_kind_ck'`)).rows[0].n).toBe(1);
  });

  it("(M4) the CHECK in both directions, NULL shapes included, on INSERT and UPDATE", async () => {
    // simulated: needs a simulated: id and no connected_by
    await refusesCheck(account(A, { simulated: true, integration: null }));
    await refusesCheck(account(A, { simulated: true, integration: "ig_77" }));
    await refusesCheck(account(A, { simulated: true, integration: "Simulated:instagram" }));
    await refusesCheck(account(A, { simulated: true, integration: "simulated:instagram", connectedBy: person }));
    await expect(account(A, { simulated: true, integration: "simulated:instagram" })).resolves.toBeTypeOf("string");
    // real: never a simulated: id; NULL and engine ids and `direct:` sentinels are fine
    await refusesCheck(account(A, { integration: "simulated:instagram" }));
    await expect(account(A, { integration: null })).resolves.toBeTypeOf("string");
    await expect(account(A, { integration: "ig_88" })).resolves.toBeTypeOf("string");
    await expect(account(A, { integration: "direct:youtube", connectedBy: person, network: "youtube" })).resolves.toBeTypeOf("string");
    // UPDATE is held to it too
    await refusesCheck(q(`UPDATE social_accounts SET postiz_integration_id = 'simulated:instagram' WHERE id = $1`, [ids.realEngine]));
    await refusesCheck(q(`UPDATE social_accounts SET postiz_integration_id = NULL WHERE id = $1`, [ids.seeded]));
    await refusesCheck(q(`UPDATE social_accounts SET connected_by = $2 WHERE id = $1`, [ids.seeded, person]));
  });

  it("(M5) the kind is fixed once used: simulated -> real never; real -> simulated only for a row that never reached an engine", async () => {
    const guard = /social_accounts_kind_guard/;
    await expect(q(`UPDATE social_accounts SET simulated = false, postiz_integration_id = 'ig_1' WHERE id = $1`, [ids.seeded])).rejects.toThrow(guard);
    await expect(q(`UPDATE social_accounts SET simulated = false, postiz_integration_id = NULL WHERE id = $1`, [ids.ownerMarked])).rejects.toThrow(guard);
    // real -> simulated: refused for an engine id, a person's connection, or a grant (any status)
    const engine = await account(A, { integration: "ig_55" });
    await expect(q(`UPDATE social_accounts SET simulated = true, postiz_integration_id = 'simulated:instagram' WHERE id = $1`, [engine])).rejects.toThrow(guard);
    const connected = await account(A, { connectedBy: person });
    await expect(q(`UPDATE social_accounts SET simulated = true, postiz_integration_id = 'simulated:instagram', connected_by = NULL WHERE id = $1`, [connected])).rejects.toThrow(guard);
    const granted = await account(A, { network: "linkedin" });
    await revokedToken(A, granted);
    await expect(q(`UPDATE social_accounts SET simulated = true, postiz_integration_id = 'simulated:linkedin' WHERE id = $1`, [granted])).rejects.toThrow(guard);
    // the CP-21 shape (never reached an engine) may be marked, with its id in the same statement (prepare --apply)
    const demo = await account(A, { network: "facebook" });
    await refusesCheck(q(`UPDATE social_accounts SET simulated = true WHERE id = $1`, [demo]));
    await q(`UPDATE social_accounts SET simulated = true, postiz_integration_id = 'simulated:' || network WHERE id = $1`, [demo]);
    expect((await q(`SELECT simulated, postiz_integration_id FROM social_accounts WHERE id = $1`, [demo])).rows[0])
      .toEqual({ simulated: true, postiz_integration_id: "simulated:facebook" });
    // ordinary writes on either kind are untouched (the trigger fires only when `simulated` changes)
    await q(`UPDATE social_accounts SET status = 'disconnected', deleted_at = now() WHERE id = $1`, [ids.seeded]);
    await q(`UPDATE social_accounts SET status = 'connected', deleted_at = NULL, simulated = true WHERE id = $1`, [ids.seeded]);
    await q(`UPDATE social_accounts SET status = 'error' WHERE id = $1`, [ids.realEngine]);
  });

  it("(M6) no OAuth grant row on a simulated account: INSERT or a moving UPDATE is refused; a real account's is fine", async () => {
    const fence = /social_oauth_tokens_real_account_only/;
    await expect(revokedToken(A, ids.cp21)).rejects.toThrow(fence);
    await expect(revokedToken(A, ids.cp21)).rejects.toMatchObject({ code: "23514" });
    const real = await account(A, { network: "linkedin" });
    await revokedToken(A, real);
    await expect(q(`UPDATE social_oauth_tokens SET account_id = $2 WHERE account_id = $1`, [real, ids.cp21])).rejects.toThrow(fence);
    // a status change on a real account's grant does not fire it
    await q(`UPDATE social_oauth_tokens SET revoked_reason = 'still real' WHERE account_id = $1`, [real]);
  });

  it("(M7) ACCOUNT_KIND_VIOLATION_SQL is exactly NOT social_accounts_kind_ck, on every shape", async () => {
    const shapes: Array<[boolean, string | null, boolean]> = [];
    for (const sim of [true, false]) {
      for (const id of [null, "simulated:instagram", "ig_1", "direct:linkedin", "Simulated:x", "simulated", ""]) {
        for (const by of [false, true]) shapes.push([sim, id, by]);
      }
    }
    const values = shapes.map((_, i) => `($${i * 3 + 1}::boolean, $${i * 3 + 2}::text, $${i * 3 + 3}::boolean)`).join(", ");
    const { rows: out } = await q(
      `SELECT ${ACCOUNT_KIND_VIOLATION_SQL} AS violation,
              ((a.simulated AND a.postiz_integration_id IS NOT NULL AND a.postiz_integration_id LIKE 'simulated:%' AND a.connected_by IS NULL)
               OR (NOT a.simulated AND (a.postiz_integration_id IS NULL OR a.postiz_integration_id NOT LIKE 'simulated:%'))) AS allowed
         FROM (SELECT v.s AS simulated, v.i AS postiz_integration_id, CASE WHEN v.b THEN 'x' END AS connected_by
                 FROM (VALUES ${values}) AS v(s, i, b)) a`,
      shapes.flat(),
    );
    expect(out).toHaveLength(shapes.length);
    for (const [i, r] of out.entries()) expect(r.violation, JSON.stringify(shapes[i])).toBe(!r.allowed);
    // and the database's own CHECK agrees with the inline copy above
    const def = (await q(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'social_accounts_kind_ck'`)).rows[0].d as string;
    expect(def).toMatch(/simulated:%/);
  });

  it("(M8) a shape it will not guess at makes it RAISE with the counts, and change nothing", async () => {
    await q(REWIND);
    const simEngine = await account(A, { simulated: true, integration: "ig_999" });
    const realSim = await account(B, { integration: "simulated:facebook", network: "facebook" });
    const simGranted = await account(A, { simulated: true, integration: "simulated:linkedin", network: "linkedin" });
    await revokedToken(A, simGranted);
    const nullSim = await account(B, { simulated: true, network: "instagram", deleted: true });
    const before = await rows();
    await expect(runAs(MIGRATION_SQL, OWNER)).rejects.toThrow(
      /SCP-Sa2: 1 simulated account\(s\) carry a non-simulated integration id or a connected_by, 1 real account\(s\) carry a simulated: integration id, and 1 OAuth grant\(s\) name a simulated account/,
    );
    expect(await rows()).toEqual(before); // the backfill of `nullSim` rolled back with the rest
    expect((await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'social_accounts_kind_ck'`)).rows[0].n).toBe(0);
    // A person decides; once they have, it applies.
    await q(`DELETE FROM social_oauth_tokens WHERE account_id = $1`, [simGranted]);
    await q(`UPDATE social_accounts SET postiz_integration_id = 'simulated:instagram' WHERE id = $1`, [simEngine]);
    await q(`UPDATE social_accounts SET postiz_integration_id = 'fb_1' WHERE id = $1`, [realSim]);
    await runAs(MIGRATION_SQL, OWNER);
    expect((await q(`SELECT postiz_integration_id FROM social_accounts WHERE id = $1`, [nullSim])).rows[0].postiz_integration_id).toBe("simulated:instagram");
    expect((await q(`SELECT count(*)::int AS n FROM social_accounts a WHERE ${ACCOUNT_KIND_VIOLATION_SQL}`)).rows[0].n).toBe(0);
  });
});
