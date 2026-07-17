import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import type { Prefs } from "@/lib/prefs";
import { DEFAULT_PREFS } from "@/lib/prefs";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import "./shell.css";

export function Shell({ me, tenantId, moduleLabel, prefs = DEFAULT_PREFS, children }: {
  me: Me; tenantId: string | null; moduleLabel: string; prefs?: Prefs; children: ReactNode;
}) {
  return (
    <div className="erp-app" data-density={prefs.density} data-width={prefs.width}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar me={me} tenantId={tenantId} />
      <TopBar me={me} tenantId={tenantId} moduleLabel={moduleLabel} />
      <main id="main-content" className="erp-main erp-scroll" tabIndex={-1}><div className="erp-main__inner">{children}</div></main>
    </div>
  );
}
