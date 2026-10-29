import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// SCP-5d (BFF §63.19): the Team dashboard's block on Reports > Team. It draws ONLY on an ok answer for the Social Media department: a 403 (not one of the four) or a failed
// read hides it, and another department never reads it.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/departments", () => ({ getDepartment: vi.fn() }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/socialTeam-data", () => ({ getTeamDashboard: vi.fn() }));

import { getDepartment } from "@/lib/departments";
import { getTeamDashboard } from "@/lib/socialTeam-data";
import { asTeamDashboard, type TeamDashboard } from "@/lib/socialTeam";
import type { ReadResult } from "@/lib/readResult";
import type { Me } from "@/lib/platform";
import { SocialTeamBlock } from "./SocialTeamBlock";

const ME = { userId: "u-1", companies: [{ id: "co-a", vertical: "agency" }] } as unknown as Me;
const row = (kind: string, i: number) => ({ kind, postId: `p-${i}`, engagementId: "e-1", clientName: "Northwind Traders", since: "2026-10-05" });
const answer = (kinds: string[]): ReadResult<TeamDashboard> => ({
  kind: "ok",
  data: asTeamDashboard({
    month: "2026-10", needsAttention: kinds.map(row), clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [], personRowsLimited: false, partial: [],
  }),
});
const mount = async (unit = "d-soc") => render((await SocialTeamBlock({ me: ME, userId: "u-1", tenantId: "co-a", unit })) ?? <></>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T04:00:00Z"));
  vi.mocked(getDepartment).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getTeamDashboard).mockReset().mockResolvedValue(answer(["late", "at_risk", "blocked", "report_due"]));
});
afterEach(() => vi.useRealTimers());

describe("SocialTeamBlock", () => {
  it("reads this month's dashboard of the Social Media department and says how many need attention and how many are late or at risk", async () => {
    await mount();
    expect(getDepartment).toHaveBeenCalledWith("u-1", "co-a", "d-soc");
    expect(getTeamDashboard).toHaveBeenCalledWith("u-1", "co-a", "2026-10");
    const block = screen.getByTestId("social-team-block");
    expect(block).toHaveTextContent("4 items need attention this month; 2 of them are late or at risk.");
    expect(screen.getByRole("link", { name: "Open the Team dashboard" })).toHaveAttribute("href", "/departments/d-soc/dashboard");
  });

  it("uses the singular for one, and says none is late when none is", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(answer(["blocked"]));
    await mount();
    expect(screen.getByTestId("social-team-block")).toHaveTextContent("1 item needs attention this month; none is late or at risk.");
    vi.mocked(getTeamDashboard).mockResolvedValue(answer(["late"]));
    document.body.innerHTML = "";
    await mount();
    expect(screen.getByTestId("social-team-block")).toHaveTextContent("1 item needs attention this month; 1 of them is late or at risk.");
  });

  it("says nothing needs attention when the server says so (an empty list is its claim)", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(answer([]));
    await mount();
    expect(screen.getByTestId("social-team-block")).toHaveTextContent("Nothing needs attention this month; none is late or at risk.");
  });

  it("hides on a 403 (the person is not one of the four) and on a failed read", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({ kind: "forbidden" });
    expect((await mount()).container).toBeEmptyDOMElement();
    vi.mocked(getTeamDashboard).mockResolvedValue({ kind: "unavailable", reason: "503" });
    expect((await mount()).container).toBeEmptyDOMElement();
  });

  it("is absent, not a crash, when the read itself throws", async () => {
    vi.mocked(getTeamDashboard).mockRejectedValue(new Error("socket hang up"));
    expect((await mount()).container).toBeEmptyDOMElement();
  });

  it("never reads for a department that is not the Social Media one, or that is not found, or whose lookup fails", async () => {
    vi.mocked(getDepartment).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    expect((await mount("d-web")).container).toBeEmptyDOMElement();
    vi.mocked(getDepartment).mockResolvedValue(null as never);
    expect((await mount("d-x")).container).toBeEmptyDOMElement();
    vi.mocked(getDepartment).mockRejectedValue(new Error("boom"));
    expect((await mount("d-y")).container).toBeEmptyDOMElement();
    expect(getTeamDashboard).not.toHaveBeenCalled();
  });
});
