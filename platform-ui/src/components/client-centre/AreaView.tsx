import Link from "next/link";
import {
  registry,
  sectionHref,
  sectionStats,
  type CentreDraft,
  type ConnectionEntry,
  type RegistryArea,
  type RegistrySection,
  type SectionPart,
} from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";
import { SectionSetupView } from "./SectionSetupView";
import { SectionConnectionsView } from "./SectionConnectionsView";

/** The parts of an area page, in strip order. PV6-03 adds Services & results as a third entry. */
const PARTS: Array<{ part: SectionPart; label: string }> = [
  { part: "setup", label: "Setup" },
  { part: "connections", label: "Connections" },
];

// One Business area (or sub-area) page: a header (name, icon, how much is set up), Marketing's sub-areas as
// cards, the part strip, and the part itself. The strip is real links — each part is its own URL — so a
// direct link, the back button and a bookmark all land on the right part.
export function AreaView({
  basePath,
  clientName,
  section,
  parent,
  part,
  draft,
  canEdit,
  onFieldChange,
  onConnectionChange,
  onAddCustomConnection,
  onRemoveCustomConnection,
}: {
  basePath: string;
  clientName: string;
  section: RegistrySection;
  /** The area that owns this section (the section itself when it is a top-level area). */
  parent: RegistryArea | undefined;
  part: SectionPart;
  draft: CentreDraft;
  canEdit: boolean;
  onFieldChange: (key: string, value: string) => void;
  onConnectionChange: (connId: string, patch: Partial<ConnectionEntry>) => void;
  onAddCustomConnection: (name: string) => void;
  onRemoveCustomConnection: (connId: string) => void;
}) {
  const crumbs = parent && parent.id !== section.id ? [clientName, parent.name, section.name] : [clientName, section.name];
  const stats = sectionStats(registry, draft.businessType, section, draft);
  const subAreas = parent && parent.id === section.id ? (parent.subAreas ?? []) : [];
  const icon = registry.icons[section.id];

  return (
    <div className="cc-content">
      <Breadcrumb items={crumbs} />
      <div className="cc-head-row">
        <h2 className="cc-area-title">
          {icon && <span className="cc-area-title__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />}
          {section.name}
        </h2>
      </div>
      <p className="cc-area-stats">
        {stats.fieldsFilled} of {stats.fieldsTotal} setup fields completed · {stats.connectionsConnected} of {stats.connectionsTotal} connections connected
      </p>

      {subAreas.length > 0 && (
        <div className="cc-area-grid cc-area-grid--sub">
          {subAreas.map((s) => {
            const st = sectionStats(registry, draft.businessType, s, draft);
            return (
              <Link key={s.id} href={sectionHref(basePath, { kind: "section", sectionId: s.id, part: "setup" })} className="cc-area-card">
                <span>
                  <b>{s.name}</b>
                  <small>{st.fieldsFilled} of {st.fieldsTotal} fields · {st.connectionsConnected} of {st.connectionsTotal} connected</small>
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <nav className="cc-parts" aria-label={`${section.name} parts`}>
        {PARTS.map((p) => (
          <Link
            key={p.part}
            href={sectionHref(basePath, { kind: "section", sectionId: section.id, part: p.part })}
            className="cc-part"
            aria-current={p.part === part ? "page" : undefined}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      {part === "setup" ? (
        <SectionSetupView clientName={clientName} section={section} draft={draft} canEdit={canEdit} onFieldChange={onFieldChange} />
      ) : (
        <SectionConnectionsView
          section={section}
          draft={draft}
          canEdit={canEdit}
          onConnectionChange={onConnectionChange}
          onAddCustomConnection={onAddCustomConnection}
          onRemoveCustomConnection={onRemoveCustomConnection}
        />
      )}
    </div>
  );
}
