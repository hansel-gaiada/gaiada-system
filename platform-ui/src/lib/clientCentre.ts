// Client Centre — types + pure, zero-I/O helpers. Client-safe (no "server-only", no I/O):
// imported by both server readers/actions and by client components that need the same shape
// math (section trees, "Shared · N", completion counts, the patch builder).
//
// CMC's layout and categorisation, carried over as native ERP pages (CC-D1). The registry this
// module reads (`clientCentreRegistry.json`) is a byte-identical copy of platform-nest's
// `src/modules/clients/centre/registry.json` — see `clientCentre.test.ts`'s parity test — and is
// ALREADY title-cased by the extraction script (`scripts/cmc/extract-registry.cjs`), so nothing
// here re-implements CMC's `titleCase`/`titleCasePages`.
import registryJson from "./clientCentreRegistry.json";

// ── Registry shapes ──────────────────────────────────────────────────────────────────────────────

export interface RegistryField {
  label: string;
  type: "text" | "textarea" | "url" | "email" | "tel";
  group: string;
  help?: string;
}
export interface RegistryConnection {
  name: string;
  idLabel: string;
}
export interface RegistryBusinessType {
  id: string;
  label: string;
}
export interface RegistryGeneralFieldGroup {
  title: string;
  keys: string[];
}
/** A leaf page (a "Coming soon" placeholder) or a sub-section (has its own `pages` + settings). */
export interface RegistryPage {
  id?: string;
  name: string;
  pages?: RegistryPage[];
}
/** A department or a sub-section — both are "sections" once inside `pages`; both carry a settings
 *  definition. A department's `id` is always present; a sub-section is a `RegistryPage` with `id`
 *  and its own nested `pages`. */
export interface RegistrySection {
  id: string;
  name: string;
  pages: RegistryPage[];
}
export interface RegistrySectionSettings {
  fields: string[];
  connections: string[];
}
export interface RegistryIndustryModule extends RegistrySection {
  settings: RegistrySectionSettings;
}

export interface ClientCentreRegistry {
  version: number;
  fieldGroups: string[];
  fields: Record<string, RegistryField>;
  connections: Record<string, RegistryConnection>;
  connectionStatuses: string[];
  connectionMethods: string[];
  businessTypes: RegistryBusinessType[];
  defaultOffDepartments: Record<string, string[]>;
  generalFields: RegistryGeneralFieldGroup[];
  departments: RegistrySection[];
  industryModules: Record<string, RegistryIndustryModule>;
  sectionSettings: Record<string, RegistrySectionSettings>;
  icons: Record<string, string>;
}

// `registryJson` also carries a `_comment` key from the extraction script — not part of the typed
// shape and never read here.
export const registry = registryJson as unknown as ClientCentreRegistry;

export const CONN_STATUS_CONNECTED = "Connected";

// ── Profile / patch shapes (mirrors the plan's API contract exactly) ───────────────────────────────

export interface ConnectionEntry {
  tool?: string;
  account?: string;
  url?: string;
  owner?: string;
  creds?: string;
  method?: string;
  status?: string;
  notes?: string;
}
export interface CustomConnection {
  id: string;
  name: string;
}

export interface CentreProfile {
  clientId: string;
  clientName: string;
  clientStatus: string | null;
  businessType: string;
  profile: Record<string, string>;
  connections: Record<string, ConnectionEntry>;
  departments: Record<string, boolean>;
  customConnections: Record<string, CustomConnection[]>;
  revision: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
  canEdit: boolean;
}

export interface CentrePatch {
  businessType?: string;
  profile?: Record<string, string | null>;
  connections?: Record<string, Partial<ConnectionEntry> | null>;
  departments?: Record<string, boolean | null>;
  customConnections?: Record<string, CustomConnection[]>;
}

export interface CentreListItem {
  clientId: string;
  clientName: string;
  clientStatus: string | null;
  businessType: string;
  city: string | null;
  fieldsFilled: { filled: number; total: number };
  connectionsConnected: { connected: number; total: number };
  updatedAt: string | null;
}

export interface PortalCentreListItem {
  clientId: string;
  clientName: string;
  canEdit: boolean;
}

// ── Draft state the autosave loop diffs against (see `buildCentrePatch`) ────────────────────────────

export interface CentreDraft {
  businessType: string;
  profile: Record<string, string>;
  connections: Record<string, ConnectionEntry>;
  departments: Record<string, boolean>;
  customConnections: Record<string, CustomConnection[]>;
}

