import type { Me } from "@/lib/platform";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
import { UserMenu } from "./UserMenu";
import { Eyebrow } from "@/components/ui";

export function Sidebar({ me }: { me: Me }) {
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <aside className="erp-side">
      <div className="erp-side__brand">
        <div className="erp-side__wordmark">GAIADA</div>
        <Eyebrow style={{ marginTop: 7, opacity: 0.55, display: "block" }}>ERP Suite</Eyebrow>
      </div>
      <nav className="erp-side__nav erp-scroll">
        {navFor(me).map((group) => (
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
