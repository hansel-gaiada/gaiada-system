// M6-P4c — provisioning completion against REAL Postgres (RLS, FORCE, the third wall on both
// webdev_provisioned_sites and webdev_sites, the migration's CHECK / FK / partial-unique), with the WebDesk
// control client faked at its HTTP boundary (`send`, injected through setWebdeskApprovedCommandDepsForTests,
// which `webdeskZoneB` honours), the contract mirror's provider faked (no real WebDesk), and GitHub's
// `githubRequest` mocked for the decide()-hook path (never the live API from a test).
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the full happy path: one reconcile takes a repo-approved row from `pending` to `complete` — a
//      webdev_sites row with origin=provisioned, adoption=mandated, the §08 kind, repo_url and the run's
//      lineage; ONE WebDesk tenant.provision with companyRef = the ERP company and the deterministic key;
//      ONE pinned contract snapshot; webdev_sites.contract_version set; and NO approval filed;
//   2. codegen is async: before latest.json exists the row parks at tenant_ready and resumes later;
//   3. crash-resume: WebDesk committed and the answer was lost (ambiguous) -> the resend with the SAME key is a
//      replay, ONE tenant; WebDesk unreachable after the registry step -> resume; an orphaned provisioned
//      registry row is adopted, never duplicated; replaying a complete row does nothing;
//   4. two concurrent completions: one registry row, one tenant request;
//   5. a foreign WebDesk slug is refused and recorded;
//   6. the decide() hook (`completeAfterRepoApproval`): GH-12 approved + GitHub shows the repo -> complete;
//   7. the schema refuses a state without its link, and one registry row per provisioned row.
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";
import * as githubAppService from "../../core/github/github-app.service";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import { computeContentHash } from "../webdev-contracts/contract-snapshot.service";
import { WebdevControlEgressError, type ContractBundleMeta, type WebdevControlProvider } from "../webdev-contracts/contract-fetch-provider";
import {
  WebdeskControlTransportError, EditorialUnavailableError,
  type WebdeskControlClient, type WebdeskControlRequest, type WebdeskControlResponse,
} from "./webdesk-control-client";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { problem } from "./webdesk-content-testkit";
import type { ProvisionProvider, ProvisionProject } from "./provision-provider";
import {
  completeAfterRepoApproval, completeProvisionedSite, readProvisionCompletion, reconcileAndComplete,
  setProvisionCompletionDepsForTests,
} from "./provision-completion.service";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const ok = (json: unknown, status = 200): WebdeskControlResponse => ({ status, contentType: "application/json", json, bodyText: JSON.stringify(json) });

/** WebDesk's control plane at the HTTP boundary: its tenants, its claim-first idempotency records. */
class FakeWebdesk {
  calls: WebdeskControlRequest[] = [];
  tenants: Array<{ slug: string; companyRef: string; status: string }> = [];
  keys = new Map<string, Record<string, unknown>>();
  tenantsCreated = 0;
  dropAfterApplyNext = false;
  failWith: Error | null = null;

  provisionCalls(): WebdeskControlRequest[] {
    return this.calls.filter((c) => c.command === "tenant.provision");
  }

  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
    if (req.command === "tenant.list") {
      const companyRef = req.query?.companyRef;
      return ok({
        tenants: this.tenants
          .filter((t) => t.companyRef === companyRef)
          .map((t) => ({ slug: t.slug, status: t.status, defaultLocale: "en", locales: ["en"], sites: [] })),
      });
    }
    if (req.command === "tenant.provision") {
      const key = req.idempotencyKey as string;
      const stored = this.keys.get(key);
      if (stored) return ok({ ...stored, replayed: true });
      const body = req.body as { slug: string; companyRef: string };
      if (this.tenants.some((t) => t.slug === body.slug)) return problem(409, "conflict", { detail: "tenant slug already exists" });
      this.tenants.push({ slug: body.slug, companyRef: body.companyRef, status: "active" });
      this.tenantsCreated += 1;
      const result = { tenant: { id: randomUUID(), slug: body.slug, company_ref: body.companyRef, status: "active" } };
      this.keys.set(key, result);
      if (this.dropAfterApplyNext) {
        this.dropAfterApplyNext = false;
        throw new WebdeskControlTransportError("link died after the request was written", 1, true, "ECONNRESET");
      }
      return ok({ ...result, replayed: false }, 201);
    }
    return problem(404, "not-found");
  }
}

