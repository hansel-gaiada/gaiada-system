import { describe, it, expect } from "vitest";
import {
  appraisalProgressText, buildCompany, companyAccess, companyAppraisalsView, companyCampaignsView, companyLearningView, decisionsView,
  moneyPart, numberTiles, partsText, waitingDays, COMPANY_CAMPAIGNS_SHOWN, DECISIONS_SHOWN, type CompanyAccess, type MoneyReads,
} from "./overviewCompany";
import { COMPANY_OVERVIEW } from "./workspaces";
import { canReadGmConsole, gmAccessFor } from "./gm";
import { selectBands } from "./overview";
import { HOTEL, me } from "./workspaceFixtures";
import type { NowQueue } from "./overviewQueue";
import type { QueueItem } from "./queueUrgency";
import type { DeptCampaignRow } from "./campaigns";
import type { ComplianceRow } from "./lms";
import type { ReportDocument } from "./reports";

const TENANT = "co-a";
const grant = (role: string, scopeType = "company", scopeId: string | null = TENANT) => me([{ role, scopeType, scopeId }]);
const PERSONAS = {
  platform_admin: me([{ role: "platform_admin", scopeType: "global", scopeId: null }]),
  company_admin: grant("company_admin"),
  manager: grant("manager"),
  hr_manager: grant("hr_manager"),
  finance_manager: grant("finance_manager"),
  member: grant("member"),
  viewer: grant("viewer"),
  org_unit_lead: grant("org_unit_lead", "org_unit", "d-web"),
};

// ── Access: the cockpit's gates, exactly ─────────────────────────────────────────────────────────

describe("companyAccess mirrors the cockpit's gates (lib/gm.ts)", () => {
  it("gives the executive tier everything and a plain member nothing", () => {
    for (const k of ["platform_admin", "company_admin"] as const) {
      expect(companyAccess(PERSONAS[k], TENANT), k).toEqual({ console: true, numbers: true, money: true });
    }
    for (const k of ["member", "viewer", "org_unit_lead"] as const) {
      expect(companyAccess(PERSONAS[k], TENANT), k).toEqual({ console: false, numbers: false, money: false });
    }
  });

  it("gives a narrowed department reader the console and no company figures and no money", () => {
    for (const k of ["manager", "hr_manager"] as const) {
      expect(gmAccessFor(PERSONAS[k], TENANT), k).toBe("narrowed");
      expect(companyAccess(PERSONAS[k], TENANT), k).toEqual({ console: true, numbers: false, money: false });
    }
  });

  it("never gives money to someone the cockpit refuses, even with the finance capability", () => {
    // finance_manager holds `finance.statement.view` but not the reporting tier: the cockpit shows them GmAccessDenied.
    expect(gmAccessFor(PERSONAS.finance_manager, TENANT)).toBe("none");
    expect(companyAccess(PERSONAS.finance_manager, TENANT).money).toBe(false);
  });

  it("agrees with canReadGmConsole for every persona, and scopes to the active company", () => {
    for (const [k, p] of Object.entries(PERSONAS)) expect(companyAccess(p, TENANT).console, k).toBe(canReadGmConsole(p, TENANT));
    // A company administrator of co-a reads nothing of co-b.
    expect(companyAccess(PERSONAS.company_admin, "co-b")).toEqual({ console: false, numbers: false, money: false });
  });
});

describe("the registry's gates place exactly the blocks the access allows (COMPANY_OVERVIEW)", () => {
  const ctx = (who: keyof typeof PERSONAS) => ({ me: PERSONAS[who], tenantId: TENANT, unitPath: [] as string[] });
  const placed = (who: keyof typeof PERSONAS) => selectBands(COMPANY_OVERVIEW, ctx(who)).flatMap((b) => b.widgets.map((w) => w.key));

  const expected = (a: CompanyAccess): string[] => [
    ...(a.console ? ["decisions"] : []),
    "today",
    ...(a.numbers || a.money ? ["company"] : []),
    ...(a.numbers ? ["departments"] : []),
    "company-campaigns",
    ...(a.numbers ? ["learning-compliance", "appraisal-cycle"] : []),
  ];

  it("holds for every persona", () => {
    for (const who of Object.keys(PERSONAS) as (keyof typeof PERSONAS)[]) {
      expect(placed(who), who).toEqual(expected(companyAccess(PERSONAS[who], TENANT)));
    }
  });

  it("shows a plain member Today and Campaigns only: no decisions, no money, no company figures", () => {
    expect(placed("member")).toEqual(["today", "company-campaigns"]);
  });

  it("shows a narrowed lead the decisions but no company block, no departments and no growth blocks", () => {
    expect(placed("manager")).toEqual(["decisions", "today", "company-campaigns"]);
  });

  it("shows the executive tier every block, in the spec's band order", () => {
    const bands = selectBands(COMPANY_OVERVIEW, ctx("company_admin")).map((b) => [b.band, b.widgets.map((w) => w.key)]);
    expect(bands).toEqual([
      ["now", ["decisions", "today"]],
      ["department", ["company", "departments"]],
      ["work", ["company-campaigns"]],
      ["growth", ["learning-compliance", "appraisal-cycle"]],
    ]);
  });

  it("hides campaigns in a company whose pack has no agency rows", () => {
    const hotel = me([{ role: "company_admin", scopeType: "company", scopeId: "co-h" }], [HOTEL]);
    const keys = selectBands(COMPANY_OVERVIEW, { me: hotel, tenantId: "co-h", unitPath: [] }).flatMap((b) => b.widgets.map((w) => w.key));
    expect(keys).not.toContain("company-campaigns");
  });

  it("builds every company block that has a reader, and ticket-marks none of them", () => {
    for (const w of COMPANY_OVERVIEW) expect(w.ticket, w.key).toBeUndefined();
  });
});

