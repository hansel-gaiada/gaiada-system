import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import { inShell } from "./workspaceShellTestKit";

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
});
