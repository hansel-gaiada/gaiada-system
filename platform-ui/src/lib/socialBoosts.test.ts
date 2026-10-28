import { describe, it, expect } from "vitest";
import fixture from "./scpStageMachine.json";
import {
  BOOST_STATUSES, asBoostBudget, asBoostList, asBoostRow, asBoostEstimate, asPortalSpend, boostOffers, boostRefusalText, budgetLine, buildBoostAction, buildBoostRequest, buildBudgetBody,
  emptyActionForm, emptyBudgetForm, emptyRequestForm, formatBoostMoney, hasHiddenOffers, isOpenBoost, parseMoneyInput, plainDate, portalSpendHasContent, requestTotal,
} from "./socialBoosts";
import { REFUSAL_WORDS } from "./socialPipeline";

// SCP-4b, SCP-4c (BFF §63.11): the pure half of the boost pages: parsing, money display, the request and action forms' checks, what the card offers and the refusal words.

const FX = fixture as unknown as { refusals: Record<string, unknown>; boosts: { statuses: string[]; actions: Array<{ action: string; from: string[]; cerbosAction: string }> } };
const row = (over: Record<string, unknown> = {}) => ({
  id: "b1", postId: "p1", postTitle: "A post", clientName: "Northwind Traders", cycleId: "c1", status: "approved", goal: "website", audience: "automatic", audienceNote: null,
  dailyBudgetMinor: 100_000, days: 3, totalBudgetMinor: 300_000, currency: "IDR", minorUnit: 0, startsOn: "2026-10-28", approvedVia: "budget", approvedAt: "2026-10-16T01:00:00Z",
  startedAt: null, endedAt: null, spendMinor: null, paidReach: null, clicks: null, reachEstimate: { low: 100, high: 200 }, simulated: false, ...over,
});

describe("the boost row and the answers", () => {
  it("reads a BoostRow, keeps a missing counter null (never 0) and refuses a body that is not one", () => {
    const b = asBoostRow(row());
    expect(b).toMatchObject({ id: "b1", status: "approved", totalBudgetMinor: 300_000, spendMinor: null, paidReach: null, clicks: null, reachEstimate: { low: 100, high: 200 }, simulated: false });
    expect(asBoostRow(row({ simulated: true, spendMinor: 0 }))).toMatchObject({ simulated: true, spendMinor: 0 });
    expect(() => asBoostRow({ id: "x" })).toThrow();
    expect(() => asBoostList({})).toThrow();
    expect(() => asBoostBudget({ agreed: null })).toThrow();
    expect(() => asPortalSpend({ budgets: [] })).toThrow();
    expect(() => asBoostEstimate({ reachLow: 1 })).toThrow();
    expect(() => asBoostEstimate({ reachLow: 1, reachHigh: 2, basis: "guess" })).toThrow();
    expect(asBoostEstimate({ reachLow: null, reachHigh: null, basis: "none" })).toEqual({ low: null, high: null, basis: "none" }); // no basis: no made-up number
    expect(asBoostEstimate({ reachLow: 8, reachHigh: 12, basis: "history" })).toEqual({ low: 8, high: 12, basis: "history" });
  });

  it("reads the list, the candidates and the totals", () => {
    const l = asBoostList({ items: [row()], candidates: [{ postId: "p2", clientName: "C", title: "T", engagementRate: 0.07, accountAverageRate: 0.03 }, { nope: 1 }], totals: { committedMinor: 5, spendMinor: 2, currency: "IDR" } });
    expect(l.items).toHaveLength(1);
    expect(l.candidates).toEqual([{ postId: "p2", clientName: "C", title: "T", engagementRate: 0.07, accountAverageRate: 0.03 }]);
    expect(l.totals).toEqual({ committedMinor: 5, spendMinor: 2, currency: "IDR" });
    expect(l.nextCursor).toBeNull();
  });

  it("reads the budget: the agreement, a pending proposal, the figures and `canRecord`", () => {
    const b = asBoostBudget({
      agreed: { amountMinor: 1_000_000, currency: "IDR", minorUnit: 0, via: "portal", agreedAt: "2026-10-01T00:00:00Z", agreedBy: { name: "Dana" } },
      pending: { id: "pr1", status: "pending", amountMinor: 1_200_000, note: "More", proposedAt: "2026-10-10T00:00:00Z" }, committedMinor: 500_000, remainingMinor: 500_000,
      history: [{ id: "h1", status: "declined", amountMinor: 1_500_000 }, { bad: true }], canRecord: true,
    });
    expect(b.agreed).toMatchObject({ amountMinor: 1_000_000, via: "portal", agreedBy: "Dana", channel: null });
    expect(b.pending).toMatchObject({ id: "pr1", amountMinor: 1_200_000, currency: "IDR", note: "More" });
    expect(b.history.map((h) => h.id)).toEqual(["h1"]);
    expect(b).toMatchObject({ committedMinor: 500_000, remainingMinor: 500_000, canRecord: true, currency: "IDR" });
    expect(asBoostBudget({ agreed: null, pending: null, committedMinor: 0, remainingMinor: 0, history: [] })).toMatchObject({ agreed: null, canRecord: false });
  });

  it("reads the portal's spend, and the section has content only with an item or a history", () => {
    const s = asPortalSpend({
      budgets: [{ proposalId: "pr1", clientName: "N", month: "2026-11", amountMinor: 5, agreedMinor: null, committedMinor: 0, currency: "IDR", minorUnit: 0, note: null, requestedAt: "2026-10-10T00:00:00Z" }],
      boosts: [{ boostId: "b1", clientName: "N", postTitle: "P", thumbFileId: "f1", totalBudgetMinor: 6, days: 2, startsOn: "2026-11-02", currency: "IDR", minorUnit: 0, remainingMinor: 1 }],
      history: [{ id: "h", kind: "budget", title: "October budget", status: "agreed", amountMinor: 9, decidedAt: "2026-10-01T00:00:00Z" }], canDecide: false,
    });
    expect(s.budgets[0]).toMatchObject({ proposalId: "pr1", agreedMinor: null });
    expect(s.boosts[0]).toMatchObject({ boostId: "b1", thumbFileId: "f1" });
    expect(s.canDecide).toBe(false);
    expect(s.history[0].title).toBe("October budget");
    expect(asPortalSpend({ budgets: [], boosts: [], history: [{ kind: "budget", id: "x", month: "2026-10", postTitle: null, status: "agreed", amountMinor: 1 }], canDecide: true }).history[0]).toMatchObject({ title: "October 2026 budget", kind: "budget" });
    expect(portalSpendHasContent(s)).toBe(true);
    expect(portalSpendHasContent({ budgets: [], boosts: [], history: [], canDecide: true })).toBe(false);
    expect(portalSpendHasContent({ budgets: [], boosts: [], history: [{ id: "h", kind: "boost", title: "t", status: "approved", amountMinor: null, currency: "IDR", minorUnit: 0, decidedAt: null }], canDecide: true })).toBe(true);
    expect(portalSpendHasContent(null)).toBe(false);
  });

  it("the statuses are the fixture's, in its order", () => {
    expect(BOOST_STATUSES).toEqual(FX.boosts.statuses);
  });
});

