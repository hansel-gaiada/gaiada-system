import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { ComponentProps, ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import { ShellNotificationsSettle, WorkspaceShellProvider } from "./WorkspaceShellContext";
import { inShell } from "./workspaceShellTestKit";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "@/lib/workspaceAccess";
import { lead, me, member, node, person } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

// SCP-Kc (DW-D51, plan §6.1, §6.2): the Social skin's pinned menu. The skin is switched on in the model here (`skins: { on: [...] }`), as the
// skin tests do; in the app Social stays off for everyone until SCP-Kg.

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
// Records the props every link was given: next/link consumes `prefetch` and renders nothing for it.
const linkCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("next/link", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("next/link")>()).default;
  return { default: (props: ComponentProps<typeof Real>) => { linkCalls.push(props as unknown as Record<string, unknown>); return <Real {...props} />; } };
});

const socialTree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);
const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const NEW_ITEMS = [{ label: "Task", href: "/tasks/new" }];

function socialModel(who: Me, over: { on?: ("standard" | "social")[]; approvals?: { pending: number } } = {}): ShellModel {
  return buildShellModel({
    me: who, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: who, tenantId: "co-a", root: socialTree }),
    skins: { on: over.on ?? ["standard", "social"] }, ...(over.approvals ? { approvals: over.approvals } : {}),
  });
}
const officer = me([member()]);
const head = me([member(), lead("d-soc")]);
const socialWs = (m: ShellModel) => m.workspaces.find((w) => w.key === "social-media")!;

function sidebar(model: ShellModel, extra?: ReactElement) {
  return (
    <WorkspaceShellProvider model={model}>
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={NEW_ITEMS} brand="Gaiada" />
      {extra}
    </WorkspaceShellProvider>
  );
}
function renderAt(model: ShellModel, pathname: string, extra?: ReactElement) {
  nav.pathname = pathname;
  return render(sidebar(model, extra));
}

const menu = () => screen.getByRole("navigation");
/** The menu's entries, links and buttons, in document order, by accessible name. */
const entries = () => Array.from(menu().querySelectorAll("a, button")).map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\d+\+?(waiting for you|unread)$/, "").trim());
/** A pinned entry (the first group), not a row of the same name inside More (the You block has its own Calendar). */
const link = (name: string | RegExp) => within(menu().querySelector<HTMLElement>(".ws-pins")!).getByRole("link", { name });
const moreButton = () => within(menu()).getByRole("button", { name: /^More/ });

beforeEach(() => {
  window.sessionStorage.clear();
  linkCalls.length = 0;
  nav.pathname = "/";
});

