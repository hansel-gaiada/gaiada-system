import Link from "next/link";
import type { Me } from "@/lib/platform";
import { getPrefs, getSidebarState } from "@/lib/prefs";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { NavGroupSection } from "./NavGroupSection";
import { UserMenu } from "./UserMenu";
import { CompanyContext } from "./CompanyContext";
import { SidebarToggle } from "./SidebarToggle";
import { SidebarState } from "./sidebarState";
import { Eyebrow } from "@/components/ui";

export async function Sidebar({ me, tenantId, departments = [] }: { me: Me; tenantId?: string | null; departments?: { id: string; name: string }[] }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const collapsed = (await getSidebarState()) === "collapsed";
  const { theme } = await getPrefs();
  return (
    <SidebarState initial={collapsed}>
      <aside className="erp-side" id="app-nav">
        <div className="erp-side__head">
          <Link href="/" className="erp-side__brand" aria-label="Home">
            <span className="erp-side__mark" aria-hidden="true">S</span>
            <div className="erp-side__wordmark">SYROWATKA</div>
            <Eyebrow className="erp-side__tagline">Operating Platform</Eyebrow>
          </Link>
          <SidebarToggle />
        </div>

        {/* Company scope lives in the sidebar; everything below is that company. */}
        <div className="erp-side__company">
          <CompanyContext me={me} tenantId={tenantId ?? null} />
        </div>

        <nav className="erp-side__nav erp-scroll">
          {navFor(me, tenantId, departments).map((group) =>
            group.label ? (
              <NavGroupSection key={group.label} group={group} />
            ) : (
              // The unlabelled group (Settings) is a single row — nothing to collapse.
              <div key="settings">
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} />
                ))}
              </div>
            ),
          )}
        </nav>
        <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} theme={theme} />
      </aside>
    </SidebarState>
  );
}
