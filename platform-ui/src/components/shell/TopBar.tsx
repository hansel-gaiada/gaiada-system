import Link from "next/link";
import type { Me } from "@/lib/platform";
import { listNotifications } from "@/lib/entities";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";
import { NewMenu } from "./NewMenu";
import { NavToggle } from "./NavToggle";
import { CommandPaletteTrigger } from "./CommandPaletteTrigger";
import { can } from "@/lib/rbac";

export async function TopBar({ me, tenantId, moduleLabel }: { me: Me; tenantId: string | null; moduleLabel: string }) {
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  // Unread notification count for the bell badge — degrades to 0 if the feed
  // is unavailable (never blocks the shell).
  const unread = tenantId
    ? (await listNotifications(me.userId, tenantId, true).catch(() => [])).length
    : 0;

  // RBAC-gated global create menu.
  const newItems = [
    { label: "Project", href: "/projects/new" },
    { label: "Task", href: "/tasks/new" },
    { label: "Campaign", href: "/agency/new" },
    ...(can(me, "pm.manage", tenantId) ? [{ label: "Client", href: "/clients/new" }, { label: "Deliverable", href: "/deliverables/new" }] : []),
    ...(can(me, "company.manage", tenantId) ? [{ label: "Company", href: "/companies/new" }, { label: "Invoice", href: "/billing/new" }] : []),
    ...(can(me, "admin.access", tenantId) ? [{ label: "Employee", href: "/people/new" }] : []),
  ];

  return (
    <header className="erp-top">
      <NavToggle />
      <div className="erp-top__meta">
        <Eyebrow style={{ color: "var(--erp-accent)" }}>{moduleLabel}</Eyebrow>
        <span className="erp-top__divider" />
        <span className="erp-top__date">{dateLine}</span>
      </div>
      <form className="erp-top__search" action="/search" method="get" role="search">
        <Icon name="search" size={18} />
        <input name="q" placeholder="Search records, people, approvals…" aria-label="Search" defaultValue="" />
      </form>
      {/* Command palette (§4) — a visible, separate affordance next to the zero-JS search form
          above rather than replacing it (see CommandPaletteTrigger.tsx's header for why the spec's
          "subsumes" wording isn't implemented literally). Cmd/Ctrl-K opens it from anywhere. */}
      <CommandPaletteTrigger />
      <div className="erp-top__actions">
        <NewMenu items={newItems} />
        <Link href="/notifications" className="erp-top__bell" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Icon name="bell" size={19} />
          {unread > 0 && <span className="erp-top__badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
        </Link>
      </div>
    </header>
  );
}
