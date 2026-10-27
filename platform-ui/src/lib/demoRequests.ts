import "server-only";
// TEMP DEMO MODE: stateful in-memory store for requests between departments (BFF §32) and across group companies (BFF §60, DW-10e), after
// `demoNotices.ts`. Routed from `demoFixtures.getDemoResponse`, so `/requests`, `/requests/new`, `/requests/outbound/[id]`, a department's Incoming
// and Sent tabs and the Overview's Requests block work with NO backend. Module-level state lasts for the dev-server process;
// `resetRequestsDemo()` is for tests.
//
// WHAT IT MODELS, in the server's order of checks (§60.5):
//  - the sender routes under the ASKING company: `GET requests/routes` (the active routes whose unit is active), `POST requests/outbound`
//    (403 first, then the body, then the route: 404 `route_not_found`, 409 `route_inactive` with `detail.status`, `route_unit_unavailable`,
//    `group_client_missing`), `GET requests/outbound` (scope `company` for a manager or administrator, `own` for everyone else: DW-D40),
//    `outbound/summary`, `outbound/:id` (another person's request is 404 to a caller in scope `own`) and `outbound/:id/cancel` (409
//    `request_not_open`, `already_in_progress`, `price_agreement_open`);
//  - the receiving side under the RECEIVING company: Incoming (`box=incoming`) with `requestingCompany`, `requesterUnit` and `client` on a cross
//    row, `box=mine` that leaves a cross row out, the detail, and a cancel that answers 409 `requester_side_only` on a cross row;
//  - the sender's rows carry NO ids of the receiver's work and NO amount: the price is a state (`impact`, `agreement`) and nothing more.
//
// WHO (the same people as the rest of the demo): `demo-hansel` is a platform admin (everything, in every company); `demo-owner` holds `owner` on
// every company (reads everything sent, sends, cannot cancel: PERMISSION-CONTRACT §49); `u-resort` (Ni Luh Sekar) and `demo-viceroy-marketing`
// (Made Sari) are plain members of Viceroy (`co-resort`); `dept-manager` is a manager of the agency; every other staff login is a member of
// the agency. A client contact has no staff right anywhere (403).
// THE ROUTES (DW-D39): Viceroy and the holding each have two, to the agency's Creatives (assets) and Web Dev (engineering), billed to each as a
// client of the agency (DW-D41).

import { demoMonthRequests, demoRequestSocialPosts } from "./demoSocialDesignQueue";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });

const AGENCY = "co-agency";
const COMPANY_NAMES: Record<string, string> = { "co-agency": "Gaia Digital Agency", "co-resort": "Viceroy", "co-holding": "D & A Syrowatka" };
const AGENCY_DEPTS: Record<string, string> = { "dept-1": "Web Dev", "dept-2": "Creatives", "dept-3": "SEO", "dept-4": "Social Media" };
/** The agency's client record for each requesting company (DW-D41). */
const CLIENT_OF: Record<string, { id: string; name: string }> = {
  "co-resort": { id: "cl-viceroy", name: "Viceroy" },
  "co-holding": { id: "cl-holding", name: "D & A Syrowatka" },
};

