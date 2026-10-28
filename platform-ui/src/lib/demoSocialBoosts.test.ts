import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-4b, SCP-4c: the demo twin of boosts and the monthly boost budget (BFF §63.11, §63.16) keeps the server's money rules and its order of checks. The first block drives the FIXTURE'S
// OWN scenario ("monthly boost budget: committed, lowering and the stopped boost's spend") against a fresh store, step by step, reading the steps from `scp-stage-machine.json`;
// the rest pins the rules the scenario does not reach (the order of checks, one open boost per post, the warning, a replay) and the invented data of the demo store.
// The store seeds from the day it is first touched, so the clock is pinned to mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import fixture from "./scpStageMachine.json";
import { socialDemo } from "./demoSocial";
import { socialPortalPostsDemo } from "./demoSocialPortal";
import { boostApi, demoBoosts, emptyBoostStore, seedBoostStore } from "./demoSocialBoosts";
import { asBoostBudget, asBoostList, asPortalSpend } from "./socialBoosts";

const NORTHWIND_CYCLE = "soc-cyc-soc-eng-1-2026-10";
const OCT = "2026-10";
const USER: Record<string, string> = { officer: "u-social", approver: "u-pm", company_admin: "u-dev", client: "demo-client" };
const POST: Record<string, string> = { "boost A": "soc-post-n-1", "boost B": "soc-post-n-2", "boost C": "soc-post-n-3" };
type R = { status: number; json: Record<string, unknown> } | null;
const FX = fixture as unknown as {
  refusals: Record<string, { http: number }>;
  scenarios: Array<{ name: string; budget: { agreedMinor: number; currency: string }; steps: Array<{ action: string; actor: string; target?: string; params?: Record<string, unknown>; expect?: Record<string, unknown>; refusal?: string }> }>;
};

const staff = (api: ReturnType<typeof boostApi>, method: string, tail: string, body?: unknown, userId = "demo-hansel", query = ""): R =>
  api.staff(method, tail, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), userId) as R;
const portal = (api: ReturnType<typeof boostApi>, method: string, path: string, body?: unknown, userId = "demo-client"): R =>
  api.portal(method, `/api/co-agency/portal/social/spend${path ? `/${path}` : ""}`,body === undefined ? undefined : JSON.stringify(body), userId) as R;
const request = { goal: "profile_visits", audience: "automatic", startsOn: `${OCT}-20` };

describe("the fixture's scenario: monthly boost budget, committed, lowering and the stopped boost's spend", () => {
  const scenario = FX.scenarios.find((s) => s.name === "monthly boost budget: committed, lowering and the stopped boost's spend")!;

  it("is the scenario this test reads (it exists, and begins with an agreed IDR 1,000,000)", () => {
    expect(scenario).toBeDefined();
    expect(scenario.budget).toEqual({ agreedMinor: 1_000_000, currency: "IDR" });
  });

  it("every step ends as the fixture says: statuses, committed, remaining, the agreement and the refusal codes", () => {
    const api = boostApi(emptyBoostStore());
    expect(staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: scenario.budget.agreedMinor, channel: "meeting", note: "Agreed at the kickoff." })?.status).toBe(200);
    const ids: Record<string, string> = {};
    const view = () => asBoostBudget(staff(api, "GET", `cycles/${NORTHWIND_CYCLE}/boost-budget`)?.json);
    const statusOf = (target: string) => (api.store.boosts.find((b) => b.id === ids[target]) as { status: string; approvedVia: string | null }) ;

    for (const [i, step] of scenario.steps.entries()) {
      const who = USER[step.actor];
      const tag = `step ${i + 1}: ${step.action} by ${step.actor}`;
      let r: R;
      switch (step.action) {
        case "request_boost": {
          r = staff(api, "POST", `posts/${POST[step.target!]}/boosts`, { ...request, ...step.params }, who);
          if (r?.status === 201) ids[step.target!] = (r.json.boost as { id: string }).id;
          break;
        }
        case "approve_boost": r = portal(api, "POST", `boosts/${ids[step.target!]}/decide`, { decision: "approve" }, who); break;
        case "record_boost_budget": r = staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, step.params, who); break;
        default: r = staff(api, "POST", `boosts/${ids[step.target!]}/actions`, { action: step.action, expectedStatus: statusOf(step.target!).status, ...step.params }, who);
      }
      if (step.refusal) {
        expect(r?.json.error, tag).toBe(step.refusal);
        expect(r?.status, tag).toBe(FX.refusals[step.refusal].http);
        continue;
      }
      expect(r?.status, tag).toBeLessThan(300);
      const e = step.expect ?? {};
      if (e.boostStatus !== undefined) expect(statusOf(step.target!).status, tag).toBe(e.boostStatus);
      if (e.approvedVia !== undefined) expect(statusOf(step.target!).approvedVia, tag).toBe(e.approvedVia);
      if (e.committedMinor !== undefined) expect(view().committedMinor, tag).toBe(e.committedMinor);
      if (e.remainingMinor !== undefined) expect(view().remainingMinor, tag).toBe(e.remainingMinor);
      if (e.agreedMinor !== undefined) expect(view().agreed?.amountMinor, tag).toBe(e.agreedMinor);
    }
  });
});

