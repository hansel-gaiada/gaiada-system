// SMM-22 — `usage-ledger.ts` against a live Postgres. No Nest app, no hub, no Cerbos: this file
// proves the DOMAIN function's own contract (the pure D-9 arithmetic, the module-GUC regression,
// the reservation's airtightness against a sequence of dispatches), exactly the split
// `dispatch.test.ts`/`d14-smm-09-social-publish-registry.test.ts` established for their own layers.
//
// ── ⚠ THE MODULE-GUC REGRESSION, PROVEN BY CONSTRUCTION ────────────────────────────────────────────
// Every write/read function here opens (or is handed) a transaction with NO `{modules:['social']}`
// option and relies on `declareSocialModuleScope` alone — mirroring `dispatch.ts`'s own header note.
// So every test below that reaches a real ledger row is already the regression test: remove
// `declareSocialModuleScope` from `reserveUsageSpend` (or from `sumUsageMonthToDate`'s caller) and
// (T1) fails with a spend total of zero / a `ledgerId` that resolves to nothing, because 0105's
// third RLS wall would make the query return/write nothing, silently — never an error. Defect class
// #1's own warning, made concrete: "on a ledger read that means a spend total of zero — the
// stop-loss would never trip."
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import {
  evaluateUsageBudget,
  resolveXPricing,
  sumUsageMonthToDate,
  sumGlobalUsageMonthToDate,
  resetGlobalUsageMonthToDateCache,
  reserveUsageSpend,
  markUsageLedgerFailed,
  markUsageLedgerCompleted,
  findPostedLedgerRowByRefId,
  insertUsageLedgerRow,
} from "./usage-ledger";

const MODULES: { modules: string[] } = { modules: ["social"] };

// ══ PURE ARITHMETIC — no DB needed ═══════════════════════════════════════════════════════════════

describe("evaluateUsageBudget — the D-9 three-tier stop-loss, pure", () => {
  const base = {
    estimate: 1, engagementCap: 10, engagementMtd: 0,
    tenantCap: 10 as number | null, tenantMtd: 0,
    globalCap: 10, globalMtd: 0,
  };

  it("passes when every tier has headroom", () => {
    expect(evaluateUsageBudget(base)).toEqual({ ok: true });
  });

  it("trips the ENGAGEMENT tier first when it alone would breach", () => {
    expect(evaluateUsageBudget({ ...base, engagementMtd: 9.5 })).toEqual({ ok: false, tier: "engagement" });
  });

  it("trips the TENANT tier when engagement is fine but tenant is not — SMM-22's own new tier", () => {
    expect(evaluateUsageBudget({ ...base, tenantMtd: 9.5 })).toEqual({ ok: false, tier: "tenant" });
  });

  it("trips the GLOBAL tier when engagement and tenant are both fine — SMM-22's own new tier", () => {
    expect(evaluateUsageBudget({ ...base, globalMtd: 9.5 })).toEqual({ ok: false, tier: "global" });
  });

  it("SKIPS the tenant tier when its cap is null (unset, by design) — never reads null as zero", () => {
    expect(evaluateUsageBudget({ ...base, tenantCap: null, tenantMtd: 9999 })).toEqual({ ok: true });
  });

  it("fails CLOSED on a non-finite cap, never reads it as unlimited", () => {
    expect(evaluateUsageBudget({ ...base, globalCap: Number.NaN })).toEqual({ ok: false, tier: "global" });
  });

  it("an estimate that lands EXACTLY on the cap passes (>, not >=, matches the pre-existing engagement-tier convention)", () => {
    expect(evaluateUsageBudget({ ...base, estimate: 10, engagementCap: 10 })).toEqual({ ok: true });
  });
});

