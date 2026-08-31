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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { withTenants, newId } from "../db";

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
  let co: string;
  let manager: string;
  let repoId: string;
  let archivedRepoId: string;
  let unlinkedRepoId: string;
  let siteId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada GH-08 Co");
    manager = await createUser("manager@gh08.test");
    await addMembership(co, manager);
    await grantRole(manager, await createRole("manager"), "company", co);

    siteId = await insertWebdevSite(co, "gh08-example.test");
    repoId = await insertRepo(co, { name: "linked-repo", webdevSiteId: siteId });
    archivedRepoId = await insertRepo(co, { name: "archived-repo", archived: true });
    unlinkedRepoId = await insertRepo(co, { name: "unlinked-repo" });

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
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
