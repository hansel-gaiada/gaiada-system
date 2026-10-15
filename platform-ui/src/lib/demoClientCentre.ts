import "server-only";
// TEMP DEMO MODE — stateful in-memory store for the Client Centre (CC-D1), mirroring
// `demoPipeline.ts`'s convention. Wired from `demoFixtures.getDemoResponse`. Session-only, resets on
// restart. Safe to delete once the real backend (platform-nest `modules/clients/centre`) is live.
//
// Three demo companies, ALL obviously fictional (CC-D7: real CMC client profiles never enter this
// repo) — "Demo Harbour Hotel" is the plan's own example:
//   cl-1 (Northwind Traders)   — reuses the app's existing demo client so the portal identity
//                                 (`demo-client`/Dana Whitfield, a client-wide signer per
//                                 `demoPortal.ts`) has a Company tab to edit — CC-D4's "canEdit" path.
//   cl-2 (Cedar Group)         — an agency business type, seeded richer (more fields/connections)
//                                 for the staff list/section-overview screens.
//   cl-harbour (Demo Harbour Hotel) — NEW, hotel business type, so the industry module ("Hotel
//                                 Operations") and a Connected/Needs-attention/Not-connected spread
//                                 are all drivable. Also given to `demo-client` as a SECOND portal
//                                 client with canEdit=false, so the multi-client switcher AND the
//                                 read-only "ask your account manager" note are both demoable.
// cl-3 (Lumen Studio) is listed with NO row at all — the plan's "a missing row synthesises an empty
// profile" rule, exercised on the staff list (0/0 filled, never configured).
import type { BusinessResults, CentrePatch, CentreProfile, ConnectionEntry, CustomConnection, ResultsKpi, ResultsServiceCard } from "./clientCentre";
import {
  registry,
  allSections,
  settingsDef,
  fieldsFilledCount,
  connectionIdsFor,
  connectionsConnectedCount,
} from "./clientCentre";

interface DemoResult {
  status: number;
  json: unknown;
}
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

interface StoredCentre {
  businessType: string;
  profile: Record<string, string>;
  connections: Record<string, ConnectionEntry>;
  areas: Record<string, boolean>;
  customConnections: Record<string, CustomConnection[]>;
  revision: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
}

const CLIENT_META: Record<string, { name: string; status: string | null }> = {
  "cl-1": { name: "Northwind Traders", status: "active" },
  "cl-2": { name: "Cedar Group", status: "active" },
  "cl-3": { name: "Lumen Studio", status: "prospect" },
  "cl-harbour": { name: "Demo Harbour Hotel", status: "active" },
  // PV3-04: the demo's group client (see demoFixtures.ts CLIENTS) has a profile, so the list reads "Hotel".
  "cl-4": { name: "Viceroy", status: "active" },
};

const CALLER_NAME: Record<string, string> = {
  "demo-hansel": "Clement Hansel",
  "gede-ic": "Gede Kusuma",
  "demo-client": "Dana Whitfield",
};

function emptyCentre(): StoredCentre {
  return { businessType: "other", profile: {}, connections: {}, areas: {}, customConnections: {}, revision: 0, updatedAt: null, updatedBy: null };
}

