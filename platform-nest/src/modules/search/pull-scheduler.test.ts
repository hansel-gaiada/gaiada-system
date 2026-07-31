// SM-54 — the pull scheduler's DECISIONS, not merely that the loop runs (tracker §6ad's SM-54 row +
// its ⚡ QA gate). This is an unattended money loop, so every test below is written to fail if a gate
// stops gating rather than to pass if the happy path happens to work.
//
// No HTTP layer and no Cerbos stub: the sweep has NO PRINCIPAL by construction (§A13.2 — that is
// exactly why it is a platform job and not an MCP/n8n caller), so driving it directly is testing the
// real thing, not a harness of it. Seeding is direct SQL under `withTenants(..., { modules: ["search"] })`
// — deliberately NOT through search.controller.ts, which a concurrent agent owns this wave.
//
// The FIVE decisions the ticket names, each with the mutation that must turn it red:
//   1. a due engagement dispatches                     — probe: nothing (this is the positive control)
//   2. a not-yet-due engagement does NOT dispatch      — probe P1: `isDue` => always true
//   3. a disabled toggle is refused NAMING the toggle  — probe P2: drop the isToggleEnabled gate
//   4. an over-budget engagement is refused            — probe P4: drop the last-attempt half of lastRunAt
//                                                        (proves the refusal consumes its window)
//   5. two overlapping ticks dispatch once             — probe P3: make the advisory lock always granted
//   + attribution (requested_by NULL / sched:<tool>)   — probe P5: stamp a non-null requested_by
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createClient, createCompany } from "../../testing/fixtures";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { resetGlobalMonthToDateCache } from "./providers/ledger";
import {
  applyScopeLimit,
  cadenceDays,
  isDue,
  runSearchPullSweep,
  schedulerCorrelationId,
  startSearchPullSchedulerLoop,
  SCHEDULED_TOOLS,
} from "./pull-scheduler";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Pure cadence derivation — no DB, so these run even without DATABASE_URL_TEST. They are the
// arithmetic behind "cadence must be derived, never hardcoded".
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("SM-54 · cadence derivation (pure)", () => {
  // SM-61 (tracker §6au, binding) SUPERSEDED this file's own original spec clause ("absent/unknown
  // cadence defaults weekly-conservative") — see `cadence.test.ts` for the parser's own pure tests
  // (parseCadence/isCadence: absent+junk => null, never a guessed schedule). `cadenceDays` re-exported
  // here now takes a REAL, already-parsed `Cadence` only — there is no "unrecognized input" branch to
  // test at this layer any more, by construction (the type signature forecloses it).
  it("ports sm-rank-pull.json's windows verbatim: daily=1, weekly=7, monthly=30", () => {
    expect(cadenceDays("daily")).toBe(1);
    expect(cadenceDays("weekly")).toBe(7);
    expect(cadenceDays("monthly")).toBe(30);
  });

  it("no prior run at all is due; a run inside the window is not; a run at exactly the window is", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);
    expect(isDue(now, null, "daily")).toBe(true);
    expect(isDue(now, hoursAgo(23), "daily")).toBe(false);
    expect(isDue(now, hoursAgo(24), "daily")).toBe(true);
    expect(isDue(now, hoursAgo(25), "daily")).toBe(true);
    expect(isDue(now, hoursAgo(24 * 6), "weekly")).toBe(false);
    expect(isDue(now, hoursAgo(24 * 7), "weekly")).toBe(true);
    expect(isDue(now, hoursAgo(24 * 29), "monthly")).toBe(false);
    expect(isDue(now, hoursAgo(24 * 30), "monthly")).toBe(true);
  });

  it("NO early-fire tolerance — 23h59m into a daily window is still not due (a tolerance would overspend)", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    expect(isDue(now, new Date(now.getTime() - (24 * 3600 * 1000 - 60_000)), "daily")).toBe(false);
  });

  it("applyScopeLimit honours the toggle's own bound and falls back to the projection's default", () => {
    const items = Array.from({ length: 120 }, (_, i) => `kw-${i}`);
    expect(applyScopeLimit(items, { maxKeywords: 10 }, 50)).toMatchObject({ eligible: 120, limit: 10 });
    expect(applyScopeLimit(items, { maxKeywords: 10 }, 50).selected).toHaveLength(10);
    // Unset => the same 50 `projectMonthlyCost` prices a run at, so a tick can never bill above the
    // figure the scope panel showed the human.
    expect(applyScopeLimit(items, {}, 50).selected).toHaveLength(50);
    // Garbage bounds must not disable the bound (that would be the fail-open direction).
    for (const bad of [0, -5, Number.NaN, "50", null]) {
      expect(applyScopeLimit(items, { maxKeywords: bad }, 50).selected).toHaveLength(50);
    }
    // A bound larger than the eligible set is not a truncation.
    expect(applyScopeLimit(items, { maxKeywords: 500 }, 50).selected).toHaveLength(120);
    // ai_visibility reads its own key.
    expect(applyScopeLimit(items, { maxQueries: 3 }, 10, "maxQueries").selected).toHaveLength(3);
  });

  it("exactly the four tools §A13.2 reassigns from n8n are scheduled — `suggestions` is not", () => {
    expect([...SCHEDULED_TOOLS]).toEqual(["rank", "volume", "backlinks", "ai_visibility"]);
    expect(SCHEDULED_TOOLS as readonly string[]).not.toContain("suggestions");
    expect(SCHEDULED_TOOLS.map(schedulerCorrelationId)).toEqual([
      "sched:rank", "sched:volume", "sched:backlinks", "sched:ai_visibility",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The sweep, against LIVE Postgres with RLS actually enforced.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
interface Seeded {
  tenantId: string;
  clientId: string;
  propertyId: string;
  engagementId: string;
  setId: string;
  keywordIds: string[];
}

describe.skipIf(!TEST_URL)("SM-54 · search pull scheduler sweep (live PG)", () => {
  let mock: MockSearchProvider;
  let seq = 0;
  /** A sweep is PLATFORM-WIDE by nature, so every engagement any earlier test left `active` and due
   *  would be re-swept by every later test — and a global counter like `mock.dispatchCount` would then
   *  depend on test order. (This is not hypothetical: the first QA run's overlap test read 2 dispatches
   *  because the pillar-kill-switch test above it leaves its engagement permanently due, a pillar
   *  refusal writing no ledger row by design.) Retiring each test's engagements in `afterEach` is what
   *  makes the counters mean "this test's spend". */
  const seededTenants: string[] = [];

  /** Every test gets its OWN company, so a sweep (which is platform-wide by nature) only ever sees
   *  the engagement that test seeded. Without this, engagements from earlier tests would be re-swept
   *  and the dispatch counts would depend on test order. */
  async function seed(
    toolScope: Record<string, unknown>,
    opts: {
      budgetUsd?: number;
      keywords?: string[];
      tracked?: boolean;
      engagementStatus?: string;
      propertyStatus?: string;
      enabledModules?: string[];
      /** Seed a prior rank capture this many hours ago (the "last capture" half of due-ness). */
      rankCapturedHoursAgo?: number;
      tenantId?: string;
      clientId?: string;
    } = {},
  ): Promise<Seeded> {
    const tenantId = opts.tenantId ?? (await createCompany(`SM54 Co ${seq++}`, opts.enabledModules ?? ["search"]));
    if (!seededTenants.includes(tenantId)) seededTenants.push(tenantId);
    const clientId = opts.clientId ?? (await createClient(tenantId, `SM54 Client ${seq++}`));
    const propertyId = newId();
    const engagementId = newId();
    const setId = newId();
    const keywordIds: string[] = [];
    const domain = `sm54-${Date.now()}-${seq++}.example.com`;

    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [propertyId, tenantId, clientId, domain, `https://${domain}`, opts.propertyStatus ?? "active", config.originSite],
        );
        await c.query(
          `INSERT INTO search_engagements
             (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            engagementId, tenantId, clientId, propertyId, `SM54 engagement ${seq++}`,
            JSON.stringify(toolScope), opts.budgetUsd ?? 100, opts.engagementStatus ?? "active", config.originSite,
          ],
        );
        await c.query(
          `INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name, origin_site) VALUES ($1,$2,$3,$4,$5)`,
          [setId, tenantId, engagementId, "SM54 set", config.originSite],
        );
        for (const kw of opts.keywords ?? ["alpha widget"]) {
          const id = newId();
          keywordIds.push(id);
          await c.query(
            `INSERT INTO search_keywords (id, tenant_id, set_id, keyword, locale, is_tracked, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, tenantId, setId, kw, "en-US", opts.tracked ?? true, config.originSite],
          );
        }
        if (opts.rankCapturedHoursAgo !== undefined) {
          await c.query(
            `INSERT INTO search_rank_snapshots
               (id, tenant_id, property_id, keyword_id, engine, device, captured_at, position, provider, simulated, origin_site)
             VALUES ($1,$2,$3,$4,'google','desktop', now() - ($5 || ' hours')::interval, 3, 'dataforseo', false, $6)`,
            [newId(), tenantId, propertyId, keywordIds[0], String(opts.rankCapturedHoursAgo), config.originSite],
          );
        }
      },
      { modules: ["search"] },
    );
    return { tenantId, clientId, propertyId, engagementId, setId, keywordIds };
  }

  async function ledger(s: Seeded): Promise<Array<{
    endpoint: string; cost_usd: string; status: string; requested_by: string | null; correlation_id: string | null;
  }>> {
    const r = await withTenants(
      [s.tenantId],
      (c) => c.query(
        `SELECT endpoint, cost_usd, status, requested_by, correlation_id
           FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at ASC, endpoint ASC`,
        [s.engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows as never;
  }

  async function snapshots(s: Seeded): Promise<number> {
    const r = await withTenants(
      [s.tenantId],
      (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM search_rank_snapshots WHERE property_id = $1`, [s.propertyId]),
      { modules: ["search"] },
    );
    return Number(r.rows[0].n);
  }

  async function activities(s: Seeded): Promise<Array<{ verb: string; actor_id: string | null; metadata: Record<string, unknown> }>> {
    const r = await withTenants(
      [s.tenantId],
      (c) => c.query(
        `SELECT verb, actor_id, metadata FROM activities
          WHERE target_entity_id = $1 AND verb = 'scheduled_pull' ORDER BY occurred_at ASC`,
        [s.engagementId],
      ),
    );
    return r.rows as never;
  }

  /** The tool leg of the LAST sweep outcome for this engagement. */
  function toolOf(result: Awaited<ReturnType<typeof runSearchPullSweep>>, s: Seeded, tool: string) {
    const o = result.outcomes.find((x) => x.engagementId === s.engagementId);
    return o?.tools.find((t) => t.tool === tool);
  }

  beforeAll(async () => {
    await initTestDb();
  });

  afterAll(async () => {
    resetProviders();
    config.search.providerMode = "live";
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviders();
    mock = new MockSearchProvider();
    registerProvider(mock);
    config.search.providerMode = "live";
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;
    config.search.pillars.seo = true;
    config.search.pillars.geo = true;
    resetGlobalMonthToDateCache();
  });

  afterEach(async () => {
    resetProviders();
    config.search.providerMode = "live";
    config.search.pillars.seo = true;
    config.search.pillars.geo = true;
    // Retire every engagement this file has seeded so far, so the next test's sweep sees only its own.
    for (const t of seededTenants) {
      await withTenants(
        [t],
        (c) => c.query(`UPDATE search_engagements SET status = 'closed' WHERE status = 'active'`),
        { modules: ["search"] },
      );
    }
  });

  // ── decision 1 + attribution ────────────────────────────────────────────────────────────────────
  it("DECISION 1 — a DUE engagement dispatches exactly one ledgered pull per tracked keyword, with §A13.2 attribution", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily", maxKeywords: 50 } }, {
      keywords: ["alpha widget", "beta widget"],
    });

    const result = await runSearchPullSweep();
    expect(result.skippedLocked).toBe(false);

    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("dispatched");
    expect(rank?.cadence).toBe("daily");
    expect(rank?.lastRunAt).toBeNull(); // first ever pull: nothing to be "since"
    expect(rank).toMatchObject({ attempted: 2, pulled: 2, skipped: 0, failed: 0 });

    // One real dispatch per keyword (rank pulls bypass the cache by design, so there is no
    // single-flight collapsing two distinct keywords).
    expect(mock.dispatchCount).toBe(2);
    expect(await snapshots(s)).toBe(2);

    const rows = await ledger(s);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // THE attribution assertion (§A13.2, verbatim): no human, no invented OBO automation user.
      expect(row.requested_by).toBeNull();
      expect(row.correlation_id).toBe("sched:rank");
      expect(row.endpoint).toBe("dataforseo.serp");
      expect(Number(row.cost_usd)).toBeGreaterThan(0);
    }

    // ONE activity row for the engagement-tick, actor NULL (system), carrying the tick's counters.
    const acts = await activities(s);
    expect(acts).toHaveLength(1);
    expect(acts[0].actor_id).toBeNull();
    expect(acts[0].metadata).toMatchObject({ scheduled: true, attempted: 2, pulled: 2, skipped: 0, failed: 0 });
  });

  it("an immediate SECOND sweep is a no-op — the capture it just wrote makes the tool not due", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });

    const first = await runSearchPullSweep();
    expect(toolOf(first, s, "rank")?.status).toBe("dispatched");
    expect(mock.dispatchCount).toBe(1);

    const second = await runSearchPullSweep();
    expect(toolOf(second, s, "rank")?.status).toBe("not_due");
    expect(toolOf(second, s, "rank")?.lastRunAt).not.toBeNull();
    // Nothing bought, nothing written, and no second activity row.
    expect(mock.dispatchCount).toBe(1);
    expect(await snapshots(s)).toBe(1);
    expect(await ledger(s)).toHaveLength(1);
    expect(await activities(s)).toHaveLength(1);
  });

  // ── decision 2 ──────────────────────────────────────────────────────────────────────────────────
  it("DECISION 2 — a NOT-YET-DUE engagement does not dispatch and spends nothing (P1 probe target)", async () => {
    // Weekly cadence, captured 48h ago => 2 days into a 7-day window.
    const s = await seed({ rank: { enabled: true, cadence: "weekly" } }, { rankCapturedHoursAgo: 48 });

    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("not_due");
    expect(rank?.reason).toContain("weekly");
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
    expect(await snapshots(s)).toBe(1); // only the seeded prior capture
    expect(await activities(s)).toHaveLength(0);
    expect(result.notDue).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBe(0);
  });

  it("cadence comes from tool_scope, not from a hardcoded schedule: the SAME 48h-old capture is due daily and not due weekly", async () => {
    const weekly = await seed({ rank: { enabled: true, cadence: "weekly" } }, { rankCapturedHoursAgo: 48 });
    const daily = await seed({ rank: { enabled: true, cadence: "daily" } }, { rankCapturedHoursAgo: 48 });

    const result = await runSearchPullSweep();
    expect(toolOf(result, weekly, "rank")?.status).toBe("not_due");
    expect(toolOf(result, daily, "rank")?.status).toBe("dispatched");
    // Exactly one of the two engagements bought anything.
    expect(mock.dispatchCount).toBe(1);
  });

  // ── decision 3 ──────────────────────────────────────────────────────────────────────────────────
  it("DECISION 3 — a DISABLED toggle is refused NAMING the toggle, with no dispatch and NO refusal ledger row (P2 probe target)", async () => {
    const s = await seed({
      rank: { enabled: false, cadence: "daily" },
      backlinks: { enabled: true, cadence: "monthly" },
    });

    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("disabled");
    // "Naming the toggle" is the whole point of the refusal — an operator has to be told WHICH switch.
    expect(rank?.reason).toContain("rank");
    expect(rank?.detail).toBe("rank");

    // The enabled sibling still ran, so this is a per-TOOL refusal and not a whole-engagement skip.
    expect(toolOf(result, s, "backlinks")?.status).toBe("dispatched");

    // Zero rank spend AND zero `rank.scope_disabled` rows: a disabled tool is never selected, so the
    // choke-point is never even asked (§SM-54 item 2: "no dispatch, no refusal row").
    const rows = await ledger(s);
    expect(rows.filter((r) => r.correlation_id === "sched:rank")).toHaveLength(0);
    expect(rows.every((r) => !r.endpoint.includes("scope_disabled"))).toBe(true);
    expect(await snapshots(s)).toBe(0);
  });

  it("every tool disabled => the engagement is visited and nothing at all is dispatched", async () => {
    const s = await seed({ rank: { enabled: false }, volume: { enabled: false }, backlinks: { enabled: false }, ai_visibility: { enabled: false } });
    const result = await runSearchPullSweep();
    const o = result.outcomes.find((x) => x.engagementId === s.engagementId);
    expect(o?.tools.every((t) => t.status === "disabled")).toBe(true);
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
    expect(await activities(s)).toHaveLength(0);
  });

  it("an engagement with NO tool_scope at all is inert (an empty config authorizes nothing)", async () => {
    const s = await seed({});
    const result = await runSearchPullSweep();
    const o = result.outcomes.find((x) => x.engagementId === s.engagementId);
    expect(o?.tools.map((t) => t.status)).toEqual(["disabled", "disabled", "disabled", "disabled"]);
    expect(mock.dispatchCount).toBe(0);
  });

  // ── SM-61 (tracker §6au Ruling 1 clause 1, binding) ────────────────────────────────────────────
  it("SM-61 — a cadence-less ENABLED tool ticks `on_demand`: no dispatch, no ledger row, no activity row, counted in SweepResult.onDemand (REQUIRED PROBE 1 target: a treat-null-as-weekly mutation must turn this red)", async () => {
    const s = await seed({ rank: { enabled: true } }); // enabled, cadence key entirely absent
    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("on_demand");
    expect(rank?.cadence).toBeNull();
    expect(rank?.reason).toContain("rank");
    // The precise property a "treat absent cadence as weekly" mutation would break: NOTHING is
    // dispatched, ever, for this engagement — not now (lastRunAt is null, so a weekly-default isDue
    // would read this as immediately due and WOULD dispatch).
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
    expect(await snapshots(s)).toBe(0);
    expect(await activities(s)).toHaveLength(0);
    expect(result.onDemand).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBe(0);
    expect(result.notDue).toBe(0);
  });

  it("SM-61 — a JUNK cadence on an enabled tool also ticks `on_demand`, never a guessed schedule", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "fortnightly" } });
    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("on_demand");
    expect(rank?.cadence).toBeNull(); // junk parses to null, identically to absent
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
  });

  it("SM-61 — on_demand is a STABLE outcome across repeated sweeps (never self-heals into a dispatch on its own, since nothing here ever schedules it)", async () => {
    const s = await seed({ rank: { enabled: true } });
    const first = await runSearchPullSweep();
    expect(toolOf(first, s, "rank")?.status).toBe("on_demand");
    const second = await runSearchPullSweep();
    expect(toolOf(second, s, "rank")?.status).toBe("on_demand");
    expect(mock.dispatchCount).toBe(0);
  });

  it("SM-61 — on_demand is counted SEPARATELY from disabled: one tool of each in the same tick", async () => {
    const s = await seed({
      rank: { enabled: true }, // on-demand: enabled, no cadence
      volume: { enabled: false }, // disabled: toggle off
    });
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "rank")?.status).toBe("on_demand");
    expect(toolOf(result, s, "volume")?.status).toBe("disabled");
    expect(result.onDemand).toBeGreaterThanOrEqual(1);
    expect(result.disabled).toBeGreaterThanOrEqual(1);
  });

  // ── decision 4 ──────────────────────────────────────────────────────────────────────────────────
  it("DECISION 4 — an OVER-BUDGET engagement is refused with budget_exceeded, and the refusal CONSUMES the cadence window (zero retry, P4 probe target)", async () => {
    // Engagement cap far below one SERP estimate ($0.0006 on the mock's rate table).
    const s = await seed({ rank: { enabled: true, cadence: "daily" } }, { budgetUsd: 0.0001 });

    const first = await runSearchPullSweep();
    const rank = toolOf(first, s, "rank");
    expect(rank?.status).toBe("refused");
    expect(rank?.reason).toBe("budget_exceeded");
    // `reason` is the choke-point CODE, lifted back out of the batch result — see classifyBatch's
    // header for why a batch refusal must not read as `dispatched` to an unattended caller. The
    // breached TIER only survives on the throwing (single-item) path; asserted in the backlinks test.
    expect(rank?.attempted).toBe(1);
    expect(rank?.pulled).toBe(0);
    expect(await snapshots(s)).toBe(0);

    // The choke-point's own $0 refusal row, attributed to the scheduler.
    const rows = await ledger(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toContain("budget_blocked");
    expect(Number(rows[0].cost_usd)).toBe(0);
    expect(rows[0].requested_by).toBeNull();
    expect(rows[0].correlation_id).toBe("sched:rank");

    // ZERO RETRY. The refused attempt consumed its daily window, so the next sweep does NOT re-attempt
    // — the failure is visible in the ledger and self-heals at the next window instead of looping.
    const second = await runSearchPullSweep();
    expect(toolOf(second, s, "rank")?.status).toBe("not_due");
    expect(await ledger(s)).toHaveLength(1);
    expect(mock.dispatchCount).toBe(0); // never reached the vendor at all
  });

  it("a mid-sweep refusal never aborts another engagement's tick", async () => {
    const broke = await seed({ rank: { enabled: true, cadence: "daily" } }, { budgetUsd: 0.0001 });
    const funded = await seed({ rank: { enabled: true, cadence: "daily" } }, { budgetUsd: 100 });

    const result = await runSearchPullSweep();
    expect(toolOf(result, broke, "rank")?.status).toBe("refused");
    expect(toolOf(result, funded, "rank")?.status).toBe("dispatched");
    expect(await snapshots(funded)).toBe(1);
    expect(result.refused).toBeGreaterThanOrEqual(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0); // a refusal is an outcome, not an error
  });

  it("a single-item (throwing) pull surfaces the breached TIER, not just the code — backlinks over budget", async () => {
    const s = await seed({ backlinks: { enabled: true, cadence: "monthly" } }, { budgetUsd: 0.0001 });
    const result = await runSearchPullSweep();
    const bl = toolOf(result, s, "backlinks");
    expect(bl?.status).toBe("refused");
    expect(bl?.reason).toBe("budget_exceeded");
    expect(bl?.detail).toContain("engagement"); // the tier the stop-loss cascade broke on
    expect(mock.dispatchCount).toBe(0);
  });

  it("the pillar kill switch outranks a due, enabled, funded engagement", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    config.search.pillars.seo = false;

    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "rank")?.status).toBe("refused");
    expect(toolOf(result, s, "rank")?.reason).toBe("pillar_disabled");
    expect(mock.dispatchCount).toBe(0);
    // No ledger row for a pillar refusal (dispatch.ts's own documented behaviour), which is WHY a
    // pillar-disabled tool is re-asked next tick rather than backing off for a whole window.
    expect(await ledger(s)).toHaveLength(0);
  });

  // ── decision 5 ──────────────────────────────────────────────────────────────────────────────────
  it("DECISION 5 — two OVERLAPPING sweeps dispatch exactly once; the loser is `skippedLocked` (P3 probe target)", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    // Hold the first sweep inside its dispatch long enough that the second is guaranteed to find the
    // advisory lock taken. This is the race SM-15 called out honestly: `bypassCache: true` means there
    // is NO cache single-flight to fall back on, and dispatch's advisory lock serializes without
    // deduping the charge — so if both sweeps ran, both would buy.
    mock.delayMs = 400;

    const [a, b] = await Promise.all([runSearchPullSweep(), runSearchPullSweep()]);
    const winners = [a, b].filter((r) => !r.skippedLocked);
    const losers = [a, b].filter((r) => r.skippedLocked);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser touched NOTHING — no tenant walk, no outcome, no spend.
    expect(losers[0]).toMatchObject({ tenants: 0, engagements: 0, dispatched: 0, outcomes: [] });

    expect(toolOf(winners[0], s, "rank")?.status).toBe("dispatched");
    // The proof that matters: ONE vendor call, ONE ledger row, ONE snapshot for one due window.
    expect(mock.dispatchCount).toBe(1);
    expect(await ledger(s)).toHaveLength(1);
    expect(await snapshots(s)).toBe(1);
  });

  it("the lock is RELEASED after a sweep (a later sweep is never permanently locked out)", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    const first = await runSearchPullSweep();
    expect(first.skippedLocked).toBe(false);
    const second = await runSearchPullSweep();
    expect(second.skippedLocked).toBe(false); // acquired again, just found nothing due
    expect(toolOf(second, s, "rank")?.status).toBe("not_due");
  });

  // ── selection scope ─────────────────────────────────────────────────────────────────────────────
  it("a tenant WITHOUT the search module is never swept, even with a due enabled engagement", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } }, { enabledModules: [] });
    const result = await runSearchPullSweep();
    expect(result.outcomes.find((x) => x.engagementId === s.engagementId)).toBeUndefined();
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
  });

  it("a non-active engagement and a non-active property are both excluded from unattended spend", async () => {
    const paused = await seed({ rank: { enabled: true, cadence: "daily" } }, { engagementStatus: "paused" });
    const draft = await seed({ rank: { enabled: true, cadence: "daily" } }, { engagementStatus: "draft" });
    const archived = await seed({ rank: { enabled: true, cadence: "daily" } }, { propertyStatus: "archived" });

    const result = await runSearchPullSweep();
    for (const s of [paused, draft, archived]) {
      expect(result.outcomes.find((x) => x.engagementId === s.engagementId)).toBeUndefined();
      expect(await ledger(s)).toHaveLength(0);
    }
    expect(mock.dispatchCount).toBe(0);
  });

  it("a due, enabled rank tool with NO tracked keywords is `no_work`, not a dispatch", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } }, { tracked: false });
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "rank")?.status).toBe("no_work");
    expect(mock.dispatchCount).toBe(0);
    expect(await ledger(s)).toHaveLength(0);
    expect(await activities(s)).toHaveLength(0);
  });

  it("a due, enabled ai_visibility tool with an empty scope query list is `no_work` (WHAT is pulled is scope-driven too)", async () => {
    const s = await seed({ ai_visibility: { enabled: true, cadence: "weekly", queries: [] } });
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "ai_visibility")?.status).toBe("no_work");
    expect(mock.dispatchCount).toBe(0);
  });

  // ── spend bounding ──────────────────────────────────────────────────────────────────────────────
  it("maxKeywords bounds ONE tick's spend to what the scope panel projected, and records the truncation", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily", maxKeywords: 2 } }, {
      keywords: ["k1", "k2", "k3", "k4", "k5"],
    });

    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    expect(rank?.status).toBe("dispatched");
    expect(rank).toMatchObject({ attempted: 2, pulled: 2, eligible: 5, limit: 2 });
    expect(mock.dispatchCount).toBe(2); // NOT 5
    expect(await ledger(s)).toHaveLength(2);
    // The deliberate under-pull is visible in the activity row, not silent.
    expect((await activities(s))[0].metadata).toMatchObject({
      tools: [{ tool: "rank", eligible: 5, limit: 2 }],
    });
  });

  it("maxQueries bounds an ai_visibility tick the same way", async () => {
    const s = await seed({
      ai_visibility: { enabled: true, cadence: "weekly", queries: ["q1", "q2", "q3", "q4"], maxQueries: 1 },
    });
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "ai_visibility")).toMatchObject({ status: "dispatched", attempted: 1, eligible: 4, limit: 1 });
    expect(mock.dispatchCount).toBe(1);
  });

  // ── multi-tool + the metrics refresh ────────────────────────────────────────────────────────────
  it("all four tools run off their own toggles and cadences in ONE engagement tick, each with its own correlation id", async () => {
    const s = await seed({
      rank: { enabled: true, cadence: "daily", maxKeywords: 10 },
      volume: { enabled: true, cadence: "monthly", maxKeywords: 10 },
      backlinks: { enabled: true, cadence: "monthly" },
      ai_visibility: { enabled: true, cadence: "weekly", queries: ["who makes alpha widgets"] },
    });

    const result = await runSearchPullSweep();
    const o = result.outcomes.find((x) => x.engagementId === s.engagementId);
    expect(o?.tools.map((t) => t.status)).toEqual(["dispatched", "dispatched", "dispatched", "dispatched"]);

    const rows = await ledger(s);
    const byCorrelation = new Set(rows.map((r) => r.correlation_id));
    expect(byCorrelation).toEqual(new Set(["sched:rank", "sched:volume", "sched:backlinks", "sched:ai_visibility"]));
    expect(rows.every((r) => r.requested_by === null)).toBe(true);

    // The metrics refresh actually wrote through (its "last capture" stamp is metrics_fetched_at).
    const kw = await withTenants(
      [s.tenantId],
      (c) => c.query<{ metrics_fetched_at: Date | null; metrics_provider: string | null }>(
        `SELECT metrics_fetched_at, metrics_provider FROM search_keywords WHERE id = $1`, [s.keywordIds[0]],
      ),
      { modules: ["search"] },
    );
    expect(kw.rows[0].metrics_fetched_at).not.toBeNull();
    expect(kw.rows[0].metrics_provider).toBe("dataforseo");

    // ONE activity row for the whole engagement-tick, listing all four tools.
    const acts = await activities(s);
    expect(acts).toHaveLength(1);
    expect((acts[0].metadata as { tools: unknown[] }).tools).toHaveLength(4);

    // And the tick is now idempotent-by-cadence across every tool.
    const second = await runSearchPullSweep();
    const o2 = second.outcomes.find((x) => x.engagementId === s.engagementId);
    expect(o2?.tools.map((t) => t.status)).toEqual(["not_due", "not_due", "not_due", "not_due"]);
  });

  it("a scheduled cadence is NOT satisfied by a manual pull's ledger row (correlation ids are disjoint)", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    // A manual pull's ledger row, attributed to a human-ish correlation id and no capture written.
    await withTenants(
      [s.tenantId],
      (c) => c.query(
        `INSERT INTO search_provider_calls
           (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit, status,
            requested_by, correlation_id, origin_site, simulated)
         VALUES ($1,$2,$3,$4,'dataforseo','dataforseo.serp',1,0.0006,false,'completed',NULL,'manual-run-1',$5,false)`,
        [newId(), s.tenantId, s.engagementId, s.propertyId, config.originSite],
      ),
      { modules: ["search"] },
    );

    const result = await runSearchPullSweep();
    // Still due: the scheduler's window is consumed only by ITS OWN attempts or by a real capture.
    expect(toolOf(result, s, "rank")?.status).toBe("dispatched");
  });

  // ── the loop wrapper ────────────────────────────────────────────────────────────────────────────
  it("the loop is a chained setTimeout with a working stop(): stop() prevents any further tick", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    const handle = startSearchPullSchedulerLoop(20);
    // Wait for the first tick's capture rather than guessing a duration (a live-PG sweep is ~300ms and
    // this box has already had Postgres in recovery today — a fixed sleep here is a flake generator).
    const deadline = Date.now() + 10_000;
    while ((await snapshots(s)) === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    handle.stop();
    const afterStop = await snapshots(s);
    expect(afterStop).toBe(1); // exactly one capture: the tool became not-due after the first tick
    // stop() must prevent every FURTHER tick — with a 20ms interval, several would have fired by now.
    await new Promise((r) => setTimeout(r, 300));
    expect(await snapshots(s)).toBe(afterStop);
    expect(await ledger(s)).toHaveLength(1);
  });
});
