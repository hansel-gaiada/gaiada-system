// M6-P6o2 — per-site vault records (owner_kind 'webdev_site', owner_id = the webdev_sites row; migration 202610271200), against
// REAL Postgres: the vault's CHECK, unique key and FORCE RLS, the ON CONFLICT upsert, the bind, and P6o's seal / filing / execution,
// with GitHub faked at the chokepoint and Cerbos stubbed (deploy-secret-http.test.ts drives the real policies, the reveal included).
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the migration: owner_kind admits exactly user, company, client, github_app and webdev_site; the unique key and FORCE RLS
//      are intact; and the file's own guards and self-check REFUSE a broken definition (each scratch case runs the real file in
//      a transaction that is rolled back);
//   2. two sites of ONE company, each with its own staging AND production ssh record, coexist (the collision P6o hit), and a
//      repeat create returns the same record (the upsert still targets (tenant, owner_kind, owner_id, provider));
//   3. existing company, client and github_app records are unchanged by any of it, and still upsert to themselves;
//   4. a per-site record is accepted for exactly its own row: the bind, the seal (environment), the filing and the execution
//      all refuse another site's record and the same site's other environment's record;
//   5. RLS: another tenant sees none of these records and cannot make one for a row it cannot see.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import * as githubAppService from "../../core/github/github-app.service";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { githubConnectionOwnerId } from "../../core/github/apps";
import { fileAutomationApproval } from "../../core/approval-filing";
import { createConnection, revokeConnection } from "../../core/integrations.service";
import type { Principal } from "../../rbac/principal";
import { siteDeploySecretName } from "./deploy-grant";
import { bindSiteDelivery } from "./site-registry.service";
import { DeliveryRefusal } from "./delivery-binding";
import { DeploySecretRefusal } from "./deploy-secret-write";
import {
  createSiteDeployRecord, executeApprovedDeploySecretWrite, fileDeploySecretWrite, listSiteDeployRecords,
  preflightDeploySecretWrite, sealDeployCredential,
} from "./deploy-secret.service";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});
vi.mock("../../core/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/http")>();
  return { ...actual, authorize: vi.fn(async () => undefined) };
});

const live = Boolean(TEST_URL);
const ORG = "acme-org";
const GRANT = "WEBDESK_DEPLOY_GRANT";
const MIGRATION = join(__dirname, "..", "..", "..", "migrations", "202610271200_integration_connections_webdev_site_owner_kind.sql");
const FIVE = ["client", "company", "github_app", "user", "webdev_site"];