const STORE: Record<string, StoredCentre> = {
  "cl-1": {
    businessType: "services",
    profile: {
      legal: "Northwind Traders Ltd", trading: "Northwind Traders", tagline: "Trading, the modern way",
      description: "A professional-services consultancy for mid-market importers, based in the Pacific Northwest.",
      industry: "Import/export consulting", founded: "2011", size: "25-50",
      website: "https://northwind.example", email: "ops@northwind.example", phone: "+1 555 0110",
      address: "1200 Market St", city: "Seattle", country: "United States", timezone: "America/Los_Angeles",
      currency: "USD", languages: "English",
    },
    connections: {
      ga4: { tool: "Google Analytics (GA4)", account: "GA4-NW-001", status: "Connected", method: "API", owner: "Dana Whitfield", creds: "1Password → Marketing vault" },
      xero: { tool: "Xero", account: "", status: "Not connected", method: "Manual" },
    },
    areas: {},
    customConnections: {},
    revision: 3,
    updatedAt: "2026-09-20T14:05:00Z",
    updatedBy: { id: "demo-client", name: "Dana Whitfield" },
  },
  "cl-2": {
    businessType: "agency",
    profile: {
      legal: "Cedar Group LLC", trading: "Cedar Group", tagline: "Growth, engineered",
      description: "A digital marketing agency running paid, SEO and lifecycle for D2C brands.",
      industry: "Digital marketing", founded: "2016", size: "10-25",
      website: "https://cedar.example", email: "hello@cedar.example", phone: "+1 555 0142",
      address: "88 Elm Ave", city: "Austin", country: "United States", timezone: "America/Chicago",
      currency: "USD", languages: "English, Spanish",
      logo: "https://cedar.example/logo.svg", color: "#2E6F5E",
    },
    connections: {
      gsc: { tool: "Google Search Console", account: "cedar.example", url: "https://cedar.example", status: "Connected", method: "API", owner: "SEO lead" },
      gtm: { tool: "Google Tag Manager", account: "GTM-CG42", status: "Needs attention", method: "Manual", notes: "Container needs the new consent-mode tags." },
      ga4: { status: "Not connected" },
      x1custom1: { tool: "Looker Studio dashboard", account: "cedar-reporting", status: "Connected", method: "Manual" },
    },
    areas: { hr: false },
    customConnections: { mk_analytics: [{ id: "x1custom1", name: "Looker Studio dashboard" }] },
    revision: 7,
    updatedAt: "2026-09-24T09:30:00Z",
    updatedBy: { id: "demo-hansel", name: "Clement Hansel" },
  },
  "cl-harbour": {
    businessType: "hotel",
    profile: {
      legal: "Demo Harbour Hotel Pte Ltd", trading: "Demo Harbour Hotel", tagline: "Where the tide meets the table",
      description: "A 42-room boutique waterfront hotel with an in-house restaurant and a small dive-shop concession.",
      industry: "Hospitality", founded: "2019", size: "50-100",
      website: "https://demoharbourhotel.example", email: "frontdesk@demoharbourhotel.example",
      phone: "+62 361 555 0199", address: "Jl. Pelabuhan 7", city: "Sanur", country: "Indonesia",
      timezone: "Asia/Makassar", currency: "IDR", languages: "Indonesian, English",
      rooms: "42", rating: "4.6", checkin: "14:00", adr: "1,450,000 IDR",
    },
    connections: {
      pms: { tool: "Cloudbeds", account: "harbour-42", status: "Connected", method: "API", owner: "Front office manager", creds: "1Password → Ops vault" },
      channel_mgr: { tool: "SiteMinder", account: "harbour-sm", status: "Needs attention", method: "Zapier / n8n", notes: "Airbnb feed dropped rates twice this month." },
      ota: { status: "Not connected" },
    },
    areas: {},
    customConnections: {},
    revision: 2,
    updatedAt: "2026-09-22T11:15:00Z",
    updatedBy: { id: "demo-hansel", name: "Clement Hansel" },
  },
};

// ── PV3-04 · the client write path's side of the profile row ─────────────────────────────────────────
// The real `POST /clients` writes the profile row (business type) in the same transaction, and `PATCH`
// upserts it. demoFixtures.ts calls these two so a demo client created or retyped shows up in the centre
// list and the Edit form exactly as it would live.

STORE["cl-4"] = {
  businessType: "hotel",
  profile: { legal: "Viceroy", trading: "Viceroy", industry: "Hospitality", city: "Ubud", country: "Indonesia", currency: "IDR", languages: "Indonesian, English" },
  connections: {}, areas: {}, customConnections: {},
  revision: 1, updatedAt: "2026-10-11T08:00:00Z", updatedBy: { id: "demo-hansel", name: "Clement Hansel" },
};

/** Is `id` one of the registry's business types? (the demo twin of the backend's `business_type_invalid`) */
export function demoIsBusinessType(id: unknown): id is string {
  return typeof id === "string" && registry.businessTypes.some((b) => b.id === id);
}

/** A client created in the demo gets its profile row now, with the chosen type (revision 1). */
export function demoCentreRegisterClient(clientId: string, name: string, status: string, businessType: string, byUserId: string): void {
  CLIENT_META[clientId] = { name, status };
  STORE[clientId] = { ...emptyCentre(), businessType, revision: 1, updatedAt: new Date().toISOString(), updatedBy: { id: byUserId, name: CALLER_NAME[byUserId] ?? null } };
}

