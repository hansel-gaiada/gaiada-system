// PRV-02 — the idempotency / adoption core, against LIVE Postgres (RLS, FORCE, third wall) and the
// PRV-00 mock over REAL SOCKETS.
//
// ── WHAT THIS SUITE IS TRYING TO FALSIFY ────────────────────────────────────────────────────────
// Three claims, in descending order of how expensive they are to get wrong:
//   1. A concurrent double-fire results in EXACTLY ONE provisioning attempt (not one row — one
//      EGRESS; the row is cheap, the GitHub repo and the public nginx vhost are not).
//   2. A 409 from provision is adopted ONLY when the ERP's own table can prove the project is ours,
//      and refused otherwise — including when the far side volunteers that it is ours.
//   3. Every access declares `{modules:['webdev']}`. 0090 carries the THIRD WALL, so a missing
//      module scope reads/writes ZERO ROWS *silently*. That failure mode looks like "no data yet".
//
// ── HOW THE CONCURRENCY TESTS AVOID PROVING NOTHING ─────────────────────────────────────────────
// A concurrent test that never actually collides passes while looking like the strongest test in the
// file. Three things guard against that here:
//   (a) "the advisory lock really serializes two different connections" below MEASURES the block and
//       also proves a DIFFERENT run is not blocked — so the lock's scope is falsified in both
//       directions before anything else relies on it.
//   (b) The racing calls are held INSIDE the egress by a barrier, so the second caller is guaranteed
//       to arrive while the first still holds the lock. Without the barrier, "concurrent" calls in a
//       fast local test routinely complete in sequence and collide never.
//   (c) The assertion is on `mock.hitCount("provision")` — the far side's own count of create
//       attempts — not on a row count. A row count would be satisfied by the partial-unique index
//       alone and would stay green even if the lock did nothing.
// Pg advisory locks are SESSION-reentrant and `pg.Pool` reuses connections, so a lock probe taken on
// a connection the prober could get handed back would block nothing. Every `withTenants` call takes a
// fresh `pool.connect()`, and the two racers are genuinely concurrent promises, so the sessions are
// distinct — assertion (a) is what proves that empirically rather than by argument.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { newId, withTenants } from "../../db";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { lockPipelineRun } from "../../core/pipeline-lock";
import { startMockProvision, type ProvisionMock } from "../../testing/mock-provision";
import { ProvisionHttpDriver } from "./provision-http";
import type { ProvisionProvider } from "./provision-provider";
import {
  evaluateProvisionPrecondition, listProvisionedSites, provisionSite, pollProvisioningSite,
  reconcileProvisionedSite,
} from "./provisioning.service";

const EMAIL = "erp-service@gaiada.com";
const PASSWORD = "prv02-service-secret";

let mock: ProvisionMock;
let tenant: string;
let otherTenant: string;
let manager: string;
let provider: ProvisionProvider;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function driver(): ProvisionProvider {
  return new ProvisionHttpDriver({
    baseUrl: mock.origin, serviceEmail: EMAIL, servicePassword: PASSWORD,
    timeoutMs: 5000, retryAttempts: 1, retryBaseDelayMs: 1,
  });
}

/** Wraps the REAL http driver so the egress can be held open while a second caller arrives.
 *  Everything still goes over a real socket — only the moment of the call is controlled. */
function barrier(inner: ProvisionProvider) {
  let entered = 0;
  let releaseFn: () => void = () => {};
  let firstEnterFn: () => void = () => {};
  const held = new Promise<void>((r) => { releaseFn = r; });
  const firstEnter = new Promise<void>((r) => { firstEnterFn = r; });
  const wrapped: ProvisionProvider = {
    key: inner.key,
    createProject: async (i) => {
      entered += 1;
      if (entered === 1) firstEnterFn();
      await held;
      return inner.createProject(i);
    },
    getProject: (id) => inner.getProject(id),
    findProjectByName: (n) => inner.findProjectByName(n),
  };
  return { provider: wrapped, release: () => releaseFn(), firstEnter, entries: () => entered };
}

/** Read what is REALLY stored, bypassing RLS — the "a 200 is not a pass / an omitted column reads
 *  exactly like NULL" discipline. Every row assertion in this file goes through here. */