// ── Needs you: decisions ─────────────────────────────────────────────────────────────────────────

const item = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({
  id, type: "approval", title: `Title ${id}`, companyId: TENANT, company: "Agency", createdAt: "2026-10-10T00:00:00Z", decidable: true, urgencyScore: 0, href: `/x/${id}`, ...over,
});
const queue = (items: QueueItem[], leg: Partial<NowQueue["companies"][number]> = {}): NowQueue =>
  ({ items, companies: [{ id: TENANT, name: "Agency", included: true, partialSources: [], ...leg }] });
const NOW = new Date("2026-10-14T12:00:00Z");

describe("decisionsView", () => {
  it("counts the approvals and gates of the active company, and only those", () => {
    const v = decisionsView(queue([
      item("a"), item("g", { type: "gate" }), item("t", { type: "task" }), item("m", { type: "mention" }), item("other", { companyId: "co-b" }),
    ]), TENANT, NOW);
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.total).toBe(2);
    expect(v.rows.map((r) => [r.id, r.kind])).toEqual([["a", "Approval"], ["g", "Pipeline gate"]]);
  });

  it("keeps the queue's rank and caps the rows, with the total saying what was cut", () => {
    const items = Array.from({ length: DECISIONS_SHOWN + 2 }, (_, i) => item(`i${i}`));
    const v = decisionsView(queue(items), TENANT, NOW);
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.id)).toEqual(items.slice(0, DECISIONS_SHOWN).map((i) => i.id));
    expect(v.total).toBe(DECISIONS_SHOWN + 2);
  });

  it("says how long each has waited, floored, and how many sit five days or more", () => {
    const v = decisionsView(queue([
      item("new", { createdAt: "2026-10-14T01:00:00Z" }), item("one", { createdAt: "2026-10-13T00:00:00Z" }),
      item("old", { createdAt: "2026-10-01T00:00:00Z" }), item("bad", { createdAt: "not a date" }),
    ]), TENANT, NOW);
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.waiting)).toEqual(["today", "1d", "13d", null]);
    expect(v.stale).toBe(1);
    expect(waitingDays("2026-10-13T00:00:00Z", NOW)).toBe(1);
    expect(waitingDays("2026-10-15T00:00:00Z", NOW)).toBe(0);
  });

  it("lists a decision that is not the person's to make, and counts it", () => {
    const v = decisionsView(queue([item("a"), item("b", { decidable: false })]), TENANT, NOW);
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.notYours).toBe(1);
    expect(v.rows[1].decidable).toBe(false);
  });

  it("is Unavailable, never empty, when the company's leg of the queue was not read", () => {
    expect(decisionsView(queue([], { included: false }), TENANT, NOW)).toEqual({ kind: "unavailable" });
    expect(decisionsView({ items: [], companies: [] }, TENANT, NOW)).toEqual({ kind: "unavailable" });
  });

  it("an empty list from a fully read company is a real 'nothing waiting'; a short one carries its failed sources", () => {
    expect(decisionsView(queue([]), TENANT, NOW)).toMatchObject({ kind: "ok", total: 0, incomplete: [] });
    expect(decisionsView(queue([], { partialSources: ["agency approvals"] }), TENANT, NOW)).toMatchObject({ kind: "ok", total: 0, incomplete: ["agency approvals"] });
  });
});

// ── Company ──────────────────────────────────────────────────────────────────────────────────────