type Tier = "admin" | "owner" | "manager" | "member";
/** Who is staff where. A person absent here (a client contact) has no right in any company. */
const PEOPLE: Record<string, { name: string; tiers: Record<string, Tier>; unit?: Record<string, { id: string; name: string }> }> = {
  "demo-hansel": { name: "Clement Hansel", tiers: { "co-agency": "admin", "co-resort": "admin", "co-holding": "admin" } },
  "demo-owner": { name: "Group Owner", tiers: { "co-agency": "owner", "co-resort": "owner", "co-holding": "owner" } },
  "u-resort": { name: "Ni Luh Sekar", tiers: { "co-resort": "member" }, unit: { "co-resort": { id: "hosp-dept-1", name: "Front Office" } } },
  "demo-viceroy-marketing": { name: "Made Sari", tiers: { "co-resort": "member" } },
  "dept-manager": { name: "Rai Wijaya", tiers: { "co-agency": "manager" }, unit: { "co-agency": { id: "dept-3", name: "SEO" } } },
  "u-seo": { name: "Luh Ayu", tiers: { "co-agency": "member" }, unit: { "co-agency": { id: "dept-3", name: "SEO" } } },
  "u-creative": { name: "Putu Rani", tiers: { "co-agency": "member" }, unit: { "co-agency": { id: "dept-2", name: "Creatives" } } },
  "u-dev": { name: "Made Putra", tiers: { "co-agency": "member" }, unit: { "co-agency": { id: "dept-1", name: "Web Dev" } } },
  "u-webhead": { name: "Ketut Arta", tiers: { "co-agency": "manager" }, unit: { "co-agency": { id: "dept-1", name: "Web Dev" } } },
  "u-social": { name: "Komang Lestari", tiers: { "co-agency": "member" }, unit: { "co-agency": { id: "dept-4", name: "Social Media" } } },
};
const isClientContact = (userId: string) => userId.startsWith("demo-client") || userId === "demo-two-company-client";
function tierOf(userId: string, tenant: string): Tier | null {
  if (isClientContact(userId)) return null;
  const p = PEOPLE[userId];
  if (p) return p.tiers[tenant] ?? null;
  // Every other staff login (gede-ic, seo-staff, u-hr, u-finance-staff, u-it) is a member of the agency alone.
  return tenant === AGENCY ? "member" : null;
}
const nameOf = (userId: string) => PEOPLE[userId]?.name ?? "A colleague";
/** `send_across`: company_admin, manager, member and owner (PERMISSION-CONTRACT §49). */
const maySend = (t: Tier | null) => t !== null;
/** `read_across`: company_admin, manager and owner: the wide tier (DW-D40). A member reads only their own. */
const mayReadAcross = (t: Tier | null) => t === "admin" || t === "manager" || t === "owner";
/** §36 `cancel`: the requester, or the company's manager or administrator. An owner who is neither cannot. */
const mayCancelOthers = (t: Tier | null) => t === "admin" || t === "manager";

// ── routes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DemoRoute {
  routeId: string; kind: "assets" | "engineering"; providerTenantId: string; targetTenantId: string;
  unitId: string; unitName: string;
  status: "proposed" | "active" | "suspended" | "revoked"; unitActive: boolean;
  /** The department is still a department of the provider's org tree. */
  unitAvailable: boolean;
  /** How many live client records of the provider are linked to the target (DW-D41): 1 is the normal case. */
  clientRecords: number;
}
const route = (n: number, kind: DemoRoute["kind"], target: string, unitId: string): DemoRoute => ({
  routeId: `5a0c0000-0000-4000-8000-00000000000${n}`, kind, providerTenantId: AGENCY, targetTenantId: target,
  unitId, unitName: AGENCY_DEPTS[unitId], status: "active", unitActive: true, unitAvailable: true, clientRecords: 1,
});
const seedRoutes = (): DemoRoute[] => [
  route(1, "assets", "co-resort", "dept-2"), route(2, "engineering", "co-resort", "dept-1"),
  route(3, "assets", "co-holding", "dept-2"), route(4, "engineering", "co-holding", "dept-1"),
];
let ROUTES: DemoRoute[] = seedRoutes();

// ── requests ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Agreement = "preparing" | "awaiting_signature" | "signed" | "closed";
interface DemoRequest {
  id: string; tenantId: string; requesterTenantId: string; kind: "assets" | "engineering";
  title: string; brief: string; neededBy: string | null; createdAt: string; closedAt: string | null;
  status: "open" | "delivered" | "declined" | "cancelled"; declineReason: string | null;
  requestedBy: string; fromUnit: { id: string; name: string } | null; toUnit: { id: string; name: string };
  requesterUnit: { id: string; name: string } | null; routeId: string | null;
  form: Record<string, unknown>;
  /** pm_task for assets, change_request for engineering. */
  workStatus: string; isDone: boolean; responsibleName: string | null;
  /** Engineering only: the price STATE. There is no amount anywhere in this store. */
  price: { impact: "unassessed" | "none" | "changes_price"; agreement: Agreement | null } | null;
  assets: { id: string; name: string; contentType: string }[];
  files: { id: string; filename: string; contentType: string; byteSize: number; url: string | null }[];
}

