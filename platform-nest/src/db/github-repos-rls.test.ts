// GH-05 — github_repos registry (blueprint §5, migration 202608310735): RLS + schema shape.
//
// CORE table (no module wall — see the migration header, integration_connections precedent), so
// unlike module-search-rls.test.ts there is no app.scopes dimension to prove. The property that
// matters here is the "third wall" the ticket calls out explicitly: an unset tenant GUC must
// return ZERO ROWS with NO ERROR (the estate's documented RLS trap — an unset GUC reads as "the
// query had nothing to do", not as a failure), and a wrong-tenant session must see nothing either.
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS is actually exercised
// — a superuser migration role would pass every one of these for the wrong reason.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";
import { config } from "../config";
import type { PoolClient } from "pg";

const site = () => config.originSite;

async function insertRepo(
  tenantId: string,
  overrides: Partial<{
    id: string;
    org: string;
    name: string;
    fullName: string;
    archived: boolean;
    projectId: string | null;
    webdevSiteId: string | null;
    deletedAt: string | null;
  }> = {},
) {
  const id = overrides.id ?? newId();
  const org = overrides.org ?? "gaiadabali";
  // newId() is uuidv7 — TIME-ORDERED, so its leading hex chars are a millisecond timestamp, not
  // randomness. Slicing from the FRONT collided constantly across calls made microseconds apart in
  // this same test file; the random bits live at the END of a v7 UUID.
  const name = overrides.name ?? `repo-${id.slice(-8)}`;
  const fullName = overrides.fullName ?? `${org}/${name}`;
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO github_repos
         (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at,
          archived, project_id, webdev_site_id, deleted_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'main', now(), $7, $8, $9, $10, $11)`,
      [
        id,
        tenantId,
        org,
        name,
        fullName,
        `https://github.com/${org}/${name}`,
        overrides.archived ?? false,
        overrides.projectId ?? null,
        overrides.webdevSiteId ?? null,
        overrides.deletedAt ?? null,
        site(),
      ],
    ),
  );
  return id;
}

async function insertWebdevSite(tenantId: string, domain: string) {
  const id = newId();
  // webdev_sites is MODULE-owned (app_module_allowed('webdev')) — the third wall applies to it even
  // though it does not apply to github_repos itself (see the migration header: github_repos is CORE).
  await withTenants(
    [tenantId],
    (c) => c.query(`INSERT INTO webdev_sites (id, tenant_id, domain, origin_site) VALUES ($1,$2,$3,$4)`, [
      id,
      tenantId,
      domain,
      site(),
    ]),
    { modules: ["webdev"] },
  );
  return id;
}

