import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkinPhoneBar } from "./SkinPhoneBar";
import { SkinPhoneTop } from "./SkinPhoneTop";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import type { SidebarAccount } from "./MorePanel";
import { ShellNotificationsSettle, WorkspaceShellProvider } from "./WorkspaceShellContext";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "@/lib/workspaceAccess";
import { me, member, node, person } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

// SCP-Ke (DW-D51, plan §6.2): the Social skin on a phone. jsdom has no media queries, so what is proved here is what the components DRAW and DO
// (the bar, the top controls, the sheet and its focus); that they appear only below 760px is CSS, driven in a browser by SCP-Kf.

const nav = vi.hoisted(() => ({ pathname: "/departments/d-soc" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}), setSkinChoiceAction: vi.fn(async () => {}) }));

const socialTree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);
const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const NEW_ITEMS = [{ label: "Task", href: "/tasks/new" }];
const officer = me([member()]);
const logout = vi.fn();
const ACCOUNT: SidebarAccount = { name: "Rina Vale", secondary: "Designer", initials: "RV", clientView: false, theme: "auto", logout };

function modelFor(who: Me, on: ("standard" | "social")[] = ["standard", "social"]): ShellModel {
  return buildShellModel({ me: who, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: who, tenantId: "co-a", root: socialTree }), skins: { on } });
}
const socialWs = (m: ShellModel) => m.workspaces.find((w) => w.key === "social-media")!;

function tree(model: ShellModel, extra?: ReactElement, props: Partial<ComponentProps<typeof SkinPhoneBar>> = {}) {
  return (
    <WorkspaceShellProvider model={model}>
      <SkinPhoneTop />
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={NEW_ITEMS} brand="Gaiada" account={ACCOUNT} />
      <SkinPhoneBar tenantId="co-a" newItems={NEW_ITEMS} company={COMPANY} companies={[]} account={ACCOUNT} {...props} />
      {extra}
    </WorkspaceShellProvider>
  );
}
function draw(model: ShellModel, pathname = "/departments/d-soc", extra?: ReactElement) {
  nav.pathname = pathname;
  return render(tree(model, extra));
}

const bar = () => screen.getByRole("navigation", { name: "Bottom navigation" });
const sidebarNav = () => screen.getByRole("navigation", { name: "Social Media menu" });
const topMore = () => document.querySelector<HTMLButtonElement>(".erp-top__phone button")!;
const sheet = () => screen.getByRole("dialog", { name: "More" });

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
  nav.pathname = "/departments/d-soc";
});