describe("the money rules", () => {
  const fresh = (agreed: number | null = 1_000_000) => {
    const api = boostApi(emptyBoostStore());
    if (agreed !== null) staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: agreed, channel: "email", note: "Agreed by email." });
    return api;
  };
  const ask = (api: ReturnType<typeof boostApi>, post: string, daily: number, days: number, extra: Record<string, unknown> = {}, userId = "u-social") =>
    staff(api, "POST", `posts/${post}/boosts`, { ...request, dailyBudgetMinor: daily, days, ...extra }, userId);

  it("a request whose total fits what remains is approved through the budget; one over it waits for the client", () => {
    const api = fresh();
    const within = ask(api, "soc-post-n-1", 100_000, 10); // exactly the whole budget: it fits
    expect(within?.status).toBe(201);
    expect(within?.json).toMatchObject({ needsClient: false, remainingMinor: 0, boost: { status: "approved", approvedVia: "budget", totalBudgetMinor: 1_000_000 } });
    const over = ask(api, "soc-post-n-2", 1, 1);
    expect(over?.json).toMatchObject({ needsClient: true, remainingMinor: 0, boost: { status: "requested", approvedVia: null } });
  });

  it("with no agreed budget nothing remains, so every request waits for the client", () => {
    const api = fresh(null);
    expect(ask(api, "soc-post-n-1", 1, 1)?.json).toMatchObject({ needsClient: true, boost: { status: "requested" } });
  });

  it("a month with no cycle has nothing agreed either (the boost is not tied to a cycle)", () => {
    const api = fresh();
    const r = staff(api, "POST", "posts/soc-post-n-1/boosts", { ...request, startsOn: "2031-01-10", dailyBudgetMinor: 1, days: 1 }, "u-social");
    expect(r?.json).toMatchObject({ needsClient: true, boost: { status: "requested", cycleId: null } });
  });

  it("a boost belongs to the cycle of the month it starts in, so it counts against that month only", () => {
    const api = fresh();
    ask(api, "soc-post-n-1", 100_000, 2, { startsOn: "2026-11-02" }); // next month: that cycle has no agreed budget
    const oct = asBoostBudget(staff(api, "GET", `cycles/${NORTHWIND_CYCLE}/boost-budget`)?.json);
    expect(oct).toMatchObject({ committedMinor: 0, remainingMinor: 1_000_000 });
  });

  it("committed is the full budget of an approved or running boost and only the spend of a stopped or completed one; remaining is never below 0", () => {
    const api = fresh(300_000);
    const a = ask(api, "soc-post-n-1", 100_000, 3)!.json.boost as { id: string };
    const read = () => asBoostBudget(staff(api, "GET", `cycles/${NORTHWIND_CYCLE}/boost-budget`)?.json);
    expect(read()).toMatchObject({ committedMinor: 300_000, remainingMinor: 0 });
    staff(api, "POST", `boosts/${a.id}/actions`, { action: "start_boost", expectedStatus: "approved" }, "u-social");
    expect(read().committedMinor).toBe(300_000);
    staff(api, "POST", `boosts/${a.id}/actions`, { action: "stop_boost", expectedStatus: "running", spendMinor: 120_000 }, "u-social");
    expect(read()).toMatchObject({ committedMinor: 120_000, remainingMinor: 180_000 });
    staff(api, "POST", `boosts/${a.id}/actions`, { action: "complete_boost", expectedStatus: "stopped", spendMinor: 130_000, paidReach: 4_000, clicks: 90 }, "u-social");
    expect(read().committedMinor).toBe(130_000);
    // an agreement raised by the client's own approval can leave committed above agreed: remaining reads 0, not a negative
    const over = ask(api, "soc-post-n-2", 100_000, 5)!.json.boost as { id: string };
    portal(api, "POST", `boosts/${over.id}/decide`, { decision: "approve" });
    expect(read()).toMatchObject({ committedMinor: 630_000, remainingMinor: 0 });
  });

  it("lowering is allowed down to committed and not below it: 409 budget_below_committed with the figure, when proposed, recorded and agreed", () => {
    const api = fresh(1_000_000);
    ask(api, "soc-post-n-1", 100_000, 5); // approved, 500,000 committed
    const below = staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/proposals`, { amountMinor: 400_000 });
    expect(below).toMatchObject({ status: 409, json: { error: "budget_below_committed", detail: { committedMinor: 500_000, currency: "IDR" } } });
    expect(staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 499_999, channel: "email", note: "Lower." })?.json.error).toBe("budget_below_committed");
    const exact = staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/proposals`, { amountMinor: 500_000, note: "Down to what is committed." });
    expect(exact?.status).toBe(201);
    // the proposal waited; a boost committed more meanwhile, so the client's agreement is judged against committed at that moment
    ask(api, "soc-post-n-2", 100_000, 5, {}, "u-pm"); // fits 500,000? remaining 500,000 -> approved: committed 1,000,000
    const id = exact?.json.proposalId as string;
    expect(portal(api, "POST", `budgets/${id}/decide`, { decision: "agree" })).toMatchObject({ status: 409, json: { error: "budget_below_committed" } });
  });

  it("a recording supersedes the pending proposal and the previous agreement", () => {
    const api = fresh(1_000_000);
    staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/proposals`, { amountMinor: 1_200_000 });
    const rec = staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 1_100_000, channel: "whatsapp", note: "By phone." });
    const b = asBoostBudget(rec?.json);
    expect(b.agreed).toMatchObject({ amountMinor: 1_100_000, via: "recorded", channel: "whatsapp" });
    expect(b.pending).toBeNull();
    expect(b.history.map((h) => h.status).sort()).toEqual(["superseded", "superseded"]);
  });
});

describe("the order of checks", () => {
  const api = () => boostApi(emptyBoostStore());

  it("an unknown target is 404 before the role is judged", () => {
    const a = api();
    expect(staff(a, "POST", "posts/no-such/boosts", {}, "u-dev")).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(staff(a, "POST", "boosts/no-such/actions", {}, "u-dev")).toMatchObject({ status: 404, json: { error: "boost_not_found" } });
    expect(staff(a, "GET", "cycles/no-such/boost-budget")).toMatchObject({ status: 404, json: { error: "cycle_not_found" } });
    expect(staff(a, "POST", "cycles/no-such/boost-budget/proposals", {}, "u-dev")).toMatchObject({ status: 404, json: { error: "cycle_not_found" } });
    expect(staff(a, "POST", "boost-budget/proposals/no-such/withdraw", {}, "u-dev")).toMatchObject({ status: 404, json: { error: "proposal_not_found" } });
  });

  it("then the role: only the client's officer and the two seats run a boost (not the owner); only the four approvers record money; a role refusal beats a bad body", () => {
    const a = api();
    for (const who of ["demo-owner", "u-dev", "u-social-2"]) {
      expect(staff(a, "POST", "posts/soc-post-n-1/boosts", {}, who), who).toMatchObject({ status: 403, json: { error: "not_officer_or_approver" } });
    }
    for (const who of ["u-social", "u-pm", "u-gm", "demo-hansel"]) {
      expect(staff(a, "POST", "posts/soc-post-n-1/boosts", {}, who)?.status, who).toBe(400); // allowed: the empty body is the first refusal
    }
    for (const who of ["u-social", "u-dev"]) {
      expect(staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, {}, who), who).toMatchObject({ status: 403, json: { error: "not_a_social_approver" } });
    }
    expect(staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, {}, "demo-owner")?.status).toBe(400); // the owner is one of the four
  });

  it("then the body, naming the field", () => {
    const a = api();
    const field = (body: Record<string, unknown>) => staff(a, "POST", "posts/soc-post-n-1/boosts", body, "u-social")?.json;
    expect(field({})).toEqual({ error: "missing_field", field: "goal" });
    expect(field({ ...request, goal: "fame", dailyBudgetMinor: 1, days: 1 })).toEqual({ error: "invalid_field", field: "goal" });
    expect(field({ ...request, audience: "custom", dailyBudgetMinor: 1, days: 1 })).toEqual({ error: "missing_field", field: "audienceNote" });
    expect(field({ ...request, dailyBudgetMinor: 0, days: 1 })).toEqual({ error: "invalid_field", field: "dailyBudgetMinor" });
    expect(field({ ...request, dailyBudgetMinor: 1.5, days: 1 })).toEqual({ error: "invalid_field", field: "dailyBudgetMinor" });
    expect(field({ ...request, dailyBudgetMinor: 1 })).toEqual({ error: "missing_field", field: "days" });
    expect(field({ ...request, dailyBudgetMinor: 1, days: 1, startsOn: "2026-02-30" })).toEqual({ error: "invalid_field", field: "startsOn" });
    expect(staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 5 }, "u-pm")?.json).toEqual({ error: "missing_field", field: "channel" });
    expect(staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 5, channel: "email" }, "u-pm")?.json).toEqual({ error: "missing_field", field: "note" });
  });

  it("then the fixture's guards in order: post_live, no_open_boost, currency_matches_budget", () => {
    const a = api();
    const ok1 = staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 1, days: 1 }, "u-social");
    expect(ok1?.status).toBe(201);
    expect(staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 1, days: 1 }, "u-social")).toMatchObject({ status: 409, json: { error: "open_boost_exists" } });
    expect(staff(a, "POST", "posts/soc-post-n-5/boosts", { ...request, dailyBudgetMinor: 1, days: 1 }, "u-social")).toMatchObject({ status: 409, json: { error: "post_not_live" } }); // scheduled, not live
    staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 100, channel: "email", note: "Agreed." });
    expect(staff(a, "POST", "posts/soc-post-n-2/boosts", { ...request, dailyBudgetMinor: 1, days: 1, currency: "USD" }, "u-social")).toMatchObject({ status: 409, json: { error: "currency_mismatch" } });
  });

  it("an action: the role, then the body, then the page's picture of the status, then the fixture's `from` list", () => {
    const a = api();
    staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 100, channel: "email", note: "Agreed." });
    const id = (staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 1, days: 1 }, "u-social")?.json.boost as { id: string }).id; // within the budget: approved
    const act = (body: Record<string, unknown>, who = "u-social") => staff(a, "POST", `boosts/${id}/actions`, body, who);
    expect(act({ action: "start_boost" }, "demo-owner")).toMatchObject({ status: 403, json: { error: "not_officer_or_approver" } });
    expect(act({ action: "record_boost_approval" }, "u-social")).toMatchObject({ status: 403, json: { error: "not_a_social_approver" } });
    expect(act({ action: "fly" })?.json.error).toBe("unknown_action");
    expect(act({ action: "start_boost" })?.json).toEqual({ error: "missing_field", field: "expectedStatus" });
    expect(act({ action: "start_boost", expectedStatus: "requested" })).toMatchObject({ status: 409, json: { error: "boost_status_changed", detail: { status: "approved" } } });
    expect(act({ action: "stop_boost", expectedStatus: "approved", spendMinor: 5 })).toMatchObject({ status: 409, json: { error: "invalid_boost_transition", detail: { status: "approved" } } });
    expect(act({ action: "record_boost_approval", expectedStatus: "approved", channel: "email", note: "x" }, "u-pm")).toMatchObject({ status: 409, json: { error: "boost_not_waiting" } });
  });

  it("stop needs the spend; complete needs the spend and the paid reach; clicks are optional; a spend above the budget is a warning, not a refusal", () => {
    const a = api();
    const id = (staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 100, days: 1 }, "u-social")?.json.boost as { id: string }).id;
    staff(a, "POST", `boosts/${id}/actions`, { action: "cancel_boost", expectedStatus: "requested" }, "u-social");
    const b = (staff(a, "POST", "posts/soc-post-n-2/boosts", { ...request, dailyBudgetMinor: 100, days: 1 }, "u-social")?.json.boost as { id: string }).id;
    const act = (body: Record<string, unknown>) => staff(a, "POST", `boosts/${b}/actions`, body, "u-social");
    act({ action: "approve_boost" }); // not an action of staff: unknown
    portal(a, "POST", `boosts/${b}/decide`, { decision: "approve" });
    act({ action: "start_boost", expectedStatus: "approved" });
    expect(act({ action: "stop_boost", expectedStatus: "running" })?.json).toEqual({ error: "missing_field", field: "spendMinor" });
    expect(act({ action: "stop_boost", expectedStatus: "running", spendMinor: -1 })?.json).toEqual({ error: "invalid_field", field: "spendMinor" });
    const stopped = act({ action: "stop_boost", expectedStatus: "running", spendMinor: 60 });
    expect(stopped?.status).toBe(200);
    expect(stopped?.json.warnings).toEqual([]);
    expect(act({ action: "complete_boost", expectedStatus: "stopped", spendMinor: 60 })?.json).toEqual({ error: "missing_field", field: "paidReach" });
    const done = act({ action: "complete_boost", expectedStatus: "stopped", spendMinor: 150, paidReach: 900 });
    expect(done?.status).toBe(200);
    expect(done?.json.warnings).toEqual(["spend_above_budget"]);
    expect((done?.json.boost as { status: string; clicks: number | null }).clicks).toBeNull();
  });

  it("recording the client's answer needs a channel and a note, and moves a waiting boost", () => {
    const a = api();
    const id = (staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 100, days: 1 }, "u-social")?.json.boost as { id: string }).id;
    const rec = (body: Record<string, unknown>, who = "demo-owner") => staff(a, "POST", `boosts/${id}/actions`, { expectedStatus: "requested", ...body }, who);
    expect(rec({ action: "record_boost_decline" })?.json).toEqual({ error: "missing_field", field: "channel" });
    expect(rec({ action: "record_boost_decline", channel: "carrier pigeon", note: "x" })?.json).toEqual({ error: "invalid_field", field: "channel" });
    const r = rec({ action: "record_boost_approval", channel: "meeting", note: "Agreed at the call." });
    expect(r?.json).toMatchObject({ boost: { status: "approved", approvedVia: "recorded" } });
  });

  it("a request with the same id again is the same boost (no second row)", () => {
    const a = api();
    const first = staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, id: "boost-1", dailyBudgetMinor: 100, days: 1 }, "u-social");
    const again = staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, id: "boost-1", dailyBudgetMinor: 100, days: 1 }, "u-social");
    expect(first?.status).toBe(201);
    expect(again?.status).toBe(200);
    expect(a.store.boosts).toHaveLength(1);
  });

  it("an action carries a fresh actionId: a replay of it answers alreadyApplied and acts once; the request says whether it created the boost", () => {
    const a = api();
    staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 1000, channel: "email", note: "Agreed." });
    const first = staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, id: "boost-r", dailyBudgetMinor: 1, days: 1 }, "u-social");
    expect(first?.json).toMatchObject({ created: true });
    expect(staff(a, "POST", "posts/soc-post-n-1/boosts", { ...request, id: "boost-r", dailyBudgetMinor: 1, days: 1 }, "u-social")?.json).toMatchObject({ created: false });
    const act = (body: Record<string, unknown>) => staff(a, "POST", "boosts/boost-r/actions", body, "u-social");
    expect(act({ action: "start_boost", expectedStatus: "approved", actionId: "act-1" })?.json).toMatchObject({ boost: { status: "running" }, warnings: [] });
    expect(act({ action: "start_boost", expectedStatus: "approved", actionId: "act-1" })).toMatchObject({ status: 200, json: { alreadyApplied: true, boost: { status: "running" } } });
    expect(act({ action: "start_boost", expectedStatus: "approved", actionId: "act-2" })).toMatchObject({ status: 409, json: { error: "boost_status_changed" } });
    expect(act({ action: "start_boost", expectedStatus: "approved", actionId: "not a uuid!" })?.json).toEqual({ error: "invalid_field", field: "actionId" });
  });

  it("the budget read carries its cycle, currency and minor unit, and the agreement's id; a write answers the read with the proposal's id", () => {
    const a = api();
    const rec = staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 1000, channel: "email", note: "Agreed." });
    expect(rec?.json).toMatchObject({ cycleId: NORTHWIND_CYCLE, currency: "IDR", minorUnit: 0, agreed: { id: expect.any(String), amountMinor: 1000 }, proposalId: expect.any(String) });
    const b = asBoostBudget(rec?.json);
    expect(b.cycleId).toBe(NORTHWIND_CYCLE);
    expect(b.agreed?.id).toBeTruthy();
    const prop = staff(a, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/proposals`, { amountMinor: 2000 });
    expect(prop?.status).toBe(201);
    expect(asBoostBudget(prop?.json).pending).toMatchObject({ amountMinor: 2000 });
    expect(staff(a, "POST", `boost-budget/proposals/${prop?.json.proposalId}/withdraw`, {})?.json).toMatchObject({ pending: null, proposalId: prop?.json.proposalId });
  });

  it("the estimate: the words of its basis, the audience narrowing it, and the field named when a query value is wrong", () => {
    const a = api();
    const est = (q: string, post = "soc-post-n-1") => staff(a, "GET", `posts/${post}/boosts/estimate`, undefined, "u-social", q)!;
    const auto = est("dailyBudgetMinor=100000&days=5&audience=automatic");
    const local = est("dailyBudgetMinor=100000&days=5&audience=local");
    expect(auto.json).toMatchObject({ basis: "history" });
    expect(local.json.reachHigh as number).toBeLessThan(auto.json.reachHigh as number);
    expect(est("dailyBudgetMinor=100000&days=5", "soc-post-h-1").json.basis).toBe("simulated"); // the hotel's live post is simulated
    expect(est("dailyBudgetMinor=0&days=5").json).toEqual({ error: "invalid_field", field: "dailyBudgetMinor" });
    expect(est("dailyBudgetMinor=5&days=5&audience=everyone").json).toEqual({ error: "invalid_field", field: "audience" });
    expect(staff(a, "GET", "posts/no-such/boosts/estimate", undefined, "u-social", "dailyBudgetMinor=1&days=1")?.status).toBe(404);
  });
});

