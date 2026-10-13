import { describe, it, expect } from "vitest";
import {
  allocationText, campaignErrorText, canEditPart, detailOf, leadText, linkAccessNote, majorText, moneyText, moneyView,
  normalizeCampaignDetail, normalizeDeptCampaignRow, ourPartChoices, parseCurrencyInput, parseMoneyInput, partUnitText,
  requestsText, socialLinkIndex, type CampaignDetail, type CampaignPart, type DeptCampaignRow,
} from "./campaigns";
import { formatBudget } from "./format";

const part = (over: Partial<CampaignPart> = {}): CampaignPart => ({
  id: "p1", unitId: "d-social", unitName: "Social Media", unitMissing: false, ownerId: "u1", ownerName: "Ayu",
  status: "active", brief: "", dueOn: null, budgetMinor: null,
  links: { searchCampaigns: [], socialCampaigns: [] }, requests: { open: 0, delivered: 0, declined: 0 }, ...over,
});

const detail = (parts: CampaignPart[], over: Partial<CampaignDetail> = {}): CampaignDetail => ({
  id: "c1", name: "Tirta Spa launch", status: "active", projectId: "pr1", clientId: "cl1", leadUnitId: null, leadUnitName: null,
  startsOn: null, endsOn: null, money: { budgetMinor: 1_000_000, currency: "USD", allocatedMinor: 0, unallocatedMinor: 1_000_000 },
  parts, linkAccess: { searchCampaigns: "ok", socialCampaigns: "ok" }, ...over,
});

describe("money display comes from the server's minor units", () => {
  it("formats every figure as returned, adds and subtracts nothing", () => {
    const v = moneyView({ budgetMinor: 1_000_000, currency: "USD", allocatedMinor: 250_050, unallocatedMinor: 749_950 });
    expect(v.budget).toBe(formatBudget(1_000_000, "USD"));
    expect(v.allocated).toBe(formatBudget(250_050, "USD"));
    expect(v.unallocated).toBe(formatBudget(749_950, "USD"));
    expect(v.hasBudget).toBe(true);
  });

  it("uses the server's unallocated figure even when it does not equal budget minus allocated", () => {
    // The UI never derives it: whatever the server says is what is shown.
    const v = moneyView({ budgetMinor: 1000, currency: "USD", allocatedMinor: 100, unallocatedMinor: 777 });
    expect(v.unallocated).toBe(formatBudget(777, "USD"));
  });

  it("says there is no budget, instead of showing zero, when none is set", () => {
    const v = moneyView({ budgetMinor: null, currency: null, allocatedMinor: 0, unallocatedMinor: null });
    expect(v.hasBudget).toBe(false);
    expect(v.budget).toBe("No budget set");
    expect(v.unallocated).toMatch(/until a budget is set/);
    expect(v.allocated).toBe("None allocated");
  });

  it("handles zero-decimal currencies", () => {
    expect(moneyText(1_500_000, "IDR")).toBe(formatBudget(1_500_000, "IDR"));
  });

  it("never invents a symbol when there is no currency", () => {
    expect(moneyText(500, null)).toBe("500 minor units");
    expect(moneyText(null, "USD")).toBe("—");
  });

  it("marks a cancelled part's allocation as released", () => {
    expect(allocationText({ budgetMinor: 5000, status: "active" }, "USD")).toBe(formatBudget(5000, "USD"));
    expect(allocationText({ budgetMinor: 5000, status: "cancelled" }, "USD")).toMatch(/released/);
    expect(allocationText({ budgetMinor: null, status: "active" }, "USD")).toBe("No allocation");
  });
});

describe("parseMoneyInput converts a typed amount exactly", () => {
  it.each([
    ["1250.50", "USD", 125050],
    ["1,250.5", "USD", 125050],
    ["0.05", "USD", 5],
    ["0", "USD", 0],
    ["12", "USD", 1200],
    ["5.", "USD", 500],
    ["1500000", "IDR", 1500000],
    ["1500000.00", "IDR", 1500000],
    ["19.99", "USD", 1999],
    ["0.29", "USD", 29],
  ])("%s %s -> %i", (text, cur, minor) => {
    expect(parseMoneyInput(text, cur)).toEqual({ ok: true, minor });
  });

  it("treats blank as none", () => {
    expect(parseMoneyInput("   ", "USD")).toEqual({ ok: true, minor: null });
  });

  it.each([["-5"], ["abc"], ["1.2.3"], ["1e3"], ["$10"], [".5"]])("refuses %s", (text) => {
    expect(parseMoneyInput(text, "USD").ok).toBe(false);
  });

  it("refuses extra decimals rather than rounding", () => {
    expect(parseMoneyInput("1.234", "USD").ok).toBe(false);
    expect(parseMoneyInput("1.230", "USD")).toEqual({ ok: true, minor: 123 });
    expect(parseMoneyInput("5.5", "IDR").ok).toBe(false);
  });

  it("refuses an amount that is not a safe integer", () => {
    expect(parseMoneyInput("99999999999999999999", "USD").ok).toBe(false);
  });

  it("round-trips with majorText", () => {
    for (const minor of [0, 5, 99, 100, 125050, 1_000_000]) {
      expect(parseMoneyInput(majorText(minor, "USD"), "USD")).toEqual({ ok: true, minor });
    }
    expect(majorText(1500000, "IDR")).toBe("1500000");
    expect(majorText(null, "USD")).toBe("");
  });
});

