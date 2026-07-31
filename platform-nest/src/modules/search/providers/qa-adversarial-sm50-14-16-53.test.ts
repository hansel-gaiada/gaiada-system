// QA GATE (chained SM-14 + SM-16 + SM-50 + SM-53/SM-57) — adversarial probes not written by any
// implementer. Test-only file added by the QA gate: dispatch.ts/rank.ts/search.controller.ts product
// code is out of scope for QA edits per this round's fix policy where noted; any defect found here is
// REPORTED for the appropriate tier to route, not silently fixed in this file, UNLESS the fix is
// explicitly in-scope (providers/*, rank.ts, backlinks.ts, ai-visibility.ts).
//
// Scope: attack the SM-50 compensating-write's COVERAGE boundary (does it fire for every path that can
// spend money before failing, not just the one path its own author tested), and reproduce the known
// rank-callback double-charge (§6ah) as a durable repro for SM-56.
//
// UPDATE (SM-60): the coverage attack HIT — the post-success write boundary was uncovered, and QA's two
// probes below were written asserting the DEFECT (zero rows for a delivered charge) so the fix would have
// a target. SM-60 flipped both to assert the correct behaviour; they are now this ticket's acceptance
// evidence and its first two mutation-probe targets.
//
// UPDATE (SM-56): the third test — the rank-callback double charge — is now FLIPPED TOO, and all three
// of this file's probes have made the same round trip: written asserting a defect, then inverted by the
// ticket that closed it. The callback edge no longer re-posts, so the assertion that used to demand TWO
// `task_post` requests for one logical capture now demands ONE, plus the idempotency the fix brought
// with it. Nothing was deleted: the scenario is unchanged and only the expected OUTCOME moved, which is
// what makes the diff readable as evidence rather than as a rewrite. No known unfixed defect remains
// in this file.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { DataForSeoProvider, DFS_RATES } from "./dataforseo";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";
import * as ledger from "./ledger";
import { collectRankForTask, pullRankForKeyword } from "../rank";

