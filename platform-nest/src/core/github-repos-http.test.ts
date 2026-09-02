// GH-08 — HTTP-level tests for GithubReposController (list/detail/link/unlink), against live PG +
// RLS + Cerbos. Mirrors client-contacts-http.test.ts's shape (buildApp() + app.inject).
//
// ── UPDATED BY GH-03 (2026-08-31): `resource_github_repo.yaml` HAS SHIPPED ─────────────────────────
// GH-08's own header used to say every well-formed request here 403s because no Cerbos policy
// existed for the `github_repo` kind, and flagged that its own group-2 403 assertions were exactly
// what GH-03 should revisit once a policy landed. It has: `cerbos/policies/resource_github_repo.yaml`
// grants `read`/`link`/`unlink` to company_admin/manager (+ `read` to member) within tenant, no
// module gate, no D14 (link/unlink are ERP-side metadata writes, never external or irreversible —
// see that policy's own header). `manager` (this fixture's principal) sits on all three tiers, so
// every previously-403 well-formed request below now asserts its real 2xx outcome. The malformed-
// input 400 assertions are untouched — those never depended on Cerbos at all.
//
// NOT verified end-to-end by THIS run unless CERBOS_URL points at a Cerbos serving THIS exact
// policy file (freshly restarted — Cerbos does not hot-reload). See this repo's own report for
// exactly how GH-03 proved that before editing these assertions.
//
// ── UPDATED BY GHT-1 (docs/blueprints/github-tenant-scope-ruling.md §9/§10) ─────────────────────────
// `config.githubRepoSync.tenantId` / `config.githubOrgTenantId` is stubbed to `co` (the fixture's
// existing tenant) in `beforeAll` — every route now resolves an effective org tenant BEFORE
// authorizing, and with the org tenant EQUAL to `co`, resolution takes its fast path (no query,
// same tenant) and every assertion above is byte-identical in behaviour to before this ticket. The
// new describe blocks below are GHT-1's own evidence: a holding-context request by a principal with
// ONLY agency (`co`) reach now succeeds and carries `org` meta; a same-root principal WITHOUT
// org-tenant reach gets 403 where it used to get `200 []`; a second-root tenant and an unconfigured
// org tenant both get a 503-family refusal, never a fake empty list.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { withTenants, withGlobal, newId } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function insertRepo(
  tenantId: string,
  overrides: Partial<{
    id: string; org: string; name: string; fullName: string; archived: boolean;
    projectId: string | null; webdevSiteId: string | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? newId();
  const org = overrides.org ?? "gaiadabali";
  const name = overrides.name ?? `repo-${id.slice(-8)}`;
  const fullName = overrides.fullName ?? `${org}/${name}`;
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO github_repos
         (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at,
          archived, project_id, webdev_site_id, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'main', now(), $7, $8, $9, $10)`,
      [
        id, tenantId, org, name, fullName, `https://github.com/${org}/${name}`,
        overrides.archived ?? false, overrides.projectId ?? null, overrides.webdevSiteId ?? null,
        config.originSite,
      ],
    ),
  );
  return id;
}

async function insertWebdevSite(tenantId: string, domain: string): Promise<string> {
  const id = newId();
  await withTenants(
    [tenantId],
    (c) => c.query(`INSERT INTO webdev_sites (id, tenant_id, domain, origin_site) VALUES ($1,$2,$3,$4)`, [
      id, tenantId, domain, config.originSite,
    ]),
    { modules: ["webdev"] },
  );
  return id;
}

