// Client Centre — registry section-tree helpers. A port of platform-ui's own
// `allAreas`/`allSections`/`settingsDef`/`connectionIdsFor` (src/lib/clientCentre.ts) — the staff
// list endpoint's `fieldsFilled`/`connectionsConnected` summaries must compute the identical numbers
// the frontend's own demo fixture (`demoClientCentre.ts:toListItem`) does, or the two surfaces would
// silently disagree about what "12 of 20 fields filled" means. See
// docs/plans/2026-09-29-client-centre.md and docs/plans/2026-10-13-pv6-business-areas-tickets.md (PV6-01) for the registry shape this reads.
import registry from "./registry.json";

/** An area or a sub-area: the unit that owns a Setup (fields) and Connections part. */
export interface RegistrySection {
  id: string;
  name: string;
}
export interface RegistryArea extends RegistrySection {
  /** Only Marketing has sub-areas. */
  subAreas?: RegistrySection[];
}
export interface RegistrySectionSettings {
  fields: string[];
  connections: string[];
}
interface RegistryIndustryArea extends RegistrySection {
  settings: RegistrySectionSettings;
}

/** The industry area (if this business type has one) followed by the fixed business areas — same
 *  order the UI renders its tree in. The industry area's id is always `ix`. */
export function allAreas(businessType: string): RegistryArea[] {
  const ix = (registry.industryModules as unknown as Record<string, RegistryIndustryArea>)[businessType];
  const areas = registry.areas as RegistryArea[];
  return ix ? [{ id: ix.id, name: ix.name }, ...areas] : areas;
}

/** Every section (area or sub-area) reachable for this business type, flattened one level deep — an
 *  area followed by its own sub-areas, if any. Unconditional: does NOT filter by `areaEnabled` /
 *  `defaultOffAreas` — a toggled-off area's fields/connections still count toward "how complete is
 *  this profile", matching the frontend's own list-item computation. */
export function allSections(businessType: string): RegistrySection[] {
  const out: RegistrySection[] = [];
  for (const a of allAreas(businessType)) {
    out.push({ id: a.id, name: a.name });
    for (const s of a.subAreas ?? []) out.push(s);
  }
  return out;
}

/** A section's fields + connections. The industry area (`ix`) reads the business type's own
 *  `industryModules[bt].settings`; every other section reads `sectionSettings[id]`. (Before PV6-01 `ix`
 *  fell through to the empty default, so an industry area showed "0 of 0" and its settings were unreachable.) */
export function settingsDef(section: RegistrySection, businessType: string): RegistrySectionSettings {
  if (section.id === "ix") {
    return (registry.industryModules as unknown as Record<string, RegistryIndustryArea>)[businessType]?.settings ?? { fields: [], connections: [] };
  }
  return (registry.sectionSettings as Record<string, RegistrySectionSettings>)[section.id] ?? { fields: [], connections: [] };
}

/** A section's full connection list = its registry connections + any custom ones added for it. */
export function connectionIdsFor(
  sectionId: string,
  def: RegistrySectionSettings,
  customConnections: Record<string, Array<{ id: string; name: string }>>,
): string[] {
  return [...def.connections, ...((customConnections[sectionId] ?? []).map((c) => c.id))];
}

/** The Company settings page's own field keys — what `fieldsFilled` counts against (NOT all 149
 *  registry fields; matches platform-ui's `generalFieldKeys`). */
export const GENERAL_FIELD_KEYS: string[] = (registry.generalFields as Array<{ keys: string[] }>).flatMap((g) => g.keys);