async function rejection<T>(p: Promise<unknown>): Promise<T> {
  try {
    await p;
  } catch (e) {
    return e as T;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe.skipIf(!TEST_URL)("QA adversarial — SM-50 compensating-write COVERAGE boundary", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;
  let seq = 0;
  const uniqueKeyword = (label: string) => `qa50-${label}-${Date.now()}-${seq++}`;

  function dfs(opts: { taskPost: unknown; taskGet?: unknown }) {
    const requests: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.test", "");
      requests.push(path);
      // `taskGet` may be a FUNCTION of the requested path so a fixture can echo the id actually asked
      // for. SM-67 made the driver refuse a task_get whose returned id isn't the requested one, which
      // exposed that a static body answering a poll for a DIFFERENT id was never realistic.
      const rawGet = typeof opts.taskGet === "function"
        ? (opts.taskGet as (p: string) => unknown)(path)
        : opts.taskGet;
      // SM-70 (tracker §6bi Ruling 2) — `taskPost` may likewise be a FUNCTION of the POSTED request
      // body, so a fixture can echo the keyword actually requested. SM-70's canonical-mismatch
      // refusal made a static `data: { keyword: "kw" }` the same fixture lie SM-67 fixed for ids: no
      // real vendor acks keyword X for a posted Y. See ACCEPTED below.
      const postedReqs = init?.body ? (JSON.parse(String(init.body)) as Array<{ keyword?: string }>) : [];
      const rawPost = typeof opts.taskPost === "function"
        ? (opts.taskPost as (reqs: Array<{ keyword?: string }>) => unknown)(postedReqs)
        : opts.taskPost;
      const payload = path.includes("task_get") ? rawGet : rawPost;
      if (payload === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard",
      timeoutMs: 5000, pollAttempts: 2, pollIntervalMs: 1, fetchImpl, sleepImpl: async () => undefined,
    });
    return { p, requests };
  }

  /** Request-aware (SM-70, tracker §6bi Ruling 2): echoes the KEYWORD ACTUALLY POSTED at each
   *  position rather than a static "kw" — see the `dfs()` doc comment above. */
  const ACCEPTED = (ids: string[]) => (reqs: Array<{ keyword?: string }> = []) => ({
    status_code: 20000,
    tasks: ids.map((id, i) => ({ id, status_code: 20000, data: { keyword: reqs[i]?.keyword ?? "kw" } })),
  });
  const DELIVERED = (id: string) => ({
    status_code: 20000,
    tasks: [{ id, status_code: 20000, result: [{ items: [{ type: "organic", rank_absolute: 3, url: "https://qa50.example/" }] }] }],
  });

  async function makeEngagement(toolScope: Record<string, unknown>, budgetUsd = 10): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
        [id, tenant, clientId, propertyId, "QA adversarial engagement", JSON.stringify(toolScope), budgetUsd, userId],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRows(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ id: string; status: string; cost_usd: string; vendor_ref: string | null }>(
        `SELECT id, status, cost_usd, vendor_ref FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at, id`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("QA Adversarial SM50/14/16 Co", ["search"]);
    userId = await createUser("qa50@adversarial.test");
    clientId = await createClient(tenant, "QA Adversarial Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "qa50.example.com", "https://qa50.example.com"],
      ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    ledger.resetGlobalMonthToDateCache();
    ledger.resetProviderMonthToDateCache();
    vi.restoreAllMocks();
  });

  // ── THE ATTACK — FOUND OPEN BY QA, CLOSED BY SM-60 ─────────────────────────────────────────────
  // SM-50's compensating write fired ONLY when the ProviderFailedAfterSpendError envelope was caught —
  // i.e. only when the wrapped invokeProvider() call itself REJECTED after recording a charge. But the
  // critical-section callback in dispatch.ts does MORE after invokeProvider resolves successfully:
  // writeCache() then insertLedgerRow() run on the SAME connection, inside the SAME transaction, and
  // a throw from EITHER of them rolls back the whole critical section exactly like a provider
  // rejection would — except that thrown error is a plain DB error, never wrapped, so
  // runCriticalSectionWithSpendCompensation's `if (!(err instanceof ProviderFailedAfterSpendError))
  // throw err;` guard let it straight through with NO compensating write. The provider call had already
  // charged the vendor (DataForSEO's task_post, confirmed via task_get DELIVERING data — a real, billed,
  // delivered response), so the money was spent and NOTHING was recorded, not even a `posted` row: the
  // identical fail-open class SM-50 exists to close, one step later in the same function.
  //
  // ⚠️ THESE TWO TESTS WERE WRITTEN INVERTED, asserting `rows).toHaveLength(0)` — the DEFECT — so that
  // the fix would have a target. SM-60 flipped them to assert the CORRECT behaviour, and they are now
  // the repro-turned-acceptance-evidence for it (the same §A11.2 #10 move SM-50 made with §6w's pin).
  // The charge must be recorded, and the caller must still receive the ORIGINAL DB fault BY IDENTITY —
  // asserted with `toBe`, not by message, because SM-50's own P4 probe proved a message assertion still
  // matches while a wrapper leaks.
  it("SM-60: a ledger-insert failure AFTER a charged+delivered provider call records the charge (was: no row at all)", async () => {
    const { p } = dfs({ taskPost: ACCEPTED(["qa-gap-1"]), taskGet: DELIVERED("qa-gap-1") });
    registerProvider(p as unknown as Parameters<typeof registerProvider>[0]);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("gap1");

    // Only dispatch.ts's own call is intercepted: ledger.ts's recordIncurred calls its module-local
    // insertLedgerRow, so the compensating write still reaches the database. That asymmetry is what
    // makes this test a faithful model of a real post-success DB fault rather than a total outage.
    const dbFault = new Error("insert into search_provider_calls violates a constraint");
    const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(dbFault);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "serp", query: kw }, requestedBy: userId,
    }));
    // The caller receives the REAL DB fault — the same object, not a wrapper, not a money message.
    expect(err).toBe(dbFault);

    insertSpy.mockRestore();
    // THE MONEY QUESTION: the vendor was engaged (task_post accepted "qa-gap-1") and DELIVERED data
    // (task_get returned a result) before the ledger write failed. A real charge occurred — and is now
    // recorded, so every budget tier and the exec rollup can see it.
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("incurred");
    expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    expect(rows[0].vendor_ref).toBe("qa-gap-1");
  });

  it("SM-60: same via writeCache() failing instead of insertLedgerRow() — the fix is not insert-specific", async () => {
    const { p } = dfs({ taskPost: ACCEPTED(["qa-gap-2"]), taskGet: DELIVERED("qa-gap-2") });
    registerProvider(p as unknown as Parameters<typeof registerProvider>[0]);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("gap2");

    const cacheModule = await import("./cache");
    const cacheFault = new Error("search_data_cache write failed");
    const writeCacheSpy = vi.spyOn(cacheModule, "writeCache").mockRejectedValue(cacheFault);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "serp", query: kw }, requestedBy: userId,
    }));
    expect(err).toBe(cacheFault);
    writeCacheSpy.mockRestore();

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1); // same charge, different trigger inside the same critical section
    expect(rows[0].status).toBe("incurred");
    expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    expect(rows[0].vendor_ref).toBe("qa-gap-2");
  });

  // ── THE §6ah DOUBLE CHARGE — repro FLIPPED to assert the SM-56 fix ──────────────────────────────
  //
  // What this test asserted before SM-56, and why it is preserved rather than replaced: the rank-pull
  // callback route called `pullRankForKeyword` — the SAME unit a manual pull uses — rather than a free
  // fetch-by-task-id. For the DataForSEO Standard queue that means a fresh `task_post` every time the
  // "callback" fires, so a genuine vendor postback relayed through n8n was CHARGED AGAIN for data
  // already paid for once. QA wrote this asserting the DEFECT (two `task_post` requests, two
  // cost-bearing rows) so the fix would have a target — the same §A11.2 #10 move SM-50 made with §6w's
  // pin, and SM-60 made with the two tests above.
  //
  // SM-56 flipped it, and the flip is the ticket's headline acceptance evidence. The route now calls
  // `collectRankForTask`, which reaches the vendor ONLY through `fetchSerpByTaskId` (`task_get`) and is
  // idempotent by task id. Both halves are asserted below, and the FIRST assertion — the transport-layer
  // request count — is the one that actually proves the money property. A `costUsd === 0` assertion
  // would not: a driver that posted and then mispriced the op would also report $0. Only counting
  // `task_post` requests distinguishes "did not buy" from "bought and said it was free".
  //
  // The repro deliberately keeps its original SHAPE (a real pull, then a redelivery of the same vendor
  // task id) so that what changed is the OUTCOME, not the scenario.
  it("SM-56 (was: §6ah KNOWN DEFECT): a collect for an already-paid task issues ZERO task_post and never charges twice", async () => {
    // taskGet echoes whichever id is polled: this test deliberately collects TWO distinct tasks
    // ("cb-task" then the orphaned "cb-task-2"), and a body hardcoded to "cb-task" would answer the
    // second poll with the first task's identity — something no real vendor does, and which SM-67's
    // echo check now correctly refuses. Assertions below are unchanged.
    const { p, requests } = dfs({
      taskPost: ACCEPTED(["cb-task"]),
      taskGet: (path: string) => DELIVERED(path.split("?")[0].split("/").filter(Boolean).pop() ?? ""),
    });
    registerProvider(p as unknown as Parameters<typeof registerProvider>[0]);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("callback");

    // A real tracked keyword row — search_rank_snapshots FKs to it, and the real callback route
    // loads its keywordId from the DB the same way.
    const setRow = await withTenants(
      [tenant],
      (c) => c.query<{ id: string }>(
        `INSERT INTO search_keyword_sets (tenant_id, engagement_id, name) VALUES ($1,$2,'QA callback-repro set') RETURNING id`,
        [tenant, eng],
      ),
      { modules: ["search"] },
    );
    const kwRow = await withTenants(
      [tenant],
      (c) => c.query<{ id: string }>(
        `INSERT INTO search_keywords (tenant_id, set_id, keyword, locale) VALUES ($1,$2,$3,'en-US') RETURNING id`,
        [tenant, setRow.rows[0].id, kw],
      ),
      { modules: ["search"] },
    );
    const keywordId = kwRow.rows[0].id;

    // First: the genuine paid pull. This one SHOULD post — it is the purchase.
    await pullRankForKeyword({
      tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "qa50.example.com",
      keyword: { keywordId, keyword: kw, locale: null }, requestedBy: userId,
      correlationId: "cb-task",
    });
    const postsAfterPull = requests.filter((r) => r.includes("task_post")).length;
    expect(postsAfterPull).toBe(1);
    // The purchase stamped the vendor's task id on its ledger row (0053) — which is what makes the
    // collect below findable, and what the OLD code had no way to use.
    const afterPull = await ledgerRows(eng);
    expect(afterPull.filter((r) => r.status === "posted")).toHaveLength(1);
    expect(afterPull[0].vendor_ref).toBe("cb-task");

    // Second: the vendor's postback for the SAME task id — the shape `POST rank-pulls/callback`
    // exercises, now routed through the collect unit instead of the paid pull unit. This is the ORIGINAL
    // repro's exact scenario, unchanged; only the outcome moved.
    const collected = await collectRankForTask({
      tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "qa50.example.com",
      keyword: { keywordId, keyword: kw, locale: null }, taskId: "cb-task", requestedBy: userId,
    });
    // `duplicate`, and it is the STRONGEST possible outcome here rather than a weaker one: a Standard-queue
    // pull posts AND polls to completion AND persists the snapshot in one dispatch, so by the time a
    // postback for that task arrives the platform ALREADY HOLDS the data. There is genuinely nothing left
    // to collect. The old code could not tell — it had no task id to reason with — so it bought the SERP
    // again; the collect edge recognises the task by the `vendor_ref` its own purchase stamped and does
    // nothing at all. Not merely free: it never even opens a socket.
    expect(collected.status).toBe("duplicate");

    // ── THE ASSERTION THAT WAS INVERTED — the whole ticket, at the transport layer ──────────────────
    // Was `toHaveLength(2)`: two posts for one logical capture, the live double charge. Now ONE — the
    // single genuine purchase — because the postback adds no post.
    expect(requests.filter((r) => r.includes("task_post"))).toHaveLength(1);

    // Was: two `posted` rows totalling 2x the Standard rate. Now ONE cost-bearing row, one charge.
    const rows = await ledgerRows(eng);
    const costBearing = rows.filter((r) => Number(r.cost_usd) > 0);
    expect(costBearing).toHaveLength(1);
    const totalCharged = costBearing.reduce((s, r) => s + Number(r.cost_usd), 0);
    expect(totalCharged).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9); // ONE task's rate, not two

    // And ONE snapshot for one logical capture — the second half of the idempotency AC (no two
    // snapshots), which the old code also violated by writing a genuine second capture per postback.
    const snaps = await withTenants(
      [tenant],
      (c) => c.query<{ id: string }>(`SELECT id FROM search_rank_snapshots WHERE keyword_id = $1`, [keywordId]),
      { modules: ["search"] },
    );
    expect(snaps.rows).toHaveLength(1);

    // ── The other half: a task that was purchased but whose data the platform does NOT hold ─────────
    // The state a postback actually exists for (a Standard-queue poll that gave up before the crawl
    // finished). Here the collect DOES fetch — and still posts nothing, which is the property that makes
    // the collect edge worth having rather than merely harmless.
    const orphanLedgerId = await withTenants(
      [tenant],
      (c) => ledger.insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, propertyId, provider: "dataforseo",
        endpoint: "dataforseo.serp", items: 1, costUsd: DFS_RATES.serpStandardPerTask,
        cacheHit: false, status: "posted", requestedBy: userId, simulated: false, vendorRef: "cb-task-2",
      }),
      { modules: ["search"] },
    );
    const postsBefore = requests.filter((r) => r.includes("task_post")).length;
    const second = await collectRankForTask({
      tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "qa50.example.com",
      keyword: { keywordId, keyword: kw, locale: null }, taskId: "cb-task-2", requestedBy: userId,
    });
    expect(second.status).toBe("collected");
    expect(requests.filter((r) => r.includes("task_post")).length - postsBefore).toBe(0); // ZERO posts
    expect(requests.filter((r) => r.includes("task_get")).length).toBeGreaterThan(0); // it DID fetch
    // The new snapshot cites the orphaned purchase, not a new call.
    const snaps2 = await withTenants(
      [tenant],
      (c) => c.query<{ provider_call_id: string | null }>(
        `SELECT provider_call_id FROM search_rank_snapshots WHERE keyword_id = $1 ORDER BY captured_at DESC LIMIT 1`,
        [keywordId],
      ),
      { modules: ["search"] },
    );
    expect(snaps2.rows[0].provider_call_id).toBe(orphanLedgerId);

    // Idempotency on THAT one too: the vendor redelivering changes nothing further.
    const redelivered = await collectRankForTask({
      tenantId: tenant, engagementId: eng, propertyId, propertyDomain: "qa50.example.com",
      keyword: { keywordId, keyword: kw, locale: null }, taskId: "cb-task-2", requestedBy: userId,
    });
    expect(redelivered.status).toBe("duplicate");
    expect(requests.filter((r) => r.includes("task_post")).length - postsBefore).toBe(0);
  });
});
