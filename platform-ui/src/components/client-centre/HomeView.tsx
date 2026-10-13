import Link from "next/link";
import {
  registry,
  activeAreas,
  businessTypeLabel,
  sectionHref,
  sectionStats,
  runningServicesByArea,
  type BusinessResults,
  type CentreProfile,
} from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";

// Home: description lede, 4 overview facts, and one card per Business area with how much of it is set up —
// read-only (the description itself is edited on Business details, not here).
// `results` is the page's ONE results read (PV6-03): each card says how many services run in that area. Absent
// (not fetched, failed, or hidden from this contact) means no count at all, never "0 services".
export function HomeView({ basePath, profile, results }: { basePath: string; profile: CentreProfile; results?: BusinessResults | null }) {
  const p = profile.profile;
  const areas = activeAreas(registry, profile.businessType, profile.areas);
  const website = p.website?.trim();
  const websiteLabel = website?.replace(/^https?:\/\//, "");
  const location = [p.city, p.country].filter(Boolean).join(", ") || "—";
  const running = results && results.visible ? runningServicesByArea(registry, profile.businessType, results) : null;
  const contact = p.phone || p.email || "—";

  return (
    <div className="cc-content">
      <Breadcrumb items={[profile.clientName, "Home"]} />
      <div className="cc-head-row">
        <h2>{profile.clientName}</h2>
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

      <h2 className="cc-sec-h">Business areas</h2>
      <div className="cc-area-grid">
        {areas.map((a) => {
          const st = sectionStats(registry, profile.businessType, a, profile);
          return (
            <Link key={a.id} href={sectionHref(basePath, { kind: "section", sectionId: a.id, part: "setup" })} className="cc-area-card">
              {registry.icons[a.id] && (
                <span className="cc-area-card__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: registry.icons[a.id] }} />
              )}
              <span>
                <b>{a.name}</b>
                <small>{st.fieldsFilled} of {st.fieldsTotal} fields · {st.connectionsConnected} of {st.connectionsTotal} connected{running && ` · ${running[a.id] ?? 0} ${(running[a.id] ?? 0) === 1 ? "service" : "services"} running`}</small>
              </span>
            </Link>
          );
        })}
      </div>
      <p style={{ marginTop: 14, color: "var(--ink-subtle)", fontSize: 13.5 }}>
        Turn business areas on or off for this business in Business details.
      </p>
    </div>
  );
}
