import Link from "next/link";
import type { Me } from "@/lib/platform";
import type { Theme } from "@/lib/prefs";
import { listNotifications } from "@/lib/entities";
import { Icon } from "./icons";
import { Eyebrow } from "@/components/ui";
import { UserMenu } from "./UserMenu";
import { NavToggle } from "./NavToggle";
import { CommandPaletteTrigger } from "./CommandPaletteTrigger";
import { ThemeToggle } from "./ThemeToggle";

export async function TopBar({ me, tenantId, moduleLabel, theme }: { me: Me; tenantId: string | null; moduleLabel: string; theme: Theme }) {
  const dateLine = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  // Unread notification count for the bell badge — degrades to 0 if the feed
  // is unavailable (never blocks the shell).
  const unread = tenantId
    ? (await listNotifications(me.userId, tenantId, true).catch(() => [])).length
    : 0;

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
      <ThemeToggle theme={theme} />
      <div className="erp-top__actions">
        {/* The design puts the account control in the TOP BAR and the global
            create action at the SIDEBAR FLOOR — the reverse of where they
            used to sit. Both moved wholesale; neither lost an item. */}
        <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} compact />
        <Link href="/notifications" className="erp-top__bell" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Icon name="bell" size={19} />
          {unread > 0 && <span className="erp-top__badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
        </Link>
      </div>
    </header>
  );
}
