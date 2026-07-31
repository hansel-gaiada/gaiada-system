// SM-21 — pure unit tests for sem-apply.ts: the content hash an approval is bound to, the
// proposal->operations translation, executor resolution, and the echo-validation/outcome
// classification step. No database, no HTTP (search-sem-apply.test.ts owns the e2e half against live
// Postgres + the real HTTP layer).
//
// Each block below states the PROPERTY it pins rather than the behaviour it observes, because these
// are the invariants the controller's guards are built on top of — if one of them silently changes,
// the controller's guards stop meaning what their comments claim.
import { describe, it, expect, afterEach } from "vitest";
import {
  ApplyInputError, MAX_OPERATIONS_PER_EXECUTION, NoLiveExecutorError,
  buildChangeOperations, canonicalizeRef, cerbosActionForKind, clearLiveAdsExecutor,
  hashChangeProposalContent, isApplyKind, reconcileExecution, registerLiveAdsExecutor,
  resolveAdsExecutor, setAdsExecutorForTest, simulationAdsExecutor, toolNameForKind,
  type ApplyFacts, type ChangeOperation, type ExecutorReport,
} from "./sem-apply";

const campaign = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Spring Sale",
  platform: "google_ads",
  budgetMinor: 50_000,
  currency: "USD",
  bidStrategy: "maximize_conversions",
  targetCpaMinor: 2_500,
  targetRoas: 3.5,
};
const facts = (over: Partial<ApplyFacts> = {}): ApplyFacts => ({ campaign, payload: {}, ...over });

afterEach(() => {
  setAdsExecutorForTest(null);
  clearLiveAdsExecutor();
});