const SEED_BASE = "2026-10-1";
const seedRequests = (): DemoRequest[] => [
  {
    id: "wr-across-1", tenantId: AGENCY, requesterTenantId: "co-resort", kind: "assets",
    title: "DEMO Reception banners for the spring offer", brief: "Three banners for the front desk screens. Warm colours, the new logo.",
    neededBy: "2026-11-05", createdAt: `${SEED_BASE}2T03:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "u-resort", fromUnit: null, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" },
    routeId: ROUTES[0].routeId,
    form: { deliverables: [{ format: "image", size: "1920x1080", quantity: 3 }], channel: "Front desk screens" },
    workStatus: "in_progress", isDone: false, responsibleName: "Putu Rani", price: null, assets: [], files: [],
  },
  {
    id: "wr-across-2", tenantId: AGENCY, requesterTenantId: "co-resort", kind: "engineering",
    title: "DEMO Booking page: a new rooms section", brief: "Add a rooms section with photos and a price-from line.",
    neededBy: null, createdAt: `${SEED_BASE}1T03:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "u-resort", fromUnit: null, toUnit: { id: "dept-1", name: "Web Dev" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" },
    routeId: ROUTES[1].routeId, form: { kind: "feature", affectedUrl: "https://viceroy.example/booking" },
    workStatus: "new", isDone: false, responsibleName: null, price: { impact: "changes_price", agreement: "awaiting_signature" }, assets: [], files: [],
  },
  {
    id: "wr-across-3", tenantId: AGENCY, requesterTenantId: "co-resort", kind: "assets",
    title: "DEMO Spring menu cover", brief: "A cover for the printed spring menu.",
    neededBy: "2026-10-09", createdAt: `${SEED_BASE}0T03:00:00.000Z`, closedAt: `${SEED_BASE}3T08:00:00.000Z`, status: "delivered", declineReason: null,
    requestedBy: "u-resort", fromUnit: null, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" },
    routeId: ROUTES[0].routeId, form: { deliverables: [{ format: "image", size: "A4", quantity: 1 }] },
    workStatus: "done", isDone: true, responsibleName: "Putu Rani", price: null,
    assets: [{ id: "ast-demo-1", name: "DEMO spring menu cover.png", contentType: "image/png" }],
    files: [{ id: "f-demo-1", filename: "DEMO menu brief.pdf", contentType: "application/pdf", byteSize: 90112, url: null }],
  },
  {
    id: "wr-across-4", tenantId: AGENCY, requesterTenantId: "co-resort", kind: "assets",
    title: "DEMO Poolside signage", brief: "Two signs, same style as the lobby ones.",
    neededBy: null, createdAt: `${SEED_BASE}2T05:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "demo-viceroy-marketing", fromUnit: null, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: null,
    routeId: ROUTES[0].routeId, form: { deliverables: [{ format: "image", size: "", quantity: 2 }] },
    workStatus: "new", isDone: false, responsibleName: null, price: null, assets: [], files: [],
  },
  {
    id: "wr-across-5", tenantId: AGENCY, requesterTenantId: "co-resort", kind: "engineering",
    title: "DEMO Fix the contact form on the events page", brief: "The form does not send on a phone.",
    neededBy: null, createdAt: `${SEED_BASE}3T04:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "u-resort", fromUnit: null, toUnit: { id: "dept-1", name: "Web Dev" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" },
    routeId: ROUTES[1].routeId, form: { kind: "bug" },
    workStatus: "new", isDone: false, responsibleName: null, price: { impact: "unassessed", agreement: null }, assets: [], files: [],
  },
  {
    id: "wr-across-6", tenantId: AGENCY, requesterTenantId: "co-holding", kind: "assets",
    title: "DEMO Annual report cover", brief: "A cover and two section dividers.",
    neededBy: "2026-12-01", createdAt: `${SEED_BASE}1T09:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "demo-hansel", fromUnit: null, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: null,
    routeId: ROUTES[2].routeId, form: { deliverables: [{ format: "document", size: "A4", quantity: 3 }] },
    workStatus: "new", isDone: false, responsibleName: null, price: null, assets: [], files: [],
  },
  {
    id: "wr-same-1", tenantId: AGENCY, requesterTenantId: AGENCY, kind: "assets",
    title: "DEMO Blog header images", brief: "Header images for the October posts.",
    neededBy: "2026-10-30", createdAt: `${SEED_BASE}2T07:00:00.000Z`, closedAt: null, status: "open", declineReason: null,
    requestedBy: "u-seo", fromUnit: { id: "dept-3", name: "SEO" }, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: null, routeId: null,
    form: { deliverables: [{ format: "image", size: "1200x630", quantity: 4 }] },
    workStatus: "new", isDone: false, responsibleName: null, price: null, assets: [], files: [],
  },
];
let REQUESTS: DemoRequest[] = seedRequests();
let seq = 0;

/** For tests: back to the seed. */
export function resetRequestsDemo(): void {
  ROUTES = seedRoutes();
  REQUESTS = seedRequests();
  seq = 0;
}
/** For tests: change one route's state (the server's order of checks is then exercised by a send). */
export function setDemoRoute(routeId: string, patch: Partial<DemoRoute>): void {
  ROUTES = ROUTES.map((r) => (r.routeId === routeId ? { ...r, ...patch } : r));
}
export const DEMO_ROUTE_IDS = { creativesToViceroy: "5a0c0000-0000-4000-8000-000000000001", webDevToViceroy: "5a0c0000-0000-4000-8000-000000000002" } as const;

// ── shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const company = (id: string) => ({ id, name: COMPANY_NAMES[id] ?? "Another company" });
const unit = (u: { id: string; name: string } | null) => (u ? { id: u.id, name: u.name, unitMissing: false } : null);
const isCross = (r: DemoRequest) => r.requesterTenantId !== r.tenantId;

/** §32.5's row, with §60.6's three extra fields (null on a same-company row). */
function receiverRow(r: DemoRequest) {
  const cross = isCross(r);
  return {
    id: r.id, kind: r.kind, title: r.title, status: r.status, neededBy: r.neededBy, createdAt: r.createdAt, closedAt: r.closedAt,
    fromUnit: cross ? null : unit(r.fromUnit), toUnit: unit(r.toUnit),
    requestedBy: { id: r.requestedBy, name: nameOf(r.requestedBy) }, campaign: null,
    work: r.kind === "assets"
      ? { type: "pm_task", id: `task-${r.id}`, projectId: null, status: r.workStatus, isDone: r.isDone, responsibleName: r.responsibleName }
      : { type: "change_request", id: `cr-${r.id}`, status: r.workStatus, route: null },
    assetCount: r.assets.length,
    requestingCompany: cross ? company(r.requesterTenantId) : null,
    requesterUnit: cross ? r.requesterUnit : null,
    client: cross ? CLIENT_OF[r.requesterTenantId] ?? null : null,
  };
}

/** §60.5's sender row: no ids of the receiver's work, no amount, and `campaign` always null. */
function senderRow(r: DemoRequest) {
  return {
    id: r.id, kind: r.kind, title: r.title, status: r.status, neededBy: r.neededBy, createdAt: r.createdAt, closedAt: r.closedAt,
    fromUnit: unit(r.requesterUnit), toUnit: unit(r.toUnit),
    requestedBy: { id: r.requestedBy, name: nameOf(r.requestedBy) }, campaign: null,
    work: r.kind === "assets"
      ? { type: "pm_task", status: r.workStatus, isDone: r.isDone, responsibleName: r.responsibleName }
      : { type: "change_request", status: r.workStatus },
    assetCount: r.assets.length,
    receivingCompany: company(r.tenantId), routeId: r.routeId,
    price: r.kind === "engineering" && r.price ? { impact: r.price.impact, agreement: r.price.impact === "changes_price" ? r.price.agreement : null } : null,
  };
}

const matchesStatus = (r: DemoRequest, status: string) => (status === "open" ? r.status === "open" : status === "closed" ? r.status !== "open" : true);
const newestFirst = (a: DemoRequest, b: DemoRequest) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

function listFilters(q: URLSearchParams): { status: string; kind: string | null } | DemoResult {
  const status = q.get("status") ?? "open";
  if (!["open", "closed", "all"].includes(status)) return err(400, "status is not valid", { reason: "status_invalid" });
  const kind = q.get("kind");
  if (kind && kind !== "assets" && kind !== "engineering") return err(400, "kind is not valid", { reason: "kind_invalid" });
  return { status, kind };
}

// ── the body of a send (§32.4's rules, as the server parses them) ──────────────────────────────────────────────────────────────────

const DELIVERABLE_FORMATS = ["image", "video", "copy", "document", "other"];
const ENGINEERING_KINDS = ["content", "design", "feature", "bug"];
const isRealDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;

function checkForm(kind: "assets" | "engineering", form: unknown): DemoResult | null {
  const bad = (field: string) => err(400, "the request details are not valid", { reason: "form_invalid", field });
  if (!form || typeof form !== "object" || Array.isArray(form)) return bad("form");
  const f = form as Record<string, unknown>;
  if (kind === "assets") {
    const ds = f.deliverables;
    if (!Array.isArray(ds) || ds.length < 1 || ds.length > 10) return bad("form.deliverables");
    for (let i = 0; i < ds.length; i += 1) {
      const d = ds[i] as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return bad(`form.deliverables[${i}]`);
      if (!DELIVERABLE_FORMATS.includes(String(d.format))) return bad(`form.deliverables[${i}].format`);
      if (!Number.isInteger(d.quantity) || (d.quantity as number) < 1 || (d.quantity as number) > 50) return bad(`form.deliverables[${i}].quantity`);
    }
    return null;
  }
  return ENGINEERING_KINDS.includes(String(f.kind)) ? null : bad("form.kind");
}

/** Title, brief, date and form, in the order the server checks them. */
function checkCommon(b: Record<string, unknown>, kind: "assets" | "engineering"): DemoResult | null {
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title || title.length > 200) return err(400, "a title is 1 to 200 characters", { reason: "title_invalid", field: "title" });
  if (b.brief !== undefined && b.brief !== null) {
    if (typeof b.brief !== "string") return err(400, "the brief must be plain text", { reason: "brief_invalid", field: "brief" });
    if (b.brief.length > 10_000) return err(400, "the brief is too long", { reason: "brief_too_long", field: "brief" });
  }
  if (b.neededBy !== undefined && b.neededBy !== null && (typeof b.neededBy !== "string" || !isRealDate(b.neededBy))) {
    return err(400, "needed by is not a real date", { reason: "date_invalid", field: "neededBy" });
  }
  return checkForm(kind, b.form);
}

function parseBody(body: string | undefined): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const staffOf = (userId: string, tenant: string): Tier | DemoResult => tierOf(userId, tenant) ?? err(403, "forbidden");

// ── the dispatcher ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Answers `/api/:tenant/requests…` and returns null for anything else. */
export function requestsDemo(method: string, path: string, q: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = path.match(/^\/api\/([^/]+)\/requests(\/.*)?$/);
  if (!m) return null;
  const tenant = m[1];
  const rest = m[2] ?? "";
  const verb = method.toUpperCase();

  // The sender's routes first: `routes` and `outbound` are static segments and never an id.
  if (rest === "/routes" && verb === "GET") {
    const tier = staffOf(userId, tenant);
    if (typeof tier !== "string") return tier;
    const routes = ROUTES.filter((r) => r.targetTenantId === tenant && r.status === "active" && r.unitActive)
      .map((r) => ({ routeId: r.routeId, kind: r.kind, company: company(r.providerTenantId), unit: { name: r.unitName } }));
    return ok({ enabled: true, routes });
  }

  if (rest === "/outbound" && verb === "POST") return sendAcross(tenant, userId, body);
  if (rest === "/outbound" && verb === "GET") return listOutbound(tenant, userId, q);
  if (rest === "/outbound/summary" && verb === "GET") return outboundSummary(tenant, userId, q);
  const outboundId = rest.match(/^\/outbound\/([^/]+)(\/cancel|\/files)?$/);
  if (outboundId) {
    if (outboundId[2] === "/cancel" && verb === "POST") return cancelOutbound(tenant, userId, outboundId[1]);
    if (outboundId[2] === "/files" && verb === "GET") return outboundFiles(tenant, userId, outboundId[1]);
    if (!outboundId[2] && verb === "GET") return outboundDetail(tenant, userId, outboundId[1]);
    return null;
  }

  // §32's receiving side.
  if (rest === "" && verb === "GET") return listReceiving(tenant, userId, q);
  if (rest === "" && verb === "POST") return createSameCompany(tenant, userId, body);
  // `GET requests/summary` is NOT served on purpose: the Overview's Requests block says "Unavailable" in the demo, the honest state that
  // e2e/workspace-shell.spec.ts (DW-3f) pins. The sender's summary (`outbound/summary`) is served above.
  const one = rest.match(/^\/([^/]+)(\/cancel|\/decline)?$/);
  if (one) {
    if (!one[2] && verb === "GET") return receivingDetail(tenant, userId, one[1]);
    if (one[2] === "/cancel" && verb === "POST") return cancelReceiving(tenant, userId, one[1]);
    if (one[2] === "/decline" && verb === "POST") return declineReceiving(tenant, userId, one[1], body);
  }
  return null;
}

// ── the sender ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function sendAcross(tenant: string, userId: string, body: string | undefined): DemoResult {
  const tier = tierOf(userId, tenant);
  if (!maySend(tier)) return err(403, "forbidden"); // always first: nothing in the body is looked at before it
  const b = parseBody(body);
  if (!b) return err(400, "the request could not be read", { reason: "body_invalid" });

  const routeId = b.routeId;
  const asked = b.kind === "assets" || b.kind === "engineering" ? b.kind : null;
  // A kind in the body parses the form first (the refusal table's order); without one the form is parsed after the route resolved.
  if (b.kind !== undefined && b.kind !== null && !asked) return err(400, "that kind of request is not available", { reason: "kind_invalid" });
  if (asked) {
    const bad = checkCommon(b, asked);
    if (bad) return bad;
  }
  if (typeof routeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(routeId)) {
    return err(400, "choose one of your company's routes", { reason: "route_invalid", field: "routeId" });
  }
  if (b.toUnitId !== undefined && b.toUnitId !== null) return err(400, "the route names the department", { reason: "to_unit_invalid" });
  if (b.campaignPartId !== undefined && b.campaignPartId !== null) return err(400, "a request to another company links no campaign part", { reason: "campaign_part_invalid" });

  const r = ROUTES.find((x) => x.routeId === routeId && x.targetTenantId === tenant);
  if (!r) return err(404, "that route does not exist", { reason: "route_not_found" });
  if (asked && asked !== r.kind) return err(400, "that kind does not match the route", { reason: "kind_invalid" });
  if (r.status !== "active" || !r.unitActive) {
    return err(409, "the route is not active", { reason: "route_inactive", detail: { status: r.status !== "active" ? r.status : "orphaned" } });
  }
  if (!r.unitAvailable) return err(409, "the route's department is no longer in the org chart", { reason: "route_unit_unavailable" });
  if (r.clientRecords === 0) return err(409, "the company has not set yours up as a client", { reason: "group_client_missing" });
  if (r.clientRecords > 1) return err(409, "the company has your company down as a client more than once", { reason: "group_client_ambiguous" });
  if (!asked) {
    const bad = checkCommon(b, r.kind);
    if (bad) return bad;
  }

  const id = `wr-across-new-${++seq}`;
  const placed = PEOPLE[userId]?.unit?.[tenant] ?? null;
  REQUESTS.push({
    id, tenantId: r.providerTenantId, requesterTenantId: tenant, kind: r.kind,
    title: String(b.title).trim(), brief: typeof b.brief === "string" ? b.brief : "",
    neededBy: typeof b.neededBy === "string" ? b.neededBy : null, createdAt: new Date().toISOString(), closedAt: null,
    status: "open", declineReason: null, requestedBy: userId, fromUnit: null, toUnit: { id: r.unitId, name: r.unitName },
    requesterUnit: placed, routeId: r.routeId, form: b.form as Record<string, unknown>,
    workStatus: "new", isDone: false, responsibleName: null,
    price: r.kind === "engineering" ? { impact: "unassessed", agreement: null } : null, assets: [], files: [],
  });
  return ok({ id, kind: r.kind, receivingCompany: company(r.providerTenantId) }, 201);
}

/** The rows the caller may see in the asking company, and the scope that says how wide that is (DW-D40). */
function senderScope(tenant: string, userId: string, tier: Tier): { scope: "company" | "own"; rows: DemoRequest[] } {
  const scope = mayReadAcross(tier) ? "company" : "own";
  return {
    scope,
    rows: REQUESTS.filter((r) => r.requesterTenantId === tenant && r.tenantId !== tenant && (scope === "company" || r.requestedBy === userId)),
  };
}

function listOutbound(tenant: string, userId: string, q: URLSearchParams): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const box = q.get("box");
  if (box !== "mine" && box !== "sent" && box !== "all") return err(400, "box is not valid", { reason: "box_invalid" });
  const f = listFilters(q);
  if ("json" in f) return f;
  const { status, kind } = f;
  const unitId = q.get("unitId");
  if (box === "sent" && !unitId) return err(400, "unitId is required for sent", { reason: "unit_invalid" });
  const { scope, rows } = senderScope(tenant, userId, tier);
  const picked = rows
    .filter((r) => (box === "mine" ? r.requestedBy === userId : box === "sent" ? r.requesterUnit?.id === unitId : true))
    .filter((r) => matchesStatus(r, status) && (!kind || r.kind === kind))
    .sort(newestFirst).slice(0, 200);
  return ok({ scope, rows: picked.map(senderRow) });
}

function outboundSummary(tenant: string, userId: string, q: URLSearchParams): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const unitId = q.get("unitId");
  if (!unitId) return err(400, "unitId is required", { reason: "unit_invalid" });
  const { scope, rows } = senderScope(tenant, userId, tier);
  return ok({ scope, sent: { open: rows.filter((r) => r.status === "open" && r.requesterUnit?.id === unitId).length } });
}

/** One of the caller's requests, or any of the company's for the wide tier; otherwise it is absent (404), never an oracle. */
function visibleOutbound(tenant: string, userId: string, id: string): { tier: Tier; row: DemoRequest } | DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const row = senderScope(tenant, userId, tier).rows.find((r) => r.id === id);
  return row ? { tier, row } : err(404, "that request no longer exists", { reason: "request_not_found" });
}

function outboundDetail(tenant: string, userId: string, id: string): DemoResult {
  const v = visibleOutbound(tenant, userId, id);
  if ("status" in v) return v;
  const r = v.row;
  return ok({
    ...senderRow(r), brief: r.brief, form: r.form, declineReason: r.declineReason,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, href: `/api/${tenant}/requests/outbound/${r.id}/assets/${a.id}/content` })),
  });
}

function outboundFiles(tenant: string, userId: string, id: string): DemoResult {
  const v = visibleOutbound(tenant, userId, id);
  if ("status" in v) return v;
  return ok(v.row.files.map((f) => ({ id: f.id, filename: f.filename, contentType: f.contentType, byteSize: f.byteSize, createdAt: v.row.createdAt, url: f.url })));
}

const LIVE_AGREEMENT: (Agreement | null)[] = ["preparing", "awaiting_signature", "signed"];

function cancelOutbound(tenant: string, userId: string, id: string): DemoResult {
  const v = visibleOutbound(tenant, userId, id);
  if ("status" in v) return v;
  const r = v.row;
  // §36's `cancel`: the requester, or the company's manager or administrator. An owner who is neither is refused (no mirror).
  if (r.requestedBy !== userId && !mayCancelOthers(v.tier)) return err(403, "forbidden");
  if (r.status !== "open") return err(409, "the request is no longer open", { reason: "request_not_open", detail: { status: r.status } });
  if (r.kind === "engineering") {
    if (r.workStatus !== "new") return err(409, "the work has already been accepted", { reason: "already_in_progress" });
    if (r.price?.impact === "changes_price" && LIVE_AGREEMENT.includes(r.price.agreement)) {
      return err(409, "a price agreement is open", { reason: "price_agreement_open", detail: { agreement: r.price.agreement } });
    }
  }
  r.status = "cancelled";
  r.closedAt = new Date().toISOString();
  return ok({ id: r.id, status: "cancelled" });
}

// ── the receiving side (§32 + §60.6) ────────────────────────────────────────────────────────────────────────────────────────────

function listReceiving(tenant: string, userId: string, q: URLSearchParams): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const box = q.get("box");
  if (box !== "mine" && box !== "sent" && box !== "incoming") return err(400, "box is not valid", { reason: "box_invalid" });
  const f = listFilters(q);
  if ("json" in f) return f;
  const { status, kind } = f;
  const unitId = q.get("unitId");
  if (box !== "mine" && !unitId) return err(400, "unitId is required", { reason: "unit_invalid" });
  const mine = REQUESTS.filter((r) => r.tenantId === tenant)
    // "mine" is what I asked from THIS company: a cross request I sent is the sender's, not mine here (§60.6).
    .filter((r) => (box === "mine" ? r.requestedBy === userId && !isCross(r) : box === "sent" ? !isCross(r) && r.fromUnit?.id === unitId : r.toUnit.id === unitId))
    .filter((r) => matchesStatus(r, status) && (!kind || r.kind === kind));
  const ordered = box === "incoming" ? mine.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) : mine.sort(newestFirst);
  return ok(ordered.slice(0, 200).map(receiverRow));
}

/** The Social Media department of the agency in this demo (`AGENCY_DEPTS`), where a request's social posts open. */
const SOCIAL_DEPT = "dept-4";

/** A Creatives month request that a Social Media post names (`creativeRequestId`): open, to Creatives, with the designer on its task. Not in the lists. */
function monthRequest(tenant: string, id: string): DemoRequest | undefined {
  const m = tenant === AGENCY ? demoMonthRequests().find((x) => x.id === id) : undefined;
  if (!m) return undefined;
  return {
    id: m.id, tenantId: AGENCY, requesterTenantId: AGENCY, kind: "assets", title: m.title, brief: "", neededBy: m.neededBy,
    createdAt: `${SEED_BASE}2T03:00:00.000Z`, closedAt: null, status: "open", declineReason: null, requestedBy: "demo-hansel",
    fromUnit: { id: SOCIAL_DEPT, name: AGENCY_DEPTS[SOCIAL_DEPT] }, toUnit: { id: "dept-2", name: "Creatives" }, requesterUnit: null, routeId: null,
    form: { deliverables: [{ format: "image", size: "per post", quantity: 4 }], channel: "social" },
    workStatus: "in_progress", isDone: false, responsibleName: "Putu Rani", price: null, assets: [], files: [],
  };
}

function receivingDetail(tenant: string, userId: string, id: string): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  // SCP-1h (§63.6.6): a Creatives month request opened by a Social Media post is read here from the demo posts, never listed (the lists above stay as seeded).
  const r = REQUESTS.find((x) => x.id === id && x.tenantId === tenant) ?? monthRequest(tenant, id);
  if (!r) return err(404, "that request no longer exists", { reason: "request_not_found" });
  return ok({
    ...receiverRow(r), brief: r.brief, form: r.form, declineReason: r.declineReason,
    assets: r.assets.map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, href: `/api/${tenant}/creative/assets/${a.id}/content` })),
    // Additive (§63.6.6): the social posts that joined this request, [] for one no post joined.
    socialPosts: demoRequestSocialPosts(id, SOCIAL_DEPT),
  });
}

function createSameCompany(tenant: string, userId: string, body: string | undefined): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const b = parseBody(body);
  if (!b) return err(400, "the request could not be read", { reason: "body_invalid" });
  const kind = b.kind === "assets" || b.kind === "engineering" ? b.kind : null;
  if (!kind) return err(400, "that kind of request is not available", { reason: "kind_invalid" });
  const to = typeof b.toUnitId === "string" && tenant === AGENCY ? AGENCY_DEPTS[b.toUnitId] : undefined;
  if (!to) return err(400, "the receiving team is not a department", { reason: "to_unit_invalid" });
  const bad = checkCommon(b, kind);
  if (bad) return bad;
  const id = `wr-same-new-${++seq}`;
  REQUESTS.push({
    id, tenantId: tenant, requesterTenantId: tenant, kind, title: String(b.title).trim(), brief: typeof b.brief === "string" ? b.brief : "",
    neededBy: typeof b.neededBy === "string" ? b.neededBy : null, createdAt: new Date().toISOString(), closedAt: null, status: "open", declineReason: null,
    requestedBy: userId, fromUnit: PEOPLE[userId]?.unit?.[tenant] ?? null, toUnit: { id: String(b.toUnitId), name: to }, requesterUnit: null, routeId: null,
    form: b.form as Record<string, unknown>, workStatus: "new", isDone: false, responsibleName: null,
    price: null, assets: [], files: [],
  });
  return ok({ id }, 201);
}

function cancelReceiving(tenant: string, userId: string, id: string): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const r = REQUESTS.find((x) => x.id === id && x.tenantId === tenant);
  if (!r) return err(404, "that request no longer exists", { reason: "request_not_found" });
  // §60.6: the receiving company cannot cancel another company's request. After the authorization, before anything else.
  if (isCross(r)) return err(409, "only the company that sent this request can cancel it", { reason: "requester_side_only" });
  if (r.requestedBy !== userId && !mayCancelOthers(tier)) return err(403, "forbidden");
  if (r.status !== "open") return err(409, "the request is no longer open", { reason: "request_not_open", detail: { status: r.status } });
  if (r.kind === "engineering" && r.workStatus !== "new") return err(409, "the work has already been accepted", { reason: "already_in_progress" });
  r.status = "cancelled";
  r.closedAt = new Date().toISOString();
  return ok({ id: r.id, status: "cancelled" });
}

function declineReceiving(tenant: string, userId: string, id: string, body: string | undefined): DemoResult {
  const tier = staffOf(userId, tenant);
  if (typeof tier !== "string") return tier;
  const r = REQUESTS.find((x) => x.id === id && x.tenantId === tenant);
  if (!r) return err(404, "that request no longer exists", { reason: "request_not_found" });
  if (tier !== "admin" && tier !== "manager") return err(403, "forbidden");
  if (r.kind !== "assets") return err(409, "engineering requests are handled by triage", { reason: "wrong_kind_for_action" });
  const reason = (parseBody(body)?.reason as string | undefined)?.trim() ?? "";
  if (!reason || reason.length > 2000) return err(400, "give a reason", { reason: "reason_invalid", field: "reason" });
  if (r.status !== "open") return err(409, "the request is no longer open", { reason: "request_not_open", detail: { status: r.status } });
  r.status = "declined";
  r.declineReason = reason;
  r.closedAt = new Date().toISOString();
  return ok({ id: r.id, status: "declined" });
}
