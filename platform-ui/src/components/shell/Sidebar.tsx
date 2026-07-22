import Link from "next/link";
import type { Me } from "@/lib/platform";
import type { MyPlacement } from "@/lib/departments";
import { toolkitFor, tabHref } from "@/lib/deptToolkits";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { NavDisclosure } from "./NavDisclosure";
import { UserMenu } from "./UserMenu";
import { CompanyContext } from "./CompanyContext";
import { Eyebrow } from "@/components/ui";

export function Sidebar({ me, tenantId, placement, departments = [] }: { me: Me; tenantId?: string | null; placement?: MyPlacement | null; departments?: { id: string; name: string }[] }) {
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
        {/* Department-first: a placed employee lands in — and works from — their own
            department console. Its toolkit tabs are the primary nav; the broader
            platform groups below appear only as the user's rank/capabilities allow
            (rank expands the sidebar). */}
        {placement && (
          <div>
            <Eyebrow style={{ padding: "6px 10px 8px", opacity: 0.4, fontSize: 10, display: "block" }}>My department</Eyebrow>
            {toolkitFor(placement.deptName).tabs.map((tab) => (
              <NavLink
                key={tab.key}
                item={{
                  label: tab.key === "overview" ? placement.deptName : tab.label,
                  href: tabHref(placement.deptId, tab),
                  icon: tab.icon,
                }}
              />
            ))}
            {placement.divisionName && (
              <div className="erp-side__division">{placement.divisionName} division</div>
            )}
          </div>
        )}
        {navFor(me, tenantId, departments).map((group) => (
          <div key={group.label || "settings"}>
            {group.label && <Eyebrow style={{ padding: "22px 10px 10px", opacity: 0.4, fontSize: 10, display: "block" }}>{group.label}</Eyebrow>}
            {group.items.map((item) => (
              item.children ? <NavDisclosure key={item.href} item={item} /> : <NavLink key={item.href} item={item} />
            ))}
          </div>
        ))}
      </nav>
      <UserMenu name={me.name} secondary={me.title ?? me.email} initials={initials} />
    </aside>
  );
}
