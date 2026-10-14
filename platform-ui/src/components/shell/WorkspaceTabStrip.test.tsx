import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import { inShell } from "./workspaceShellTestKit";
import { buildShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { HOTEL, agencyTree, me, member } from "@/lib/workspaceFixtures";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("WorkspaceTabStrip", () => {
  it("draws the active row's tabs, with the page's tab current", () => {
    nav.pathname = "/departments/d-web/repositories";
    render(inShell(<WorkspaceTabStrip />));
    const strip = screen.getByRole("navigation", { name: "Build sections" });
    expect(strip).toHaveClass("sec-tabs");
    const links = within(strip).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(expect.arrayContaining(["PRD Studio", "Repositories", "Deliverables"]));
    const current = links.filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Repositories");
    expect(current[0]).toHaveAttribute("href", "/departments/d-web/repositories");
    expect(current[0]).toHaveClass("sec-tab--active");
  });

  it("lights the parent tab on a record below it", () => {
    nav.pathname = "/departments/d-web/board/abc";
    render(inShell(<WorkspaceTabStrip />));
    const strip = screen.getByRole("navigation", { name: /sections$/ });
    expect(within(strip).getByRole("link", { current: "page" })).toHaveAttribute("href", "/departments/d-web/board");
  });

  it("draws nothing for a row with one tab", () => {
    nav.pathname = "/departments/d-web";
    const { container } = render(inShell(<WorkspaceTabStrip />));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing when no row holds the page", () => {
    // A personal page no sidebar row lists: the shell keeps the home workspace, and no row holds it.
    nav.pathname = "/appraisals/department";
    const { container } = render(inShell(<WorkspaceTabStrip />));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing in the classic shell", () => {
    nav.pathname = "/departments/d-web/repositories";
    const { container } = render(<WorkspaceTabStrip />);
    expect(container).toBeEmptyDOMElement();
  });

  // DW-8c: the You block's Calendar row, Calendar and Meetings, on the calendar and meetings pages.
  it("draws Calendar and Meetings on /calendar, with Calendar current", () => {
    nav.pathname = "/calendar";
    render(inShell(<WorkspaceTabStrip />));
    const strip = screen.getByRole("navigation", { name: "Calendar sections" });
    expect(within(strip).getAllByRole("link").map((a) => a.textContent?.trim())).toEqual(["Calendar", "Meetings"]);
    const current = within(strip).getByRole("link", { current: "page" });
    expect(current).toHaveTextContent("Calendar");
    expect(current).toHaveAttribute("href", "/calendar");
  });

  it.each(["/meetings", "/meetings/abc123"])("draws the same two tabs on %s, with Meetings current", (path) => {
    nav.pathname = path;
    render(inShell(<WorkspaceTabStrip />));
    const strip = screen.getByRole("navigation", { name: "Calendar sections" });
    expect(within(strip).getAllByRole("link").map((a) => a.textContent?.trim())).toEqual(["Calendar", "Meetings"]);
    const current = within(strip).getByRole("link", { current: "page" });
    expect(current).toHaveTextContent("Meetings");
    expect(current).toHaveAttribute("href", "/meetings");
  });

  it("omits Meetings for a company whose pack has no meetings row", () => {
    // A hotel (hospitality pack) member: the agencyRow gate for `meetings` is false for her company.
    const hotelMe = me([member("co-h")], [HOTEL]);
    const model = buildShellModel({
      me: hotelMe,
      tenantId: "co-h",
      workspaces: resolveMyWorkspaces({ me: hotelMe, tenantId: "co-h", root: agencyTree() }),
    });
    nav.pathname = "/calendar";
    // The gate removes Meetings, which leaves the row with one tab; the strip then draws nothing (a one-tab row).
    const { container } = render(inShell(<WorkspaceTabStrip />, model));
    expect(screen.queryByRole("link", { name: "Meetings" })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
