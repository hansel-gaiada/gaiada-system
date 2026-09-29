import Link from "next/link";
import {
  registry,
  isSub,
  settingsDef,
  fieldsFilledCount,
  connectionIdsFor,
  connectionsConnectedCount,
  sectionHref,
  type CentreProfile,
  type RegistrySection,
} from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";

// CMC's section overview: stats + area cards. Read-only — the numbers come straight off the saved
// profile, never the in-flight draft, so a half-typed edit elsewhere never makes this page's counts
// flicker mid-keystroke.
export function SectionOverviewView({
  basePath,
  section,
  profile,
  crumbs,
}: {
  basePath: string;
  section: RegistrySection;
  profile: CentreProfile;
  crumbs: string[];
}) {
  const def = settingsDef(registry, section);
  const connIds = connectionIdsFor(section.id, def, profile.customConnections);
  const filled = fieldsFilledCount(profile.profile, def.fields);
  const connected = connectionsConnectedCount(profile.connections, connIds);
  const settingsHref = sectionHref(basePath, { kind: "section", sectionId: section.id, sub: "settings" });

  return (
    <div className="cc-content">
      <Breadcrumb items={crumbs} />
      <div className="cc-head-row">
        <h1>{section.name}</h1>
        <Link href={settingsHref} className="lux-btn lux-btn--ghost lux-btn--sm">Settings</Link>
      </div>
      <p className="cc-lede">
        Overview of {section.name.toLowerCase()} for {profile.clientName}. Each area below will show its status,
        owner and provider once it&apos;s set up.
      </p>
      <div className="cc-stats">
        <div className="cc-stat"><b>{section.pages.length}</b><span>areas</span></div>
        <div className="cc-stat"><b>{filled}<span className="cc-stat__of">/{def.fields.length}</span></b><span>setup fields completed</span></div>
        <div className="cc-stat"><b>{connected}<span className="cc-stat__of">/{connIds.length}</span></b><span>connections connected</span></div>
      </div>
      <div className="cc-dept-grid">
        {section.pages.map((p, i) => {
          const href = isSub(p)
            ? sectionHref(basePath, { kind: "section", sectionId: p.id, sub: "overview" })
            : sectionHref(basePath, { kind: "section", sectionId: section.id, sub: "page", pageIndex: i });
          return (
            <Link key={i} href={href} className="cc-dept-card">
              <span>
                <b>{p.name}</b>
                <small>{isSub(p) ? `${p.pages.length} areas` : "Not set up yet"}</small>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