describe("the Social menu: which entries a person sees", () => {
  it("an officer sees Home, Search, Messages, Notifications, Tasks, Create, Calendar, Reports, Saved, Profile (SCP-1k), AI Assistant, then More", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    expect(entries()).toEqual(["Home", "Search", "Messages", "Notifications", "Tasks", "Create", "Calendar", "Reports", "Saved", "Profile", "AI Assistant", "More"]);
    expect(link("Profile")).toHaveAttribute("href", "/departments/d-soc/profile");
  });

  it("a head also sees Settings (SCP-1c); the Dashboard page stays hidden while ticketed", () => {
    renderAt(socialModel(head), "/departments/d-soc");
    expect(entries()).toEqual(["Home", "Search", "Messages", "Notifications", "Tasks", "Create", "Calendar", "Reports", "Saved", "Profile", "AI Assistant", "Settings", "More"]);
    expect(within(menu()).queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(link("Settings")).toHaveAttribute("href", "/departments/d-soc/settings");
  });

  it("the entries open the pages the person's rows already offer, and replace the groups", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    expect(link("Home")).toHaveAttribute("href", "/departments/d-soc");
    expect(link("Tasks")).toHaveAttribute("href", "/me/tasks");
    expect(link("Calendar")).toHaveAttribute("href", "/departments/d-soc/calendar");
    expect(link("Saved")).toHaveAttribute("href", "/departments/d-soc/assets");
    expect(link("Notifications")).toHaveAttribute("href", "/me/inbox");
    // SCP-5a: the Reports pin opens the Social reports tab (the row's first tab, Mine, until that tab existed).
    expect(link("Reports")).toHaveAttribute("href", "/departments/d-soc/social-reports");
    expect(within(menu()).queryByRole("group", { name: "Work" })).toBeNull();
    expect(within(menu()).queryByRole("group", { name: "You" })).toBeNull();
  });

  it("draws the brand as the group's name, and the one workspace switcher is in the More panel (MorePanel.test.tsx), not above the menu", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    expect(document.querySelector(".erp-side__wordmark")).toHaveTextContent("Gaiada");
    expect(screen.queryByRole("button", { name: /Switch workspace/ })).toBeNull();
  });

  it("is the Standard menu, exactly, when Social is not switched on", () => {
    renderAt(socialModel(officer, { on: ["standard"] }), "/departments/d-soc");
    expect(within(menu()).getByRole("group", { name: "Work" })).toBeInTheDocument();
    expect(within(menu()).getByRole("group", { name: "Performance" })).toBeInTheDocument();
    expect(within(menu()).getByRole("group", { name: "You" })).toBeInTheDocument();
    expect(within(menu()).queryByRole("button", { name: /^More/ })).toBeNull();
    expect(document.querySelector(".ws-pin")).toBeNull();
  });

  it("is the Standard menu for a person who chose Standard", () => {
    const m = buildShellModel({
      me: officer, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: officer, tenantId: "co-a", root: socialTree }),
      skins: { on: ["standard", "social"], choice: "standard" },
    });
    renderAt(m, "/departments/d-soc");
    expect(within(menu()).getByRole("group", { name: "Work" })).toBeInTheDocument();
    expect(within(menu()).queryByRole("button", { name: /^More/ })).toBeNull();
  });
});

describe("the Social menu: Search, Create and Notifications", () => {
  it("Search opens the command palette with the event the top bar's field uses", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    const seen = vi.fn();
    window.addEventListener("gaiada:palette:open", seen);
    fireEvent.click(within(menu()).getByRole("button", { name: "Search" }));
    window.removeEventListener("gaiada:palette:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toBeInstanceOf(CustomEvent);
  });

  it("Create opens the New menu: the workspace's own creates first, then the shell's items, each a link", () => {
    const model = socialModel(officer);
    const creates = socialWs(model).creates;
    expect(creates.length).toBeGreaterThan(0);
    renderAt(model, "/departments/d-soc");
    const create = within(menu()).getByRole("button", { name: "Create" });
    expect(create).toHaveAttribute("aria-haspopup", "menu");
    expect(create).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(create);
    expect(create).toHaveAttribute("aria-expanded", "true");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([...creates.map((c) => c.label), "Task"]);
    expect(items.map((i) => i.getAttribute("href"))).toEqual([...creates.map((c) => c.href), "/tasks/new"]);
  });

  it("Create closes on Escape, on an outside press and when an item is chosen", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    const create = within(menu()).getByRole("button", { name: "Create" });
    fireEvent.click(create);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(create);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(create);
    const first = within(screen.getByRole("menu")).getAllByRole("menuitem")[0];
    first.addEventListener("click", (e) => e.preventDefault()); // jsdom cannot navigate
    fireEvent.click(first);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("draws no Notifications badge while the count is unknown, and never a 0", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    expect(screen.queryByRole("img", { name: /unread/ })).toBeNull();
    expect(link("Notifications")).toHaveTextContent(/^Notifications$/);
  });

  it("shows the unread count the top bar's one read settled", async () => {
    await act(async () => { renderAt(socialModel(officer), "/departments/d-soc", <ShellNotificationsSettle unread={4} />); });
    expect(screen.getByRole("img", { name: "4 unread" })).toHaveTextContent("4");
    expect(link(/^Notifications/)).toContainElement(screen.getByRole("img", { name: "4 unread" }));
  });

  it("reads 99+ past 99, a settled 0 draws no badge, and a failed read (null) draws none", async () => {
    const model = socialModel(officer);
    const ui = (unread: number | null) => sidebar(model, <ShellNotificationsSettle unread={unread} />);
    nav.pathname = "/departments/d-soc";
    let out!: ReturnType<typeof render>;
    await act(async () => { out = render(ui(120)); });
    expect(screen.getByRole("img", { name: "120 unread" })).toHaveTextContent("99+");
    await act(async () => { out.rerender(ui(0)); });
    expect(screen.queryByRole("img", { name: /unread/ })).toBeNull();
    await act(async () => { out.rerender(ui(3)); });
    expect(screen.getByRole("img", { name: "3 unread" })).toBeInTheDocument();
    // The next read failed: the count is unknown again, not 0 and not the stale 3.
    await act(async () => { out.rerender(ui(null)); });
    expect(screen.queryByRole("img", { name: /unread/ })).toBeNull();
  });
});