/** The contract mirror's far side: unpublished (404) until a test publishes the slug. */
function contractProvider(published: Set<string>): WebdevControlProvider {
  const artifacts = {
    sdkTs: Buffer.from("export const sdk = 'p4c';"),
    openapi: Buffer.from(JSON.stringify({ openapi: "3.0.0", info: { title: "p4c" } })),
    contractMd: Buffer.from("# Contract\n\np4c\n"),
    sdkPhp: null as Buffer | null,
  };
  const { contentHash } = computeContentHash(artifacts);
  const byUrl: Record<string, Buffer> = {
    "https://fixture.invalid/sdk.d.ts": artifacts.sdkTs,
    "https://fixture.invalid/openapi.v1.json": artifacts.openapi,
    "https://fixture.invalid/CONTENT-CONTRACT.md": artifacts.contractMd,
  };
  return {
    key: "fixture",
    async getContractBundle(slug: string): Promise<ContractBundleMeta> {
      if (!published.has(slug)) throw new WebdevControlEgressError(`webdev-control contract read for "${slug}" returned 404: not found`);
      return {
        version: "1.0.0",
        vocabularyVersion: "1.3.0",
        blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
        artifacts: {
          sdkTsUrl: "https://fixture.invalid/sdk.d.ts",
          sdkPhpUrl: null,
          openapiUrl: "https://fixture.invalid/openapi.v1.json",
          contractMdUrl: "https://fixture.invalid/CONTENT-CONTRACT.md",
          blockLibraryUrl: null,
        },
        contentHash,
        generatedAt: new Date().toISOString(),
      };
    },
    async downloadArtifact(url: string): Promise<Buffer> {
      const b = byUrl[url];
      if (!b) throw new Error(`no fixture artifact for ${url}`);
      return b;
    },
  };
}

/** The repo step's far side: the GH-12 request is approved and GitHub has the repo. */
function repoReady(slug: string): ProvisionProvider {
  const project = (id: string): ProvisionProject => ({
    id, name: slug, status: "live", repoUrl: `https://github.com/acme-org/${slug}`, stagingUrl: null,
  });
  return {
    key: "erp_repo",
    createProject: async () => {
      throw new Error("the completion path never re-files the repo request");
    },
    getProject: async (id) => project(id),
    findProjectByName: async () => null,
  };
}

const live = Boolean(TEST_URL);