/** What the type was before (`null` = no profile row, i.e. "not set"), and whether this call moved it.
 *  A same-type call writes nothing, as on the backend. */
export function demoCentreSetBusinessType(clientId: string, businessType: string, byUserId: string): { before: string | null; changed: boolean } {
  const existing = STORE[clientId];
  const before = existing && existing.revision > 0 ? existing.businessType : null;
  if (before === businessType) return { before, changed: false };
  const base = existing ?? emptyCentre();
  STORE[clientId] = { ...base, businessType, revision: base.revision + 1, updatedAt: new Date().toISOString(), updatedBy: { id: byUserId, name: CALLER_NAME[byUserId] ?? null } };
  return { before, changed: true };
}

function toListItem(clientId: string, s: StoredCentre) {
  const meta = CLIENT_META[clientId] ?? { name: clientId, status: null };
  const generalFieldKeys = registry.generalFields.flatMap((g) => g.keys);
  const sections = allSections(registry, s.businessType);
  let connIds = new Set<string>();
  let connTotal = 0;
  for (const sec of sections) {
    const def = settingsDef(registry, s.businessType, sec);
    for (const id of connectionIdsFor(sec.id, def, s.customConnections)) connIds.add(id);
  }
  connTotal = connIds.size;
  return {
    clientId,
    clientName: meta.name,
    clientStatus: meta.status,
    businessType: s.businessType,
    city: s.profile.city ?? null,
    fieldsFilled: { filled: fieldsFilledCount(s.profile, generalFieldKeys), total: generalFieldKeys.length },
    connectionsConnected: { connected: connectionsConnectedCount(s.connections, [...connIds]), total: connTotal },
    updatedAt: s.updatedAt,
  };
}

function toProfile(clientId: string, s: StoredCentre, canEdit: boolean): CentreProfile {
  const meta = CLIENT_META[clientId] ?? { name: clientId, status: null };
  return {
    clientId,
    clientName: meta.name,
    clientStatus: meta.status,
    businessType: s.businessType,
    profile: { ...s.profile },
    connections: s.connections,
    areas: s.areas,
    customConnections: s.customConnections,
    revision: s.revision,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    canEdit,
  };
}

// ── CMC-SEC-1 follow-up 3: refuse a credential-shaped VALUE, not just a suspicious key ─────────────
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{10,}\b/,
  /\bgh[po]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(password|pwd)\s*[:=]\s*\S+/i,
];
function looksLikeSecret(v: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(v));
}

const KNOWN_FIELD_KEYS = new Set(Object.keys(registry.fields));
const KNOWN_CONNECTION_KEYS = new Set(Object.keys(registry.connections));
const KNOWN_AREA_IDS = new Set([
  ...registry.areas.map((d) => d.id),
  "ix",
]);
const KNOWN_TOP_KEYS = new Set(["businessType", "profile", "connections", "areas", "customConnections"]);
const CONNECTION_SUBKEYS = new Set(["tool", "account", "url", "owner", "creds", "method", "status", "notes"]);
const VALID_CONNECTION_METHODS = new Set(registry.connectionMethods);
const VALID_CONNECTION_STATUSES = new Set(registry.connectionStatuses);
const VALID_SECTION_IDS = new Set([...Object.keys(registry.sectionSettings), "ix"]);

/** Every custom id ALREADY in `customConnections` before this patch applies — mirrors the real
 *  `validation.ts::existingCustomIds`. A `connections.<id>` edit is only valid for an id that is
 *  either a registry key or one already created — a patch cannot create-and-edit the same custom
 *  connection in one request (see `useCentreAutosave.ts`'s "immediate" flush, which exists so the
 *  UI never tries to). */
function existingCustomIds(s: StoredCentre): Set<string> {
  const ids = new Set<string>();
  for (const list of Object.values(s.customConnections)) for (const item of list) ids.add(item.id);
  return ids;
}

/** Mirrors the shared validation function both real PATCH routes call
 *  (`platform-nest/src/modules/clients/centre/validation.ts::applyCentrePatch`): unknown keys
 *  refused with 400 naming the field, values capped at 5,000 chars, every value scanned for a
 *  credential shape, `method`/`status` checked against the registry's own value lists, and a
 *  `connections` key must be a registry connection or an ALREADY-existing custom id (checked
 *  against `current`, not this same patch's own `customConnections`). Returns the first violation,
 *  or null if the patch is clean. */
