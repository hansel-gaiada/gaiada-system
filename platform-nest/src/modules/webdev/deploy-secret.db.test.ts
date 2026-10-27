// M6-P6o (WSK-D88) — the ERP writes a delivered site's deploy secret from its vault record, against REAL Postgres (RLS and
// FORCE on every table touched, the vault's AES-GCM seal, the approval row, the GH-04 ledger in `activities`, the outbox, the
// deploy grant's state machine), with GitHub faked at the chokepoint (`githubRequest` -> core/github/git-data.testkit.ts) and
// Cerbos stubbed (deploy-secret-http.test.ts drives the real policies through the real decide() route).
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. SEAL, WRITE, GRANT: the tracked seal path stores ciphertext only; an approved write puts a sealed box that the org's
//      private key opens to exactly the vault's value; the grant then completes; the approval, ledger and console agree;
//   2. ROTATION: a reseal makes the console `stale`, and an approved rewrite makes GitHub hold the new value;
//   3. O-3: without `organization_secrets` the execution FAILS with the typed token, the console says `pending` with that
//      reason, nothing is written and the grant is not attempted;
//   4. an ARCHIVED (revoked) site is refused at filing and at execution, with no value write;
//   5. decider ≠ requester at the preflight AND at execution (a row approved by hand by its own requester writes nothing),
//      and a decided approval never runs twice;
//   6. THE LEAK SCAN: every row of EVERY table, every captured log line, every service answer and every recorded outbound
//      call is scanned for each planted value; a positive control plants one and must find it.
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { newId } from "../../db";
import { config } from "../../config";
import * as githubAppService from "../../core/github/github-app.service";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import { createConnection } from "../../core/integrations.service";
import type { Principal } from "../../rbac/principal";
import { findSecretValueLeaks, type ScannedBlob } from "../../testing/secret-value-leaks";
import { siteDeploySecretName } from "./deploy-grant";
import { revokeDeployForSite } from "./deploy-grant.service";
import { bindSiteDelivery } from "./site-registry.service";
import { DeploySecretRefusal } from "./deploy-secret-write";
import {
  executeApprovedDeploySecretWrite, fileDeploySecretWrite, preflightDeploySecretWrite, readDeploySecretState, sealDeployCredential,
} from "./deploy-secret.service";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});
// Cerbos is the HTTP suite's subject; here the database, the vault and the order are. `writeActivity` (the ledger) stays real.
vi.mock("../../core/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/http")>();
  return { ...actual, authorize: vi.fn(async () => undefined) };
});

const live = Boolean(TEST_URL);
const ORG = "acme-org";
const GRANT = "WEBDESK_DEPLOY_GRANT";
const canary = (tag: string): string => `canary-p6o-${tag}-${randomBytes(12).toString("hex")}`;

const logs: string[] = [];
const fmt = (a: unknown): string => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : JSON.stringify(a) ?? String(a));
const restoreFns: Array<() => void> = [];
/** Every value planted in this run, and every answer a service gave (scanned at the end). */
const planted: Record<string, string> = {};
const answers: string[] = [];
const keep = <T>(v: T): T => {
  answers.push(JSON.stringify(v));
  return v;
};

