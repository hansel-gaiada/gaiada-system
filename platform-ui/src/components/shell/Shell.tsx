import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import type { Prefs } from "@/lib/prefs";
import { DEFAULT_PREFS } from "@/lib/prefs";
import { canViewAllCompanies, isUnrestricted } from "@/lib/rbac";
import { WorkspaceShellSidebar } from "./WorkspaceShellSidebar";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { ShellFrame } from "./ShellFrame";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { CommandPalette } from "./CommandPalette";
import { workspacePaletteEntries } from "@/lib/palette";
import { applyApprovals, applyRoutes, type ShellModel } from "@/lib/shellModel";
import "./shell.css";

// The department workspace shell: the ONLY layout of the staff app (DW-D38). The server resolves the person's workspaces into
// `workspaceModel` (`(app)/layout.tsx`); a model that cannot be built is a bug and reaches the error boundary, it never falls
// back to another sidebar.
export function Shell({ me, tenantId, prefs = DEFAULT_PREFS, workspaceModel, approvalsFeed, routesFeed, children }: {
  me: Me; tenantId: string | null; prefs?: Prefs; workspaceModel: ShellModel;
  /** The streamed pending-approvals read (`ShellApprovalsFeed` in a <Suspense>), drawn inside the provider so it can settle the model's
   *  Approvals row. Omitted when the model was built with a settled read. */
  approvalsFeed?: ReactNode;
  /** The streamed routes read (`ShellRoutesFeed` in a <Suspense>), for a company whose pack lacks the Requests row (DW-10e). Omitted otherwise. */
  routesFeed?: ReactNode;
  children: ReactNode;
}) {
  const special = canViewAllCompanies(me);

  // Command palette tiers 1+2 (§4.1/§4.2) — computed here, in the same request that renders the
  // sidebar, so typing in the palette costs zero network round-trips for anything but tier 3 (live
  // records, fetched client-side from CommandPalette itself). The builder is pure/client-safe.
  // The palette is static (no streamed count): it is built from the model as it stands while the approvals read is in flight, and keeps its own
  // explicit `/approvals` entry for everyone (`STATIC_PALETTE_ENTRIES`).
  const paletteEntries = workspacePaletteEntries(applyRoutes(applyApprovals(workspaceModel, "inflight"), "inflight"), me, tenantId);

  // The provider renders no DOM and sits OUTSIDE the frame: the frame (`.erp-app`) reads the workspace being drawn to wear its skin
  // (SCP-Ka, DW-D51), and `.erp-app`'s grid still sees the frame's parts as its direct children.
  return (
    <WorkspaceShellProvider model={workspaceModel}>
      <ShellFrame density={prefs.density} width={prefs.width}>
        <a href="#main-content" className="skip-link">Skip to content</a>
        {approvalsFeed}
        {routesFeed}
        <WorkspaceShellSidebar me={me} tenantId={tenantId} theme={prefs.theme} />
        {/* DW-2c: the workspace top bar shows the access notice as a chip, not as a strip above the page. */}
        <WorkspaceTopBar me={me} tenantId={tenantId} theme={prefs.theme} special={special} unrestricted={isUnrestricted(me)} />
        <main id="main-content" className="erp-main erp-scroll" tabIndex={-1}>
          <div className="erp-main__inner">
            {/* DW-2b: the one tab strip. */}
            <WorkspaceTabStrip />
            {children}
          </div>
        </main>
        {/* The assistant has no floating button: the sidebar's AI Assistant row opens the drawer (DW-2d). Command palette (§4):
            mounted once, renders nothing until opened (Cmd/Ctrl-K or the top bar's search field). */}
        <CommandPalette entries={paletteEntries} />
      </ShellFrame>
    </WorkspaceShellProvider>
  );
}
