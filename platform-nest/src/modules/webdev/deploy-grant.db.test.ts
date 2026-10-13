// M6-P4g — the deploy grant against REAL Postgres (RLS, FORCE, the third wall on webdev_provisioned_sites, webdev_sites and
// webdev_contract_snapshots, the migration's CHECKs, the provisioning advisory lock, the GH-04 ledger in `activities`, the
// outbox), with GitHub faked at the chokepoint: `githubRequest` is mocked to the in-memory fake
// (core/github/git-data.testkit.ts). Authorization is covered by deploy-grant-http.test.ts; this suite drives the ports
// below it (scaffold-commit.db.test.ts's posture), plus the HOOK into P4b2's commit with Cerbos stubbed out.
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. a grant records `granted` with its facts, ledgers each secret write (`github.secret_write`, the secret's NAME, the
//      GH-12 approval, the basis) and emits webdev.site.deploy_granted;
//   2. the scaffold commit is followed by the grant in the same call, the commit is never turned into an error by it, and
//      an identical re-submit resumes a grant that could not finish;
//   3. a partial grant is recorded and resumed; a secret not created yet is pending (not an error) and completes later;
//      a revoke is recorded with its reason and actor; the per-site secret is granted to this site's repo only;
//   4. without `organization_secrets` the row says so, specifically;
//   5. the schema refuses a grant state without its links, on an uncommitted scaffold, or a revoke without a reason;
//   6. (M6-P6h2) the grant covers the production per-site secret once the site has a live production row (the row
//      `promoted_from_site_id` names), a `granted` site may list that name as pending (migration 202610132340 lifted the old
//      "granted holds no pending name" rule), the console read lists each environment's secret, a revoke removes both, and the
//      trigger after `POST sites/:id/production` extends the grant but never re-grants a revoked site.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { newId } from "../../db";
import { config } from "../../config";
import * as githubAppService from "../../core/github/github-app.service";
import { GithubApiError } from "../../core/github/errors";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import type { Principal } from "../../rbac/principal";
import { DeployGrantRefusal, grantDeploySecrets, revokeDeploySecrets, siteDeploySecretName } from "./deploy-grant";
import { deployGrantPorts, followProductionRow, readDeployGrant } from "./deploy-grant.service";
import { commitScaffoldForSite } from "./scaffold-commit.service";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});
// Cerbos is the HTTP suite's subject; here only the hook's wiring and the database are. `writeActivity` (the ledger) stays real.
vi.mock("../../core/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/http")>();
  return { ...actual, authorize: vi.fn(async () => undefined) };
});

const live = Boolean(TEST_URL);
const ORG = "acme-org";
const GRANT = "WEBDESK_DEPLOY_GRANT";
const KEY = "WEBDESK_DEPLOY_KEY";
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const file = (path: string, content: string) => {
  const b = Buffer.from(content, "utf8");
  return { path, base64: b.toString("base64"), sha256: sha256(b), bytes: b.byteLength };
};

