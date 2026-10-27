import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import type { SidebarAccount } from "./MorePanel";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { SidebarState } from "./sidebarState";
import { UserMenu } from "./UserMenu";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "@/lib/workspaceAccess";
import { me, member, node, person } from "@/lib/workspaceFixtures";
import { setSkinChoiceAction } from "@/lib/prefsActions";
import type { Me } from "@/lib/platform";

// SCP-Kd (DW-D51, plan §6.2): the Social skin's More panel.

const nav = vi.hoisted(() => ({ pathname: "/", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: nav.refresh }),
}));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}), setSkinChoiceAction: vi.fn(async () => {}) }));

const socialTree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);
const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const officer = me([member()]);

function modelFor(who: Me, over: { on?: ("standard" | "social")[]; approvals?: { pending: number } } = {}): ShellModel {
  return buildShellModel({
    me: who, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: who, tenantId: "co-a", root: socialTree }),
    skins: { on: over.on ?? ["standard", "social"] }, ...(over.approvals ? { approvals: over.approvals } : {}),
  });
}
const socialWs = (m: ShellModel) => m.workspaces.find((w) => w.key === "social-media")!;
const logout = vi.fn();
const account = (over: Partial<SidebarAccount> = {}): SidebarAccount => ({
  name: "Rina Vale", secondary: "Designer", initials: "RV", clientView: false, theme: "auto", logout, ...over,
});

function draw(model: ShellModel, props: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}, pathname = "/departments/d-soc") {
  nav.pathname = pathname;
  return render(
    <WorkspaceShellProvider model={model}>
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[{ label: "Task", href: "/tasks/new" }]} brand="Gaiada" account={account()} {...props} />
    </WorkspaceShellProvider>,
  );
}

const menu = () => screen.getByRole("navigation");
const moreButton = () => within(menu()).getByRole("button", { name: /^More/ });
const openMore = () => { fireEvent.click(moreButton()); return screen.getByRole("dialog", { name: "More" }); };
const field = () => screen.getByRole("searchbox", { name: "Find a page" });
const resultKeys = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLAnchorElement>("a[data-result]")).map((a) => a.dataset.result);

beforeEach(() => {
  // jsdom has no matchMedia, which the sidebar state and the rail tooltip read for the rail breakpoint (the rail is on while the panel is open).
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
  nav.refresh.mockClear();
  logout.mockClear();
  vi.mocked(setSkinChoiceAction).mockClear();
});
afterEach(() => document.documentElement.removeAttribute("data-sidebar"));

