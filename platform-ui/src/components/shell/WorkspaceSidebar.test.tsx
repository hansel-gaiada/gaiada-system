import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { buildShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me, member } from "@/lib/workspaceFixtures";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
// Records the props every link was given: next/link consumes `prefetch` and renders nothing for it.
const linkCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("next/link", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("next/link")>()).default;
  return { default: (props: ComponentProps<typeof Real>) => { linkCalls.push(props as unknown as Record<string, unknown>); return <Real {...props} />; } };
});

// A placed Web Dev employee in an agency company with Web Dev, SEO and the GM in its org tree.
const employee = me([member()]);
const model = buildShellModel({
  me: employee,
  tenantId: "co-a",
  workspaces: resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) }),
});
const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };

function renderAt(pathname: string, companies: SidebarCompany[] = []) {
  nav.pathname = pathname;
  // A fresh element each time: React skips re-rendering an identical one, and the mocked pathname is
  // read only when the sidebar renders.
  const ui = () => (
    <WorkspaceShellProvider model={model}>
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={companies} newItems={[{ label: "Task", href: "/tasks/new" }]} />
    </WorkspaceShellProvider>
  );
  const out = render(ui());
  return { ...out, goTo: (next: string) => { nav.pathname = next; out.rerender(ui()); } };
}

const switcher = () => screen.getByRole("button", { name: /Switch workspace/ });
const menu = () => screen.getByRole("navigation");

beforeEach(() => {
  window.sessionStorage.clear();
  linkCalls.length = 0;
});

