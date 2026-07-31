// SM-50 — incurred-cost ledger rows: the money-path proofs for "the vendor was charged and delivered
// no data" (design addendum §A11, binding; tracker §6x.2; the defect itself is recorded in §6w).
//
// The eight ACs from §6x.2, and where each is discharged in this file:
//   1. DFS Standard poll-exhaustion e2e -> exactly ONE incurred row at accepted-tasks x published
//      rate, carrying vendor_ref, `simulated` stamped from the dispatch value, and NO cache row.
//   2. Failure BEFORE any billable point -> byte-for-byte today (rollback, no row). The NEGATIVE
//      CONTROL, and the reason this ticket is a widening rather than a redefinition.
//   3. THE HEADLINE (§4d): a loop of N incurred failures accrues N x rate into month-to-date and the
//      N+1-th dispatch is REFUSED on a budget tier. Deposit burn is now visible to the stop-loss.
//   4. Mixed task_post accept/reject -> only ACCEPTED (billed) tasks are recorded.
//   5. recordIncurred secondary failure -> the provider error still propagates (the §4d guarded
//      -recordBlocked template).
//   6. §6w's sandbox pin flipped -> lives in dataforseo.sandbox.test.ts (that file owns the
//      real-sockets rehearsal); this file's DB-level equivalent is AC 1 above.
//   7. Event lands with an href + the callback-path interlock (no re-post, no second cost-bearing row).
//   8. Mutation probes -> recorded in the block comment at the end of this file.
//
// SM-60 (tracker §6ak) extends this file rather than starting a new one, because it closes the SAME
// fail-open one step later in the same function: SM-50 compensated only when the PROVIDER CALL rejected,
// so a call that was charged AND DELIVERED and then lost its ledger row to a plain DB fault (writeCache /
// insertLedgerRow / the true-up / the COMMIT, all inside the same rolled-back transaction) recorded
// nothing at all. Its tests are the `SM60-*` block near the end of the live-Postgres describe, plus three
// unit tests on the amount now leaving the capture scope on the SUCCESS path. The externally-written
// repro it flips lives in qa-adversarial-sm50-14-16-53.test.ts.
//
// These run against LIVE Postgres for the same reason dispatch.test.ts does: the properties under test
// are DB properties. The compensating write's whole point is that it survives a ROLLBACK, which cannot
// be demonstrated against a mock — a fake would "survive" trivially and prove nothing.
//
// The driver is the REAL DataForSeoProvider with an injected `fetchImpl` (SM-05's harness), not a mock
// provider, because the billing point being tested is DataForSEO's own: task_post is charged at post.
// A hand-rolled provider that called recordIncurredCostUsd would test my test, not the driver.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, createClient } from "../../../testing/fixtures";
import { DataForSeoProvider, DFS_RATES } from "./dataforseo";
import { MockSearchProvider } from "./mock-provider";
import { registerProvider, resetProviders } from "./registry";
import { dispatchProviderOp } from "./dispatch";
import * as ledger from "./ledger";
// SM-60: namespace import so writeCache can be failed in isolation — dispatch.ts calls it through the
// module object once SWC transpiles the ESM import, the same mechanism the ledger spies above use.
import * as cache from "./cache";
import {
  advanceIncurredToCompleted,
  findIncurredByVendorRef,
  findLedgerRowByVendorRef,
  insertLedgerRow,
  resetGlobalMonthToDateCache,
  resetProviderMonthToDateCache,
  sumGlobalMonthToDate,
  sumMonthToDate,
  sumProviderMonthToDate,
  trueUpLedger,
} from "./ledger";
import {
  BudgetExceededError,
  ProviderFailedAfterSpendError,
  recordActualCostUsd,
  recordIncurredCostUsd,
  takeCapturedActualCostUsd,
  withActualCostCapture,
  type SearchDataProvider,
} from "./types";
// Namespace import so the incurred-cost event emit can be failed in isolation with a spy (dispatch.ts
// calls through the module object once SWC transpiles the ESM import — the same mechanism
// dispatch.test.ts uses for the global-ceiling failure path).
import * as outbox from "../../../events/outbox.service";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PURE UNITS — the two-channel ALS store and the failure boundary (no DB)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Minimal provider stand-in: only `takeActualCostUsd`'s presence/absence matters to the wrapper. */
function stubProvider(takeActual?: () => number | undefined): SearchDataProvider {
  return { takeActualCostUsd: takeActual } as unknown as SearchDataProvider;
}

/** Await a promise that MUST reject, returning the rejection value typed. Fails loudly if it resolves —
 *  a "rejection" test that silently passed on a resolve would be exactly the kind of test that tests
 *  nothing, which this module's gates have caught more than once. */
