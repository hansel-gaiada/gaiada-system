// SM-01 — search-marketing module (0034/0035) RLS: served-tenant isolation + THE THIRD WALL
// (module-sliced RLS), the deliberate no-RLS search_data_cache exemption (D-4), and the additive
// integration_connections widen (0035).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised.
//
// The third wall lives in the second GUC, `app.scopes` (CSV of module keys authorized for the
// request), consumed by app_module_allowed('search'). withTenants({modules:['search']}) sets it; here
// we exercise both the real overload AND set app.scopes directly to prove the DB wall in isolation.
// `withSearch` = a request that correctly declared the search scope; plain `withTenants` = a request
// that did NOT — the exact "mis-scoped handler" of the third-wall design.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";
import type { PoolClient } from "pg";

// The 18 tenant-scoped search_* tables (search_data_cache is intentionally NOT here — it is no-RLS).
const SEARCH_TENANT_TABLES = [
  "search_properties", "search_engagements", "search_kpi_targets", "search_keyword_sets",
  "search_keywords", "search_provider_calls", "search_rank_snapshots", "search_audits",
  "search_audit_findings", "search_backlink_snapshots", "search_ai_visibility", "search_campaigns",
  "search_ad_groups", "search_ads", "search_negatives", "search_campaign_metrics_daily",
  "search_change_proposals", "search_reports",
];

// withTenants + declare the 'search' module scope (models withTenants([t], {modules:['search']})).
async function withSearch<T>(tenantIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, fn, { modules: ["search"] });
}

