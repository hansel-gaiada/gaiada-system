import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkinPhoneBar } from "./SkinPhoneBar";
import { SkinPhoneTop } from "./SkinPhoneTop";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import type { SidebarAccount } from "./MorePanel";
import { ShellApprovalsSettle, ShellNotificationsSettle, WorkspaceShellProvider } from "./WorkspaceShellContext";
import type { ShellModel } from "@/lib/shellModel";
import { SKIN_PERSONAS, modelFor, tabHrefsOf, type SkinPersona } from "@/lib/skinTestKit";
import { me, member } from "@/lib/workspaceFixtures";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { buildShellModel } from "@/lib/shellModel";
import { agencyWithSocial } from "@/lib/skinTestKit";

// SCP-Kf (plan §8): REACHABILITY across skins. "Nothing loses its home": every page the Standard menu links to, for the same person on the same
// page, is still linked from the Social skin, on a desktop (the pinned menu plus the More panel) and on a phone (the bottom bar, the top
// controls and the More sheet, since a phone has no menu column). These render the real components and read the real links.
//
//   S  the links of the Standard sidebar (its rows and its foot; the "Back to" context is navigation, not a menu entry)
//   D  the Social desktop's: the menu and the More panel's rows (its account items are the avatar menu's, not the sidebar's)
//   P  the Social phone's: the bar, the top controls and the sheet's rows
//
// Required: S is contained in D and in P (nothing lost), and what D and P add beyond S is only a deeper page of a row (Calendar, Saved) the
// workspace's own tabs already hold (nothing invented). The shell's items (Search, Create) are buttons, not links, so they are outside the sets.

const nav = vi.hoisted(() => ({ pathname: "/departments/d-soc" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}), setSkinChoiceAction: vi.fn(async () => {}) }));

const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const ACCOUNT: SidebarAccount = { name: "Rina Vale", secondary: "Designer", initials: "RV", clientView: false, theme: "auto", logout: vi.fn() };
const NEW_ITEMS = [{ label: "Task", href: "/tasks/new" }];

function tree(model: ShellModel) {
  return (
    <WorkspaceShellProvider model={model}>
      <SkinPhoneTop />
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={NEW_ITEMS} brand="Gaiada" account={ACCOUNT} />
      <SkinPhoneBar tenantId="co-a" newItems={NEW_ITEMS} company={COMPANY} companies={[]} account={ACCOUNT} />
    </WorkspaceShellProvider>
  );
}

// Not menu entries: the "Back to <home>" context link, and the brand mark's link to "/" (which only redirects to the home Overview or the Company area,
// both of which are menu entries themselves). The phone shows neither, as it shows no menu column.
const SKIPPED = ".ws-side__context, .erp-side__head";

const linksIn = (root: ParentNode, selector: string, skip = "") =>
  Array.from(root.querySelectorAll<HTMLAnchorElement>(`${selector} a[href]`))
    .filter((a) => !skip || !a.closest(skip))
    .map((a) => a.getAttribute("href")!);

/** The Standard sidebar's links for the person on this page. */
function standardLinks(p: SkinPersona, pathname: string): Set<string> {
  nav.pathname = pathname;
  const { container, unmount } = render(tree(modelFor(p, undefined)));
  const hrefs = new Set(linksIn(container, "aside", SKIPPED));
  unmount();
  return hrefs;
}

/** The Social desktop's links: the menu with More open, rows only. */
function socialDesktopLinks(p: SkinPersona, pathname: string): Set<string> {
  nav.pathname = pathname;
  const { container, unmount } = render(tree(modelFor(p, { on: ["standard", "social"] })));
  fireEvent.click(within(container.querySelector("aside")!).getByRole("button", { name: /^More/ }));
  const hrefs = new Set([...linksIn(container, "aside", `${SKIPPED}, .ws-more__foot`)]);
  unmount();
  return hrefs;
}

/** The Social phone's links: the bottom bar, the top controls and the sheet's rows (the sidebar is an off-canvas drawer there, never opened). */
function socialPhoneLinks(p: SkinPersona, pathname: string): Set<string> {
  nav.pathname = pathname;
  const { container, unmount } = render(tree(modelFor(p, { on: ["standard", "social"] })));
  fireEvent.click(container.querySelector<HTMLButtonElement>(".erp-top__phone button")!);
  const hrefs = new Set([
    ...linksIn(container, ".ws-bar"),
    ...linksIn(container, ".erp-top__phone"),
    ...linksIn(container, ".ws-more--sheet", ".ws-more__foot"),
  ]);
  unmount();
  return hrefs;
}

const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
});

// The Social Media workspace itself, and a page of another department (where the skin is not drawn at all).
const PAGES = ["/departments/d-soc", "/departments/d-soc/calendar", "/me/tasks"];