describe("resolveXPricing — config-sourced, never a literal", () => {
  it("is null when either half of X's price is unset", async () => {
    const { config } = await import("../../config");
    const before = { a: config.social.usage.xPerPostCostUsd, b: config.social.usage.xPerPostWithLinkCostUsd };
    try {
      config.social.usage.xPerPostCostUsd = null;
      config.social.usage.xPerPostWithLinkCostUsd = 0.2;
      expect(resolveXPricing()).toBeNull();
      config.social.usage.xPerPostCostUsd = 0.015;
      config.social.usage.xPerPostWithLinkCostUsd = null;
      expect(resolveXPricing()).toBeNull();
      config.social.usage.xPerPostCostUsd = 0.015;
      config.social.usage.xPerPostWithLinkCostUsd = 0.2;
      expect(resolveXPricing()).toEqual({ perPostUsd: 0.015, perPostWithLinkUsd: 0.2 });
    } finally {
      config.social.usage.xPerPostCostUsd = before.a;
      config.social.usage.xPerPostWithLinkCostUsd = before.b;
    }
  });
});

// ══ DB-BACKED — the ledger itself ═══════════════════════════════════════════════════════════════

describe.skipIf(!TEST_URL)("usage-ledger.ts against live Postgres", () => {
  let co: string;
  let otherCo: string;
  let clientId: string;
  let tenantCapBefore: number | null;
  let globalCapBefore: number;

  let seq = 0;
  const uniq = (label: string): string => `smm22-ledger-${label}-${++seq}`;

  beforeAll(async () => {
    await initTestDb();
    const { config } = await import("../../config");
    tenantCapBefore = config.social.usage.tenantMonthlyCapUsd;
    globalCapBefore = config.social.usage.globalMonthlyCapUsd;
    co = await createCompany("SMM-22 Ledger Co", ["social"]);
    otherCo = await createCompany("SMM-22 Ledger Co (other tenant)", ["social"]);
    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
  });

  afterAll(async () => {
    const { config } = await import("../../config");
    config.social.usage.tenantMonthlyCapUsd = tenantCapBefore;
    config.social.usage.globalMonthlyCapUsd = globalCapBefore;
    resetGlobalUsageMonthToDateCache();
    await teardownTestDb();
  });

  async function makeEngagement(tenantId: string, client: string, budgetUsd = 10): Promise<string> {
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-22 ledger engagement','active','{}',$4,'central')`,
        [id, tenantId, client, budgetUsd],
      ), MODULES);
    return id;
  }

  // ══ (T1) THE MODULE-GUC REGRESSION, BY CONSTRUCTION ══════════════════════════════════════════

  it("(T1) ⭐ reserveUsageSpend actually reaches a real row — the module-GUC regression test", async () => {
    const engagementId = await makeEngagement(co, clientId);
    const reservation = await reserveUsageSpend(co, engagementId, 1, 10, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("unreachable");

    // Read it back through the SAME module-scoped path a real caller would use — if
    // `declareSocialModuleScope` were ever removed from `reserveUsageSpend`, THIS insert would
    // never have landed (0105's third RLS wall silently discards it), and this read would find
    // nothing rather than throwing.
    const spent = await withTenants([co], (c) => sumUsageMonthToDate(c, engagementId), MODULES);
    expect(spent).toBe(1);
  });

  // ══ (T2) THE THREE TIERS, THROUGH THE REAL RESERVATION ═══════════════════════════════════════

  it("(T2) engagement tier: a reservation that would exceed the engagement's OWN cap refuses, and writes NO row", async () => {
    const engagementId = await makeEngagement(co, clientId, 1);
    const r1 = await reserveUsageSpend(co, engagementId, 0.9, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(r1.ok).toBe(true);
    const r2 = await reserveUsageSpend(co, engagementId, 0.5, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(r2).toEqual({ ok: false, tier: "engagement" });
    // Observable state, not an inference: the sum after the refused attempt is UNCHANGED.
    const spent = await withTenants([co], (c) => sumUsageMonthToDate(c, engagementId), MODULES);
    expect(spent).toBe(0.9);
  });

  it("(T3) tenant tier: TWO engagements in the SAME tenant share one tenant-wide cap", async () => {
    const { config } = await import("../../config");
    config.social.usage.tenantMonthlyCapUsd = 1;
    try {
      // A FRESH tenant, deliberately — this test sums ACROSS THE WHOLE TENANT, so reusing `co`
      // (already carrying spend from earlier engagement-tier tests above) would pollute the sum
      // with unrelated reservations and make this test's own arithmetic unverifiable (this file's
      // own "test-file pollution" defect class, applied across tests sharing one tenant rather than
      // across files).
      const freshCo = await createCompany("SMM-22 Ledger Co (tenant-tier)", ["social"]);
      const freshClientId = newId();
      await withTenants([freshCo], (c) =>
        c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand Fresh','central')`, [freshClientId, freshCo]));
      const engA = await makeEngagement(freshCo, freshClientId, 10); // engagement cap is generous
      const engB = await makeEngagement(freshCo, freshClientId, 10);
      const r1 = await reserveUsageSpend(freshCo, engA, 0.8, 10, {
        accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
      });
      expect(r1.ok).toBe(true);
      // engB's OWN cap is fine (10), but the TENANT'S shared cap (1) is nearly spent by engA.
      const r2 = await reserveUsageSpend(freshCo, engB, 0.5, 10, {
        accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
      });
      expect(r2).toEqual({ ok: false, tier: "tenant" });
    } finally {
      config.social.usage.tenantMonthlyCapUsd = tenantCapBefore;
    }
  });

  it("(T4) global tier: TWO DIFFERENT TENANTS share one platform-wide cap", async () => {
    const { config } = await import("../../config");
    resetGlobalUsageMonthToDateCache();
    try {
      // FRESH tenants for the tenant-tier reason (T3), but the GLOBAL sum spans EVERY company ever
      // created in THIS FILE's own isolated test database (earlier tests above left un-released
      // reservations behind on purpose, to prove OTHER things) — so the cap here is set ADAPTIVELY,
      // relative to whatever the platform-wide MTD already is, rather than a hardcoded absolute
      // value this file's own test order could silently invalidate.
      const baseline = await sumGlobalUsageMonthToDate();
      config.social.usage.globalMonthlyCapUsd = baseline + 1;

      const hereCo = await createCompany("SMM-22 Ledger Co (global-tier, A)", ["social"]);
      const thereCo = await createCompany("SMM-22 Ledger Co (global-tier, B)", ["social"]);
      const hereClientId = newId();
      await withTenants([hereCo], (c) =>
        c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand Here','central')`, [hereClientId, hereCo]));
      const engHere = await makeEngagement(hereCo, hereClientId, 10);
      const thereClientId = newId();
      await withTenants([thereCo], (c) =>
        c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand There','central')`, [thereClientId, thereCo]));
      const engThere = await makeEngagement(thereCo, thereClientId, 10);

      resetGlobalUsageMonthToDateCache();
      const r1 = await reserveUsageSpend(hereCo, engHere, 0.8, 10, {
        accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
      });
      expect(r1.ok).toBe(true);
      resetGlobalUsageMonthToDateCache(); // force a fresh cross-tenant sum for the second reservation
      // A DIFFERENT tenant's engagement, comfortably under ITS OWN engagement/tenant tiers, still
      // refuses at the GLOBAL tier because tenant #1 already spent most of the (adaptively-sized)
      // remaining platform-wide headroom.
      const r2 = await reserveUsageSpend(thereCo, engThere, 0.5, 10, {
        accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
      });
      expect(r2).toEqual({ ok: false, tier: "global" });
    } finally {
      config.social.usage.globalMonthlyCapUsd = globalCapBefore;
      resetGlobalUsageMonthToDateCache();
    }
  });

  // ══ (T5) THE RESERVATION IS AIRTIGHT AGAINST A SEQUENCE OF DISPATCHES ════════════════════════
  //
  // This is the "second, airtight check" dispatch.ts's own reservation exists to be — proven here
  // WITHOUT relying on real OS-thread concurrency (a Promise.all race is covered separately, at the
  // dispatch.ts level, for the end-to-end property). Two reservations, back to back, for amounts
  // that EACH individually fit the cap but jointly do not: the second one's OWN re-sum (not a
  // cached or stale value) is what catches it.

  it("(T5) two reservations that individually fit but jointly exceed the cap: exactly the SECOND refuses", async () => {
    const engagementId = await makeEngagement(co, clientId, 1); // room for exactly one $0.6 post, not two
    const first = await reserveUsageSpend(co, engagementId, 0.6, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    const second = await reserveUsageSpend(co, engagementId, 0.6, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, tier: "engagement" });
    // Exactly ONE posted row exists, never two — the money-safety property itself, read back as
    // data rather than inferred from the return values alone.
    const spent = await withTenants([co], (c) => sumUsageMonthToDate(c, engagementId), MODULES);
    expect(spent).toBe(0.6);
  });

  // ══ (T6) RELEASE / TRUE-UP LIFECYCLE ══════════════════════════════════════════════════════════

  it("(T6) markUsageLedgerFailed releases a reservation to cost=0, and it stops counting toward the cap", async () => {
    const engagementId = await makeEngagement(co, clientId, 1);
    const r = await reserveUsageSpend(co, engagementId, 0.9, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");

    const released = await markUsageLedgerFailed(co, r.ledgerId);
    expect(released).toBe(true);

    // Observable state: the sum is back to zero, so a FOLLOW-UP reservation for the SAME amount
    // now succeeds — the money was genuinely given back, not just relabeled.
    const spentAfterRelease = await withTenants([co], (c) => sumUsageMonthToDate(c, engagementId), MODULES);
    expect(spentAfterRelease).toBe(0);
    const retry = await reserveUsageSpend(co, engagementId, 0.9, 1, {
      accountId: null, kind: "x_post", refId: newId(), requestedBy: null, correlationId: null,
    });
    expect(retry.ok).toBe(true);

    // A double release is a no-op, never a corruption (only a `posted` row advances).
    const doubleRelease = await markUsageLedgerFailed(co, r.ledgerId);
    expect(doubleRelease).toBe(false);
  });

  it("(T6b) markUsageLedgerCompleted moves status only — X's cost is flat, nothing to correct", async () => {
    const engagementId = await makeEngagement(co, clientId, 10);
    const refId = newId();
    const r = await reserveUsageSpend(co, engagementId, 0.5, 10, {
      accountId: null, kind: "x_post", refId, requestedBy: null, correlationId: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");

    const found = await withTenants([co], (c) => findPostedLedgerRowByRefId(c, refId), MODULES);
    expect(found?.id).toBe(r.ledgerId);

    const completed = await markUsageLedgerCompleted(co, r.ledgerId);
    expect(completed).toBe(true);
    // Still counts toward MTD spend (status-blind sum, `sumUsageMonthToDate`'s own `status <>
    // 'failed'` predicate admits `completed`) — the spend is real and confirmed, not released.
    const spent = await withTenants([co], (c) => sumUsageMonthToDate(c, engagementId), MODULES);
    expect(spent).toBe(0.5);
    // A completed row is no longer `posted`, so `findPostedLedgerRowByRefId` no longer finds it —
    // the reconcile job's own idempotency guard against advancing it twice.
    const foundAgain = await withTenants([co], (c) => findPostedLedgerRowByRefId(c, refId), MODULES);
    expect(foundAgain).toBeNull();
  });

  it("(T7) a plain insertUsageLedgerRow at status='failed' always carries cost_usd=0 when written via markUsageLedgerFailed — never inserted nonzero-and-failed directly by this module's own callers", async () => {
    // Belt-and-braces: insertUsageLedgerRow itself does not enforce the invariant (it is a thin
    // insert, matching search's own insertLedgerRow) — the invariant is enforced by
    // `markUsageLedgerFailed`'s own hardcoded `cost_usd = 0`, asserted directly here.
    const engagementId = await makeEngagement(co, clientId, 10);
    const id = await withTenants([co], (c) => insertUsageLedgerRow(c, {
      tenantId: co, engagementId, kind: "x_post", refId: newId(), costUsd: 0.7, status: "posted", requestedBy: null,
    }), MODULES);
    await markUsageLedgerFailed(co, id);
    const row = await withTenants([co], (c) =>
      c.query<{ cost_usd: string; status: string }>(`SELECT cost_usd, status FROM social_usage_ledger WHERE id = $1`, [id]), MODULES);
    expect(Number(row.rows[0].cost_usd)).toBe(0);
    expect(row.rows[0].status).toBe("failed");
  });
});