describe.skipIf(!TEST_URL)("search module RLS — served-tenant + third-wall + cache exemption (0034/0035)", () => {
  let A: string; // provider (agency) — serves search to B/C, never touches B's rows
  let B: string; // served company — owns its search data
  let C: string; // second served / unrelated company
  let clientB: string;
  let propertyId: string;

  beforeAll(async () => {
    await initTestDb();
    // B/C get 'search' via serving in the real flow — deliberately NOT via enabled_modules, to prove
    // the wall is scope-declaration-based, not enablement-based.
    A = await createCompany("Provider A", ["search"]);
    B = await createCompany("Served B");
    C = await createCompany("Served C");
    clientB = await createClient(B, "Client of B");

    propertyId = newId();
    await withSearch([B], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url)
         VALUES ($1,$2,$3,'example.com','https://example.com')`,
        [propertyId, B, clientB],
      ),
    );
  });
  afterAll(teardownTestDb);

  // ── FORCE-RLS sweep invariant: all 18 search_* tenant tables FORCE RLS; cache is EXEMPT ──────────
  it("all 18 search_* tenant tables FORCE RLS (rls.test.ts sweep invariant)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relkind='r' AND relname = ANY($1::text[])`,
        [SEARCH_TENANT_TABLES],
      ),
    );
    expect(rows.length).toBe(18);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("each search_* tenant table has exactly one FOR-ALL tenant_isolation policy", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies
          WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [SEARCH_TENANT_TABLES],
      ),
    );
    expect(rows.length).toBe(18);
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  it("search_data_cache is NOT RLS-enabled (the deliberate D-4 exemption)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='search_data_cache'`,
      ),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].relrowsecurity, "search_data_cache must NOT enable RLS").toBe(false);
    expect(rows[0].relforcerowsecurity, "search_data_cache must NOT force RLS").toBe(false);
  });

  // ── (a) right-tenant + module scope → rows visible ────────────────────────────────────────────────
  it("a search property for served company B is visible under withSearch([B])", async () => {
    const res = await withSearch([B], (c) => c.query(`SELECT tenant_id FROM search_properties WHERE id=$1`, [propertyId]));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(B);
  });

  // ── cross-tenant → zero rows ──────────────────────────────────────────────────────────────────────
  it("B's property is invisible to served company C and to provider A (even WITH search scope)", async () => {
    const fromC = await withSearch([C], (c) => c.query(`SELECT id FROM search_properties WHERE id=$1`, [propertyId]));
    const fromA = await withSearch([A], (c) => c.query(`SELECT id FROM search_properties WHERE id=$1`, [propertyId]));
    expect(fromC.rows.length).toBe(0);
    expect(fromA.rows.length).toBe(0);
  });

  it("WITH CHECK blocks INSERT into a tenant outside the authorized set", async () => {
    await expect(
      withSearch([B], (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url)
           VALUES (gen_random_uuid(),$1,$2,'smuggled.com','https://smuggled.com')`,
          [C, clientB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (b) THE THIRD WALL: right tenant, but the request did NOT declare the search module scope ─────
  it("right tenant WITHOUT the search module scope → ZERO rows (module wall, read)", async () => {
    // Plain withTenants([B]) sets app.current_tenant_ids but NOT app.scopes — the mis-scoped handler.
    const res = await withTenants([B], (c) => c.query(`SELECT id FROM search_properties WHERE id=$1`, [propertyId]));
    expect(res.rows.length).toBe(0);
  });

  it("right tenant with a DIFFERENT module scope (e.g. 'hr') → ZERO rows", async () => {
    const res = await withTenants([B], (c) => c.query(`SELECT id FROM search_properties WHERE id=$1`, [propertyId]), {
      modules: ["hr", "finance"],
    });
    expect(res.rows.length).toBe(0);
  });

  it("WITH CHECK blocks INSERT without the search scope declared (module wall, write)", async () => {
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url)
           VALUES (gen_random_uuid(),$1,$2,'noscope.com','https://noscope.com')`,
          [B, clientB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (d) empty tenant set → zero rows, never an error (0025 fail-closed) on every search_* table ───
  it("empty tenant set → zero rows on every search_* tenant table, no error (even with search scope)", async () => {
    for (const t of SEARCH_TENANT_TABLES) {
      const res = await withSearch([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
      expect(res.rows[0].n, `${t} under withSearch([]) must be empty, not error`).toBe(0);
    }
  });

  // ── the no-RLS cache: readable with NO tenant GUC set (proves the exemption end-to-end) ───────────
  it("search_data_cache is readable and writable with NO tenant context set", async () => {
    const key = `volume|dataforseo|kopi|google|id-ID|2360|${newId()}`;
    // Write + read through the raw runtime pool with ZERO tenant/scope GUCs — impossible for any
    // RLS-bound table, the whole point of the exemption.
    const { getPool } = await import("./index");
    await getPool().query(
      `INSERT INTO search_data_cache (cache_key, kind, payload, provider, expires_at)
       VALUES ($1,'volume','{"volume":1200}','dataforseo', now() + interval '30 days')`,
      [key],
    );
    const res = await getPool().query<{ cache_key: string }>(
      `SELECT cache_key FROM search_data_cache WHERE cache_key=$1`,
      [key],
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].cache_key).toBe(key);
  });

  // ── app_module_allowed inlines into the predicate (STABLE, once-per-scan, not per-row) ────────────
  it("app_current_tenants + app_module_allowed inline into the RLS predicate (not opaque per-row)", async () => {
    const plan = await withSearch([B], async (c) => {
      const r = await c.query<{ ["QUERY PLAN"]: string }>(`EXPLAIN (COSTS OFF) SELECT * FROM search_properties`);
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("string_to_array"); // both helpers inlined
    expect(plan).not.toContain("app_module_allowed");
    expect(plan).not.toContain("app_current_tenants");
  });

  // ── 0035 widen: additive, existing rows valid, new search providers + client owner_kind legal ─────
  it("integration_connections widen is additive — new search provider + client owner_kind insert", async () => {
    const id = newId();
    const res = await withTenants([B], (c) =>
      c.query<{ provider: string; owner_kind: string }>(
        `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site)
         VALUES ($1,$2,'client',$3,'google_search_console','central') RETURNING provider, owner_kind`,
        [id, B, clientB],
      ),
    );
    expect(res.rows[0].provider).toBe("google_search_console");
    expect(res.rows[0].owner_kind).toBe("client");
  });

  it("integration_connections still accepts the ORIGINAL providers/owner_kinds (no data loss)", async () => {
    // The pre-0035 legal values must remain legal (additive-only proof).
    const okUser = await withTenants([B], (c) =>
      c.query(
        `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site)
         VALUES (gen_random_uuid(),$1,'user',$2,'github','central') RETURNING id`,
        [B, clientB],
      ),
    );
    expect(okUser.rows.length).toBe(1);
    for (const p of ["google_analytics", "google_ads", "semrush"]) {
      const r = await withTenants([B], (c) =>
        c.query(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site)
           VALUES (gen_random_uuid(),$1,'company',$1,$2,'central') RETURNING id`,
          [B, p],
        ),
      );
      expect(r.rows.length, p).toBe(1);
    }
  });

  it("integration_connections rejects a still-invalid provider (widen did not open the field)", async () => {
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site)
           VALUES (gen_random_uuid(),$1,'company',$1,'facebook_ads','central')`,
          [B],
        ),
      ),
    ).rejects.toThrow(/integration_connections_provider_check|check constraint/);
  });
});