describe("the portal", () => {
  const fresh = () => {
    const api = boostApi(emptyBoostStore());
    staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/record`, { amountMinor: 300_000, channel: "email", note: "Agreed." });
    const over = (staff(api, "POST", "posts/soc-post-n-1/boosts", { ...request, dailyBudgetMinor: 200_000, days: 5 }, "u-social")?.json.boost as { id: string }).id;
    const proposal = (staff(api, "POST", `cycles/${NORTHWIND_CYCLE}/boost-budget/proposals`, { amountMinor: 1_500_000, note: "A bigger month." }, "u-pm")?.json.proposalId as string);
    return { api, over, proposal };
  };

  it("lists the waiting items for the contact's client, and tells a viewer from a signer in `canDecide`", () => {
    const { api, over, proposal } = fresh();
    const s = asPortalSpend(portal(api, "GET", "")?.json);
    expect(s.canDecide).toBe(true);
    expect(s.boosts).toEqual([expect.objectContaining({ boostId: over, postTitle: "Harvest collection arrives", totalBudgetMinor: 1_000_000, days: 5, remainingMinor: 300_000, thumbFileId: "soc-post-n-1-f1" })]);
    expect(s.budgets).toEqual([expect.objectContaining({ proposalId: proposal, amountMinor: 1_500_000, agreedMinor: 300_000, committedMinor: 0, note: "A bigger month.", month: OCT })]);
    expect(JSON.stringify(portal(api, "GET", "")?.json)).not.toMatch(/fees?/i); // the client never sees our fees
    expect(asPortalSpend(portal(api, "GET", "", undefined, "demo-client-viewer")?.json).canDecide).toBe(false);
  });

  it("a staff caller is 403 'not a portal client', never an empty list", () => {
    const { api } = fresh();
    expect(portal(api, "GET", "", undefined, "u-pm")).toMatchObject({ status: 403 });
    expect(portal(api, "POST", "boosts/x/decide", { decision: "approve" }, "u-pm")?.status).toBe(403);
  });

  it("a viewer sees the items but cannot decide: 403 view_only after the target is found (an unknown target is 404 first)", () => {
    const { api, over, proposal } = fresh();
    expect(portal(api, "POST", `boosts/${over}/decide`, { decision: "approve" }, "demo-client-viewer")).toMatchObject({ status: 403, json: { error: "view_only" } });
    expect(portal(api, "POST", `budgets/${proposal}/decide`, { decision: "agree" }, "demo-client-viewer")).toMatchObject({ status: 403, json: { error: "view_only" } });
    expect(portal(api, "POST", "boosts/no-such/decide", { decision: "approve" }, "demo-client-viewer")).toMatchObject({ status: 404, json: { error: "boost_not_found" } });
    expect(portal(api, "POST", "budgets/no-such/decide", { decision: "agree" }, "demo-client-viewer")).toMatchObject({ status: 404, json: { error: "proposal_not_found" } });
  });

  it("a signer's decision: body checked, applied once, a replay is alreadyDecided, a different one is 409", () => {
    const { api, over, proposal } = fresh();
    expect(portal(api, "POST", `boosts/${over}/decide`, { decision: "maybe" })?.json).toEqual({ error: "invalid_field", field: "decision" });
    expect(portal(api, "POST", `boosts/${over}/decide`, { decision: "approve", note: "Go ahead." })?.status).toBe(200);
    expect(api.store.boosts[0]).toMatchObject({ status: "approved", approvedVia: "portal" });
    expect(portal(api, "POST", `boosts/${over}/decide`, { decision: "approve" })?.json).toEqual({ alreadyDecided: true });
    expect(portal(api, "POST", `boosts/${over}/decide`, { decision: "decline" })).toMatchObject({ status: 409, json: { error: "boost_already_decided" } });

    expect(portal(api, "POST", `budgets/${proposal}/decide`, { decision: "agree" })?.status).toBe(200);
    expect(asBoostBudget(staff(api, "GET", `cycles/${NORTHWIND_CYCLE}/boost-budget`)?.json).agreed).toMatchObject({ amountMinor: 1_500_000, via: "portal" });
    expect(portal(api, "POST", `budgets/${proposal}/decide`, { decision: "agree" })?.json).toEqual({ alreadyDecided: true });
    expect(portal(api, "POST", `budgets/${proposal}/decide`, { decision: "decline" })).toMatchObject({ status: 409, json: { error: "budget_already_decided" } });
  });

  it("a decline moves a boost to declined, which commits nothing", () => {
    const { api, over } = fresh();
    portal(api, "POST", `boosts/${over}/decide`, { decision: "decline" });
    expect(api.store.boosts[0].status).toBe("declined");
    expect(api.committed(api.store.boosts[0].cycleId)).toBe(0);
  });
});

describe("the demo store's invented data (BFF §63.16)", () => {
  const read = () => asBoostList(socialDemo("GET", "/api/co-agency/modules/social/boosts", new URLSearchParams(), undefined, "demo-hansel")?.json);

  it("holds a boost inside the monthly budget, one over it waiting for the client, one running and one completed with results", () => {
    const { items } = read();
    const by = (status: string) => items.filter((b) => b.status === status);
    expect(by("approved")[0]).toMatchObject({ approvedVia: "budget", clientName: "Northwind Traders", totalBudgetMinor: 300_000 });
    expect(by("running")[0]).toMatchObject({ clientName: "Northwind Traders", totalBudgetMinor: 200_000 });
    expect(by("requested").map((b) => b.clientName).sort()).toEqual(["Harborlight Hotel", "Northwind Traders"]);
    expect(by("requested").find((b) => b.clientName === "Northwind Traders")).toMatchObject({ totalBudgetMinor: 600_000, approvedVia: null });
    expect(by("completed")[0]).toMatchObject({ spendMinor: 142_500, paidReach: 6_100, clicks: 230, clientName: "Saltmarsh Day Spa" });
    expect(items.find((b) => b.simulated)).toMatchObject({ clientName: "Harborlight Hotel", status: "requested" });
  });

  it("shows Northwind's current cycle with an agreed IDR 1,000,000, committed 500,000 and 500,000 remaining, and its history", () => {
    const b = asBoostBudget(socialDemo("GET", `/api/co-agency/modules/social/cycles/${NORTHWIND_CYCLE}/boost-budget`, new URLSearchParams(), undefined, "u-pm")?.json);
    expect(b).toMatchObject({ agreed: { amountMinor: 1_000_000, via: "portal" }, committedMinor: 500_000, remainingMinor: 500_000, canRecord: true, pending: null });
    expect(b.history.map((h) => h.status).sort()).toEqual(["declined", "superseded"]);
    const officer = asBoostBudget(socialDemo("GET", `/api/co-agency/modules/social/cycles/${NORTHWIND_CYCLE}/boost-budget`, new URLSearchParams(), undefined, "u-social")?.json);
    expect(officer.canRecord).toBe(false);
  });

  it("holds a pending proposal for another client (the hotel), and one for Northwind's next month", () => {
    const hotel = asBoostBudget(socialDemo("GET", "/api/co-agency/modules/social/cycles/soc-cyc-soc-eng-4-2026-10/boost-budget", new URLSearchParams(), undefined, "u-pm")?.json);
    expect(hotel).toMatchObject({ agreed: null, remainingMinor: 0, pending: { amountMinor: 800_000, status: "pending" } });
    const next = asBoostBudget(socialDemo("GET", "/api/co-agency/modules/social/cycles/soc-cyc-soc-eng-1-2026-11/boost-budget", new URLSearchParams(), undefined, "u-pm")?.json);
    expect(next.pending).toMatchObject({ amountMinor: 1_200_000 });
  });

  it("names exactly one live boost candidate with no boost, and the post read carries the post's boost", () => {
    expect(read().candidates).toEqual([expect.objectContaining({ postId: "soc-post-n-2", title: "A day in the warehouse", clientName: "Northwind Traders" })]);
    const post = (id: string) => socialDemo("GET", `/api/co-agency/modules/social/posts/${id}/pipeline`, new URLSearchParams(), undefined, "u-social")?.json as { boost: { status: string } | null };
    expect(post("soc-post-n-1").boost).toMatchObject({ status: "approved" });
    expect(post("soc-post-n-2").boost).toBeNull();
    expect(post("soc-post-n-6").boost).toBeNull(); // not live
  });

  it("the Boosting list filters by status and its totals follow the filter", () => {
    const r = asBoostList(socialDemo("GET", "/api/co-agency/modules/social/boosts", new URLSearchParams("status=completed"), undefined, "demo-hansel")?.json);
    expect(r.items).toHaveLength(1);
    expect(r.totals).toEqual({ committedMinor: 142_500, spendMinor: 142_500, currency: "IDR" });
    expect(socialDemo("GET", "/api/co-agency/modules/social/boosts", new URLSearchParams("status=lost"), undefined, "demo-hansel")).toMatchObject({ status: 400, json: { field: "status" } });
  });

  it("a client contact is not staff: the staff reads refuse it", () => {
    expect(socialDemo("GET", "/api/co-agency/modules/social/boosts", new URLSearchParams(), undefined, "demo-client")?.status).toBe(403);
  });

  it("answers the portal's spend read with Northwind's boost over the budget and the proposal for next month", () => {
    const s = asPortalSpend(demoBoosts.portal("GET", "/api/co-agency/portal/social/spend", undefined, "demo-client")?.json);
    expect(s.boosts).toEqual([expect.objectContaining({ postTitle: "Reader favourite reshare", totalBudgetMinor: 600_000, remainingMinor: 500_000 })]);
    expect(s.budgets).toEqual([expect.objectContaining({ amountMinor: 1_200_000, agreedMinor: null, month: "2026-11" })]);
    expect(s.history.length).toBeGreaterThan(0);
    expect(socialPortalPostsDemo("GET", "/api/co-agency/portal/social/spend", new URLSearchParams(), "demo-client")).toBeNull(); // not a route of 63.9
  });

  it("seeds the same data every time (a fresh seed equals the pinned store's shape)", () => {
    expect(seedBoostStore().boosts.map((b) => b.status).sort()).toEqual(["approved", "completed", "requested", "requested", "running"]);
  });
});