const doc = (kpis: unknown[], header: Record<string, unknown> = {}) =>
  ({ kind: "ok" as const, data: { header: { periodLabel: "October 2026", ...header }, kpis } as unknown as ReportDocument });
const ratioKpi = (metricKey: string, numerator: number, denominator: number) => ({ metricKey, label: metricKey, unit: "percent", value: denominator ? numerator / denominator : 0, numerator, denominator });

describe("numberTiles (the company report document)", () => {
  it("states milestones hit and utilization with their parts", () => {
    const tiles = numberTiles(doc([ratioKpi("delivery.milestone_hit_rate", 7, 9), ratioKpi("effort.capacity_utilization", 9000, 12000)]));
    expect(tiles.map((t) => [t.key, t.state, t.value, t.detail])).toEqual([
      ["milestones", "ok", "78%", "7 of 9 milestones due"],
      ["utilization", "ok", "75%", "150 h of 200 h expected"],
    ]);
  });

  it("says No data for a ratio over nothing or a missing KPI, never 0%", () => {
    const tiles = numberTiles(doc([ratioKpi("delivery.milestone_hit_rate", 0, 0)]));
    expect(tiles.map((t) => [t.state, t.value])).toEqual([["no-data", "No data"], ["no-data", "No data"]]);
  });

  it("carries a refusal or a failure into both tiles, never a figure", () => {
    expect(numberTiles({ kind: "forbidden" }).map((t) => [t.state, t.value])).toEqual([["forbidden", "No access"], ["forbidden", "No access"]]);
    expect(numberTiles({ kind: "unavailable", reason: "x" }).map((t) => [t.state, t.value])).toEqual([["unavailable", "Unavailable"], ["unavailable", "Unavailable"]]);
  });
});

const pnl = (revenue: string, net: string) => ({
  kind: "ok" as const,
  data: [
    { section: "revenue", code: "4100", name: "Sales", amount: "999999999.0000" },
    { section: "total", code: "TOTAL_REVENUE", name: "Total revenue", amount: revenue },
    { section: "total", code: "NET_PROFIT", name: "Net profit", amount: net },
  ],
});
const aging = (rows: Partial<{ totalOutstanding: string; current: string; d90Plus: string }>[]) => ({
  kind: "ok" as const,
  data: rows.map((r, i) => ({ customerCode: `c${i}`, customerName: `C${i}`, totalOutstanding: "0", current: "0", d1_30: "0", d31_60: "0", d61_90: "0", d90Plus: "0", ...r })) as never,
});
const books = { kind: "ok" as const, data: [{ id: "p1" }] };

describe("moneyPart (the cockpit's GmMoneyCard rules)", () => {
  it("reads revenue from the P&L total row, never re-summed, and the overdue from outstanding less current", () => {
    const part = moneyPart({ periods: books, pnl: pnl("331000000.0000", "199000000.0000"), ar: aging([{ totalOutstanding: "100000000", current: "40000000", d90Plus: "10000000" }]) });
    if (part.kind !== "tiles") throw new Error("expected tiles");
    expect(part.tiles.map((t) => [t.key, t.state, t.value, t.detail])).toEqual([
      ["revenue", "ok", "331.0M IDR", "199.0M IDR net"],
      ["overdue", "ok", "60.0M IDR", "10.0M IDR past 90 days"],
    ]);
  });

  it("draws nothing when the finance gate read is refused (the cockpit renders no card)", () => {
    expect(moneyPart({ periods: { kind: "forbidden" }, pnl: null, ar: null })).toEqual({ kind: "hidden" });
  });

  it("says setup, not zero, when there is no fiscal calendar", () => {
    expect(moneyPart({ periods: { kind: "ok", data: [] }, pnl: null, ar: null })).toEqual({ kind: "no-books" });
  });

  it("is Unavailable on both tiles when the gate read failed", () => {
    const part = moneyPart({ periods: { kind: "unavailable", reason: "x" }, pnl: null, ar: null });
    if (part.kind !== "tiles") throw new Error("expected tiles");
    expect(part.tiles.map((t) => t.value)).toEqual(["Unavailable", "Unavailable"]);
  });

  it("answers for each tile on its own: a refused P&L does not hide the receivables, and neither becomes 0", () => {
    const part = moneyPart({ periods: books, pnl: { kind: "forbidden" }, ar: aging([{ totalOutstanding: "5", current: "5" }]) });
    if (part.kind !== "tiles") throw new Error("expected tiles");
    expect(part.tiles.map((t) => [t.key, t.state, t.value])).toEqual([["revenue", "forbidden", "No access"], ["overdue", "ok", "0 IDR"]]);
    const failed = moneyPart({ periods: books, pnl: pnl("1", "1"), ar: { kind: "unavailable", reason: "x" } });
    if (failed.kind !== "tiles") throw new Error("expected tiles");
    expect(failed.tiles[1]).toMatchObject({ state: "unavailable", value: "Unavailable" });
  });

  it("says No data, not 0, for a statement that carried no totals", () => {
    const part = moneyPart({ periods: books, pnl: { kind: "ok", data: [{ section: "revenue", code: "4100", name: "Sales", amount: "5" }] }, ar: aging([]) });
    if (part.kind !== "tiles") throw new Error("expected tiles");
    expect(part.tiles[0]).toMatchObject({ key: "revenue", state: "no-data", value: "No data" });
  });
});

