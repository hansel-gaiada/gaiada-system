import Link from "next/link";
import type { Me } from "@/lib/platform";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { UserMenu } from "./UserMenu";
import { CompanyContext } from "./CompanyContext";
import { Eyebrow } from "@/components/ui";

export function Sidebar({ me, tenantId, departments = [] }: { me: Me; tenantId?: string | null; departments?: { id: string; name: string }[] }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <aside className="erp-side" id="app-nav">
      <Link href="/" className="erp-side__brand" aria-label="Home">
        <div className="erp-side__wordmark">SYROWATKA</div>
        <Eyebrow className="erp-side__tagline">Operating Platform</Eyebrow>
      </Link>

      {/* Company scope lives in the sidebar; everything below is that company. */}
      <div className="erp-side__company">
        <CompanyContext me={me} tenantId={tenantId ?? null} />
      </div>

      <nav className="erp-side__nav erp-scroll">
        {navFor(me, tenantId, departments).map((group) => (
          <div key={group.label || "settings"}>
            {group.label && <Eyebrow className="erp-side__grouplabel">{group.label}</Eyebrow>}
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
