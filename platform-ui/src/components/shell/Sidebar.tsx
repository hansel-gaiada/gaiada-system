import Link from "next/link";
import type { Me } from "@/lib/platform";
import { getSidebarState } from "@/lib/prefs";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { NavGroupSection } from "./NavGroupSection";
import { NewMenu } from "./NewMenu";
import { Icon } from "./icons";
import { newMenuItems } from "./WorkspaceShellSidebar";
import { activeCompany, groupNameOf } from "@/lib/companyContext";
import { CompanyContext } from "./CompanyContext";
import { SidebarToggle } from "./SidebarToggle";
import { SidebarState } from "./sidebarState";
import { Eyebrow } from "@/components/ui";

export async function Sidebar({ me, tenantId, departments = [] }: { me: Me; tenantId?: string | null; departments?: { id: string; name: string }[] }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const collapsed = (await getSidebarState()) === "collapsed";
  const newItems = newMenuItems(me, tenantId);
  // PV-D13: the wordmark is the group's name, from data; the company's name when the person is outside the root.
  const brand = groupNameOf(me, tenantId) ?? activeCompany(me, tenantId)?.name ?? null;
  return (
    <SidebarState initial={collapsed}>
      <aside className="erp-side" id="app-nav">
        <div className="erp-side__head">
          <Link href="/" className="erp-side__brand" aria-label="Home">
            {/* The design's brand mark is a pulse glyph on the accent disc, not the
              letter S. `icons.tsx` has no "use client", so this stays a server
              component. */}
            <span className="erp-side__mark" aria-hidden="true"><Icon name="pulse" size={17} /></span>
            {brand ? <div className="erp-side__wordmark">{brand}</div> : null}
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
        <div className="erp-side__new">
          <NewMenu items={newItems} />
        </div>
      </aside>
    </SidebarState>
  );
}