function validatePatch(patch: CentrePatch, current: StoredCentre): { error: string; field: string } | null {
  // The real validator refuses any top-level key it does not know, naming it (so the retired `departments`
  // key is a 400 here too).
  for (const key of Object.keys(patch)) {
    if (!KNOWN_TOP_KEYS.has(key)) return { error: `unknown field: ${key}`, field: key };
  }
  if (patch.businessType && !registry.businessTypes.some((t) => t.id === patch.businessType)) {
    return { error: `unknown business type: ${patch.businessType}`, field: "businessType" };
  }
  if (patch.profile) {
    for (const [k, v] of Object.entries(patch.profile)) {
      if (!KNOWN_FIELD_KEYS.has(k)) return { error: `unknown field: ${k}`, field: `profile.${k}` };
      if (typeof v === "string") {
        if (v.length > 5000) return { error: `${k} exceeds 5,000 characters`, field: `profile.${k}` };
        if (looksLikeSecret(v)) return { error: `${k} looks like it contains a credential — record where it's stored instead`, field: `profile.${k}` };
      }
    }
  }
  if (patch.connections) {
    const validCustomIds = existingCustomIds(current);
    for (const [k, entry] of Object.entries(patch.connections)) {
      if (!KNOWN_CONNECTION_KEYS.has(k) && !validCustomIds.has(k)) {
        return { error: `unknown connection: ${k}`, field: `connections.${k}` };
      }
      if (!entry) continue;
      for (const [sk, sv] of Object.entries(entry)) {
        if (!CONNECTION_SUBKEYS.has(sk)) return { error: `unknown connection field: ${sk}`, field: `connections.${k}.${sk}` };
        if (typeof sv === "string") {
          if (sv.length > 5000) return { error: `${sk} exceeds 5,000 characters`, field: `connections.${k}.${sk}` };
          if (looksLikeSecret(sv)) return { error: `${sk} looks like it contains a credential — record where it's stored instead`, field: `connections.${k}.${sk}` };
          if (sk === "method" && !VALID_CONNECTION_METHODS.has(sv)) return { error: `method must be one of the registry methods: ${sv}`, field: `connections.${k}.method` };
          if (sk === "status" && !VALID_CONNECTION_STATUSES.has(sv)) return { error: `status must be one of the registry statuses: ${sv}`, field: `connections.${k}.status` };
        }
      }
    }
  }
  if (patch.areas) {
    for (const k of Object.keys(patch.areas)) {
      if (!KNOWN_AREA_IDS.has(k)) return { error: `unknown business area: ${k}`, field: `areas.${k}` };
    }
  }
  if (patch.customConnections) {
    for (const [sectionId, list] of Object.entries(patch.customConnections)) {
      if (!VALID_SECTION_IDS.has(sectionId)) return { error: `unknown section: ${sectionId}`, field: `customConnections.${sectionId}` };
      for (const c of list) {
        if (!/^x[a-z0-9]{4,40}$/.test(c.id)) return { error: `invalid custom connection id: ${c.id}`, field: `customConnections.${sectionId}` };
        if (!c.name || c.name.length > 120) return { error: `custom connection name must be 1-120 characters`, field: `customConnections.${sectionId}` };
      }
    }
  }
  return null;
}

function applyPatch(s: StoredCentre, patch: CentrePatch, byUserId: string): StoredCentre {
  const next: StoredCentre = {
    businessType: patch.businessType ?? s.businessType,
    profile: { ...s.profile },
    connections: Object.fromEntries(Object.entries(s.connections).map(([k, v]) => [k, { ...v }])),
    areas: { ...s.areas },
    customConnections: Object.fromEntries(Object.entries(s.customConnections).map(([k, v]) => [k, [...v]])),
    revision: s.revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: { id: byUserId, name: CALLER_NAME[byUserId] ?? null },
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
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === "") delete (merged as Record<string, unknown>)[sk];
        else (merged as Record<string, unknown>)[sk] = sv;
      }
      // An entry with every sub-key deleted is pruned, not persisted as `{}` (matches
      // `validation.ts`'s own comment: an empty connection object carries no information a missing
      // key doesn't already carry).
      if (Object.keys(merged).length === 0) delete next.connections[k];
      else next.connections[k] = merged;
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