describe.skipIf(!live)("M6-P6o2 — per-site vault records (real Postgres)", () => {
  let T: string;
  let U: string;
  let requester: string;
  let decider: string;
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId, names: config.webdeskDeploySecretNames, key: config.integrationTokenKey };
  const P = (userId: string, tenant = T): Principal => ({ userId, assurance: "high", companies: [tenant], roles: [], sessionVersion: 1 }) as unknown as Principal;

  function credential(environment: "staging" | "production", tag: string): Record<string, unknown> {
    return {
      version: 1, environment, transport: "sftp", host: "sftp.example.invalid", port: 65002, user: `u_${tag}_${environment}`,
      password: `canary-p6o2-${tag}-${randomBytes(10).toString("hex")}`,
      knownHosts: "[sftp.example.invalid]:65002 ssh-ed25519 AAAAplaceholder", remoteBase: `/home/u/domains/${environment}`, docroot: "public_html",
      siteUrl: `https://${environment}.example.invalid`,
    };
  }

  interface Site { provisionedId: string; slug: string; staging: string; production: string; gh: FakeGithub }

  /** A provisioned, completed, scaffolded COMPANY site (no client), its staging row, and the production row made from it. */
  async function companySite(tag: string): Promise<Site> {
    const slug = `p6o2-${tag}-${newId().slice(-10)}`;
    const db = adminPool();
    const runId = newId();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, T]);
    const filed = await fileAutomationApproval({
      tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: requester,
    });
    await db.query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
    const staging = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main')`,
      [staging, T, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`],
    );
    const production = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site, promoted_from_site_id)
       VALUES ($1, $2, $3, 'production', 'static', $4, 'mandated', 'provisioned', 'main', $5)`,
      [production, T, `${slug}.example.invalid`, `https://github.com/${ORG}/${slug}`, staging],
    );
    const snapshotId = newId();
    const contentHash = `sha256:${"a".repeat(64)}`;
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, '{}'::jsonb, 'main')`,
      [snapshotId, T, slug, contentHash],
    );
    const provisionedId = newId();
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, $3, 'erp_repo', $4, $5, 'astro', 'live', $6, $7, 'main', 'complete', $8, $5, $9, now())`,
      [provisionedId, T, runId, filed.id, slug, `https://github.com/${ORG}/${slug}`, requester, staging, snapshotId],
    );
    const gh = new FakeGithub(ORG, slug);
    await gh.useOrgKeyPair();
    const base = gh.seedTemplate({ "README.md": "# template\n" });
    const lock = JSON.stringify({ blockLibraryVersion: "", contentHash, contractVersion: "1.0.0", snapshotId, vocabularyVersion: "1.1.0" }, null, 2) + "\n";
    const commit = gh.pushHumanCommit({ "CONTRACT.lock": lock });
    gh.addOrgSecret(GRANT);
    await db.query(
      `UPDATE webdev_provisioned_sites
          SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
              scaffold_base_sha = $4, scaffold_tree_sha = $5, scaffold_commit_sha = $5, scaffold_committed_at = now()
        WHERE id = $1`,
      [provisionedId, "d".repeat(64), snapshotId, base, commit],
    );
    return { provisionedId, slug, staging, production, gh };
  }

  /** Point the GitHub chokepoint at this site's fake repo. */
  function useGithub(s: Site): void {
    const call = s.gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation((async (_t: string, role: string, _a: string, req: never) => {
      if (role !== "erp") throw new Error(`the deploy secret write must use the erp App, not ${role}`);
      return call(req);
    }) as never);
  }

  const record = (row: string, provider: "ssh" | "ftp" = "ssh") => createSiteDeployRecord(P(requester), T, row, { provider, externalAccount: `p6o2 ${provider}` });
  const bind = (row: string, vaultRef: string) =>
    bindSiteDelivery(T, row, { hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh", vaultRef }, requester);
  const vaultRow = async (id: string) =>
    (await adminPool().query(`SELECT id, owner_kind, owner_id, provider, status, access_token_enc, updated_at FROM integration_connections WHERE id = $1`, [id])).rows[0];

  async function caught<E>(p: Promise<unknown>, cls: new (...a: never[]) => E): Promise<E> {
    try {
      await p;
    } catch (err) {
      if (err instanceof cls) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  async function approveAndRun(approvalId: string) {
    const row = (await adminPool().query(`SELECT tool_args, requested_by FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0];
    await preflightDeploySecretWrite(T, approvalId, row.tool_args, row.requested_by, P(decider));
    await adminPool().query(
      `UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'pending' WHERE id = $1`,
      [approvalId, decider],
    );
    return executeApprovedDeploySecretWrite(T, approvalId, row.tool_args, P(decider));
  }

  /** Run the REAL migration file inside a transaction after `breakIt`, and roll back whatever happened. */
  async function runMigrationAfter(breakIt: string[]): Promise<{ ok: true; def: string } | { ok: false; message: string }> {
    const sql = readFileSync(MIGRATION, "utf8");
    const c = await adminPool().connect();
    try {
      await c.query("BEGIN");
      for (const stmt of breakIt) await c.query(stmt);
      try {
        await c.query(sql);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      const def = (await c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'integration_connections'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%owner_kind%'`,
      )).rows[0].def;
      return { ok: true, def };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  const ownerKindDef = async () =>
    (await adminPool().query<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'integration_connections'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%owner_kind%'`,
    )).rows;
  const literals = (def: string) => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P6o2 Per-Site Co", ["webdev"]);
    U = await createCompany("P6o2 Other Co", ["webdev"]);
    requester = await createUser("p6o2-requester@ex.test", "P6o2 Requester");
    decider = await createUser("p6o2-decider@ex.test", "P6o2 Decider");
    await addMembership(T, requester);
    await addMembership(T, decider);
    await addMembership(U, requester);
    config.githubOrg = ORG;
    config.githubOrgTenantId = T;
    config.webdeskDeploySecretNames = "";
    config.integrationTokenKey = randomBytes(32).toString("base64");
  }, 120_000);

  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    config.webdeskDeploySecretNames = saved.names;
    config.integrationTokenKey = saved.key;
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  // ── 1. the migration ─────────────────────────────────────────────────────────────────────────────

  it("the migration: ONE owner_kind CHECK admitting exactly the five kinds; the unique key, FORCE RLS and the tenant wall are intact", async () => {
    const checks = await ownerKindDef();
    expect(checks).toHaveLength(1);
    expect(literals(checks[0].def)).toEqual(FIVE);
    const uq = (await adminPool().query<{ cols: string[] }>(
      `SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
         FROM pg_constraint c WHERE c.conrelid = 'integration_connections'::regclass AND c.contype = 'u'`,
    )).rows.map((r) => r.cols);
    expect(uq).toEqual([["tenant_id", "owner_kind", "owner_id", "provider"]]);
    const rls = (await adminPool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'integration_connections'::regclass`)).rows[0];
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = (await adminPool().query(`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'integration_connections'`)).rows;
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ policyname: "tenant_isolation" });
    expect(pol[0].qual).toContain("app_current_tenants");
    expect(pol[0].with_check).toContain("app_current_tenants");
    // an unknown kind is still refused
    await expect(adminPool().query(
      `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, origin_site) VALUES ($1, $2, 'webdev_project', $2, 'ssh', 'test')`,
      [newId(), T],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("the file's widening path, from the PRE-migration four-value CHECK, adds exactly webdev_site (and a re-run on the migrated schema changes nothing)", async () => {
    const [{ name }] = await ownerKindDef();
    const fromFour = await runMigrationAfter([
      `ALTER TABLE integration_connections DROP CONSTRAINT ${name}`,
      `ALTER TABLE integration_connections ADD CONSTRAINT ${name} CHECK (owner_kind IN ('user', 'company', 'client', 'github_app')) NOT VALID`,
    ]);
    expect(fromFour.ok).toBe(true);
    expect(literals((fromFour as { def: string }).def)).toEqual(FIVE);
    const rerun = await runMigrationAfter([]);
    expect(rerun.ok).toBe(true);
    expect(literals((rerun as { def: string }).def)).toEqual(FIVE);
    // both rolled back: the live definition is untouched
    expect(literals((await ownerKindDef())[0].def)).toEqual(FIVE);
  });

  it.each([
    ["a live CHECK that lost 'client' (the 202608311000 incident)", (n: string) => [
      `ALTER TABLE integration_connections DROP CONSTRAINT ${n}`,
      `ALTER TABLE integration_connections ADD CONSTRAINT ${n} CHECK (owner_kind IN ('user', 'company', 'github_app')) NOT VALID`,
    ], /no longer admits \{client\}/],
    ["two owner_kind CHECKs", (_n: string) => [
      `ALTER TABLE integration_connections ADD CONSTRAINT p6o2_scratch_second CHECK (owner_kind <> 'nobody') NOT VALID`,
    ], /expected exactly 1 owner_kind CHECK/],
    ["a CHECK that admits an extra kind (step 1 skips it; the self-check does not)", (n: string) => [
      `ALTER TABLE integration_connections DROP CONSTRAINT ${n}`,
      `ALTER TABLE integration_connections ADD CONSTRAINT ${n} CHECK (owner_kind IN ('user', 'company', 'client', 'github_app', 'webdev_site', 'bogus')) NOT VALID`,
    ], /self-check: owner_kind CHECK admits/],
    ["FORCE RLS switched off", (_n: string) => [`ALTER TABLE integration_connections NO FORCE ROW LEVEL SECURITY`], /RLS enabled AND forced/],
    ["the tenant wall dropped", (_n: string) => [`DROP POLICY tenant_isolation ON integration_connections`], /tenant_isolation policy/],
  ])("the migration REFUSES %s, and the rollback leaves the live schema as it was", async (_l, breakIt, message) => {
    const [{ name }] = await ownerKindDef();
    const out = await runMigrationAfter(breakIt(name));
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toMatch(message);
    expect(literals((await ownerKindDef())[0].def)).toEqual(FIVE);
    expect((await adminPool().query(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'integration_connections'::regclass`)).rows[0].relforcerowsecurity).toBe(true);
  });

  it("the migration REFUSES when the unique key the upsert targets is gone", async () => {
    const uq = (await adminPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'integration_connections'::regclass AND contype = 'u'`,
    )).rows[0].conname;
    const out = await runMigrationAfter([`ALTER TABLE integration_connections DROP CONSTRAINT ${uq}`]);
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toMatch(/UNIQUE \(tenant_id, owner_kind, owner_id, provider\)/);
  });

  // ── 2 + 3. coexistence, the upsert, and the kinds that were already there ─────────────────────────

  it("two sites of ONE company, each with its own staging AND production ssh record, coexist; a repeat returns the same record; company, client and github_app records are unchanged", async () => {
    // The kinds that were already there, made first.
    const clientId = await createClient(T, "P6o2 client");
    const company = await createConnection(T, { ownerKind: "company", ownerId: T, provider: "ssh", externalAccount: "company ssh", createdBy: requester });
    const client = await createConnection(T, { ownerKind: "client", ownerId: clientId, provider: "ssh", externalAccount: "client ssh", createdBy: requester });
    const app = await createConnection(T, { ownerKind: "github_app", ownerId: githubConnectionOwnerId("erp"), provider: "github", externalAccount: "app", createdBy: requester });
    const before = await Promise.all([company, client, app].map((r) => vaultRow(r.id)));

    const a = await companySite("a");
    const b = await companySite("b");
    const recs = [await record(a.staging), await record(a.production), await record(b.staging), await record(b.production)];
    expect(new Set(recs.map((r) => r.id)).size).toBe(4);
    for (const [r, row] of [[recs[0], a.staging], [recs[1], a.production], [recs[2], b.staging], [recs[3], b.production]] as const) {
      expect(r).toMatchObject({ ownerKind: "webdev_site", ownerId: row, provider: "ssh", status: "unconfigured", hasToken: false });
      expect(await vaultRow(r.id)).toMatchObject({ owner_kind: "webdev_site", owner_id: row, provider: "ssh" });
    }
    // one row may also hold an ftp record, beside its ssh record
    const ftp = await record(a.staging, "ftp");
    expect(ftp.id).not.toBe(recs[0].id);
    // a repeat create is the SAME record (ON CONFLICT (tenant_id, owner_kind, owner_id, provider)), not a second one
    expect((await record(a.staging)).id).toBe(recs[0].id);
    expect(Number((await adminPool().query(
      `SELECT count(*)::int AS n FROM integration_connections WHERE tenant_id = $1 AND owner_kind = 'webdev_site' AND owner_id = $2 AND provider = 'ssh'`,
      [T, a.staging],
    )).rows[0].n)).toBe(1);
    // a revoked per-site record comes back through the same upsert, unconfigured and token-less
    await revokeConnection(T, recs[3].id);
    expect(await record(b.production)).toMatchObject({ id: recs[3].id, status: "unconfigured", hasToken: false });
    // the list is the row's own records only
    expect((await listSiteDeployRecords(P(requester), T, a.staging)).map((r) => r.id).sort()).toEqual([recs[0].id, ftp.id].sort());
    expect((await listSiteDeployRecords(P(requester), T, b.staging)).map((r) => r.id)).toEqual([recs[2].id]);

    // the earlier kinds: untouched, and each still upserts to itself
    expect(await Promise.all([company, client, app].map((r) => vaultRow(r.id)))).toEqual(before);
    expect((await createConnection(T, { ownerKind: "company", ownerId: T, provider: "ssh", createdBy: requester })).id).toBe(company.id);
    expect((await createConnection(T, { ownerKind: "client", ownerId: clientId, provider: "ssh", createdBy: requester })).id).toBe(client.id);
    expect((await createConnection(T, { ownerKind: "github_app", ownerId: githubConnectionOwnerId("erp"), provider: "github", createdBy: requester })).id).toBe(app.id);
  });

  it("no record for a preview or development row, a deleted row, another tenant's row or a malformed id; a body other than {provider[, externalAccount]} is refused; nothing is stored", async () => {
    const preview = newId();
    await adminPool().query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'preview', 'static', 'mandated', 'provisioned', 'main')`,
      [preview, T, `prev-${preview.slice(-8)}.provisioned.invalid`],
    );
    const s = await companySite("refuse");
    const gone = await companySite("gone");
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id = $1`, [gone.production]);
    const countFor = async (row: string) =>
      Number((await adminPool().query(`SELECT count(*)::int AS n FROM integration_connections WHERE owner_kind = 'webdev_site' AND owner_id = $1`, [row])).rows[0].n);

    expect((await caught(record(preview), DeploySecretRefusal)).code).toBe("deploy_secret_not_deliverable");
    expect((await caught(record(gone.production), DeploySecretRefusal)).code).toBe("not_found");
    expect((await caught(createSiteDeployRecord(P(requester, U), U, s.staging, { provider: "ssh" }), DeploySecretRefusal)).code).toBe("not_found");
    expect((await caught(createSiteDeployRecord(P(requester), T, "not-a-uuid", { provider: "ssh" }), DeploySecretRefusal)).code).toBe("not_found");
    for (const body of [{}, { provider: "github" }, { provider: "cpanel" }, { provider: "ssh", password: "x" }, { provider: "ssh", externalAccount: "" }, null, []]) {
      expect((await caught(createSiteDeployRecord(P(requester), T, s.staging, body), DeploySecretRefusal)).code, JSON.stringify(body)).toBe("deploy_secret_body_invalid");
    }
    for (const row of [preview, gone.production, s.staging]) expect(await countFor(row)).toBe(0);
  });

  it("RLS: another tenant sees none of these records, and its own context cannot reach them by id", async () => {
    const s = await companySite("rls");
    const r = await record(s.staging);
    const seen = async (tenant: string) =>
      (await withTenants([tenant], (c) => c.query(`SELECT id FROM integration_connections WHERE owner_kind = 'webdev_site'`))).rows.map((x) => x.id);
    expect(await seen(T)).toContain(r.id);
    expect(await seen(U)).toEqual([]);
    expect((await withTenants([U], (c) => c.query(`SELECT 1 FROM integration_connections WHERE id = $1`, [r.id]))).rowCount).toBe(0);
    // and a write from U's context cannot touch it
    expect((await withTenants([U], (c) => c.query(`UPDATE integration_connections SET external_account = 'x' WHERE id = $1`, [r.id]))).rowCount).toBe(0);
  });

  // ── 4. exactly its own row: the seal, the bind, the filing, the execution ────────────────────────

  it("the SEAL takes a per-site record's own environment only: the production record refuses a staging credential, a record whose row is gone refuses; nothing is stored", async () => {
    const s = await companySite("seal");
    const stg = await record(s.staging);
    const prd = await record(s.production);
    expect(await sealDeployCredential(P(requester), T, stg.id, { credential: credential("staging", "seal") })).toMatchObject({ environment: "staging", connection: { status: "linked", hasToken: true } });
    const wrongEnv = await caught(sealDeployCredential(P(requester), T, prd.id, { credential: credential("staging", "seal-x") }), DeploySecretRefusal);
    expect(wrongEnv).toMatchObject({ code: "deploy_credential_wrong_record", qualifier: "environment" });
    expect((await vaultRow(prd.id))).toMatchObject({ access_token_enc: null, status: "unconfigured" });
    expect(await sealDeployCredential(P(requester), T, prd.id, { credential: credential("production", "seal") })).toMatchObject({ environment: "production" });

    const gone = await companySite("seal-gone");
    const orphan = await record(gone.staging);
    await adminPool().query(`UPDATE webdev_sites SET deleted_at = now() WHERE id IN ($1, $2)`, [gone.production, gone.staging]);
    expect(await caught(sealDeployCredential(P(requester), T, orphan.id, { credential: credential("staging", "orphan") }), DeploySecretRefusal))
      .toMatchObject({ code: "deploy_credential_wrong_record", qualifier: "owner" });
    expect((await vaultRow(orphan.id)).access_token_enc).toBeNull();
  });

  it("the BIND takes each row's own record and refuses another site's and the same site's other environment's (vault_ref_wrong_owner)", async () => {
    const a = await companySite("bind-a");
    const b = await companySite("bind-b");
    const aStg = await record(a.staging);
    const aPrd = await record(a.production);
    const bStg = await record(b.staging);
    await sealDeployCredential(P(requester), T, aStg.id, { credential: credential("staging", "ba") });
    await sealDeployCredential(P(requester), T, aPrd.id, { credential: credential("production", "ba") });
    await sealDeployCredential(P(requester), T, bStg.id, { credential: credential("staging", "bb") });

    expect(await bind(a.staging, aStg.id)).toMatchObject({ vaultRef: aStg.id, deliveryState: "ready" });
    expect(await bind(a.production, aPrd.id)).toMatchObject({ vaultRef: aPrd.id, deliveryState: "ready" });
    expect(await bind(b.staging, bStg.id)).toMatchObject({ vaultRef: bStg.id });
    for (const [row, other] of [[b.staging, aStg.id], [a.staging, bStg.id], [a.staging, aPrd.id], [a.production, aStg.id]] as const) {
      expect((await caught(bind(row, other), DeliveryRefusal)).code, `${row} <- ${other}`).toBe("vault_ref_wrong_owner");
    }
    // the refusals changed nothing
    expect((await adminPool().query(`SELECT vault_ref FROM webdev_sites WHERE id = $1`, [b.staging])).rows[0].vault_ref).toBe(bStg.id);
  });

  it("P6o's WRITE, from per-site records: staging and production each write their own value; a pointer forced at another site's record is refused at filing, and a record re-owned after filing is refused at execution", async () => {
    const s = await companySite("write");
    useGithub(s);
    const stg = await record(s.staging);
    const prd = await record(s.production);
    await sealDeployCredential(P(requester), T, stg.id, { credential: credential("staging", "w") });
    await sealDeployCredential(P(requester), T, prd.id, { credential: credential("production", "w") });
    await bind(s.staging, stg.id);
    await bind(s.production, prd.id);
    const { decryptSecret } = await import("../../core/secret-box");
    const valueOf = async (id: string) => decryptSecret((await vaultRow(id)).access_token_enc as string);

    for (const [row, rec, env] of [[s.staging, stg.id, "staging"], [s.production, prd.id, "production"]] as const) {
      const f = await fileDeploySecretWrite(P(requester), T, row, undefined);
      expect(f).toMatchObject({ status: "pending", environment: env });
      expect((await adminPool().query(`SELECT tool_args->>'connectionId' AS c FROM automation_approvals WHERE id = $1`, [f.approvalId])).rows[0].c).toBe(rec);
      const out = await approveAndRun(f.approvalId);
      expect(out, env).toMatchObject({ executionStatus: "executed", result: { environment: env, written: "created" } });
      const name = siteDeploySecretName({ slug: s.slug, environment: env, repositoryId: s.gh.repoId });
      expect(await s.gh.openOrgSecretValue(name)).toBe(await valueOf(rec));
    }

    // Another company site's record, forced onto this row's pointer by hand (the bind would have refused it).
    const other = await companySite("write-other");
    const otherRec = await record(other.staging);
    await sealDeployCredential(P(requester), T, otherRec.id, { credential: credential("staging", "wo") });
    await adminPool().query(`UPDATE webdev_sites SET vault_ref = $2 WHERE id = $1`, [s.staging, otherRec.id]);
    expect(await caught(fileDeploySecretWrite(P(requester), T, s.staging, undefined), DeploySecretRefusal))
      .toMatchObject({ code: "deploy_secret_vault_unusable", qualifier: "vault_ref_wrong_owner" });

    // Put the own record back, file, then re-own the record to ANOTHER row (one that holds no ssh record yet, or the unique key
    // would refuse the UPDATE itself) BEFORE the decision: the execution re-reads the facts and refuses it, typed, no value write.
    await adminPool().query(`UPDATE webdev_sites SET vault_ref = $2 WHERE id = $1`, [s.staging, stg.id]);
    const f = await fileDeploySecretWrite(P(requester), T, s.staging, undefined);
    await adminPool().query(`UPDATE integration_connections SET owner_id = $2 WHERE id = $1`, [stg.id, other.production]);
    const writes = s.gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path)).length;
    expect(await approveAndRun(f.approvalId)).toMatchObject({ executionStatus: "failed", error: "deploy_secret_vault_unusable: vault_ref_wrong_owner" });
    expect(s.gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path))).toHaveLength(writes);
  });
});
