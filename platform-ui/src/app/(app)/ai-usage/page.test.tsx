import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { UsageRead } from "@/lib/aiUsage-data";
import type { CompanyUsage } from "@/lib/aiUsage";
import type { Allowances } from "@/lib/aiBudget";
import { EMPTY_TOTALS, allowances, companyBudget, companyUsage, unitBudget } from "@/lib/aiUsageFixtures";
import { me as meFixture } from "@/lib/workspaceFixtures";

// AIP-16 (BFF section 66.5, owner ruling AIP-D18): the company's AI usage, Company area. Totals by surface, department, model and day; never a person.
// Each department line opens that department's month; "No department recorded" (the null bucket) and "Company, no person" (`noPerson`) are their own
// lines. A refusal is said as one, an empty month plainly, and the server decides who may read (the GM holds the read through a seat).
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...r }: { href: string; children?: React.ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/aiUsage-data", () => ({ getCompanyAiUsage: vi.fn(), getAllowances: vi.fn() }));
vi.mock("@/lib/aiBudgetActions", () => ({
  setCompanyBudgetAction: vi.fn(), setUnitBudgetAction: vi.fn(), setAllowanceAction: vi.fn(), liftStopAction: vi.fn(),
}));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAllowances, getCompanyAiUsage } from "@/lib/aiUsage-data";
import CompanyAiUsagePage from "./page";

const readMock = vi.mocked(getCompanyAiUsage);
const ok = (data: CompanyUsage): UsageRead<CompanyUsage> => ({ kind: "ok", data });
const mount = async (sp: { month?: string } = {}) => render(await CompanyAiUsagePage({ searchParams: Promise.resolve(sp) }));
const card = (title: string) => screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;
const cardTitles = () => [...document.querySelectorAll("section.lux-card h3")].map((h) => h.firstChild?.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  vi.mocked(getMe).mockResolvedValue(meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]));
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  readMock.mockReset().mockResolvedValue(ok(companyUsage()));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the current UTC month for the signed-in person in the active company, and passes a chosen month", async () => {
    await mount();
    expect(readMock).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
    await mount({ month: "2026-09" });
    expect(readMock).toHaveBeenLastCalledWith("u-1", "co-a", "2026-09");
  });
  it("asks the server for anyone who opens the address: the server decides (the GM reads through a seat the UI cannot see)", async () => {
    vi.mocked(getMe).mockResolvedValue(meFixture([]));
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(readMock).toHaveBeenCalledTimes(1);
  });
  it("reads nothing, and says so, without an active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    await mount();
    expect(screen.getByText("Select a company from the top bar.")).toBeInTheDocument();
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("the month", () => {
  it("is shown with the earlier month and keeps the company path in its links", async () => {
    await mount({ month: "2026-09" });
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: /August 2026/ })).toHaveAttribute("href", "/ai-usage?month=2026-08");
    expect(within(nav).getByRole("link", { name: "This month" })).toHaveAttribute("href", "/ai-usage?month=2026-10");
  });
});