async function rejection<T>(p: Promise<unknown>): Promise<T> {
  try {
    await p;
  } catch (e) {
    return e as T;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

describe("SM-50 withActualCostCapture — the failure boundary (addendum §A11.1.3)", () => {
  it("a rejection with NOTHING recorded rethrows the ORIGINAL error object, untouched", async () => {
    // The negative control at the unit level, and asserted by IDENTITY (`toBe`), not by message: this
    // is the property that keeps every pre-SM-50 failure path byte-for-byte unchanged. A failure before
    // the vendor was engaged must roll back and write no row, exactly as before.
    const original = new Error("connect ECONNREFUSED");
    const err = await rejection<Error>(withActualCostCapture(stubProvider(), async () => {
      throw original;
    }));
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(ProviderFailedAfterSpendError);
  });

  it("a rejection AFTER a recorded charge wraps it, carrying the cause, the amount and the vendor refs", async () => {
    const original = new Error("dataforseo serp task t-1 still queued after 3 polls");
    const err = await rejection<ProviderFailedAfterSpendError>(withActualCostCapture(stubProvider(), async () => {
      recordIncurredCostUsd(0.0006, "t-1");
      recordIncurredCostUsd(0.0006, "t-2");
      throw original;
    }));
    expect(err).toBeInstanceOf(ProviderFailedAfterSpendError);
    const wrapped = err as ProviderFailedAfterSpendError;
    // The cause is preserved by IDENTITY so dispatch can rethrow the caller's own typed error.
    expect(wrapped.cause).toBe(original);
    expect(wrapped.incurredUsd).toBeCloseTo(0.0012, 9);
    expect(wrapped.vendorRefs).toEqual(["t-1", "t-2"]);
    // The envelope names the original failure too, so a log line is not mysterious.
    expect(wrapped.message).toContain("still queued after 3 polls");
  });

  it("is ADDITIVE, never last-write-wins — one op fanning out into several billable calls sums them", async () => {
    const err = await rejection<ProviderFailedAfterSpendError>(withActualCostCapture(stubProvider(), async () => {
      await Promise.all([
        (async () => recordIncurredCostUsd(0.002, "a"))(),
        (async () => recordIncurredCostUsd(0.003, "b"))(),
      ]);
      throw new Error("boom");
    }));
    expect(err.incurredUsd).toBeCloseTo(0.005, 9);
    expect([...err.vendorRefs].sort()).toEqual(["a", "b"]);
  });

  it("a recorded charge of exactly $0 does NOT wrap — a $0 money row is the degenerate-input class (§A9.5)", async () => {
    const original = new Error("nothing billable happened");
    const err = await rejection<Error>(withActualCostCapture(stubProvider(), async () => {
      recordIncurredCostUsd(0);
      throw original;
    }));
    expect(err).toBe(original);
  });

  it("recordActualCostUsd IMPLIES incurred — SM-42's channel feeds SM-50's with no second call site", async () => {
    // §A11.1.3: "a vendor-confirmed ACTUAL charge is by definition an INCURRED charge". This is why
    // ahrefs.ts needed no edit for this ticket: its existing capture already reports liability.
    const err = await rejection<ProviderFailedAfterSpendError>(withActualCostCapture(stubProvider(), async () => {
      recordActualCostUsd(0.25);
      throw new Error("second parallel call failed");
    }));
    expect(err).toBeInstanceOf(ProviderFailedAfterSpendError);
    expect(err.incurredUsd).toBeCloseTo(0.25, 9);
    // No vendorRef: the SM-42 channel carries an amount only. The column stays NULL rather than being
    // filled with a placeholder.
    expect(err.vendorRefs).toEqual([]);
  });

  it("a driver's takeActualCostUsd() clear-on-read does NOT destroy the liability record", async () => {
    // The two channels are separate fields precisely so this cannot happen. If they shared one
    // accumulator, the driver's read would zero the money record before the framework saw it — the
    // §6w defect reachable through a refactor rather than through a rollback.
    let taken: number | undefined;
    // Exactly what a real driver's takeActualCostUsd() does (ahrefs.ts is the reference).
    const provider = stubProvider(() => {
      taken = takeCapturedActualCostUsd();
      return taken;
    });
    const out = await withActualCostCapture(provider, async () => {
      recordActualCostUsd(0.4);
      recordIncurredCostUsd(0.1, "extra");
      return "ok";
    });
    expect(taken).toBeCloseTo(0.4, 9);
    expect(out.actualCostUsd).toBeCloseTo(0.4, 9);
    // vendorRefs still readable on the success path AFTER the driver consumed its own channel.
    expect(out.vendorRefs).toEqual(["extra"]);
  });

  it("returns vendorRefs on the SUCCESS path too — one column, both paths (§A11.1.4)", async () => {
    const out = await withActualCostCapture(stubProvider(), async () => {
      recordIncurredCostUsd(0.0006, "t-success");
      return 42;
    });
    expect(out.result).toBe(42);
    expect(out.vendorRefs).toEqual(["t-success"]);
  });

  // ── SM-60: the AMOUNT must leave the scope on the SUCCESS path too ──────────────────────────────
  it("SM-60: returns incurredUsd on the SUCCESS path — the liability outlives the capture scope", async () => {
    // SM-50 let the amount escape only inside the rejection envelope, so a failure in the writes that
    // follow a SUCCESSFUL provider call had no amount to compensate with. This is the seam that fixes it,
    // and it must be the SUM (a fanned-out op charges more than once), not whichever call parsed last.
    const out = await withActualCostCapture(stubProvider(), async () => {
      recordIncurredCostUsd(0.0006, "t-1");
      recordIncurredCostUsd(0.0006, "t-2");
      return "delivered";
    });
    expect(out.result).toBe("delivered");
    expect(out.incurredUsd).toBeCloseTo(0.0012, 9);
    expect(out.vendorRefs).toEqual(["t-1", "t-2"]);
  });

  it("SM-60: incurredUsd is 0 when the driver reported no charge — never a placeholder for 'unknown'", async () => {
    // The phantom-row guard's upstream half: a driver that never records (every simulator, and any live
    // driver whose vendor acknowledgement was never parsed) must produce a value dispatch can only read
    // as "nothing owed". 0, not undefined, so the caller's `> 0` test is total.
    const out = await withActualCostCapture(stubProvider(), async () => "no charge");
    expect(out.incurredUsd).toBe(0);
    expect(out.vendorRefs).toEqual([]);
  });

  it("SM-60: a driver's takeActualCostUsd() clear-on-read does not zero the SUCCESS-path incurredUsd either", async () => {
    // The P7 hazard transposed onto the new reader: if the two channels shared one accumulator, the
    // driver's read would zero the amount before dispatch could hand it to the liability holder — the
    // same defect, reachable through the success path instead of the failure path.
    const provider = stubProvider(() => takeCapturedActualCostUsd());
    const out = await withActualCostCapture(provider, async () => {
      recordActualCostUsd(0.4);
      return "ok";
    });
    expect(out.actualCostUsd).toBeCloseTo(0.4, 9);
    expect(out.incurredUsd).toBeCloseTo(0.4, 9); // recordActualCostUsd IMPLIES incurred (§A11.1.3)
  });

  it("isolates concurrent scopes by construction — a racing op can neither read nor clobber the other", async () => {
    // The SM-42 hazard transposed onto the new channel: provider instances are process-level
    // singletons, so if this store were shared state, op B's charge would land on op A's ledger row.
    const [a, b] = await Promise.all([
      rejection<ProviderFailedAfterSpendError>(withActualCostCapture(stubProvider(), async () => {
        recordIncurredCostUsd(1, "A1");
        await new Promise((r) => setTimeout(r, 5));
        recordIncurredCostUsd(1, "A2");
        throw new Error("A failed");
      })),
      rejection<ProviderFailedAfterSpendError>(withActualCostCapture(stubProvider(), async () => {
        recordIncurredCostUsd(10, "B1");
        await new Promise((r) => setTimeout(r, 1));
        throw new Error("B failed");
      })),
    ]);
    expect(a.incurredUsd).toBe(2);
    expect(a.vendorRefs).toEqual(["A1", "A2"]);
    expect(b.incurredUsd).toBe(10);
    expect(b.vendorRefs).toEqual(["B1"]);
  });

  it("recordIncurredCostUsd OUTSIDE any capture scope is a documented no-op, never a throw", () => {
    // A driver unit test calling an HTTP method directly must not blow up. Recording is bookkeeping,
    // never a precondition for the vendor call's own correctness.
    expect(() => recordIncurredCostUsd(0.0006, "orphan")).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// INTEGRATION — the compensating write, against live Postgres
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!TEST_URL)("SM-50 incurred-cost rows (live Postgres)", () => {
  let tenant: string;
  let userId: string;
  let clientId: string;
  let propertyId: string;

  const STANDARD_RATE = DFS_RATES.serpStandardPerTask;

  let seq = 0;
  const uniqueKeyword = (label: string) => `sm50-${label}-${Date.now()}-${seq++}`;

  /** A DataForSEO driver whose HTTP layer is scripted. `taskPost` and `taskGet` are the two envelopes
   *  the SERP path reads; both are vendor-shaped (a per-task status_code inside a 200, which is how
   *  DataForSEO actually signals per-task outcomes). */
  function dfs(opts: {
    taskPost: unknown;
    taskGet?: unknown;
    queue?: "standard" | "live";
    pollAttempts?: number;
  }): { p: DataForSeoProvider; requests: string[] } {
    const requests: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url).replace("https://api.test", "");
      requests.push(path);
      // `taskGet` may be a FUNCTION of the requested path, so a fixture can echo the id that was
      // actually asked for. Before SM-67 a canned body was harmless; now that the driver refuses a
      // task_get whose returned id isn't the one requested, a static id makes every poll look like a
      // vendor identity violation. See STILL_QUEUED below.
      const rawGet = typeof opts.taskGet === "function"
        ? (opts.taskGet as (p: string) => unknown)(path)
        : opts.taskGet;
      // SM-70 (tracker §6bi Ruling 2) — `taskPost` may likewise be a FUNCTION of the POSTED request
      // body, so a fixture can echo the keyword actually requested rather than a static literal. A
      // canned `data: { keyword: "kw" }` was harmless before SM-70's canonical-mismatch refusal
      // existed; now that a mismatch against the ACTUAL posted keyword throws, a static echo is the
      // same fixture-truthfulness lie SM-67 fixed for ids (no real vendor acks keyword X for a posted
      // Y). See ACCEPTED below.
      const postedReqs = init?.body ? (JSON.parse(String(init.body)) as Array<{ keyword?: string }>) : [];
      const rawPost = typeof opts.taskPost === "function"
        ? (opts.taskPost as (reqs: Array<{ keyword?: string }>) => unknown)(postedReqs)
        : opts.taskPost;
      const payload = path.includes("task_get") ? rawGet : rawPost;
      if (payload === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "user@test", password: "secret-pass", baseUrl: "https://api.test",
      queue: opts.queue ?? "standard", timeoutMs: 5000,
      pollAttempts: opts.pollAttempts ?? 2, pollIntervalMs: 1,
      fetchImpl, sleepImpl: async () => undefined,
    });
    return { p, requests };
  }

  /** task_post accepted N tasks (and therefore charged for N). Request-aware (SM-70, tracker §6bi
   *  Ruling 2, fixture-truthfulness corollary): the returned function echoes the KEYWORD ACTUALLY
   *  POSTED at each position, positionally paired with `ids` (the vendor-assigned task ids, arbitrary
   *  fixture literals) — never a static "kw". A static echo would canonically mismatch against every
   *  caller's real `uniqueKeyword(...)` query and wrongly refuse the data path this ticket's callers
   *  are not testing; a real vendor never echoes a keyword nobody posted, so a static echo was always
   *  the fixture lie SM-67 already fixed once for ids. `ids.length` may be SHORTER than the posted
   *  `reqs` (nothing in this file posts more than it accepts), so the fallback keyword only matters
   *  for a genuinely out-of-bounds index, which never happens here. */
  const ACCEPTED = (ids: string[]) => (reqs: Array<{ keyword?: string }> = []) => ({
    status_code: 20000,
    tasks: ids.map((id, i) => ({ id, status_code: 20000, data: { keyword: reqs[i]?.keyword ?? "kw" } })),
  });
  /** Standard-queue "still in queue" — the answer that makes polling exhaust.
   *
   *  Echoes the id from the REQUESTED path rather than a canned `"t"`. This is a fixture-truthfulness
   *  fix, not a softening: the old constant asserted that DataForSEO answers a poll for `task-ac1` with
   *  a body labelled `t`, which no real vendor does. SM-67 added the echo check that made the lie
   *  visible. Every assertion in this file is unchanged — only the mock's honesty is. */
  const STILL_QUEUED = (path: string) => ({
    status_code: 20000,
    tasks: [{ id: path.split("?")[0].split("/").filter(Boolean).pop() ?? "", status_code: 40602 }],
  });

  async function makeEngagement(toolScope: Record<string, unknown>, budgetUsd = 10): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
        [id, tenant, clientId, propertyId, "SM-50 engagement", JSON.stringify(toolScope), budgetUsd, userId],
      ),
      { modules: ["search"] },
    );
    return id;
  }

  async function ledgerRows(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{
        id: string; endpoint: string; items: number; cost_usd: string; cache_hit: boolean;
        status: string; simulated: boolean; vendor_ref: string | null; provider: string;
        correlation_id: string | null; requested_by: string | null; property_id: string | null;
      }>(
        `SELECT id, endpoint, items, cost_usd, cache_hit, status, simulated, vendor_ref, provider,
                correlation_id, requested_by, property_id
           FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at, id`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  async function cacheRowCount(cacheKeyFragment: string): Promise<number> {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ n: string }>(
        `SELECT count(*) AS n FROM search_data_cache WHERE cache_key LIKE $1`,
        [`%${cacheKeyFragment}%`],
      ),
      { modules: ["search"] },
    );
    return Number(r.rows[0].n);
  }

  async function incurredEvents(engagementId: string) {
    const r = await withTenants(
      [tenant],
      (c) => c.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox_events
          WHERE entity_id = $1 AND event_type = 'search.provider.incurred_cost' ORDER BY created_at`,
        [engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-50 Incurred Co", ["search"]);
    userId = await createUser("sm50@incurred.test");
    clientId = await createClient(tenant, "SM-50 Client");
    propertyId = newId();
    await withTenants(
      [tenant],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propertyId, tenant, clientId, "sm50.example.com", "https://sm50.example.com"],
      ),
      { modules: ["search"] },
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    resetGlobalMonthToDateCache();
    resetProviderMonthToDateCache();
    vi.restoreAllMocks();
  });

  // ── AC 1 — the headline shape ─────────────────────────────────────────────────────────────────────
  it("AC1: poll exhaustion after a CHARGED task_post writes exactly ONE incurred row, and no cache row", async () => {
    const { p, requests } = dfs({ taskPost: ACCEPTED(["task-ac1"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("ac1");
    const correlationId = newId();

    // The caller still receives the DRIVER's OWN typed error, not a wrapper — non-negotiable #1.
    //
    // ⚠️ The message assertion ALONE is not sufficient, and I know that because a mutation probe proved
    // it: ProviderFailedAfterSpendError's message deliberately QUOTES its cause, so `toThrow(/still
    // queued/)` still matches when the envelope leaks. Substituting the envelope for the cause passed
    // that assertion and was caught only incidentally elsewhere. The identity check below is the real
    // pin: what the caller receives must be the driver's plain Error, never the internal envelope.
    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "serp", query: kw }, requestedBy: userId, correlationId,
    }));
    expect(err.message).toMatch(/still queued after 2 polls/);
    expect(err).not.toBeInstanceOf(ProviderFailedAfterSpendError);
    expect(err.name).toBe("Error");
    // Nor may the envelope's own framing reach a caller by any route.
    expect(err.message).not.toMatch(/AFTER the vendor was charged/);

    // The vendor was genuinely engaged: one post + pollAttempts gets.
    expect(requests.filter((r) => r.includes("task_post"))).toHaveLength(1);
    expect(requests.filter((r) => r.includes("task_get"))).toHaveLength(2);

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("incurred");
    // accepted tasks (1) x the PUBLISHED Standard rate — not the op's estimate, though here they
    // coincide; the assertion is against the rate table so a future estimate change cannot silently
    // redefine what "charged" means.
    expect(Number(row.cost_usd)).toBeCloseTo(1 * STANDARD_RATE, 9);
    expect(row.cost_usd).not.toBe("0.000000"); // a cost-BEARING row: the whole point
    expect(row.vendor_ref).toBe("task-ac1");
    expect(row.items).toBe(1);
    expect(row.cache_hit).toBe(false);
    // `simulated` stamped from the dispatch value (live in tests: SEARCH_PROVIDER_MODE unset).
    expect(row.simulated).toBe(config.search.providerMode === "simulate");
    // Attribution survives the rollback too — the compensating write is a full ledger row, not a stub.
    expect(row.requested_by).toBe(userId);
    expect(row.correlation_id).toBe(correlationId);
    expect(row.property_id).toBe(propertyId);
    expect(row.provider).toBe("dataforseo");
    expect(row.endpoint).toBe("dataforseo.serp.incurred_no_data");

    // NO cache row: we have nothing to cache, and a poisoned cache entry would hide the failure.
    expect(await cacheRowCount(kw)).toBe(0);
  });

  it("AC1b: the `failed => cost 0` invariant is untouched — an incurred row is NOT a failed row", async () => {
    // §A11.1.2: the reason `incurred` exists at all. If a future edit "simplified" this to a
    // cost-bearing `failed` row, this assertion is what fails.
    const { p } = dfs({ taskPost: ACCEPTED(["task-inv"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("inv") }, requestedBy: userId,
    })).rejects.toThrow();
    const rows = await ledgerRows(eng);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(0);
    for (const r of rows.filter((x) => x.status === "failed")) expect(Number(r.cost_usd)).toBe(0);
  });

  // ── AC 2 — the NEGATIVE CONTROL ───────────────────────────────────────────────────────────────────
  it("AC2: a failure BEFORE any billable point still rolls back with NO row at all (byte-for-byte today)", async () => {
    // Top-level 40100 = auth rejected. assertOk throws before a single task is accepted, so nothing was
    // charged and nothing is owed. This is the property SM-04 shipped and SM-50 must NOT change: an
    // over-eager compensating write here would invent a charge nobody made and could refuse a real
    // client for phantom money — worse in kind than the defect being fixed.
    const { p, requests } = dfs({ taskPost: { status_code: 40100, status_message: "auth failed" } });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac2") }, requestedBy: userId,
    })).rejects.toThrow(/task_post failed: 40100/);
    expect(await ledgerRows(eng)).toHaveLength(0);
    // and it never even reached the poll
    expect(requests.filter((r) => r.includes("task_get"))).toHaveLength(0);
  });

  it("AC2b: a transport-level failure (no vendor acknowledgement at all) writes no row either", async () => {
    // The ambiguous class §A11.1.5 rules must UNDER-record: the request died where the charge is
    // unknowable, so we record nothing and SM-41's console reconciliation is the designed catch.
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard",
      timeoutMs: 5000, fetchImpl, sleepImpl: async () => undefined,
    });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac2b") }, requestedBy: userId,
    })).rejects.toThrow(/ECONNREFUSED/);
    expect(await ledgerRows(eng)).toHaveLength(0);
  });

  // ── AC 3 — THE HEADLINE: burn-then-refuse ─────────────────────────────────────────────────────────
  it("AC3 HEADLINE: N incurred failures accrue into month-to-date and the N+1-th dispatch is REFUSED", async () => {
    // This is the whole ticket in one test. Before SM-50 every one of these failures left NO row, so
    // month-to-date stayed at $0 forever and the (N+1)-th dispatch — and the ten-thousandth — sailed
    // through, burning real deposit that no budget tier could see.
    //
    // Cap arithmetic, deliberately explicit: rate = $0.0006/task, engagement cap = $0.0015. Two burns
    // put MTD at $0.0012; the third dispatch projects 0.0012 + 0.0006 = $0.0018 > $0.0015, so the
    // ENGAGEMENT tier breaches. evaluateBudget uses `>`, so landing exactly on the cap would still be
    // allowed — the numbers are chosen to clear it unambiguously.
    const { p } = dfs({ taskPost: ACCEPTED(["burn"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const cap = 0.0015;
    const eng = await makeEngagement({ rank: { enabled: true } }, cap);

    for (let i = 0; i < 2; i++) {
      await expect(dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword(`burn-${i}`) },
        requestedBy: userId,
      })).rejects.toThrow(/still queued/);
    }

    // The burn is now IN the ledger and IN the sum the stop-loss reads.
    const incurred = (await ledgerRows(eng)).filter((r) => r.status === "incurred");
    expect(incurred).toHaveLength(2);
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    expect(mtd).toBeCloseTo(2 * STANDARD_RATE, 9);

    // ...and the next dispatch is refused BECAUSE OF IT. Asserting the ERROR TYPE AND TIER, not merely
    // "it threw": a poll exhaustion also throws, so a weaker assertion would pass even if the refusal
    // never happened.
    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("refused") },
      requestedBy: userId,
    }));
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("engagement");
    expect((err as BudgetExceededError).monthToDateUsd).toBeCloseTo(2 * STANDARD_RATE, 9);

    // The refusal is a `failed`/0 row (recordBlocked, unchanged), so the two statuses stay legible
    // side by side: two cost-bearing `incurred` rows and one cost-0 `failed` refusal.
    const after = await ledgerRows(eng);
    const blocked = after.filter((r) => r.status === "failed");
    expect(blocked).toHaveLength(1);
    expect(Number(blocked[0].cost_usd)).toBe(0);
    expect(blocked[0].endpoint).toBe("dataforseo.serp.budget_blocked");
  });

  it("AC3b: incurred cost also binds the CROSS-TENANT tiers — the platform and per-provider ceilings see it", async () => {
    // §A11.2 #2/#3: the global and per-provider sums are the tiers that bound a shared deposit, and the
    // DataForSEO deposit-burn ceiling is the one this ticket exists to arm. Proven by DELTA (these are
    // platform-wide aggregates other tests contribute to, so an absolute value would be a flaky
    // assertion, and a flaky money assertion is worse than none).
    const providerKey = `sm50-ceiling-${Date.now()}`;
    resetGlobalMonthToDateCache();
    resetProviderMonthToDateCache();
    const globalBefore = await sumGlobalMonthToDate(false);
    const providerBefore = await sumProviderMonthToDate(providerKey, false);

    await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: null, provider: providerKey,
        endpoint: "sm50.ceiling.incurred_no_data", items: 1, costUsd: 3, cacheHit: false,
        status: "incurred", requestedBy: null, simulated: false, vendorRef: "vr-ceiling",
      }),
      { modules: ["search"] },
    );

    resetGlobalMonthToDateCache();
    resetProviderMonthToDateCache();
    expect(await sumGlobalMonthToDate(false)).toBeCloseTo(globalBefore + 3, 6);
    expect(await sumProviderMonthToDate(providerKey, false)).toBeCloseTo(providerBefore + 3, 6);
  });

  it("AC3c: the money sums are STATUS-BLIND — every status contributes, incurred included", async () => {
    // The load-bearing fact §A11.2 rests on, asserted directly rather than trusted. If someone adds
    // `AND status <> 'incurred'` to sumMonthToDate to "clean up the ceiling", this is the test that
    // goes red — and it goes red on the exact arithmetic a budget tier performs.
    const eng = await makeEngagement({ rank: { enabled: true } }, 1000);
    const seed = (status: ledger.LedgerStatus, costUsd: number) => withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, provider: "dataforseo", endpoint: `seed.${status}`,
        items: 1, costUsd, cacheHit: false, status, requestedBy: null, simulated: false,
      }),
      { modules: ["search"] },
    );
    await seed("posted", 1);
    await seed("completed", 2);
    await seed("failed", 0);
    await seed("incurred", 4);
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    expect(mtd).toBeCloseTo(7, 6); // 1 + 2 + 0 + 4 — the incurred $4 is NOT exempt
  });

  // ── AC 4 — SM-68's response-array bound, REPURPOSED as its dispatch-grain probe (§6bi Ruling 3) ────
  // AC4 used to post 1 task (dispatchProviderOp's serp op is single-keyword: reqs.length === 1) against
  // a fixture returning TWO tasks ("ok-1" accepted, "bad-1" rejected 40501), and asserted the OLD
  // per-task-throw behaviour (`/task rejected: 40501/`). SM-68's bound (`Math.min(tasks.length,
  // reqs.length)`) stops the loop at the first entry, so "bad-1" — beyond `reqs.length` — is never even
  // inspected: it is UNMATCHED OVERFLOW (§A14.2 skip+count+disclose), not a reachable rejection. The old
  // assertion therefore pinned a defect (trusting a longer-than-posted response tail) rather than the
  // fix; its red was CORRECT behaviour, not a regression (§6bi Ruling 3).
  //
  // The fixture is ALSO unrealistic on its own terms (a 1-task post does not return 2 tasks from a real
  // vendor) — but it is precisely the adversarial shape the bound exists for, so it is not deleted: its
  // assertions FLIP from trusting the phantom tail to proving the defence holds at dispatch grain, not
  // merely at the driver's own unit tests (SM-68's describe block in dataforseo.test.ts already covers
  // this at the driver level; this is the SAME property one layer further out, through the real
  // stop-loss/cache/ledger machinery).
  it("AC4 (repurposed, §6bi Ruling 3): the SM-68 bound makes an over-long response's phantom rejection "
    + "UNREACHABLE — exactly ONE charge for the in-bounds accepted task, NO throw, and the overflow is "
    + "counted, never billed", async () => {
    const { p } = dfs({
      // Request-aware: echoes the KEYWORD ACTUALLY POSTED for the in-bounds task ("ok-1"), never a
      // static literal — a static echo would canonically mismatch this test's `uniqueKeyword(...)`
      // query and wrongly exercise SM-70's identity refusal, which is not what THIS test probes.
      taskPost: (reqs: Array<{ keyword?: string }>) => ({
        status_code: 20000,
        tasks: [
          { id: "ok-1", status_code: 20000, data: { keyword: reqs[0]?.keyword ?? "kw" } },
          // An UNREQUESTED extra entry (reqs has only 1 element) — the fixture no real vendor
          // produces, and precisely the adversarial shape the SM-68 bound exists for.
          { id: "bad-1", status_code: 40501, status_message: "invalid location_code" },
        ],
      }),
      taskGet: { status_code: 20000, tasks: [{ id: "ok-1", status_code: 20000, result: [{ items: [] }] }] },
    });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);

    // NO throw at all: "bad-1" is beyond the bound, so its rejection is never seen, and "ok-1"'s own
    // task_get succeeds cleanly.
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac4") }, requestedBy: userId,
    });
    expect(res.status).toBe("posted");

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("posted"); // data WAS delivered — this is not an incurred/no-data row
    // ONE task's rate, not two: the phantom "bad-1" was never even reached, let alone billed.
    expect(Number(rows[0].cost_usd)).toBeCloseTo(1 * STANDARD_RATE, 9);
    expect(rows[0].vendor_ref).toBe("ok-1");

    // The overflow bound's own disclosure: "bad-1" is counted as UNMATCHED, never billed.
    expect(p.getTasksUnmatchedSkippedCount()).toBe(1);
  });

  it("AC4b: an all-rejected task_post is charged nothing and writes nothing", async () => {
    const { p } = dfs({
      taskPost: { status_code: 20000, tasks: [{ id: "bad-only", status_code: 40501, status_message: "nope" }] },
    });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac4b") }, requestedBy: userId,
    })).rejects.toThrow(/task rejected/);
    expect(await ledgerRows(eng)).toHaveLength(0);
  });

  // ── AC 5 — the §4d secondary-failure guard ────────────────────────────────────────────────────────
  it("AC5: when recordIncurred ITSELF fails, the PROVIDER error still propagates (never masked)", async () => {
    // The §4d template: an audit write is best-effort, and a secondary throw out of it must never
    // replace the error the caller needs to act on. Without the guard the caller would see
    // "ledger unavailable" instead of "the task never completed" — a different, misleading incident.
    const spy = vi.spyOn(ledger, "recordIncurred").mockRejectedValue(new Error("ledger write refused"));
    const { p } = dfs({ taskPost: ACCEPTED(["task-ac5"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac5") }, requestedBy: userId,
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/still queued after 2 polls/);
    expect(err.message).not.toMatch(/ledger write refused/);
    // And the envelope never escapes either way.
    expect(err).not.toBeInstanceOf(ProviderFailedAfterSpendError);
  });

  // ── AC 7 — the bell event + the callback interlock ────────────────────────────────────────────────
  it("AC7: the compensating write emits search.provider.incurred_cost with the row's own facts", async () => {
    const { p } = dfs({ taskPost: ACCEPTED(["task-ac7"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const correlationId = newId();
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac7") },
      requestedBy: userId, correlationId,
    })).rejects.toThrow();

    const events = await incurredEvents(eng);
    expect(events).toHaveLength(1);
    const payload = events[0].payload;
    expect(payload.provider).toBe("dataforseo");
    expect(payload.vendorRef).toBe("task-ac7");
    expect(Number(payload.costUsd)).toBeCloseTo(STANDARD_RATE, 9);
    expect(payload.correlationId).toBe(correlationId);
    // The event points at the row it describes, so a consumer never has to guess which charge.
    const rows = await ledgerRows(eng);
    expect(payload.ledgerId).toBe(rows.find((r) => r.status === "incurred")!.id);
  });

  it("AC7b: a failing EVENT emit still leaves the LEDGER ROW, and still surfaces the provider error", async () => {
    // The ORDERING property, proven by forcing the failure rather than by reading the code: the row is
    // written first and the emit is guarded separately, because if only one of the two can happen it
    // must be the row — a silent-but-metered burn still refuses the next dispatch, whereas a
    // notified-but-unmetered one does not.
    //
    // The spy fails ONLY the incurred-cost emit, so the budget-warning emits inside the critical section
    // (a different code path through the same function) are untouched and this test cannot pass for the
    // wrong reason.
    const real = outbox.emitEvent;
    const spy = vi.spyOn(outbox, "emitEvent").mockImplementation(
      (async (c, tenantId, entityType, entityId, eventType, payload) => {
        if (eventType === "search.provider.incurred_cost") throw new Error("outbox unavailable");
        return real(c, tenantId, entityType, entityId, eventType, payload);
      }) as typeof outbox.emitEvent,
    );

    const { p } = dfs({ taskPost: ACCEPTED(["task-ac7b"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("ac7b") }, requestedBy: userId,
    }));

    // The provider error wins, not the outbox failure (the nested §4d guard).
    expect(err.message).toMatch(/still queued/);
    expect(err.message).not.toMatch(/outbox unavailable/);
    // ...and the money is still metered, which is the property that matters.
    const rows = (await ledgerRows(eng)).filter((r) => r.status === "incurred");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(STANDARD_RATE, 9);
    // No event, exactly as forced — recorded so the trade-off is visible, not implied.
    expect(await incurredEvents(eng)).toHaveLength(0);
    spy.mockRestore();
  });

  it("AC7c: the callback interlock — an incurred row advances to completed at the SAME cost, never a second row", async () => {
    // §A11.1.4. The advance changes STATUS ONLY: there is no cost parameter, by design, so a caller
    // cannot re-price a charge while "reconciling" it, and the money in every budget tier is unmoved.
    const { p } = dfs({ taskPost: ACCEPTED(["task-late"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("late") }, requestedBy: userId,
    })).rejects.toThrow();

    const before = await ledgerRows(eng);
    expect(before).toHaveLength(1);
    const cost = Number(before[0].cost_usd);

    // The callback locates the written-off charge by the VENDOR's id, not by anything it was told.
    // SM-59: scoped to the PROVIDER too — a vendor ref is unique only inside its own vendor namespace.
    const found = await findIncurredByVendorRef(tenant, "dataforseo", "task-late");
    expect(found?.id).toBe(before[0].id);
    expect(found?.costUsd).toBeCloseTo(cost, 9);

    expect(await advanceIncurredToCompleted(tenant, found!.id)).toBe(true);
    const after = await ledgerRows(eng);
    expect(after).toHaveLength(1); // NO second cost-bearing row for the same charge
    expect(after[0].status).toBe("completed");
    expect(Number(after[0].cost_usd)).toBeCloseTo(cost, 9); // same cost, unmoved
    expect(after[0].vendor_ref).toBe("task-late");

    // Idempotent-ish: a redelivered callback is a no-op, not a corruption.
    expect(await advanceIncurredToCompleted(tenant, found!.id)).toBe(false);
    expect(await findIncurredByVendorRef(tenant, "dataforseo", "task-late")).toBeNull();
  });

  it("AC7d: the generic true-up stays posted-only — it can NEVER re-price an incurred row", async () => {
    // §A11.2 #7. Correcting an estimate on a delivered call and reconciling an orphaned charge are
    // different operations; if trueUpLedger could touch an incurred row, a reconciliation could
    // silently rewrite a real vendor charge.
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const id = await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, provider: "dataforseo", endpoint: "trueup.guard",
        items: 1, costUsd: 5, cacheHit: false, status: "incurred", requestedBy: null,
        simulated: false, vendorRef: "vr-trueup",
      }),
      { modules: ["search"] },
    );
    expect(await trueUpLedger(tenant, id, 999)).toBe(false);
    const rows = (await ledgerRows(eng)).filter((r) => r.id === id);
    expect(rows[0].status).toBe("incurred");
    expect(Number(rows[0].cost_usd)).toBe(5);
  });

  it("cross-tenant: findIncurredByVendorRef cannot reach another tenant's written-off charge", async () => {
    // A vendor postback is untrusted input by design (§02/§03), so a forged callback quoting someone
    // else's task id must find nothing. RLS on the scoped connection is what enforces it.
    const other = await createCompany("SM-50 Other Co", ["search"]);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, provider: "dataforseo", endpoint: "xtenant.guard",
        items: 1, costUsd: 1, cacheHit: false, status: "incurred", requestedBy: null,
        simulated: false, vendorRef: "vr-secret",
      }),
      { modules: ["search"] },
    );
    expect(await findIncurredByVendorRef(tenant, "dataforseo", "vr-secret")).not.toBeNull();
    expect(await findIncurredByVendorRef(other, "dataforseo", "vr-secret")).toBeNull();
    expect(await advanceIncurredToCompleted(other, (await findIncurredByVendorRef(tenant, "dataforseo", "vr-secret"))!.id)).toBe(false);
  });

  // ── SM-59 (tracker §6ai note 2) — the provider predicate, tested as the CROSS-VENDOR case ─────────
  it("SM-59: a same-tenant vendor_ref COLLISION across two providers reconciles the RIGHT provider's row", async () => {
    // The shape the senior-db review flagged. `vendor_ref` is the VENDOR's id for its own line item, so
    // it is unique only within that vendor's namespace — two providers can legitimately mint the same
    // string. Before SM-59 this lookup matched `vendor_ref` + `status` and nothing else, so whichever
    // row happened to be newest won and a reconciliation could advance the WRONG vendor's charge. That
    // is not a crash: it produces a well-formed row attributing one vendor's money to another, and tells
    // SM-41's console reconciliation that the other vendor's orphan was collected.
    //
    // Deliberately written as TWO rows that differ ONLY by provider, so the provider predicate is the
    // single thing standing between the two answers — nothing else in the query can be what passes it.
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const COLLIDING_REF = "vr-collision-42";
    const dfsId = await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, provider: "dataforseo", endpoint: "serp.incurred_no_data",
        items: 1, costUsd: 0.0006, cacheHit: false, status: "incurred", requestedBy: null,
        simulated: false, vendorRef: COLLIDING_REF,
      }),
      { modules: ["search"] },
    );
    // Written SECOND, so it is the newest — i.e. exactly the row the old `ORDER BY created_at DESC`
    // would have returned for a DataForSEO reconciliation. The test would pass vacuously if the rows
    // were inserted the other way round, which is why the order matters here.
    const ahrefsId = await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: eng, provider: "ahrefs", endpoint: "backlinks.incurred_no_data",
        items: 1, costUsd: 7.5, cacheHit: false, status: "incurred", requestedBy: null,
        simulated: false, vendorRef: COLLIDING_REF,
      }),
      { modules: ["search"] },
    );
    expect(ahrefsId).not.toBe(dfsId);

    // Each provider finds ITS OWN row — asserted by row IDENTITY, not by cost, because two rows could
    // in principle share a cost while a message/amount assertion stayed green (the §6ah P4 lesson).
    const dfsFound = await findIncurredByVendorRef(tenant, "dataforseo", COLLIDING_REF);
    const ahrefsFound = await findIncurredByVendorRef(tenant, "ahrefs", COLLIDING_REF);
    expect(dfsFound?.id).toBe(dfsId);
    expect(ahrefsFound?.id).toBe(ahrefsId);
    expect(dfsFound?.provider).toBe("dataforseo");
    expect(ahrefsFound?.provider).toBe("ahrefs");

    // And a provider with no row for this ref finds NOTHING rather than borrowing someone else's.
    expect(await findIncurredByVendorRef(tenant, "semrush", COLLIDING_REF)).toBeNull();

    // The collect edge's own lookup carries the identical predicate — SM-56 is the second stamping path
    // that makes this collision expressible, so both readers must be provider-scoped or the fix is half
    // applied. Same identity assertions, same reasoning.
    const dfsRow = await findLedgerRowByVendorRef(tenant, "dataforseo", COLLIDING_REF);
    const ahrefsRow = await findLedgerRowByVendorRef(tenant, "ahrefs", COLLIDING_REF);
    expect(dfsRow?.id).toBe(dfsId);
    expect(ahrefsRow?.id).toBe(ahrefsId);
    expect(await findLedgerRowByVendorRef(tenant, "semrush", COLLIDING_REF)).toBeNull();

    // Advancing one leaves the OTHER untouched — the money consequence, stated as money.
    expect(await advanceIncurredToCompleted(tenant, dfsFound!.id)).toBe(true);
    const still = await findIncurredByVendorRef(tenant, "ahrefs", COLLIDING_REF);
    expect(still?.id).toBe(ahrefsId); // Ahrefs's charge is still an open orphan, as it should be
    expect(Number(still?.costUsd)).toBeCloseTo(7.5, 9);
  });

  // ── §A11.1.4's other half: vendor_ref on the SUCCESS path ─────────────────────────────────────────
  it("a SUCCESSFUL dispatch also stamps vendor_ref — one column, both paths", async () => {
    const { p } = dfs({
      taskPost: ACCEPTED(["task-good"]),
      taskGet: {
        status_code: 20000,
        tasks: [{ id: "task-good", status_code: 20000, result: [{ items: [{ type: "organic", rank_absolute: 1, url: "https://a.example/" }] }] }],
      },
    });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("good") }, requestedBy: userId,
    });
    expect(res.status).toBe("posted");
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("posted");
    expect(rows[0].vendor_ref).toBe("task-good");
    // A successful call is NOT an incurred one: the charge bought data, so it is an ordinary posted row.
    expect(rows.some((r) => r.status === "incurred")).toBe(false);
  });

  it("retry after an incurred failure produces TWO rows, matching TWO vendor charges (enumerated, not deduped)", async () => {
    // §A11.2's explicit enumeration: "retry after an incurred failure double-charges the vendor and
    // writes two rows — ledger equals vendor truth, no deduplication is attempted." Pinned so nobody
    // later "fixes" the duplicate and makes the ledger under-report real money.
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("retry");
    for (const id of ["retry-1", "retry-2"]) {
      resetProviders();
      const { p } = dfs({ taskPost: ACCEPTED([id]), taskGet: STILL_QUEUED });
      registerProvider(p as SearchDataProvider);
      await expect(dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "serp", query: kw }, requestedBy: userId,
      })).rejects.toThrow(/still queued/);
    }
    const rows = (await ledgerRows(eng)).filter((r) => r.status === "incurred");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vendor_ref).sort()).toEqual(["retry-1", "retry-2"]);
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    expect(mtd).toBeCloseTo(2 * STANDARD_RATE, 9);
  });

  it("the LIVE queue's higher published rate is what a live-queue charge records", async () => {
    // The rate is read from the CONFIGURED queue, not hardcoded to Standard — a live-queue engagement
    // burns 3.3x as fast and the ledger has to say so, or the ceiling is calibrated against the wrong
    // number.
    const { p } = dfs({ taskPost: ACCEPTED(["task-live"]), taskGet: STILL_QUEUED, queue: "live" });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("livequeue") }, requestedBy: userId,
    })).rejects.toThrow();
    const rows = (await ledgerRows(eng)).filter((r) => r.status === "incurred");
    expect(Number(rows[0].cost_usd)).toBeCloseTo(DFS_RATES.serpLivePerTask, 9);
    expect(DFS_RATES.serpLivePerTask).toBeGreaterThan(DFS_RATES.serpStandardPerTask);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // SM-60 — the POST-SUCCESS write boundary (tracker §6ak). SM-50 compensated only when the provider
  // call itself rejected; the writes that follow a SUCCESSFUL, CHARGED, DELIVERED call could still lose
  // the charge entirely. QA's repro lives in qa-adversarial-sm50-14-16-53.test.ts (flipped by this
  // ticket); these are the shape, guard and money proofs.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** A task_get that DELIVERS a real result — the vendor did its job; only our bookkeeping fails. */
  const DELIVERED = (id: string) => ({
    status_code: 20000,
    tasks: [{ id, status_code: 20000, result: [{ items: [{ type: "organic", rank_absolute: 3, url: "https://sm60.example/" }] }] }],
  });

  it("SM60-1: a ledger-INSERT fault after a charged+delivered call writes ONE incurred row and rethrows the DB fault BY IDENTITY", async () => {
    const { p, requests } = dfs({ taskPost: ACCEPTED(["task-sm60-1"]), taskGet: DELIVERED("task-sm60-1") });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const kw = uniqueKeyword("sm60-1");
    const correlationId = newId();

    // Only dispatch.ts's own insertLedgerRow call is intercepted (ledger.ts's recordIncurred calls its
    // module-local binding), so this models a real post-success DB fault — a constraint violation, a
    // dropped connection, a statement timeout — rather than a total ledger outage. The outage case is
    // AC5's territory and is unchanged.
    const dbFault = new Error("insert into search_provider_calls violates a constraint");
    const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(dbFault);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "serp", query: kw }, requestedBy: userId, correlationId,
    }));
    insertSpy.mockRestore();

    // Property 1: the caller receives the REAL fault, the same object — no wrapper, no money message.
    // Identity, not message: SM-50's P4 probe proved a message assertion passes while a wrapper leaks.
    expect(err).toBe(dbFault);
    expect(err).not.toBeInstanceOf(ProviderFailedAfterSpendError);

    // The vendor was genuinely engaged AND delivered — this is a charge for data we then threw away.
    expect(requests.filter((r) => r.includes("task_post"))).toHaveLength(1);
    expect(requests.filter((r) => r.includes("task_get"))).toHaveLength(1);

    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("incurred");
    expect(Number(row.cost_usd)).toBeCloseTo(1 * STANDARD_RATE, 9);
    expect(row.cost_usd).not.toBe("0.000000");
    expect(row.vendor_ref).toBe("task-sm60-1");
    expect(row.items).toBe(1);
    expect(row.cache_hit).toBe(false);
    expect(row.simulated).toBe(config.search.providerMode === "simulate");
    expect(row.requested_by).toBe(userId);
    expect(row.correlation_id).toBe(correlationId);
    expect(row.property_id).toBe(propertyId);
    // The reason suffix distinguishes this shape from SM-50's vendor-side non-delivery WITHOUT a second
    // status — the same reason-in-the-endpoint convention `.budget_blocked` etc. already use.
    expect(row.endpoint).toBe("dataforseo.serp.incurred_write_failed");
    expect(row.endpoint).not.toBe("dataforseo.serp.incurred_no_data");

    // The rollback took the cache row with it, so the delivered payload is genuinely NOT retained: this
    // row is honest when it says the platform has nothing for the charge.
    expect(await cacheRowCount(kw)).toBe(0);
  });

  it("SM60-2: a CACHE-write fault does the same — the fix is bound to the charge, not to one statement", async () => {
    const { p } = dfs({ taskPost: ACCEPTED(["task-sm60-2"]), taskGet: DELIVERED("task-sm60-2") });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const cacheFault = new Error("search_data_cache write failed");
    const spy = vi.spyOn(cache, "writeCache").mockRejectedValue(cacheFault);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "serp", query: uniqueKeyword("sm60-2") }, requestedBy: userId,
    }));
    spy.mockRestore();

    expect(err).toBe(cacheFault);
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("incurred");
    expect(rows[0].vendor_ref).toBe("task-sm60-2");
    expect(Number(rows[0].cost_usd)).toBeCloseTo(STANDARD_RATE, 9);
    expect(rows[0].endpoint).toBe("dataforseo.serp.incurred_write_failed");
  });

  it("SM60-3 PHANTOM-ROW GUARD: the same fault with NO recorded charge writes NOTHING", async () => {
    // The counterweight to the fix, and the reason it is a charge test rather than an error-type test.
    // MockSearchProvider succeeds and never calls recordIncurredCostUsd — exactly like every simulator,
    // and like any live driver whose vendor acknowledgement was never parsed. Compensating here would
    // invent an `incurred` row for money nobody was charged, which would refuse real client work for
    // phantom spend: worse in kind than the missing row this ticket fixes, and harder to explain.
    resetProviders();
    registerProvider(new MockSearchProvider() as SearchDataProvider);
    const eng = await makeEngagement({ volume: { enabled: true } }, 100);
    const dbFault = new Error("statement timeout");
    const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(dbFault);
    const incurredSpy = vi.spyOn(ledger, "recordIncurred");

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "volume", query: uniqueKeyword("sm60-3") }, requestedBy: userId,
    }));
    insertSpy.mockRestore();

    expect(err).toBe(dbFault); // unchanged, untouched, still by identity
    expect(incurredSpy).not.toHaveBeenCalled(); // the guard fired BEFORE any write was attempted
    expect(await ledgerRows(eng)).toHaveLength(0);
    incurredSpy.mockRestore();
  });

  it("SM60-4: the recovered charge binds the stop-loss — burn via a write fault, then be REFUSED", async () => {
    // AC3's headline, re-run through the SM-60 path: it is not enough that a row appears, it has to be
    // the row a budget tier sums. Same cap arithmetic as AC3 (rate $0.0006, cap $0.0015: two burns put
    // MTD at $0.0012, the third projects $0.0018 > $0.0015 and the ENGAGEMENT tier breaches).
    const cap = 0.0015;
    const eng = await makeEngagement({ rank: { enabled: true } }, cap);
    for (let i = 0; i < 2; i++) {
      resetProviders();
      const { p } = dfs({ taskPost: ACCEPTED([`sm60-burn-${i}`]), taskGet: DELIVERED(`sm60-burn-${i}`) });
      registerProvider(p as SearchDataProvider);
      const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(new Error("connection terminated"));
      await expect(dispatchProviderOp({
        tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword(`sm60-burn-${i}`) },
        requestedBy: userId,
      })).rejects.toThrow(/connection terminated/);
      insertSpy.mockRestore();
    }

    const incurred = (await ledgerRows(eng)).filter((r) => r.status === "incurred");
    expect(incurred).toHaveLength(2);
    expect(incurred.every((r) => r.endpoint.endsWith(".incurred_write_failed"))).toBe(true);
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    expect(mtd).toBeCloseTo(2 * STANDARD_RATE, 9);

    resetProviders();
    const { p } = dfs({ taskPost: ACCEPTED(["sm60-refused"]), taskGet: DELIVERED("sm60-refused") });
    registerProvider(p as SearchDataProvider);
    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("sm60-refused") },
      requestedBy: userId,
    }));
    // The type AND tier, not merely "it threw": this dispatch would otherwise have SUCCEEDED (its
    // provider call is scripted to deliver), so only a real refusal can produce this.
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).tier).toBe("engagement");
    expect((err as BudgetExceededError).monthToDateUsd).toBeCloseTo(2 * STANDARD_RATE, 9);
  });

  it("SM60-5: the bell event still fires, and carries dataDelivered so the two shapes are distinguishable", async () => {
    // ONE event type deliberately (§A11.2 #11: a charge that bought the platform nothing must reach a
    // human whichever way it happened), with the sub-case as DATA rather than as a second event type a
    // consumer could forget to subscribe to.
    const { p } = dfs({ taskPost: ACCEPTED(["task-sm60-5"]), taskGet: DELIVERED("task-sm60-5") });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(new Error("deadlock detected"));
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("sm60-5") }, requestedBy: userId,
    })).rejects.toThrow(/deadlock detected/);
    insertSpy.mockRestore();

    const events = await incurredEvents(eng);
    expect(events).toHaveLength(1);
    expect(events[0].payload.dataDelivered).toBe(true);
    expect(events[0].payload.vendorRef).toBe("task-sm60-5");
    const rows = await ledgerRows(eng);
    expect(events[0].payload.ledgerId).toBe(rows.find((r) => r.status === "incurred")!.id);
  });

  it("SM60-5b: the SM-50 path reports dataDelivered=false — the flag is a real discriminator, not a constant", async () => {
    const { p } = dfs({ taskPost: ACCEPTED(["task-sm60-5b"]), taskGet: STILL_QUEUED });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("sm60-5b") }, requestedBy: userId,
    })).rejects.toThrow(/still queued/);
    const events = await incurredEvents(eng);
    expect(events).toHaveLength(1);
    expect(events[0].payload.dataDelivered).toBe(false);
    const rows = await ledgerRows(eng);
    expect(rows[0].endpoint).toBe("dataforseo.serp.incurred_no_data");
  });

  it("SM60-6: a SUCCESSFUL dispatch writes NO incurred row — the holder is read only on the failure path", async () => {
    // The other half of the phantom guard: the liability holder is populated on EVERY charged dispatch,
    // including the ones that go on to succeed. If the compensation ever ran on a successful dispatch,
    // every paid pull would be double-counted — a far bigger money error than the one being fixed.
    const { p } = dfs({ taskPost: ACCEPTED(["task-sm60-6"]), taskGet: DELIVERED("task-sm60-6") });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const res = await dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("sm60-6") }, requestedBy: userId,
    });
    expect(res.status).toBe("posted");
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("posted");
    expect(rows[0].vendor_ref).toBe("task-sm60-6");
    expect(await incurredEvents(eng)).toHaveLength(0);
  });

  // ── QA adversarial pass (⚡ gate, 2026-07-30) — two boundaries the implementer's own S1-S5 probes
  // did not attack: the TRUE-UP statement (a THIRD post-success statement inside the same transaction,
  // distinct from writeCache/insertLedgerRow) and the declared post-COMMIT residual window itself. ──
  it("QA-SM60-A: a TRUE-UP fault (SM-42's statement, not writeCache/insertLedgerRow) still compensates exactly once", async () => {
    // Every existing SM60-* test fails writeCache or insertLedgerRow. Nothing in the suite fails the
    // THIRD statement the same transaction can run — trueUpLedgerOnConnection, reached only when the
    // resolved driver implements takeActualCostUsd() (SM-42) and therefore only for a driver shape
    // DataForSEO does not have. Built as a bespoke volume-capable stub so the true-up path is actually
    // exercised, not skipped the way every DataForSEO-driven SM60 test skips it.
    resetProviders();
    let captured: number | undefined;
    const provider: SearchDataProvider = {
      key: "dataforseo",
      capabilities: new Set(["volume"]),
      postSerpTasks: async () => [],
      fetchSerpResults: async () => [],
      getBacklinkSummary: async () => ({ target: "", backlinks: 0, refDomains: 0 }),
      getAiVisibility: async () => [],
      estimateCostUsd: () => 0.0001,
      async getKeywordMetrics(kws) {
        // recordActualCostUsd IMPLIES incurred (§A11.1.3) — this is what puts a charge in the liability
        // holder for a driver shape that also exercises trueUpLedgerOnConnection.
        recordActualCostUsd(0.0009);
        return kws.map((k) => ({ keyword: k.keyword, volume: 100 }));
      },
      takeActualCostUsd: () => takeCapturedActualCostUsd(),
    };
    registerProvider(provider);
    const eng = await makeEngagement({ volume: { enabled: true } }, 100);
    const trueUpFault = new Error("true-up UPDATE violates a check constraint");
    const spy = vi.spyOn(ledger, "trueUpLedgerOnConnection").mockRejectedValue(trueUpFault);

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "volume", query: uniqueKeyword("qa-a") }, requestedBy: userId,
    }));
    spy.mockRestore();

    // Same identity guarantee the rest of the suite pins: the caller sees the REAL fault, not a wrapper.
    expect(err).toBe(trueUpFault);
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("incurred");
    // The AMOUNT recorded is the CHARGE (what the driver reported via recordActualCostUsd), not the
    // pre-dispatch estimate — the true-up never committed, so there is no "actual" figure to prefer.
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0009, 9);
    expect(rows[0].endpoint).toBe("dataforseo.volume.incurred_write_failed");
    // The cache row the transaction wrote before the true-up ran was rolled back with everything else.
    expect(await cacheRowCount("qa-a")).toBe(0);
  });

  it("QA-SM60-B: a fault STRICTLY AFTER a successful COMMIT reproduces the DECLARED residual — and ONLY that shape", async () => {
    // dispatch.ts's own header (SM-60 doc comment) admits: if the transaction actually COMMITTED and the
    // fault arose strictly after the COMMIT (in practice only a pool double-release fault), the catch
    // will write a DUPLICATE `incurred` row alongside the already-committed `posted` row — an
    // over-count, the fail-CLOSED direction of the trade. This test manufactures exactly that shape
    // (wrap runInCacheCriticalSection so the REAL critical section runs to a REAL commit, then throw
    // AFTER it resolves) to confirm the residual is (a) real, (b) bounded to this one shape, and (c) not
    // reachable by any of the ordinary faults the rest of this file already exercises — none of which
    // produced a 2-row result.
    const { p } = dfs({ taskPost: ACCEPTED(["task-qa-b"]), taskGet: DELIVERED("task-qa-b") });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: true } }, 100);
    const real = cache.runInCacheCriticalSection;
    const postCommitFault = new Error("pool double-release fault (simulated, strictly after COMMIT)");
    const spy = vi.spyOn(cache, "runInCacheCriticalSection").mockImplementation(
      (async (...args: Parameters<typeof real>) => {
        const result = await real(...args); // the REAL transaction COMMITs for real here
        throw postCommitFault; // then the fault arrives, after money AND the row are already durable
      }) as typeof real,
    );

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("qa-b") }, requestedBy: userId,
    }));
    spy.mockRestore();

    expect(err).toBe(postCommitFault);
    const rows = await ledgerRows(eng);
    // THE OVER-COUNT, reproduced and bounded: the committed `posted` row survives (it was already
    // durable before the fault existed) AND the compensation catch — which has no way to know the
    // transaction it is compensating for already succeeded — writes a SECOND, duplicate `incurred` row
    // for the same vendor charge. This is the documented trade, not a wider hole: every OTHER fault in
    // this file (writeCache, insertLedgerRow, the true-up, the phantom-guard cases) produced exactly ONE
    // row or ZERO, never two, because in every other case the transaction genuinely rolled back and the
    // posted row genuinely does not exist.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "posted")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "incurred")).toHaveLength(1);
    expect(rows.find((r) => r.status === "posted")!.vendor_ref).toBe("task-qa-b");
    expect(rows.find((r) => r.status === "incurred")!.vendor_ref).toBe("task-qa-b");
    // Both rows are money: sumMonthToDate double-counts this one call, exactly as the doc-comment's
    // honesty admits, and SM-41's ledger-vs-console reconciliation is named as the designed backstop for
    // this exact shape — not a mutation-probe pin, because it is accepted behaviour, not a bug.
    const mtd = await withTenants([tenant], (c) => sumMonthToDate(c, eng, false), { modules: ["search"] });
    expect(mtd).toBeCloseTo(2 * STANDARD_RATE, 9);
  });

  it("QA-SM60-C PHANTOM-ROW, the exact-$0 boundary: a driver that records incurredUsd===0 (not 'never records') still writes NOTHING on a post-success fault", async () => {
    // SM60-3 already proves "never calls recordIncurredCostUsd at all" writes nothing. That is a
    // DIFFERENT code path through the guard than this one: here the ALS store's `incurredObserved`
    // flag IS true (the driver explicitly declared a charge), but the amount is exactly 0. The `> 0`
    // test in dispatch.ts (`if (incurredUsd > 0) liability.recorded = ...`) is what has to hold at this
    // exact boundary — a `>= 0` or a bare truthiness/`incurredObserved` check would phantom-write a $0
    // charge into the liability holder and, on this same post-success fault, into the ledger as a
    // cost-bearing... except it can't be cost-bearing at $0, so the honest failure mode of a wrong
    // boundary here is a NOISE row (an `incurred` row with cost_usd = 0), which is the §A9.5
    // degenerate-input class this ticket's own comments name as the thing to avoid.
    resetProviders();
    const provider: SearchDataProvider = {
      key: "dataforseo",
      capabilities: new Set(["volume"]),
      postSerpTasks: async () => [],
      fetchSerpResults: async () => [],
      getBacklinkSummary: async () => ({ target: "", backlinks: 0, refDomains: 0 }),
      getAiVisibility: async () => [],
      estimateCostUsd: () => 0.0001,
      async getKeywordMetrics(kws) {
        recordIncurredCostUsd(0); // explicitly declared, explicitly nothing billable
        return kws.map((k) => ({ keyword: k.keyword, volume: 100 }));
      },
    };
    registerProvider(provider);
    const eng = await makeEngagement({ volume: { enabled: true } }, 100);
    const dbFault = new Error("statement timeout on insert");
    const insertSpy = vi.spyOn(ledger, "insertLedgerRow").mockRejectedValue(dbFault);
    const incurredSpy = vi.spyOn(ledger, "recordIncurred");

    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, propertyId,
      op: { kind: "volume", query: uniqueKeyword("qa-c") }, requestedBy: userId,
    }));
    insertSpy.mockRestore();

    expect(err).toBe(dbFault); // untouched, by identity
    expect(incurredSpy).not.toHaveBeenCalled(); // the guard fired before any compensating write attempt
    expect(await ledgerRows(eng)).toHaveLength(0); // NOT EVEN a $0 incurred row
    incurredSpy.mockRestore();
  });

  it("QA-SM60-D PHANTOM-ROW, the never-invoked boundary: a BUDGET REFUSAL never reaches invokeProvider, so the holder is never even a candidate", async () => {
    // The other place a phantom row could sneak in: if a future edit read the liability holder BEFORE
    // confirming invokeProvider actually ran (e.g. reordered so the holder check happens outside the
    // try/catch that wraps the real dispatch), a budget-blocked op — which never contacts the vendor —
    // could still be compensated for money nobody was ever asked to spend. Proven by forcing a real
    // budget breach against a driver that WOULD record a charge if it were ever called, and asserting
    // the vendor transport layer was never touched at all.
    const { p, requests } = dfs({ taskPost: ACCEPTED(["should-never-be-posted"]) });
    registerProvider(p as SearchDataProvider);
    const tinyCap = 0.00001; // below DFS_RATES.serpStandardPerTask, guarantees an immediate breach
    const eng = await makeEngagement({ rank: { enabled: true } }, tinyCap);
    const err = await rejection<Error>(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("qa-d") }, requestedBy: userId,
    }));
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(requests).toHaveLength(0); // the vendor transport layer was NEVER reached
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed"); // recordBlocked, cost 0 — never `incurred`
    expect(Number(rows[0].cost_usd)).toBe(0);
    expect(rows.some((r) => r.status === "incurred")).toBe(false);
  });

  it("a scope refusal still writes failed/0 and never reaches a provider — no incurred row exists", async () => {
    // The pre-engagement refusal path is unchanged (recordBlocked, cost 0). Included because "did SM-50
    // accidentally start writing incurred rows for refusals?" is the cheap way this could go wrong.
    const { p, requests } = dfs({ taskPost: ACCEPTED(["never"]) });
    registerProvider(p as SearchDataProvider);
    const eng = await makeEngagement({ rank: { enabled: false } }, 100);
    await expect(dispatchProviderOp({
      tenantId: tenant, engagementId: eng, op: { kind: "serp", query: uniqueKeyword("scoped") }, requestedBy: userId,
    })).rejects.toThrow(/enable the 'rank' tool/);
    const rows = await ledgerRows(eng);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(Number(rows[0].cost_usd)).toBe(0);
    expect(rows[0].vendor_ref).toBeNull();
    expect(requests).toHaveLength(0); // the vendor was never contacted, so nothing could be charged
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// MUTATION PROBES — the §6r standard: every guard added by this ticket was DELETED in turn, the suite
// re-run, and the resulting failures recorded. A guard whose removal leaves the suite green is a
// finding, not a pass. The probes applied, with the tests that catch each, are:
//
// OBSERVED RESULTS (tsc verified clean under each probe, so every failure below is behavioural, not a
// syntax error; the product files were restored byte-identically afterwards and re-verified):
//
//   P1  delete the recordIncurred call in runCriticalSectionWithSpendCompensation (keep the rethrow)
//       => 10 failed / 26 passed. The burn vanishes from the ledger exactly as it did before this
//          ticket, INCLUDING the flipped §6w sandbox pin.
//   P2  add `AND status <> 'incurred'` to sumMonthToDate
//       => 3 failed / 51 passed: AC3 (the headline refusal), AC3c, and the retry-pair sum. Incurred
//          spend escapes the ceiling — the exact fail-open this ticket exists to close.
//   P2b add `AND status <> 'incurred'` to the PINNED GLOBAL_MTD_QUERY_SQL constant
//       => 3 failed / 51 passed: the behavioural cross-tenant test AND both mechanical shape pins.
//          Recorded separately from P2 because sumMonthToDate builds its SQL at runtime (no constant to
//          anchor), so the two halves of the prohibition are enforced by different mechanisms.
//   P3  remove the secondary-failure guard (rethrow recordIncurred's rejection instead of swallowing)
//       => 1 failed / 53 passed: AC5. The provider error is masked by the audit failure.
//   P4  throw the envelope instead of `err.cause`
//       => 2 failed / 52 passed: AC1 and AC5.
//       ⚠️ FINDING FROM THIS PROBE, kept because it is instructive: on the first run P4 produced only
//          ONE failure, because ProviderFailedAfterSpendError's message QUOTES its cause, so every
//          `rejects.toThrow(/still queued/)` assertion still matched while the internal envelope leaked
//          to callers. A message assertion is not an identity assertion. AC1 now checks the error's
//          identity directly, which is what makes this probe fail where it should.
//   P5  restore postSerpTasks' original order (throw on the first rejected task before recording)
//       => 2 failed / 60 passed: AC4 and its driver-level twin. A mixed response loses a real charge.
//   P6  record every task in postSerpTasks, accepted or not
//       => 4 failed / 58 passed: AC4/AC4b and both driver-level twins. Liability is over-stated, which
//          could refuse a real client for money nobody was charged.
//   P7  share ONE accumulator between the correction and liability channels
//       => 1 failed / 61 passed: the clear-on-read unit test. takeActualCostUsd() destroys the money
//          record — the §6w defect reachable by refactor instead of by rollback.
//   P8  interpolate the money figure into the bell prose (notifications.ts)
//       => 1 failed / 8 passed in search-notifications.test.ts: SM-13's TEXT-SAFETY rule holds — a
//          standard-rate accounting figure must not be rendered where it reads as cash.
//
// Every probe produced red. If one ever comes back green, that is the finding, not a pass.
//
// ── SM-60's own probes (tracker §6ak) ───────────────────────────────────────────────────────────────
// Same discipline, same evidence standard: each mutation was applied to the PRODUCT file, `tsc
// --noEmit` confirmed clean so every failure is behavioural rather than a syntax error, the two files
// below were re-run, and dispatch.ts/types.ts were then restored and diffed byte-identical.
// Counts are for `incurred-cost.test.ts` + `qa-adversarial-sm50-14-16-53.test.ts` (41 tests) unless
// noted.
//
//   S1  restore SM-50's narrow guard (`if (!(err instanceof ProviderFailedAfterSpendError)) throw err`)
//       => 6 failed / 35 passed: SM60-1, SM60-2, SM60-4, SM60-5 and BOTH flipped QA repro tests. This
//          is the defect itself, reinstated — the charge vanishes from the ledger exactly as it did
//          before this ticket.
//   S2  delete the phantom-row guard (compensate on ANY post-provider error, charge or not)
//       => 5 failed / 91 passed (run widened to include dispatch.test.ts): SM60-3 (the phantom probe)
//          plus SM-50's OWN negative controls AC2, AC2b, AC4b and SM-04's "a provider failure rolls
//          back the whole critical section" pin. Recording money nobody was charged breaks four
//          pre-existing money properties, not just the new one — which is why the guard is the same
//          line as the fix.
//   S3  wrap the SM-60 error instead of rethrowing it by identity
//       => 4 failed / 37 passed: SM60-1, SM60-2 and both QA repro tests — all four `expect(err).toBe(
//          theFault)` assertions. ⚠️ NOTE, and it is SM-50's P4 lesson repeating exactly: SM60-4 and
//          SM60-5, which assert `rejects.toThrow(/connection terminated/)`, stayed GREEN under this
//          probe, because ProviderFailedAfterSpendError's message quotes its cause. Only the identity
//          assertions caught the leak. A message assertion is still not an identity assertion.
//   S4  delete the liability handoff (`if (incurredUsd > 0) liability.recorded = …`)
//       => 6 failed / 35 passed: the same four SM60 tests + both QA repros. The catch has a rule and no
//          data — proof that the handoff, not the widened catch, is what carries the fix.
//   S5  return `incurredUsd: 0` from withActualCostCapture's SUCCESS path (types.ts half)
//       => 8 failed / 33 passed: the two SM-60 unit tests plus all six integration reds. The seam is
//          pinned at both layers independently.
// ════════════════════════════════════════════════════════════════════════════════════════════════
