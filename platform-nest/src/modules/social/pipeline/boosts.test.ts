// SCP-4a — the pure half of boosts and the monthly budget (no database): the money rules against the fixture, the estimate, the request body,
// and the coverage of the fixture's `boosts` and `boostBudgets` by the routes. The SQL, the walls, the lock and the HTTP answers are proved
// against real Postgres and Cerbos in boosts.http.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCP } from "./fixture";
import {
  BOOST_STATUSES, BUDGET_STATUSES, MAX_MINOR, committedBy, committedOf, estimateFrom, fitsRemaining, remainingOf,
} from "./boosts-data";
import { BOOST_ACTION_ROUTES, BOOST_RECORD_ACTIONS, BOOST_ROUTE_ACTIONS, isRealIsoDate, parseBoostRequest, parseTransitionParams } from "./boosts";

const RULE_WORDS: Record<string, (total: number, spend: number) => number> = {
  "total budget": (total) => total,
  "actual spend": (_t, spend) => spend,
  nothing: () => 0,
};

describe("SCP-4a · the money rules (fixture `boosts.committedBy`, SCP-Q15)", () => {
  it("the statuses are the fixture's and the migration's", () => {
    expect([...BOOST_STATUSES]).toEqual(SCP.boosts.statuses);
    expect([...BUDGET_STATUSES]).toEqual(SCP.boostBudgets.statuses);
  });

  it("committedBy is the fixture's word for every status", () => {
    const by = SCP.boosts.committedBy as Record<string, string>;
    expect(Object.keys(by).sort()).toEqual([...BOOST_STATUSES].sort());
    for (const [status, word] of Object.entries(by)) {
      expect(RULE_WORDS[word], word).toBeDefined();
      expect(committedBy(status, 500_000, 200_000), status).toBe(RULE_WORDS[word](500_000, 200_000));
    }
    expect(committedBy("stopped", 500_000, null)).toBe(0);
  });

  it("the fixture's scenario figures follow from the rules", () => {
    // A approved 500k, B approved 1M, A stopped at 200k, B cancelled.
    expect(committedOf([{ status: "approved", totalMinor: 500_000, spendMinor: null }])).toBe(500_000);
    expect(committedOf([{ status: "approved", totalMinor: 500_000, spendMinor: null }, { status: "approved", totalMinor: 1_000_000, spendMinor: null }])).toBe(1_500_000);
    expect(committedOf([{ status: "stopped", totalMinor: 500_000, spendMinor: 200_000 }, { status: "approved", totalMinor: 1_000_000, spendMinor: null }])).toBe(1_200_000);
    expect(committedOf([{ status: "stopped", totalMinor: 500_000, spendMinor: 200_000 }, { status: "cancelled", totalMinor: 1_000_000, spendMinor: null }])).toBe(200_000);
    expect(remainingOf(1_000_000, 1_500_000)).toBe(0); // shown as 0 when below
    expect(remainingOf(1_000_000, 200_000)).toBe(800_000);
    expect(remainingOf(600_000, 200_000)).toBe(400_000);
    expect(remainingOf(null, 0)).toBe(0); // no agreed budget: nothing remains
  });

  it("fits against the raw difference, only with an agreement; the exact amount fits", () => {
    expect(fitsRemaining(1_000_000, 0, 500_000)).toBe(true);
    expect(fitsRemaining(1_000_000, 500_000, 500_000)).toBe(true);
    expect(fitsRemaining(1_000_000, 500_000, 500_001)).toBe(false);
    expect(fitsRemaining(1_000_000, 1_200_000, 0)).toBe(false); // over-committed (a spend above budget): nothing fits
    expect(fitsRemaining(null, 0, 1)).toBe(false);
  });
});

describe("SCP-4a · the estimate (`GET posts/:postId/boosts/estimate`)", () => {
  it("history: paid reach per minor unit spent, times the total, 80% to 120%", () => {
    expect(estimateFrom({ totalMinor: 500_000, minorUnit: 0, simulated: false, historyReach: 10_000, historySpend: 100_000 }))
      .toEqual({ reachLow: 40_000, reachHigh: 60_000, basis: "history" });
  });
  it("simulated: only a simulated post with no history, deterministic; a real post with none is none", () => {
    expect(estimateFrom({ totalMinor: 500_000, minorUnit: 0, simulated: true, historyReach: 0, historySpend: 0 }))
      .toEqual({ reachLow: 10_000, reachHigh: 30_000, basis: "simulated" });
    expect(estimateFrom({ totalMinor: 500_000, minorUnit: 0, simulated: false, historyReach: 0, historySpend: 0 }))
      .toEqual({ reachLow: null, reachHigh: null, basis: "none" });
  });
});

