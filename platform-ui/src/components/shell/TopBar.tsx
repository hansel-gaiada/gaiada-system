import type { Me } from "@/lib/platform";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";
import { TenantSwitcher } from "./TenantSwitcher";

// Search is display-only this task — global search wires up with the module pages.
export function TopBar({ me, tenantId, moduleLabel }: { me: Me; tenantId: string | null; moduleLabel: string }) {
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return (
    <header className="erp-top">
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
        <Eyebrow style={{ color: "var(--erp-accent)" }}>{moduleLabel}</Eyebrow>
        <span style={{ width: 0.5, height: 16, background: "rgba(26,25,22,.2)" }} />
        <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)", whiteSpace: "nowrap" }}>{dateLine}</span>
      </div>
      <label className="erp-top__search">
        <Icon name="search" size={18} />
        <input placeholder="Search records, people, approvals…" aria-label="Search" />
      </label>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 18 }}>
        {me.companies.length > 1 && (
          <TenantSwitcher companies={me.companies} current={tenantId} />
        )}
      </div>
    </header>
  );
}