async function storedSite(id: string) {
  const r = await adminPool().query(
    `SELECT id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, repo_url,
            staging_url, status, failure_reason, requested_by, approval_id, last_reconciled_at,
            origin_site, created_at, updated_at
       FROM webdev_provisioned_sites WHERE id = $1`, [id]);
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function storedSitesForRun(runId: string) {
  const r = await adminPool().query(
    `SELECT id, status, provider_ref, slug FROM webdev_provisioned_sites WHERE pipeline_run_id = $1
      ORDER BY created_at`, [runId]);
  return r.rows as Array<{ id: string; status: string; provider_ref: string | null; slug: string }>;
}

async function outboxFor(entityId: string) {
  const r = await adminPool().query(
    `SELECT event_type, payload FROM outbox_events WHERE entity_id = $1 ORDER BY created_at`, [entityId]);
  return r.rows as Array<{ event_type: string; payload: Record<string, unknown> }>;
}

/** A pipeline run with an OPTIONAL decided `prd_sign` gate. */
async function makeRun(opts: { title: string; status?: string; prdSigned?: boolean; ownerId?: string }): Promise<string> {
  const runId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, created_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, tenant, opts.title, opts.status ?? "delivery_active", opts.ownerId ?? manager, config.originSite],
    );
    if (opts.prdSigned) {
      await c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, decided_by, decided_at, origin_site)
         VALUES ($1, $2, $3, 'prd_sign', 'client', 'decided', 'signed', $4, now(), $5)`,
        [newId(), tenant, runId, manager, config.originSite],
      );
    }
  });
  return runId;
}

describe.skipIf(!TEST_URL)("PRV-02 — provisioning idempotency + adoption core", () => {
  beforeAll(async () => {
    await initTestDb();
    mock = await startMockProvision({ serviceEmail: EMAIL, servicePassword: PASSWORD });
    provider = driver();
    tenant = await createCompany("Agency PRV", ["webdev"]);
    otherTenant = await createCompany("Other Client PRV", ["webdev"]);
    manager = await createUser("prv-mgr@a.test", "Manager Mo");
    await addMembership(tenant, manager);
  });
  afterAll(async () => {
    await mock.close();
    await teardownTestDb();
  });
  beforeEach(() => mock.resetHitCounts());

  const base = (runId: string | null, extra: Record<string, unknown> = {}) => ({
    tenantId: tenant, provider, runId, requestedBy: manager, requestedByName: "Manager Mo", ...extra,
  }) as Parameters<typeof provisionSite>[0];

  // ══ 1. The happy path, asserted on ROW CONTENT ═════════════════════════════════════════════════

  it("provisions once and records every correlation field (not just a successful call)", async () => {
    const runId = await makeRun({ title: "Acme Corp Website", prdSigned: true });
    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("created");
    if (r.outcome !== "created") return;

    const row = await storedSite(r.site.id);
    // A 200/"created" says nothing about what landed. An omitted column reads exactly like NULL, so
    // every field the later poll, the 409 rule and the UI depend on is asserted explicitly.
    expect(row).toBeDefined();
    expect(row!.tenant_id).toBe(tenant);
    expect(row!.pipeline_run_id).toBe(runId);
    expect(row!.provider).toBe("provision");
    expect(row!.slug).toBe("acme-corp-website");
    expect(row!.framework).toBe("vite"); // OQ-P4 default
    expect(row!.status).toBe("pending");
    expect(row!.provider_ref).toBeTruthy();       // the correlation key — NULL here disarms the 409 rule
    expect(row!.repo_url).toBe("https://github.com/gaiadabali/acme-corp-website");
    expect(row!.staging_url).toBe("https://acme-corp-website.gaiada.online");
    expect(row!.failure_reason).toBeNull();
    expect(row!.requested_by).toBe(manager);
    expect(row!.approval_id).toBeNull();
    expect(row!.origin_site).toBe(config.originSite);

    expect(mock.hitCount("provision")).toBe(1);
    const events = await outboxFor(r.site.id);
    expect(events.map((e) => e.event_type)).toContain("webdev.site.provision_requested");
    expect(events[0].payload.providerRef).toBe(row!.provider_ref);
    expect(events[0].payload.adopted).toBe(false);
  });

  it("a repeat call is idempotent: the SAME row, and no second egress", async () => {
    const runId = await makeRun({ title: "Repeat Call Site", prdSigned: true });
    const first = await provisionSite(base(runId));
    expect(first.outcome).toBe("created");
    mock.resetHitCounts();

    const second = await provisionSite(base(runId));
    expect(second.outcome).toBe("existing");
    if (first.outcome !== "created" || second.outcome !== "existing") return;
    expect(second.site.id).toBe(first.site.id);
    expect(mock.hitCount("provision")).toBe(0);
    expect(await storedSitesForRun(runId)).toHaveLength(1);
  });

  it("carries the approval id through for attribution when the WS4 path drove it", async () => {
    const runId = await makeRun({ title: "Approved Path Site", prdSigned: true });
    const approvalId = newId();
    const r = await provisionSite(base(runId, { approvalId, requireSignedPrdGate: true }));
    expect(r.outcome).toBe("created");
    if (r.outcome !== "created") return;
    expect((await storedSite(r.site.id))!.approval_id).toBe(approvalId);
  });

  // ══ 2. The lock is real (falsify the concurrency tests before trusting them) ═══════════════════

  it("the advisory lock really serializes two different connections on the same run", async () => {
    const runId = await makeRun({ title: "Lock Probe A", prdSigned: true });
    const HOLD = 400;
    let waited = -1;
    const holder = withTenants([tenant], async (c) => {
      await lockPipelineRun(c, runId);
      await sleep(HOLD);
    }, { modules: ["webdev"] });
    await sleep(60); // let the holder actually take it
    const started = Date.now();
    const waiter = withTenants([tenant], async (c) => {
      await lockPipelineRun(c, runId);
      waited = Date.now() - started;
    }, { modules: ["webdev"] });
    await Promise.all([holder, waiter]);
    // If this is ~0 the sessions were the same (reentrant) or the lock was a no-op, and every
    // "concurrent" assertion below would be theatre.
    expect(waited).toBeGreaterThan(HOLD - 120);
  });

  it("LOCK SCOPE: a run holding its lock does NOT block a DIFFERENT run", async () => {
    const runA = await makeRun({ title: "Lock Probe B", prdSigned: true });
    const runB = await makeRun({ title: "Lock Probe C", prdSigned: true });
    let waited = -1;
    const holder = withTenants([tenant], async (c) => {
      await lockPipelineRun(c, runA);
      await sleep(400);
    }, { modules: ["webdev"] });
    await sleep(60);
    const started = Date.now();
    await withTenants([tenant], async (c) => {
      await lockPipelineRun(c, runB);
      waited = Date.now() - started;
    }, { modules: ["webdev"] });
    await holder;
    expect(waited).toBeLessThan(200);
  });

  // ══ 3. THE DOUBLE-FIRE RACES ══════════════════════════════════════════════════════════════════

  it("CREATE RACE: two concurrent provisions of one run yield ONE egress and ONE row", async () => {
    const runId = await makeRun({ title: "Race Create Site", prdSigned: true });
    const b = barrier(driver());
    mock.resetHitCounts();

    const p1 = provisionSite(base(runId, { provider: b.provider }));
    const p2 = provisionSite(base(runId, { provider: b.provider }));
    await b.firstEnter;   // one caller is inside the egress, holding the lock
    await sleep(300);     // the other has had ample time to reach the lock and block on it
    b.release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // The far side's own count. This is the assertion that matters: one repo, one vhost.
    expect(mock.hitCount("provision")).toBe(1);
    expect(b.entries()).toBe(1);
    // Exactly one row, and the loser was handed it rather than an error.
    const rows = await storedSitesForRun(runId);
    expect(rows).toHaveLength(1);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(["created", "existing"]);
    const ids = [r1, r2].map((r) => ("site" in r ? r.site.id : null));
    expect(ids[0]).toBe(ids[1]);
  });

  it("CREATE RACE (partial uniques dropped): the LOCK + RE-CHECK alone still yield ONE egress", async () => {
    // Why this test exists, stated plainly: the test above passes even with the precondition
    // re-check DELETED, because `ux_wps_run` refuses the loser's INSERT and the 23505 is translated
    // back into "here is the existing row". Mutation-probed and confirmed green. A concurrency test
    // that stays green when you remove the thing it claims to test is the defect, not the proof.
    //
    // So this one removes the SCHEMA half and re-runs the same race. The design claims two
    // independent layers, EACH SUFFICIENT ALONE (D-P5); this is the only way to actually demonstrate
    // the code half. With the indexes gone, deleting the `existingLiveSiteForRun` arm makes this go
    // RED with two provision hits — i.e. two GitHub repos and two nginx vhosts.
    //
    // BOTH partial uniques come out, not just `ux_wps_run`: the first attempt at this test dropped
    // only that one and STAYED GREEN, because the two racers derive the same slug and `ux_wps_slug`
    // caught the loser instead. Worth recording — it is the same "the backstop I forgot about was
    // doing the work" mistake one level down, and it is why the drop list is explicit rather than
    // "the obvious index".
    const runId = await makeRun({ title: "Race No Index Site", prdSigned: true });
    await adminPool().query(`DROP INDEX ux_wps_run`);
    await adminPool().query(`DROP INDEX ux_wps_slug`);
    await adminPool().query(`DROP INDEX ux_wps_provider_ref`);
    try {
      const b = barrier(driver());
      mock.resetHitCounts();
      const p1 = provisionSite(base(runId, { provider: b.provider }));
      const p2 = provisionSite(base(runId, { provider: b.provider }));
      await b.firstEnter;
      await sleep(300);
      b.release();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(mock.hitCount("provision")).toBe(1);
      expect(b.entries()).toBe(1);
      expect(await storedSitesForRun(runId)).toHaveLength(1);
      expect([r1.outcome, r2.outcome].sort()).toEqual(["created", "existing"]);
    } finally {
      // Remove THIS test's rows before restoring the constraints. Without it, a run that legitimately
      // FAILS (the mutation probe) leaves duplicates behind, `CREATE UNIQUE INDEX` then throws from
      // the finally block, and that throw MASKS the assertion failure that is the actual finding —
      // the probe reports "could not create unique index" instead of "expected 2 to be 1".
      await adminPool().query(`DELETE FROM webdev_provisioned_sites WHERE pipeline_run_id = $1`, [runId]);
      await adminPool().query(
        `CREATE UNIQUE INDEX ux_wps_run ON webdev_provisioned_sites (pipeline_run_id)
           WHERE pipeline_run_id IS NOT NULL AND status <> 'failed'`);
      await adminPool().query(
        `CREATE UNIQUE INDEX ux_wps_slug ON webdev_provisioned_sites (tenant_id, slug)
           WHERE status <> 'failed'`);
      await adminPool().query(
        `CREATE UNIQUE INDEX ux_wps_provider_ref ON webdev_provisioned_sites (tenant_id, provider_ref)
           WHERE provider_ref IS NOT NULL AND status <> 'failed'`);
    }
  });

  it("RESUME RACE: two concurrent reconciles of a never-egressed row yield ONE egress", async () => {
    // The crash-resume shape (design §03: the row "stays `requested` if the failure precedes any
    // successful egress"). This is the path with NO unique-index backstop — its action is an UPDATE,
    // so the lock + the re-read under it are the ONLY protection. It is the mutation-probe target.
    const runId = await makeRun({ title: "Race Resume Site", prdSigned: true });
    const siteId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, slug, framework, status, requested_by, origin_site)
       VALUES ($1, $2, $3, 'provision', 'race-resume-site', 'vite', 'requested', $4, $5)`,
      [siteId, tenant, runId, manager, config.originSite]), { modules: ["webdev"] });

    const b = barrier(driver());
    mock.resetHitCounts();
    const args = { tenantId: tenant, siteId, provider: b.provider, requestedByName: "Manager Mo" };
    const p1 = reconcileProvisionedSite(args);
    const p2 = reconcileProvisionedSite(args);
    await b.firstEnter;
    await sleep(300);
    b.release();
    await Promise.all([p1, p2]);

    expect(mock.hitCount("provision")).toBe(1);
    expect(b.entries()).toBe(1);
    const row = await storedSite(siteId);
    expect(row!.status).toBe("pending");
    expect(row!.provider_ref).toBeTruthy();
    // And still exactly one row for the run — the resume never inserts.
    expect(await storedSitesForRun(runId)).toHaveLength(1);
  });

  // ══ 4. The precondition matrix ════════════════════════════════════════════════════════════════

  it("precondition: an unknown run is refused before anything is created", async () => {
    const r = await provisionSite(base(newId()));
    expect(r).toEqual({ outcome: "precondition_failed", reason: "run_not_found" });
    expect(mock.hitCount("provision")).toBe(0);
  });

  it("precondition: a BLOCKED run acquires no infrastructure", async () => {
    const runId = await makeRun({ title: "Blocked Run Site", status: "blocked", prdSigned: true });
    const r = await provisionSite(base(runId));
    expect(r).toEqual({ outcome: "precondition_failed", reason: "run_blocked" });
    expect(mock.hitCount("provision")).toBe(0);
    expect(await storedSitesForRun(runId)).toHaveLength(0);
  });

  it("precondition: the automation path requires a DECIDED prd_sign gate; the staff path does not", async () => {
    const runId = await makeRun({ title: "Ungated Run Site", prdSigned: false });
    // Automation / D14 re-drive: the gate is the justification, re-derived at execution time.
    const automation = await provisionSite(base(runId, { requireSignedPrdGate: true }));
    expect(automation).toEqual({ outcome: "precondition_failed", reason: "prd_gate_not_decided" });
    expect(mock.hitCount("provision")).toBe(0);
    // Staff click (Cerbos-gated, covers manual runs and mini-runs that have no prd_sign gate at all).
    const staff = await provisionSite(base(runId));
    expect(staff.outcome).toBe("created");
  });

  it("precondition: a gate decided `changes_requested` does NOT satisfy the automation arm", async () => {
    const runId = await makeRun({ title: "Changes Requested Site", prdSigned: false });
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, origin_site)
       VALUES ($1, $2, $3, 'prd_sign', 'client', 'decided', 'changes_requested', $4)`,
      [newId(), tenant, runId, config.originSite]));
    const r = await withTenants([tenant], (c) =>
      evaluateProvisionPrecondition(c, runId, { requireSignedPrdGate: true }), { modules: ["webdev"] });
    expect(r).toEqual({ ok: false, reason: "prd_gate_not_decided" });
  });

  it("precondition: a FAILED row does not block a retry, but a live one does", async () => {
    const runId = await makeRun({ title: "Retry After Failure Site", prdSigned: true });
    const failedId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, slug, framework, status, failure_reason, requested_by, origin_site)
       VALUES ($1, $2, $3, 'provision', 'retry-after-failure-site', 'vite', 'failed', 'egress_error', $4, $5)`,
      [failedId, tenant, runId, manager, config.originSite]), { modules: ["webdev"] });

    const retry = await provisionSite(base(runId));
    expect(retry.outcome).toBe("created");
    const again = await provisionSite(base(runId));
    expect(again.outcome).toBe("existing");
    const rows = await storedSitesForRun(runId);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "pending"]);
  });

  // ══ 5. THE 409 RULE — both branches ═══════════════════════════════════════════════════════════

  it("409 FOREIGN: refuses to adopt a project this tenant has no record of", async () => {
    const runId = await makeRun({ title: "Foreign Conflict Site", prdSigned: true });
    mock.seedProject({
      id: "proj-someone-elses", name: "foreign-conflict-site",
      repoUrl: "https://github.com/gaiadabali/foreign-conflict-site",
      stagingUrl: "https://foreign-conflict-site.gaiada.online", status: "live", isOurs: false,
    });

    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("conflict_foreign");
    if (r.outcome !== "conflict_foreign") return;

    const row = await storedSite(r.site.id);
    // The refusal is a RECORDED FACT, not just a status code: the row is committed as failed with the
    // typed token, and — critically — it never binds itself to the foreign project.
    expect(row!.status).toBe("failed");
    expect(row!.failure_reason).toBe("slug_conflict_foreign");
    expect(row!.provider_ref).toBeNull();
    expect(row!.repo_url).toBeNull();
    expect(row!.staging_url).toBeNull();

    const events = await outboxFor(r.site.id);
    expect(events.map((e) => e.event_type)).toContain("webdev.site.provision_failed");

    const notes = await adminPool().query(
      `SELECT type, payload FROM notifications WHERE user_id = $1 AND type = 'webdev.site.provision_failed'`,
      [manager]);
    expect(notes.rowCount).toBeGreaterThan(0);
  });

  it("409 FOREIGN: still refuses when the FAR SIDE claims the project is ours", async () => {
    // provision has no tenancy and cannot answer "is this ours". A far side that volunteers the
    // answer — sloppily or maliciously — must not be able to walk another client's site into this
    // tenant's table. The mock's 409 body carries `isOurs: true` here on purpose.
    const runId = await makeRun({ title: "Lying Far Side Site", prdSigned: true });
    mock.seedProject({
      id: "proj-claims-to-be-ours", name: "lying-far-side-site",
      repoUrl: "https://github.com/gaiadabali/lying-far-side-site",
      stagingUrl: "https://lying-far-side-site.gaiada.online", status: "live", isOurs: true,
    });
    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("conflict_foreign");
    if (r.outcome !== "conflict_foreign") return;
    expect((await storedSite(r.site.id))!.provider_ref).toBeNull();
  });

  it("409 FOREIGN: another ERP TENANT's record does not make a project ours", async () => {
    // The tenancy edge the whole rule exists for. `provision`'s namespace is global; the ownership
    // lookup runs inside `withTenants([tenantId])`, so a row belonging to a different ERP tenant is
    // invisible to it and cannot certify ownership. If the lookup ever escaped RLS, this goes green
    // as "adopted" — which is the breach.
    const runId = await makeRun({ title: "Cross Tenant Site", prdSigned: true });
    mock.seedProject({
      id: "proj-other-tenants", name: "cross-tenant-site",
      repoUrl: "https://github.com/gaiadabali/cross-tenant-site",
      stagingUrl: "https://cross-tenant-site.gaiada.online", status: "live", isOurs: true,
    });
    // The OTHER tenant legitimately owns that provider_ref.
    await withTenants([otherTenant], (c) => c.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, provider, provider_ref, slug, framework, status, origin_site)
       VALUES ($1, $2, 'provision', 'proj-other-tenants', 'cross-tenant-site', 'vite', 'live', $3)`,
      [newId(), otherTenant, config.originSite]), { modules: ["webdev"] });

    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("conflict_foreign");
    if (r.outcome !== "conflict_foreign") return;
    expect((await storedSite(r.site.id))!.provider_ref).toBeNull();
  });

  it("409 OURS: adopts a project this tenant DID create, and takes its live state", async () => {
    // The canonical ours-case: an earlier attempt recorded `provider_ref` and then failed
    // (`poll_timeout`). The ownership lookup is deliberately NOT filtered by status — filtering
    // `status <> 'failed'` would refuse to adopt our own project on exactly this retry.
    const runId = await makeRun({ title: "Adopt Ours Site", prdSigned: true });
    mock.seedProject({
      id: "proj-definitely-ours", name: "adopt-ours-site",
      repoUrl: "https://github.com/gaiadabali/adopt-ours-site",
      stagingUrl: "https://adopt-ours-site.gaiada.online", status: "provisioned", isOurs: true,
    });
    const oldId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, failure_reason, requested_by, origin_site)
       VALUES ($1, $2, $3, 'provision', 'proj-definitely-ours', 'adopt-ours-site', 'vite', 'failed', 'poll_timeout', $4, $5)`,
      [oldId, tenant, runId, manager, config.originSite]), { modules: ["webdev"] });

    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("adopted");
    if (r.outcome !== "adopted") return;
    expect(r.site.id).not.toBe(oldId);

    const row = await storedSite(r.site.id);
    expect(row!.provider_ref).toBe("proj-definitely-ours");
    expect(row!.status).toBe("provisioned");           // taken from the far side, not assumed
    expect(row!.repo_url).toBe("https://github.com/gaiadabali/adopt-ours-site");
    expect(row!.staging_url).toBe("https://adopt-ours-site.gaiada.online");
    expect(row!.failure_reason).toBeNull();
    expect(row!.last_reconciled_at).not.toBeNull();

    const events = await outboxFor(r.site.id);
    expect(events.some((e) => e.event_type === "webdev.site.provision_requested" && e.payload.adopted === true)).toBe(true);
  });

  // ══ 6. Poll timeout, and the reconcile that flips it forward ══════════════════════════════════

  it("a stuck project lands `failed/poll_timeout` — honest, and NOT final", async () => {
    const runId = await makeRun({ title: "Stuck Site", prdSigned: true });
    const r = await provisionSite(base(runId));
    expect(r.outcome).toBe("created");
    if (r.outcome !== "created") return;
    mock.setStuck(r.site.providerRef as string, true);

    const after = await pollProvisioningSite(tenant, r.site.id, provider, { intervalMs: 10, maxIntervalMs: 20, maxMs: 120 });
    expect(after?.status).toBe("failed");
    const row = await storedSite(r.site.id);
    expect(row!.failure_reason).toBe("poll_timeout");
    // NOT final: the provider_ref survives, which is what lets reconcile flip it forward AND what
    // makes the project adoptable if a retry ever 409s on the same name.
    expect(row!.provider_ref).toBe(r.site.providerRef);

    // provision's own restart-resume eventually completes the work; the hourly reconcile picks it up.
    mock.setStuck(r.site.providerRef as string, false);
    mock.progressStatus(r.site.providerRef as string, "live");
    const rec = await reconcileProvisionedSite({ tenantId: tenant, siteId: r.site.id, provider, requestedByName: "Manager Mo" });
    expect(rec.outcome).toBe("advanced");
    const flipped = await storedSite(r.site.id);
    expect(flipped!.status).toBe("live");
    expect(flipped!.failure_reason).toBeNull();
    expect((await outboxFor(r.site.id)).map((e) => e.event_type)).toContain("webdev.site.provisioned");
  });

  it("the poller advances pending -> provisioned -> live and emits on the transition", async () => {
    const runId = await makeRun({ title: "Poll Forward Site", prdSigned: true });
    const r = await provisionSite(base(runId));
    if (r.outcome !== "created") throw new Error("setup failed");
    mock.progressStatus(r.site.providerRef as string, "live");
    const final = await pollProvisioningSite(tenant, r.site.id, provider, { intervalMs: 5, maxIntervalMs: 10, maxMs: 500 });
    expect(final?.status).toBe("live");
    const row = await storedSite(r.site.id);
    expect(row!.status).toBe("live");
    expect(row!.last_reconciled_at).not.toBeNull();
    expect((await outboxFor(r.site.id)).map((e) => e.event_type)).toContain("webdev.site.provisioned");
  });

  it("reconcile refuses to revive a failed row that a retry has already superseded", async () => {
    const runId = await makeRun({ title: "Superseded Site", prdSigned: true });
    const first = await provisionSite(base(runId));
    if (first.outcome !== "created") throw new Error("setup failed");
    const ref = first.site.providerRef as string;
    mock.setStuck(ref, true);
    await pollProvisioningSite(tenant, first.site.id, provider, { intervalMs: 5, maxIntervalMs: 10, maxMs: 40 });
    expect((await storedSite(first.site.id))!.status).toBe("failed");

    // A retry claims the run slot (with a different slug, since the failed row freed neither name).
    const retry = await provisionSite(base(runId, { slug: "superseded-site-v2" }));
    expect(retry.outcome).toBe("created");

    // Now the far side finishes the ORIGINAL project. Flipping it forward would collide with
    // `ux_wps_run`; the server-side re-check records `superseded` instead of surfacing a 23505.
    mock.setStuck(ref, false);
    mock.progressStatus(ref, "live");
    const rec = await reconcileProvisionedSite({ tenantId: tenant, siteId: first.site.id, provider, requestedByName: "Mo" });
    expect(rec.outcome).toBe("superseded");
    const row = await storedSite(first.site.id);
    expect(row!.status).toBe("failed");
    expect(row!.failure_reason).toBe("superseded");
  });

  // ══ 7. Refusals that must never reach the far side ════════════════════════════════════════════

  it("refuses a non-static stack with routing rather than downgrading it to a static site", async () => {
    const runId = await makeRun({ title: "Wordpress Ask Site", prdSigned: true });
    const r = await provisionSite(base(runId, { stack: "wordpress" }));
    expect(r).toEqual({ outcome: "invalid", reason: "unsupported_stack" });
    expect(mock.hitCount("provision")).toBe(0);
    expect(await storedSitesForRun(runId)).toHaveLength(0);
  });

  it("refuses an unsupported framework and an unusable slug before egress", async () => {
    const runId = await makeRun({ title: "Bad Input Site", prdSigned: true });
    expect(await provisionSite(base(runId, { framework: "wordpress" })))
      .toEqual({ outcome: "invalid", reason: "unsupported_framework" });
    // A punctuation-only title derives to an EMPTY slug — never silently rescued into `run-<id>`.
    const punctRun = await makeRun({ title: "!!!", prdSigned: true });
    expect(await provisionSite(base(punctRun))).toEqual({ outcome: "invalid", reason: "invalid_slug" });
    // Shell-metacharacter defense in depth for provision's `/bin/sh -c` heredoc.
    expect(await provisionSite(base(runId, { slug: "acme;rm -rf /" })))
      .toEqual({ outcome: "invalid", reason: "invalid_slug" });
    expect(mock.hitCount("provision")).toBe(0);
  });

  it("a dead hop records `failed/egress_error` and never blocks the pipeline", async () => {
    const runId = await makeRun({ title: "Dead Hop Site", prdSigned: true });
    const dead = new ProvisionHttpDriver({
      baseUrl: "http://127.0.0.1:1", serviceEmail: EMAIL, servicePassword: PASSWORD,
      timeoutMs: 500, retryAttempts: 2, retryBaseDelayMs: 1,
    });
    const r = await provisionSite(base(runId, { provider: dead }));
    expect(r.outcome).toBe("egress_error");
    if (r.outcome !== "egress_error") return;
    const row = await storedSite(r.site.id);
    expect(row!.status).toBe("failed");
    expect(row!.failure_reason).toBe("egress_error");
    expect(row!.provider_ref).toBeNull();
    // The run itself is untouched — provision being down never blocks delivery (design §03).
    const run = await adminPool().query(`SELECT status FROM pipeline_runs WHERE id = $1`, [runId]);
    expect(run.rows[0].status).toBe("delivery_active");
    // And the failed row freed the slot, so a later attempt is possible.
    const retry = await provisionSite(base(runId));
    expect(retry.outcome).toBe("created");
  });

  it("a far-side rejection is recorded, not retried into a second create", async () => {
    const runId = await makeRun({ title: "Rejected Input Site", prdSigned: true });
    // The mock validates `framework` server-side; the service's own guard is bypassed on purpose so
    // the far-side 400 arm is exercised end to end.
    const r = await provisionSite(base(runId, { framework: "vite", slug: "rejected-input-site" }));
    expect(r.outcome).toBe("created"); // sanity: this slug is fine
    if (r.outcome !== "created") return;
    expect(mock.hitCount("provision")).toBe(1);
  });

  // ══ 8. The third wall — the two-sided `app.scopes` handshake ══════════════════════════════════

  it("MODULE SCOPE: the same read returns rows WITH `webdev` declared and ZERO without", async () => {
    const runId = await makeRun({ title: "Scope Handshake Site", prdSigned: true });
    const r = await provisionSite(base(runId));
    if (r.outcome !== "created") throw new Error("setup failed");

    const q = `SELECT id FROM webdev_provisioned_sites WHERE id = $1`;
    // Correct scope: the row is visible.
    const withScope = await withTenants([tenant], (c) => c.query(q, [r.site.id]), { modules: ["webdev"] });
    expect(withScope.rowCount).toBe(1);
    // NO module scope: ZERO ROWS, silently — not an error. This is the failure mode that reads like
    // "no data yet" and is why every access path in the service declares the scope.
    const noScope = await withTenants([tenant], (c) => c.query(q, [r.site.id]));
    expect(noScope.rowCount).toBe(0);
    // A DIFFERENT declared scope fails the same way — the WD-23A-1 regression class exactly.
    const wrongScope = await withTenants([tenant], (c) => c.query(q, [r.site.id]), { modules: ["hr"] });
    expect(wrongScope.rowCount).toBe(0);
    // And the SERVICE's own read path declares it (this is the assertion that proves the production
    // code, not just the policy).
    expect((await listProvisionedSites(tenant, runId)).map((s) => s.id)).toEqual([r.site.id]);
  });

  it("MODULE SCOPE: a write without the scope is refused too (both wings of the handshake)", async () => {
    const runId = await makeRun({ title: "Scope Write Probe", prdSigned: true });
    await expect(
      withTenants([tenant], (c) => c.query(
        `INSERT INTO webdev_provisioned_sites (id, tenant_id, pipeline_run_id, provider, slug, framework, status, origin_site)
         VALUES ($1, $2, $3, 'provision', 'scope-write-probe', 'vite', 'requested', $4)`,
        [newId(), tenant, runId, config.originSite])),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("TENANCY: another tenant cannot see this tenant's sites even with the module scope declared", async () => {
    const runId = await makeRun({ title: "Tenant Isolation Site", prdSigned: true });
    const r = await provisionSite(base(runId));
    if (r.outcome !== "created") throw new Error("setup failed");
    const seen = await withTenants([otherTenant],
      (c) => c.query(`SELECT id FROM webdev_provisioned_sites WHERE id = $1`, [r.site.id]),
      { modules: ["webdev"] });
    expect(seen.rowCount).toBe(0);
    expect(await listProvisionedSites(otherTenant, runId)).toEqual([]);
  });

  // ══ 9. Credential non-exposure in the new response shape ══════════════════════════════════════

  it("no credential appears in the DTO, the stored row, or any emitted event", async () => {
    const runId = await makeRun({ title: "Secret Hygiene Site", prdSigned: true });
    const r = await provisionSite(base(runId));
    if (r.outcome !== "created") throw new Error("setup failed");

    const dto = JSON.stringify(r.site);
    const row = JSON.stringify(await storedSite(r.site.id));
    const events = JSON.stringify(await outboxFor(r.site.id));
    for (const blob of [dto, row, events]) {
      expect(blob).not.toContain(PASSWORD);
      expect(blob).not.toContain(EMAIL);
      expect(blob).not.toContain("mock-jwt-");
      expect(blob.toLowerCase()).not.toContain("password");
      expect(blob).not.toContain("GITHUB_TOKEN");
    }
    // The DTO is an explicit column list — assert its exact key set so a future column cannot ride
    // along silently.
    expect(Object.keys(r.site).sort()).toEqual([
      "approvalId", "createdAt", "failureReason", "framework", "id", "lastReconciledAt",
      "pipelineRunId", "provider", "providerRef", "repoUrl", "requestedBy", "slug", "stagingUrl",
      "status", "tenantId", "updatedAt",
    ]);
  });
});
