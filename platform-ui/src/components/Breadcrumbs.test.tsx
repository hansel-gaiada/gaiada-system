import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Breadcrumbs } from "./Breadcrumbs";
import { inShell } from "./shell/workspaceShellTestKit";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const items = [{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "HR" }];

describe("Breadcrumbs", () => {
  it("renders the trail outside the workspace shell (the portal), even on a tool page", () => {
    nav.pathname = "/hr/people";
    render(<Breadcrumbs items={items} />);
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail).toHaveTextContent("Organization");
    expect(screen.getByRole("link", { name: "Departments" })).toHaveAttribute("href", "/departments");
    expect(screen.getByText("HR").closest("a")).toBeNull();
  });

  it("hides on a tool page inside a workspace", () => {
    nav.pathname = "/hr/people";
    render(inShell(<Breadcrumbs items={items} />));
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("keeps the trail on a record below a tool inside a workspace", () => {
    nav.pathname = "/hr/people/u-123";
    render(inShell(<Breadcrumbs items={items} />));
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
  });

  it("renders nothing for an empty trail", () => {
    nav.pathname = "/hr/people/u-123";
    const { container } = render(<Breadcrumbs items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
