import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Shell } from "./Shell";
import { shellModel } from "./workspaceShellTestKit";
import { me, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

// DW-2c/2d: which frame the shell draws. The async server halves are stubs; what is under test is the
// choice Shell makes between the classic and the workspace parts.
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/prefs", () => ({ DEFAULT_PREFS: { density: "comfortable", width: "standard", theme: "auto", shell: "classic" } }));
vi.mock("@/lib/companyContext", async (orig) => ({ ...(await orig<typeof import("@/lib/companyContext")>()), activeCompany: () => null }));
vi.mock("@/lib/palette", () => ({ buildNavEntries: () => [], buildDeptEntries: () => [] }));
vi.mock("./nav", () => ({ navFor: () => [] }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside data-testid="classic-side" /> }));
vi.mock("./WorkspaceShellSidebar", () => ({ WorkspaceShellSidebar: () => <aside data-testid="ws-side" /> }));
vi.mock("./TopBar", () => ({ TopBar: () => <header data-testid="classic-top" /> }));
vi.mock("./WorkspaceTopBar", () => ({
  WorkspaceTopBar: (p: { special: boolean; unrestricted: boolean }) => <header data-testid="ws-top" data-special={String(p.special)} data-unrestricted={String(p.unrestricted)} />,
}));
vi.mock("./AssistantFab", () => ({ AssistantFab: () => <a data-testid="fab" id="asst-fab-trigger" href="/assistant">Assistant</a> }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => <div data-testid="palette" /> }));
vi.mock("./WorkspaceTabStrip", () => ({ WorkspaceTabStrip: () => <div data-testid="tabs" /> }));

const staff: Me = me([member()]);
// An unrestricted account: a global platform_admin grant.
const admin: Me = me([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]);

function draw(who: Me, workspace: boolean) {
  return render(
    <Shell me={who} tenantId="co-a" moduleLabel="Agency" workspaceModel={workspace ? shellModel : null}>
      <p>page</p>
    </Shell>,
  );
}

describe("Shell: classic", () => {
  it("draws the classic bar, the access strip and the floating assistant button, as before", () => {
    const { container } = draw(admin, false);
    expect(screen.getByTestId("classic-top")).toBeInTheDocument();
    expect(screen.queryByTestId("ws-top")).toBeNull();
    expect(container.querySelector(".erp-special")).not.toBeNull();
    expect(screen.getByTestId("fab")).toBeInTheDocument();
    expect(screen.getByTestId("classic-side")).toBeInTheDocument();
    expect(screen.queryByTestId("tabs")).toBeNull();
  });

  it("draws no strip for an ordinary person", () => {
    const { container } = draw(staff, false);
    expect(container.querySelector(".erp-special")).toBeNull();
    expect(screen.getByTestId("fab")).toBeInTheDocument();
  });
});

describe("Shell: workspace", () => {
  it("draws the workspace bar and no floating assistant button, so the sidebar row owns the id", () => {
    draw(staff, true);
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-special", "false");
    expect(screen.queryByTestId("classic-top")).toBeNull();
    expect(screen.queryByTestId("fab")).toBeNull();
    expect(document.querySelectorAll("#asst-fab-trigger")).toHaveLength(0);
    expect(screen.getByTestId("ws-side")).toBeInTheDocument();
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
    expect(screen.getByTestId("palette")).toBeInTheDocument();
  });

  it("moves the access notice from the strip into the bar's chip", () => {
    const { container } = draw(admin, true);
    expect(container.querySelector(".erp-special")).toBeNull();
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-special", "true");
    expect(screen.getByTestId("ws-top")).toHaveAttribute("data-unrestricted", "true");
  });
});