export function draftFromProfile(p: CentreProfile): CentreDraft {
  return {
    businessType: p.businessType,
    profile: { ...p.profile },
    connections: Object.fromEntries(Object.entries(p.connections).map(([k, v]) => [k, { ...v }])),
    departments: { ...p.departments },
    customConnections: Object.fromEntries(
      Object.entries(p.customConnections).map(([k, v]) => [k, v.map((c) => ({ ...c }))]),
    ),
  };
}

// ── Section tree ─────────────────────────────────────────────────────────────────────────────────

/** True for a `RegistryPage` that is itself a sub-section (has its own `pages`), as opposed to a
 *  leaf "Coming soon" page. Same test as CMC's `isSub`. */
export function isSub(p: RegistryPage): p is RegistrySection {
  return !!p && Array.isArray(p.pages);
}

/** The industry module (if this business type has one) followed by the fixed departments — the
 *  same order CMC's `allDepts` renders the nav in. */
export function allDepts(r: ClientCentreRegistry, businessType: string): RegistrySection[] {
  const ix = r.industryModules[businessType];
  return ix ? [ix, ...r.departments] : r.departments;
}

/** `departments[id]` present -> that boolean; absent -> on unless listed in
 *  `defaultOffDepartments[businessType]`. Only a TOP-LEVEL department id is ever toggled — a
 *  sub-section (e.g. `mk_strat`) always follows its parent's state, matching CMC. */
export function deptEnabled(r: ClientCentreRegistry, businessType: string, overrides: Record<string, boolean>, deptId: string): boolean {
  if (deptId in overrides) return !!overrides[deptId];
  return !(r.defaultOffDepartments[businessType] ?? []).includes(deptId);
}

export function activeDepts(r: ClientCentreRegistry, businessType: string, overrides: Record<string, boolean>): RegistrySection[] {
  return allDepts(r, businessType).filter((d) => deptEnabled(r, businessType, overrides, d.id));
}

export function findDept(r: ClientCentreRegistry, businessType: string, deptId: string): RegistrySection | undefined {
  return allDepts(r, businessType).find((d) => d.id === deptId);
}

/** Every section reachable for this business type: each department, and every sub-section nested
 *  one level inside it (registry nesting never goes deeper than that). Section ids are unique
 *  across the whole registry (a sub-section like `se` is not prefixed by its parent's id), so a
 *  section can always be found by id alone regardless of nesting — the basis for the route model
 *  below. */
export function allSections(r: ClientCentreRegistry, businessType: string): RegistrySection[] {
  const out: RegistrySection[] = [];
  for (const d of allDepts(r, businessType)) {
    out.push(d);
    for (const p of d.pages) if (isSub(p)) out.push(p);
  }
  return out;
}

/** Find any section (department or sub-section) by id, anywhere in the tree for this business type. */
export function findSection(r: ClientCentreRegistry, businessType: string, sectionId: string): RegistrySection | undefined {
  return allSections(r, businessType).find((s) => s.id === sectionId);
}

/** The department that owns a sub-section, for breadcrumbs (e.g. Marketing owning SEO). Returns
 *  the section itself if it is already a top-level department. */
export function parentOf(r: ClientCentreRegistry, businessType: string, sectionId: string): RegistrySection | undefined {
  for (const d of allDepts(r, businessType)) {
    if (d.id === sectionId) return d;
    if (d.pages.some((p) => isSub(p) && p.id === sectionId)) return d;
  }
  return undefined;
}

export function settingsDef(r: ClientCentreRegistry, section: RegistrySection): RegistrySectionSettings {
  return r.sectionSettings[section.id] ?? { fields: [], connections: [] };
}

/** The display name of a leaf page or sub-section inside a `pages` array. */
export function pageName(p: RegistryPage): string {
  return p.name;
}

/** "Shared · N": which OTHER sections (by name) use this field/connection key, for this business
 *  type. `excludeSectionId` is the section currently being edited, matching CMC's `usedBy(...)
 *  .filter(n => n !== currentDept.name)` — done by id here rather than by name, since two
 *  differently-named sections can never collide but the exclusion intent is identical. */
export function usedBy(
  r: ClientCentreRegistry,
  businessType: string,
  kind: "fields" | "connections",
  key: string,
  excludeSectionId?: string,
): string[] {
  return allSections(r, businessType)
    .filter((s) => s.id !== excludeSectionId)
    .filter((s) => (settingsDef(r, s)[kind] || []).includes(key))
    .map((s) => s.name);
}