describe.skipIf(!live)("M6-P4c — provisioning completion (real Postgres, faked WebDesk)", () => {
  let T: string;
  let OTHER: string;
  let userId: string;
  let clientId: string;
  let projectId: string;
  let principal: Principal;
  let wd: FakeWebdesk;
  let published: Set<string>;

  async function pendingSite(slug: string, opts: { framework?: string; providerRef?: string; lineage?: boolean } = {}): Promise<string> {
    const id = newId();
    await withTenants(
      [T],
      (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites
             (id, tenant_id, provider, provider_ref, slug, framework, status, requested_by, client_id, project_id, origin_site)
           VALUES ($1, $2, 'erp_repo', $3, $4, $5, 'pending', $6, $7, $8, 'main')`,
          [id, T, opts.providerRef ?? newId(), slug, opts.framework ?? "astro", userId,
            opts.lineage === false ? null : clientId, opts.lineage === false ? null : projectId],
        ),
      { modules: ["webdev"] },
    );
    return id;
  }

  async function stored(id: string) {
    const r = await adminPool().query(
      `SELECT status, repo_url, completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_error
         FROM webdev_provisioned_sites WHERE id = $1`,
      [id],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function registryRows(domain: string) {
    const r = await adminPool().query(
      `SELECT id, tenant_id, domain, environment, origin, adoption, kind, repo_url, client_id, project_id, contract_version
         FROM webdev_sites WHERE domain = $1 AND deleted_at IS NULL`,
      [domain],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  async function approvalCount(): Promise<number> {
    const r = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM automation_approvals WHERE tenant_id = $1`, [T]);
    return Number(r.rows[0].n);
  }

  async function snapshotCount(slug: string): Promise<number> {
    const r = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM webdev_contract_snapshots WHERE tenant_id = $1 AND webdesk_tenant_slug = $2`,
      [T, slug],
    );
    return Number(r.rows[0].n);
  }

  const slugOf = (p: string) => `${p}-${newId().slice(0, 8)}`;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P4c Completion Co", ["webdev"]);
    OTHER = await createCompany("P4c Other Co", ["webdev"]);
    userId = await createUser("p4c-completion@ex.test", "P4c Operator");
    await addMembership(T, userId);
    clientId = await createClient(T, "P4c Client");
    projectId = await createProject(T, "P4c Project", userId);
    principal = { userId, assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;
  });

  afterAll(async () => {
    setWebdeskApprovedCommandDepsForTests(null);
    setProvisionCompletionDepsForTests(null);
    await teardownTestDb();
  });

  beforeEach(() => {
    wd = new FakeWebdesk();
    published = new Set();
    setWebdeskApprovedCommandDepsForTests({ client: wd as unknown as WebdeskControlClient });
    setProvisionCompletionDepsForTests({ contractProvider: contractProvider(published) });
    webdeskZoneB.clearSiteCache();
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("HAPPY PATH: one reconcile takes a repo-approved row from pending to complete", async () => {
    const slug = slugOf("happy");
    published.add(slug);
    const id = await pendingSite(slug);
    const approvalsBefore = await approvalCount();

    const { outcome, completion } = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(outcome.outcome).toBe("advanced");
    expect(completion).toEqual({ state: "complete", next: "done", advanced: ["register", "tenant", "contract"], error: null });

    const reg = await registryRows(`${slug}.provisioned.invalid`);
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({
      tenant_id: T, environment: "staging", origin: "provisioned", adoption: "mandated", kind: "static",
      repo_url: `https://github.com/acme-org/${slug}`, client_id: clientId, project_id: projectId, contract_version: "1.0.0",
    });
    const row = await stored(id);
    expect(row).toMatchObject({
      status: "live", completion_state: "complete", webdev_site_id: reg[0].id, webdesk_tenant_slug: slug, completion_error: null,
    });
    expect(row.contract_snapshot_id).toBeTruthy();
    expect(await snapshotCount(slug)).toBe(1);

    const sent = wd.provisionCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", path: "/control/v1/tenants", body: { slug, companyRef: T }, idempotencyKey: `wps-tenant:${id}` });
    expect(sent[0].ws4).toBeUndefined(); // MEDIUM: no WS4 assertion
    expect(wd.tenantsCreated).toBe(1);
    // No approval of any kind was filed by the completion.
    expect(await approvalCount()).toBe(approvalsBefore);
    // The egress is ledgered: attempted, then succeeded.
    const acts = await adminPool().query(
      `SELECT metadata->>'outcome' AS outcome FROM activities WHERE verb = 'webdesk.tenant.provision' AND target_entity_id = $1 ORDER BY occurred_at`,
      [id],
    );
    expect(acts.rows.map((r) => r.outcome)).toEqual(["attempted", "succeeded"]);
    // The route's read shape.
    expect(await readProvisionCompletion(T, id)).toMatchObject({ state: "complete", next: "done", webdeskTenantSlug: slug, error: null });
  });

  it("maps fullstack and wp frameworks to their §08 kinds in the registry row", async () => {
    for (const [framework, kind] of [["node", "fullstack"], ["wp", "wp"]] as const) {
      const slug = slugOf(`kind-${framework}`);
      const id = await pendingSite(slug, { framework, lineage: false });
      await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
      const reg = await registryRows(`${slug}.provisioned.invalid`);
      expect(reg[0]).toMatchObject({ kind, client_id: null, project_id: null });
    }
  });

  it("CODEGEN IS ASYNC: parks at tenant_ready with contract_not_published, then completes on a later reconcile", async () => {
    const slug = slugOf("async");
    const id = await pendingSite(slug);
    const first = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(first.completion).toMatchObject({ state: "tenant_ready", next: "contract", error: "contract_not_published" });
    expect(await stored(id)).toMatchObject({ completion_state: "tenant_ready", completion_error: "contract_not_published", contract_snapshot_id: null });

    published.add(slug);
    const second = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(second.completion).toMatchObject({ state: "complete", advanced: ["contract"], error: null });
    expect(wd.provisionCalls()).toHaveLength(1);
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(1);
  });

  it("CRASH-RESUME (tenant): WebDesk committed, the answer was lost -> resend with the SAME key is a replay; ONE tenant", async () => {
    const slug = slugOf("ambig");
    published.add(slug);
    const id = await pendingSite(slug);
    wd.dropAfterApplyNext = true;
    const first = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(first.completion).toMatchObject({ state: "registered", error: "webdesk_ambiguous" });
    expect(wd.tenantsCreated).toBe(1);

    const second = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(second.completion).toMatchObject({ state: "complete", advanced: ["tenant", "contract"] });
    const sent = wd.provisionCalls();
    expect(sent).toHaveLength(2);
    expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
    expect(wd.tenantsCreated).toBe(1);
    expect(wd.tenants.filter((t) => t.slug === slug)).toHaveLength(1);
  });

  it("CRASH-RESUME (between register and tenant): WebDesk down after the registry commit -> resume finishes once", async () => {
    const slug = slugOf("down");
    published.add(slug);
    const id = await pendingSite(slug);
    wd.failWith = new EditorialUnavailableError(30_000);
    const first = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(first.completion).toMatchObject({ state: "registered", next: "tenant" });
    expect(String(first.completion?.error)).toContain("editorial_unavailable");
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(1);

    wd.failWith = null;
    const second = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(second.completion).toMatchObject({ state: "complete" });
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(1);
    expect(wd.tenantsCreated).toBe(1);
  });

  it("an orphaned registry row that provisioning made is ADOPTED; a manual row with the same domain is refused", async () => {
    const slug = slugOf("orphan");
    published.add(slug);
    const orphanId = newId();
    await withTenants(
      [T],
      (c) =>
        c.query(
          `INSERT INTO webdev_sites (id, tenant_id, domain, environment, origin, adoption, origin_site)
           VALUES ($1, $2, $3, 'staging', 'provisioned', 'mandated', 'main')`,
          [orphanId, T, `${slug}.provisioned.invalid`],
        ),
      { modules: ["webdev"] },
    );
    const id = await pendingSite(slug);
    await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(1);
    expect(await stored(id)).toMatchObject({ webdev_site_id: orphanId, completion_state: "complete" });

    const manualSlug = slugOf("manual");
    await withTenants(
      [T],
      (c) => c.query(`INSERT INTO webdev_sites (id, tenant_id, domain, origin, origin_site) VALUES ($1, $2, $3, 'manual', 'main')`, [newId(), T, `${manualSlug}.provisioned.invalid`]),
      { modules: ["webdev"] },
    );
    const id2 = await pendingSite(manualSlug);
    const r = await reconcileAndComplete({ tenantId: T, siteId: id2, provider: repoReady(manualSlug), requestedByName: "x", principal });
    expect(r.completion).toMatchObject({ state: null, error: "registry_domain_taken" });
    expect(wd.provisionCalls()).toHaveLength(1); // only the first site's
  });

  it("REPLAY: reconciling a complete row three more times changes nothing", async () => {
    const slug = slugOf("replay");
    published.add(slug);
    const id = await pendingSite(slug);
    await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    const before = await stored(id);
    for (let i = 0; i < 3; i++) {
      const r = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
      expect(r.completion).toEqual({ state: "complete", next: "done", advanced: [], error: null });
    }
    expect(await stored(id)).toEqual(before);
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(1);
    expect(wd.provisionCalls()).toHaveLength(1);
    expect(await snapshotCount(slug)).toBe(1);
  });

  it("CONCURRENCY: two completions racing on the same live row -> one registry row, one tenant request", async () => {
    // A row whose repo step already finished (live + repo_url), so only the completion races.
    const slug2 = slugOf("race");
    published.add(slug2);
    const id2 = await pendingSite(slug2);
    await withTenants([T], (c) => c.query(
      `UPDATE webdev_provisioned_sites SET status = 'live', repo_url = $2 WHERE id = $1`,
      [id2, `https://github.com/acme-org/${slug2}`],
    ), { modules: ["webdev"] });
    const [a, b] = await Promise.all([completeProvisionedSite(T, id2, principal), completeProvisionedSite(T, id2, principal)]);
    expect([a.state, b.state]).toEqual(["complete", "complete"]);
    expect(await registryRows(`${slug2}.provisioned.invalid`)).toHaveLength(1);
    expect(wd.provisionCalls().filter((c) => (c.body as { slug: string }).slug === slug2)).toHaveLength(1);
    expect([...a.advanced, ...b.advanced].sort()).toEqual(["contract", "register", "tenant"]);
  });

  it("a WebDesk slug held by ANOTHER company is refused (webdesk_tenant_slug_foreign); nothing is created", async () => {
    const slug = slugOf("foreign");
    wd.tenants.push({ slug, companyRef: OTHER, status: "active" });
    const id = await pendingSite(slug);
    const r = await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    expect(r.completion).toMatchObject({ state: "registered", error: "webdesk_tenant_slug_foreign" });
    expect(wd.tenantsCreated).toBe(0);
    expect(await stored(id)).toMatchObject({ completion_state: "registered", completion_error: "webdesk_tenant_slug_foreign" });
  });

  it("a live mirror row from the decommissioned `provision` host is NOT completed retroactively", async () => {
    const slug = slugOf("legacy");
    const id = newId();
    await withTenants([T], (c) => c.query(
      `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, repo_url, origin_site)
       VALUES ($1, $2, 'provision', $3, $4, 'vite', 'live', $5, 'main')`,
      [id, T, newId(), slug, `https://github.com/acme-org/${slug}`],
    ), { modules: ["webdev"] });
    const r = await completeProvisionedSite(T, id, principal);
    expect(r).toEqual({ state: null, next: "not_ready", advanced: [], error: null });
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(0);
    expect(wd.calls).toHaveLength(0);
  });

  it("a row still awaiting its repo is left alone (no registry row, no WebDesk call)", async () => {
    const slug = slugOf("waiting");
    const id = await pendingSite(slug);
    const waiting: ProvisionProvider = { ...repoReady(slug), getProject: async (pid) => ({ id: pid, name: slug, status: "pending", repoUrl: null, stagingUrl: null }) };
    const r = await reconcileAndComplete({ tenantId: T, siteId: id, provider: waiting, requestedByName: "x", principal });
    expect(r.completion).toEqual({ state: null, next: "not_ready", advanced: [], error: null });
    expect(await registryRows(`${slug}.provisioned.invalid`)).toHaveLength(0);
    expect(wd.calls).toHaveLength(0);
  });

  it("DECIDE HOOK: GH-12 approved and GitHub shows the repo -> completeAfterRepoApproval finishes §08", async () => {
    const savedOrg = config.githubOrg;
    config.githubOrg = "acme-org";
    try {
      const slug = slugOf("decide");
      published.add(slug);
      const filed = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [filed.id]);
      const id = await pendingSite(slug, { providerRef: filed.id });
      vi.mocked(githubAppService.githubRequest).mockResolvedValue({
        data: { full_name: `acme-org/${slug}`, html_url: `https://github.com/acme-org/${slug}` }, status: 200,
      } as never);

      await completeAfterRepoApproval(T, filed.id, principal);
      expect(await stored(id)).toMatchObject({ status: "live", completion_state: "complete", webdesk_tenant_slug: slug });
      // An approval that no provisioned row filed is a no-op, and never throws.
      await expect(completeAfterRepoApproval(T, newId(), principal)).resolves.toBeUndefined();
    } finally {
      config.githubOrg = savedOrg;
    }
  });

  it("SCHEMA: a state cannot be recorded without its link, and one registry row belongs to one provisioned row", async () => {
    const slug = slugOf("schema");
    const id = await pendingSite(slug);
    await expect(
      adminPool().query(`UPDATE webdev_provisioned_sites SET completion_state = 'registered' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });

    published.add(slug);
    await reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal });
    const linked = (await stored(id)).webdev_site_id as string;
    const other = await pendingSite(slugOf("schema2"));
    await expect(
      adminPool().query(`UPDATE webdev_provisioned_sites SET webdev_site_id = $2 WHERE id = $1`, [other, linked]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("THIRD WALL: the completion columns are invisible to another company", async () => {
    const slug = slugOf("wall");
    const id = await pendingSite(slug);
    const seen = await withTenants([OTHER], (c) => c.query(`SELECT 1 FROM webdev_provisioned_sites WHERE id = $1`, [id]), { modules: ["webdev"] });
    expect(seen.rowCount).toBe(0);
    expect(await readProvisionCompletion(OTHER, id)).toBeNull();
  });
});
