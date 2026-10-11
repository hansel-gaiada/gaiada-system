// M5-G0 — the internal sentinel script. Pure planner + argument parsing always run; the DB half
// (idempotency, one transaction, tenant isolation, RLS scope) runs when DATABASE_URL_TEST is set.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { parseArgs, planSentinel, runSentinel, SentinelRefusal, type SentinelState } from "./internal-sentinel";

const TENANT = "0198a1b2-0000-7000-8000-000000000001";
const OPTS = { name: "Acme (Internal)", domain: "acme.test" };
const empty: SentinelState = { companyExists: true, internalClients: [], sameNameClients: [], property: null };

describe("internal-sentinel: parseArgs", () => {
  it("defaults to a dry run and lower-cases the domain", () => {
    const o = parseArgs(["--tenant-id", TENANT, "--name", " Acme (Internal) ", "--domain", "ACME.test"]);
    expect(o).toEqual({ tenantId: TENANT, name: "Acme (Internal)", domain: "acme.test", apply: false });
  });
  it("--apply turns writes on", () => {
    expect(parseArgs(["--tenant-id", TENANT, "--name", "x", "--domain", "a.test", "--apply"]).apply).toBe(true);
  });
  it.each([
    [["--name", "x", "--domain", "a.test"]],
    [["--tenant-id", "nope", "--name", "x", "--domain", "a.test"]],
    [["--tenant-id", TENANT, "--name", "x", "--domain", "https://a.test/"]],
    [["--tenant-id", TENANT, "--name", "x", "--domain", "a.test", "--bogus"]],
    [["--tenant-id", TENANT, "--name", "--domain", "a.test"]],
  ])("refuses %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(SentinelRefusal);
  });
});

describe("internal-sentinel: planSentinel", () => {
  it("empty database: insert the client, then the property bound to it", () => {
    const p = planSentinel(empty, OPTS);
    expect(p.refusals).toEqual([]);
    expect(p.writes).toBe(true);
    expect(p.steps).toEqual([
      { kind: "client", action: "insert", name: OPTS.name },
      { kind: "property", action: "insert", domain: "acme.test", siteUrl: "https://acme.test/" },
    ]);
  });
  it("fully present: finds both and writes nothing (the idempotent second run)", () => {
    const p = planSentinel({
      ...empty,
      internalClients: [{ id: "c1", name: "Whatever it was named" }],
      property: { id: "p1", clientId: "c1", verifiedAt: "2026-10-11T00:00:00.000Z" },
    }, OPTS);
    expect(p.writes).toBe(false);
    expect(p.refusals).toEqual([]);
    expect(p.steps.map((s) => s.action)).toEqual(["found", "found"]);
  });
  it("client present, property missing: inserts only the property", () => {
    const p = planSentinel({ ...empty, internalClients: [{ id: "c1", name: "n" }] }, OPTS);
    expect(p.steps.map((s) => `${s.kind}:${s.action}`)).toEqual(["client:found", "property:insert"]);
    expect(p.writes).toBe(true);
  });
  it("found property with NULL verified_at is flagged, never changed", () => {
    const p = planSentinel({ ...empty, internalClients: [{ id: "c1", name: "n" }], property: { id: "p1", clientId: "c1", verifiedAt: null } }, OPTS);
    expect(p.writes).toBe(false);
    expect(JSON.stringify(p.steps)).toContain("verified_at is NULL");
  });
  it("refuses: unknown tenant", () => {
    expect(planSentinel({ ...empty, companyExists: false }, OPTS).refusals).toHaveLength(1);
  });
  it("refuses: two internal clients", () => {
    const p = planSentinel({ ...empty, internalClients: [{ id: "a", name: "n" }, { id: "b", name: "n" }] }, OPTS);
    expect(p.refusals).toHaveLength(1);
    expect(p.writes).toBe(false);
  });
  it("refuses: a real client already has the name (never adopted)", () => {
    const p = planSentinel({ ...empty, sameNameClients: [{ id: "real" }] }, OPTS);
    expect(p.refusals[0]).toContain("never adopts a real client");
    expect(p.writes).toBe(false);
  });
  it("refuses: the domain already belongs to another client (never reassigned)", () => {
    const p = planSentinel({ ...empty, property: { id: "p1", clientId: "someone-else", verifiedAt: null } }, OPTS);
    expect(p.refusals[0]).toContain("never reassigns");
    expect(p.writes).toBe(false);
    const q = planSentinel({ ...empty, internalClients: [{ id: "c1", name: "n" }], property: { id: "p1", clientId: "someone-else", verifiedAt: null } }, OPTS);
    expect(q.refusals).toHaveLength(1);
  });
});