describe.skipIf(!live)("M6-P6o — the deploy secret written from the vault (real Postgres, faked GitHub)", () => {
  let T: string;
  let requester: string;
  let decider: string;
  let gh: FakeGithub;
  const calls: unknown[] = [];
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId, names: config.webdeskDeploySecretNames, key: config.integrationTokenKey };
  const P = (userId: string): Principal => ({ userId, assurance: "high", companies: [T], roles: [], sessionVersion: 1 }) as unknown as Principal;

  interface Site { id: string; slug: string; webdevSiteId: string; connectionId: string; name: string }

  function credential(tag: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    const password = canary(`pw-${tag}`);
    planted[`password:${tag}`] = password;
    return {
      version: 1, environment: "staging", transport: "sftp", host: "sftp.example.invalid", port: 65002, user: `u_${tag}_stg`, password,
      knownHosts: "[sftp.example.invalid]:65002 ssh-ed25519 AAAAplaceholder", remoteBase: "/home/u/domains/stg", docroot: "public_html",
      siteUrl: "https://stg.example.invalid", ...over,
    };
  }

  /** A provisioned, completed, scaffolded site; its fake repo with an org key; a sealed vault record bound to its staging row. */
  async function deliverableSite(tag: string): Promise<Site & { canonical: string }> {
    const slug = `p6o-${newId().slice(-12)}`;
    const runId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, T]);
    const filed = await fileAutomationApproval({
      tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: requester,
    });
    await db.query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
    // Each site has its own client, so each gets its own vault record: `integration_connections` is UNIQUE per
    // (tenant, owner_kind, owner_id, provider), so a COMPANY can hold only one `ssh` record (see the report's follow-up).
    const clientId = await createClient(T, `P6o client ${tag} ${slug}`);
    const webdevSiteId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site, client_id)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main', $5)`,
      [webdevSiteId, T, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`, clientId],
    );
    const snapshotId = newId();
    const contentHash = `sha256:${"e".repeat(64)}`;
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, '1.0.0', '1.1.0', $4, '{}'::jsonb, 'main')`,
      [snapshotId, T, slug, contentHash],
    );
    const id = newId();
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, $3, 'erp_repo', $4, $5, 'astro', 'live', $6, $7, 'main', 'complete', $8, $5, $9, now())`,
      [id, T, runId, filed.id, slug, `https://github.com/${ORG}/${slug}`, requester, webdevSiteId, snapshotId],
    );
    gh = new FakeGithub(ORG, slug);
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
      [id, "d".repeat(64), snapshotId, base, commit],
    );
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation((async (_t: string, role: string, _a: string, req: never) => {
      if (role !== "erp") throw new Error(`the deploy secret write must use the erp App, not ${role}`);
      const r = await call(req);
      calls.push(req);
      return r;
    }) as never);

    // The vault record (runbook step 2a), sealed through the TRACKED path (step 2b), then bound (step 4).
    const conn = await createConnection(T, { ownerKind: "client", ownerId: clientId, provider: "ssh", externalAccount: `p6o ${tag}`, createdBy: requester });
    const sealed = keep(await sealDeployCredential(P(requester), T, conn.id, { credential: credential(tag) }));
    expect(sealed.connection).toMatchObject({ id: conn.id, status: "linked", hasToken: true });
    await bindSiteDelivery(T, webdevSiteId, { hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh", vaultRef: conn.id }, requester);
    const canonical = await canonicalOf(conn.id);
    return { id, slug, webdevSiteId, connectionId: conn.id, name: siteDeploySecretName({ slug, environment: "staging", repositoryId: gh.repoId }), canonical };
  }

  /** What the vault holds, decrypted here ONLY to compare with what GitHub can open (the test is allowed to know the value). */
  async function canonicalOf(connectionId: string): Promise<string> {
    const { decryptSecret } = await import("../../core/secret-box");
    const r = await adminPool().query<{ e: string }>(`SELECT access_token_enc AS e FROM integration_connections WHERE id = $1`, [connectionId]);
    const v = decryptSecret(r.rows[0].e);
    planted[`canonical:${connectionId}`] = v;
    return v;
  }

  /** decide(), as automation-approvals.controller.ts runs it: preflight, the decide UPDATE, then the in-band execution. */
  async function approveAndRun(approvalId: string, by: string = decider) {
    const row = (await adminPool().query(`SELECT tool_args, requested_by FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0];
    await preflightDeploySecretWrite(T, approvalId, row.tool_args, row.requested_by, P(by));
    await adminPool().query(
      `UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'pending' WHERE id = $1`,
      [approvalId, by],
    );
    return keep(await executeApprovedDeploySecretWrite(T, approvalId, row.tool_args, P(by)));
  }

  const approval = async (id: string) => (await adminPool().query(`SELECT * FROM automation_approvals WHERE id = $1`, [id])).rows[0];
  const valueWrites = () => gh.calls.filter((c) => c.method === "PUT" && /\/actions\/secrets\/[^/]+$/.test(c.path));
  const grantRow = async (id: string) =>
    (await adminPool().query(`SELECT deploy_grant_state, deploy_grant_secret_names FROM webdev_provisioned_sites WHERE id = $1`, [id])).rows[0];

  async function refusal(p: Promise<unknown>): Promise<DeploySecretRefusal> {
    try {
      await p;
    } catch (err) {
      if (err instanceof DeploySecretRefusal) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  beforeAll(async () => {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(fmt).join(" ")); });
      restoreFns.push(() => spy.mockRestore());
    }
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      (stream as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        logs.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
      restoreFns.push(() => { (stream as unknown as { write: unknown }).write = orig; });
    }
    await initTestDb();
    T = await createCompany("P6o Deploy Secret Co", ["webdev"]);
    requester = await createUser("p6o-requester@ex.test", "P6o Requester");
    decider = await createUser("p6o-decider@ex.test", "P6o Decider");
    await addMembership(T, requester);
    await addMembership(T, decider);
    config.githubOrg = ORG;
    config.githubOrgTenantId = T;
    config.webdeskDeploySecretNames = "";
    config.integrationTokenKey = randomBytes(32).toString("base64");
  });

  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    config.webdeskDeploySecretNames = saved.names;
    config.integrationTokenKey = saved.key;
    for (const f of restoreFns.reverse()) f();
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("SEAL, WRITE, GRANT: ciphertext at rest; an approved write stores a box the org's private key opens to the vault value; the grant completes; approval, ledger and console agree", async () => {
    const s = await deliverableSite("happy");
    // At rest: an AES-GCM envelope, never the plaintext.
    const enc = (await adminPool().query(`SELECT access_token_enc FROM integration_connections WHERE id = $1`, [s.connectionId])).rows[0].access_token_enc as string;
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "not_requested" });

    const filing = keep(await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, { reason: "first delivery of the staging site" }));
    expect(filing).toMatchObject({ status: "pending", environment: "staging" });
    const a0 = await approval(filing.approvalId);
    expect(a0).toMatchObject({ origin: "github", workflow_id: "github:write_deploy_secret", tool_name: "github.writeDeploySecret", impact: "high", requested_by: requester });
    expect(Object.keys(a0.tool_args).sort()).toEqual(["connectionId", "environment", "provisionedSiteId", "sealedVersion", "webdevSiteId"]);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "awaiting_approval", approvalId: filing.approvalId });
    // A second filing while one waits is refused, naming the open request.
    expect((await refusal(fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined))).code).toBe("deploy_secret_request_open");

    const out = await approveAndRun(filing.approvalId);
    expect(out).toMatchObject({ executionStatus: "executed", result: { secretName: s.name, written: "created", selectedRepositoryIds: [], grant: { outcome: "granted", state: "granted" } } });
    // The sealing is right: the private key opens it to exactly what the vault holds.
    expect(await gh.openOrgSecretValue(s.name)).toBe(s.canonical);
    // The write created it visible to no repo; the grant (after every gate condition) added exactly this one.
    expect([...gh.orgSecrets.get(s.name)!.repos]).toEqual([gh.repoId]);
    expect(await grantRow(s.id)).toMatchObject({ deploy_grant_state: "granted" });
    expect((await grantRow(s.id)).deploy_grant_secret_names).toEqual(expect.arrayContaining([GRANT, s.name]));

    const a1 = await approval(filing.approvalId);
    expect(a1).toMatchObject({ status: "approved", execution_status: "executed", decided_by: decider, executed_by: decider, execution_error: null });
    expect(a1.execution_result).toMatchObject({ secretName: s.name, environment: "staging", written: "created", sealedVersion: filing.sealedVersion });
    // The GH-04 ledger: attempted + succeeded for the VALUE write, with the name, the approval and WSK-D88's basis.
    const ledger = (await adminPool().query(
      `SELECT metadata FROM activities WHERE verb = 'github.secret_write' AND metadata->>'basis' = 'deploy-secret-write' AND metadata->>'approvalId' = $1 ORDER BY occurred_at, id`,
      [filing.approvalId],
    )).rows.map((r) => r.metadata);
    expect(ledger.map((m) => m.outcome)).toEqual(["attempted", "succeeded"]);
    expect(ledger.every((m) => m.secretName === s.name && m.ruling === "WSK-D88")).toBe(true);
    expect((await adminPool().query(`SELECT 1 FROM outbox_events WHERE event_type = 'webdev.site.deploy_secret_written' AND entity_id = $1`, [s.webdevSiteId])).rowCount).toBe(1);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "written", secretName: s.name, reason: null });
  });

  it("ROTATION: a reseal makes the console stale and refuses the old approval; the approved rewrite makes GitHub hold the NEW value", async () => {
    const s = await deliverableSite("rot");
    await approveAndRun((await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined)).approvalId);
    expect(await gh.openOrgSecretValue(s.name)).toBe(s.canonical);

    // A filed-but-undecided request for the OLD value, then the reseal (the vault changes FIRST).
    const stale = await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined);
    keep(await sealDeployCredential(P(requester), T, s.connectionId, { credential: credential("rot2") }));
    const next = await canonicalOf(s.connectionId);
    expect(next).not.toBe(s.canonical);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "awaiting_approval" });
    const refused = await approveAndRun(stale.approvalId);
    expect(refused).toMatchObject({ executionStatus: "failed", error: "deploy_secret_vault_changed" });
    expect(await gh.openOrgSecretValue(s.name)).toBe(s.canonical);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "pending", reason: "deploy_secret_vault_changed" });

    const out = await approveAndRun((await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined)).approvalId);
    expect(out).toMatchObject({ executionStatus: "executed", result: { written: "updated", selectedRepositoryIds: [gh.repoId] } });
    // After: the vault and GitHub agree.
    expect(await gh.openOrgSecretValue(s.name)).toBe(next);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "written" });
  });

  it("O-3: without organization_secrets the write FAILS typed; the console says pending with that reason, never success; nothing written, no grant attempted", async () => {
    const s = await deliverableSite("o3");
    gh.orgSecretsPermission = false;
    const out = await approveAndRun((await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined)).approvalId);
    expect(out).toMatchObject({ executionStatus: "failed", error: "github_permission_missing: organization_secrets" });
    expect(valueWrites()).toHaveLength(0);
    expect(gh.calls.some((c) => c.path.includes("/repositories/"))).toBe(false);
    expect((await grantRow(s.id)).deploy_grant_state).toBeNull();
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({
      state: "pending", reason: "github_permission_missing: organization_secrets",
    });
  });

  it("an ARCHIVED (revoked) site gets nothing: refused at filing, and a request filed before the revoke writes nothing (WSK-D82)", async () => {
    const s = await deliverableSite("arch");
    // Delivered and granted first, so the archive has a grant to revoke.
    await approveAndRun((await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined)).approvalId);
    expect((await grantRow(s.id)).deploy_grant_state).toBe("granted");
    const early = await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined);
    const writesBefore = valueWrites().length;
    // The archive path's own call (revokeDeployAfterArchive -> revokeDeployForSite), as the archive's decider.
    await revokeDeployForSite(P(decider), T, s.id, "WebDesk site archived (approval test)");
    expect((await grantRow(s.id)).deploy_grant_state).toBe("revoked");
    expect((await refusal(fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined))).code).toBe("deploy_secret_site_revoked");
    const out = await approveAndRun(early.approvalId);
    expect(out).toMatchObject({ executionStatus: "failed", error: "deploy_secret_site_revoked" });
    expect(valueWrites()).toHaveLength(writesBefore);
    // The revoke removed the repo; nothing put it back.
    expect([...gh.orgSecrets.get(s.name)!.repos]).toEqual([]);
    expect(keep(await readDeploySecretState(P(requester), T, s.webdevSiteId))).toMatchObject({ state: "revoked" });
  });

  it("APPROVAL: the requester cannot approve their own request (preflight), a row approved by its requester by hand writes nothing (executor), and a decided approval never runs twice", async () => {
    const s = await deliverableSite("appr");
    const f = await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined);
    const row = await approval(f.approvalId);
    const self = await preflightDeploySecretWrite(T, f.approvalId, row.tool_args, row.requested_by, P(requester)).catch((e) => e);
    expect(self).toBeInstanceOf(ForbiddenException);
    expect((self as ForbiddenException).getResponse()).toMatchObject({ reason: "self_approval" });

    // The second wall: approved by its own requester through some other path.
    await adminPool().query(
      `UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'pending' WHERE id = $1`,
      [f.approvalId, requester],
    );
    expect(keep(await executeApprovedDeploySecretWrite(T, f.approvalId, row.tool_args, P(requester)))).toMatchObject({
      executionStatus: "failed", error: "approver_refused: self_approval",
    });
    expect(gh.calls).toHaveLength(0);

    // A properly decided one runs once; re-presenting it claims nothing and writes nothing.
    const g = await fileDeploySecretWrite(P(requester), T, s.webdevSiteId, undefined);
    expect(await approveAndRun(g.approvalId)).toMatchObject({ executionStatus: "executed" });
    const writes = valueWrites().length;
    expect(await executeApprovedDeploySecretWrite(T, g.approvalId, (await approval(g.approvalId)).tool_args, P(decider))).toEqual({
      executionStatus: "not_claimed", error: "already_decided_or_executed",
    });
    expect(valueWrites()).toHaveLength(writes);
  });

  it("the seal path refuses a malformed credential naming fields only, a user-owned record, and the wrong provider; nothing is stored", async () => {
    const own = await createConnection(T, { ownerKind: "user", ownerId: requester, provider: "ssh", externalAccount: "mine", createdBy: requester });
    const ftp = await createConnection(T, { ownerKind: "company", ownerId: T, provider: "ftp", externalAccount: "p6o ftp", createdBy: requester });
    const bad = { ...credential("bad"), transport: "ftp" };
    const e1 = await refusal(sealDeployCredential(P(requester), T, ftp.id, { credential: bad }));
    expect(e1.code).toBe("deploy_credential_invalid");
    expect(e1.detail).toContain("transport must be sftp or ftps");
    expect((await refusal(sealDeployCredential(P(requester), T, own.id, { credential: credential("own") }))).code).toBe("deploy_credential_wrong_record");
    expect((await refusal(sealDeployCredential(P(requester), T, ftp.id, { credential: credential("prov") }))).code).toBe("deploy_credential_wrong_record");
    expect((await refusal(sealDeployCredential(P(requester), T, ftp.id, { credential: credential("x"), extra: 1 }))).code).toBe("deploy_secret_body_invalid");
    for (const r of [own, ftp]) {
      const row = (await adminPool().query(`SELECT access_token_enc, status FROM integration_connections WHERE id = $1`, [r.id])).rows[0];
      expect(row).toMatchObject({ access_token_enc: null, status: "unconfigured" });
    }
  });

  // ── THE LEAK SCAN (runs after everything above in this file) ─────────────────────────────────────

  async function collectBlobs(): Promise<ScannedBlob[]> {
    const tables = (await adminPool().query<{ t: string }>(
      `SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    )).rows.map((r) => r.t);
    const out: ScannedBlob[] = [];
    for (const t of tables) {
      const rows = (await adminPool().query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM ${t} x`)).rows;
      rows.forEach((r, i) => out.push({ where: `${t}#${i}`, text: r.j }));
    }
    logs.forEach((text, i) => out.push({ where: `log#${i}`, text }));
    answers.forEach((text, i) => out.push({ where: `answer#${i}`, text }));
    calls.forEach((c, i) => out.push({ where: `github-call#${i}`, text: JSON.stringify(c) }));
    return out;
  }

  it("LEAK SCAN: no row of ANY table, no log line, no answer and no outbound call holds a planted value (passwords and whole credentials)", async () => {
    expect(Object.keys(planted).length).toBeGreaterThanOrEqual(8);
    // The capture is wired (a control for the capture itself, not for the app's chattiness).
    console.log("[p6o] log capture probe");
    expect(logs.some((l) => l.includes("[p6o] log capture probe"))).toBe(true);
    const blobs = await collectBlobs();
    expect(blobs.some((b) => b.where.startsWith("integration_connections#"))).toBe(true);
    expect(blobs.some((b) => b.where.startsWith("automation_approvals#"))).toBe(true);
    expect(blobs.some((b) => b.where.startsWith("github-call#"))).toBe(true);
    expect(findSecretValueLeaks(blobs, planted)).toEqual([]);
  });

  it("LEAK SCAN positive control: plant ONE password in an audit row and the same scan must find it", async () => {
    const [label, value] = Object.entries(planted).find(([k]) => k.startsWith("password:")) as [string, string];
    await adminPool().query(
      `UPDATE activities SET metadata = metadata || jsonb_build_object('planted', $1::text)
        WHERE id = (SELECT id FROM activities WHERE verb = 'github.secret_write' ORDER BY occurred_at LIMIT 1)`,
      [value],
    );
    const hits = findSecretValueLeaks(await collectBlobs(), { [label]: value });
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/^activities#\d+: password:/);
  });
});
