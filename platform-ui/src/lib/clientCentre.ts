// Client Centre — types + pure, zero-I/O helpers. Client-safe (no "server-only", no I/O):
// imported by both server readers/actions and by client components that need the same shape
// math (section trees, "Shared · N", completion counts, the patch builder).
//
// CMC's layout and categorisation, carried over as native ERP pages (CC-D1), re-cut as BUSINESS AREAS
// by PV6-01: an area has a Setup part (its fields), a Connections part and, from PV6-03, Services &
// results. The registry this module reads (`clientCentreRegistry.json`, v2) is a byte-identical copy of
// platform-nest's `src/modules/clients/centre/registry.json` — see `clientCentre.test.ts`'s parity test —
// and is ALREADY title-cased, so nothing here re-implements CMC's `titleCase`.
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
/** A Business area or a sub-area: the unit that owns a Setup (fields) and a Connections part. */
export interface RegistrySection {
  id: string;
  name: string;
}
export interface RegistryArea extends RegistrySection {
  /** Only Marketing has sub-areas (its 19 sub-sections; ids unchanged from registry v1). */
  subAreas?: RegistrySection[];
}
export interface RegistrySectionSettings {
  fields: string[];
  connections: string[];
}
/** The business type's own area. Its id is always `ix`; its settings live here, not in `sectionSettings`. */
export interface RegistryIndustryArea extends RegistrySection {
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
  defaultOffAreas: Record<string, string[]>;
  generalFields: RegistryGeneralFieldGroup[];
  areas: RegistryArea[];
  industryModules: Record<string, RegistryIndustryArea>;
  sectionSettings: Record<string, RegistrySectionSettings>;
  icons: Record<string, string>;
}

// `registryJson` also carries a `_comment` key — not part of the typed shape and never read here.
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
  /** Business area on/off overrides (absent = the business type's default). The database column is still named `departments`. */
  areas: Record<string, boolean>;
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
  areas?: Record<string, boolean | null>;
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
  areas: Record<string, boolean>;
  customConnections: Record<string, CustomConnection[]>;
}

export function draftFromProfile(p: CentreProfile): CentreDraft {
  return {
    businessType: p.businessType,
    profile: { ...p.profile },
    connections: Object.fromEntries(Object.entries(p.connections).map(([k, v]) => [k, { ...v }])),
    areas: { ...p.areas },
    customConnections: Object.fromEntries(
      Object.entries(p.customConnections).map(([k, v]) => [k, v.map((c) => ({ ...c }))]),
    ),
  };
}

// ── Business areas ───────────────────────────────────────────────────────────────────────────────

/** The industry area (if this business type has one) followed by the fixed Business areas. */
export function allAreas(r: ClientCentreRegistry, businessType: string): RegistryArea[] {
  const ix = r.industryModules[businessType];
  return ix ? [{ id: ix.id, name: ix.name }, ...r.areas] : r.areas;
}

/** `areas[id]` present -> that boolean; absent -> on unless listed in `defaultOffAreas[businessType]`.
 *  Only a TOP-LEVEL area id is ever toggled — a sub-area (e.g. `mk_strat`) always follows its parent. */
export function areaEnabled(r: ClientCentreRegistry, businessType: string, overrides: Record<string, boolean>, areaId: string): boolean {
  if (areaId in overrides) return !!overrides[areaId];
  return !(r.defaultOffAreas[businessType] ?? []).includes(areaId);
}

export function activeAreas(r: ClientCentreRegistry, businessType: string, overrides: Record<string, boolean>): RegistryArea[] {
  return allAreas(r, businessType).filter((a) => areaEnabled(r, businessType, overrides, a.id));
}

export function findArea(r: ClientCentreRegistry, businessType: string, areaId: string): RegistryArea | undefined {
  return allAreas(r, businessType).find((a) => a.id === areaId);
}

/** Every section reachable for this business type: each area, and every sub-area nested one level inside
 *  it (the registry never nests deeper). Section ids are unique across the whole registry (a sub-area like
 *  `se` is not prefixed by its parent's id), so a section can always be found by id alone — the basis for
 *  the route model below. */
