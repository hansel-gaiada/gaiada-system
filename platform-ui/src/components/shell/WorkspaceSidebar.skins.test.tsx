import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceSidebar, type SidebarCompany } from "./WorkspaceSidebar";
import type { SidebarAccount } from "./MorePanel";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import type { ShellModel } from "@/lib/shellModel";
import { SKIN_PERSONAS, SKIN_RUNS, modelFor, type SkinsInput } from "@/lib/skinTestKit";

// SCP-Kf (plan §8): the sidebar's fixed items hold in BOTH skins, for every kind of person. The Standard-only suites (WorkspaceSidebar.test.tsx and
// its siblings) pin the Standard menu's shape and are unchanged; this file runs the items no skin may drop (the AI Assistant, the way to
// notifications, the one workspace switcher, Company and Admin, and the rule that a skin is drawn only for the workspace that wears it) through
// both skins, and then pins what the Social menu keeps: ⌘K (Search), notifications, the Assistant, and More with the switcher.

const nav = vi.hoisted(() => ({ pathname: "/departments/d-soc" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/tenant", () => ({ switchTenant: vi.fn() }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}), setSkinChoiceAction: vi.fn(async () => {}) }));
// Records the props every link was given: next/link consumes `prefetch` and renders nothing for it.
const linkCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("next/link", async (importOriginal) => {
  const Real = (await importOriginal<typeof import("next/link")>()).default;
  return { default: (props: ComponentProps<typeof Real>) => { linkCalls.push(props as unknown as Record<string, unknown>); return <Real {...props} />; } };
});

const COMPANY: SidebarCompany = { id: "co-a", name: "Agency" };
const ACCOUNT: SidebarAccount = { name: "Rina Vale", secondary: "Designer", initials: "RV", clientView: false, theme: "auto", logout: vi.fn() };

function draw(model: ShellModel, pathname = "/departments/d-soc") {
  nav.pathname = pathname;
  return render(
    <WorkspaceShellProvider model={model}>
      <WorkspaceSidebar tenantId="co-a" company={COMPANY} companies={[]} newItems={[{ label: "Task", href: "/tasks/new" }]} brand="Gaiada" account={ACCOUNT} />
    </WorkspaceShellProvider>,
  );
}
const aside = () => document.querySelector("aside")!;
const isSocial = (skins: SkinsInput) => !!skins;
/** Opens More where the skin has one, so what the menu keeps behind it can be reached. */
function openMoreIfAny() {
  const more = within(aside()).queryByRole("button", { name: /^More/ });
  if (more) fireEvent.click(more);
}

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
  window.sessionStorage.clear();
  document.documentElement.removeAttribute("data-sidebar");
  linkCalls.length = 0;
});

describe.each(SKIN_RUNS)("the sidebar's fixed items, in the $name", ({ skins }) => {
  describe.each(SKIN_PERSONAS)("$name", (persona) => {
    const model = () => modelFor(persona, skins);

    it("draws the skin only on the Social Media workspace", () => {
      draw(model());
      expect(aside().querySelector(".ws-pin") !== null).toBe(isSocial(skins));
    });

    it("keeps the AI Assistant: the drawer's href with the page it was opened from, the button's id, no prefetch, and one such id", () => {
      draw(model(), "/departments/d-soc/calendar");
      const row = within(aside()).getByRole("link", { name: "AI Assistant" });
      expect(row).toHaveAttribute("href", `/assistant?from=${encodeURIComponent("/departments/d-soc/calendar")}`);
      expect(row).toHaveAttribute("id", "asst-fab-trigger");
      expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(1);
      for (const p of linkCalls.filter((p) => p.id === "asst-fab-trigger")) expect(p.prefetch).toBe(false);
    });

    it("keeps a way to notifications: a link to the inbox", () => {
      draw(model());
      openMoreIfAny();
      expect(Array.from(aside().querySelectorAll("a")).some((a) => a.getAttribute("href") === "/me/inbox")).toBe(true);
    });

    it("has exactly one workspace switcher once everything the menu keeps is reachable, listing this person's workspaces", () => {
      draw(model());
      openMoreIfAny();
      const switchers = screen.getAllByRole("button", { name: /Switch workspace/ });
      expect(switchers).toHaveLength(1);
      fireEvent.click(switchers[0]);
      expect(screen.getByRole("list", { name: "Departments" })).toBeInTheDocument();
      // The workspace the person is on is marked in it.
      expect(document.querySelector('.ws-switch__item[aria-current="true"]')).toHaveTextContent("Social Media");
    });

    it("keeps the Company and Admin foot links for the person who has those areas", () => {
      const m = model();
      draw(m);
      const foot = aside().querySelector(".ws-side__foot")!;
      const hrefs = Array.from(foot.querySelectorAll("a")).map((a) => a.getAttribute("href"));
      expect(hrefs.includes(m.company[0]?.tabs[0]?.href ?? "/none")).toBe(m.company.length > 0);
      expect(hrefs.includes(m.admin[0]?.tabs[0]?.href ?? "/none")).toBe(m.admin.length > 0);
    });
  });
});

describe("the Social sidebar keeps what every skin keeps (DW-D51)", () => {
  const persona = SKIN_PERSONAS[0];
  const social = { on: ["standard", "social"] } as SkinsInput;

  it("keeps ⌘K: Search opens the command palette with the event the palette listens for", () => {
    draw(modelFor(persona, social));
    const seen = vi.fn();
    window.addEventListener("gaiada:palette:open", seen);
    fireEvent.click(within(aside()).getByRole("button", { name: "Search" }));
    window.removeEventListener("gaiada:palette:open", seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("keeps notifications, the AI Assistant, Create and More, and More carries the one switcher", () => {
    draw(modelFor(persona, social));
    const menu = within(aside()).getByRole("navigation");
    for (const name of ["Notifications", "AI Assistant"]) expect(within(menu).getByRole("link", { name })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /^More/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch workspace/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: /^More/ }));
    expect(within(screen.getByRole("dialog", { name: "More" })).getByRole("button", { name: /^Switch workspace/ })).toBeInTheDocument();
  });

  it("is drawn for the person who chose Standard exactly as the Standard skin is: no pinned menu, no More, the switcher above the menu", () => {
    const chose = modelFor(persona, { on: ["standard", "social"], choice: "standard" });
    const std = modelFor(persona, undefined);
    const a = draw(chose);
    // React's generated ids (useId) differ between two renders; everything else must be equal.
    const plain = (html: string) => html.replace(/(:|«|_)r_?[0-9a-z]+(:|»|_)/g, "ID");
    const chosenHtml = plain(a.container.innerHTML);
    a.unmount();
    const b = draw(std);
    const stdHtml = plain(b.container.innerHTML);
    expect(stdHtml).toBe(chosenHtml);
    expect(screen.getAllByRole("button", { name: /Switch workspace/ })).toHaveLength(1);
  });
});