describe("parseCurrencyInput", () => {
  it("upper-cases a code, treats blank as none, refuses anything else", () => {
    expect(parseCurrencyInput(" usd ")).toEqual({ ok: true, currency: "USD" });
    expect(parseCurrencyInput("")).toEqual({ ok: true, currency: null });
    expect(parseCurrencyInput("US").ok).toBe(false);
    expect(parseCurrencyInput("US1").ok).toBe(false);
  });
});

describe("campaignErrorText: reason codes in plain sentences", () => {
  const r = (reason: string, status = 409, detail?: Record<string, unknown>) => ({ status, reason, message: "raw", detail });

  it("allocation_exceeds_budget shows the server's three figures", () => {
    const text = campaignErrorText(r("allocation_exceeds_budget", 409, { budgetMinor: 100000, allocatedMinor: 80000, requestedMinor: 30000 }), "USD");
    expect(text).toContain(formatBudget(100000, "USD"));
    expect(text).toContain(formatBudget(80000, "USD"));
    expect(text).toContain(formatBudget(30000, "USD"));
    expect(text).toMatch(/above the campaign budget/);
  });

  it("budget_below_allocations says lowered or cleared, with the allocated figure", () => {
    const lowered = campaignErrorText(r("budget_below_allocations", 409, { budgetMinor: 5000, allocatedMinor: 9000 }), "USD");
    expect(lowered).toMatch(/lowered/);
    expect(lowered).toContain(formatBudget(9000, "USD"));
    const cleared = campaignErrorText(r("budget_below_allocations", 409, { budgetMinor: null, allocatedMinor: 9000 }), "USD");
    expect(cleared).toMatch(/cleared/);
  });

  it("currency_locked_by_allocations names the currency the server reports", () => {
    const text = campaignErrorText(r("currency_locked_by_allocations", 409, { currency: "IDR", allocatedMinor: 1500000 }), "USD");
    expect(text).toContain(formatBudget(1500000, "IDR"));
  });

  it("does not fake figures when the detail is missing", () => {
    expect(campaignErrorText(r("allocation_exceeds_budget"), "USD")).toMatch(/unknown amount/);
  });

  it.each([
    ["campaign_has_no_budget", /no budget/],
    ["part_exists", /already has a part/],
    ["part_has_links", /linked/],
    ["already_linked", /already linked/],
    ["owner_invalid", /active member/],
    ["unit_invalid", /not a department/],
    ["part_changed", /changed while you were saving/],
    ["link_target_invalid", /cannot be linked/],
    ["dates_invalid", /end date/],
  ])("%s", (reason, pattern) => {
    expect(campaignErrorText(r(reason, 409))).toMatch(pattern);
  });

  it("falls back on the status, then on the server's own sentence", () => {
    expect(campaignErrorText({ status: 403, message: "forbidden" })).toMatch(/permission/);
    expect(campaignErrorText({ status: 404, message: "x" })).toMatch(/no longer exists/);
    expect(campaignErrorText({ status: 500, message: "database went away" })).toBe("database went away");
    expect(campaignErrorText({ status: 500, message: "" })).toMatch(/did not work/);
  });

  it("detailOf only returns an object detail", () => {
    expect(detailOf({ detail: { a: 1 } })).toEqual({ a: 1 });
    expect(detailOf({ detail: [1] })).toBeUndefined();
    expect(detailOf(null)).toBeUndefined();
    expect(detailOf({})).toBeUndefined();
  });
});

describe("who is offered the part controls", () => {
  const base = { canManage: false, meId: "me", ownerId: "other", isHead: false };
  it("offers them to a manager, the part's owner and the department head, and to nobody else", () => {
    expect(canEditPart({ ...base, canManage: true })).toBe(true);
    expect(canEditPart({ ...base, ownerId: "me" })).toBe(true);
    expect(canEditPart({ ...base, isHead: true })).toBe(true);
    expect(canEditPart(base)).toBe(false);
  });
  it("an unowned part is not owned by anybody", () => {
    expect(canEditPart({ ...base, ownerId: null })).toBe(false);
  });
});