describe.skipIf(!live)("M6-P4g — deploy grant (real Postgres, faked GitHub)", () => {
  let T: string;
  let userId: string;
  let gh: FakeGithub;
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId, names: config.webdeskDeploySecretNames };

  interface Site { id: string; runId: string; slug: string; approvalId: string; webdevSiteId: string; snapshot: { id: string; contentHash: string } }

  /** A provisioned row whose §08 completion is `complete`, with its GH-12 approval, run, registry row and pin. */
  async function completeSite(): Promise<Site> {
    const slug = `p4g-${newId().slice(-12)}`; // uuidv7: the first 8 hex are a timestamp prefix (shared for ~65 s), the tail is random
    const runId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, T]);
    const filed = await fileAutomationApproval({
      tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: userId,
    });
    await db.query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
    const webdevSiteId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main')`,
      [webdevSiteId, T, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`],
    );
    const snapshot = { id: newId(), contentHash: `sha256:${sha256(Buffer.from(slug))}` };
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, '{}'::jsonb, 'main')`,
      [snapshot.id, T, slug, snapshot.contentHash],
    );
    const id = newId();
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, $3, 'erp_repo', $4, $5, 'astro', 'live', $6, $7, 'main', 'complete', $8, $5, $9, now())`,
      [id, T, runId, filed.id, slug, `https://github.com/${ORG}/${slug}`, userId, webdevSiteId, snapshot.id],
    );
    return { id, runId, slug, approvalId: filed.id, webdevSiteId, snapshot };
  }

  /** The site's own per-site deploy secret (provisioned registry rows are `staging`). */
  // M6-P6f: named from the repo's name and GitHub id; `gh` (the fake repo) is made by fakeRepoFor before any caller asks.
  const siteSecret = (s: Site) => siteDeploySecretName({ slug: s.slug, environment: "staging", repositoryId: gh.repoId });

  /** M6-P6h2: the same site's PRODUCTION per-site secret. */
  const prodSecret = (s: Site) => siteDeploySecretName({ slug: s.slug, environment: "production", repositoryId: gh.repoId });

  /** The production row `POST sites/:id/production` makes from the staging row (M6-P6g): environment production, `promoted_from_site_id`. */
  async function addProductionRow(s: Site): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, promoted_from_site_id, origin_site)
       VALUES ($1, $2, $3, 'production', 'static', $4, 'mandated', 'provisioned', $5, 'main')`,
      [id, T, `www.${s.slug}.example`, `https://github.com/${ORG}/${s.slug}`, s.webdevSiteId],
    );
    return id;
  }

  const lockFor = (s: Site) =>
    JSON.stringify({ blockLibraryVersion: "0.1.0", contentHash: s.snapshot.contentHash, contractVersion: "1.0.0", snapshotId: s.snapshot.id, vocabularyVersion: "1.1.0" }, null, 2) + "\n";
  const treeFor = (s: Site) => [file("CONTRACT.lock", lockFor(s)), file("src/pages/index.astro", "<h1>Home</h1>\n")];

  /** Point the mocked chokepoint at a fake repo named after the site (the template, not yet scaffolded). */
  function fakeRepoFor(s: Site, secrets: string[] = [GRANT], withSiteSecret = true): FakeGithub {
    gh = new FakeGithub(ORG, s.slug);
    gh.seedTemplate({ "README.md": "# template\n" });
    for (const n of secrets) gh.addOrgSecret(n);
    if (withSiteSecret) gh.addOrgSecret(siteSecret(s));
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation(((_t: string, role: string, _a: string, req: never) => {
      if (role !== "erp") throw new Error(`the deploy grant must use the erp App, not ${role}`);
      return call(req);
    }) as never);
    return gh;
  }

  /** A site whose scaffold is committed: the lock on the default branch and the row's scaffold columns as P4b2 leaves them. */
  async function committedSite(secrets: string[] = [GRANT]): Promise<Site> {
    const s = await completeSite();
    fakeRepoFor(s, secrets);
    const base = gh.headOf() as string;
    const commit = gh.pushHumanCommit({ "CONTRACT.lock": lockFor(s), "src/pages/index.astro": "<h1>Home</h1>\n" });
    await adminPool().query(
      `UPDATE webdev_provisioned_sites
          SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
              scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
        WHERE id = $1`,
      [s.id, "c".repeat(64), s.snapshot.id, base, commit],
    );
    return s;
  }

  const ports = (s: Site, names: string[] = [GRANT]) =>
    deployGrantPorts({ tenantId: T, siteId: s.id, orgTenantId: T, actorId: userId, secretNames: names, approvalId: s.approvalId });

  async function stored(id: string) {
    const r = await adminPool().query(
      `SELECT deploy_grant_state, deploy_grant_secret_names, deploy_grant_snapshot_id, deploy_grant_repository_id, deploy_grant_head_sha,
              deploy_grant_error, deploy_grant_requested_by, deploy_grant_granted_at, deploy_grant_revoked_at, deploy_grant_revoked_by,
              deploy_grant_revoke_reason, deploy_grant_site_secret_name, deploy_grant_pending_names
         FROM webdev_provisioned_sites WHERE id = $1`,
      [id],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function refusal(p: Promise<unknown>): Promise<DeployGrantRefusal> {
    try {
      await p;
    } catch (err) {
      if (err instanceof DeployGrantRefusal) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P4g Deploy Grant Co", ["webdev"]);
    userId = await createUser("p4g-operator@ex.test", "P4g Operator");
    await addMembership(T, userId);
    config.githubOrg = ORG;
    config.githubOrgTenantId = T;
    config.webdeskDeploySecretNames = "";
  });

  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    config.webdeskDeploySecretNames = saved.names;
    await teardownTestDb();
  });

  // A block body on purpose: a function RETURNED from beforeEach is a cleanup hook, and mockReset() returns the mock.
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
    config.webdeskDeploySecretNames = "";
  });

  it("HAPPY PATH: granted, recorded, ledgered (secret_write, the secret's name, the GH-12 approval, the basis) and announced", async () => {
    const s = await committedSite();
    const r = await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    expect(r).toMatchObject({ outcome: "granted", state: "granted", repo: `${ORG}/${s.slug}`, repositoryId: gh.repoId, snapshotId: s.snapshot.id });
    expect(gh.orgSecrets.get(GRANT)!.repos.has(gh.repoId)).toBe(true);

    const row = await stored(s.id);
    expect(row).toMatchObject({
      deploy_grant_state: "granted", deploy_grant_secret_names: [GRANT, siteSecret(s)], deploy_grant_snapshot_id: s.snapshot.id,
      deploy_grant_head_sha: gh.headOf(), deploy_grant_error: null, deploy_grant_requested_by: userId,
      deploy_grant_site_secret_name: siteSecret(s), deploy_grant_pending_names: [],
    });
    expect([...gh.orgSecrets.get(siteSecret(s))!.repos]).toEqual([gh.repoId]);
    expect(Number(row.deploy_grant_repository_id)).toBe(gh.repoId);
    expect(row.deploy_grant_granted_at).toBeTruthy();

    const acts = await adminPool().query(
      `SELECT metadata->>'outcome' AS outcome, metadata->>'secretName' AS secret, metadata->>'approvalId' AS approval,
              metadata->>'basis' AS basis, metadata->>'ruling' AS ruling, actor_id
         FROM activities WHERE tenant_id = $1 AND verb = 'github.secret_write' AND metadata->>'repo' = $2 ORDER BY occurred_at, id`,
      [T, `${ORG}/${s.slug}`],
    );
    expect(acts.rows.map((a) => a.outcome).sort()).toEqual(["attempted", "attempted", "succeeded", "succeeded"]);
    expect(acts.rows.every((a) => [GRANT, siteSecret(s)].includes(a.secret) && a.approval === s.approvalId && a.basis === "deploy-gate-grant" && a.ruling === "WSK-D29" && a.actor_id === userId)).toBe(true);

    const ev = await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.deploy_granted'`, [s.id]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toMatchObject({ secretNames: [GRANT, siteSecret(s)], snapshotId: s.snapshot.id });
    expect(await readDeployGrant(T, s.id)).toMatchObject({
      state: "granted", secretNames: [GRANT, siteSecret(s)], siteSecretName: siteSecret(s), pendingNames: [], repositoryId: gh.repoId, error: null,
    });
  });

  it("THE HOOK: the scaffold commit is followed by the grant in the same call; a 403 never turns the commit into an error; a re-submit resumes it", async () => {
    const s = await completeSite();
    fakeRepoFor(s);
    gh.orgSecretsPermission = false; // O-3 not yet in effect
    const principal = { userId, assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;

    const first = await commitScaffoldForSite(principal, T, s.id, { runId: s.runId, files: treeFor(s) });
    expect(first.outcome).toBe("committed");
    expect(gh.headOf()).toBe(first.commitSha);
    expect(first.deployGrant).toMatchObject({ outcome: "refused", state: null, error: "github_permission_missing: organization_secrets" });
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: null, deploy_grant_error: "github_permission_missing: organization_secrets" });

    gh.orgSecretsPermission = true; // the owner grants it
    const again = await commitScaffoldForSite(principal, T, s.id, { runId: s.runId, files: treeFor(s) });
    expect(again).toMatchObject({ outcome: "already_committed", commitSha: first.commitSha });
    expect(again.deployGrant).toMatchObject({ outcome: "granted", state: "granted", error: null });
    expect(gh.orgSecrets.get(GRANT)!.repos.has(gh.repoId)).toBe(true);
    expect((await stored(s.id)).deploy_grant_head_sha).toBe(first.commitSha);

    const quiet = await commitScaffoldForSite(principal, T, s.id, { runId: s.runId, files: treeFor(s) });
    expect(quiet.deployGrant).toMatchObject({ outcome: "already_granted" });
  });

  it("PARTIAL: the second secret's PUT fails; the first is recorded on the row; the re-run completes", async () => {
    const s = await committedSite([GRANT, KEY]);
    let dropped = false;
    gh.beforeRequest = (method, path) => {
      if (method === "PUT" && path.includes(KEY) && !dropped) {
        dropped = true;
        throw new GithubApiError(`PUT ${path}`, 502, "Bad Gateway");
      }
    };
    expect((await refusal(grantDeploySecrets(ports(s, [GRANT, KEY]), { siteId: s.id, trigger: "operator" }))).code).toBe("github_request_failed");
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: "pending", deploy_grant_secret_names: [GRANT], deploy_grant_error: "github_request_failed" });
    const r = await grantDeploySecrets(ports(s, [GRANT, KEY]), { siteId: s.id, trigger: "scaffold" });
    expect(r.outcome).toBe("granted");
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: "granted", deploy_grant_secret_names: [GRANT, KEY, siteSecret(s)], deploy_grant_error: null });
  });

  it("A SECRET NOT CREATED YET is not an error: pending for that name on the row; the next run completes it", async () => {
    const s = await completeSite();
    fakeRepoFor(s, [GRANT], false); // the owner has not created the per-site secret yet (before P6)
    const base = gh.headOf() as string;
    const commit = gh.pushHumanCommit({ "CONTRACT.lock": lockFor(s) });
    await adminPool().query(
      `UPDATE webdev_provisioned_sites
          SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
              scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
        WHERE id = $1`,
      [s.id, "c".repeat(64), s.snapshot.id, base, commit],
    );
    const r = await grantDeploySecrets(ports(s, [GRANT, KEY]), { siteId: s.id, trigger: "operator" });
    expect(r).toMatchObject({ outcome: "pending", state: "pending", pending: [KEY, siteSecret(s)], error: null, siteSecretName: siteSecret(s) });
    expect(await stored(s.id)).toMatchObject({
      deploy_grant_state: "pending", deploy_grant_secret_names: [GRANT], deploy_grant_pending_names: [KEY, siteSecret(s)],
      deploy_grant_error: null, deploy_grant_site_secret_name: siteSecret(s),
    });
    gh.addOrgSecret(KEY);
    gh.addOrgSecret(siteSecret(s));
    expect(await grantDeploySecrets(ports(s, [GRANT, KEY]), { siteId: s.id, trigger: "scaffold" })).toMatchObject({ outcome: "granted", pending: [] });
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: "granted", deploy_grant_pending_names: [] });
  });

  it("REVOKE: removed at GitHub, recorded with its reason and actor, announced; the automatic path then leaves it", async () => {
    const s = await committedSite();
    await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    const r = await revokeDeploySecrets(ports(s), { siteId: s.id, reason: "the client's contract ended" });
    expect(r).toMatchObject({ outcome: "revoked", state: "revoked" });
    expect(gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
    const row = await stored(s.id);
    expect(row).toMatchObject({
      deploy_grant_state: "revoked", deploy_grant_secret_names: [], deploy_grant_revoked_by: userId,
      deploy_grant_revoke_reason: "the client's contract ended", deploy_grant_error: null,
    });
    expect(row.deploy_grant_revoked_at).toBeTruthy();
    const ev = await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.deploy_revoked'`, [s.id]);
    // M6-P6h2: a revoke covers every derivable per-site name, the production one too (this site has no production row).
    expect(ev.rows[0].payload).toMatchObject({ reason: "the client's contract ended", secretNames: [GRANT, siteSecret(s), prodSecret(s)] });
    expect(gh.orgSecrets.get(siteSecret(s))!.repos.size).toBe(0);
    const revokeRows = await adminPool().query(
      `SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND verb = 'github.secret_write' AND metadata->>'basis' = 'deploy-gate-revoke' AND metadata->>'repo' = $2`,
      [T, `${ORG}/${s.slug}`],
    );
    expect(revokeRows.rows[0].n).toBe(6); // three names (the marker, staging, production), attempted + succeeded each
    expect(await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "scaffold" })).toMatchObject({ outcome: "skipped_revoked" });
    expect(gh.orgSecrets.get(GRANT)!.repos.size).toBe(0);
  });

  it("CONDITIONS on the real tables: a soft-deleted registry row and another tenant's site are refused, nothing written", async () => {
    const s = await committedSite();
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [s.webdevSiteId]);
    expect((await refusal(grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" }))).code).toBe("deploy_grant_no_registry_row");
    expect(gh.count("PUT", "/actions/secrets/")).toBe(0);
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: null, deploy_grant_error: "deploy_grant_no_registry_row" });

    const OTHER = await createCompany("P4g Other Co", ["webdev"]);
    const foreign = deployGrantPorts({ tenantId: OTHER, siteId: s.id, orgTenantId: OTHER, actorId: userId, secretNames: [GRANT] });
    expect((await refusal(grantDeploySecrets(foreign, { siteId: s.id, trigger: "operator" }))).code).toBe("not_found");
  });

  it("SCHEMA: a grant state needs a committed scaffold and its facts; granted needs names; revoked needs a reason; names are shape-checked", async () => {
    const plain = await completeSite();
    const facts = `deploy_grant_secret_names = '{WEBDESK_DEPLOY_GRANT}', deploy_grant_snapshot_id = '${plain.snapshot.id}',
                   deploy_grant_repository_id = 7, deploy_grant_head_sha = '${"a".repeat(40)}', deploy_grant_requested_by = '${userId}',
                   deploy_grant_site_secret_name = 'WEBDESK_DEPLOY_X_STAGING_424242', deploy_grant_pending_names = '{}'`;
    // not committed
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_state = 'pending', ${facts} WHERE id = $1`, [plain.id]))
      .rejects.toMatchObject({ code: "23514" });
    const s = await committedSite();
    // without its facts
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_state = 'pending' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // granted without a time
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_state = 'granted', ${facts} WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // revoked without a reason
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_state = 'revoked', deploy_grant_revoked_at = now(), ${facts} WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // a reason too short; a name that is not a secret name; a sha that is not one
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_revoke_reason = 'no' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_secret_names = '{"bad-name"}' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_head_sha = 'nope' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // a per-site name that is not one derived by siteDeploySecretName
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_site_secret_name = 'OTHER_SECRET' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // M6-P6f: the name ends in the repository id, so the old `<H8>` form (8 hex with a letter) is no longer one
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_site_secret_name = 'WEBDESK_DEPLOY_X_STAGING_0A1B2C3D' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    // granted with no name at all (granted still needs at least one)
    await expect(adminPool().query(
      `UPDATE webdev_provisioned_sites SET deploy_grant_state = 'granted', deploy_grant_granted_at = now(),
         ${facts.replace("deploy_grant_secret_names = '{WEBDESK_DEPLOY_GRANT}'", "deploy_grant_secret_names = '{}'")} WHERE id = $1`,
      [s.id],
    )).rejects.toMatchObject({ code: "23514" });
    // the complete claim is accepted
    await adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_state = 'pending', ${facts} WHERE id = $1`, [s.id]);
    // M6-P6h2 (migration 202610132340): granted MAY list a pending name (a production secret not created yet); its other rules held
    await adminPool().query(
      `UPDATE webdev_provisioned_sites SET deploy_grant_state = 'granted', deploy_grant_granted_at = now(),
         ${facts.replace("deploy_grant_pending_names = '{}'", "deploy_grant_pending_names = '{WEBDESK_DEPLOY_X_PRODUCTION_424242}'")} WHERE id = $1`,
      [s.id],
    );
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: "granted", deploy_grant_pending_names: ["WEBDESK_DEPLOY_X_PRODUCTION_424242"] });
    // a pending name must still be a secret name (the column's own CHECK is a different constraint)
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET deploy_grant_pending_names = '{"bad-name"}' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("PRODUCTION ROW (M6-P6h2): the grant covers both per-site secrets; the row records the staging name and lists both; the read says where each stands", async () => {
    const s = await committedSite();
    const prodRowId = await addProductionRow(s);
    gh.addOrgSecret(prodSecret(s));
    const r = await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    expect(r).toMatchObject({
      outcome: "granted", state: "granted", siteSecretName: siteSecret(s), pending: [],
      siteSecrets: [{ environment: "staging", name: siteSecret(s), status: "granted" }, { environment: "production", name: prodSecret(s), status: "granted" }],
    });
    expect(r.secrets.map((x) => x.name)).toEqual([GRANT, siteSecret(s), prodSecret(s)]);
    expect([...gh.orgSecrets.get(prodSecret(s))!.repos]).toEqual([gh.repoId]);
    expect(await stored(s.id)).toMatchObject({
      deploy_grant_state: "granted", deploy_grant_secret_names: [GRANT, siteSecret(s), prodSecret(s)],
      deploy_grant_site_secret_name: siteSecret(s), deploy_grant_pending_names: [],
    });
    expect(await readDeployGrant(T, s.id)).toMatchObject({
      state: "granted", siteSecretName: siteSecret(s), pendingNames: [],
      siteSecrets: [{ environment: "staging", name: siteSecret(s), status: "granted" }, { environment: "production", name: prodSecret(s), status: "granted" }],
    });
    // a SOFT-DELETED production row is no live production row: the read and the next grant are staging only again
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [prodRowId]);
    expect((await readDeployGrant(T, s.id))!.siteSecrets.map((x) => x.environment)).toEqual(["staging"]);
    const staged = await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    expect(staged.secrets.map((x) => x.name)).toEqual([GRANT, siteSecret(s)]);
  });

  it("PRODUCTION SECRET NOT CREATED YET on a site already granted at staging: it stays granted, lists the name pending (the CHECK accepts it), then completes", async () => {
    const s = await committedSite();
    expect(await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" })).toMatchObject({ outcome: "granted" });
    await addProductionRow(s);
    const r = await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "production" });
    expect(r).toMatchObject({ outcome: "pending", state: "granted", pending: [prodSecret(s)], error: null });
    expect(await stored(s.id)).toMatchObject({
      deploy_grant_state: "granted", deploy_grant_secret_names: [GRANT, siteSecret(s)], deploy_grant_pending_names: [prodSecret(s)], deploy_grant_error: null,
    });
    expect(await readDeployGrant(T, s.id)).toMatchObject({
      state: "granted", pendingNames: [prodSecret(s)],
      siteSecrets: [{ environment: "staging", name: siteSecret(s), status: "granted" }, { environment: "production", name: prodSecret(s), status: "pending" }],
    });
    gh.addOrgSecret(prodSecret(s));
    expect(await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "production" })).toMatchObject({ outcome: "granted", state: "granted", pending: [] });
    expect(await stored(s.id)).toMatchObject({ deploy_grant_secret_names: [GRANT, siteSecret(s), prodSecret(s)], deploy_grant_pending_names: [] });
  });

  it("PRODUCTION SECRET visible to all repos: an error recorded, never written through", async () => {
    const s = await committedSite();
    await addProductionRow(s);
    gh.addOrgSecret(prodSecret(s), "all");
    const r = await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    expect(r).toMatchObject({ outcome: "partial", error: `deploy_grant_secret_not_selected: ${prodSecret(s)}` });
    expect(gh.count("PUT", prodSecret(s))).toBe(0);
    expect(await stored(s.id)).toMatchObject({ deploy_grant_secret_names: [GRANT, siteSecret(s)], deploy_grant_error: `deploy_grant_secret_not_selected: ${prodSecret(s)}` });
  });

  it("REVOKE with a production row removes BOTH per-site names at GitHub and ledgers each", async () => {
    const s = await committedSite();
    await addProductionRow(s);
    gh.addOrgSecret(prodSecret(s));
    await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" });
    const r = await revokeDeploySecrets(ports(s), { siteId: s.id, reason: "the client contract ended" });
    expect(r).toMatchObject({ outcome: "revoked", state: "revoked" });
    for (const n of [GRANT, siteSecret(s), prodSecret(s)]) expect(gh.orgSecrets.get(n)!.repos.size).toBe(0);
    expect(await stored(s.id)).toMatchObject({ deploy_grant_state: "revoked", deploy_grant_secret_names: [], deploy_grant_pending_names: [] });
    const ev = await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.deploy_revoked'`, [s.id]);
    expect(ev.rows[0].payload).toMatchObject({ secretNames: [GRANT, siteSecret(s), prodSecret(s)] });
    const revokeRows = await adminPool().query(
      `SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND verb = 'github.secret_write' AND metadata->>'basis' = 'deploy-gate-revoke' AND metadata->>'repo' = $2`,
      [T, `${ORG}/${s.slug}`],
    );
    expect(revokeRows.rows[0].n).toBe(6); // three secrets, attempted + succeeded each
  });

  it("THE TRIGGER after the production row: extends the grant best-effort; never re-grants a revoked site; null for a site no provisioned row owns", async () => {
    const principal = { userId, assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;
    const s = await committedSite();
    expect(await grantDeploySecrets(ports(s), { siteId: s.id, trigger: "operator" })).toMatchObject({ outcome: "granted" });
    await addProductionRow(s);
    gh.addOrgSecret(prodSecret(s));
    const summary = await followProductionRow(principal, T, s.webdevSiteId);
    expect(summary).toMatchObject({
      outcome: "granted", state: "granted", error: null,
      siteSecrets: [{ environment: "staging", name: siteSecret(s), status: "granted" }, { environment: "production", name: prodSecret(s), status: "granted" }],
    });
    expect(gh.orgSecrets.get(prodSecret(s))!.repos.has(gh.repoId)).toBe(true);

    // an operator revoke is never undone by it
    await revokeDeploySecrets(ports(s), { siteId: s.id, reason: "paused by the operator" });
    const before = gh.calls.length;
    expect(await followProductionRow(principal, T, s.webdevSiteId)).toMatchObject({ outcome: "skipped_revoked", state: "revoked" });
    expect(gh.calls.length).toBe(before);
    expect(gh.orgSecrets.get(prodSecret(s))!.repos.size).toBe(0);

    // a staging row that belongs to no provisioned site has no grant to extend; a refusal is data, not an exception
    expect(await followProductionRow(principal, T, newId())).toBeNull();
    const noPrincipal = { userId: null, assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;
    expect(await followProductionRow(noPrincipal, T, s.webdevSiteId)).toMatchObject({ outcome: "refused" });
  });
});