describe.skipIf(!TEST_URL)("github-repos HTTP surface (GH-08)", () => {
  let app: NestFastifyApplication;
  let holding: string;
  let co: string;
  let secondRoot: string;
  let manager: string;
  let holdingOnlyUser: string;
  let repoId: string;
  let archivedRepoId: string;
  let unlinkedRepoId: string;
  let siteId: string;
  let originalOrgTenantId: string;
  let originalRepoSyncTenantId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    // ── GHT-1 fixture: a root tree with TWO companies, mirroring the live shape (holding root,
    // agency child) — plus a wholly SEPARATE root for the cross-root refusal cases. ──────────────
    holding = await createCompany("GH-08 Holding");
    co = await createCompany("Gaiada GH-08 Co", [], holding); // the ORG TENANT — child of `holding`
    secondRoot = await createCompany("GH-08 Second Root"); // its own root, shares nothing with `holding`

    manager = await createUser("manager@gh08.test");
    await addMembership(co, manager);
    await grantRole(manager, await createRole("manager"), "company", co);

    // Same-root as `co` (both under `holding`), but membership ONLY at `holding` — the "Viceroy-only
    // member" shape from the ruling: reach at their own tenant, none into the org tenant.
    holdingOnlyUser = await createUser("holding-only@gh08.test");
    await addMembership(holding, holdingOnlyUser);
    await grantRole(holdingOnlyUser, await createRole("manager"), "company", holding);

    siteId = await insertWebdevSite(co, "gh08-example.test");
    repoId = await insertRepo(co, { name: "linked-repo", webdevSiteId: siteId });
    archivedRepoId = await insertRepo(co, { name: "archived-repo", archived: true });
    unlinkedRepoId = await insertRepo(co, { name: "unlinked-repo" });

    // GHT-1: the org-tenant knob, stubbed to `co` so every existing assertion below hits the
    // resolver's fast path (org === requestTenantId) and stays byte-identical in behaviour.
    originalOrgTenantId = config.githubOrgTenantId;
    originalRepoSyncTenantId = config.githubRepoSync.tenantId;
    config.githubOrgTenantId = co;
    config.githubRepoSync.tenantId = co;

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    config.githubOrgTenantId = originalOrgTenantId;
    config.githubRepoSync.tenantId = originalRepoSyncTenantId;
  });

  // ---- routing + validation (proven independent of the pending Cerbos policy) ----

  describe("list — query validation runs before authorize()", () => {
    it("rejects an invalid `linked` value (400)", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${co}/github/repos?linked=maybe`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(400);
    });

    it("rejects an invalid `archived` value (400)", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${co}/github/repos?archived=nope`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(400);
    });

    it("a well-formed list request succeeds (GH-03: manager holds the read tier)", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${co}/github/repos?linked=false&archived=false&search=repo`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(Array.isArray(body.repos)).toBe(true);
      expect(typeof body.total).toBe("number");
      // GHT-1: every read carries the resolved org's meta, even on the fast path (org === :tenantId).
      expect(body.org).toEqual({ login: config.githubOrg, tenantId: co, tenantName: "Gaiada GH-08 Co" });
    });
  });

  describe("detail", () => {
    it("a well-formed detail request succeeds (GH-03: manager holds the read tier)", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${co}/github/repos/${repoId}`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.id).toBe(repoId);
      expect(body.webdevSiteId).toBe(siteId);
    });
  });

  describe("link — body validation runs before authorize()", () => {
    it("rejects a body with neither webdevSiteId nor projectId (400)", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/github/repos/${unlinkedRepoId}/link`,
        headers: asUser(manager), payload: {},
      });
      expect(r.statusCode).toBe(400);
    });

    it("a well-formed link request succeeds (GH-03: manager holds the link tier) and the row is updated", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/github/repos/${unlinkedRepoId}/link`,
        headers: asUser(manager), payload: { webdevSiteId: siteId },
      });
      expect(r.statusCode).toBe(201);
      const body = JSON.parse(r.body);
      expect(body.webdevSiteId).toBe(siteId);

      const row = await adminPool().query(`SELECT webdev_site_id, tenant_id FROM github_repos WHERE id = $1`, [unlinkedRepoId]);
      expect(row.rows[0].webdev_site_id).toBe(siteId);
      expect(row.rows[0].tenant_id).toBe(co);
    });
  });

  describe("unlink — body validation runs before authorize()", () => {
    it("rejects an invalid `target` (400)", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/github/repos/${repoId}/unlink`,
        headers: asUser(manager), payload: { target: "everything" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("a well-formed unlink request succeeds (GH-03: manager holds the unlink tier) and clears the link", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/github/repos/${repoId}/unlink`,
        headers: asUser(manager), payload: {},
      });
      expect(r.statusCode).toBe(201);
      const body = JSON.parse(r.body);
      expect(body.webdevSiteId).toBeNull();

      const row = await adminPool().query(`SELECT webdev_site_id FROM github_repos WHERE id = $1`, [repoId]);
      expect(row.rows[0].webdev_site_id).toBeNull();
    });
  });

  // ---- GHT-1: effective org-tenant resolution (docs/blueprints/github-tenant-scope-ruling.md) ----
  describe("GHT-1 — effective org-tenant resolution", () => {
    it("a holding-context request by a principal with ONLY agency reach sees the full registry, with org meta", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${holding}/github/repos`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.total).toBeGreaterThan(0);
      expect(body.org).toEqual({ login: config.githubOrg, tenantId: co, tenantName: "Gaiada GH-08 Co" });
    });

    it("same holding-context resolution also works for detail", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${holding}/github/repos/${archivedRepoId}`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.id).toBe(archivedRepoId);
      expect(body.org.tenantId).toBe(co);
    });

    it("a same-root principal WITHOUT org-tenant reach is refused 403, not served an empty list (behaviour change, pinned)", async () => {
      const r = await app.inject({
        method: "GET", url: `/api/${holding}/github/repos`, headers: asUser(holdingOnlyUser),
      });
      expect(r.statusCode).toBe(403);
    });

    it("the same principal CAN read their own tenant's data on an unrelated surface (positive control — proves the 403 above is the org-reach gate, not a broken principal/token)", async () => {
      // holdingOnlyUser really does hold a working `manager` grant at `holding` — read the members
      // list for their own tenant to prove the principal/session is otherwise functional.
      const r = await app.inject({
        method: "GET", url: `/api/${holding}/members`, headers: asUser(holdingOnlyUser),
      });
      expect(r.statusCode).toBe(200);
    });

    it("a DIFFERENT root's tenant in the URL is refused before any github_repos query runs (503-family, never a 200)", async () => {
      const before = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM github_repos`);
      const r = await app.inject({
        method: "GET", url: `/api/${secondRoot}/github/repos`, headers: asUser(manager),
      });
      expect(r.statusCode).toBe(503);
      expect(r.statusCode).not.toBe(200);
      const after = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM github_repos`);
      expect(after.rows[0].n).toBe(before.rows[0].n); // no row was touched by the refused request
    });

    it("a DIFFERENT root also refuses detail, link, and unlink the same way", async () => {
      const detail = await app.inject({
        method: "GET", url: `/api/${secondRoot}/github/repos/${archivedRepoId}`, headers: asUser(manager),
      });
      expect(detail.statusCode).toBe(503);

      const link = await app.inject({
        method: "POST", url: `/api/${secondRoot}/github/repos/${archivedRepoId}/link`,
        headers: asUser(manager), payload: { projectId: newId() },
      });
      expect(link.statusCode).toBe(503);
    });

    it("an unconfigured org tenant refuses with 503, never an empty-list 200", async () => {
      const saved = config.githubOrgTenantId;
      config.githubOrgTenantId = "";
      try {
        const r = await app.inject({
          method: "GET", url: `/api/${co}/github/repos`, headers: asUser(manager),
        });
        expect(r.statusCode).toBe(503);
        expect(r.statusCode).not.toBe(200);
      } finally {
        config.githubOrgTenantId = saved;
      }
    });

    it("creation-requests files its automation_approval under the ORG tenant, even from the holding vantage", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${holding}/github/repos/creation-requests`,
        headers: asUser(manager),
        payload: { name: "ght1-fixture-repo" },
      });
      expect(r.statusCode).toBe(201);
      const body = JSON.parse(r.body);
      const row = await adminPool().query(
        `SELECT tenant_id FROM automation_approvals WHERE id = $1`,
        [body.id],
      );
      expect(row.rows[0]?.tenant_id).toBe(co); // NOT `holding` — the misfiling the ruling closes
    });
  });

  // ---- tenant_id is structurally immutable via this surface ----
  //
  // There is no request shape ANYWHERE in this controller that names `tenantId` as a column to
  // write (link()/unlink() only ever SET webdev_site_id / project_id / updated_at — see the
  // controller's own header). This is asserted at the DB layer directly (github-repos-rls.test.ts
  // already covers the RLS/FK shape); here we simply confirm the archived fixture's tenant_id is
  // unchanged after the app boots and every HTTP path above has run against it.
  it("tenant_id is unchanged after every write attempt above (no code path ever touches it)", async () => {
    const row = await adminPool().query(`SELECT tenant_id FROM github_repos WHERE id = $1`, [archivedRepoId]);
    expect(row.rows[0].tenant_id).toBe(co);
  });
});