// ─────────────────────────────────────────── content identity ──────────────────────────────────────
describe("hashChangeProposalContent — the identity an approval is bound to", () => {
  it("is stable across key order and across an equivalent re-serialization", () => {
    const a = hashChangeProposalContent("budget", "api", { budgetMinor: 1, currency: "USD", nested: { b: 2, a: 1 } });
    const b = hashChangeProposalContent("budget", "api", { nested: { a: 1, b: 2 }, currency: "USD", budgetMinor: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the payload changes — the whole point of binding approval to content", () => {
    const before = hashChangeProposalContent("budget", "api", { budgetMinor: 50_000, currency: "USD" });
    const after = hashChangeProposalContent("budget", "api", { budgetMinor: 5_000_000, currency: "USD" });
    expect(after).not.toBe(before);
  });

  it("changes when KIND changes even though the payload is byte-identical", () => {
    // The same {ids:[...]} payload means "add these negatives" under one kind and "publish these
    // ads" under another. A hash over payload alone would let an approval for one authorize the
    // other, which is why the hash covers kind.
    const ids = { ids: ["aaaaaaaa-0000-0000-0000-000000000001"] };
    expect(hashChangeProposalContent("negatives_batch", "api", ids))
      .not.toBe(hashChangeProposalContent("ads_batch", "api", ids));
  });

  it("changes when MODE changes — an api approval must not authorize a manual execution channel", () => {
    expect(hashChangeProposalContent("pause", "api", {}))
      .not.toBe(hashChangeProposalContent("pause", "manual", {}));
  });

  it("treats a null/undefined payload as {} rather than throwing", () => {
    // A NULL payload is not reachable through the routes (0034 has payload NOT NULL), but a hash
    // function that throws on it would turn a data anomaly into a 500 on an authz-critical path.
    expect(hashChangeProposalContent("pause", "api", null)).toBe(hashChangeProposalContent("pause", "api", {}));
  });

  it("does not collide between array and object encodings of the same-looking data", () => {
    expect(hashChangeProposalContent("pause", "api", { ids: ["a", "b"] }))
      .not.toBe(hashChangeProposalContent("pause", "api", { ids: { 0: "a", 1: "b" } }));
  });
});

// ─────────────────────────────────────────── operations ────────────────────────────────────────────
describe("buildChangeOperations", () => {
  it("refuses an unknown kind rather than defaulting to one", () => {
    expect(() => buildChangeOperations("delete_everything", facts())).toThrow(ApplyInputError);
    expect(isApplyKind("delete_everything")).toBe(false);
  });

  it("pause/budget/bid are single campaign-level operations carrying the campaign's own values", () => {
    const pause = buildChangeOperations("pause", facts());
    expect(pause).toHaveLength(1);
    expect(pause[0].opType).toBe("campaign.pause");
    expect(pause[0].entityId).toBe(campaign.id);

    const budget = buildChangeOperations("budget", facts());
    expect(budget[0].fields).toMatchObject({ budgetMinor: 50_000, currency: "USD" });

    const bid = buildChangeOperations("bid", facts());
    expect(bid[0].fields).toMatchObject({ bidStrategy: "maximize_conversions", targetCpaMinor: 2_500, targetRoas: 3.5 });
  });

  it("payload overrides the campaign's stored value — the SAME selection rule the manual CSV twin uses", () => {
    // Drift between the two twins would mean the same approved proposal applies two different
    // changes depending on which path executed it. sem-export.ts's budget branch has this rule.
    const ops = buildChangeOperations("budget", facts({ payload: { budgetMinor: 12_345, currency: "IDR" } }));
    expect(ops[0].fields).toMatchObject({ budgetMinor: 12_345, currency: "IDR" });
  });

  it("refuses a budget change with neither a payload nor a campaign value (never invents 0)", () => {
    const bare = { ...campaign, budgetMinor: null, currency: null };
    expect(() => buildChangeOperations("budget", { campaign: bare, payload: {} })).toThrow(/budgetMinor\+currency required/);
  });

  it("refuses a negative budget rather than sending it to an ad account", () => {
    expect(() => buildChangeOperations("budget", facts({ payload: { budgetMinor: -1, currency: "USD" } })))
      .toThrow(/cannot be negative/);
  });

  it("refuses a bid change with no strategy anywhere", () => {
    const bare = { ...campaign, bidStrategy: null };
    expect(() => buildChangeOperations("bid", { campaign: bare, payload: {} })).toThrow(/bidStrategy required/);
  });

  it("launch expands into one campaign op PLUS one op per keyword — a genuinely multi-op batch", () => {
    const ops = buildChangeOperations("launch", facts({
      launchKeywords: [
        { keywordId: "k1", keyword: "running shoes", adGroupName: "Shoes" },
        { keywordId: "k2", keyword: "trail shoes", adGroupName: "Shoes" },
      ],
    }));
    expect(ops.map((o) => o.opType)).toEqual(["campaign.launch", "keyword.add", "keyword.add"]);
    expect(ops[1].entityId).toBe("k1");
  });

  it("refuses launch/negatives_batch/ads_batch with nothing to act on (never a no-op success)", () => {
    expect(() => buildChangeOperations("launch", facts({ launchKeywords: [] }))).toThrow(ApplyInputError);
    expect(() => buildChangeOperations("negatives_batch", facts({ negatives: [] }))).toThrow(ApplyInputError);
    expect(() => buildChangeOperations("ads_batch", facts({ ads: [] }))).toThrow(ApplyInputError);
  });

  it("every ref is unique and derived from OUR OWN row id, never from an array position", () => {
    // A positional ref would make the echo check tautological: any response of the right LENGTH
    // would validate. This is the assertion that keeps §A14's check meaningful.
    const ops = buildChangeOperations("negatives_batch", facts({
      negatives: [
        { id: "n1", term: "free", matchType: "broad", adGroupName: null },
        { id: "n2", term: "cheap", matchType: "phrase", adGroupName: "Shoes" },
      ],
    }));
    expect(ops.map((o) => o.ref)).toEqual(["negative.add#n1", "negative.add#n2"]);
    expect(new Set(ops.map((o) => o.ref)).size).toBe(ops.length);
    for (const op of ops) expect(op.ref).not.toMatch(/#\d+$/);
  });

  it("refuses a batch above the operation ceiling instead of attempting an unproven size", () => {
    const many = Array.from({ length: MAX_OPERATIONS_PER_EXECUTION + 1 }, (_, i) => ({
      id: `n${i}`, term: `t${i}`, matchType: "broad", adGroupName: null,
    }));
    expect(() => buildChangeOperations("negatives_batch", facts({ negatives: many })))
      .toThrow(new RegExp(`above the ${MAX_OPERATIONS_PER_EXECUTION} ceiling`));
  });

  it("refuses a batch whose refs collide, rather than mis-attributing one result to two changes", () => {
    const dupes = [
      { id: "same", term: "a", matchType: "broad", adGroupName: null },
      { id: "same", term: "b", matchType: "exact", adGroupName: null },
    ];
    expect(() => buildChangeOperations("negatives_batch", facts({ negatives: dupes })))
      .toThrow(/duplicate operation ref/);
  });
});

// ─────────────────────────────────────────── executor resolution ───────────────────────────────────
describe("resolveAdsExecutor — simulate and live are mutually exclusive", () => {
  it("simulate mode resolves the built-in simulator and expects simulated=true", () => {
    const { executor, expectSimulated } = resolveAdsExecutor("simulate");
    expect(executor).toBe(simulationAdsExecutor);
    expect(expectSimulated).toBe(true);
  });

  it("simulate mode IGNORES a registered live executor — a demo instance cannot touch a real account", async () => {
    let called = false;
    registerLiveAdsExecutor(async () => { called = true; return { provider: "google_ads", simulated: false, results: [] }; });
    const { executor, expectSimulated } = resolveAdsExecutor("simulate");
    expect(executor).toBe(simulationAdsExecutor);
    expect(expectSimulated).toBe(true);
    await executor({ tenantId: "t", proposalId: "p", campaignId: "c", kind: "pause", operations: [] });
    expect(called).toBe(false);
  });

  it("live mode with NO registered executor REFUSES — it never falls back to the simulator", () => {
    expect(() => resolveAdsExecutor("live")).toThrow(NoLiveExecutorError);
    // The refusal must name the ticket that will provide it, so the gap reads as absent capability
    // rather than as a bug.
    expect(() => resolveAdsExecutor("live")).toThrow(/SM-26/);
  });

  it("live mode with a registered executor uses it and expects simulated=false", () => {
    const live = async (): Promise<ExecutorReport> => ({ provider: "google_ads", simulated: false, results: [] });
    registerLiveAdsExecutor(live);
    const resolved = resolveAdsExecutor("live");
    expect(resolved.executor).toBe(live);
    expect(resolved.expectSimulated).toBe(false);
  });

  it("the built-in simulator reaches nothing and says so", async () => {
    const ops = buildChangeOperations("pause", facts());
    const report = await simulationAdsExecutor({ tenantId: "t", proposalId: "p", campaignId: campaign.id, kind: "pause", operations: ops });
    expect(report.simulated).toBe(true);
    expect(report.provider).toBe("simulation");
    // The synthetic remote id must be unmistakable — never shaped like a real Google resource name.
    expect(report.results[0].remoteId).toMatch(/^simulated:\/\//);
  });
});

// ─────────────────────────────────────────── reconciliation ────────────────────────────────────────
const ops3: ChangeOperation[] = buildChangeOperations("negatives_batch", facts({
  negatives: [
    { id: "n1", term: "free", matchType: "broad", adGroupName: null },
    { id: "n2", term: "cheap", matchType: "broad", adGroupName: null },
    { id: "n3", term: "torrent", matchType: "broad", adGroupName: null },
  ],
}));
const report = (results: ExecutorReport["results"], over: Partial<ExecutorReport> = {}): ExecutorReport =>
  ({ provider: "simulation", simulated: true, results, ...over });

describe("reconcileExecution — four outcomes, none rounded into another", () => {
  it("all applied => 'applied', and every entity id is attributable", () => {
    const out = reconcileExecution(ops3, report(ops3.map((o) => ({ ref: o.ref, outcome: "applied" as const }))), true);
    expect(out.status).toBe("applied");
    expect(out.changesApplied).toBe(3);
    expect(out.appliedEntityIds).toEqual(["n1", "n2", "n3"]);
  });

  it("some applied + some failed => 'partial', NOT applied and NOT failed", () => {
    // This is the property the whole four-status design exists for: a batch where part of the change
    // is live in the client's account and part is not is a real state, and it must not be reported
    // as either neighbour.
    const out = reconcileExecution(ops3, report([
      { ref: "negative.add#n1", outcome: "applied" },
      { ref: "negative.add#n2", outcome: "failed", detail: "POLICY_VIOLATION" },
      { ref: "negative.add#n3", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("partial");
    expect(out.changesApplied).toBe(2);
    expect(out.changesFailed).toBe(1);
    // Only the ones that actually applied are cascadable.
    expect(out.appliedEntityIds).toEqual(["n1", "n3"]);
    expect(out.perChange.find((p) => p.entityId === "n2")).toMatchObject({ outcome: "failed", detail: "POLICY_VIOLATION" });
  });

  it("zero applied => 'failed'", () => {
    const out = reconcileExecution(ops3, report(ops3.map((o) => ({ ref: o.ref, outcome: "failed" as const }))), true);
    expect(out.status).toBe("failed");
    expect(out.changesApplied).toBe(0);
    expect(out.appliedEntityIds).toEqual([]);
  });

  it("a result echoing a ref we never sent => 'indeterminate', and NOTHING is attributed", () => {
    // §A14.5's pairing discriminator: a violated identity on a paired response impeaches the
    // addressing scheme, so the other two results are equally suspect. Skip-and-continue would
    // mislabel the survivors as known-good.
    const out = reconcileExecution(ops3, report([
      { ref: "negative.add#n1", outcome: "applied" },
      { ref: "negative.add#SOMEONE-ELSES-ROW", outcome: "applied" },
      { ref: "negative.add#n3", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("indeterminate");
    expect(out.echoViolations.join(" ")).toMatch(/never sent/);
    expect(out.appliedEntityIds).toEqual([]);
  });

  it("a MISSING result => 'indeterminate' (a live change whose outcome we will never learn)", () => {
    const out = reconcileExecution(ops3, report([
      { ref: "negative.add#n1", outcome: "applied" },
      { ref: "negative.add#n2", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("indeterminate");
    expect(out.changesUnknown).toBe(1);
    expect(out.perChange.find((p) => p.entityId === "n3")).toMatchObject({ outcome: "unknown" });
    expect(out.appliedEntityIds).toEqual([]);
  });

  it("a DUPLICATED ref => 'indeterminate' (we cannot tell which result is authoritative)", () => {
    const out = reconcileExecution(ops3, report([
      { ref: "negative.add#n1", outcome: "applied" },
      { ref: "negative.add#n1", outcome: "failed" },
      { ref: "negative.add#n2", outcome: "applied" },
      { ref: "negative.add#n3", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("indeterminate");
    expect(out.echoViolations.join(" ")).toMatch(/more than once/);
  });

  it("an executor claiming a LIVE push while the platform expects simulate => 'indeterminate'", () => {
    // The one that matters most in a demo environment: 'simulated' must never be stamped from an
    // unchecked executor claim, because a false 'true' would hide a real ad-account change.
    const out = reconcileExecution(
      ops3,
      report(ops3.map((o) => ({ ref: o.ref, outcome: "applied" as const })), { simulated: false, provider: "google_ads" }),
      true,
    );
    expect(out.status).toBe("indeterminate");
    expect(out.echoViolations.join(" ")).toMatch(/simulated=false while the platform expected simulated=true/);
    expect(out.appliedEntityIds).toEqual([]);
  });

  it("the inverse mismatch is caught too — a simulator answering for a LIVE execution", () => {
    const out = reconcileExecution(ops3, report(ops3.map((o) => ({ ref: o.ref, outcome: "applied" as const }))), false);
    expect(out.status).toBe("indeterminate");
  });

  it("raw-only ref variance is ACCEPTED and COUNTED, never refused (§A14.5 canonicalize-then-compare)", () => {
    // Restatement (case/whitespace) is the counterparty echoing our own id differently; a canonical
    // mismatch is a different identity. Conflating the two would turn a cosmetic vendor habit into
    // a false incident on a live-money path.
    const out = reconcileExecution(ops3, report([
      { ref: " NEGATIVE.ADD#N1 ", outcome: "applied" },
      { ref: "negative.add#n2", outcome: "applied" },
      { ref: "negative.add#n3", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("applied");
    expect(out.refsRestated).toBe(1);
    expect(out.echoViolations).toEqual([]);
    expect(canonicalizeRef(" NEGATIVE.ADD#N1 ")).toBe("negative.add#n1");
  });

  it("a non-string ref is a violation, not a crash", () => {
    const out = reconcileExecution(ops3, report([
      { ref: undefined as unknown as string, outcome: "applied" },
      { ref: "negative.add#n2", outcome: "applied" },
      { ref: "negative.add#n3", outcome: "applied" },
    ]), true);
    expect(out.status).toBe("indeterminate");
  });

  it("an empty results array for a real batch => 'indeterminate', never a silent success", () => {
    const out = reconcileExecution(ops3, report([]), true);
    expect(out.status).toBe("indeterminate");
    expect(out.changesUnknown).toBe(3);
  });

  it("detail text is bounded so a hostile executor cannot write unbounded text into the record", () => {
    const out = reconcileExecution([ops3[0]], report([{ ref: ops3[0].ref, outcome: "failed", detail: "x".repeat(5_000) }]), true);
    expect(out.perChange[0].detail).toHaveLength(500);
  });
});

// ─────────────────────────────────────────── authz mapping ─────────────────────────────────────────
describe("cerbosActionForKind / toolNameForKind", () => {
  it("maps every kind onto an action ALREADY granted in resource_search_campaign.yaml", () => {
    // No policy file is touched by SM-21. These three action strings are exactly the ones SM-03
    // already enumerates as elevated-only — inventing a fourth would mean editing a live Cerbos
    // policy, and an unlisted action reads as a silent DENY (project memory
    // `cerbos-new-policy-needs-restart`).
    const granted = new Set(["launch", "set_budget", "apply_negatives"]);
    for (const kind of ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const) {
      expect(granted.has(cerbosActionForKind(kind))).toBe(true);
    }
    expect(cerbosActionForKind("budget")).toBe("set_budget");
    expect(cerbosActionForKind("negatives_batch")).toBe("apply_negatives");
    expect(cerbosActionForKind("pause")).toBe("launch");
    expect(cerbosActionForKind("bid")).toBe("launch");
    expect(cerbosActionForKind("ads_batch")).toBe("launch");
  });

  it("never returns the BASELINE 'update' action for any kind (that tier cannot execute)", () => {
    for (const kind of ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const) {
      expect(cerbosActionForKind(kind)).not.toBe("update");
      expect(cerbosActionForKind(kind)).not.toBe("propose_change");
    }
  });

  it("names a declared high-impact §07 tool for every kind", () => {
    const declared = new Set(["search.launchCampaign", "search.setBudget", "search.applyNegatives"]);
    for (const kind of ["launch", "pause", "budget", "bid", "negatives_batch", "ads_batch"] as const) {
      expect(declared.has(toolNameForKind(kind))).toBe(true);
    }
  });
});