describe("money", () => {
  it("shows integer minor units in the answer's own decimals", () => {
    expect(formatBoostMoney(1_000_000, "IDR", 0)).toBe("IDR 1,000,000");
    expect(formatBoostMoney(1_000_000, "IDR")).toBe("IDR 1,000,000");
    expect(formatBoostMoney(123_456, "USD", 2)).toBe("USD 1,234.56");
    expect(formatBoostMoney(5, "usd")).toBe("USD 0.05");
    expect(formatBoostMoney(0, "IDR", 0)).toBe("IDR 0");
    expect(formatBoostMoney(null, "IDR")).toBe("—");
  });

  it("reads a typed amount in whole units (the currency's own decimals at most) as minor units", () => {
    expect(parseMoneyInput("100000", 0)).toBe(100_000);
    expect(parseMoneyInput("1,000,000", 0)).toBe(1_000_000);
    expect(parseMoneyInput("1 000 000", 0)).toBe(1_000_000);
    expect(parseMoneyInput("10.25", 2)).toBe(1025);
    expect(parseMoneyInput("10.5", 0)).toBeNull();
    expect(parseMoneyInput("", 0)).toBeNull();
    expect(parseMoneyInput("ten", 0)).toBeNull();
    expect(parseMoneyInput("-5", 0)).toBeNull();
  });

  it("plain dates never move through a time zone", () => {
    expect(plainDate("2026-10-28")).toBe("28 Oct 2026");
    expect(plainDate("2026-01-01")).toBe("1 Jan 2026");
    expect(plainDate("soon")).toBe("soon");
  });
});

