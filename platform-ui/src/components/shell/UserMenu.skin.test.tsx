import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UserMenu } from "./UserMenu";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { buildShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "@/lib/workspaceAccess";
import { me, member, node, person } from "@/lib/workspaceFixtures";
import { setSkinChoiceAction } from "@/lib/prefsActions";
import type { SkinChoice } from "@/lib/skins";

// SCP-Kd (DW-D51): the way back from the personal opt-out. The Standard avatar menu offers "Use the Social look" only where the person is on a
// workspace whose skin is on but has chosen Standard; everywhere else the menu is exactly as it was.

const nav = vi.hoisted(() => ({ pathname: "/departments/d-soc", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: nav.refresh }) }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}), setSkinChoiceAction: vi.fn(async () => {}) }));

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);
const who = me([member()]);
function model(on: ("standard" | "social")[], choice?: SkinChoice) {
  return buildShellModel({ me: who, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: who, tenantId: "co-a", root: tree }), skins: { on, ...(choice ? { choice } : {}) } });
}
function menuAt(pathname: string, on: ("standard" | "social")[], choice?: SkinChoice) {
  nav.pathname = pathname;
  const out = render(
    <WorkspaceShellProvider model={model(on, choice)}>
      <UserMenu name="Rina Vale" secondary="Designer" initials="RV" compact theme="auto" />
    </WorkspaceShellProvider>,
  );
  fireEvent.click(out.container.querySelector(".erp-usermenu__trigger") as HTMLElement);
  return out;
}
const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);
const BASE = ["Account settings", "Sign out"];

beforeEach(() => {
  nav.refresh.mockClear();
  vi.mocked(setSkinChoiceAction).mockClear();
});

describe("the avatar menu's way back to the skin", () => {
  it("offers 'Use the Social look' only to a person on a Social workspace who chose Standard", () => {
    menuAt("/departments/d-soc", ["standard", "social"], "standard");
    expect(items()).toEqual(["Use the Social look", ...BASE]);
  });

  it("sets the choice back to the workspace's own skin and refreshes", async () => {
    menuAt("/departments/d-soc", ["standard", "social"], "standard");
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Use the Social look" })); });
    expect(setSkinChoiceAction).toHaveBeenCalledWith("workspace");
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    // The menu closes on the choice.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is not offered while the person wears the skin (the Social skin hides this menu anyway)", () => {
    menuAt("/departments/d-soc", ["standard", "social"]);
    expect(items()).toEqual(BASE);
  });

  it("is not offered on another department, whose own skin is Standard", () => {
    menuAt("/departments/d-web", ["standard", "social"], "standard");
    expect(items()).toEqual(BASE);
  });

  it("is not offered in the Company area", () => {
    menuAt("/organization", ["standard", "social"], "standard");
    expect(items()).toEqual(BASE);
  });

  it("with Social off is exactly the menu it always was, in or out of the shell, even for a person who chose Standard", () => {
    const outside = render(<UserMenu name="Rina Vale" secondary="Designer" initials="RV" compact theme="auto" />);
    fireEvent.click(outside.container.querySelector(".erp-usermenu__trigger") as HTMLElement);
    const plain = outside.container.innerHTML;
    outside.unmount();
    for (const choice of [undefined, "standard"] as const) {
      const inside = menuAt("/departments/d-soc", ["standard"], choice);
      expect(items()).toEqual(BASE);
      expect(inside.container.innerHTML).toBe(plain);
      inside.unmount();
    }
  });
});
