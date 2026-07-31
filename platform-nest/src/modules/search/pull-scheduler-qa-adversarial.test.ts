// ⚡ QA gate adversarial probes for SM-54 (tracker §6at + gate instructions). SM-54's own six
// mutation probes all attack ITS decision logic (due-ness, toggle gate, lock, attempt-half of
// lastRunAt, correlationId, scope-limit truncation) — this file deliberately attacks boundaries
// its author had no reason to probe (§6ak's lesson: a probe suite shares its blind spots with the
// design that produced it). Five families, each named in the QA brief:
//   1. the loop<->module-function seam (classifyBatch on a MIXED batch)
//   2. time (clock backwards, cadence casing, the GREATEST merge with only one half present)
//   3. multi-tenancy under a no-principal loop (cross-tenant read/write foreclosure)
//   4. the activity/attribution row (every row, including a throwing single-item refusal)
//   5. PillarDisabledError's non-consuming re-ask, and the lock surviving stop()
//
// No product code is modified by this file. Any ledger/snapshot/activity rows written by these
// tests are torn down in afterEach exactly like the sibling suite (pull-scheduler.test.ts).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createClient, createCompany } from "../../testing/fixtures";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { resetGlobalMonthToDateCache } from "./providers/ledger";
import { isDue, runSearchPullSweep, startSearchPullSchedulerLoop } from "./pull-scheduler";
import { parseCadence } from "./cadence";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// FAMILY 2 (part) — pure time arithmetic, no DB needed.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("SM-54 adversarial · time — pure", () => {
  it("ATTACK: clock goes backwards (lastRunAt in the FUTURE relative to now) — must NOT be due", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    const future = new Date("2026-07-31T12:00:00Z"); // 24h in the future
    // now.getTime() - lastRunAt.getTime() is negative here; a due-ness check that used Math.abs(),
    // or that failed to handle a negative diff, would fire on a clock skew or a corrected system
    // clock — which on THIS money path means an extra unbudgeted vendor call.
    expect(isDue(now, future, "daily")).toBe(false);
    // Even a wildly-future lastRunAt (e.g. a bad system clock earlier that has since been fixed)
    // must never be treated as "so overdue it's due" — the arithmetic must stay monotonic in the
    // safe (never-fire) direction for any negative delta, not just a small one.
    const farFuture = new Date("2027-01-01T00:00:00Z");
    expect(isDue(now, farFuture, "monthly")).toBe(false);
  });

  it("ATTACK (SM-61, §6au SUPERSEDES this attack's original claim): cadence casing/whitespace variants must resolve to ON-DEMAND, never to a guessed schedule of ANY kind — not `daily`, and no longer a weekly default either", () => {
    // This file's own original claim (pre-SM-61) was "casing/whitespace junk falls to the SAFE
    // default (weekly), never to `daily`". §6au overturned that: there is no default any more, safe
    // or otherwise. A caller who wrote "Daily", "DAILY", " daily", or "daily " (any of which a
    // hand-edited tool_scope JSON blob could contain) must resolve to `null` (on-demand) — no
    // schedule at all — which is now the ONLY fail-safe direction on this money path; the "conservative
    // default" this attack used to require IS the SM-61 defect (a cadence-less/junk-cadence tool
    // scheduled unattended spend a human never priced).
    for (const variant of ["Daily", "DAILY", " daily", "daily ", "Weekly", "MONTHLY", "\tdaily\n"]) {
      expect(parseCadence(variant)).toBeNull();
    }
  });

  it("ATTACK: a daily tool cannot be made to fire 31 times across a 30-day month by walking isDue tick-by-tick", () => {
    // Operationalizes the file header's own claim ("no early-fire tolerance ... a daily tool
    // fires up to 31 times a month instead of 30" is the failure this is supposed to foreclose).
    // Simulate an hourly poller for 31 days and count how many times isDue would have fired,
    // always advancing lastRunAt to the tick that fired (as the real loop does via a fresh capture).
    let lastRunAt: Date | null = null;
    let fires = 0;
    const start = new Date("2026-01-01T00:00:00Z").getTime();
    for (let h = 0; h < 31 * 24; h++) {
      const now = new Date(start + h * 3600 * 1000);
      if (isDue(now, lastRunAt, "daily")) {
        fires += 1;
        lastRunAt = now;
      }
    }
    expect(fires).toBeLessThanOrEqual(31); // 31 whole days elapsed, so <=31 is the loose bound
    // The tighter, real claim: at most one fire per 24h window, so across 31*24h it cannot exceed 31,
    // and in practice (hourly granularity, no drift) it lands at exactly 31 — never 32+.
    expect(fires).toBe(31);
  });

  it("ATTACK: absent capture + present (recent) attempt is NOT due; present capture + absent attempt uses the capture", () => {
    const now = new Date("2026-07-30T12:00:00Z");
    // loadLastRuns's GREATEST logic collapses to a single Date | null before isDue ever runs, so the
    // pure function only sees the merged result — but both inputs to that merge must independently
    // suppress a false "due". Exercise both legs of the ternary directly.
    const recentAttemptOnly = now; // GREATEST(null, now) = now
    expect(isDue(now, recentAttemptOnly, "daily")).toBe(false);
    const staleCaptureOnly = new Date(now.getTime() - 40 * 3600 * 1000); // 40h ago, no attempt
    expect(isDue(now, staleCaptureOnly, "daily")).toBe(true); // 40h > 24h daily window
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Live-Postgres probes.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
interface Seeded {
  tenantId: string;
  clientId: string;
  propertyId: string;
  engagementId: string;
  setId: string;
  keywordIds: string[];
}

describe.skipIf(!TEST_URL)("SM-54 adversarial · live PG", () => {
  let mock: MockSearchProvider;
  let seq = 0;
  const seededTenants: string[] = [];

  async function seed(
    toolScope: Record<string, unknown>,
    opts: {
      budgetUsd?: number;
      keywords?: string[];
      enabledModules?: string[];
      tenantId?: string;
      clientId?: string;
    } = {},
  ): Promise<Seeded> {
    const tenantId = opts.tenantId ?? (await createCompany(`SM54-QA Co ${seq++}`, opts.enabledModules ?? ["search"]));
    if (!seededTenants.includes(tenantId)) seededTenants.push(tenantId);
    const clientId = opts.clientId ?? (await createClient(tenantId, `SM54-QA Client ${seq++}`));
    const propertyId = newId();
    const engagementId = newId();
    const setId = newId();
    const keywordIds: string[] = [];
    const domain = `sm54qa-${Date.now()}-${seq++}.example.com`;

    await withTenants(
      [tenantId],
      async (c) => {
        await c.query(
          `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,'active',$6)`,
          [propertyId, tenantId, clientId, domain, `https://${domain}`, config.originSite],
        );
        await c.query(
          `INSERT INTO search_engagements
             (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
          [
            engagementId, tenantId, clientId, propertyId, `SM54-QA engagement ${seq++}`,
            JSON.stringify(toolScope), opts.budgetUsd ?? 100, config.originSite,
          ],
        );
        await c.query(
          `INSERT INTO search_keyword_sets (id, tenant_id, engagement_id, name, origin_site) VALUES ($1,$2,$3,$4,$5)`,
          [setId, tenantId, engagementId, "SM54-QA set", config.originSite],
        );
        for (const kw of opts.keywords ?? ["alpha widget"]) {
          const id = newId();
          keywordIds.push(id);
          await c.query(
            `INSERT INTO search_keywords (id, tenant_id, set_id, keyword, locale, is_tracked, origin_site)
             VALUES ($1,$2,$3,$4,'en-US',true,$5)`,
            [id, tenantId, setId, kw, config.originSite],
          );
        }
      },
      { modules: ["search"] },
    );
    return { tenantId, clientId, propertyId, engagementId, setId, keywordIds };
  }

  async function ledger(s: Seeded) {
    const r = await withTenants(
      [s.tenantId],
      (c) => c.query<{
        endpoint: string; cost_usd: string; status: string; requested_by: string | null; correlation_id: string | null;
      }>(
        `SELECT endpoint, cost_usd, status, requested_by, correlation_id
           FROM search_provider_calls WHERE engagement_id = $1 ORDER BY created_at ASC, endpoint ASC`,
        [s.engagementId],
      ),
      { modules: ["search"] },
    );
    return r.rows;
  }

  async function activities(s: Seeded) {
    const r = await withTenants(
      [s.tenantId],
      (c) => c.query<{ verb: string; actor_id: string | null; metadata: Record<string, unknown> }>(
        `SELECT verb, actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = 'scheduled_pull' ORDER BY occurred_at ASC`,
        [s.engagementId],
      ),
    );
    return r.rows;
  }

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
    for (const t of seededTenants) {
      await withTenants([t], (c) => c.query(`UPDATE search_engagements SET status = 'closed' WHERE status = 'active'`), {
        modules: ["search"],
      });
    }
  });

  // ── FAMILY 1 — the loop<->module-function seam: classifyBatch on a MIXED batch ─────────────────
  it("ATTACK: a MIXED batch (one pulled, one refused) must classify as `dispatched` with the refusal carried in `detail`, never as a clean `refused` or a silent `dispatched`", async () => {
    // k1 < k2 alphabetically (ORDER BY keyword ASC), budget covers exactly one $0.0006 SERP pull.
    const s = await seed({ rank: { enabled: true, cadence: "daily" } }, {
      keywords: ["k1-alpha", "k2-beta"],
      budgetUsd: 0.001, // one pull (0.0006) fits; a second (0.0012 cumulative) does not
    });

    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    // The lie this attacks in EITHER direction: classifying this as `refused` would hide that money
    // WAS spent (pulled:1); classifying it as `dispatched` with no `detail` would hide that the
    // remainder was refused, not merely "not yet gotten to".
    expect(rank?.status).toBe("dispatched");
    expect(rank).toMatchObject({ attempted: 2, pulled: 1, skipped: 1, failed: 0 });
    expect(rank?.detail).toContain("budget_exceeded");

    const rows = await ledger(s);
    expect(rows).toHaveLength(2); // one real charge, one $0 refusal row
    const costRows = rows.filter((r) => Number(r.cost_usd) > 0);
    const zeroRows = rows.filter((r) => Number(r.cost_usd) === 0);
    expect(costRows).toHaveLength(1);
    expect(zeroRows).toHaveLength(1);
    // Attribution holds on BOTH rows of a mixed batch, not just the successful one.
    for (const row of rows) {
      expect(row.requested_by).toBeNull();
      expect(row.correlation_id).toBe("sched:rank");
    }

    // The window was consumed (a capture WAS written), so the next sweep must not retry the refused
    // remainder — SM-54 item 5, but specifically exercised on the MIXED shape, not the pure-refusal one.
    const second = await runSearchPullSweep();
    expect(toolOf(second, s, "rank")?.status).toBe("not_due");
    expect(await ledger(s)).toHaveLength(2); // unchanged
  });

  it("ATTACK: a batch with NO refusal and NO successful pull (a plain per-item exception) must classify as `failed`, never `dispatched`", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } }, { keywords: ["only-keyword"] });
    const boom = new Error("mock: malformed provider response");
    const original = mock.postSerpTasks.bind(mock);
    mock.postSerpTasks = async () => {
      throw boom;
    };

    const result = await runSearchPullSweep();
    const rank = toolOf(result, s, "rank");
    // This is the OTHER direction of the same lie classifyBatch exists to prevent: pulled===0 here
    // for a reason that is NOT a choke-point refusal (no ProviderDispatchError was thrown), so
    // reporting `dispatched` (nothing to detail) or `refused` (no refusal code exists) would both
    // misdescribe a hard fault as something the choke-point decided.
    expect(rank?.status).toBe("failed");
    expect(rank?.reason).toContain("malformed provider response");
    expect(rank).toMatchObject({ pulled: 0, skipped: 0, failed: 1 });
    // A hard failure writes NO ledger row (invokeProvider rejected before any charge point) — the
    // transaction rolled back with nothing to compensate, unlike SM-50/60's post-success class.
    expect(await ledger(s)).toHaveLength(0);
    expect(mock.dispatchCount).toBe(0); // tick() is inside postSerpTasks; it never ran
    mock.postSerpTasks = original;

    // A `failed` tick still consumes NOTHING per SM-54 item 5's zero-retry rule only for REFUSALS —
    // verify a genuine failure is NOT given the same non-retry treatment as a refusal: since no
    // ledger attempt row and no capture were written, the next sweep must retry (self-heal), which is
    // the correct behaviour for a transient fault as opposed to a standing budget/scope refusal.
    mock.dispatchCount = 0;
    const second = await runSearchPullSweep();
    expect(toolOf(second, s, "rank")?.status).toBe("dispatched"); // retried successfully this time
    expect(mock.dispatchCount).toBe(1);
  });

  it("ATTACK: an all-`absent` metrics batch (provider returns nothing for every keyword) still classifies `dispatched` — money WAS spent even though nothing was `updated`", async () => {
    const s = await seed({ volume: { enabled: true, cadence: "daily" } }, { keywords: ["k1", "k2"] });
    mock.getKeywordMetrics = async (kws) => kws.map(() => undefined as never).filter(Boolean); // always []

    const result = await runSearchPullSweep();
    const vol = toolOf(result, s, "volume");
    // Documented as intentional in pull-scheduler.ts's own comment (line ~411): an all-absent batch
    // DID dispatch and DID spend (attempted=2), so `dispatched` is the honest classification even
    // though `pulled` (mapped from `updated`) is 0. The attack: verify this reads as intentional
    // behaviour, not as classifyBatch accidentally reporting "nothing happened" as success — the
    // ledger must show real charges for both attempted items.
    expect(vol?.status).toBe("dispatched");
    expect(vol).toMatchObject({ attempted: 2, pulled: 0 });
    const rows = await ledger(s);
    expect(rows.filter((r) => r.endpoint === "dataforseo.volume")).toHaveLength(2);
    expect(rows.every((r) => Number(r.cost_usd) > 0)).toBe(true);
  });

  it("ATTACK: a plain-Error throw from a SINGLE-ITEM pull (backlinks — no internal try/catch of its own) must classify `failed`, not `refused` — this is the outer catch's OWN instanceof discriminator, not classifyBatch's", async () => {
    // Unlike rank/volume/ai_visibility (batch functions with their own internal ProviderDispatchError
    // catch), `pullBacklinksForProperty` has none — a plain throw propagates all the way up to
    // tickEngagement's own `catch (err) { if (err instanceof ProviderDispatchError) ... else ... }`.
    // That is the ONE place in this file where the refused/failed distinction is decided by a type
    // check rather than by classifyBatch, and it is untouched by any of SM-54's own six probes.
    const s = await seed({ backlinks: { enabled: true, cadence: "monthly" } });
    const boom = new Error("mock: backlink summary malformed");
    const original = mock.getBacklinkSummary.bind(mock);
    mock.getBacklinkSummary = async () => {
      throw boom;
    };

    const result = await runSearchPullSweep();
    const bl = toolOf(result, s, "backlinks");
    expect(bl?.status).toBe("failed");
    expect(bl?.reason).toContain("malformed");
    expect(await ledger(s)).toHaveLength(0); // no charge point reached
    mock.getBacklinkSummary = original;
  });

  // ── FAMILY 2 (DB half) — the GREATEST(capture, attempt) merge, explicitly ─────────────────────
  it("ATTACK: a STALE capture with a RECENT scheduler attempt (both present) must not be due — the attempt half must win over an older capture", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    // Stale capture: 40h ago (would be due for `daily` alone).
    await withTenants(
      [s.tenantId],
      (c) => c.query(
        `INSERT INTO search_rank_snapshots (id, tenant_id, property_id, keyword_id, engine, device, captured_at, position, provider, simulated, origin_site)
         VALUES ($1,$2,$3,$4,'google','desktop', now() - interval '40 hours', 5, 'dataforseo', false, $5)`,
        [newId(), s.tenantId, s.propertyId, s.keywordIds[0], config.originSite],
      ),
      { modules: ["search"] },
    );
    // Recent scheduler ATTEMPT (a refusal row) 1h ago, same correlation id the sweep reads.
    await withTenants(
      [s.tenantId],
      (c) => c.query(
        `INSERT INTO search_provider_calls
           (id, tenant_id, engagement_id, property_id, provider, endpoint, items, cost_usd, cache_hit, status,
            requested_by, correlation_id, origin_site, simulated, created_at)
         VALUES ($1,$2,$3,$4,'dataforseo','dataforseo.serp.budget_blocked',0,0,false,'failed',
                 NULL,'sched:rank',$5,false, now() - interval '1 hour')`,
        [newId(), s.tenantId, s.engagementId, s.propertyId, config.originSite],
      ),
      { modules: ["search"] },
    );

    const result = await runSearchPullSweep();
    // If the merge used ONLY the capture (ignoring the more recent attempt), this would be `dispatched`
    // (40h > 24h). GREATEST must pick the 1h-old attempt, which is inside the daily window.
    expect(toolOf(result, s, "rank")?.status).toBe("not_due");
    expect(mock.dispatchCount).toBe(0);
  });

  // ── FAMILY 3 — multi-tenancy under a no-principal loop ──────────────────────────────────────────
  it("ATTACK: a sweep dispatching tenant A's engagement writes NOTHING readable under tenant B's RLS context, even when B queries A's own engagementId", async () => {
    const a = await seed({ rank: { enabled: true, cadence: "daily" } });
    const b = await seed({ rank: { enabled: true, cadence: "daily" } });

    await runSearchPullSweep();
    expect(await ledger(a)).toHaveLength(1);
    expect(await ledger(b)).toHaveLength(1);

    // The attack: authenticate as tenant B, ask for tenant A's engagement id by name. RLS must
    // foreclose this — zero rows, not a filtered "your data doesn't match" empty result that could
    // in principle be bypassed by a different query shape.
    const crossRead = await withTenants(
      [b.tenantId],
      (c) => c.query(`SELECT * FROM search_provider_calls WHERE engagement_id = $1`, [a.engagementId]),
      { modules: ["search"] },
    );
    expect(crossRead.rows).toHaveLength(0);

    const crossSnapshots = await withTenants(
      [b.tenantId],
      (c) => c.query(`SELECT * FROM search_rank_snapshots WHERE property_id = $1`, [a.propertyId]),
      { modules: ["search"] },
    );
    expect(crossSnapshots.rows).toHaveLength(0);

    const crossActivity = await withTenants(
      [b.tenantId],
      (c) => c.query(`SELECT * FROM activities WHERE target_entity_id = $1`, [a.engagementId]),
    );
    expect(crossActivity.rows).toHaveLength(0);
  });

  it("ATTACK: one tenant with search DISABLED sitting between two enabled tenants (alphabetically) does not abort or skip its neighbours", async () => {
    // createCompany names are used for ordering by created_at, not name, but seeding sequentially
    // guarantees disabled-tenant is visited mid-sweep among enabled ones (company list order = creation order).
    const before = await seed({ rank: { enabled: true, cadence: "daily" } });
    const disabled = await seed({ rank: { enabled: true, cadence: "daily" } }, { enabledModules: [] });
    const after = await seed({ rank: { enabled: true, cadence: "daily" } });

    const result = await runSearchPullSweep();
    expect(toolOf(result, before, "rank")?.status).toBe("dispatched");
    expect(toolOf(result, after, "rank")?.status).toBe("dispatched");
    expect(result.outcomes.find((o) => o.engagementId === disabled.engagementId)).toBeUndefined();
    expect(await ledger(disabled)).toHaveLength(0);
    expect(mock.dispatchCount).toBe(2); // before + after only
  });

  // ── FAMILY 4 — the activity/attribution row on every outcome, including a throwing single-item refusal ─
  it("ATTACK: a THROWING single-item refusal (backlinks, over budget) still gets the same attribution + activity treatment as a batch refusal", async () => {
    const s = await seed({ backlinks: { enabled: true, cadence: "monthly" } }, { budgetUsd: 0.0001 });
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "backlinks")?.status).toBe("refused");

    const rows = await ledger(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by).toBeNull();
    expect(rows[0].correlation_id).toBe("sched:backlinks");

    const acts = await activities(s);
    expect(acts).toHaveLength(1);
    expect(acts[0].actor_id).toBeNull();
    expect((acts[0].metadata as { tools: Array<{ tool: string; status: string }> }).tools).toEqual([
      expect.objectContaining({ tool: "backlinks", status: "refused" }),
    ]);
  });

  it("ATTACK: ai_visibility's refusal (budget) carries the same NULL/sched: attribution as rank's", async () => {
    const s = await seed(
      { ai_visibility: { enabled: true, cadence: "weekly", queries: ["who makes widgets"] } },
      { budgetUsd: 0.0001 },
    );
    const result = await runSearchPullSweep();
    expect(toolOf(result, s, "ai_visibility")?.status).toBe("refused");
    const rows = await ledger(s);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.requested_by).toBeNull();
      expect(row.correlation_id).toBe("sched:ai_visibility");
    }
  });

  // ── FAMILY 5 — PillarDisabledError's non-consuming re-ask across MULTIPLE sweeps ────────────────
  it("ATTACK: THREE consecutive sweeps with the pillar off write ZERO rows total and never resolve to `not_due` or `dispatched` (a stuck-off pillar cannot become a silent success or a silent skip)", async () => {
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    config.search.pillars.seo = false;

    for (let i = 0; i < 3; i++) {
      const result = await runSearchPullSweep();
      const rank = toolOf(result, s, "rank");
      expect(rank?.status).toBe("refused");
      expect(rank?.reason).toBe("pillar_disabled");
    }
    expect(await ledger(s)).toHaveLength(0);
    expect(await activities(s)).toHaveLength(3); // each refused tick DOES write its own activity row
    expect(mock.dispatchCount).toBe(0);

    // Flip it back on: the very next sweep must dispatch (proving the pillar brake truly consumed
    // no window — a real refusal in DECISION 4's sense would still show `not_due` here).
    config.search.pillars.seo = true;
    const recovered = await runSearchPullSweep();
    expect(toolOf(recovered, s, "rank")?.status).toBe("dispatched");
  });

  // ── FAMILY 5 (part 2) — the lock cannot be left held after stop() ───────────────────────────────
  it("ATTACK: calling stop() WHILE a sweep is mid-flight does not leave the advisory lock held — checked in pg_locks directly, not inferred from a second sweep", async () => {
    // A second `runSearchPullSweep()` call is NOT a reliable witness here: pg-pool can hand the
    // exact same physical connection back to the next `withGlobal` caller, and Postgres session-
    // scoped advisory locks are RE-ENTRANT within one session — so "the second sweep acquired the
    // lock" can be true either because it was genuinely released, OR because the same session that
    // never released it is trivially re-acquiring its own still-held lock. That ambiguity is a real
    // gap in adversarial testing itself (the exact §6ak-shaped blind spot this gate exists to catch
    // in ITS OWN probes, not just the code's): query `pg_locks` for the lock's (classid, objid)
    // directly, which is true independent of which session or connection asks.
    const s = await seed({ rank: { enabled: true, cadence: "daily" } });
    const LOCK_NS = 0x53430003;
    const LOCK_KEY = 0;
    const heldCount = () =>
      withGlobal((c) =>
        c
          .query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
            [LOCK_NS, LOCK_KEY],
          )
          .then((r) => Number(r.rows[0].n)),
      );

    mock.delayMs = 250; // widen the in-flight window
    const handle = startSearchPullSchedulerLoop(50_000); // long interval: only the first tick matters
    await new Promise((r) => setTimeout(r, 30)); // let the tick begin, mid-dispatch
    expect(await heldCount()).toBeGreaterThanOrEqual(1); // sanity: the lock genuinely is held right now
    handle.stop(); // stop() only flips `stopped`; it cannot cancel the in-flight sweep or its lock hold
    // Wait out the in-flight sweep's own duration plus margin, then confirm pg_locks itself shows
    // the lock gone — released in the `finally` as documented, not wedged by an early stop() racing it.
    await new Promise((r) => setTimeout(r, 800));
    mock.delayMs = 0;
    expect(await heldCount()).toBe(0);
    const direct = await runSearchPullSweep();
    expect(direct.skippedLocked).toBe(false);
    void s;
  });
});
