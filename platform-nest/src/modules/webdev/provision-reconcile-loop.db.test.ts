// M6-P4c2 — the scheduled reconcile against REAL Postgres (RLS, FORCE, the third wall, the advisory lock) with the
// real completion state machine behind it. Same fakes as provision-completion.db.test.ts: WebDesk's control plane at
// the HTTP boundary, the contract mirror's far side (unpublished until a test publishes the slug), and GitHub's
// `githubRequest` mocked. NOTHING in the loop is faked: `runProvisionReconcileTick()` runs with its default deps, so
// the company enumeration, the per-tenant `{modules:['webdev']}` read, `isModuleEnabled`, `assemblePrincipal`
// and `completeAfterPoll` / `reconcileAndComplete` are the production ones.
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the stall itself: a row parked at tenant_ready (contract_not_published) advances to `complete` on a tick once
//      WebDesk has published, with ONE contract_pinned event and ONE snapshot, acting as the row's own requester;
//   2. a `complete` row and a `failed` row are not touched (not even their updated_at);
//   3. two tenants are both reached by one tick (an unscoped read would return zero rows for BOTH);
//   4. a tenant with the webdev module OFF is left alone (the third wall alone would have let it through);
//   5. a click racing a tick (and a second completion) pins the contract once: one event, one snapshot;
//   6. a `pending` row whose GH-12 request was approved is reconciled through the repo step too; one whose request is
//      still awaiting its decision is not (and GitHub is never asked);
//   7. the back-off: inside a wait nothing happens, once the wait passes it advances, past 24 h it is left alone;
//   8. an unexpected fault on one row is recorded on that row and does not stop the others.
// Test traps honoured: slugs come from newId().slice(-12) (uuidv7 hex prefix is a timestamp and collides), and
// beforeEach has a BLOCK body (a returned function would become a cleanup hook).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import type { Principal } from "../../rbac/principal";
import * as githubAppService from "../../core/github/github-app.service";
import { GithubApiError } from "../../core/github/errors";
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
  completeProvisionedSite, reconcileAndComplete, setProvisionCompletionDepsForTests,
} from "./provision-completion.service";
import { runProvisionReconcileTick } from "./provision-reconcile-loop";

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
function contractProvider(published: Set<string>, badBlockLibrary: Set<string> = new Set()): WebdevControlProvider {
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
    "https://fixture.invalid/blocks.tgz": Buffer.from("tarball bytes as downloaded"),
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
          // M6-P4b0b: a slug in `badBlockLibrary` is one whose tarball does not hash to WebDesk's claim.
          blockLibraryUrl: badBlockLibrary.has(slug) ? "https://fixture.invalid/blocks.tgz" : null,
          blockLibrarySha256: badBlockLibrary.has(slug) ? "ab".repeat(32) : null,
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

describe.skipIf(!live)("M6-P4c2 — the scheduled provisioning reconcile (real Postgres, faked WebDesk)", () => {
  let T: string;
  let OTHER: string;
  let OFF: string;
  let userId: string;
  let clientId: string;
  let projectId: string;
  let principal: Principal;
  let wd: FakeWebdesk;
  let published: Set<string>;
  let exploding: Set<string>;

  /** A provisioned row as the repo step leaves it: ERP repo control, repo done (live + repo_url), completion not begun. */
  async function liveSite(tenant: string, slug: string, opts: { requestedBy?: string | null } = {}): Promise<string> {
    const id = newId();
    const lineage = tenant === T;
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO webdev_provisioned_sites
             (id, tenant_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, client_id, project_id, origin_site)
           VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'live', $5, $6, $7, $8, 'main')`,
          [id, tenant, newId(), slug, `https://github.com/acme-org/${slug}`,
            opts.requestedBy === undefined ? userId : opts.requestedBy, lineage ? clientId : null, lineage ? projectId : null],
        ),
      { modules: ["webdev"] },
    );
    return id;
  }

  /** The stall: registry row + WebDesk tenant done, the contract not published yet. */
  async function stuckAtTenantReady(tenant: string, slug: string): Promise<string> {
    const id = await liveSite(tenant, slug);
    const r = await completeProvisionedSite(tenant, id, principal);
    expect(r).toMatchObject({ state: "tenant_ready", next: "contract", error: "contract_not_published" });
    return id;
  }

  async function stored(id: string) {
    const r = await adminPool().query(
      `SELECT status, completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_error,
              completion_updated_at, updated_at
         FROM webdev_provisioned_sites WHERE id = $1`,
      [id],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function pinnedEvents(id: string): Promise<number> {
    const r = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE event_type = 'webdev.site.contract_pinned' AND entity_id = $1`,
      [id],
    );
    return Number(r.rows[0].n);
  }

  async function snapshotCount(tenant: string, slug: string): Promise<number> {
    const r = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM webdev_contract_snapshots WHERE tenant_id = $1 AND webdesk_tenant_slug = $2`,
      [tenant, slug],
    );
    return Number(r.rows[0].n);
  }

  const slugOf = (p: string) => `${p}-${newId().slice(-12)}`;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P4c2 Reconcile Co", ["webdev"]);
    OTHER = await createCompany("P4c2 Second Co", ["webdev"]);
    OFF = await createCompany("P4c2 Module-Off Co", []);
    userId = await createUser("p4c2-reconcile@ex.test", "P4c2 Operator");
    await addMembership(T, userId);
    clientId = await createClient(T, "P4c2 Client");
    projectId = await createProject(T, "P4c2 Project", userId);
    principal = { userId, assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;
  });

  afterAll(async () => {
    setWebdeskApprovedCommandDepsForTests(null);
    setProvisionCompletionDepsForTests(null);
    await teardownTestDb();
  });

  beforeEach(async () => {
    wd = new FakeWebdesk();
    published = new Set();
    exploding = new Set();
    const base = contractProvider(published);
    const provider: WebdevControlProvider = {
      ...base,
      async getContractBundle(slug: string) {
        if (exploding.has(slug)) throw new Error("unexpected fault inside the contract mirror");
        return base.getContractBundle(slug);
      },
    };
    setWebdeskApprovedCommandDepsForTests({ client: wd as unknown as WebdeskControlClient });
    setProvisionCompletionDepsForTests({ contractProvider: provider });
    webdeskZoneB.clearSiteCache();
    vi.mocked(githubAppService.githubRequest).mockReset();
    // Isolation: the tick reads every company, so a row an earlier test left unfinished must not be driven by this
    // one. `failed` is the loop's own "leave it alone" status; updated_at is untouched.
    await adminPool().query(`UPDATE webdev_provisioned_sites SET status = 'failed'`);
  });

  it("THE STALL: a tenant_ready row advances to complete on a tick once the contract is published; ONE event, ONE snapshot, as the requester", async () => {
    const slug = slugOf("stall");
    const id = await stuckAtTenantReady(T, slug);

    // Not published yet: a tick attempts it and it stays parked.
    const first = await runProvisionReconcileTick();
    expect(first).toMatchObject({ attempted: 1, progressed: 0, completed: 0, failed: 0 });
    expect(await stored(id)).toMatchObject({ completion_state: "tenant_ready", completion_error: "contract_not_published" });

    published.add(slug);
    const second = await runProvisionReconcileTick();
    expect(second).toMatchObject({ attempted: 1, progressed: 1, completed: 1, failed: 0 });
    const row = await stored(id);
    expect(row).toMatchObject({ completion_state: "complete", completion_error: null });
    expect(row.contract_snapshot_id).toBeTruthy();
    expect(await pinnedEvents(id)).toBe(1);
    expect(await snapshotCount(T, slug)).toBe(1);
    const fetched = await adminPool().query(`SELECT fetched_by FROM webdev_contract_snapshots WHERE tenant_id = $1 AND webdesk_tenant_slug = $2`, [T, slug]);
    expect(fetched.rows[0].fetched_by).toBe(userId); // the row's own requested_by, not an invented identity

    // Nothing is left to do: a further tick leaves everything where it is.
    const third = await runProvisionReconcileTick();
    expect(third).toMatchObject({ attempted: 0 });
    expect(await pinnedEvents(id)).toBe(1);
  });

  it("a row at `registered` (WebDesk was down) and one the repo step finished but completion never began are both finished", async () => {
    const a = slugOf("reg");
    const b = slugOf("fresh");
    published.add(a);
    published.add(b);
    const idA = await liveSite(T, a);
    wd.failWith = new EditorialUnavailableError(30_000);
    expect((await completeProvisionedSite(T, idA, principal)).state).toBe("registered");
    wd.failWith = null;
    const idB = await liveSite(T, b);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ attempted: 2, completed: 2 });
    expect(await stored(idA)).toMatchObject({ completion_state: "complete" });
    expect(await stored(idB)).toMatchObject({ completion_state: "complete" });
    expect(wd.tenantsCreated).toBe(2);
  });

  it("a COMPLETE row is not touched", async () => {
    const slug = slugOf("done");
    published.add(slug);
    const id = await liveSite(T, slug);
    await completeProvisionedSite(T, id, principal);
    expect(await stored(id)).toMatchObject({ completion_state: "complete" });
    const before = await stored(id);
    const callsBefore = wd.calls.length;
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ planned: 0, attempted: 0 });
    expect(await stored(id)).toEqual(before);
    expect(wd.calls.length).toBe(callsBefore);
    expect(await pinnedEvents(id)).toBe(1);
  });

  it("a FAILED row is not touched, even when its contract is published and it holds a completion state", async () => {
    const slug = slugOf("failed");
    const id = await stuckAtTenantReady(T, slug);
    published.add(slug);
    await adminPool().query(`UPDATE webdev_provisioned_sites SET status = 'failed', failure_reason = 'provider_failed' WHERE id = $1`, [id]);
    const before = await stored(id);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ planned: 0, attempted: 0 });
    expect(await stored(id)).toEqual(before);
    expect(await snapshotCount(T, slug)).toBe(0);
    expect(await pinnedEvents(id)).toBe(0);
  });

  it("TWO TENANTS: one tick reaches both (each read is scoped to its own tenant)", async () => {
    const sa = slugOf("tenant-a");
    const sb = slugOf("tenant-b");
    const idA = await stuckAtTenantReady(T, sa);
    const idB = await stuckAtTenantReady(OTHER, sb);
    published.add(sa);
    published.add(sb);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ attempted: 2, completed: 2, tenantErrors: 0 });
    expect(await stored(idA)).toMatchObject({ completion_state: "complete" });
    expect(await stored(idB)).toMatchObject({ completion_state: "complete" });
    expect(await snapshotCount(T, sa)).toBe(1);
    expect(await snapshotCount(OTHER, sb)).toBe(1);
  });

  it("a tenant whose webdev module is OFF is left alone", async () => {
    const slug = slugOf("off");
    published.add(slug);
    const id = await liveSite(OFF, slug);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ attempted: 0 });
    expect(await stored(id)).toMatchObject({ completion_state: null });
    expect(wd.calls).toHaveLength(0);
  });

  it("CONCURRENCY: a tick, a manual reconcile and a second completion racing on one row pin the contract ONCE", async () => {
    const slug = slugOf("race");
    const id = await stuckAtTenantReady(T, slug);
    published.add(slug);
    const results = await Promise.all([
      runProvisionReconcileTick(),
      reconcileAndComplete({ tenantId: T, siteId: id, provider: repoReady(slug), requestedByName: "x", principal }),
      completeProvisionedSite(T, id, principal),
    ]);
    expect(results).toHaveLength(3);
    expect(await stored(id)).toMatchObject({ completion_state: "complete", completion_error: null });
    expect(await pinnedEvents(id)).toBe(1);
    expect(await snapshotCount(T, slug)).toBe(1);
    expect(wd.provisionCalls().filter((c) => (c.body as { slug: string }).slug === slug)).toHaveLength(1);
  });

  it("PENDING + APPROVED: the tick runs the repo reconcile too; a request still awaiting its decision is not chased", async () => {
    const savedOrg = config.githubOrg;
    config.githubOrg = "acme-org";
    try {
      const approvedSlug = slugOf("appr");
      const waitingSlug = slugOf("wait");
      published.add(approvedSlug);
      published.add(waitingSlug);
      const filed = async (slug: string) =>
        fileAutomationApproval({
          tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
          toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: userId,
        });
      const a = await filed(approvedSlug);
      const w = await filed(waitingSlug);
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [a.id, userId]);
      const pending = async (slug: string, ref: string) => {
        const id = newId();
        await withTenants([T], (c) => c.query(
          `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, requested_by, origin_site)
           VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'pending', $5, 'main')`,
          [id, T, ref, slug, userId],
        ), { modules: ["webdev"] });
        return id;
      };
      const idApproved = await pending(approvedSlug, a.id);
      const idWaiting = await pending(waitingSlug, w.id);
      vi.mocked(githubAppService.githubRequest).mockImplementation((async (_t: string, _app: string, _actor: string, req: { path: string }) => {
        const name = decodeURIComponent(req.path.split("/").pop() as string);
        return { data: { full_name: `acme-org/${name}`, html_url: `https://github.com/acme-org/${name}` }, status: 200 };
      }) as never);

      const r = await runProvisionReconcileTick();
      expect(r).toMatchObject({ planned: 1, attempted: 1, completed: 1 });
      expect(await stored(idApproved)).toMatchObject({ status: "live", completion_state: "complete" });
      expect(await stored(idWaiting)).toMatchObject({ status: "pending", completion_state: null });
      const asked = vi.mocked(githubAppService.githubRequest).mock.calls.map((c) => String((c[3] as { path: string }).path));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((p) => p.endsWith(approvedSlug))).toBe(true);
    } finally {
      config.githubOrg = savedOrg;
    }
  });

  it("an APPROVED request whose repo is not visible on GitHub yet is looked at, then backs off (its reconcile marks the attempt)", async () => {
    const savedOrg = config.githubOrg;
    config.githubOrg = "acme-org";
    try {
      const slug = slugOf("ghlag");
      const a = await fileAutomationApproval({
        tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
        toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: userId,
      });
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [a.id, userId]);
      const id = newId();
      await withTenants([T], (c) => c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, requested_by, origin_site)
         VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'pending', $5, 'main')`,
        [id, T, a.id, slug, userId],
      ), { modules: ["webdev"] });
      vi.mocked(githubAppService.githubRequest).mockRejectedValue(new GithubApiError("get repo", 404));

      expect(await runProvisionReconcileTick()).toMatchObject({ planned: 1, attempted: 1, progressed: 0 });
      expect(await stored(id)).toMatchObject({ status: "pending", completion_state: null });

      // Two hours after the approval, attempted a minute ago: not its turn.
      await adminPool().query(`UPDATE automation_approvals SET decided_at = now() - interval '2 hours' WHERE id = $1`, [a.id]);
      await adminPool().query(`UPDATE webdev_provisioned_sites SET updated_at = now() - interval '2 hours', last_reconciled_at = now() - interval '1 minute' WHERE id = $1`, [id]);
      const calls = vi.mocked(githubAppService.githubRequest).mock.calls.length;
      expect(await runProvisionReconcileTick()).toMatchObject({ planned: 0, attempted: 0 });
      expect(vi.mocked(githubAppService.githubRequest).mock.calls.length).toBe(calls);
    } finally {
      config.githubOrg = savedOrg;
    }
  });

  it("a repo-done row never asks GitHub (the contract pin does not need it)", async () => {
    const slug = slugOf("nogh");
    published.add(slug);
    await liveSite(T, slug);
    await runProvisionReconcileTick();
    expect(vi.mocked(githubAppService.githubRequest)).not.toHaveBeenCalled();
  });

  it("BACK-OFF: inside the wait nothing happens, once it passes the row advances, past 24 h it is left for the button", async () => {
    const slug = slugOf("backoff");
    const id = await stuckAtTenantReady(T, slug);
    published.add(slug);

    // 2 h since the last transition, last attempt 5 minutes ago: the 30-minute gap has not passed.
    await adminPool().query(
      `UPDATE webdev_provisioned_sites SET updated_at = now() - interval '2 hours', completion_updated_at = now() - interval '5 minutes' WHERE id = $1`,
      [id],
    );
    expect(await runProvisionReconcileTick()).toMatchObject({ planned: 0, attempted: 0 });
    expect(await stored(id)).toMatchObject({ completion_state: "tenant_ready" });

    // The gap passes: it advances.
    await adminPool().query(`UPDATE webdev_provisioned_sites SET completion_updated_at = now() - interval '31 minutes' WHERE id = $1`, [id]);
    expect(await runProvisionReconcileTick()).toMatchObject({ planned: 1, attempted: 1, completed: 1 });
    expect(await stored(id)).toMatchObject({ completion_state: "complete" });

    // A row whose last transition is over 24 h old is not attempted at all, however long since its last attempt.
    const slug2 = slugOf("stopped");
    const id2 = await stuckAtTenantReady(T, slug2);
    published.add(slug2);
    await adminPool().query(
      `UPDATE webdev_provisioned_sites SET updated_at = now() - interval '25 hours', completion_updated_at = now() - interval '24 hours' WHERE id = $1`,
      [id2],
    );
    expect(await runProvisionReconcileTick()).toMatchObject({ planned: 0, attempted: 0 });
    expect(await stored(id2)).toMatchObject({ completion_state: "tenant_ready" });
    expect(await snapshotCount(T, slug2)).toBe(0);
    // ...and the manual button still finishes it.
    const manual = await reconcileAndComplete({ tenantId: T, siteId: id2, provider: repoReady(slug2), requestedByName: "x", principal });
    expect(manual.completion).toMatchObject({ state: "complete" });
  });

  it("FAULT ISOLATION: an unexpected fault is recorded on its own row and the other rows still complete", async () => {
    const bad = slugOf("bad");
    const good = slugOf("good");
    const idBad = await stuckAtTenantReady(T, bad);
    const idGood = await stuckAtTenantReady(T, good);
    published.add(bad);
    published.add(good);
    exploding.add(bad);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ attempted: 2, completed: 1, failed: 1 });
    expect(await stored(idGood)).toMatchObject({ completion_state: "complete" });
    expect(await stored(idBad)).toMatchObject({ completion_state: "tenant_ready", completion_error: "completion_failed" });
  });

  it("NO ACTIVE ACTOR: a row whose requester is gone and that has no decider is skipped, never run as someone else", async () => {
    const slug = slugOf("noactor");
    const id = await stuckAtTenantReady(T, slug);
    published.add(slug);
    await adminPool().query(`UPDATE webdev_provisioned_sites SET requested_by = NULL WHERE id = $1`, [id]);
    const r = await runProvisionReconcileTick();
    expect(r).toMatchObject({ planned: 1, attempted: 0, noActor: 1 });
    expect(await stored(id)).toMatchObject({ completion_state: "tenant_ready" });
  });
});
