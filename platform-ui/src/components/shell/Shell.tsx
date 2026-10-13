import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import type { Prefs } from "@/lib/prefs";
import { DEFAULT_PREFS } from "@/lib/prefs";
import { can, canViewAllCompanies, isUnrestricted } from "@/lib/rbac";
import { navFor } from "./nav";
import { Sidebar } from "./Sidebar";
import { WorkspaceShellSidebar } from "./WorkspaceShellSidebar";
import { WorkspaceShellProvider } from "./WorkspaceShellContext";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import { TopBar } from "./TopBar";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { SpecialAccessBanner } from "./SpecialAccessBanner";
import { AssistantFab } from "./AssistantFab";
import { CommandPalette } from "./CommandPalette";
import { activeCompany } from "@/lib/companyContext";
import { buildNavEntries, buildDeptEntries, workspacePaletteEntries } from "@/lib/palette";
import type { ShellModel } from "@/lib/shellModel";
import "./shell.css";

export function Shell({ me, tenantId, moduleLabel, prefs = DEFAULT_PREFS, departments = [], workspaceModel = null, children }: {
  me: Me; tenantId: string | null; moduleLabel: string; prefs?: Prefs; departments?: { id: string; name: string }[];
  /** DW-2a: present only on the pilot switch (`prefs.shell === "workspaces"`) when the model built. */
  workspaceModel?: ShellModel | null;
  children: ReactNode;
}) {
  const special = canViewAllCompanies(me);

  // Command palette tiers 1+2 (§4.1/§4.2) — computed here, in the same request that renders the
  // sidebar, so typing in the palette costs zero network round-trips for anything but tier 3 (live
  // records, fetched client-side from CommandPalette itself). Both builders are pure/client-safe.
  const todayEntries = [...buildNavEntries(navFor(me, tenantId, departments)), ...buildDeptEntries(departments, activeCompany(me, tenantId)?.vertical, (t) => !t.requires || can(me, t.requires, tenantId))];
  // DW-2e: the workspace shell builds them from the registry too (rule 3), with today's entries kept in the union.
  const paletteEntries = workspaceModel ? workspacePaletteEntries(workspaceModel, todayEntries) : todayEntries;

  // Everything below the skip link. In the workspace shell it sits inside the provider, which renders no
  // DOM, so `.erp-app`'s grid still sees these as its direct children.
  const frame = (
    <>
      {workspaceModel ? (
        <WorkspaceShellSidebar me={me} tenantId={tenantId} />
      ) : (
        <Sidebar me={me} tenantId={tenantId} departments={departments} />
      )}
      {/* DW-2c: the workspace shell has its own top bar, and shows the access notice as a chip in it
          instead of the strip below. */}
      {workspaceModel ? (
        <WorkspaceTopBar me={me} tenantId={tenantId} theme={prefs.theme} shell={prefs.shell} special={special} unrestricted={isUnrestricted(me)} />
      ) : (
        <TopBar me={me} tenantId={tenantId} moduleLabel={moduleLabel} theme={prefs.theme} shell={prefs.shell} />
      )}
      <main id="main-content" className="erp-main erp-scroll" tabIndex={-1}>
        {special && !workspaceModel && <SpecialAccessBanner unrestricted={isUnrestricted(me)} />}
        <div className="erp-main__inner">
          {/* DW-2b: the workspace shell's one tab strip; draws nothing in the classic shell. */}
          {workspaceModel && <WorkspaceTabStrip />}
          {children}
        </div>
      </main>
      {/* ASST-22 — reachable from every app page `Shell` renders, not just `/assistant` itself. The
          workspace shell has no button: its sidebar's AI Assistant row opens the same drawer (DW-2d). */}
      {!workspaceModel && <AssistantFab tenantId={tenantId} />}
      {/* Command palette (§4) — additive, mounted once per shell render; renders nothing until
          opened (Cmd/Ctrl-K or the top bar's visible trigger). */}
      <CommandPalette entries={paletteEntries} />
    </>
  );

  return (
    <div className="erp-app" data-density={prefs.density} data-width={prefs.width}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      {workspaceModel ? <WorkspaceShellProvider model={workspaceModel}>{frame}</WorkspaceShellProvider> : frame}
    </div>
  );
}
