// Regression cover for the portfolio read model — webdesk-design-v2.md §04/§07.
//
// ── WHY THIS TEST EXISTS, AND WHY IT RUNS AGAINST LIVE POSTGRES ────────────────────────────────
// `getPortfolio()` shipped without the `modules` option on its `withTenants` call. `webdev_sites`
// composes its RLS as `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')`,
// and `app_module_allowed` returns **NULL** when `app.scopes` is unset — so the predicate went
// NULL, every row was filtered out, and Postgres raised nothing. In production the console showed
// "no sites provisioned yet" while 20 live rows sat in the table.
//
// A mocked-`withTenants` test cannot catch that class of bug: the whole failure lives in the
// database's evaluation of a predicate, so the assertion has to come back through real RLS. Hence
// the live-Postgres posture already used by `console-reads.service.test.ts` in this directory.
//
// The first test below is the one that fails if the `modules` option is ever dropped again.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { withTenants } from "../../db";
import { getPortfolio } from "./portfolio-reads.service";

async function insertSite(
  tenantId: string,
  domain: string,
  environment: string,
): Promise<void> {
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `INSERT INTO webdev_sites (tenant_id, domain, environment, host_kind, access, adoption, origin, origin_site)
         VALUES ($1, $2, $3, 'unknown', 'none', 'tracked', 'manual', 'portfolio-test')`,
        [tenantId, domain, environment],
      ),
    { modules: ["webdev"] },
  );
}

describe("getPortfolio — the module scope its RLS depends on", () => {
  let tenantId: string;

  beforeAll(async () => {
    await initTestDb();
    // Enable both modules on the company as well as declaring them per-request: the GUC is what RLS
    // actually reads, but a fixture that disagrees with the request would be a misleading test.
    tenantId = await createCompany("Portfolio Co", ["webdev", "search"]);
    await insertSite(tenantId, "example-prod.test", "production");
    await insertSite(tenantId, "example-stg.test", "staging");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("returns the rows that exist, instead of silently reading zero", async () => {
    const res = await getPortfolio(tenantId);
    // The exact assertion the bug violated: rows exist, so the read must not come back empty.
    expect(res.counts.sites).toBe(2);
    expect(res.projects.length).toBeGreaterThan(0);
  });

  it("groups both environments under one unassigned bucket and marks the production one", async () => {
    const res = await getPortfolio(tenantId);
    // Neither site has a project, so both land in the single null-keyed group — an unassigned
    // domain must be visible, not hidden.
    const group = res.projects.find((p) => p.projectId === null);
    expect(group).toBeDefined();
    expect(group?.environments.map((e) => e.domain).sort()).toEqual([
      "example-prod.test",
      "example-stg.test",
    ]);
    expect(group?.production?.domain).toBe("example-prod.test");
    expect(res.counts.byEnvironment).toMatchObject({ production: 1, staging: 1 });
  });

  it("reports no crawl consent when the domain has no search_properties row", async () => {
    // `search` is in the module list so the LEFT JOIN can actually evaluate. With it omitted the
    // join would still produce these same values, which is exactly why this is asserted alongside
    // the count above rather than on its own — consent must read false because there is no row,
    // not because the module gate silently blanked it.
    const res = await getPortfolio(tenantId);
    expect(res.counts.withoutConsent).toBe(2);
  });
});
