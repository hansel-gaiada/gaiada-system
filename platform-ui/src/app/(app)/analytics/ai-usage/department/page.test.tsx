import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UsageRead } from "@/lib/aiUsage-data";
import type { UnitUsage } from "@/lib/aiUsage";
import { EMPTY_TOTALS, allowances, unitBudget, unitUsage } from "@/lib/aiUsageFixtures";
import { agencyTree, lead, me as meFixture, member } from "@/lib/workspaceFixtures";

// AIP-16 (BFF section 66.4, owner rulings AIP-D6 and AIP-D18): Analytics > AI usage, one department's month. PER PERSON only when the answer HAS the
// `people` key (the head and the owner); without it (company admins, the GM) no person section is drawn at all. A refusal is the house "not allowed"
// state, an unknown department the "not found" state, and neither is an empty month. With no `?unit=` the page offers the departments the person may open.
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
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/aiUsage-data", () => ({ getUnitAiUsage: vi.fn(), getAllowances: vi.fn() }));
vi.mock("@/lib/aiBudgetActions", () => ({
  setCompanyBudgetAction: vi.fn(), setUnitBudgetAction: vi.fn(), setAllowanceAction: vi.fn(), liftStopAction: vi.fn(),
}));

import { getMe } from "@/lib/platform";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getAllowances, getUnitAiUsage } from "@/lib/aiUsage-data";
import DepartmentAiUsagePage from "./page";

const readMock = vi.mocked(getUnitAiUsage);
const ok = (data: UnitUsage): UsageRead<UnitUsage> => ({ kind: "ok", data });
const mount = async (sp: { unit?: string; month?: string } = { unit: "d-web" }) => render(await DepartmentAiUsagePage({ searchParams: Promise.resolve(sp) }));
const card = (title: string) => screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;
const cardTitles = () => [...document.querySelectorAll("section.lux-card h3")].map((h) => h.firstChild?.textContent);

const as = {
  member: meFixture([member()]),
  head: meFixture([member(), lead("d-web")]),
  admin: meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]),
  owner: meFixture([{ role: "owner", scopeType: "company", scopeId: "co-a" }]),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  vi.mocked(getMe).mockResolvedValue(as.head);
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree() as never);
  readMock.mockReset().mockResolvedValue(ok(unitUsage()));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads this unit's current UTC month for the signed-in person in the active company", async () => {
    await mount();
    expect(readMock).toHaveBeenCalledWith("u-1", "co-a", "d-web", "2026-10");
  });
  it("passes a chosen month, and keeps the unit in every month link and in the form", async () => {
    await mount({ unit: "d-web", month: "2026-09" });
    expect(readMock).toHaveBeenCalledWith("u-1", "co-a", "d-web", "2026-09");
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: /August 2026/ })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-web&month=2026-08");
    expect(within(nav).getByRole("link", { name: /October 2026/ })).toHaveAttribute("href", "/analytics/ai-usage/department?unit=d-web&month=2026-10");
    expect(document.querySelector('form input[type="hidden"][name="unit"]')).toHaveAttribute("value", "d-web");
  });
  it("asks the server whenever it is given a unit, for anyone: the server decides (the GM holds the read through a seat the UI cannot see)", async () => {
    vi.mocked(getMe).mockResolvedValue(as.member);
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(readMock).toHaveBeenCalledTimes(1);
  });
});

