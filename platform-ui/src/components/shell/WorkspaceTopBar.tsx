import type { Me } from "@/lib/platform";
import type { Theme } from "@/lib/prefs";
import type { ShellLayout } from "@/lib/shellLayout";
import { listNotifications } from "@/lib/entities";
import { NavToggle } from "./NavToggle";
import { NotificationBell, type BellItem } from "./NotificationBell";
import { SpecialAccessChip } from "./SpecialAccessChip";
import { TopBarSearch } from "./TopBarSearch";
import { UserMenu } from "./UserMenu";
import { SimulatedFactorBadge } from "@/components/auth/SimulatedFactorBadge";
import "./workspace-topbar.css";

// DW-2c: the workspace shell's top bar (plan §2.5), drawn only for people on the pilot switch. The
// classic bar (TopBar.tsx) is untouched.
//
//   [☰ phone]  [ Search pages, people, records…  ⌘K ]        [chip] [🔔 3] [avatar]
//
// One search field, the bell with a pop-over, and one avatar menu that also holds the theme. The label,
// the date, the separate theme and palette buttons are gone, and the access strip is the chip.

/** How many notifications the bell's pop-over lists. */
const BELL_ITEMS = 5;

export async function WorkspaceTopBar({ me, tenantId, theme, shell, special, unrestricted }: {
  me: Me; tenantId: string | null; theme: Theme; shell?: ShellLayout; special: boolean; unrestricted: boolean;
}) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  // The same unread read the classic bell uses. That one turns a failure into 0; here a thrown read is
  // `null`, so the bell shows no count and says it could not load. (listNotifications itself already
  // turns a 403/404, a tenant without the feature, into an empty list.)
  let unread: { count: number; items: BellItem[] } | null = { count: 0, items: [] };
  if (tenantId) {
    try {
      const rows = await listNotifications(me.userId, tenantId, true);
      unread = {
        count: rows.length,
        items: [...rows]
          .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
          .slice(0, BELL_ITEMS)
          .map((n) => ({ id: n.id, title: n.payload?.title || n.type, createdAt: n.created_at })),
      };
    } catch {
      unread = null;
    }
  }

  return (
    <header className="erp-top erp-top--ws">
      <NavToggle />
      <TopBarSearch />
      <div className="erp-top__actions">
        {special && <SpecialAccessChip unrestricted={unrestricted} />}
        {/* PV5-14 / PV-D40: only while a simulated second factor holds this sign-in (dev stage). */}
        {me.assuranceSource === "simulated" && me.assuranceExpiresAt && <SimulatedFactorBadge expiresAt={me.assuranceExpiresAt} />}
        <NotificationBell unread={unread?.count ?? null} items={unread?.items ?? []} />
        <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} compact clientView={(me.clientOf ?? []).length > 0} shellLayout={shell} theme={theme} />
      </div>
    </header>
  );
}