describe("the phone's bottom bar", () => {
  it("draws nothing for Standard: a workspace with no skin on, the Company area, or a person who chose Standard", () => {
    const off = draw(modelFor(officer, ["standard"]));
    expect(screen.queryByRole("navigation", { name: "Bottom navigation" })).toBeNull();
    expect(off.container.querySelector(".ws-bar, .erp-top__phone")).toBeNull();
    off.unmount();
    nav.pathname = "/organization";
    const company = render(tree(modelFor(me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]))));
    expect(company.container.querySelector(".ws-bar, .erp-top__phone")).toBeNull();
    company.unmount();
    const chose = buildShellModel({
      me: officer, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: officer, tenantId: "co-a", root: socialTree }),
      skins: { on: ["standard", "social"], choice: "standard" },
    });
    nav.pathname = "/departments/d-soc";
    const standard = render(tree(chose));
    expect(standard.container.querySelector(".ws-bar, .erp-top__phone")).toBeNull();
  });

  it("outside the workspace shell it draws nothing", () => {
    const { container } = render(<SkinPhoneBar tenantId="co-a" newItems={[]} company={COMPANY} companies={[]} account={ACCOUNT} />);
    expect(container).toBeEmptyDOMElement();
    const top = render(<SkinPhoneTop />);
    expect(top.container).toBeEmptyDOMElement();
  });

  it("is a landmark of its own, named differently from the menu", () => {
    draw(modelFor(officer));
    expect(bar()).toBeInTheDocument();
    expect(sidebarNav()).not.toBe(bar());
    expect(screen.getAllByRole("navigation")).toHaveLength(2);
  });

  it("holds Home, Search, Create and Tasks in that order, icon only and named by aria-label (Profile is ticketed, so absent)", () => {
    draw(modelFor(officer));
    const slots = Array.from(bar().querySelectorAll("a, button"));
    expect(slots.map((s) => s.getAttribute("aria-label"))).toEqual(["Home", "Search", "Create", "Tasks"]);
    for (const s of slots) expect(s.textContent).toBe("");
    expect(within(bar()).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/departments/d-soc");
    expect(within(bar()).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/me/tasks");
    expect(within(bar()).queryByRole("link", { name: "Profile" })).toBeNull();
  });

  it("Search opens the command palette with the event the top bar's field uses", () => {
    draw(modelFor(officer));
    const seen = vi.fn();
    window.addEventListener("gaiada:palette:open", seen);
    fireEvent.click(within(bar()).getByRole("button", { name: "Search" }));
    window.removeEventListener("gaiada:palette:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("Create opens the New menu: the workspace's creates first, then the shell's items, as the sidebar's does", () => {
    const model = modelFor(officer);
    const creates = socialWs(model).creates;
    expect(creates.length).toBeGreaterThan(0);
    draw(model);
    const create = within(bar()).getByRole("button", { name: "Create" });
    expect(create).toHaveAttribute("aria-haspopup", "menu");
    expect(create).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(create);
    expect(create).toHaveAttribute("aria-expanded", "true");
    const menu = within(bar()).getByRole("menu");
    expect(menu).toHaveClass("erp-new__menu--bar");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([...creates.map((c) => c.label), "Task"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(bar()).queryByRole("menu")).toBeNull();
  });

  it("marks the entry whose page this is as current", () => {
    const { unmount } = draw(modelFor(officer), "/departments/d-soc");
    expect(within(bar()).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(within(bar()).getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
    unmount();
    draw(modelFor(officer), "/me/tasks");
    expect(within(bar()).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
    expect(within(bar()).getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });
});

describe("the phone's top controls", () => {
  const top = () => document.querySelector<HTMLElement>(".erp-top__phone")!;

  it("are Notifications, Messages and More, in that order, with no count while it is unknown", () => {
    draw(modelFor(officer));
    expect(Array.from(top().querySelectorAll("a, button")).map((e) => e.getAttribute("aria-label") ?? e.textContent)).toEqual(["Notifications", "Messages", "More"]);
    expect(within(top()).getByRole("link", { name: "Messages" })).toHaveAttribute("href", "/departments/d-soc/messages");
    const bell = within(top()).getByRole("link", { name: "Notifications" });
    expect(bell).toHaveAttribute("href", "/me/inbox");
    expect(within(bell).queryByRole("img")).toBeNull();
  });

  it("show the unread count the top bar's one read settled, named for a screen reader", async () => {
    await act(async () => { draw(modelFor(officer), "/departments/d-soc", <ShellNotificationsSettle unread={4} />); });
    const bell = within(top()).getByRole("link", { name: "Notifications 4 unread" });
    expect(within(bell).getByRole("img", { name: "4 unread" })).toHaveTextContent("4");
  });

  it("mark Notifications current on the inbox", () => {
    draw(modelFor(officer), "/me/inbox");
    expect(within(top()).getByRole("link", { name: "Notifications" })).toHaveAttribute("aria-current", "page");
  });

  it("More is a button that controls the sheet", () => {
    draw(modelFor(officer));
    expect(topMore()).toHaveAttribute("aria-label", "More");
    expect(topMore()).toHaveAttribute("aria-expanded", "false");
    expect(topMore()).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(topMore());
    expect(topMore()).toHaveAttribute("aria-expanded", "true");
    expect(topMore()).toHaveAttribute("aria-controls", sheet().id);
  });
});

describe("More as a full-screen sheet", () => {
  it("opens the same panel, as a sheet, with focus on Find a page", () => {
    draw(modelFor(officer));
    fireEvent.click(topMore());
    expect(sheet()).toHaveClass("ws-more--sheet");
    expect(sheet()).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("searchbox", { name: "Find a page" })).toHaveFocus();
  });

  it("lists first a 'Menu' section with the pinned entries a phone has no other place for: Calendar, Reports, Saved, AI Assistant", () => {
    const model = modelFor(officer);
    draw(model);
    fireEvent.click(topMore());
    const groups = within(sheet()).getAllByRole("group");
    expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual(["Menu", "Work", "Performance", "You", "Company and Admin"]);
    const menu = groups[0];
    expect(Array.from(menu.querySelectorAll(".ws-more__label")).map((l) => l.textContent)).toEqual(["Calendar", "Reports", "Saved", "AI Assistant"]);
    expect(within(menu).getByRole("link", { name: "Calendar" })).toHaveAttribute("href", "/departments/d-soc/calendar");
    expect(within(menu).getByRole("link", { name: "Saved" })).toHaveAttribute("href", "/departments/d-soc/assets");
    expect(within(menu).getByRole("link", { name: "Reports" })).toHaveAttribute("href", "/reports/person");
    // Nothing the bar or the top holds is repeated there, and the rows below are the model's own, as on the desktop.
    for (const name of ["Home", "Tasks", "Notifications", "Search", "Create"]) expect(within(menu).queryByRole("link", { name })).toBeNull();
    expect(Array.from(groups[1].querySelectorAll("a[data-result]")).map((a) => (a as HTMLElement).dataset.result)).toEqual(socialWs(model).rows.work.map((r) => r.key));
  });

  it("keeps the AI Assistant on a phone: its drawer href, no prefetch, and not a second #asst-fab-trigger", () => {
    draw(modelFor(officer), "/departments/d-soc/calendar");
    fireEvent.click(topMore());
    const row = within(within(sheet()).getAllByRole("group")[0]).getByRole("link", { name: "AI Assistant" });
    expect(row).toHaveAttribute("href", `/assistant?from=${encodeURIComponent("/departments/d-soc/calendar")}`);
    expect(row).not.toHaveAttribute("id");
    // The sidebar's own pin still carries the id: exactly one in the document.
    expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(1);
    expect(document.querySelector("#asst-fab-trigger")?.closest(".ws-more")).toBeNull();
  });

  it("marks the current Menu entry, and Find a page filters that section too", () => {
    draw(modelFor(officer), "/departments/d-soc/calendar");
    fireEvent.click(topMore());
    // (The You block has its own Calendar row; the Menu entry is the one in the first section.)
    expect(within(within(sheet()).getAllByRole("group")[0]).getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a page" }), { target: { value: "saved" } });
    expect(Array.from(sheet().querySelectorAll(".ws-more__label")).map((l) => l.textContent)).toEqual(["Saved"]);
  });

  it("Escape closes it and returns focus to the top bar's More; so does its close button", () => {
    draw(modelFor(officer));
    fireEvent.click(topMore());
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find a page" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(topMore()).toHaveFocus();
    expect(topMore()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(topMore());
    fireEvent.click(within(sheet()).getByRole("button", { name: "Close More" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(topMore()).toHaveFocus();
  });

  it("any navigation closes it", () => {
    const model = modelFor(officer);
    const { rerender } = draw(model);
    fireEvent.click(topMore());
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    nav.pathname = "/me/tasks";
    rerender(tree(model));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("carries the workspace switcher, which opens its list, and the account", () => {
    draw(modelFor(officer));
    fireEvent.click(topMore());
    const dialog = sheet();
    const sw = within(dialog).getByRole("button", { name: /^Switch workspace/ });
    expect(sw).toHaveTextContent("Social Media");
    fireEvent.click(sw);
    expect(within(dialog).getByRole("list", { name: "Your workspaces" })).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Departments" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Account settings" })).toHaveAttribute("href", "/account");
    expect(within(dialog).getByRole("button", { name: "Log out" })).toBeInTheDocument();
    // Every skin still has exactly one switcher: this one.
    expect(screen.getAllByRole("button", { name: /Switch workspace/ })).toHaveLength(1);
  });

  it("does not turn the rail on: the sheet covers the screen, the menu column is not involved", () => {
    draw(modelFor(officer));
    fireEvent.click(topMore());
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
  });
});

describe("one More at a time", () => {
  it("opening the sheet closes the menu's panel, and the other way round", () => {
    draw(modelFor(officer));
    const menuMore = within(sidebarNav()).getByRole("button", { name: /^More/ });
    fireEvent.click(menuMore);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(sheet()).not.toHaveClass("ws-more--sheet");
    expect(menuMore).toHaveAttribute("aria-expanded", "true");
    // The menu's button is in the rail while its panel is open; the phone's button is not "outside" in any way that matters here: press, then click.
    fireEvent.click(topMore());
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(sheet()).toHaveClass("ws-more--sheet");
    expect(menuMore).toHaveAttribute("aria-expanded", "false");
    expect(topMore()).toHaveAttribute("aria-expanded", "true");
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
    fireEvent.click(menuMore);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(sheet()).not.toHaveClass("ws-more--sheet");
    expect(topMore()).toHaveAttribute("aria-expanded", "false");
  });

  it("the desktop panel has no Menu section: the menu column already shows those pins", () => {
    draw(modelFor(officer));
    fireEvent.click(within(sidebarNav()).getByRole("button", { name: /^More/ }));
    expect(within(sheet()).getAllByRole("group").map((g) => g.querySelector("h3")?.textContent)).toEqual(["Work", "Performance", "You"]);
    expect(within(sheet()).queryByRole("heading", { name: "Menu" })).toBeNull();
  });
});