describe("the department's month", () => {
  it("names the department from the answer and leads with the by-surface breakdown", async () => {
    await mount();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("AI usage: Web Dev");
    expect(cardTitles().slice(0, 3)).toEqual(["By surface", "Month total", "By model"]);
    expect(within(card("By surface")).getByText("Knowledge (embedding and search)")).toBeInTheDocument();
  });
  it("shows the model lines, a model that was not recorded said so", async () => {
    await mount();
    const model = within(card("By model"));
    expect(model.getByText("openrouter / z-ai/glm-5.3-flash")).toBeInTheDocument();
    expect(model.getByText("Model not recorded")).toBeInTheDocument();
  });
  it("draws each person when the answer has the people (the head, the owner), by name, with counts and cost only", async () => {
    await mount();
    const people = within(card("By person"));
    expect(people.getByText("Made Putra").closest(".lux-table__row")).toHaveTextContent("$0.0002");
    expect(people.getByText("Name not available").closest(".lux-table__row")).toHaveTextContent("under $0.0001");
  });
  it("draws NO person section when the answer has no `people` key (company admins, the GM): never an empty list", async () => {
    vi.mocked(getMe).mockResolvedValue(as.admin);
    readMock.mockResolvedValue(ok(unitUsage({ people: null, capabilities: { canSeePeople: false, canManage: false, canLiftStop: false } })));
    await mount();
    expect(screen.queryByRole("heading", { name: /^By person/ })).not.toBeInTheDocument();
    expect(cardTitles()).toEqual(["By surface", "Month total", "By model", "By day"]);
  });
  it("says so when the answer HAS people and the list is empty", async () => {
    vi.mocked(getMe).mockResolvedValue(as.owner);
    readMock.mockResolvedValue(ok(unitUsage({ people: [] })));
    await mount();
    expect(within(card("By person")).getByText("No person in this department used AI this month.")).toBeInTheDocument();
  });
  it("shows the unknown and marked figures as the answer says them", async () => {
    await mount();
    const model = within(card("By model")).getByText("Model not recorded").closest(".lux-table__row") as HTMLElement;
    expect([...model.querySelectorAll(":scope > span")].map((c) => c.textContent)).toEqual(["Model not recorded", "5", "unknown", "unknown", "unknown"]);
    expect(within(card("By model")).getByText("openrouter / z-ai/glm-5.3-flash").closest(".lux-table__row")).toHaveTextContent("9,200 (estimated)");
  });
  it("says an empty month plainly", async () => {
    readMock.mockResolvedValue(ok(unitUsage({ month: "2026-08", totals: EMPTY_TOTALS, bySurface: [], byModel: [], byDay: [], people: [] })));
    await mount({ unit: "d-web", month: "2026-08" });
    expect(screen.getByText("No AI use recorded in August 2026")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^By person/ })).not.toBeInTheDocument();
  });
});

