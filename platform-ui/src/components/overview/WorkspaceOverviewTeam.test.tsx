import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { ViewSwitch } from "./ViewSwitch";
import { pilotFrame } from "./pilot";
import { subjectOfRef } from "@/lib/overview";
import { resolveMyWorkspaces, type MyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, lead, me, member } from "@/lib/workspaceFixtures";
import type { OverviewWidgetComponent } from "./widgets";
import * as workspacesData from "@/lib/workspaces-data";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/departments/d-web",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/prefs", () => ({ getPrefs: vi.fn(async () => ({ shell: "workspaces", pinnedTools: {} })) }));
vi.mock("@/lib/modules", () => ({ moduleGate: vi.fn(async () => ({ isEnabled: () => true })) }));
vi.mock("@/lib/workspaces-data", () => ({ myWorkspaces: vi.fn() }));


// DW-3h: the frame's Me | Team switch. Drawn only for a head of this workspace's unit; `?view=team` for anyone else is Me.
const tree = agencyTree({ frontend: ["u-1"] });
const asHead = { ...me([member(), lead("d-web")]), name: "Ketut Arta" };
const asMember = { ...me([member()]), name: "Made Putra" };
const webDevFor = (who: typeof asHead) => subjectOfRef(resolveMyWorkspaces({ me: who, tenantId: "co-a", root: tree }).all.find((r) => r.deptId === "d-web")!);
const NOW = new Date(2026, 9, 13, 9, 30);

// A host whose blocks say which view they were drawn for.
const host: Record<string, OverviewWidgetComponent> = {
  "needs-you": (p) => <p>needs-you view:{p.view}</p>,
  "your-numbers": (p) => <p>your-numbers view:{p.view} label:{p.subjectLabel}</p>,
};
const draw = (who: typeof asHead, props: Partial<Parameters<typeof WorkspaceOverview>[0]> = {}) =>
  render(<WorkspaceOverview me={who} tenantId="co-a" subject={webDevFor(who)} period="month" now={NOW} widgets={host} {...props} />);

describe("ViewSwitch", () => {
  it("is two plain links that keep the period, with the chosen one current", () => {
    render(<ViewSwitch value="team" period="week" />);
    const nav = screen.getByRole("navigation", { name: "View" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])).toEqual([
      ["Me", "?period=week", null],
      ["Team", "?period=week&view=team", "true"],
    ]);
  });

  it("marks Me current by default", () => {
    render(<ViewSwitch value="me" period="month" />);
    expect(screen.getByRole("link", { name: "Me" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Team" })).not.toHaveAttribute("aria-current");
  });
});

describe("WorkspaceOverview: Me | Team", () => {
  it("draws the switch for a head, beside the period selector, and defaults to Me", () => {
    draw(asHead, { canSwitchView: true });
    expect(screen.getByRole("navigation", { name: "View" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Me" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("needs-you view:me")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "You", exact: true })).toBeInTheDocument();
  });

  it("hands every block the Team view, with the workspace's name, and says so in the You band", () => {
    draw(asHead, { canSwitchView: true, view: "team", period: "week" });
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Me" })).toHaveAttribute("href", "?period=week");
    expect(screen.getByText("needs-you view:team")).toBeInTheDocument();
    expect(screen.getByText("your-numbers view:team label:Web Dev")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "You and your team" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "You", exact: true })).toBeNull();
  });

  it("draws no switch for anyone else, and a Team view handed to the frame is Me for them", () => {
    draw(asMember, { view: "team" });
    expect(screen.queryByRole("navigation", { name: "View" })).toBeNull();
    expect(screen.getByText("needs-you view:me")).toBeInTheDocument();
    expect(screen.getByText("your-numbers view:me label:Web Dev")).toBeInTheDocument();
  });
});

describe("pilotFrame: ?view=team is a head's alone (DW-3h)", () => {
  const frameFor = async (who: typeof asHead, search: { period?: string; view?: string | string[] }, deptId = "d-web") => {
    const ws: MyWorkspaces = resolveMyWorkspaces({ me: who, tenantId: "co-a", root: tree });
    vi.mocked(workspacesData.myWorkspaces).mockResolvedValue(ws);
    const frame = await pilotFrame(who, "co-a", { deptId }, Promise.resolve(search));
    expect(frame).not.toBeNull();
    return (frame!(null) as { props: { view: string; canSwitchView: boolean } }).props;
  };

  it("passes Team to a head of this unit who asked for it", async () => {
    expect(await frameFor(asHead, { view: "team" })).toMatchObject({ view: "team", canSwitchView: true });
  });

  it("offers the switch to a head but stays on Me without the param, or with a forged one", async () => {
    expect(await frameFor(asHead, {})).toMatchObject({ view: "me", canSwitchView: true });
    expect(await frameFor(asHead, { view: "TEAM" })).toMatchObject({ view: "me", canSwitchView: true });
  });

  it("ignores it for a member with no lead grant, so nothing about the team is read", async () => {
    expect(await frameFor(asMember, { view: "team" })).toMatchObject({ view: "me", canSwitchView: false });
    expect(await frameFor(asMember, { view: ["team"] })).toMatchObject({ view: "me", canSwitchView: false });
  });

  it("ignores it for a head of ANOTHER unit visiting this one", async () => {
    const seoHead = { ...me([member(), lead("d-seo")]), name: "Seo Head" };
    expect(await frameFor(seoHead, { view: "team" })).toMatchObject({ view: "me", canSwitchView: false });
    // ...and gives them the switch on their own department.
    expect(await frameFor(seoHead, { view: "team" }, "d-seo")).toMatchObject({ view: "team", canSwitchView: true });
  });
});
