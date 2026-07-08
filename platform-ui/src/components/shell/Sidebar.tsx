import type { Me } from "@/lib/platform";
import { navFor } from "./nav";
import { NavLink } from "./NavLink";
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
      <div className="erp-side__user">
        <div className="erp-side__avatar">{initials}</div>
        <div style={{ minWidth: 0, lineHeight: 1.25 }}>
          <div style={{ font: "700 13px var(--font-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{me.name}</div>
          <div style={{ font: "400 11px var(--font-body)", color: "rgba(26,25,22,.55)" }}>{me.title ?? me.email}</div>
        </div>
      </div>
    </aside>
  );
}