export function allSections(r: ClientCentreRegistry, businessType: string): RegistrySection[] {
  const out: RegistrySection[] = [];
  for (const a of allAreas(r, businessType)) {
    out.push({ id: a.id, name: a.name });
    for (const s of a.subAreas ?? []) out.push(s);
  }
  return out;
}

/** Find any section (area or sub-area) by id, anywhere in the tree for this business type. */
export function findSection(r: ClientCentreRegistry, businessType: string, sectionId: string): RegistrySection | undefined {
  return allSections(r, businessType).find((s) => s.id === sectionId);
}

/** The area that owns a section, for breadcrumbs (Marketing owning SEO). Returns the area itself when the
 *  section is already a top-level area. */
export function parentOf(r: ClientCentreRegistry, businessType: string, sectionId: string): RegistryArea | undefined {
  for (const a of allAreas(r, businessType)) {
    if (a.id === sectionId) return a;
    if ((a.subAreas ?? []).some((s) => s.id === sectionId)) return a;
  }
  return undefined;
}

/** A section's fields and connections. The industry area (`ix`) reads the business type's own
 *  `industryModules[bt].settings` (PV6-01 finding 2: before this it fell through to the empty default and
 *  showed "0 of 0"); every other section reads `sectionSettings[id]`. */
export function settingsDef(r: ClientCentreRegistry, businessType: string, section: RegistrySection): RegistrySectionSettings {
  if (section.id === "ix") return r.industryModules[businessType]?.settings ?? { fields: [], connections: [] };
  return r.sectionSettings[section.id] ?? { fields: [], connections: [] };
}

/** "Shared · N": which OTHER sections (by name) use this field/connection key, for this business
 *  type. `excludeSectionId` is the section currently being edited, excluded by id. */