describe("the request form", () => {
  const filled = { ...emptyRequestForm("2026-10-20"), goal: "profile_visits", dailyBudget: "100000", days: "5" };

  it("totals daily times days, and says nothing until both are numbers", () => {
    expect(requestTotal(filled, 0)).toEqual({ dailyMinor: 100_000, days: 5, totalMinor: 500_000 });
    expect(requestTotal({ dailyBudget: "", days: "5" }, 0)).toBeNull();
    expect(requestTotal({ dailyBudget: "100000", days: "0" }, 0)).toBeNull();
    expect(requestTotal({ dailyBudget: "0", days: "3" }, 0)).toBeNull();
  });

  it("the line is within when the total fits what remains (equal fits), over otherwise with the figure left", () => {
    expect(budgetLine(500_000, 500_000, "IDR", 0)).toEqual({ within: true, text: "Within this month's agreed budget: starts without asking." });
    const over = budgetLine(500_001, 500_000, "IDR", 0);
    expect(over.within).toBe(false);
    expect(over.text).toBe("Over what remains (IDR 500,000 left): the client will be asked to approve it.");
    expect(budgetLine(1, 0, "IDR", 0).text).toContain("IDR 0 left");
  });

  it("builds the body with minor units, the id and the optional currency; a custom audience needs its note", () => {
    const ok = buildBoostRequest(filled, { minorUnit: 0, currency: null, id: "id-1" });
    expect(ok).toEqual({ ok: true, body: { id: "id-1", goal: "profile_visits", audience: "automatic", dailyBudgetMinor: 100_000, days: 5, startsOn: "2026-10-20" } });
    expect(buildBoostRequest(filled, { minorUnit: 0, currency: "IDR", id: "i" })).toMatchObject({ ok: true, body: { currency: "IDR" } });
    expect(buildBoostRequest({ ...filled, audience: "custom" }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: false, field: "audienceNote" });
    expect(buildBoostRequest({ ...filled, audience: "custom", audienceNote: "  Cyclists in Ubud  " }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: true, body: { audienceNote: "Cyclists in Ubud" } });
    expect(buildBoostRequest({ ...filled, goal: "" }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: false, field: "goal" });
    expect(buildBoostRequest({ ...filled, dailyBudget: "abc" }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: false, field: "dailyBudgetMinor" });
    expect(buildBoostRequest({ ...filled, days: "" }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: false, field: "days" });
    expect(buildBoostRequest({ ...filled, startsOn: "2026-02-30" }, { minorUnit: 0, currency: null, id: "i" })).toMatchObject({ ok: false, field: "startsOn" });
  });
});

describe("the action forms (the fixture's params)", () => {
  const f = (over: Partial<ReturnType<typeof emptyActionForm>>) => ({ ...emptyActionForm(), ...over });

  it("cancel and start send only the action and the status the card showed", () => {
    expect(buildBoostAction("cancel_boost", "approved", emptyActionForm(), 0)).toEqual({ ok: true, body: { action: "cancel_boost", expectedStatus: "approved" } });
    expect(buildBoostAction("start_boost", "approved", emptyActionForm(), 0)).toEqual({ ok: true, body: { action: "start_boost", expectedStatus: "approved" } });
  });

  it("stop: the spend is required, paid reach and clicks are optional", () => {
    expect(buildBoostAction("stop_boost", "running", f({}), 0)).toMatchObject({ ok: false, field: "spendMinor" });
    expect(buildBoostAction("stop_boost", "running", f({ spend: "0" }), 0)).toEqual({ ok: true, body: { action: "stop_boost", expectedStatus: "running", spendMinor: 0 } });
    expect(buildBoostAction("stop_boost", "running", f({ spend: "20,000", paidReach: "900", clicks: "12" }), 0)).toMatchObject({ ok: true, body: { spendMinor: 20_000, paidReach: 900, clicks: 12 } });
    expect(buildBoostAction("stop_boost", "running", f({ spend: "5", paidReach: "x" }), 0)).toMatchObject({ ok: false, field: "paidReach" });
  });

  it("complete: the spend and the paid reach are required, clicks are optional", () => {
    expect(buildBoostAction("complete_boost", "stopped", f({ spend: "5" }), 0)).toMatchObject({ ok: false, field: "paidReach" });
    expect(buildBoostAction("complete_boost", "stopped", f({ spend: "5", paidReach: "100" }), 0)).toEqual({ ok: true, body: { action: "complete_boost", expectedStatus: "stopped", spendMinor: 5, paidReach: 100 } });
    expect(buildBoostAction("complete_boost", "running", f({ spend: "5", paidReach: "100", clicks: "-1" }), 0)).toMatchObject({ ok: false, field: "clicks" });
  });

  it("recording the client's answer needs a channel and a note", () => {
    expect(buildBoostAction("record_boost_approval", "requested", f({ note: "ok" }), 0)).toMatchObject({ ok: false, field: "channel" });
    expect(buildBoostAction("record_boost_decline", "requested", f({ channel: "email" }), 0)).toMatchObject({ ok: false, field: "note" });
    expect(buildBoostAction("record_boost_decline", "requested", f({ channel: "email", note: " Said no. " }), 0)).toEqual({ ok: true, body: { action: "record_boost_decline", expectedStatus: "requested", channel: "email", note: "Said no." } });
  });
});

