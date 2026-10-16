import { Suspense } from "react";
import type { Me } from "@/lib/platform";
import type { Theme } from "@/lib/prefs";
import { NavToggle } from "./NavToggle";
import { NotificationBell } from "./NotificationBell";
import { WorkspaceTopBarBell } from "./WorkspaceTopBarBell";
import { SpecialAccessChip } from "./SpecialAccessChip";
import { TopBarSearch } from "./TopBarSearch";
import { UserMenu } from "./UserMenu";
import { SimulatedFactorBadge } from "@/components/auth/SimulatedFactorBadge";
import "./workspace-topbar.css";

// DW-2c: the workspace shell's top bar (plan §2.5), the only top bar (DW-D38).
//
//   [☰ phone]  [ Search pages, people, records…  ⌘K ]        [chip] [🔔 3] [avatar]
//
// One search field, the bell with a pop-over, and one avatar menu that also holds the theme. The label,
// the date, the separate theme and palette buttons are gone, and the access strip is the chip.

export function WorkspaceTopBar({ me, tenantId, theme, special, unrestricted }: {
  me: Me; tenantId: string | null; theme: Theme; special: boolean; unrestricted: boolean;
}) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <header className="erp-top erp-top--ws">
      <NavToggle />
      <TopBarSearch />
      <div className="erp-top__actions">
        {special && <SpecialAccessChip unrestricted={unrestricted} />}
        {/* PV5-14 / PV-D40: only while a simulated second factor holds this sign-in (dev stage). */}
        {me.assuranceSource === "simulated" && me.assuranceExpiresAt && <SimulatedFactorBadge expiresAt={me.assuranceExpiresAt} />}
        {/* While the read is in flight the bell is drawn with no count (`unread={null}`, never a made-up 0) and its pop-over says it is loading. */}
        <Suspense fallback={<NotificationBell unread={null} items={[]} loading />}>
          <WorkspaceTopBarBell me={me} tenantId={tenantId} />
        </Suspense>
        <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} compact clientView={(me.clientOf ?? []).length > 0} theme={theme} />
      </div>
    </header>
  );
}