describe("words for parts, links and leads", () => {
  it("a link list that cannot be shown says why, never an empty list", () => {
    expect(linkAccessNote("search_campaign", "forbidden")).toBe("You cannot see SEO campaigns.");
    expect(linkAccessNote("social_campaign", "forbidden")).toBe("You cannot see Social campaigns.");
    expect(linkAccessNote("search_campaign", "module_off")).toMatch(/SEO module is off/);
    expect(linkAccessNote("social_campaign", "ok")).toBeNull();
  });

  it("names a unit that has left the org chart", () => {
    expect(partUnitText({ unitName: "SEO", unitMissing: false })).toBe("SEO");
    expect(partUnitText({ unitName: null, unitMissing: true })).toMatch(/no longer in the org chart/);
    expect(leadText(null, null)).toMatch(/Office of the GM/);
    expect(leadText("d1", "SEO")).toBe("SEO");
    expect(leadText("d1", null)).toMatch(/no longer in the org chart/);
  });

  it("summarises request counts", () => {
    expect(requestsText({ open: 0, delivered: 0, declined: 0 })).toBe("No requests");
    expect(requestsText({ open: 2, delivered: 1, declined: 0 })).toBe("2 open, 1 delivered, 0 declined");
  });
});

describe("normalising the wire shapes", () => {
  it("reads a department list row, with and without our part", () => {
    const withPart = normalizeDeptCampaignRow({
      id: "c1", name: "N", status: "active", project_id: "pr", leadUnitId: "d", startsOn: null, endsOn: null, clientId: "cl", partCount: 2,
      part: { id: "p", status: "blocked", ownerId: "u", ownerName: "Ayu", dueOn: "2026-11-01" },
    });
    expect(withPart?.part?.status).toBe("blocked");
    expect(withPart?.projectId).toBe("pr");
    const leadOnly = normalizeDeptCampaignRow({ id: "c2", name: "M", status: "paused", part: null });
    expect(leadOnly?.part).toBeNull();
    expect(normalizeDeptCampaignRow({ name: "no id" })).toBeNull();
    expect(normalizeDeptCampaignRow("x")).toBeNull();
  });

  it("reads the detail, defaults what is missing, and refuses a wrong shape", () => {
    const d = normalizeCampaignDetail({
      id: "c1", name: "N", status: "active", projectId: "pr", clientId: null, leadUnitId: null, leadUnitName: null, startsOn: null, endsOn: null,
      money: { budgetMinor: 5000, currency: "USD", allocatedMinor: 1000, unallocatedMinor: 4000 },
      parts: [{
        id: "p", unitId: "d", unitName: null, unitMissing: true, ownerId: null, ownerName: null, status: "planned", brief: "b", dueOn: null,
        budgetMinor: null,
        links: { searchCampaigns: [{ id: "s", name: "S", status: "active", budgetMinor: 10, currency: "USD" }], socialCampaigns: [] },
        requests: { open: 1, delivered: 0, declined: 0 },
      }],
      linkAccess: { searchCampaigns: "forbidden", socialCampaigns: "module_off" },
    });
    expect(d?.money.unallocatedMinor).toBe(4000);
    expect(d?.parts[0].unitMissing).toBe(true);
    expect(d?.linkAccess).toEqual({ searchCampaigns: "forbidden", socialCampaigns: "module_off" });
    expect(normalizeCampaignDetail([])).toBeNull();
    expect(normalizeCampaignDetail({ name: "no id" })).toBeNull();
    expect(normalizeCampaignDetail({ id: "c" })?.parts).toEqual([]);
  });
});

describe("the Social campaigns screen", () => {
  const row = (id: string, partStatus: string | null): DeptCampaignRow => ({
    id, name: `Campaign ${id}`, status: "active", projectId: null, clientId: null, leadUnitId: null, startsOn: null, endsOn: null, partCount: 1,
    part: partStatus ? { id: `part-${id}`, status: partStatus, ownerId: null, ownerName: null, dueOn: null } : null,
  });

  it("offers only the shared campaigns where this department has a part", () => {
    const choices = ourPartChoices([row("a", "active"), row("b", null), row("c", "planned")]);
    expect(choices.map((c) => c.campaignId)).toEqual(["a", "c"]);
    expect(choices[0]).toEqual({ campaignId: "a", campaignName: "Campaign a", partId: "part-a", partStatus: "active" });
  });

  it("maps a linked social campaign to its shared campaign name, from our own part only", () => {
    const ours = part({ id: "p-ours", unitId: "d-social", links: { searchCampaigns: [], socialCampaigns: [{ id: "s1", name: "Reels", status: "active" }] } });
    const theirs = part({ id: "p-theirs", unitId: "d-seo", links: { searchCampaigns: [], socialCampaigns: [{ id: "s2", name: "Other", status: "active" }] } });
    const idx = socialLinkIndex([detail([ours, theirs])], "d-social");
    expect(idx.get("s1")).toEqual({ sharedCampaignId: "c1", sharedCampaignName: "Tirta Spa launch", partId: "p-ours" });
    expect(idx.has("s2")).toBe(false);
  });
});