describe("WorkspaceSidebar", () => {
  it("draws the Web Dev rows on a Web Dev page, with the row holding the page active", () => {
    renderAt("/departments/d-web/prd");
    expect(switcher()).toHaveTextContent("Web Dev");
    expect(switcher()).toHaveTextContent("Agency");
    const build = within(menu()).getByRole("link", { name: "Build" });
    expect(build).toHaveAttribute("aria-current", "page");
    expect(build).toHaveAttribute("href", "/departments/d-web/prd");
    expect(within(menu()).getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(within(menu()).getByRole("group", { name: "Work" })).toBeInTheDocument();
    expect(within(menu()).getByRole("group", { name: "Performance" })).toBeInTheDocument();
    expect(within(menu()).getByRole("group", { name: "You" })).toBeInTheDocument();
    expect(screen.queryByText(/Visiting/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Back to/ })).toBeNull();
  });

  // DW-2d: the row opens today's assistant drawer over the current page, as the floating button did.
  describe("the AI Assistant row (DW-2d)", () => {
    const row = () => within(menu()).getByRole("link", { name: "AI Assistant" });

    it("links to the drawer's route with no page context on a page with no record, carrying the page it was opened from (DW-2h)", () => {
      renderAt("/departments/d-web");
      expect(row()).toHaveAttribute("href", `/assistant?from=${encodeURIComponent("/departments/d-web")}`);
      expect(within(menu()).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    });

    it("carries the page context of the record it was opened from", () => {
      const { goTo } = renderAt("/tasks/t-4");
      expect(row()).toHaveAttribute("href", `/assistant?ctx=${encodeURIComponent("erp:task:t-4")}&from=${encodeURIComponent("/tasks/t-4")}`);
      goTo("/people/p-9");
      expect(row()).toHaveAttribute("href", `/assistant?ctx=${encodeURIComponent("erp:person:co-a:p-9")}&from=${encodeURIComponent("/people/p-9")}`);
    });

    it("has the FAB's id, so the drawer's focus return lands on it, and is not prefetched", () => {
      renderAt("/tasks/t-4");
      expect(row()).toHaveAttribute("id", "asst-fab-trigger");
      // next/link renders `prefetch={false}` as no prefetch at all; the prop itself is what the mock below sees.
      const mine = linkCalls.filter((p) => p.id === "asst-fab-trigger");
      expect(mine.length).toBeGreaterThan(0);
      for (const p of mine) expect(p.prefetch).toBe(false);
      // No other row is opted out of prefetching or takes the id.
      const rows = linkCalls.filter((p) => String(p.className).includes("ws-row") && p.id !== "asst-fab-trigger");
      expect(rows.length).toBeGreaterThan(0);
      for (const p of rows) { expect(p.prefetch).toBeUndefined(); expect(p.id).toBeUndefined(); }
      expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(1);
    });

    it("is simply the active row on /assistant, linking to the page", () => {
      renderAt("/assistant");
      expect(row()).toHaveAttribute("href", "/assistant");
      expect(row()).toHaveAttribute("aria-current", "page");
    });
  });

  it("lists the workspace's own create action first in + New, then the existing items (DW-2f)", () => {
    renderAt("/departments/d-web/prd");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((a) => a.textContent)).toEqual(["New briefing", "Task"]);
  });

  it("lists only the existing items at the Company view (DW-2f)", () => {
    renderAt("/organization");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((a) => a.textContent)).toEqual(["Task"]);
  });

  it("shows another department's rows as a visit, with the way back", () => {
    renderAt("/departments/d-seo");
    expect(screen.getByText("Visiting SEO")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Web Dev" })).toHaveAttribute("href", "/departments/d-web");
    expect(within(menu()).getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/departments/d-seo");
    expect(switcher()).toHaveTextContent("SEO");
  });

  it("draws the Company rows at /organization, with the way back", () => {
    renderAt("/organization");
    expect(within(menu()).getByRole("link", { name: "Organization" })).toHaveAttribute("aria-current", "page");
    expect(within(menu()).queryByRole("link", { name: "Build" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Web Dev" })).toBeInTheDocument();
    expect(screen.queryByText(/Visiting/)).toBeNull();
  });

  it("keeps the home workspace's rows on a personal page", () => {
    renderAt("/me");
    expect(switcher()).toHaveTextContent("Web Dev");
    expect(within(menu()).getByRole("link", { name: "Build" })).toBeInTheDocument();
    expect(within(menu()).getByRole("link", { name: "Me" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText(/Visiting/)).toBeNull();
  });

  it("keeps the department last visited on a personal page (the last-area rule)", () => {
    const { goTo } = renderAt("/departments/d-seo");
    goTo("/me/inbox");
    expect(screen.getByText("Visiting SEO")).toBeInTheDocument();
    expect(within(menu()).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  });

  it("reads the last area from this tab's session after mount", () => {
    window.sessionStorage.setItem("gaiada.shell.lastArea", JSON.stringify({ kind: "workspace", deptId: "d-seo" }));
    renderAt("/me/inbox");
    expect(screen.getByText("Visiting SEO")).toBeInTheDocument();
  });

  it("ignores a stored area it cannot read, and a department it does not know", () => {
    window.sessionStorage.setItem("gaiada.shell.lastArea", "{not json");
    const { unmount } = renderAt("/me");
    expect(switcher()).toHaveTextContent("Web Dev");
    unmount();
    window.sessionStorage.setItem("gaiada.shell.lastArea", JSON.stringify({ kind: "workspace", deptId: "d-other-company" }));
    renderAt("/me");
    expect(switcher()).toHaveTextContent("Web Dev");
  });

  it("lists the person's own workspace, then every department, in the switcher", () => {
    renderAt("/departments/d-web");
    const btn = switcher();
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const mine = screen.getByRole("list", { name: "Your workspaces" });
    expect(within(mine).getAllByRole("link").map((a) => a.textContent)).toEqual(["Web DevHome"]);
    expect(within(mine).getByRole("link")).toHaveAttribute("aria-current", "true");
    const all = screen.getByRole("list", { name: "Departments" });
    expect(within(all).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Office of the GM", "/departments/d-gm"],
      ["SEO", "/departments/d-seo"],
      ["HR", "/hr"],
      ["IT", "/it"],
      ["Finance", "/finance"],
    ]);
    expect(screen.queryByText("Switch company")).toBeNull();
  });

  it("closes the switcher on Escape and hands focus back", () => {
    renderAt("/departments/d-web");
    fireEvent.click(switcher());
    const link = within(screen.getByRole("list", { name: "Departments" })).getAllByRole("link")[0];
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Departments" })).toBeNull();
    expect(switcher()).toHaveFocus();
  });

  it("offers Switch company only with more than one company", () => {
    renderAt("/departments/d-web", [COMPANY, { id: "co-b", name: "Other" }]);
    fireEvent.click(switcher());
    expect(screen.getByText("Switch company")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Active company" })).toHaveValue("co-a");
  });

  it("has a footer with Company and + New, and no Admin without admin rows", () => {
    renderAt("/departments/d-web");
    expect(screen.getByRole("link", { name: "Company" })).toHaveAttribute("href", "/departments");
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("shows no counts on any row", () => {
    renderAt("/departments/d-web");
    for (const link of within(menu()).getAllByRole("link")) expect(link.textContent).not.toMatch(/\d/);
  });

  it("keeps the drawer contract the phone toggle relies on", () => {
    const { container } = renderAt("/departments/d-web");
    expect(container.querySelector("aside#app-nav.erp-side")).not.toBeNull();
  });
});
