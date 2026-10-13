import Link from "next/link";
import {
  registry,
  sectionHref,
  sectionStats,
  cardsForSection,
  type BusinessResults,
  type CentreDraft,
  type ConnectionEntry,
  type RegistryArea,
  type RegistrySection,
  type SectionPart,
} from "@/lib/clientCentre";
import { Breadcrumb } from "./Breadcrumb";
import { SectionSetupView } from "./SectionSetupView";
import { SectionConnectionsView } from "./SectionConnectionsView";
import { ResultsView } from "./ResultsView";

/** The parts of an area page, in strip order. */
const PARTS: Array<{ part: SectionPart; label: string }> = [
  { part: "setup", label: "Setup" },
  { part: "connections", label: "Connections" },
  { part: "results", label: "Services & results" },
];

// One Business area (or sub-area) page: a header (name, icon, how much is set up), the part strip, and the part
// itself. Marketing's sub-areas are cards on its Setup part, BELOW the strip (so the strip is always first and
// never pushed down by 19 cards); its results part groups the sub-areas' services instead. The strip is real links — each part is its own URL — so a
// direct link, the back button and a bookmark all land on the right part.
export function AreaView({
  basePath,
  clientName,
  section,
  parent,
  part,
  draft,
  canEdit,
  isPortal,
  results,
  websiteHref,
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
  isPortal: boolean;
  /** Fetched by the page only when the results part is shown; `undefined` = not fetched, `null` = the read failed. */
  results?: BusinessResults | null;
  /** Portal website editors only: where a website card links. */
  websiteHref?: string | null;
  onFieldChange: (key: string, value: string) => void;
  onConnectionChange: (connId: string, patch: Partial<ConnectionEntry>) => void;
  onAddCustomConnection: (name: string) => void;
  onRemoveCustomConnection: (connId: string) => void;
}) {
  const crumbs = parent && parent.id !== section.id ? [clientName, parent.name, section.name] : [clientName, section.name];
  const stats = sectionStats(registry, draft.businessType, section, draft);
  const subAreas = parent && parent.id === section.id ? (parent.subAreas ?? []) : [];
  const icon = registry.icons[section.id];
  const owner = parent && parent.id === section.id ? parent : section;
  const running =
    results && results.visible ? cardsForSection(results, owner).filter((c) => c.status === "active").length : null;

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
        {running !== null && ` · ${running} ${running === 1 ? "service" : "services"} running`}
      </p>

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

      {part === "setup" && subAreas.length > 0 && (
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

      {part === "setup" ? (
        <SectionSetupView clientName={clientName} section={section} draft={draft} canEdit={canEdit} onFieldChange={onFieldChange} />
      ) : part === "results" ? (
        <ResultsView section={owner} results={results ?? null} showClientMarker={!isPortal} websiteHref={websiteHref} />
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