// Which clients a portal caller may reach, and whether they may edit (CC-D4: active, client-wide,
// `signer` only). Mirrors `demoPortal.ts`'s `demo-client` = Dana Whitfield, client-wide signer on
// cl-1 — given a SECOND client here (view-only) so the switcher and the read-only path are both
// demoable without disturbing that file's own fixtures.
const PORTAL_SCOPE: Record<string, Array<{ clientId: string; canEdit: boolean }>> = {
  "demo-client": [
    { clientId: "cl-1", canEdit: true },
    { clientId: "cl-harbour", canEdit: false },
  ],
  // PV7-03: the other demo portal identities (demoPortalClients.ts) are contacts of Northwind and nothing else, so the
  // portal Overview's results headline reads a real answer for them too, not a failed read. The viewer is view-only
  // (`canEdit: false`), which the demo reads as "results hidden" (PV-D37), the project-scoped state.
  "demo-client-admin": [{ clientId: "cl-1", canEdit: true }],
  "demo-client-viewer": [{ clientId: "cl-1", canEdit: false }],
  "demo-viceroy-marketing": [{ clientId: "cl-1", canEdit: true }],
  "demo-two-company-client": [{ clientId: "cl-1", canEdit: true }],
};

// ── PV6-03 · Services & results ───────────────────────────────────────────────────────────────────────
// Every state the UI draws, so a DEMO_MODE page renders each one (the e2e + axe run drive these):
//   cl-1 (Northwind Traders)  — all five services: figures up and down, flat, a null figure ("Not measured yet"),
//                               no previous period ("Not enough data"), a target met and a target missed, a
//                               website card with NO figures. Staff and the portal read the SAME payload.
//   cl-harbour                — staff: one card and an `unavailable` service; the portal contact there is
//                               project-scoped (canEdit=false), so the portal reads `visible: false`.
//   everyone else             — no services (the empty area).
const PERIOD = { from: "2026-09-01", to: "2026-09-30" };
const kpi = (key: string, label: string, value: number | null, unit: ResultsKpi["unit"], previous: number | null, target: number | null = null): ResultsKpi => ({
  key, label, value, unit, period: PERIOD, previous, target, asOf: value === null ? null : "2026-09-30",
});

function northwindServices(): ResultsServiceCard[] {
  return [
    {
      service: "social", areaId: "mk_social", title: "Social media management", status: "active", since: "2026-03-01", clientVisible: true,
      items: [{ label: "Instagram", detail: "@northwind.traders" }, { label: "LinkedIn", detail: "Northwind Traders" }],
      kpis: [
        kpi("followers", "Followers", 12400, "count", 11800, 15000),
        kpi("engagement_rate", "Engagement rate", null, "percent", null),
        kpi("reach", "Reach", 5200, "count", null, 4000),
      ],
    },
    {
      service: "search", areaId: "se", title: "Search engine optimisation", status: "active", since: "2026-02-01", clientVisible: true,
      items: [{ label: "Tracked keywords", detail: "24" }],
      kpis: [
        kpi("avg_position", "Average ranking position", 4.2, "position", 4.2, 3),
        kpi("organic_sessions", "Organic sessions", 8200, "count", 7900),
        kpi("top10_share", "Keywords in the top 10", 62.5, "percent", 70, 60),
      ],
    },
    {
      service: "search_ads", areaId: "mk_paid", title: "Paid search", status: "paused", since: "2026-04-15", clientVisible: true,
      items: [{ label: "Campaigns", detail: "3 running, 1 paused" }],
      kpis: [
        kpi("clicks", "Clicks", 3150, "count", 2900),
        kpi("conversions", "Conversions", 0, "count", 12),
        kpi("conversion_value", "Conversion value (USD)", 18450, "count", 21000),
      ],
    },
    {
      service: "analytics", areaId: "mk_analytics", title: "Site analytics", status: "setting_up", since: null, clientVisible: true,
      items: [{ label: "Property", detail: "northwind.example" }],
      kpis: [kpi("sessions", "Sessions", null, "count", null)],
    },
    {
      service: "website", areaId: "mk_web", title: "Website", status: "active", since: "2026-01-10", clientVisible: true,
      items: [{ label: "northwind.example", detail: "Built on WebDesk" }],
      kpis: [],
    },
  ];
}