/** Field keys grouped by `fieldGroups`' display order (skipping empty groups and unknown keys). */
export function groupedFields(r: ClientCentreRegistry, keys: string[]): Array<[string, string[]]> {
  const byGroup: Record<string, string[]> = {};
  for (const k of keys) {
    const def = r.fields[k];
    if (!def) continue;
    (byGroup[def.group] ??= []).push(k);
  }
  return r.fieldGroups.filter((g) => byGroup[g]?.length).map((g) => [g, byGroup[g]]);
}

// ── Completion counts ("N of M setup fields completed" / "N of M connections connected") ──────────

export function fieldsFilledCount(profile: Record<string, string>, fields: string[]): number {
  return fields.filter((k) => (profile[k] ?? "").trim().length > 0).length;
}

/** A section's full connection list = its registry connections + any custom ones added for it. */
export function connectionIdsFor(sectionId: string, def: RegistrySectionSettings, customConnections: Record<string, CustomConnection[]>): string[] {
  return [...def.connections, ...(customConnections[sectionId] ?? []).map((c) => c.id)];
}

export function connectionsConnectedCount(connections: Record<string, ConnectionEntry>, connectionIds: string[]): number {
  return connectionIds.filter((id) => connections[id]?.status === CONN_STATUS_CONNECTED).length;
}

// ── Route model ──────────────────────────────────────────────────────────────────────────────────
// The catch-all segment (`[[...section]]`) under `/clients/[clientId]/profile` (staff) and
// `/portal/company` (portal). Every section id is unique registry-wide (see `allSections` above),
// so the route never needs to encode a parent — `["se", "settings"]` finds SEO directly even
// though it nests under Marketing.

export type SectionRoute =
  | { kind: "home" }
  | { kind: "company" }
  | { kind: "section"; sectionId: string; sub: "overview" }
  | { kind: "section"; sectionId: string; sub: "settings" }
  | { kind: "section"; sectionId: string; sub: "page"; pageIndex: number };

const COMPANY_SEGMENT = "company";
const SETTINGS_SEGMENT = "settings";

export function parseSectionRoute(segments: string[] | undefined): SectionRoute {
  const segs = segments ?? [];
  if (segs.length === 0) return { kind: "home" };
  if (segs[0] === COMPANY_SEGMENT && segs.length === 1) return { kind: "company" };
  const [sectionId, second] = segs;
  if (segs.length === 1) return { kind: "section", sectionId, sub: "overview" };
  if (second === SETTINGS_SEGMENT && segs.length === 2) return { kind: "section", sectionId, sub: "settings" };
  const pageIndex = Number(second);
  if (segs.length === 2 && Number.isInteger(pageIndex) && pageIndex >= 0) {
    return { kind: "section", sectionId, sub: "page", pageIndex };
  }
  return { kind: "home" };
}

export function sectionHref(base: string, route: SectionRoute): string {
  if (route.kind === "home") return base;
  if (route.kind === "company") return `${base}/${COMPANY_SEGMENT}`;
  if (route.sub === "overview") return `${base}/${route.sectionId}`;
  if (route.sub === "settings") return `${base}/${route.sectionId}/${SETTINGS_SEGMENT}`;
  return `${base}/${route.sectionId}/${route.pageIndex}`;
}

// ── Patch builder ────────────────────────────────────────────────────────────────────────────────
// Emits ONLY changed keys; null/"" means delete. Used by the autosave loop (client) to compute what
// to send, and unit-testable in isolation from any component.

/** `null`/`""` are both "delete this key" on the wire (see the plan's `CentrePatch.profile`). */
function normalizeDeletable(v: string | undefined): string {
  return (v ?? "").trim() === (v ?? "") ? (v ?? "") : (v ?? "");
}

export function buildProfilePatch(before: Record<string, string>, after: Record<string, string>): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = normalizeDeletable(before[k]);
    const a = normalizeDeletable(after[k]);
    if (b === a) continue;
    patch[k] = a === "" ? null : a;
  }
  return patch;
}

const CONNECTION_SUBKEYS: Array<keyof ConnectionEntry> = ["tool", "account", "url", "owner", "creds", "method", "status", "notes"];

export function buildConnectionsPatch(
  before: Record<string, ConnectionEntry>,
  after: Record<string, ConnectionEntry>,
): Record<string, Partial<ConnectionEntry> | null> {
  const patch: Record<string, Partial<ConnectionEntry> | null> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    if (!a) {
      if (b) patch[k] = null;
      continue;
    }
    const sub: Partial<ConnectionEntry> = {};
    let changed = false;
    for (const sk of CONNECTION_SUBKEYS) {
      const bv = normalizeDeletable(b?.[sk]);
      const av = normalizeDeletable(a[sk]);
      if (bv === av) continue;
      changed = true;
      sub[sk] = av === "" ? (null as unknown as string) : av;
    }
    if (changed) patch[k] = sub;
  }
  return patch;
}

