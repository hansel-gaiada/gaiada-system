import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Shell } from "./Shell";
import { shellModel } from "./workspaceShellTestKit";
import { me, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

// The shell has one layout (DW-D38). The async server halves are stubs; what is under test is what Shell draws around the page.
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
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

function draw(who: Me) {
  return render(
    <Shell me={who} tenantId="co-a" workspaceModel={shellModel}>
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