export function usedBy(
  r: ClientCentreRegistry,
  businessType: string,
  kind: "fields" | "connections",
  key: string,
  excludeSectionId?: string,
): string[] {
  return allSections(r, businessType)
    .filter((s) => s.id !== excludeSectionId)
    .filter((s) => (settingsDef(r, businessType, s)[kind] || []).includes(key))
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

export interface SectionStats {
  fieldsFilled: number;
  fieldsTotal: number;
  connectionsConnected: number;
  connectionsTotal: number;
}

/** "N of M setup fields completed" and "N of M connections connected" for one area or sub-area. */
export function sectionStats(
  r: ClientCentreRegistry,
  businessType: string,
  section: RegistrySection,
  state: { profile: Record<string, string>; connections: Record<string, ConnectionEntry>; customConnections: Record<string, CustomConnection[]> },
): SectionStats {
  const def = settingsDef(r, businessType, section);
  const connIds = connectionIdsFor(section.id, def, state.customConnections);
  return {
    fieldsFilled: fieldsFilledCount(state.profile, def.fields),
    fieldsTotal: def.fields.length,
    connectionsConnected: connectionsConnectedCount(state.connections, connIds),
    connectionsTotal: connIds.length,
  };
}

// ── Route model ──────────────────────────────────────────────────────────────────────────────────
// The catch-all segment (`[[...section]]`) under `/clients/[clientId]/profile` (staff) and
// `/portal/company` (portal). Every section id is unique registry-wide (see `allSections` above),
// so the route never needs to encode a parent — `["se", "connections"]` finds SEO directly even
// though it nests under Marketing.
//
//   ``                       Home: the Business areas
//   `company`                Business details
//   `<areaId>`               the area's Setup (its fields)
//   `<areaId>/connections`   the area's Connections
//   `<areaId>/settings`      OLD, redirects to `<areaId>`           (see `legacySectionRedirect`)
//   `<areaId>/<n>`           OLD leaf page, redirects to `<areaId>`
//   `<areaId>/results`       Services & results (PV6-03)

/** The parts of an area page, in the order the strip shows them. */
export type SectionPart = "setup" | "connections" | "results";

export type SectionRoute =
  | { kind: "home" }
  | { kind: "company" }
  | { kind: "section"; sectionId: string; part: SectionPart };

const COMPANY_SEGMENT = "company";
const CONNECTIONS_SEGMENT = "connections";
const RESULTS_SEGMENT = "results";
const LEGACY_SETTINGS_SEGMENT = "settings";

export function parseSectionRoute(segments: string[] | undefined): SectionRoute {
  const segs = segments ?? [];
  if (segs.length === 0) return { kind: "home" };
  if (segs[0] === COMPANY_SEGMENT && segs.length === 1) return { kind: "company" };
  const [sectionId, second] = segs;
  if (segs.length === 1) return { kind: "section", sectionId, part: "setup" };
  if (second === CONNECTIONS_SEGMENT && segs.length === 2) return { kind: "section", sectionId, part: "connections" };
  if (second === RESULTS_SEGMENT && segs.length === 2) return { kind: "section", sectionId, part: "results" };
  return { kind: "home" };
}

export function sectionHref(base: string, route: SectionRoute): string {
  if (route.kind === "home") return base;
  if (route.kind === "company") return `${base}/${COMPANY_SEGMENT}`;
  if (route.part === "setup") return `${base}/${route.sectionId}`;
  if (route.part === "results") return `${base}/${route.sectionId}/${RESULTS_SEGMENT}`;
  return `${base}/${route.sectionId}/${CONNECTIONS_SEGMENT}`;
}

/** Where a pre-PV6-01 URL should land, or `null` when the URL is not an old one. `<areaId>/settings` and
 *  `<areaId>/<n>` (an old "Coming soon" leaf page) both go to the area's Setup. Bookmarks may still hold
 *  them; no notification or link in the app does. */
export function legacySectionRedirect(base: string, segments: string[] | undefined): string | null {
  const segs = segments ?? [];
  if (segs.length !== 2) return null;
  const [sectionId, second] = segs;
  const isLeaf = /^\d+$/.test(second);
  if (second === LEGACY_SETTINGS_SEGMENT || isLeaf) return sectionHref(base, { kind: "section", sectionId, part: "setup" });
  return null;
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
export function buildAreasPatch(before: Record<string, boolean>, after: Record<string, boolean>): Record<string, boolean | null> {
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
  const areas = buildAreasPatch(before.areas, after.areas);
  if (Object.keys(areas).length) patch.areas = areas;
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
    areas: { ...draft.areas },
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
  if (patch.areas) {
    for (const [k, v] of Object.entries(patch.areas)) {
      if (v === null) delete next.areas[k];
      else next.areas[k] = v;
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

// ── History labels (PV6-01 finding 4) ────────────────────────────────────────────────────────────
// The hub's History tab used to print the raw change path (`departments.rs`). A change path is
// `businessType`, `profile.<fieldKey>`, `connections.<connectionKey>`, `customConnections.<sectionId>` or
// `areas.<areaId>` (rows written before PV6-01 say `departments.<areaId>`).

/** The industry area's name is per business type; the History tab does not know the type, so it is named
 *  generically. */
const INDUSTRY_AREA_LABEL = "Industry area";

function sectionNameById(r: ClientCentreRegistry, id: string): string | null {
  if (id === "ix") return INDUSTRY_AREA_LABEL;
  for (const a of r.areas) {
    if (a.id === id) return a.name;
    const sub = a.subAreas?.find((x) => x.id === id);
    if (sub) return sub.name;
  }
  return null;
}

/** A human label for one change path. Unknown keys fall back to the key itself, never to nothing. */
export function centreChangeLabel(r: ClientCentreRegistry, path: string): string {
  if (path === "businessType") return "Business type";
  const dot = path.indexOf(".");
  if (dot < 0) return path;
  const head = path.slice(0, dot);
  const key = path.slice(dot + 1);
  if (head === "profile") return r.fields[key]?.label ?? key;
  if (head === "connections") return r.connections[key]?.name ?? "Custom connection";
  if (head === "customConnections") return `Custom connections, ${sectionNameById(r, key) ?? key}`;
  if (head === "areas" || head === "departments") return `Business area ${sectionNameById(r, key) ?? key}`;
  return path;
}

/** True for a change path whose value is an on/off toggle, so the History tab can say "on" and "off". */
export function isAreaTogglePath(path: string): boolean {
  return path.startsWith("areas.") || path.startsWith("departments.");
}

// ── Services & results (PV6-03) ──────────────────────────────────────────────────────────────────────
// The wire shape of `GET .../centre/results` (staff) and `GET .../portal/centre/:clientId/results`, mirrored from
// `platform-nest/src/modules/clients/centre/results/types.ts` (BFF §25). Unknown is `null`, never 0.

export type ServiceKey = "social" | "search" | "search_ads" | "analytics" | "website";

export interface ResultsKpi {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "percent" | "position" | "ratio";
  period: { from: string; to: string } | null;
  previous: number | null;
  target: number | null;
  asOf: string | null;
}

export interface ResultsServiceCard {
  service: ServiceKey;
  areaId: string;
  title: string;
  status: "active" | "paused" | "setting_up" | "ended";
  since: string | null;
  items: { label: string; detail: string | null }[];
  kpis: ResultsKpi[];
  clientVisible: true;
}

export interface BusinessResults {
  clientId: string;
  generatedAt: string;
  visible: boolean;
  services: ResultsServiceCard[];
  unavailable: ServiceKey[];
}

/** The cards that belong on a section's results part: its own, plus (for a top-level area) its sub-areas'. */
export function cardsForSection(results: BusinessResults, section: RegistryArea | RegistrySection): ResultsServiceCard[] {
  const ids = new Set<string>([section.id]);
  for (const s of (section as RegistryArea).subAreas ?? []) ids.add(s.id);
  return results.services.filter((c) => ids.has(c.areaId));
}

/** Services running (status "active") per top-level area id, from ONE results read. A card in a sub-area counts
 *  for the area that owns it. */
export function runningServicesByArea(r: ClientCentreRegistry, businessType: string, results: BusinessResults | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!results || !results.visible) return out;
  for (const c of results.services) {
    if (c.status !== "active") continue;
    const owner = parentOf(r, businessType, c.areaId);
    if (owner) out[owner.id] = (out[owner.id] ?? 0) + 1;
  }
  return out;
}

export type KpiChange =
  | { direction: "up" | "down" | "flat"; delta: number }
  | { direction: "none" };

/** The change against the previous period. `none` ("not enough data") when either figure is unknown: a missing
 *  `previous` is never read as 0, and an unmeasured `value` has no change to report. */
export function kpiChange(k: Pick<ResultsKpi, "value" | "previous">): KpiChange {
  if (k.value === null || k.previous === null) return { direction: "none" };
  const delta = k.value - k.previous;
  if (delta === 0) return { direction: "flat", delta: 0 };
  return { direction: delta > 0 ? "up" : "down", delta };
}

/** Whether a measured figure meets its target; null when there is no target or no figure. For "position" a lower
 *  figure is better (rank 3 beats rank 8). */
export function targetMet(k: Pick<ResultsKpi, "value" | "target" | "unit">): boolean | null {
  if (k.value === null || k.target === null) return null;
  return k.unit === "position" ? k.value <= k.target : k.value >= k.target;
}

// ── The portal Overview's results headline (PV7-03) ──────────────────────────────────────────────────

/** Figures that stay on the full Services & results page and never go into a headline: they are money-like (PV-D38). */
const HEADLINE_BANNED: ReadonlyArray<{ service: ServiceKey; key: string }> = [{ service: "search_ads", key: "conversion_value" }];

export interface ResultsHeadlineItem { service: ServiceKey; areaId: string; cardTitle: string; kpi: ResultsKpi }

/** Up to `max` headline numbers: the first KPI of each ACTIVE service card, in the payload's order. A card with no KPI
 *  (the website card) adds nothing, and a banned money-like figure is skipped in favour of the card's next one. An
 *  unmeasured KPI is kept (its value is `null`): the page says "Not measured yet", never 0. */
export function portalResultsHeadline(results: BusinessResults, max = 4): ResultsHeadlineItem[] {
  const out: ResultsHeadlineItem[] = [];
  for (const card of results.services) {
    if (out.length >= max) break;
    if (card.status !== "active") continue;
    const kpi = card.kpis.find((k) => !HEADLINE_BANNED.some((b) => b.service === card.service && b.key === k.key));
    if (kpi) out.push({ service: card.service, areaId: card.areaId, cardTitle: card.title, kpi });
  }
  return out;
}