describe("buildCompany: each part only for the person who may see it", () => {
  const money: MoneyReads = { periods: books, pnl: pnl("331000000", "100000000"), ar: aging([{ totalOutstanding: "1", current: "1" }]) };
  const document = doc([ratioKpi("delivery.milestone_hit_rate", 1, 2), ratioKpi("effort.capacity_utilization", 60, 120)]);
  const window = { from: "2026-10-01", to: "2026-10-31" };
  const keys = (a: CompanyAccess, d: typeof document | null, m: MoneyReads | null) => buildCompany({ access: a, document: d, money: m, ...window })?.tiles.map((t) => t.key) ?? null;

  it("draws money, then milestones and utilization, for the full tier", () => {
    expect(keys({ console: true, numbers: true, money: true }, document, money)).toEqual(["revenue", "overdue", "milestones", "utilization"]);
  });

  it("draws no money for someone without the money gate, even if money reads were handed in", () => {
    expect(keys({ console: true, numbers: true, money: false }, document, money)).toEqual(["milestones", "utilization"]);
  });

  it("draws no company figures for someone without the numbers gate, even if a document was handed in", () => {
    expect(keys({ console: true, numbers: false, money: true }, document, money)).toEqual(["revenue", "overdue"]);
  });

  it("draws no block at all for a person with neither", () => {
    expect(buildCompany({ access: { console: true, numbers: false, money: false }, document, money, ...window })).toBeNull();
    expect(buildCompany({ access: { console: false, numbers: false, money: false }, document: null, money: null, ...window })).toBeNull();
  });

  it("draws nothing for a refused finance gate read when no report part is allowed (the cockpit shows nothing either)", () => {
    expect(buildCompany({ access: { console: true, numbers: false, money: true }, document: null, money: { periods: { kind: "forbidden" }, pnl: null, ar: null }, ...window })).toBeNull();
  });

  it("states the no-books setup in words, with the Finance link and no tiles", () => {
    const m = buildCompany({ access: { console: true, numbers: false, money: true }, document: null, money: { periods: { kind: "ok", data: [] }, pnl: null, ar: null }, ...window })!;
    expect(m.noBooks).toBe(true);
    expect(m.tiles).toEqual([]);
    expect(m.links).toEqual({ report: false, finance: true });
  });

  it("links only to pages the person may open, names the money window and carries the history warning", () => {
    const withHistory = doc([], { warnings: { precedesFactHistory: { firstFactDate: "2026-08-01", affectedDays: 10 } } });
    const full = buildCompany({ access: { console: true, numbers: true, money: true }, document: withHistory, money, ...window })!;
    expect(full.links).toEqual({ report: true, finance: true });
    expect(full.moneyWindow).toBe("01 Oct 2026 to 31 Oct 2026");
    expect(full.periodLabel).toBe("October 2026");
    expect(full.note).toMatch(/records begin on 1 August 2026/);
    const numbersOnly = buildCompany({ access: { console: true, numbers: true, money: false }, document, money: null, ...window })!;
    expect(numbersOnly.links).toEqual({ report: true, finance: false });
    expect(numbersOnly.moneyWindow).toBeNull();
  });
});

// ── Campaigns across departments ─────────────────────────────────────────────────────────────────

const campaign = (id: string, over: Partial<DeptCampaignRow> = {}): DeptCampaignRow => ({
  id, name: `Campaign ${id}`, status: "active", projectId: null, clientId: null, leadUnitId: null, startsOn: null, endsOn: null, partCount: 0, part: null, ...over,
});

