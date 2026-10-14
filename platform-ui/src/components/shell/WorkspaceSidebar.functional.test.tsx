import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import { WorkspaceShellProvider, viewFor } from "./WorkspaceShellContext";
import { buildShellModel, workspaceForArea } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { areaFor, resolveArea } from "@/lib/areas";
import { me, member, node } from "@/lib/workspaceFixtures";

// DW-7d: HR, Finance and IT are org nodes now. `/hr/...` (an owned route, area carries the slug) and
// `/departments/<hr node id>/...` (area carries the deptId) must draw the SAME workspace.

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));

const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const HR_ID = "d-hr-co-a";

function modelFor(withHrNode: boolean) {
  const staff = me([member(), { role: "hr_manager", scopeType: "company", scopeId: "co-a" }]);
  const root = node("root", "Agency", "company", [
    node("d-web", "Web Dev", "department"),
    ...(withHrNode ? [node(HR_ID, "HR", "department")] : []),
  ]);
  return buildShellModel({ me: staff, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: staff, tenantId: "co-a", root }) });
}

function renderAt(pathname: string, model = modelFor(true)) {
  nav.pathname = pathname;
  return render(
    <WorkspaceShellProvider model={model}>
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[]} />
    </WorkspaceShellProvider>,
  );
}

// The AI Assistant link carries the page it was opened from (`?from=`), which differs by design; the rest must match.
const menuLinks = () =>
  within(screen.getByRole("navigation")).getAllByRole("link").map((a) => `${a.textContent?.trim()} ${a.getAttribute("href")?.split("?from=")[0]}`);

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("a functional department that is in the org tree (DW-7d)", () => {
  it("resolves /hr/... and /departments/<hr id>/... to the one HR workspace", () => {
    const model = modelFor(true);
    const hr = model.workspaces.filter((w) => w.key === "hr");
    expect(hr).toHaveLength(1);
    expect(hr[0].deptId).toBe(HR_ID);
    expect(hr[0].mine).toBe(true);
    const byConsole = workspaceForArea(model, resolveArea(areaFor("/hr/leave"), null, model.home));
    const byDept = workspaceForArea(model, resolveArea(areaFor(`/departments/${HR_ID}/projects`), null, model.home));
    expect(byConsole).toBe(hr[0]);
    expect(byDept).toBe(hr[0]);
    expect(viewFor(model, resolveArea(areaFor("/hr/leave"), null, model.home))).toEqual({ kind: "workspace", ws: hr[0] });
  });

  it("draws the same rows on both paths: not a visit, the switcher marks HR", () => {
    const first = renderAt("/hr/leave");
    const onConsole = menuLinks();
    expect(screen.queryByText(/Visiting/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    expect(screen.getByRole("link", { name: /^HR/ })).toHaveAttribute("aria-current", "true");
    first.unmount();

    renderAt(`/departments/${HR_ID}/projects`);
    expect(menuLinks()).toEqual(onConsole);
    expect(screen.queryByText(/Visiting/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Back to/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    expect(screen.getByRole("link", { name: /^HR/ })).toHaveAttribute("aria-current", "true");
  });

  it("offers Project Management, its tabs under /departments/<hr id>/...", () => {
    renderAt("/hr/leave");
    const pm = menuLinks().find((l) => l.startsWith("Project Management "));
    expect(pm).toBe(`Project Management /departments/${HR_ID}/projects`);
    const ws = modelFor(true).workspaces.find((w) => w.key === "hr")!;
    const tabs = ws.rows.work.find((r) => r.key === "pm")!.tabs.map((t) => t.href);
    expect(tabs.length).toBeGreaterThan(0);
    for (const href of tabs) expect(href.startsWith(`/departments/${HR_ID}/`)).toBe(true);
  });

  it("a company whose tree lacks HR still gets the workspace, without Project Management", () => {
    const model = modelFor(false);
    const hr = model.workspaces.find((w) => w.key === "hr")!;
    expect(hr.deptId).toBeNull();
    expect(hr.rows.work.map((r) => r.key)).not.toContain("pm");
  });
});
