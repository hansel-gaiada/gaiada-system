import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { UsageRead } from "@/lib/aiUsage-data";
import type { MyUsage } from "@/lib/aiUsage";
import { EMPTY_TOTALS, fig, myUsage } from "@/lib/aiUsageFixtures";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

// AIP-05 (BFF section 66.3, owner ruling AIP-D18): Analytics > My AI use. The person's OWN month: by surface first, never one combined calls number,
// honest figures (unknown is not 0; a tiny cost is "under $0.0001"; estimated and price-table figures are marked), an empty month said plainly,
// and a refusal or a failed read said as such. Server page: the reader is mocked, and what is under test is what the page makes of each answer.
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
vi.mock("@/lib/aiUsage-data", () => ({ getMyAiUsage: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getMyAiUsage } from "@/lib/aiUsage-data";
import MyAiUsagePage from "./page";

const readMock = vi.mocked(getMyAiUsage);
const ok = (data: MyUsage): UsageRead<MyUsage> => ({ kind: "ok", data });
const mount = async (sp: { month?: string | string[] } = {}) => render(await MyAiUsagePage({ searchParams: Promise.resolve(sp) }));
// A card's title may carry a "?" hint button, so match on the title's own text.
const card = (title: string) => screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;
const cardTitles = () => [...document.querySelectorAll("section.lux-card h3")].map((h) => h.firstChild?.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  vi.mocked(getMe).mockResolvedValue(meFixture([member()]));
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  readMock.mockReset().mockResolvedValue(ok(myUsage()));
});
afterEach(() => vi.useRealTimers());

describe("what is asked of the platform", () => {
  it("reads the signed-in person's own current UTC month in the active company", async () => {
    await mount();
    expect(readMock).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
  });
  it("passes a chosen month, and the current month for one that is not a real month or is still to come", async () => {
    await mount({ month: "2026-09" });
    expect(readMock).toHaveBeenLastCalledWith("u-1", "co-a", "2026-09");
    await mount({ month: "2026-13" });
    expect(readMock).toHaveBeenLastCalledWith("u-1", "co-a", "2026-10");
    await mount({ month: "2027-01" });
    expect(readMock).toHaveBeenLastCalledWith("u-1", "co-a", "2026-10");
  });
  it("reads nothing, and says so, without an active company", async () => {
    vi.mocked(getActiveTenant).mockResolvedValue(null as never);
    await mount();
    expect(screen.getByText("Select a company from the top bar.")).toBeInTheDocument();
    expect(readMock).not.toHaveBeenCalled();
  });
});

describe("the month", () => {
  it("is shown and offers the earlier month, the months to choose from, and no month after this one", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByText("October 2026")).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /September 2026/ })).toHaveAttribute("href", "/analytics/ai-usage?month=2026-09");
    expect(within(nav).queryByRole("link", { name: /November 2026/ })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "This month" })).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Choose a month" }) as HTMLSelectElement;
    expect(select.name).toBe("month");
    expect(select.value).toBe("2026-10");
    expect(select.options).toHaveLength(12);
  });
  it("offers the next month and a way back to this month from an earlier one", async () => {
    readMock.mockResolvedValue(ok(myUsage({ month: "2026-08" })));
    await mount({ month: "2026-08" });
    const nav = screen.getByRole("navigation", { name: "Month" });
    expect(within(nav).getByRole("link", { name: /September 2026/ })).toHaveAttribute("href", "/analytics/ai-usage?month=2026-09");
    expect(within(nav).getByRole("link", { name: "This month" })).toHaveAttribute("href", "/analytics/ai-usage?month=2026-10");
  });
});

