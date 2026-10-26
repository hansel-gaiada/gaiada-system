import { render, screen } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Shell } from "./Shell";
import { shellModel } from "./workspaceShellTestKit";
import { me, member, node, person } from "@/lib/workspaceFixtures";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import type { Me } from "@/lib/platform";

// The shell has one layout (DW-D38). The async server halves are stubs; what is under test is what Shell draws around the page.
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/prefs", () => ({ DEFAULT_PREFS: { density: "comfortable", width: "standard", theme: "auto" } }));
vi.mock("@/lib/palette", () => ({ workspacePaletteEntries: () => [] }));
vi.mock("./WorkspaceShellSidebar", () => ({ WorkspaceShellSidebar: () => <aside data-testid="ws-side" /> }));
vi.mock("./WorkspaceTopBar", () => ({
  WorkspaceTopBar: (p: { special: boolean; unrestricted: boolean }) => <header data-testid="ws-top" data-special={String(p.special)} data-unrestricted={String(p.unrestricted)} />,
}));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => <div data-testid="palette" /> }));
vi.mock("./WorkspaceTabStrip", () => ({ WorkspaceTabStrip: () => <div data-testid="tabs" /> }));

const staff: Me = me([member()]);
// An unrestricted account: a global platform_admin grant.
const admin: Me = me([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]);

function draw(who: Me, model: ShellModel = shellModel) {
  return render(
    <Shell me={who} tenantId="co-a" workspaceModel={model}>
      <p>page</p>
    </Shell>,
  );
}

describe("Shell", () => {
  it("draws the workspace sidebar, bar, tab strip and palette around the page, and no floating assistant button", () => {
    draw(staff);
    expect(screen.getByTestId("ws-side")).toBeInTheDocument();
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-special", "false");
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
    expect(screen.getByTestId("palette")).toBeInTheDocument();
    expect(screen.getByText("page")).toBeInTheDocument();
    // The sidebar's AI Assistant row owns the id (AssistantDrawer returns focus to it); no second element carries it.
    expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(0);
  });

  it("keeps the skip link and the main landmark", () => {
    draw(staff);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(document.querySelector("main#main-content")).not.toBeNull();
  });

  it("shows the access notice in the bar's chip, never as a strip above the page", () => {
    const { container } = draw(admin);
    expect(container.querySelector(".erp-special")).toBeNull();
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-special", "true");
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-unrestricted", "true");
  });
});

// SCP-Ka (DW-D51): the skin seam. A Social Media employee in a company that also has Web Dev.
const socialTree = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);
const socialModel = (on: ("standard" | "social")[]) =>
  buildShellModel({ me: staff, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: staff, tenantId: "co-a", root: socialTree }), skins: { on } });

describe("Shell: skins", () => {
  afterEach(() => {
    nav.pathname = "/";
    document.documentElement.removeAttribute("data-skin");
  });

  it("draws the Standard frame exactly as before skins: the same attributes, the same parts in the same order, nothing on <html>", () => {
    const { container } = draw(staff);
    const frame = container.querySelector(".erp-app")!;
    expect(frame.parentElement).toBe(container);
    expect(frame.getAttributeNames().sort()).toEqual(["class", "data-density", "data-width"]);
    expect(frame.getAttribute("class")).toBe("erp-app");
    expect([...frame.children].map((c) => c.getAttribute("data-testid") ?? c.tagName.toLowerCase())).toEqual(["a", "ws-side", "ws-top", "main", "palette"]);
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });

  it("keeps Social Media Standard while the Social skin is off", () => {
    nav.pathname = "/departments/d-soc";
    const { container } = draw(staff, socialModel(["standard"]));
    expect(container.querySelector(".erp-app")!.hasAttribute("data-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });

  it("wears the Social skin in Social Media once it is on, on the frame and on <html> for overlays, and drops it on leaving", () => {
    nav.pathname = "/departments/d-soc";
    const { container, rerender, unmount } = draw(staff, socialModel(["standard", "social"]));
    expect(container.querySelector(".erp-app")).toHaveAttribute("data-skin", "social");
    expect(document.documentElement).toHaveAttribute("data-skin", "social");

    // Another department of the same model: Standard again.
    nav.pathname = "/departments/d-web";
    rerender(<Shell me={staff} tenantId="co-a" workspaceModel={socialModel(["standard", "social"])}><p>page</p></Shell>);
    expect(container.querySelector(".erp-app")!.hasAttribute("data-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);

    nav.pathname = "/departments/d-soc";
    rerender(<Shell me={staff} tenantId="co-a" workspaceModel={socialModel(["standard", "social"])}><p>page</p></Shell>);
    expect(document.documentElement).toHaveAttribute("data-skin", "social");
    unmount();
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
  });
});
