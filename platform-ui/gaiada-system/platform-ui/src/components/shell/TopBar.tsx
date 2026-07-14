import Link from "next/link";
import type { Me } from "@/lib/platform";
import { listNotifications } from "@/lib/entities";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";
import { TenantSwitcher } from "./TenantSwitcher";

export async function TopBar({ me, tenantId, moduleLabel }: { me: Me; tenantId: string | null; moduleLabel: string }) {
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  // Unread notification count for the bell badge — degrades to 0 if the feed
  // is unavailable (never blocks the shell).
  const unread = tenantId
    ? (await listNotifications(me.userId, tenantId, true).catch(() => [])).length
    : 0;

  return (
    <header className="erp-top">
      <div className="erp-top__meta">
        <Eyebrow style={{ color: "var(--erp-accent)" }}>{moduleLabel}</Eyebrow>
        <span className="erp-top__divider" />
        <span className="erp-top__date">{dateLine}</span>
      </div>
      <form className="erp-top__search" action="/search" method="get" role="search">
        <Icon name="search" size={18} />
        <input name="q" placeholder="Search records, people, approvals…" aria-label="Search" defaultValue="" />
      </form>
      <div className="erp-top__actions">
        <Link href="/notifications" className="erp-top__bell" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Icon name="bell" size={19} />
          {unread > 0 && <span className="erp-top__badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
        </Link>
        {me.companies.length > 1 && <TenantSwitcher companies={me.companies} current={tenantId} />}
      </div>
    </header>
  );
}
