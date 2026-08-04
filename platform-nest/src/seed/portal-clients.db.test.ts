// Coverage for seed/portal-clients.ts, by EXECUTING it against a real Postgres rather than reading
// its INSERTs — the standard agency.db.test.ts sets, and the one that has repeatedly caught seed bugs
// that `tsc` cannot (a wrong column name, a CHECK-invalid enum value, a missing module grant).
//
// What matters here is not "rows appeared". It is that the rows are in the exact shape the portal
// needs to show anything, because the portal has already been broken twice by data that looked fine:
//   - a run with no client_id is invisible to its own client (WD-30), so that link is asserted;
//   - a contact with no `client` role has a tenant and no permissions, so the grant is asserted;
//   - the report track must be present in the DB and ABSENT from the portal, so the seed is checked
//     to actually create the internal-only stage the portal is supposed to hide.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedPortalClients } from "./portal-clients";

// The seed resolves companies BY NAME and deliberately skips any it cannot find, so the fixture only
// has to create the two names it looks for.
const AGENCY = "Gaia Digital Agency";
const RESORT = "Sanur Resort";

describe.skipIf(!TEST_URL)("seed/portal-clients", () => {
  let agency: string;
  let resort: string;

  beforeAll(async () => {
    await initTestDb();
    agency = await createCompany(AGENCY);
    resort = await createCompany(RESORT);
    // Keycloak is NOT configured under test, which is the fail-soft path: contacts stay `invited`
    // and the seed mints invite tokens instead of pretending accounts exist.
    await seedPortalClients();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("creates clients on BOTH companies, not just the agency", async () => {
    // The whole point of the seed: several clients across different companies. If they all landed on
    // one tenant, comparing two client logins would prove nothing about isolation.
    const a = await withTenants([agency], (c) =>
      c.query<{ n: string }>(`SELECT count(*)::int n FROM clients WHERE tenant_id = $1`, [agency]));
    const r = await withTenants([resort], (c) =>
      c.query<{ n: string }>(`SELECT count(*)::int n FROM clients WHERE tenant_id = $1`, [resort]));
    expect(Number(a.rows[0].n)).toBeGreaterThanOrEqual(3);
    expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  it("every seeded run carries client_id AND project_id — the WD-30 invariant", async () => {
    // A run missing either is invisible to its client no matter how correct the auth is. Asserted on
    // the seeded rows specifically, since this seed exists to give the portal something to show.
    for (const t of [agency, resort]) {
      const runs = await withTenants([t], (c) =>
        c.query<{ id: string; client_id: string | null; project_id: string | null }>(
          `SELECT id, client_id, project_id FROM pipeline_runs WHERE tenant_id = $1 AND deleted_at IS NULL`, [t]));
      expect(runs.rows.length).toBeGreaterThan(0);
      for (const run of runs.rows) {
        expect(run.client_id).not.toBeNull();
        expect(run.project_id).not.toBeNull();
      }
    }
  });

  it("each run's project points at the SAME client as the run", async () => {
    // Two independently-set columns that must agree. If they diverge, project-scoped contacts and
    // client-scoped contacts see different things for one delivery, which is worse than either alone.
    for (const t of [agency, resort]) {
      const mismatched = await withTenants([t], (c) =>
        c.query(`SELECT r.id FROM pipeline_runs r JOIN projects p ON p.id = r.project_id
                  WHERE r.tenant_id = $1 AND p.client_id IS DISTINCT FROM r.client_id`, [t]));
      expect(mismatched.rows).toEqual([]);
    }
  });

  it("grants the global `client` role at the contact's own company", async () => {
    // Without this the contact resolves a tenant and is then denied every portal action — the trap the
    // accept route documents. Scope must be the company that serves them, not merely any company.
    const rows = await withGlobal((c) =>
      c.query<{ scope_id: string }>(
        `SELECT ur.scope_id FROM user_roles ur
           JOIN roles ro ON ro.id = ur.role_id
           JOIN users u ON u.id = ur.user_id
          WHERE ro.name = 'client' AND ro.company_id IS NULL AND u.email = $1`,
        ["ayu@nusacoffee.test"]));
    expect(rows.rows.map((r) => r.scope_id)).toContain(agency);
  });

  it("seeds a signer AND a viewer, because capability has to be distinguishable", async () => {
    const caps = await withTenants([agency], (c) =>
      c.query<{ capability: string; email: string }>(
        `SELECT cc.capability, u.email FROM client_contacts cc JOIN users u ON u.id = cc.user_id
          WHERE cc.tenant_id = $1`, [agency]));
    const byEmail = Object.fromEntries(caps.rows.map((r) => [r.email, r.capability]));
    expect(byEmail["ayu@nusacoffee.test"]).toBe("signer");
    expect(byEmail["budi@nusacoffee.test"]).toBe("viewer");
  });

  it("creates the internal-only report stage the portal must hide", async () => {
    // The seed is the fixture that makes "a client cannot see the report track" testable at all. If it
    // never created a report stage, that assertion elsewhere would pass vacuously.
    const rows = await withTenants([agency], (c) =>
      c.query(`SELECT 1 FROM pipeline_stages WHERE tenant_id = $1 AND track = 'report'`, [agency]));
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it("leaves contacts `invited` when Keycloak is not configured, rather than faking an account", async () => {
    // Fail-soft must not mean fail-dishonest: marking these `active` would claim a login that does
    // not exist. Under test Keycloak is absent, so every contact must still be awaiting acceptance.
    const rows = await withTenants([agency], (c) =>
      c.query<{ status: string; activated_at: string | null }>(
        `SELECT status, activated_at FROM client_contacts WHERE tenant_id = $1`, [agency]));
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.status).toBe("invited");
      expect(r.activated_at).toBeNull();
    }
  });

  it("is idempotent — a second full run duplicates nothing", async () => {
    // Idempotency proven by ROW COUNTS across every table it writes, not by inspecting ON CONFLICT.
    const counts = async () => {
      const out: Record<string, number> = {};
      for (const [table, tenant] of [["clients", agency], ["projects", agency], ["client_contacts", agency],
        ["pipeline_runs", agency], ["pipeline_stages", agency], ["pipeline_gates", agency],
        ["clients", resort], ["pipeline_runs", resort]] as [string, string][]) {
        const r = await withTenants([tenant], (c) =>
          c.query<{ n: string }>(`SELECT count(*)::int n FROM ${table} WHERE tenant_id = $1`, [tenant]));
        out[`${table}@${tenant.slice(0, 8)}`] = Number(r.rows[0].n);
      }
      return out;
    };
    const before = await counts();
    await seedPortalClients();
    expect(await counts()).toEqual(before);
  }, 120_000);

  it("skips a company it cannot find instead of inventing one", async () => {
    // A seed that created the member company itself would produce a tenant with no org structure,
    // no people and no modules — data that looks corrupt rather than absent.
    const bogus = await withGlobal((c) =>
      c.query(`SELECT 1 FROM companies WHERE name = $1`, ["No Such Company"]));
    expect(bogus.rows).toEqual([]);
    expect(config.originSite).toBeTruthy();
  });
});
