import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { buildShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { workspaceFor } from "@/lib/workspaces";
import { me, member, node, person } from "@/lib/workspaceFixtures";

// DW-6e: a department with no bespoke workspace draws the generic skeleton. The demo data has no such
// department in the browser (only the agency company has a seeded org tree), so it is proved here.

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));

const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };

describe("the generic workspace (DW-6e)", () => {
  it("is what an agency department with no bespoke workspace gets", () => {
    const ws = workspaceFor("agency", "Brand Studio");
    expect(ws.kind).toBe("generic");
    expect(ws.label).toBe("Brand Studio");
  });

  it("draws Overview, AI Assistant, Project Management, Tools & connections, then Reports, Analytics, Appraisals, Learning", () => {
    const employee = me([member()]);
    const root = node("root", "Agency", "company", [node("d-brand", "Brand Studio", "department", [person("p-1", "u-1")])]);
    const model = buildShellModel({ me: employee, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: employee, tenantId: "co-a", root }) });
    nav.pathname = "/departments/d-brand";
    render(
      <WorkspaceShellProvider model={model}>
        <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[]} />
      </WorkspaceShellProvider>,
    );

    const menu = screen.getByRole("navigation", { name: "Brand Studio menu" });
    const labels = (group?: string) =>
      within(group ? within(menu).getByRole("group", { name: group }) : menu).getAllByRole("link").map((a) => a.textContent?.trim());
    // An ordered subsequence, so a later ticket may add a row without breaking this.
    const all = labels();
    const wanted = ["Overview", "AI Assistant", "Project Management", "Tools & connections", "Reports", "Analytics", "Appraisals", "Learning"];
    let i = 0;
    for (const l of all) if (l === wanted[i]) i++;
    expect(i, `expected ${JSON.stringify(wanted)} in order within ${JSON.stringify(all)}`).toBe(wanted.length);

    expect(labels("Work")).toEqual(expect.arrayContaining(["Project Management", "Tools & connections"]));
    expect(labels("Performance").slice(0, 5)).toEqual(["My performance", "Reports", "Analytics", "Appraisals", "Learning"]);
    expect(within(menu).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  });
});