describe("SCP-4a · the request body (400 {field}, after the decision)", () => {
  const good = { goal: "website", audience: "automatic", dailyBudgetMinor: 100_000, days: 5, startsOn: "2027-03-02" };
  const fieldOf = (body: unknown): string | null => {
    try { parseBoostRequest(body); return null; } catch (e) { return ((e as { getResponse(): { field?: string } }).getResponse()).field ?? "?"; }
  };
  it("accepts the contract's body and refuses each bad field by name", () => {
    expect(parseBoostRequest(good)).toMatchObject({ goal: "website", days: 5, currency: null, id: null });
    expect(fieldOf({ ...good, goal: "likes" })).toBe("goal");
    expect(fieldOf({ ...good, audience: undefined })).toBe("audience");
    expect(fieldOf({ ...good, audience: "custom" })).toBe("audienceNote"); // the note is required for custom
    expect(fieldOf({ ...good, audience: "custom", audienceNote: "Women 25-40 in Bali" })).toBeNull();
    expect(fieldOf({ ...good, dailyBudgetMinor: 0 })).toBe("dailyBudgetMinor");
    expect(fieldOf({ ...good, dailyBudgetMinor: 1.5 })).toBe("dailyBudgetMinor");
    expect(fieldOf({ ...good, dailyBudgetMinor: MAX_MINOR, days: 2 })).toBe("dailyBudgetMinor"); // the total may not exceed 10^12
    expect(fieldOf({ ...good, days: 91 })).toBe("days");
    expect(fieldOf({ ...good, startsOn: "2027-02-31" })).toBe("startsOn");
    expect(fieldOf({ ...good, currency: "idr" })).toBe("currency");
    expect(fieldOf({ ...good, id: "not-a-uuid" })).toBe("id");
    expect(isRealIsoDate("2028-02-29")).toBe(true);
    expect(isRealIsoDate("2027-02-29")).toBe(false);
  });
  it("each action's own params", () => {
    expect(() => parseTransitionParams("stop_boost", {})).toThrow();
    expect(parseTransitionParams("stop_boost", { spendMinor: 0 })).toEqual({ spendMinor: 0, paidReach: null, clicks: null });
    expect(() => parseTransitionParams("complete_boost", { spendMinor: 10 })).toThrow(); // paidReach required
    expect(() => parseTransitionParams("record_boost_approval", { channel: "fax", note: "x" })).toThrow();
    expect(parseTransitionParams("record_boost_decline", { channel: "email", note: " No. " })).toEqual({ channel: "email", note: "No." });
  });
});

describe("SCP-4a · the fixture's boosts and budgets are all carried", () => {
  const all = [...SCP.boosts.actions, ...SCP.boostBudgets.actions];

  it("every action of `boosts` and `boostBudgets` has its route, and nothing else does", () => {
    expect(Object.keys(BOOST_ACTION_ROUTES).sort()).toEqual(all.map((a) => a.action).sort());
  });

  it("the action route takes exactly the staff boost actions of the fixture; the record actions gate on budget", () => {
    const staff = SCP.boosts.actions.filter((a) => !a.cerbosAction.startsWith("portal:") && a.action !== "request_boost").map((a) => a.action);
    expect([...BOOST_ROUTE_ACTIONS].sort()).toEqual(staff.sort());
    for (const a of SCP.boosts.actions) {
      if (BOOST_RECORD_ACTIONS.has(a.action)) expect(a.cerbosAction, a.action).toBe("social_engagement:budget");
      else if ((BOOST_ROUTE_ACTIONS as readonly string[]).includes(a.action)) expect(a.cerbosAction, a.action).toBe("boost");
    }
  });

  it("every refusal a boost or budget guard names is catalogued with its HTTP status", () => {
    for (const a of all) for (const g of a.guards ?? []) expect(SCP.refusals[g.refusal]?.http, `${a.action}: ${g.refusal}`).toBeGreaterThan(0);
    for (const code of ["boost_not_found", "proposal_not_found", "cycle_not_found", "boost_status_changed", "invalid_boost_transition",
      "boost_already_decided", "budget_already_decided", "not_officer_or_approver", "not_a_social_approver", "view_only", "automation_cannot_act"]) {
      expect(SCP.refusals[code]?.http, code).toBeGreaterThan(0);
    }
  });
});

describe("SCP-4a · no ads are bought (§63.11): the boost code reaches no network", () => {
  it("no fetch, no HTTP client, no publisher in the boost files", () => {
    for (const f of ["boosts.ts", "boosts-data.ts", "boosts.controller.ts", "portal-spend.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|from "(node:)?https?"|axios|undici|getPublisher|resolvePublisher|resolveSimulatedPublisher/);
    }
  });
});
