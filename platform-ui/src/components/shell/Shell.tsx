import type { ReactNode } from "react";
import type { Me } from "@/lib/platform";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import "./shell.css";

export function Shell({ me, tenantId, moduleLabel, children }: {
  me: Me; tenantId: string | null; moduleLabel: string; children: ReactNode;
}) {
  return (
    <div className="erp-app">
      <Sidebar me={me} />
      <TopBar me={me} tenantId={tenantId} moduleLabel={moduleLabel} />
      <main className="erp-main erp-scroll"><div className="erp-main__inner">{children}</div></main>
    </div>
  );
}