describe.skipIf(!TEST_URL)("internal-sentinel: against Postgres", () => {
  let A: string;
  let B: string;
  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Sentinel A");
    B = await createCompany("Sentinel B");
  });
  afterAll(async () => { await teardownTestDb(); });

  const counts = (t: string) => withTenants([t], async (c) => {
    const cl = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM clients WHERE is_internal AND deleted_at IS NULL`);
    const sp = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM search_properties WHERE domain = 'acme.test'`);
    return { clients: cl.rows[0].n, props: sp.rows[0].n };
  }, { modules: ["search"] });

  it("dry run writes nothing", async () => {
    const r = await runSentinel({ tenantId: A, ...OPTS, apply: false });
    expect(r.applied).toBe(false);
    expect(r.lines.join("\n")).toContain("would insert");
    expect(await counts(A)).toEqual({ clients: "0", props: "0" });
  });

  it("apply creates both rows, bound, verified, internal; second run finds and changes nothing", async () => {
    const first = await runSentinel({ tenantId: A, ...OPTS, apply: true });
    expect(first.applied).toBe(true);
    expect(first.clientId && first.propertyId).toBeTruthy();
    const row = await withTenants([A], (c) => c.query(
      `SELECT sp.site_url, sp.verified_at, sp.umami_site_id, sp.client_id, cl.is_internal
         FROM search_properties sp JOIN clients cl ON cl.id = sp.client_id WHERE sp.id = $1`, [first.propertyId]), { modules: ["search"] });
    expect(row.rows[0]).toMatchObject({ site_url: "https://acme.test/", umami_site_id: null, client_id: first.clientId, is_internal: true });
    expect(row.rows[0].verified_at).toBeInstanceOf(Date);

    const second = await runSentinel({ tenantId: A, ...OPTS, apply: true });
    expect(second.applied).toBe(false);
    expect(second.clientId).toBe(first.clientId);
    expect(second.propertyId).toBe(first.propertyId);
    expect(second.lines.join("\n")).toContain("Nothing to change");
    expect(await counts(A)).toEqual({ clients: "1", props: "1" });
  });

  it("is tenant-scoped: tenant B sees nothing of A and gets its own sentinel", async () => {
    expect(await counts(B)).toEqual({ clients: "0", props: "0" });
    const r = await runSentinel({ tenantId: B, ...OPTS, apply: true });
    expect(r.applied).toBe(true);
    expect(r.clientId).toBeTruthy();
  });

  it("refuses a name clash with a real client and writes nothing", async () => {
    const C = await createCompany("Sentinel C");
    await withTenants([C], (c) => c.query(
      `INSERT INTO clients (id, tenant_id, name, origin_site) VALUES (gen_random_uuid(), $1, $2, 'central')`, [C, OPTS.name]));
    const r = await runSentinel({ tenantId: C, ...OPTS, apply: true });
    expect(r.applied).toBe(false);
    expect(r.plan.refusals).toHaveLength(1);
    expect(await counts(C)).toEqual({ clients: "0", props: "0" });
  });

  it("a second live internal client under one tenant is rejected by the marker's unique index", async () => {
    await expect(withTenants([A], (c) => c.query(
      `INSERT INTO clients (id, tenant_id, name, origin_site, is_internal) VALUES (gen_random_uuid(), $1, 'dup', 'central', true)`, [A]))).rejects.toThrow();
  });
});
