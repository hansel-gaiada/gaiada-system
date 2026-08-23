import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import type { Prefs } from "@/lib/prefs";
import { DEFAULT_PREFS } from "@/lib/prefs";
import { canViewAllCompanies, isUnrestricted } from "@/lib/rbac";
import { navFor } from "./nav";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SpecialAccessBanner } from "./SpecialAccessBanner";
import { AssistantFab } from "./AssistantFab";
import { CommandPalette } from "./CommandPalette";
import { buildNavEntries, buildDeptEntries } from "@/lib/palette";
import "./shell.css";

export function Shell({ me, tenantId, moduleLabel, prefs = DEFAULT_PREFS, departments = [], children }: {
  me: Me; tenantId: string | null; moduleLabel: string; prefs?: Prefs; departments?: { id: string; name: string }[]; children: ReactNode;
}) {
  const special = canViewAllCompanies(me);

  // Command palette tiers 1+2 (§4.1/§4.2) — computed here, in the same request that renders the
  // sidebar, so typing in the palette costs zero network round-trips for anything but tier 3 (live
  // records, fetched client-side from CommandPalette itself). Both builders are pure/client-safe.
  const paletteEntries = [...buildNavEntries(navFor(me, tenantId, departments)), ...buildDeptEntries(departments)];

  return (
    <div className="erp-app" data-density={prefs.density} data-width={prefs.width}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar me={me} tenantId={tenantId} departments={departments} />
      <TopBar me={me} tenantId={tenantId} moduleLabel={moduleLabel} theme={prefs.theme} />
      <main id="main-content" className="erp-main erp-scroll" tabIndex={-1}>
        {special && <SpecialAccessBanner unrestricted={isUnrestricted(me)} />}
        <div className="erp-main__inner">{children}</div>
      </main>
      {/* ASST-22 — reachable from every app page `Shell` renders, not just `/assistant` itself. */}
      <AssistantFab tenantId={tenantId} />
      {/* Command palette (§4) — additive, mounted once per shell render; renders nothing until
          opened (Cmd/Ctrl-K or the TopBar's visible trigger). */}
      <CommandPalette entries={paletteEntries} />
    </div>
  );
}