describe.skipIf(!TEST_URL)("github_repos RLS + shape (GH-05, migration 202608310735)", () => {
  let A: string; // tenant with data
  let C: string; // unrelated tenant, must see nothing of A's

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Repo Tenant A");
    C = await createCompany("Repo Tenant C");
  });
  afterAll(teardownTestDb);

  // ── FORCE RLS + exactly one FOR-ALL policy ─────────────────────────────────────────────────────
  it("github_repos FORCE RLS with exactly one FOR-ALL tenant_isolation policy", async () => {
    const rls = await withGlobal((c) =>
      c.query<{ relforcerowsecurity: boolean }>(
        `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'github_repos'`,
      ),
    );
    expect(rls.rows.length).toBe(1);
    expect(rls.rows[0].relforcerowsecurity).toBe(true);

    const policies = await withGlobal((c) =>
      c.query<{ policyname: string; cmd: string }>(
        `SELECT policyname, cmd FROM pg_policies WHERE tablename = 'github_repos'`,
      ),
    );
    expect(policies.rows.length).toBe(1);
    expect(policies.rows[0].policyname).toBe("tenant_isolation");
    expect(policies.rows[0].cmd).toBe("ALL");
  });

  // ── THE THIRD WALL: unset GUC → zero rows, no error ────────────────────────────────────────────
  it("with NO tenant GUC set at all, github_repos reads ZERO ROWS and does not error", async () => {
    const id = await insertRepo(A);
    const { getPool } = await import("./index");
    // Raw pool query: no withTenants, no withGlobal-with-transaction — exactly the "mis-scoped
    // handler" / migration-time shape the estate's RLS trap note describes. Must not throw.
    const res = await getPool().query(`SELECT id FROM github_repos WHERE id = $1`, [id]);
    expect(res.rows.length).toBe(0);
  });

  it("empty tenant set → zero rows on github_repos, never an error (0025 fail-closed)", async () => {
    const res = await withTenants([], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM github_repos`));
    expect(res.rows[0].n).toBe(0);
  });

  // ── cross-tenant isolation ──────────────────────────────────────────────────────────────────────
  it("a repo registered for tenant A is invisible to unrelated tenant C", async () => {
    const id = await insertRepo(A);
    const fromA = await withTenants([A], (c) => c.query(`SELECT id FROM github_repos WHERE id=$1`, [id]));
    const fromC = await withTenants([C], (c) => c.query(`SELECT id FROM github_repos WHERE id=$1`, [id]));
    expect(fromA.rows.length).toBe(1);
    expect(fromC.rows.length).toBe(0);
  });

  it("WITH CHECK blocks INSERT into a tenant outside the authorized set", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO github_repos
             (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, origin_site)
           VALUES (gen_random_uuid(), $1, 'gaiadabali', 'smuggled', 'gaiadabali/smuggled',
                   'https://github.com/gaiadabali/smuggled', 'main', now(), $2)`,
          [C, site()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── archived as a first-class, queryable state (not a footnote) ────────────────────────────────
  it("archived is independently queryable — both states coexist and filter correctly", async () => {
    const live = await insertRepo(A, { archived: false });
    const dead = await insertRepo(A, { archived: true });
    const archivedRows = await withTenants([A], (c) =>
      c.query<{ id: string }>(`SELECT id FROM github_repos WHERE archived = true AND id = ANY($1)`, [[live, dead]]),
    );
    expect(archivedRows.rows.map((r) => r.id)).toEqual([dead]);
    const activeRows = await withTenants([A], (c) =>
      c.query<{ id: string }>(`SELECT id FROM github_repos WHERE archived = false AND id = ANY($1)`, [[live, dead]]),
    );
    expect(activeRows.rows.map((r) => r.id)).toEqual([live]);
  });

  // ── unlinked repo is a legitimate row, not a rejected one ───────────────────────────────────────
  it("a repo with NO project_id and NO webdev_site_id inserts cleanly (unlinked is a finding, not an error)", async () => {
    const id = await insertRepo(A, { projectId: null, webdevSiteId: null });
    const res = await withTenants([A], (c) =>
      c.query<{ project_id: string | null; webdev_site_id: string | null }>(
        `SELECT project_id, webdev_site_id FROM github_repos WHERE id=$1`,
        [id],
      ),
    );
    expect(res.rows[0].project_id).toBeNull();
    expect(res.rows[0].webdev_site_id).toBeNull();

    const unlinked = await withTenants([A], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM github_repos WHERE tenant_id = $1 AND project_id IS NULL AND webdev_site_id IS NULL AND id = $2`,
        [A, id],
      ),
    );
    expect(unlinked.rows.length).toBe(1);
  });

  // ── the partial-unique-index trap, proven both directions ──────────────────────────────────────
  it("rejects a second LIVE row with the same (org, full_name)", async () => {
    const org = "gaiadabali";
    const name = `dup-${newId().slice(-8)}`;
    await insertRepo(A, { org, name, fullName: `${org}/${name}` });
    await expect(insertRepo(A, { org, name, fullName: `${org}/${name}` })).rejects.toThrow(
      /duplicate key value violates unique constraint|ux_github_repos_org_full_name/,
    );
  });

  it("a SOFT-DELETED row does not block re-registering the same (org, full_name) — the partial index works", async () => {
    const org = "gaiadabali";
    const name = `renew-${newId().slice(-8)}`;
    const fullName = `${org}/${name}`;
    const firstId = await insertRepo(A, { org, name, fullName });
    await withTenants([A], (c) => c.query(`UPDATE github_repos SET deleted_at = now() WHERE id = $1`, [firstId]));
    // Must NOT throw: the partial index only covers deleted_at IS NULL rows.
    const secondId = await insertRepo(A, { org, name, fullName });
    expect(secondId).not.toBe(firstId);
  });

  // ── composite FKs make cross-tenant linkage structurally impossible ────────────────────────────
  it("project_id composite FK refuses a project belonging to a DIFFERENT tenant", async () => {
    const otherTenantProject = await createProject(C, "C's project");
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO github_repos
             (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, project_id, origin_site)
           VALUES (gen_random_uuid(), $1, 'gaiadabali', 'cross-fk', 'gaiadabali/cross-fk',
                   'https://github.com/gaiadabali/cross-fk', 'main', now(), $2, $3)`,
          [A, otherTenantProject, site()],
        ),
      ),
    ).rejects.toThrow(/fk_github_repos_project|foreign key/);
  });

  it("project_id composite FK accepts a project belonging to the SAME tenant", async () => {
    const ownProject = await createProject(A, "A's project");
    const id = await insertRepo(A, { projectId: ownProject });
    const res = await withTenants([A], (c) => c.query(`SELECT project_id FROM github_repos WHERE id=$1`, [id]));
    expect(res.rows[0].project_id).toBe(ownProject);
  });

  it("webdev_site_id composite FK refuses a site belonging to a DIFFERENT tenant", async () => {
    const otherTenantSite = await insertWebdevSite(C, "other-tenant-example.com");
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO github_repos
             (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, webdev_site_id, origin_site)
           VALUES (gen_random_uuid(), $1, 'gaiadabali', 'cross-fk-site', 'gaiadabali/cross-fk-site',
                   'https://github.com/gaiadabali/cross-fk-site', 'main', now(), $2, $3)`,
          [A, otherTenantSite, site()],
        ),
      ),
    ).rejects.toThrow(/fk_github_repos_webdev_site|foreign key/);
  });

  it("webdev_site_id composite FK accepts a site belonging to the SAME tenant", async () => {
    const ownSite = await insertWebdevSite(A, "own-example.com");
    const id = await insertRepo(A, { webdevSiteId: ownSite });
    const res = await withTenants([A], (c) => c.query(`SELECT webdev_site_id FROM github_repos WHERE id=$1`, [id]));
    expect(res.rows[0].webdev_site_id).toBe(ownSite);
  });

  // ── freshness columns behave as designed ────────────────────────────────────────────────────────
  it("last_synced_at defaults to now() and is independently updatable per row (staleness is visible)", async () => {
    const id = await insertRepo(A);
    const before = await withTenants([A], (c) =>
      c.query<{ last_synced_at: Date }>(`SELECT last_synced_at FROM github_repos WHERE id=$1`, [id]),
    );
    expect(before.rows[0].last_synced_at).toBeInstanceOf(Date);

    await withTenants([A], (c) =>
      c.query(`UPDATE github_repos SET last_synced_at = now() - interval '30 days' WHERE id=$1`, [id]),
    );
    const stale = await withTenants([A], (c) =>
      c.query<{ id: string }>(
        `SELECT id FROM github_repos WHERE id=$1 AND last_synced_at < now() - interval '1 day'`,
        [id],
      ),
    );
    expect(stale.rows.length).toBe(1);
  });

  it("head_sha/head_committed_at/head_author accept NULL — a genuinely empty repo is a true fact, not an error", async () => {
    const id = newId();
    await withTenants([A], (c: PoolClient) =>
      c.query(
        `INSERT INTO github_repos
           (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, origin_site)
         VALUES ($1,$2,'gaiadabali','empty-repo','gaiadabali/empty-repo',
                 'https://github.com/gaiadabali/empty-repo','main', now(), $3)`,
        [id, A, site()],
      ),
    );
    const res = await withTenants([A], (c) =>
      c.query<{ head_sha: string | null; pushed_at: Date | null }>(
        `SELECT head_sha, pushed_at FROM github_repos WHERE id=$1`,
        [id],
      ),
    );
    expect(res.rows[0].head_sha).toBeNull();
    expect(res.rows[0].pushed_at).toBeNull();
  });

  it("visibility rejects a value outside GitHub's known vocabulary", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO github_repos
             (id, tenant_id, org, name, full_name, html_url, default_branch, repo_created_at, visibility, origin_site)
           VALUES (gen_random_uuid(), $1, 'gaiadabali', 'bad-vis', 'gaiadabali/bad-vis',
                   'https://github.com/gaiadabali/bad-vis', 'main', now(), 'secret', $2)`,
          [A, site()],
        ),
      ),
    ).rejects.toThrow(/violates check constraint|github_repos_visibility_check/);
  });

  it("latest_run_status/conclusion accept an arbitrary GitHub value with no CHECK rejection", async () => {
    const id = await insertRepo(A);
    await withTenants([A], (c) =>
      c.query(
        `UPDATE github_repos SET latest_run_status = 'waiting', latest_run_conclusion = 'action_required' WHERE id=$1`,
        [id],
      ),
    );
    const res = await withTenants([A], (c) =>
      c.query<{ latest_run_status: string; latest_run_conclusion: string }>(
        `SELECT latest_run_status, latest_run_conclusion FROM github_repos WHERE id=$1`,
        [id],
      ),
    );
    expect(res.rows[0].latest_run_status).toBe("waiting");
    expect(res.rows[0].latest_run_conclusion).toBe("action_required");
  });
});