function resultsFor(clientId: string, portal: boolean, canEdit: boolean): BusinessResults {
  const base = { clientId, generatedAt: "2026-10-13T09:00:00Z", unavailable: [] as BusinessResults["unavailable"] };
  if (portal && !canEdit) return { ...base, visible: false, services: [] };
  if (clientId === "cl-1") return { ...base, visible: true, services: northwindServices() };
  if (clientId === "cl-harbour") {
    return { ...base, visible: true, services: northwindServices().slice(0, 1), unavailable: ["analytics"] };
  }
  return { ...base, visible: true, services: [] };
}

export function clientCentreDemo(method: string, p: string, userId: string, body?: string): DemoResult | null {
  const m = method.toUpperCase();

  // ── Staff ──────────────────────────────────────────────────────────────────────────────────────
  if (p.match(/^\/api\/[^/]+\/clients\/centre$/) && m === "GET") {
    return ok(Object.keys(CLIENT_META).map((clientId) => toListItem(clientId, STORE[clientId] ?? emptyCentre())));
  }
  // PV6-03: Services & results, staff side.
  const resM = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/centre\/results$/);
  if (resM && m === "GET") {
    if (!(resM[1] in CLIENT_META)) return err(404, "client not found");
    return ok(resultsFor(resM[1], false, true));
  }
  // PV6-04: no demo client was converted from a lead, so there are never discovery answers to fill from.
  const discM = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/centre\/(discovery|fill-from-discovery)$/);
  if (discM) {
    if (!(discM[1] in CLIENT_META)) return err(404, "client not found");
    if (discM[2] === "discovery" && m === "GET") return ok({ available: false, fillable: [] });
    if (discM[2] === "fill-from-discovery" && m === "POST") return err(404, "no discovery answers for this client");
  }
  const staffM = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/centre$/);
  if (staffM) {
    const clientId = staffM[1];
    if (!(clientId in CLIENT_META)) return err(404, "client not found");
    if (m === "GET") return ok(toProfile(clientId, STORE[clientId] ?? emptyCentre(), true));
    if (m === "PATCH") {
      const patch = JSON.parse(body || "{}") as CentrePatch;
      const current = STORE[clientId] ?? emptyCentre();
      const violation = validatePatch(patch, current);
      if (violation) return err(400, violation.error, violation.field);
      STORE[clientId] = applyPatch(current, patch, userId);
      return ok(toProfile(clientId, STORE[clientId], true));
    }
  }

  // ── Portal ─────────────────────────────────────────────────────────────────────────────────────
  if (p.match(/^\/api\/[^/]+\/portal\/centre$/) && m === "GET") {
    const scope = PORTAL_SCOPE[userId] ?? [];
    return ok(scope.map(({ clientId, canEdit }) => ({ clientId, clientName: CLIENT_META[clientId]?.name ?? clientId, canEdit })));
  }
  const portalResM = p.match(/^\/api\/[^/]+\/portal\/centre\/([^/]+)\/results$/);
  if (portalResM && m === "GET") {
    const scope = (PORTAL_SCOPE[userId] ?? []).find((x) => x.clientId === portalResM[1]);
    if (!scope) return err(404, "not found");
    return ok(resultsFor(portalResM[1], true, scope.canEdit));
  }
  const portalM = p.match(/^\/api\/[^/]+\/portal\/centre\/([^/]+)$/);
  if (portalM) {
    const clientId = portalM[1];
    const scope = (PORTAL_SCOPE[userId] ?? []).find((s) => s.clientId === clientId);
    if (!scope) return err(404, "not found"); // out-of-scope answers 404, never 403 (plan's own rule)
    if (m === "GET") return ok(toProfile(clientId, STORE[clientId] ?? emptyCentre(), scope.canEdit));
    if (m === "PATCH") {
      // Verbatim server copy (`portal-centre.controller.ts::patch`'s ForbiddenException).
      if (!scope.canEdit) return err(403, "your access is view-only — ask your account manager for company-wide signing access");
      const patch = JSON.parse(body || "{}") as CentrePatch;
      const current = STORE[clientId] ?? emptyCentre();
      const violation = validatePatch(patch, current);
      if (violation) return err(400, violation.error, violation.field);
      STORE[clientId] = applyPatch(current, patch, userId);
      return ok(toProfile(clientId, STORE[clientId], scope.canEdit));
    }
  }

  return null;
}
