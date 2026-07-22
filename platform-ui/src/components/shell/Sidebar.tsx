import Link from "next/link";
import type { Me } from "@/lib/platform";
import type { MyPlacement } from "@/lib/departments";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { UserMenu } from "./UserMenu";
import { CompanyContext } from "./CompanyContext";
import { Eyebrow } from "@/components/ui";

export function Sidebar({ me, tenantId, placement }: { me: Me; tenantId?: string | null; placement?: MyPlacement | null }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <aside className="erp-side">
      <Link href="/" className="erp-side__brand" aria-label="Home">
        <div className="erp-side__wordmark">SYROWATKA</div>
        <Eyebrow style={{ marginTop: 7, opacity: 0.55, display: "block" }}>Operating Platform</Eyebrow>
      </Link>

      {/* Company scope lives in the sidebar; everything below is that company. */}
      <div className="erp-side__company">
        <CompanyContext me={me} tenantId={tenantId ?? null} />
      </div>

      <nav className="erp-side__nav erp-scroll">
        {placement && (
          <div>
            <Eyebrow style={{ padding: "6px 10px 8px", opacity: 0.4, fontSize: 10, display: "block" }}>My team</Eyebrow>
            <NavLink item={{ label: placement.deptName, href: `/departments/${placement.deptId}`, icon: "hr" }} />
            {placement.divisionName && (
              <div className="erp-side__division">{placement.divisionName} division</div>
            )}
          </div>
        )}
        {navFor(me, tenantId).map((group) => (
          <div key={group.label}>
            <Eyebrow style={{ padding: "22px 10px 10px", opacity: 0.4, fontSize: 10, display: "block" }}>{group.label}</Eyebrow>
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </div>
        ))}
      </nav>
      <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} />
    </aside>
  );
}