describe("what it shows", () => {
  it("leads with the by-surface breakdown, in readable labels, and never adds the surfaces into one calls number", async () => {
    await mount();
    const cards = cardTitles();
    expect(cards[0]).toBe("By surface");
    expect(cards.slice(0, 3)).toEqual(["By surface", "Month total", "By day"]);
    const surface = within(card("By surface"));
    expect(surface.getByText("Knowledge (embedding and search)")).toBeInTheDocument();
    expect(surface.getByText("Assistant replies")).toBeInTheDocument();
    expect(surface.getByText("AI agents")).toBeInTheDocument();
    expect(surface.getByText("3,180")).toBeInTheDocument();
    // the combined figure (3,199) is in no calls column of the page except the totals' own, which is not drawn
    expect(screen.queryByText("3,199")).not.toBeInTheDocument();
  });
  it("shows the month total as cost and tokens, with the sentences that say what is estimated or unpriced", async () => {
    await mount();
    const total = within(card("Month total"));
    expect(total.getByText("Cost").nextSibling).toHaveTextContent("$0.0011");
    expect(total.getByText("Tokens in").nextSibling).toHaveTextContent("421,200 (estimated)");
    expect(total.getByText("Tokens out").nextSibling).toHaveTextContent("2,100 (estimated)");
    expect(total.getByText(/Tokens are estimated for 2 calls/)).toBeInTheDocument();
    expect(total.getByText(/Cost is from our price table for 3 calls/)).toBeInTheDocument();
    expect(total.getByText(/8 calls had no cost figure, so the cost is a floor/)).toBeInTheDocument();
  });
  it("shows a null token sum and a null cost as unknown, never 0", async () => {
    await mount();
    const agent = within(card("By surface")).getByText("AI agents").closest(".lux-table__row") as HTMLElement;
    const cells = [...agent.querySelectorAll(":scope > span")].map((c) => c.textContent);
    expect(cells).toEqual(["AI agents", "5", "unknown", "unknown", "unknown"]);
  });
  it("shows a tiny cost as 'under $0.0001' and the marks beside the figures they belong to", async () => {
    readMock.mockResolvedValue(ok(myUsage({
      totals: fig({ calls: 4, costUsd: "0.00000900" }),
      bySurface: [{ surface: "title", ...fig({ calls: 4, costUsd: "0.00000900" }) }, { surface: "assistant", ...fig({ calls: 3, providerCostCalls: 0, tableCostCalls: 3, estimatedTokenCalls: 3 }) }],
    })));
    await mount();
    const surface = within(card("By surface"));
    expect(surface.getByText("Assistant chat titles").closest(".lux-table__row")).toHaveTextContent("under $0.0001");
    const assistant = surface.getByText("Assistant replies").closest(".lux-table__row") as HTMLElement;
    expect(assistant).toHaveTextContent("1,000 (estimated)");
    expect(assistant).toHaveTextContent("$0.0010 (from our price table)");
  });
  it("lists the days, with the calls column named as all surfaces", async () => {
    await mount();
    const day = within(card("By day"));
    expect(day.getByText("Calls (all surfaces)")).toBeInTheDocument();
    expect(day.getByText("3 Oct")).toBeInTheDocument();
    expect(day.getByText("12 Oct").closest(".lux-table__row")).toHaveTextContent("unknown");
  });
  it("draws no person, no model and no department section: this is the person's own", async () => {
    await mount();
    for (const t of ["By person", "By model", "By department"]) expect(screen.queryByRole("heading", { name: new RegExp(`^${t}`) })).not.toBeInTheDocument();
  });
});

describe("an empty month, a refusal and a failed read", () => {
  it("says an empty month plainly", async () => {
    readMock.mockResolvedValue(ok(myUsage({ month: "2026-08", totals: EMPTY_TOTALS, bySurface: [], byDay: [] })));
    await mount({ month: "2026-08" });
    expect(screen.getByText("No AI use recorded in August 2026")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^By surface/ })).not.toBeInTheDocument();
  });
  it("says a refusal as a refusal (a client contact is not staff), never as an empty month", async () => {
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/You don't have access to your AI use in this company/)).toBeInTheDocument();
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
  });
  it("says a failed read cannot tell, with the reason, never as an empty month", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", reason: "the AI usage answer had a bad costUsd" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("the AI usage answer had a bad costUsd")).toBeInTheDocument();
    expect(screen.queryByText(/No AI use recorded/)).not.toBeInTheDocument();
  });
});