describe("a refusal, an unknown department and a failed read", () => {
  it("says a 403 in the house 'not allowed' state, never as an empty month", async () => {
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount({ unit: "d-seo" });
    expect(screen.getByText(/You don't have access to this department's AI usage/)).toBeInTheDocument();
    expect(screen.getByText(/Only the department's head, the owner and company admins/)).toBeInTheDocument();
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("says a 404 unit_not_found in the 'not found' state", async () => {
    vi.mocked(getMe).mockResolvedValue(as.admin);
    readMock.mockResolvedValue({ kind: "not_found" });
    await mount({ unit: "d-gone" });
    const gone = document.querySelector('[data-state="not-found"]');
    expect(gone).toHaveTextContent("This department was not found.");
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
  });
  it("says a failed read cannot tell, with the reason", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", reason: "upstream 502" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("upstream 502")).toBeInTheDocument();
  });
});

describe("with no ?unit=: choose a department", () => {
  const options = () => screen.queryAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/analytics/ai-usage/department?unit=")).map((a) => `${a.textContent} ${a.getAttribute("href")}`);
  it("offers a head the departments they lead, and reads nothing", async () => {
    await mount({});
    expect(options()).toEqual(["Frontend /analytics/ai-usage/department?unit=dv-fe&month=2026-10", "Web Dev /analytics/ai-usage/department?unit=d-web&month=2026-10"]);
    expect(readMock).not.toHaveBeenCalled();
  });
  it("offers the company read every department", async () => {
    vi.mocked(getMe).mockResolvedValue(as.admin);
    await mount({});
    expect(options().map((o) => o.split(" /")[0]).sort()).toEqual(["Frontend", "GM", "SEO", "Web Dev"]);
  });
  it("tells a person who leads no one that this is for heads, and reads nothing", async () => {
    vi.mocked(getMe).mockResolvedValue(as.member);
    await mount({});
    expect(screen.getByText(/Only the department's head, the owner and company admins/)).toBeInTheDocument();
    expect(readOrgRoot).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });
  it("says so when the organisation could not be read", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    await mount({});
    expect(screen.getByText(/the organisation could not be read/)).toBeInTheDocument();
  });
});

// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11): this unit's OWN budget line, the owner's form and per-person allowances, and the Lift button.
describe("the department's budget (AIP-17b)", () => {
  const OWNER = { canSeePeople: true, canManage: true, canLiftStop: true };
  const HEAD = { canSeePeople: true, canManage: false, canLiftStop: true };
  const stopped = () => unitBudget({ mode: "soft_stop", monthlyUsd: "1.0000", spentUsd: "1.30000000", percent: 130, state: "over_100", stopLifted: false });
  beforeEach(() => vi.mocked(getAllowances).mockReset().mockResolvedValue({ kind: "ok", data: allowances() }));
  const liftButton = () => screen.queryByRole("button", { name: "Lift the stop for the rest of this month" });

  it("shows no Budget box when no budget is set, and reads no allowances for a head", async () => {
    await mount();
    expect(screen.queryByRole("heading", { name: /^Budget/ })).not.toBeInTheDocument();
    expect(getAllowances).not.toHaveBeenCalled();
  });
  it("shows the unit's own line: mode in words, figure, spent, percent and state, leading the page", async () => {
    readMock.mockResolvedValue(ok(unitUsage({ budget: unitBudget() })));
    await mount();
    expect(cardTitles()[0]).toBe("Budget");
    const b = within(card("Budget"));
    expect(b.getByText("Report only")).toBeInTheDocument();
    expect(b.getByText("$1.00 a month")).toBeInTheDocument();
    expect(b.getByText("$0.8000 of $1.00")).toBeInTheDocument();
    expect(b.getByText("80%")).toBeInTheDocument();
    expect(b.getByText("over 80%")).toBeInTheDocument();
    expect(b.queryByText("lifted for this month")).not.toBeInTheDocument();
  });
  it("shows the three state words", async () => {
    for (const [state, percent, words] of [["under", 10, "under"], ["over_80", 85, "over 80%"], ["over_100", 100, "at or over 100%"]] as const) {
      readMock.mockResolvedValue(ok(unitUsage({ budget: unitBudget({ state, percent }) })));
      const { unmount } = await mount();
      expect(within(card("Budget")).getByText(words)).toBeInTheDocument();
      unmount();
    }
  });
  it("shows no form to a head: no input, no Remove, no allowance column", async () => {
    readMock.mockResolvedValue(ok(unitUsage({ budget: unitBudget(), capabilities: HEAD })));
    await mount();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove|Change|Set the/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Daily reply allowance")).not.toBeInTheDocument();
  });

  describe("for the owner (canManage)", () => {
    beforeEach(() => vi.mocked(getMe).mockResolvedValue(as.owner));
    it("shows the budget form (figure and mode), starting from what is stored", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ budget: stopped(), capabilities: OWNER })));
      await mount();
      const b = within(card("Budget"));
      expect((b.getByLabelText("Monthly figure (US dollars)") as HTMLInputElement).value).toBe("1.0000");
      expect((b.getByLabelText("When it reaches the figure") as HTMLSelectElement).value).toBe("soft_stop");
      expect(b.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    });
    it("with no budget set, gives the form to set one (Report only by default)", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ capabilities: OWNER })));
      await mount();
      const b = within(card("Budget"));
      expect(b.getByText("No budget is set for this department.")).toBeInTheDocument();
      expect((b.getByLabelText("When it reaches the figure") as HTMLSelectElement).value).toBe("report");
      expect(b.getByRole("button", { name: "Set the budget" })).toBeInTheDocument();
    });
    it("adds an allowance column to the by-person table: the default shown when no override, the override as a number", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ capabilities: OWNER })));
      await mount();
      expect(getAllowances).toHaveBeenCalledWith("u-1", "co-a");
      const people = within(card("By person"));
      expect(people.getByText("Daily reply allowance")).toBeInTheDocument();
      expect(people.getByText("Made Putra").closest(".lux-table__row")).toHaveTextContent("350 a day");
      expect(people.getByText("Made Putra").closest(".lux-table__row")).not.toHaveTextContent("(default)");
      expect(people.getByText("Name not available").closest(".lux-table__row")).toHaveTextContent("200 a day (default)");
    });
    it("reads no allowances when the answer has no people (nothing to put them in), and keeps the plain table without one", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ people: null, capabilities: OWNER })));
      await mount();
      expect(getAllowances).not.toHaveBeenCalled();
      expect(screen.queryByText("Daily reply allowance")).not.toBeInTheDocument();
    });
    it("keeps the plain by-person table when the allowances cannot be read (the rest of the page is unaffected)", async () => {
      vi.mocked(getAllowances).mockResolvedValue({ kind: "unavailable", reason: "x" });
      readMock.mockResolvedValue(ok(unitUsage({ capabilities: OWNER })));
      await mount();
      expect(screen.queryByText("Daily reply allowance")).not.toBeInTheDocument();
      expect(within(card("By person")).getByText("Made Putra")).toBeInTheDocument();
    });
  });

  describe("the Lift button (AIP-18)", () => {
    it("is offered for a Soft stop at or over 100%, not lifted this month, when canLiftStop, in the current month: to a head and to the owner", async () => {
      for (const caps of [HEAD, OWNER]) {
        readMock.mockResolvedValue(ok(unitUsage({ budget: stopped(), capabilities: caps })));
        const { unmount } = await mount();
        expect(liftButton()).toBeInTheDocument();
        unmount();
      }
    });
    it.each([
      ["Report only", unitBudget({ mode: "report", state: "over_100", percent: 130 })],
      ["over 80% only", unitBudget({ mode: "soft_stop", state: "over_80", percent: 85 })],
      ["under", unitBudget({ mode: "soft_stop", state: "under", percent: 10 })],
      ["already lifted this month", { ...stopped(), stopLifted: true }],
    ])("is not offered when the budget is %s", async (_n, budget) => {
      readMock.mockResolvedValue(ok(unitUsage({ budget, capabilities: HEAD })));
      await mount();
      expect(liftButton()).not.toBeInTheDocument();
    });
    it("is not offered without canLiftStop, and not with no budget", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ budget: stopped(), capabilities: { canSeePeople: true, canManage: false, canLiftStop: false } })));
      await mount();
      expect(liftButton()).not.toBeInTheDocument();
      cleanup();
      readMock.mockResolvedValue(ok(unitUsage({ budget: null, capabilities: HEAD })));
      await mount();
      expect(liftButton()).not.toBeInTheDocument();
    });
    it("is not offered beside a past month's figures (a lift always applies to the current month)", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ month: "2026-09", budget: stopped(), capabilities: HEAD })));
      await mount({ unit: "d-web", month: "2026-09" });
      expect(within(card("Budget")).getByText("at or over 100%")).toBeInTheDocument();
      expect(liftButton()).not.toBeInTheDocument();
    });
    it("after a lift the line says 'lifted for this month' and the button is gone", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ budget: { ...stopped(), stopLifted: true }, capabilities: HEAD })));
      await mount();
      expect(within(card("Budget")).getByText("lifted for this month")).toBeInTheDocument();
      expect(liftButton()).not.toBeInTheDocument();
    });
    it("asks first, and says what lifting does", async () => {
      readMock.mockResolvedValue(ok(unitUsage({ budget: stopped(), capabilities: HEAD })));
      await mount();
      fireEvent.click(liftButton() as HTMLElement);
      expect(screen.getByText(/Replies return to normal for this department until the month ends, and waiting agent runs start/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Confirm: lift the stop" })).toBeInTheDocument();
    });
  });
});