describe("the budget forms", () => {
  it("a proposal is an amount and an optional note; a recording adds a channel and needs the note", () => {
    const f = { ...emptyBudgetForm(), amount: "1,100,000" };
    expect(buildBudgetBody("propose", f, 0)).toEqual({ ok: true, body: { amountMinor: 1_100_000 } });
    expect(buildBudgetBody("propose", { ...f, note: " More " }, 0)).toEqual({ ok: true, body: { amountMinor: 1_100_000, note: "More" } });
    expect(buildBudgetBody("propose", { ...f, amount: "0" }, 0)).toMatchObject({ ok: false, field: "amountMinor" });
    expect(buildBudgetBody("record", f, 0)).toMatchObject({ ok: false, field: "channel" });
    expect(buildBudgetBody("record", { ...f, channel: "meeting" }, 0)).toMatchObject({ ok: false, field: "note" });
    expect(buildBudgetBody("record", { ...f, channel: "meeting", note: "At the call." }, 0)).toEqual({ ok: true, body: { amountMinor: 1_100_000, channel: "meeting", note: "At the call." } });
  });
});

describe("what the card offers", () => {
  const names = (status: string, who: { canRun: boolean; canRecord: boolean }) => boostOffers(status, who).map((o) => o.action);
  const ALL = { canRun: true, canRecord: true };

  it("follows the fixture's `from` lists for a person who may do everything", () => {
    for (const s of FX.boosts.statuses) {
      expect([...names(s, ALL)].sort(), s).toEqual(FX.boosts.actions.filter((a) => a.from.includes(s) && a.action !== "approve_boost" && a.action !== "decline_boost")  .map((a) => a.action).sort()); // the client's two are the portal's
    }
    expect(names("requested", ALL)).toEqual(["cancel_boost", "record_boost_approval", "record_boost_decline"]);
    expect(names("approved", ALL)).toEqual(["cancel_boost", "start_boost"]);
    expect(names("running", ALL)).toEqual(["stop_boost", "complete_boost"]);
    expect(names("stopped", ALL)).toEqual(["complete_boost"]);
    for (const s of ["completed", "cancelled", "declined"]) expect(names(s, ALL)).toEqual([]);
  });

  it("splits the run actions (officer, HoD, GM) from the record actions (the four approvers)", () => {
    expect(names("requested", { canRun: true, canRecord: false })).toEqual(["cancel_boost"]);
    expect(names("requested", { canRun: false, canRecord: true })).toEqual(["record_boost_approval", "record_boost_decline"]);
    expect(names("requested", { canRun: false, canRecord: false })).toEqual([]);
    expect(names("running", { canRun: false, canRecord: true })).toEqual([]);
    expect(hasHiddenOffers("running", { canRun: false, canRecord: true })).toBe(true);
    expect(hasHiddenOffers("running", { canRun: true, canRecord: false })).toBe(false);
    expect(hasHiddenOffers("requested", { canRun: true, canRecord: false })).toBe(true);
  });

  it("a post's open boost is one that is requested, approved, running or stopped", () => {
    expect(["requested", "approved", "running", "stopped"].every(isOpenBoost)).toBe(true);
    expect(["completed", "cancelled", "declined", null, undefined].some(isOpenBoost)).toBe(false);
  });
});

describe("the refusal words", () => {
  it("every boost code of the fixture has words, and the budget refusal names what is committed", () => {
    const codes = Object.keys(FX.refusals).filter((c) => /boost|budget|proposal|view_only|approver|officer/.test(c));
    expect(codes.length).toBeGreaterThan(8);
    for (const c of codes) expect(boostRefusalText({ status: 409, error: c }), c).not.toMatch(/_/);
    expect(Object.keys(REFUSAL_WORDS)).toEqual(expect.arrayContaining(["open_boost_exists", "post_not_live", "currency_mismatch", "budget_below_committed"]));
    expect(boostRefusalText({ status: 409, error: "budget_below_committed", detail: { committedMinor: 500_000, currency: "IDR" } })).toContain("IDR 500,000");
  });

  it("a changed boost names where it is now; the owner is told they do not run boosts; a viewer is told view-only", () => {
    expect(boostRefusalText({ status: 409, error: "boost_status_changed", detail: { status: "running" } })).toContain("running");
    expect(boostRefusalText({ status: 409, error: "invalid_boost_transition", detail: { status: "completed" } })).toContain("completed");
    expect(boostRefusalText({ status: 403, error: "not_officer_or_approver" })).toMatch(/owner agrees the money but does not run boosts/);
    expect(boostRefusalText({ status: 403, error: "view_only" })).toMatch(/view-only/);
    expect(boostRefusalText({ status: 400, error: "missing_field", field: "spendMinor" })).toBe("The spend is required.");
  });
});