/** `overrides` maps hold ONLY explicit choices (a key present but absent from the map means "back
 *  to default"), so a key removed between before/after is a real, meaningful `null` — not noise. */
export function buildDepartmentsPatch(before: Record<string, boolean>, after: Record<string, boolean>): Record<string, boolean | null> {
  const patch: Record<string, boolean | null> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const hasBefore = k in before;
    const hasAfter = k in after;
    if (hasBefore && !hasAfter) { patch[k] = null; continue; }
    if (!hasAfter) continue;
    if (!hasBefore || before[k] !== after[k]) patch[k] = after[k];
  }
  return patch;
}

/** Custom connections REPLACE a section's whole list when it changed — no per-item diff, matching
 *  the plan's `CentrePatch.customConnections` semantics. */
export function buildCustomConnectionsPatch(
  before: Record<string, CustomConnection[]>,
  after: Record<string, CustomConnection[]>,
): Record<string, CustomConnection[]> {
  const patch: Record<string, CustomConnection[]> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = JSON.stringify(before[k] ?? []);
    const a = JSON.stringify(after[k] ?? []);
    if (b !== a) patch[k] = after[k] ?? [];
  }
  return patch;
}

/** The one function the autosave loop calls: diff two drafts into the minimal `CentrePatch`.
 *  Returns `null` when nothing changed (callers use this to skip an empty PATCH). */
export function buildCentrePatch(before: CentreDraft, after: CentreDraft): CentrePatch | null {
  const patch: CentrePatch = {};
  if (before.businessType !== after.businessType) patch.businessType = after.businessType;
  const profile = buildProfilePatch(before.profile, after.profile);
  if (Object.keys(profile).length) patch.profile = profile;
  const connections = buildConnectionsPatch(before.connections, after.connections);
  if (Object.keys(connections).length) patch.connections = connections;
  const departments = buildDepartmentsPatch(before.departments, after.departments);
  if (Object.keys(departments).length) patch.departments = departments;
  const customConnections = buildCustomConnectionsPatch(before.customConnections, after.customConnections);
  if (Object.keys(customConnections).length) patch.customConnections = customConnections;
  return Object.keys(patch).length ? patch : null;
}

/** Apply a patch onto a draft locally (optimistic update before the round trip returns) — the
 *  mirror image of `buildCentrePatch`, used so the autosave hook can merge a queued edit into its
 *  local "before" baseline once a PATCH succeeds. */
export function applyPatchToDraft(draft: CentreDraft, patch: CentrePatch): CentreDraft {
  const next: CentreDraft = {
    businessType: patch.businessType ?? draft.businessType,
    profile: { ...draft.profile },
    connections: Object.fromEntries(Object.entries(draft.connections).map(([k, v]) => [k, { ...v }])),
    departments: { ...draft.departments },
    customConnections: Object.fromEntries(Object.entries(draft.customConnections).map(([k, v]) => [k, [...v]])),
  };
  if (patch.profile) {
    for (const [k, v] of Object.entries(patch.profile)) {
      if (v === null || v === "") delete next.profile[k];
      else next.profile[k] = v;
    }
  }
  if (patch.connections) {
    for (const [k, v] of Object.entries(patch.connections)) {
      if (v === null) { delete next.connections[k]; continue; }
      const merged: ConnectionEntry = { ...(next.connections[k] ?? {}) };
      for (const sk of CONNECTION_SUBKEYS) {
        const sv = v[sk];
        if (sv === null || sv === "" ) delete merged[sk];
        else if (sv !== undefined) merged[sk] = sv;
      }
      next.connections[k] = merged;
    }
  }
  if (patch.departments) {
    for (const [k, v] of Object.entries(patch.departments)) {
      if (v === null) delete next.departments[k];
      else next.departments[k] = v;
    }
  }
  if (patch.customConnections) {
    for (const [k, v] of Object.entries(patch.customConnections)) next.customConnections[k] = v;
  }
  return next;
}

// ── Business type label ─────────────────────────────────────────────────────────────────────────

export function businessTypeLabel(r: ClientCentreRegistry, businessType: string): string {
  return r.businessTypes.find((t) => t.id === businessType)?.label ?? "Other";
}
