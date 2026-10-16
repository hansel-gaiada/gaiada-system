import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HideOnOverview } from "./HideOnOverview";
import { inShell } from "@/components/shell/workspaceShellTestKit";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

beforeEach(() => {
  window.sessionStorage.clear();
});

const header = <h1>Web Dev header</h1>;

describe("HideOnOverview", () => {
  it("hides the header on the workspace's Overview page, in the workspace shell", () => {
    nav.pathname = "/departments/d-web";
    render(inShell(<HideOnOverview overviewPath="/departments/d-web">{header}</HideOnOverview>));
    expect(screen.queryByText("Web Dev header")).not.toBeInTheDocument();
  });

  it("tolerates a trailing slash", () => {
    nav.pathname = "/departments/d-web/";
    render(inShell(<HideOnOverview overviewPath="/departments/d-web">{header}</HideOnOverview>));
    expect(screen.queryByText("Web Dev header")).not.toBeInTheDocument();
  });

  it("keeps the header on every other page of the workspace", () => {
    for (const path of ["/departments/d-web/board", "/departments/d-web/projects/p-1", "/departments/d-other"]) {
      nav.pathname = path;
      const { unmount } = render(inShell(<HideOnOverview overviewPath="/departments/d-web">{header}</HideOnOverview>));
      expect(screen.getByText("Web Dev header"), path).toBeInTheDocument();
      unmount();
    }
  });

  it("never hides it outside the workspace shell", () => {
    nav.pathname = "/departments/d-web";
    render(<HideOnOverview overviewPath="/departments/d-web">{header}</HideOnOverview>);
    expect(screen.getByText("Web Dev header")).toBeInTheDocument();
  });

  it("keeps it where the layout opts out (the GM's refusal page)", () => {
    nav.pathname = "/departments/d-web";
    render(inShell(<HideOnOverview overviewPath="/departments/d-web" enabled={false}>{header}</HideOnOverview>));
    expect(screen.getByText("Web Dev header")).toBeInTheDocument();
  });
});
