// Client Centre — registry section-tree helpers. BYTE-FOR-BYTE port of platform-ui's own
// `allDepts`/`allSections`/`settingsDef`/`connectionIdsFor` (src/lib/clientCentre.ts) — the staff
// list endpoint's `fieldsFilled`/`connectionsConnected` summaries must compute the identical numbers
// the frontend's own demo fixture (`demoClientCentre.ts:toListItem`) does, or the two surfaces would
// silently disagree about what "12 of 20 fields filled" means. See
// docs/plans/2026-09-29-client-centre.md for the registry shape this reads.
import registry from "./registry.json";

export interface RegistryPage {
  id?: string;
  name: string;
  pages?: RegistryPage[];
}
export interface RegistrySection {
  id: string;
  name: string;
  pages: RegistryPage[];
}
export interface RegistrySectionSettings {
  fields: string[];
  connections: string[];
}

export function isSub(p: RegistryPage): p is RegistrySection {
  return !!p && Array.isArray(p.pages);
}

/** The industry module (if this business type has one) followed by the fixed departments — same
 *  order CMC's own `allDepts` renders the nav in. */
export function allDepts(businessType: string): RegistrySection[] {
  const ix = (registry.industryModules as Record<string, RegistrySection>)[businessType];
  const departments = registry.departments as RegistrySection[];
  return ix ? [ix, ...departments] : departments;
}

/** Every section (department or sub-section) reachable for this business type, flattened one level
 *  deep — a department followed by its own sub-sections, if any. Unconditional: does NOT filter by
 *  `deptEnabled`/`defaultOffDepartments` — a toggled-off department's fields/connections still
 *  count toward "how complete is this profile", matching the frontend's own list-item computation. */
export function allSections(businessType: string): RegistrySection[] {
  const out: RegistrySection[] = [];
  for (const d of allDepts(businessType)) {
    out.push(d);
    for (const p of d.pages) if (isSub(p)) out.push(p);
  }
  return out;
}

export function settingsDef(section: RegistrySection): RegistrySectionSettings {
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