describe("the More panel: what it lists", () => {
  it("is a labelled, non-modal dialog that More controls", () => {
    draw(modelFor(officer));
    expect(moreButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = openMore();
    expect(moreButton()).toHaveAttribute("aria-expanded", "true");
    expect(moreButton()).toHaveAttribute("aria-controls", dialog.id);
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(within(dialog).getByRole("heading", { name: "More" })).toBeInTheDocument();
  });

  it("lists exactly the model's Work, Performance and You rows, in order, each linking to its first tab", () => {
    const model = modelFor(officer);
    draw(model);
    const dialog = openMore();
    for (const [label, rows] of [["Work", socialWs(model).rows.work], ["Performance", socialWs(model).rows.performance], ["You", socialWs(model).rows.you]] as const) {
      const group = within(dialog).getByRole("group", { name: label });
      expect(resultKeys(group)).toEqual(rows.map((r) => r.key));
      for (const row of rows) {
        const a = group.querySelector<HTMLAnchorElement>(`a[data-result="${row.key}"]`)!;
        expect(a).toHaveAttribute("href", row.tabs[0].href);
      }
    }
    // Nothing else but the workspace's own tabs (SCP-Kj): the Overview and the AI Assistant are pinned in the menu, not rows of the panel.
    expect(within(dialog).getAllByRole("group").map((g) => g.getAttribute("aria-labelledby") && g.querySelector("h3")?.textContent)).toEqual(["This workspace", "Work", "Performance", "You"]);
  });

  it("lists first 'This workspace': Notices and Department calendar, the Overview row's tabs no pin opens (SCP-Kj)", () => {
    draw(modelFor(officer));
    const group = within(openMore()).getByRole("group", { name: "This workspace" });
    expect(Array.from(group.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Notices", "/departments/d-soc/notices"], ["Department calendar", "/departments/d-soc/schedule"],
    ]);
  });

  it("marks the one that is the current page, and nothing when the page is Home (SCP-Kj)", () => {
    draw(modelFor(officer), {}, "/departments/d-soc/notices");
    const group = within(openMore()).getByRole("group", { name: "This workspace" });
    expect(within(group).getByRole("link", { name: "Notices" })).toHaveAttribute("aria-current", "page");
    expect(within(group).getByRole("link", { name: "Department calendar" })).not.toHaveAttribute("aria-current");
  });
});

describe("the More panel: the second line and the badge", () => {
  it("lists a row's tab labels as the grey second line only where the row holds several pages", () => {
    const model = modelFor(officer);
    draw(model);
    const dialog = openMore();
    const rows = [...socialWs(model).rows.work, ...socialWs(model).rows.performance, ...socialWs(model).rows.you];
    expect(rows.some((r) => r.tabs.length > 1)).toBe(true);
    expect(rows.some((r) => r.tabs.length === 1)).toBe(true);
    for (const row of rows) {
      const a = dialog.querySelector<HTMLAnchorElement>(`a[data-result="${row.key}"]`)!;
      const sub = a.querySelector(".ws-more__sub");
      if (row.tabs.length > 1) {
        expect(sub, row.key).toHaveTextContent(row.tabs.map((t) => t.label).join(", "));
        expect(a).toHaveAccessibleDescription(row.tabs.map((t) => t.label).join(", "));
      } else {
        expect(sub, row.key).toBeNull();
      }
    }
    // The design's own example: Project Management lists its pages.
    expect(dialog.querySelector('a[data-result="pm"] .ws-more__sub')).toHaveTextContent(/^Projects, Board/);
  });

  it("More wears the sum of the counts inside the panel, and each row keeps its own, with its accessible name", async () => {
    const decider = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
    const base = modelFor(decider, { approvals: { pending: 3 } });
    const ws = socialWs(base);
    // A second counted row, so the figure is a sum and not only Approvals.
    const model = { ...base, workspaces: base.workspaces.map((w) => (w === ws ? { ...w, rows: { ...w.rows, work: w.rows.work.map((r, i) => (i === 0 ? { ...r, count: 2 } : r)) } } : w)) };
    expect(ws.rows.you.find((r) => r.key === "approvals")?.count).toBe(3);
    await act(async () => { draw(model); });
    expect(within(moreButton()).getByRole("img", { name: "5 waiting for you" })).toHaveTextContent("5");
    const dialog = openMore();
    const approvals = within(dialog).getByRole("link", { name: /^Approvals/ });
    expect(within(approvals).getByRole("img", { name: "3 waiting for you" })).toBeInTheDocument();
    expect(approvals).toHaveAccessibleName("Approvals 3 waiting for you");
    expect(within(dialog).getAllByRole("img", { name: /waiting for you/ }).map((i) => i.getAttribute("aria-label")).sort()).toEqual(["2 waiting for you", "3 waiting for you"]);
  });

  it("draws no badge on More when nothing inside it has a count", () => {
    draw(modelFor(officer));
    expect(within(moreButton()).queryByRole("img")).toBeNull();
  });
});

describe("the More panel: Find a page", () => {
  const labelsOf = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll(".ws-more__row .ws-more__label")).map((e) => e.textContent);

  it("filters the rows by label as you type, case-insensitively", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    fireEvent.change(field(), { target: { value: "PROJECT" } });
    expect(labelsOf(dialog)).toContain("Project Management");
    expect(labelsOf(dialog)).not.toContain("My tasks");
  });

  it("shows a matching tab as its own result, linking to that tab, with its row as the grey line", () => {
    const model = modelFor(officer);
    draw(model);
    const dialog = openMore();
    fireEvent.change(field(), { target: { value: "timeline" } });
    const pm = socialWs(model).rows.work.find((r) => r.key === "pm")!;
    const tab = pm.tabs.find((t) => t.label === "Timeline")!;
    const hit = dialog.querySelector<HTMLAnchorElement>('a[data-result="pm/timeline"]')!;
    expect(hit).toHaveAttribute("href", tab.href);
    expect(hit.querySelector(".ws-more__label")).toHaveTextContent("Timeline");
    expect(hit.querySelector(".ws-more__sub")).toHaveTextContent(pm.label);
    // The row itself does not match "timeline", so it is not listed.
    expect(dialog.querySelector('a[data-result="pm"]')).toBeNull();
  });

  it("says so when nothing matches, and announces the count politely", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    const live = dialog.querySelector("[aria-live]")!;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    fireEvent.change(field(), { target: { value: "timeline" } });
    expect(live.textContent).toMatch(/^\d+ pages? found$/);
    fireEvent.change(field(), { target: { value: "zzz-no-such-page" } });
    expect(within(dialog).getByText(/No pages match “zzz-no-such-page”/)).toBeInTheDocument();
    expect(live).toHaveTextContent("No pages found");
    expect(dialog.querySelector("a[data-result]")).toBeNull();
    fireEvent.change(field(), { target: { value: "" } });
    expect(live).toHaveTextContent("");
    expect(within(dialog).queryByText(/No pages match/)).toBeNull();
  });

  it("Enter with no exact match opens the command palette with the typed text", () => {
    draw(modelFor(officer));
    openMore();
    const seen = vi.fn();
    window.addEventListener("gaiada:palette:open", seen);
    fireEvent.change(field(), { target: { value: "  invoices from may " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    window.removeEventListener("gaiada:palette:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ query: "invoices from may" });
  });

  it("Enter with an exact match opens that page instead, and does not open the palette", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    const palette = vi.fn();
    const clicked = vi.fn();
    const onClick = (e: Event) => { clicked((e.target as HTMLElement).closest("a")?.getAttribute("href")); e.preventDefault(); };
    window.addEventListener("gaiada:palette:open", palette);
    document.addEventListener("click", onClick);
    fireEvent.change(field(), { target: { value: "my tasks" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    window.removeEventListener("gaiada:palette:open", palette);
    document.removeEventListener("click", onClick);
    expect(palette).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledWith("/me/tasks");
    // Choosing a page closes the panel.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dialog).not.toBeInTheDocument();
  });

  it("Enter on an empty field does nothing", () => {
    draw(modelFor(officer));
    openMore();
    const palette = vi.fn();
    window.addEventListener("gaiada:palette:open", palette);
    fireEvent.keyDown(field(), { key: "Enter" });
    window.removeEventListener("gaiada:palette:open", palette);
    expect(palette).not.toHaveBeenCalled();
  });
});

describe("the More panel: the account", () => {
  it("carries the person, Switch workspace, Appearance, Account settings and Log out, in that order, after the rows", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    expect(dialog).toHaveTextContent("RV");
    expect(dialog).toHaveTextContent("Rina Vale");
    expect(dialog).toHaveTextContent("Designer");
    const order = Array.from(dialog.querySelectorAll<HTMLElement>("input, a, button")).map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim());
    const at = (re: RegExp) => order.findIndex((t) => re.test(t ?? ""));
    expect(order[0]).toBe("Find a page");
    expect(at(/^Switch workspace/)).toBeGreaterThan(at(/^Project Management/));
    expect(at(/^Light$/)).toBeGreaterThan(at(/^Switch workspace/));
    expect(at(/^Account settings$/)).toBeGreaterThan(at(/^Dark$/));
    expect(at(/^Log out$/)).toBeGreaterThan(at(/^Account settings$/));
    expect(order[order.length - 1]).toBe("Close More");
  });

  it("offers every item the avatar menu offers: theme, Account settings, Client view for a client contact, and the sign-out form", async () => {
    draw(modelFor(officer), { account: account({ clientView: true, theme: "dark" }) });
    const dialog = openMore();
    // The avatar menu's own items, for the same person.
    const { container } = render(<UserMenu name="Rina Vale" secondary="Designer" initials="RV" compact clientView theme="dark" />);
    fireEvent.click(container.querySelector(".erp-usermenu__trigger") as HTMLElement);
    const avatarMenu = screen.getByRole("menu", { name: "Account menu" });
    const hrefsOf = (root: HTMLElement) => Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href")).filter((h) => h === "/account" || h === "/portal").sort();
    expect(hrefsOf(dialog)).toEqual(hrefsOf(avatarMenu));
    expect(hrefsOf(dialog)).toEqual(["/account", "/portal"]);
    expect(within(avatarMenu).getAllByRole("menuitemradio").map((r) => r.getAttribute("aria-label"))).toEqual(["Match device", "Light", "Dark"]);
    const group = within(dialog).getByRole("radiogroup", { name: "Appearance" });
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Match device", "Light", "Dark"]);
    expect(within(group).getByRole("radio", { name: "Dark" })).toBeChecked();
    // Sign out: a form whose submit calls the server action.
    const out = within(dialog).getByRole("button", { name: "Log out" });
    expect(out.closest("form")).not.toBeNull();
    expect(out).toHaveAttribute("type", "submit");
    await act(async () => { fireEvent.click(out); });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("hides Client view for a person who is not a client contact", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    expect(within(dialog).queryByRole("link", { name: "Client view" })).toBeNull();
    expect(within(dialog).getByRole("link", { name: "Account settings" })).toHaveAttribute("href", "/account");
  });

  it("draws the person's account only when it is given (the rows and the switcher stay)", () => {
    draw(modelFor(officer), { account: null });
    const dialog = openMore();
    expect(within(dialog).queryByRole("button", { name: "Log out" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /^Switch workspace/ })).toBeInTheDocument();
  });

  it("Switch workspace opens the workspace switcher's own list, the person's workspaces then the departments", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    const sw = within(dialog).getByRole("button", { name: /^Switch workspace/ });
    expect(sw).toHaveTextContent("Social Media");
    expect(sw).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-expanded", "true");
    const mine = within(dialog).getByRole("list", { name: "Your workspaces" });
    expect(within(mine).getByRole("link", { name: /Social Media/ })).toHaveAttribute("aria-current", "true");
    expect(within(dialog).getByRole("list", { name: "Departments" })).toBeInTheDocument();
    // Escape closes the list first, and the panel stays.
    fireEvent.keyDown(sw, { key: "Escape" });
    expect(sw).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
  });

  it("every skin has exactly one workspace switcher: in the panel for Social, above the menu for Standard", () => {
    const { unmount } = draw(modelFor(officer));
    expect(screen.queryAllByRole("button", { name: /Switch workspace/ })).toHaveLength(0);
    openMore();
    expect(screen.getAllByRole("button", { name: /Switch workspace/ })).toHaveLength(1);
    unmount();
    draw(modelFor(officer, { on: ["standard"] }));
    expect(screen.getAllByRole("button", { name: /Switch workspace/ })).toHaveLength(1);
  });
});

describe("the More panel: the personal opt-out of the skin", () => {
  it("has a Standard look switch, off to begin with, that writes the choice through the action and refreshes", async () => {
    draw(modelFor(officer));
    const dialog = openMore();
    const sw = within(dialog).getByRole("switch", { name: "Standard look" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await act(async () => { fireEvent.click(sw); });
    expect(setSkinChoiceAction).toHaveBeenCalledWith("standard");
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});

describe("the More panel: keyboard and focus", () => {
  it("opening moves focus to Find a page", () => {
    draw(modelFor(officer));
    openMore();
    expect(field()).toHaveFocus();
  });

  it("Escape closes the panel and returns focus to More", () => {
    draw(modelFor(officer));
    openMore();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(moreButton()).toHaveFocus();
    expect(moreButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("a press outside closes it, while a press on More is More's own toggle", () => {
    draw(modelFor(officer));
    openMore();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    openMore();
    // The press on the button must not close it first (the click would then reopen it).
    fireEvent.mouseDown(moreButton());
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    fireEvent.click(moreButton());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a press inside the panel does not close it, and its close button does, returning focus", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    fireEvent.mouseDown(within(dialog).getByRole("heading", { name: "More" }));
    expect(screen.getByRole("dialog", { name: "More" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close More" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(moreButton()).toHaveFocus();
  });

  it("choosing a link closes the panel", () => {
    draw(modelFor(officer));
    const dialog = openMore();
    const onClick = (e: Event) => e.preventDefault();
    document.addEventListener("click", onClick);
    fireEvent.click(within(dialog).getByRole("link", { name: "Account settings" }));
    document.removeEventListener("click", onClick);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the menu's own entries stay reachable while the panel is open", () => {
    draw(modelFor(officer));
    openMore();
    for (const name of ["Home", "Notifications", "Tasks", "Calendar", "Reports", "Saved", "AI Assistant"]) {
      const link = within(menu().querySelector<HTMLElement>(".ws-pins")!).getByRole("link", { name });
      expect(link.closest("[aria-hidden='true']")).toBeNull();
      expect(link).not.toHaveAttribute("tabindex", "-1");
    }
    expect(within(menu()).getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(within(menu()).getByRole("button", { name: "Create" })).toBeInTheDocument();
  });
});

describe("the More panel: the icon rail", () => {
  it("opening switches the menu to the collapsed rail's flag, and closing takes it away", () => {
    draw(modelFor(officer));
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
    openMore();
    expect(document.documentElement).toHaveAttribute("data-sidebar", "collapsed");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
  });

  it("keeps the rail when the person had collapsed the menu themselves, and never writes their saved choice", () => {
    document.documentElement.setAttribute("data-sidebar", "collapsed");
    const before = document.cookie;
    nav.pathname = "/departments/d-soc";
    render(
      <SidebarState initial>
        <WorkspaceShellProvider model={modelFor(officer)}>
          <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[]} account={account()} />
        </WorkspaceShellProvider>
      </SidebarState>,
    );
    openMore();
    expect(document.documentElement).toHaveAttribute("data-sidebar", "collapsed");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.documentElement).toHaveAttribute("data-sidebar", "collapsed");
    expect(document.cookie).toBe(before);
  });

  it("is only the Social menu: the Standard sidebar has no More button and no panel", () => {
    draw(modelFor(officer, { on: ["standard"] }));
    expect(within(menu()).queryByRole("button", { name: /^More/ })).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-sidebar");
  });
});
