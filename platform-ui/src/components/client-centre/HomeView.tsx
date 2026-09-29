import Link from "next/link";
import {
  registry,
  activeDepts,
  businessTypeLabel,
  sectionHref,
  type CentreProfile,
} from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";

// CMC's Home: description lede, 4 overview facts, department cards with "N areas" — read-only (the
// description itself is edited on Business details, not here).
export function HomeView({ clientId, basePath, profile }: { clientId: string; basePath: string; profile: CentreProfile }) {
  const p = profile.profile;
  const depts = activeDepts(registry, profile.businessType, profile.departments);
  const website = p.website?.trim();
  const websiteLabel = website?.replace(/^https?:\/\//, "");
  const location = [p.city, p.country].filter(Boolean).join(", ") || "—";
  const contact = p.phone || p.email || "—";

  return (
    <div className="cc-content">
      <Breadcrumb items={[profile.clientName, "Home"]} />
      <div className="cc-head-row">
        <h1>{profile.clientName}</h1>
        <Link href={sectionHref(basePath, { kind: "company" })} className="lux-btn lux-btn--ghost lux-btn--sm">
          Business details
        </Link>
      </div>
      <p className="cc-lede">
        {p.description || "Add a description, location and contact details in Business details."}
      </p>

      <div className="cc-overview">
        <div className="cc-overview__item"><span>Business type</span><b>{businessTypeLabel(registry, profile.businessType)}</b></div>
        <div className="cc-overview__item"><span>Location</span><b>{location}</b></div>
        <div className="cc-overview__item">
          <span>Website</span>
          <b>{website ? <a href={website} target="_blank" rel="noopener">{websiteLabel}</a> : "—"}</b>
        </div>
        <div className="cc-overview__item"><span>Contact</span><b>{contact}</b></div>
      </div>

      <h2 className="cc-sec-h">Departments</h2>
      <div className="cc-dept-grid">
        {depts.map((d) => (
          <Link key={d.id} href={sectionHref(basePath, { kind: "section", sectionId: d.id, sub: "overview" })} className="cc-dept-card">
            {registry.icons[d.id] && (
              <span className="cc-dept-card__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: registry.icons[d.id] }} />
            )}
            <span>
              <b>{d.name}</b>
              <small>{d.pages.length} areas</small>
            </span>
          </Link>
        ))}
      </div>
      <p style={{ marginTop: 14, color: "var(--ink-subtle)", fontSize: 13.5 }}>
        Turn departments on or off for this business in Business details.
      </p>
    </div>
  );
}