describe("what it shows", () => {
  it("leads with by surface, then the month total, the model, the departments and the no-person lines, and the days", async () => {
    await mount();
    expect(cardTitles()).toEqual(["By surface", "Month total", "By model", "By department", "Company, no person", "By day"]);
  });
  it("links each department line to that department's month, for the same month", async () => {
    await mount();
    const dept = within(card("By department"));
    expect(dept.getByRole("link", { name: "Web Dev" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-web&month=2026-10");
    expect(dept.getByRole("link", { name: "SEO" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-seo&month=2026-10");
  });
  it("shows the null bucket as 'No department recorded', its own line with no link and its unknown cost as unknown", async () => {
    await mount();
    const dept = within(card("By department"));
    expect(dept.queryByRole("link", { name: "No department recorded" })).not.toBeInTheDocument();
    const row = dept.getByText("No department recorded").closest(".lux-table__row") as HTMLElement;
    expect([...row.querySelectorAll(":scope > span")].map((c) => c.textContent)).toEqual(["No department recorded", "33", "1,000", "200", "unknown"]);
  });
  it("shows the 'Company, no person' lines by surface", async () => {
    await mount();
    const np = within(card("Company, no person"));
    expect(np.getByText("Knowledge (embedding and search)").closest(".lux-table__row")).toHaveTextContent("3,180");
  });
  it("draws no person anywhere: the company tier never sees one", async () => {
    await mount();
    expect(screen.queryByRole("heading", { name: /^By person/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Made Putra")).not.toBeInTheDocument();
  });
  it("leaves out the no-person section when the answer has no such line, and a department the tree no longer has is said so", async () => {
    readMock.mockResolvedValue(ok(companyUsage({ noPerson: [], byDepartment: [{ ...companyUsage().byDepartment[0], unitNodeId: "d-old", name: null }] })));
    await mount();
    expect(cardTitles()).not.toContain("Company, no person");
    expect(within(card("By department")).getByText("Department not in the organisation tree")).toBeInTheDocument();
  });
});

describe("an empty month, a refusal and a failed read", () => {
  it("says an empty month plainly", async () => {
    readMock.mockResolvedValue(ok(companyUsage({ month: "2026-07", totals: EMPTY_TOTALS, byDepartment: [], noPerson: [], bySurface: [], byModel: [], byDay: [] })));
    await mount({ month: "2026-07" });
    expect(screen.getByText("No AI use recorded in July 2026")).toBeInTheDocument();
    expect(cardTitles()).toEqual([]);
  });
  it("says a 403 as a refusal and points to the person's own use, never as an empty month", async () => {
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to the company's AI usage/)).toBeInTheDocument();
    expect(screen.getByText(/owner, the GM, company admins and the superadmin/)).toBeInTheDocument();
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
  });
  it("says a failed read cannot tell, with the reason", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", reason: "upstream 502" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("upstream 502")).toBeInTheDocument();
  });
});

// AIP-17b and AIP-18 (BFF §66.8, §66.9): the company's alert figure and each department's budget line lead the page; the owner (`capabilities.canManage`)
// gets the forms and the per-person allowance overrides (`GET allowances`). NO BUDGET, NO BOX: a reader with nothing set sees nothing of this.
describe("budget lines (AIP-17b)", () => {
  const OWNER = { canSeePeople: true, canManage: true, canLiftStop: true };
  const withBudgets = (over: Partial<CompanyUsage> = {}) =>
    companyUsage({
      budgets: {
        company: companyBudget(),
        units: [unitBudget(), unitBudget({ unitNodeId: "d-seo", name: "SEO", mode: "soft_stop", monthlyUsd: "5.0000", spentUsd: "6.00000000", percent: 120, state: "over_100", stopLifted: true })],
      },
      ...over,
    });
  const allowRead = (a: Allowances) => vi.mocked(getAllowances).mockResolvedValue({ kind: "ok", data: a });
  beforeEach(() => vi.mocked(getAllowances).mockReset());

  it("shows nothing at all when no budget is set (no empty box) and reads no allowances for a reader", async () => {
    await mount();
    expect(cardTitles()).toEqual(["By surface", "Month total", "By model", "By department", "Company, no person", "By day"]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(getAllowances).not.toHaveBeenCalled();
  });
  it("shows the company's alert figure: figure, spent so far, percent and state in words", async () => {
    readMock.mockResolvedValue(ok(withBudgets()));
    await mount();
    const c = within(card("Company alert figure"));
    expect(c.getByText("$250.00 a month")).toBeInTheDocument();
    expect(c.getByText("$218.75 of $250.00")).toBeInTheDocument();
    expect(c.getByText("87.5%")).toBeInTheDocument();
    expect(c.getByText("over 80%")).toBeInTheDocument();
    expect(cardTitles().slice(0, 2)).toEqual(["Company alert figure", "Department budgets"]);
  });
  it("shows each department's line: its link, the mode in words, 'lifted for this month' only when so, and the state", async () => {
    readMock.mockResolvedValue(ok(withBudgets()));
    await mount();
    const d = within(card("Department budgets"));
    expect(d.getByRole("link", { name: "Web Dev" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-web&month=2026-10");
    expect(d.getByRole("link", { name: "SEO" })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-seo&month=2026-10");
    const web = d.getByRole("link", { name: "Web Dev" }).closest("li") as HTMLElement;
    expect(within(web).getByText("Report only")).toBeInTheDocument();
    expect(within(web).getByText("80%")).toBeInTheDocument();
    expect(within(web).queryByText("lifted for this month")).not.toBeInTheDocument();
    const seo = d.getByRole("link", { name: "SEO" }).closest("li") as HTMLElement;
    expect(within(seo).getByText("Soft stop")).toBeInTheDocument();
    expect(within(seo).getByText("at or over 100%")).toBeInTheDocument();
    expect(within(seo).getByText("lifted for this month")).toBeInTheDocument();
  });
  it("says an unknown spend as unknown, never $0 or 0%, and notes the calls with no cost", async () => {
    readMock.mockResolvedValue(ok(withBudgets({ budgets: { company: companyBudget({ spentUsd: null, percent: 0, state: "under", noCostCalls: 4 }), units: [] } })));
    await mount();
    const c = within(card("Company alert figure"));
    expect(c.getByText("unknown of $250.00")).toBeInTheDocument();
    expect(c.getByText("unknown", { selector: "dd" })).toBeInTheDocument();
    expect(c.getByText("4 calls had no cost figure, so they are not counted against the figure.")).toBeInTheDocument();
  });
  it("shows no edit form to a reader: no inputs, no Remove, no allowances", async () => {
    readMock.mockResolvedValue(ok(withBudgets()));
    await mount();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove|Change|Set the/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Daily reply allowances/ })).not.toBeInTheDocument();
    expect(getAllowances).not.toHaveBeenCalled();
  });

  describe("for the owner (canManage)", () => {
    it("shows the forms: the figure, each department's budget, and an Add form for departments with none", async () => {
      readMock.mockResolvedValue(ok(withBudgets({ capabilities: OWNER })));
      allowRead(allowances());
      await mount();
      expect(getAllowances).toHaveBeenCalledWith("u-1", "co-a");
      const c = within(card("Company alert figure"));
      expect((c.getByLabelText("Monthly alert figure (US dollars)") as HTMLInputElement).value).toBe("250.0000");
      expect(c.getByRole("button", { name: "Remove" })).toBeInTheDocument();
      const d = card("Department budgets");
      expect(within(d).getAllByRole("button", { name: "Remove" })).toHaveLength(2);
      // the Add form offers only a department with a node and no budget yet (Web Dev and SEO have one; the null bucket has no node)
      expect(within(d).queryByLabelText("Department")).toBeNull();
    });
    it("offers the Add form with the departments that have no budget", async () => {
      readMock.mockResolvedValue(ok(withBudgets({ capabilities: OWNER, budgets: { company: companyBudget(), units: [unitBudget()] } })));
      allowRead(allowances());
      await mount();
      const select = within(card("Department budgets")).getByLabelText("Department") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual(["Choose a department", "SEO"]);
    });
    it("with no budget set, still gives the owner the form to set one: a control, not an empty box", async () => {
      readMock.mockResolvedValue(ok(companyUsage({ capabilities: OWNER })));
      allowRead(allowances({ overrides: [] }));
      await mount();
      const c = within(card("Company alert figure"));
      expect(c.getByText("No alert figure is set.")).toBeInTheDocument();
      expect(c.getByRole("button", { name: "Set the figure" })).toBeInTheDocument();
      expect(within(card("Department budgets")).getByText("No department has a budget.")).toBeInTheDocument();
    });
    it("lists the per-person allowance overrides with the default, each with a way back to the default", async () => {
      readMock.mockResolvedValue(ok(companyUsage({ capabilities: OWNER })));
      allowRead(allowances());
      await mount();
      const a = within(card("Daily reply allowances"));
      expect(a.getByText("Default: 200 replies a day.")).toBeInTheDocument();
      const row = a.getByText("Made Putra").closest("li") as HTMLElement;
      expect(row).toHaveTextContent("350 replies a day");
      expect(within(row).getByRole("button", { name: /Use the default/ })).toBeInTheDocument();
    });
    it("says so when nobody has their own allowance", async () => {
      readMock.mockResolvedValue(ok(companyUsage({ capabilities: OWNER })));
      allowRead(allowances({ overrides: [] }));
      await mount();
      expect(within(card("Daily reply allowances")).getByText("No one has their own allowance.")).toBeInTheDocument();
    });
    it("says a failed allowances read cannot tell, and still draws the rest of the page", async () => {
      readMock.mockResolvedValue(ok(companyUsage({ capabilities: OWNER })));
      vi.mocked(getAllowances).mockResolvedValue({ kind: "unavailable", reason: "upstream 502" });
      await mount();
      expect(screen.getByText("upstream 502")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: /^By surface/ })).toBeInTheDocument();
    });
  });
});
