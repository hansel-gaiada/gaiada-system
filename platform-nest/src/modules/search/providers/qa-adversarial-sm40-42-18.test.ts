// QA GATE (chained SM-40/SM-42/SM-18) — adversarial probes not written by any implementer.
// Test-only file added by the QA gate per the round's fix policy: product code in
// search.controller.ts / providers/* / platform-ui is out of scope for QA edits this round: any
// defect found here is REPORTED for the architect/senior-be to route, not fixed in this file.
//
// Scope: SM-40 (per-provider ceiling) NaN/zero/negative-cap edge cases, SM-42 (true-up seam)
// mid-capture-throw isolation + double-take idempotency, SM-18 (SEM plan) mixed-provenance
// three-state proof at the pure-function boundary.
import { describe, it, expect, beforeEach } from "vitest";
import { evaluateBudget } from "./dispatch";
import { computeProviderReservationCapUsd } from "../../../config";
import {
  registerProvider,
  resetProviders,
} from "./registry";
import { withActualCostCapture, takeCapturedActualCostUsd, recordActualCostUsd } from "./types";
import { MockSearchProvider } from "./mock-provider";
import { buildCampaignPlan, type PlanKeywordRow } from "../sem-plan";

// The mock provider (SM-04) never implements the OPTIONAL SM-42 true-up surface — only ahrefs.ts
// does today. To probe withActualCostCapture's isolation contract at all we need a provider that
// implements it the way the design mandates (delegating to takeCapturedActualCostUsd(), never a
// hand-rolled instance field) — mirroring ahrefs.ts's `takeActualCostUsd()` verbatim.
class TrueUpCapableMockProvider extends MockSearchProvider {
  takeActualCostUsd(): number | undefined {
    return takeCapturedActualCostUsd();
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// SM-40 attack 1: a cap of exactly 0 / negative / NaN from a malformed env value
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("QA adversarial — SM-40 evaluateBudget with a degenerate PROVIDER cap", () => {
  const base = {
    estimate: 1, engagementCap: 1_000_000, engagementMtd: 0,
    tenantCap: null as number | null, tenantMtd: 0,
    globalCap: 1_000_000, globalMtd: 0,
  };

  it("cap === 0 (a literal, not unset) breaches EVERY dispatch — fails safe, correct", () => {
    const d = evaluateBudget({ ...base, providerCap: 0, providerMtd: 0 });
    expect(d.breach?.tier).toBe("provider");
  });

  it("a negative cap also breaches every dispatch — fails safe, correct", () => {
    const d = evaluateBudget({ ...base, providerCap: -5, providerMtd: 0 });
    expect(d.breach?.tier).toBe("provider");
  });

  // ── THE FINDING ──────────────────────────────────────────────────────────────────────────────
  // config.ts's DataForSEO branch is:
  //   `process.env.DATAFORSEO_MONTHLY_CAP_USD ? Number(process.env.DATAFORSEO_MONTHLY_CAP_USD) : null`
  // A non-numeric-but-non-empty value (a realistic operator typo, e.g. "150 usd" or a stray env
  // template placeholder left unresolved) produces `Number(x) === NaN`, which is NOT run through
  // computeProviderReservationCapUsd's `monthlyPlanPriceUsd > 0` guard (that guard exists ONLY on
  // the Semrush/Ahrefs amortization path). evaluateBudget itself has no NaN guard either: `t.cap ==
  // null` is false for NaN (NaN is not == null), so the tier is NOT skipped, but every subsequent
  // comparison against NaN (`projected > NaN`, `projected >= ratio * NaN`) is FALSE by IEEE-754
  // semantics — so the tier is evaluated, silently never breaches and never warns, for ANY
  // estimate, at ANY month-to-date. This is the exact §4d fail-open class (a tier that LOOKS
  // configured and enforced but is actually inert), arriving through a config-parsing gap rather
  // than a catch-to-0 this time.
  // ── ROUTED AND CLOSED (tracker §6r) — retitled, assertions deliberately UNCHANGED. ──────────────
  // This test's diagnosis was right and its proposed remedy was wrong, which is worth preserving
  // rather than editing away. The remedy proposed was "coerce the NaN cap to null so the tier is
  // skipped". That fixes nothing: an inert NaN tier and a skipped null tier enforce EXACTLY the same
  // nothing (`projected > NaN` and `projected >= ratio * NaN` are both false), so coercion only
  // relocates the silence. Verified directly before choosing the real fix.
  // Nothing downstream of the parse can distinguish "no cap configured" from "a cap I could not
  // read", so the fix had to go to the parse site: config.ts's `moneyEnv()` now THROWS at boot on a
  // set-but-uninterpretable cap (pinned by src/config-money-env.test.ts, 6/9 of which fail if that
  // guard is removed). The assertions below therefore still hold and are still correct — a NaN cap
  // reaching this function IS inert — but that state is no longer reachable from configuration.
  it("evaluateBudget cannot defend a NaN provider cap — inert, no breach, no warning (fixed upstream at the config parse, §6r)", () => {
    const capFromMalformedEnv = Number("abc"); // mirrors config.ts's literal `Number(process.env...)`
    expect(Number.isNaN(capFromMalformedEnv)).toBe(true);
    // engagement/global caps set far above the estimate so THEIR tiers stay silent — isolates the
    // provider tier's own behavior under a NaN cap from the other tiers' unrelated warn/breach noise.
    const d = evaluateBudget({
      estimate: 1_000_000_000, // an absurd estimate — a real cap of any finite size would refuse this
      engagementCap: 1e15, engagementMtd: 0,
      tenantCap: null, tenantMtd: 0,
      providerCap: capFromMalformedEnv,
      providerMtd: 0,
      globalCap: 1e15, globalMtd: 0,
    });
    // This SHOULD refuse (or at minimum the config layer should have refused to produce a NaN cap
    // in the first place, matching the Semrush/Ahrefs treatment of an equally-malformed plan
    // price). It does neither: no breach at all, and specifically no "provider"-tier warning —
    // the tier is invisibly a no-op for a BILLION-dollar estimate against a $0 month-to-date.
    expect(d.breach).toBeUndefined();
    expect(d.warnings.some((w) => w.tier === "provider")).toBe(false);
  });

  it("confirms the ASYMMETRY: the Semrush/Ahrefs amortization path DOES guard against this exact input shape", () => {
    // A non-numeric SEMRUSH_MONTHLY_PLAN_PRICE_USD produces the same NaN via config.ts's
    // `Number(process.env.SEMRUSH_MONTHLY_PLAN_PRICE_USD ?? 0)` — but that value is never used as
    // a cap directly; it is only ever passed through computeProviderReservationCapUsd, whose
    // `!(monthlyPlanPriceUsd > 0)` guard is true for NaN (NaN > 0 is false, so `!false` = true),
    // correctly returning null (tier SKIPPED) rather than a NaN cap. DataForSEO's cap bypasses this
    // guard entirely because it is assigned directly from the parsed env value with no derivation
    // function in between. Same malformed-input shape, two different outcomes — DataForSEO gets
    // the unsafe one.
    const nanPlanPrice = Number("abc");
    expect(computeProviderReservationCapUsd(nanPlanPrice, 0.5)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// SM-42 attack: does a provider throwing MID-capture leak state into the NEXT dispatch's capture?
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("QA adversarial — SM-42 withActualCostCapture isolation under a mid-capture throw", () => {
  beforeEach(() => resetProviders());

  it("a throwing capture leaves NOTHING for a subsequent, unrelated capture to observe", async () => {
    const provider = new TrueUpCapableMockProvider();
    registerProvider(provider);

    // First "dispatch": records a partial cost then throws before completing (mirrors a driver
    // whose internal HTTP layer reports a partial actual cost via recordActualCostUsd and then the
    // op fails, e.g. one of two parallel Ahrefs calls succeeds and the other rejects).
    await expect(
      withActualCostCapture(provider, async () => {
        recordActualCostUsd(42);
        throw new Error("simulated mid-capture provider failure");
      }),
    ).rejects.toThrow("simulated mid-capture provider failure");

    // Second, unrelated capture on the SAME provider singleton must start from a clean slate — if
    // the AsyncLocalStorage store somehow leaked (e.g. a bug that used a module-level variable
    // instead of the store, or read the store outside the run() callback), this would observe the
    // first capture's $42 or its `observed` flag.
    const second = await withActualCostCapture(provider, async () => {
      // Deliberately records NOTHING — this call's actualCostUsd should end up `undefined`,
      // not `42` and not `0`.
      return "second-call-payload";
    });
    expect(second.actualCostUsd).toBeUndefined();
    expect(second.result).toBe("second-call-payload");
  });

  it("takeCapturedActualCostUsd is read-AND-CLEAR: a second take in the SAME scope returns undefined, never re-plays the figure", async () => {
    const provider = new TrueUpCapableMockProvider();
    registerProvider(provider);
    await withActualCostCapture(provider, async () => {
      recordActualCostUsd(10);
      const first = takeCapturedActualCostUsd();
      const second = takeCapturedActualCostUsd();
      expect(first).toBe(10);
      expect(second).toBeUndefined(); // not 0, not 10 again — a true "nothing left to report"
      return null;
    });
  });

  it("two captures for the SAME op that both record are ADDITIVE, never last-write-wins (the getBacklinkSummary shape)", async () => {
    const provider = new TrueUpCapableMockProvider();
    registerProvider(provider);
    const { actualCostUsd } = await withActualCostCapture(provider, async () => {
      // Simulates two parallel internal HTTP calls within ONE op, as Ahrefs's real
      // getBacklinkSummary does (backlinks-stats + domain-rating in Promise.all).
      await Promise.all([
        (async () => { await new Promise((r) => setTimeout(r, 5)); recordActualCostUsd(7); })(),
        (async () => { await new Promise((r) => setTimeout(r, 15)); recordActualCostUsd(3); })(),
      ]);
      return null;
    });
    expect(actualCostUsd).toBe(10); // 7 + 3, never just 3 (last-resolved) or just 7 (first-resolved)
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// SM-18 attack: hand-stamped MIXED provenance fixture — three states, never blended
// ────────────────────────────────────────────────────────────────────────────────────────────────
describe("QA adversarial — SM-18 buildCampaignPlan provenance: real vs simulated vs unpulled, never blended", () => {
  function row(over: Partial<PlanKeywordRow>): PlanKeywordRow {
    return {
      id: `kw-${Math.random().toString(36).slice(2)}`,
      keyword: "test keyword",
      intent: "commercial",
      clusterId: "cluster-1",
      clusterLabel: "Widgets",
      volume: 100,
      difficulty: 40,
      cpcUsd: 1.2,
      metricsProvider: null,
      metricsSimulated: false,
      ...over,
    };
  }

  it("one ad group mixing dataforseo(real) + semrush(simulated) + fully-unpulled keywords reports all THREE states distinctly, providers never blended", () => {
    const rows: PlanKeywordRow[] = [
      row({ metricsProvider: "dataforseo", metricsSimulated: false }),
      row({ metricsProvider: "dataforseo", metricsSimulated: false }),
      row({ metricsProvider: "semrush", metricsSimulated: true }),
      row({ metricsProvider: null, metricsSimulated: false }), // unpulled — must NOT count as real or 0
      row({ metricsProvider: null, metricsSimulated: false }),
    ];
    const plan = buildCampaignPlan(rows);
    expect(plan.adGroups).toHaveLength(1);
    const group = plan.adGroups[0];
    expect(group.provenance.providers).toEqual(["dataforseo", "semrush"]); // distinct, sorted, never a blended label
    expect(group.provenance.realCount).toBe(2); // the two dataforseo rows
    expect(group.provenance.simulatedCount).toBe(1); // the one semrush(simulated) row
    expect(group.provenance.unpulledCount).toBe(2); // the two null-provider rows — a THIRD state, not folded into real or simulated
    expect(group.provenance.realCount + group.provenance.simulatedCount + group.provenance.unpulledCount).toBe(rows.length);
  });

  it("a cluster where EVERY keyword is unpulled reports providers:[] and unpulledCount === total — never invents a provider", () => {
    const rows: PlanKeywordRow[] = [
      row({ metricsProvider: null }),
      row({ metricsProvider: null }),
      row({ metricsProvider: null }),
    ];
    const plan = buildCampaignPlan(rows);
    const group = plan.adGroups[0];
    expect(group.provenance.providers).toEqual([]);
    expect(group.provenance.unpulledCount).toBe(3);
    expect(group.provenance.realCount).toBe(0);
    expect(group.provenance.simulatedCount).toBe(0);
  });

  it("a THIRD vendor (ahrefs, real) alongside dataforseo(simulated) in one cluster still lists both distinctly with correct real/sim split", () => {
    const rows: PlanKeywordRow[] = [
      row({ metricsProvider: "ahrefs", metricsSimulated: false }),
      row({ metricsProvider: "dataforseo", metricsSimulated: true }),
      row({ metricsProvider: "dataforseo", metricsSimulated: true }),
    ];
    const plan = buildCampaignPlan(rows);
    const group = plan.adGroups[0];
    expect(group.provenance.providers).toEqual(["ahrefs", "dataforseo"]);
    expect(group.provenance.realCount).toBe(1);
    expect(group.provenance.simulatedCount).toBe(2);
    expect(group.provenance.unpulledCount).toBe(0);
  });
});