describe("the Social menu: which entry is current", () => {
  const current = () => within(menu()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);

  it("lights Home on the Overview, and only Home, whatever the query", () => {
    renderAt(socialModel(head), "/departments/d-soc");
    expect(current()).toEqual(["Home"]);
  });

  it("lights the entry whose page is the deepest prefix of the path, a record below it included", () => {
    const { unmount } = renderAt(socialModel(head), "/departments/d-soc/calendar");
    expect(current()).toEqual(["Calendar"]);
    unmount();
    renderAt(socialModel(head), "/departments/d-soc/assets");
    expect(current()).toEqual(["Saved"]);
  });

  it("lights Reports on any tab of the Reports row", () => {
    renderAt(socialModel(head), "/reports/team");
    expect(current()).toEqual(["Reports"]);
  });

  it("lights Tasks on /me/tasks and Notifications on the inbox, the latter without opening More", () => {
    const { unmount } = renderAt(socialModel(officer), "/me/tasks");
    expect(current()).toEqual(["Tasks"]);
    unmount();
    renderAt(socialModel(officer), "/me/inbox");
    expect(current()).toEqual(["Notifications"]);
    expect(moreButton()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the Social menu: the AI Assistant entry", () => {
  const row = () => link("AI Assistant");

  it("opens today's assistant drawer over the page, with the button's id, and is not prefetched", () => {
    renderAt(socialModel(officer), "/departments/d-soc");
    expect(row()).toHaveAttribute("href", `/assistant?from=${encodeURIComponent("/departments/d-soc")}`);
    expect(row()).toHaveAttribute("id", "asst-fab-trigger");
    expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(1);
    const mine = linkCalls.filter((p) => p.id === "asst-fab-trigger");
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine) expect(p.prefetch).toBe(false);
    // No other entry is opted out of prefetching or takes the id.
    for (const p of linkCalls.filter((p) => p.id !== "asst-fab-trigger")) { expect(p.prefetch).toBeUndefined(); expect(p.id).toBeUndefined(); }
  });

  it("keeps the page context of a record it is opened from", () => {
    renderAt(socialModel(officer), "/tasks/t-4");
    expect(row()).toHaveAttribute("href", `/assistant?ctx=${encodeURIComponent("erp:task:t-4")}&from=${encodeURIComponent("/tasks/t-4")}`);
  });

  it("is simply the current entry on /assistant, linking to the page, and still the only one with the id", () => {
    renderAt(socialModel(officer), "/assistant");
    expect(row()).toHaveAttribute("href", "/assistant");
    expect(row()).toHaveAttribute("aria-current", "page");
    expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(1);
  });
});

describe("the Social menu: not drawn outside a department that wears the skin", () => {
  it("another department of the same company keeps the Standard menu", () => {
    renderAt(socialModel(officer), "/departments/d-web");
    // The last area decides on a page of no area; a Web Dev page names its own department.
    expect(within(menu()).queryByRole("button", { name: /^More/ })).toBeNull();
  });

  it("the Company area keeps the Standard menu", () => {
    renderAt(socialModel(me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }])), "/organization");
    expect(within(menu()).queryByRole("button", { name: /^More/ })).toBeNull();
    expect(inShell).toBeTypeOf("function");
  });
});