describe.each(SKIN_PERSONAS)("every page the Standard menu links to is still reachable in the Social skin: $name", (persona) => {
  describe.each(PAGES)("on %s", (pathname) => {
    const S = standardLinks(persona, pathname);
    const D = socialDesktopLinks(persona, pathname);
    const P = socialPhoneLinks(persona, pathname);
    const socialWs = modelFor(persona, { on: ["standard", "social"] }).workspaces.find((w) => w.key === "social-media")!;
    const own = new Set(tabHrefsOf(socialWs));

    it("has a Standard menu to compare with", () => {
      expect(S.size).toBeGreaterThan(10);
      expect(S.has("/departments/d-soc")).toBe(true);
    });

    it("loses nothing on a desktop: the pinned menu plus More link every page the Standard sidebar does", () => {
      expect(minus(S, D)).toEqual([]);
    });

    it("loses nothing on a phone: the bar, the top and the sheet link every page the Standard sidebar does", () => {
      expect(minus(S, P)).toEqual([]);
    });

    it("invents nothing: what the Social desktop and phone add are deeper pages of the workspace's own rows", () => {
      for (const extra of [...minus(D, S), ...minus(P, S)]) expect(own.has(extra), extra).toBe(true);
      // What it adds today: the Calendar tab and the Asset Library, which Standard reaches through the row's tab strip, and (SCP-Kj) the Overview row's Notices and
      // Department calendar, which the Social Home no longer has a strip for (More lists them first, "This workspace"), and (SCP-5a) Social reports, which the Reports pin now opens
      // and which Standard reaches through the shared Reports row's tab strip.
      expect(minus(D, S)).toEqual([`/departments/d-soc/assets`, `/departments/d-soc/calendar`, `/departments/d-soc/notices`, `/departments/d-soc/schedule`, `/departments/d-soc/social-reports`].filter((h) => !S.has(h)).sort());
    });
  });
});

describe("a phone reaches Company and Admin, which the Standard sidebar's foot links to", () => {
  const admin = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]);

  it("lists them in the sheet, each opening its area's first page", () => {
    nav.pathname = "/departments/d-soc";
    const model = buildShellModel({
      me: admin, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: admin, tenantId: "co-a", root: agencyWithSocial("social") }),
      skins: { on: ["standard", "social"] },
    });
    expect(model.company.length).toBeGreaterThan(0);
    render(tree(model));
    fireEvent.click(document.querySelector<HTMLButtonElement>(".erp-top__phone button")!);
    const sheet = screen.getByRole("dialog", { name: "More" });
    const group = within(sheet).getByRole("group", { name: "Company and Admin" });
    expect(within(group).getByRole("link", { name: "Company" })).toHaveAttribute("href", model.company[0].tabs[0].href);
    if (model.admin.length > 0) expect(within(group).getByRole("link", { name: "Admin" })).toHaveAttribute("href", model.admin[0].tabs[0].href);
  });
});

describe("the counts Standard draws are not lost in the Social skin", () => {
  const decider = me([member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
  const persona: SkinPersona = { name: "decider", who: decider, tenantId: "co-a", root: agencyWithSocial("social") };

  it("shows the Approvals count on its row in Standard, and on More (and on its row inside) in the Social skin", async () => {
    nav.pathname = "/departments/d-soc";
    const std = buildShellModel({ me: decider, tenantId: "co-a", approvals: { pending: 3 }, workspaces: resolveMyWorkspaces({ me: decider, tenantId: "co-a", root: persona.root }) });
    const soc = buildShellModel({ me: decider, tenantId: "co-a", approvals: { pending: 3 }, workspaces: resolveMyWorkspaces({ me: decider, tenantId: "co-a", root: persona.root }), skins: { on: ["standard", "social"] } });
    const a = render(tree(std));
    expect(screen.getByRole("img", { name: "3 waiting for you" })).toBeInTheDocument();
    a.unmount();
    render(tree(soc));
    const aside = document.querySelector("aside")!;
    expect(within(within(aside).getByRole("button", { name: /^More/ })).getByRole("img", { name: "3 waiting for you" })).toBeInTheDocument();
    fireEvent.click(within(aside).getByRole("button", { name: /^More/ }));
    expect(within(screen.getByRole("dialog", { name: "More" })).getByRole("link", { name: /^Approvals/ })).toHaveAccessibleName("Approvals 3 waiting for you");
  });

  it("a streamed count settles in the Social menu as it does in Standard, and the unread count reaches Notifications", async () => {
    nav.pathname = "/departments/d-soc";
    const inflight = buildShellModel({ me: decider, tenantId: "co-a", approvals: "inflight", workspaces: resolveMyWorkspaces({ me: decider, tenantId: "co-a", root: persona.root }), skins: { on: ["standard", "social"] } });
    await act(async () => {
      render(
        <WorkspaceShellProvider model={inflight}>
          <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[]} account={ACCOUNT} />
          <ShellApprovalsSettle read={{ pending: 2 }} />
          <ShellNotificationsSettle unread={5} />
        </WorkspaceShellProvider>,
      );
    });
    const aside = document.querySelector("aside")!;
    expect(within(within(aside).getByRole("button", { name: /^More/ })).getByRole("img", { name: "2 waiting for you" })).toBeInTheDocument();
    expect(within(aside).getByRole("img", { name: "5 unread" })).toBeInTheDocument();
  });
});