describe("companyCampaignsView", () => {
  it("passes a refusal and a failure through, never an empty list", () => {
    expect(companyCampaignsView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(companyCampaignsView({ kind: "unavailable", reason: "x" })).toEqual({ kind: "unavailable" });
  });

  it("an empty ok is a real 'no open campaigns'", () => {
    expect(companyCampaignsView({ kind: "ok", data: [] })).toEqual({ kind: "ok", rows: [], total: 0 });
  });

  it("drops finished campaigns, puts the soonest ending first and the undated last", () => {
    const v = companyCampaignsView({
      kind: "ok",
      data: [
        campaign("undated"), campaign("late", { endsOn: "2026-12-31" }), campaign("done", { status: "completed", endsOn: "2026-10-01" }),
        campaign("soon", { endsOn: "2026-10-20" }), campaign("cancelled", { status: "cancelled" }),
      ],
    });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => r.id)).toEqual(["soon", "late", "undated"]);
    expect(v.total).toBe(3);
  });

  it("carries how many departments have a part, and says so in words", () => {
    const v = companyCampaignsView({ kind: "ok", data: [campaign("a", { partCount: 3 }), campaign("b", { partCount: 1 }), campaign("c")] });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows.map((r) => partsText(r.parts))).toEqual(["3 departments", "1 department", "No department part yet"]);
  });

  it("caps the rows and keeps the true total", () => {
    const v = companyCampaignsView({ kind: "ok", data: Array.from({ length: COMPANY_CAMPAIGNS_SHOWN + 2 }, (_, i) => campaign(`c${i}`)) });
    if (v.kind !== "ok") throw new Error("expected ok");
    expect(v.rows).toHaveLength(COMPANY_CAMPAIGNS_SHOWN);
    expect(v.total).toBe(COMPANY_CAMPAIGNS_SHOWN + 2);
  });
});

// ── Growth ───────────────────────────────────────────────────────────────────────────────────────

const row = (over: Partial<ComplianceRow>): ComplianceRow => ({ pathKey: "p", title: "Path", isMandatory: true, assigned: 10, completed: 5, outstanding: 5, overdue: 1, waived: 0, ...over });

describe("companyLearningView", () => {
  it("passes a refusal and a failure through, never 'nothing assigned'", () => {
    expect(companyLearningView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(companyLearningView({ kind: "unavailable", reason: "x" })).toEqual({ kind: "unavailable" });
  });

  it("sums the MANDATORY paths only, and names the weakest when there is more than one", () => {
    const v = companyLearningView({
      kind: "ok",
      data: [
        row({ pathKey: "a", title: "Induction", assigned: 20, completed: 18, outstanding: 2, overdue: 0 }),
        row({ pathKey: "b", title: "Security", assigned: 20, completed: 8, outstanding: 12, overdue: 6 }),
        row({ pathKey: "c", title: "Optional", isMandatory: false, assigned: 100, completed: 0, outstanding: 100, overdue: 50 }),
      ],
    });
    expect(v).toEqual({ kind: "ok", paths: 2, assigned: 40, completed: 26, outstanding: 14, overdue: 6, coverage: 65, lowest: { title: "Security", coverage: 40 } });
  });

  it("does not name a weakest path when there is only one", () => {
    const v = companyLearningView({ kind: "ok", data: [row({})] });
    expect(v).toMatchObject({ kind: "ok", paths: 1, coverage: 50, lowest: null });
  });

  it("an empty grid is a real 'nothing assigned', with no percentage: not 0% and not 100%", () => {
    expect(companyLearningView({ kind: "ok", data: [] })).toMatchObject({ kind: "ok", assigned: 0, coverage: null, lowest: null });
    expect(companyLearningView({ kind: "ok", data: [row({ isMandatory: false })] })).toMatchObject({ assigned: 0, coverage: null });
  });
});

describe("companyAppraisalsView", () => {
  const pack = (cycleId: string, status: "draft" | "submitted" | "acknowledged" | "disputed" | "finalized") => ({ cycleId, status });

  it("passes a refusal and a failure through", () => {
    expect(companyAppraisalsView({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(companyAppraisalsView({ kind: "unavailable", reason: "x" })).toEqual({ kind: "unavailable" });
  });

  it("counts by stage over every appraisal, and the cycles", () => {
    const v = companyAppraisalsView({ kind: "ok", data: { appraisals: [pack("c1", "finalized"), pack("c1", "submitted"), pack("c2", "draft"), pack("c2", "finalized")] } });
    expect(v).toMatchObject({ kind: "ok", total: 4, cycles: 2, finalized: 2, submitted: 1, draft: 1 });
    if (v.kind === "ok") expect(appraisalProgressText(v)).toBe("2 of 4 finalized");
  });

  it("an empty list from a successful read is a real 'none yet'", () => {
    expect(companyAppraisalsView({ kind: "ok", data: { appraisals: [] } })).toMatchObject({ kind: "ok", total: 0, cycles: 0 });
  });
});
