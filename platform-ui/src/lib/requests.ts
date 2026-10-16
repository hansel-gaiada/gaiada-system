// DW-5c UI: requests between departments (docs/FRONTEND-BFF-CONTRACT.md §32). Pure types and helpers, client-safe:
// the readers live in `requests-data.ts` (server-only), the writes in `requestActions.ts`.
//
// What this file owns:
//   - the wire shapes (§32.5) and defensive normalisers, so a wrong shape never crashes a page;
//   - the request FORM model and a client-side validator that mirrors §32.4 (and the title, brief and date rules of
//     §32.1/§32.5) bound for bound, so the form explains a mistake before the server has to. The server stays the
//     authority; its `form_invalid` field names use the same `form.deliverables[0].size` spelling as this validator's,
//     so a server refusal lands on the same field;
//   - every typed refusal `reason` of §32.5 and §32.10 as a sentence (`requestErrorText`);
//   - who is OFFERED which action (`requestActions`). That is cosmetic: Cerbos decides.
import { formatDate } from "./format";

// ── vocabulary ───────────────────────────────────────────────────────────────────────────────────

export const REQUEST_KINDS = ["assets", "engineering"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ["open", "delivered", "declined", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open",
  delivered: "Delivered",
  declined: "Declined",
  cancelled: "Cancelled",
};

export const ENGINEERING_KINDS = ["content", "design", "feature", "bug"] as const;
export const ENGINEERING_KIND_LABEL: Record<(typeof ENGINEERING_KINDS)[number], string> = {
  content: "Content change",
  design: "Design change",
  feature: "New feature",
  bug: "Bug",
};

export const DELIVERABLE_FORMATS = ["image", "video", "copy", "document", "other"] as const;
export const DELIVERABLE_FORMAT_LABEL: Record<(typeof DELIVERABLE_FORMATS)[number], string> = {
  image: "Image",
  video: "Video",
  copy: "Copy",
  document: "Document",
  other: "Other",
};

/** The §32.4 / §32.1 bounds. The same numbers as the server's `work-requests.service.ts`. */
export const LIMITS = {
  title: 200,
  brief: 10_000,
  reason: 2_000,
  deliverables: 10,
  quantity: 50,
  size: 60,
  channel: 60,
  references: 10,
  url: 500,
  notes: 2_000,
  assetIds: 20,
} as const;

/** The two "Ask ..." targets the registry's ASK_ACTIONS link to (`/requests/new?to=<key>`), and the kind each takes (§32.5). */
export const REQUEST_TARGETS = {
  creatives: { label: "Creatives", kind: "assets" },
  "web-dev": { label: "Web Dev", kind: "engineering" },
} as const satisfies Record<string, { label: string; kind: RequestKind }>;
export type RequestTargetKey = keyof typeof REQUEST_TARGETS;

export function parseTarget(raw: string | string[] | undefined): RequestTargetKey | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "creatives" || v === "web-dev" ? v : null;
}

export type StatusFilter = "open" | "closed" | "all";
/** Anything unknown reads as the default, `open`. */
export function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "closed" || v === "all" ? v : "open";
}

// ── shapes (§32.5) ───────────────────────────────────────────────────────────────────────────────

/** A department as the server names it. `name` is null and `unitMissing` true when it left the org chart (§32.10 #9). */
export interface UnitRef { id: string; name: string | null; unitMissing: boolean }

export type RequestWork =
  | { type: "pm_task"; id: string; projectId: string | null; status: string; isDone: boolean; responsibleName: string | null }
  | { type: "change_request"; id: string; status: string; route: string | null };

/** `live`: the work item as it is now. `removed`: the wire said `work: null` (the item was deleted). `unknown`: the
 *  wire carried something this UI cannot read, which is NOT the same as removed. */
export type WorkState = { state: "live"; work: RequestWork } | { state: "removed" } | { state: "unknown" };

/** A company as the wire names it (DW-10e, §60.5/§60.6). */
export interface CompanyRef { id: string; name: string }

/** The sender's view of an engineering request's price (§60.5): a STATE, never an amount. Only these two fields are read, so
 *  an amount, a currency or a contract id that ever reached the wire is dropped here and cannot be drawn (DW-D41). */
export const PRICE_IMPACTS = ["unassessed", "none", "changes_price"] as const;
export type PriceImpact = (typeof PRICE_IMPACTS)[number];
export const PRICE_AGREEMENTS = ["preparing", "awaiting_signature", "signed", "closed"] as const;
export type PriceAgreement = (typeof PRICE_AGREEMENTS)[number];
export interface RequestPrice { impact: PriceImpact; agreement: PriceAgreement | null }

export interface RequestRow {
  id: string;
  kind: RequestKind;
  title: string;
  status: string;
  neededBy: string | null;
  createdAt: string | null;
  closedAt: string | null;
  fromUnit: UnitRef | null;
  toUnit: UnitRef;
  requestedBy: { id: string; name: string };
  campaign: { id: string; name: string; partId: string } | null;
  work: WorkState;
  assetCount: number;
  // DW-10e. Optional on purpose: absent reads as null, which is a same-company row exactly as §32 sends it.
  /** The RECEIVING side's rows and detail (§60.6): the company that asked, its department (the name when it was sent) and the
   *  client the work is billed to. All null on a same-company row. */
  requestingCompany?: CompanyRef | null;
  requesterUnit?: { id: string; name: string } | null;
  client?: CompanyRef | null;
  /** The SENDER's rows (§60.5): the company that takes the request, and the route it went through. Set on every row the outbound
   *  reads return, so a row with a `receivingCompany` opens at `/requests/outbound/<id>`. */
  receivingCompany?: CompanyRef | null;
  routeId?: string | null;
  /** The sender's row of an engineering request: the price state. Null for assets, and when it could not be read. */
  price?: RequestPrice | null;
}

export interface RequestAsset { id: string; name: string; contentType: string; href: string }

export interface RequestDetail extends RequestRow {
  brief: string;
  /** The form as sent, shown back as data. Never interpreted. */
  form: Record<string, unknown>;
  declineReason: string | null;
  assets: RequestAsset[];
}

export interface RequestSummary {
  incoming: { open: number; oldestOpenAt: string | null };
  sent: { open: number };
}

// ── normalising what the wire sends ──────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function unitRef(v: unknown, loose = false): UnitRef | null {
  const o = obj(v);
  if (!o) return null;
  // The sender's rows name a unit by its name alone when the wire gives no id (it is another company's tree: an id would be useless to
  // the reader), so a loose read keeps a unit that has a name.
  const id = str(o.id) ?? (loose && str(o.name) ? "" : null);
  if (id === null) return null;
  const name = str(o.name);
  return { id, name, unitMissing: o.unitMissing === true || name === null };
}

/** `idless`: the sender's `work` carries no ids (§60.5: the receiver's task and change-request ids stay with the receiver). */
function normalizeWork(v: unknown, idless = false): WorkState {
  if (v === null) return { state: "removed" };
  const o = obj(v);
  const id = o ? (str(o.id) ?? (idless ? "" : null)) : null;
  if (!o || id === null || (!idless && !id)) return { state: "unknown" };
  if (o.type === "pm_task") {
    return {
      state: "live",
      work: {
        type: "pm_task", id, projectId: str(o.projectId), status: str(o.status) ?? "", isDone: o.isDone === true,
        responsibleName: str(o.responsibleName),
      },
    };
  }
  if (o.type === "change_request") {
    return { state: "live", work: { type: "change_request", id, status: str(o.status) ?? "", route: str(o.route) } };
  }
  return { state: "unknown" };
}

function companyRef(v: unknown): CompanyRef | null {
  const o = obj(v);
  const id = o ? str(o.id) : null;
  return o && id ? { id, name: str(o.name) ?? "Another company" } : null;
}

function requesterUnitRef(v: unknown): { id: string; name: string } | null {
  const o = obj(v);
  const name = o ? str(o.name) : null;
  return o && name ? { id: str(o.id) ?? "", name } : null;
}

/** The price state only: two fields from a closed vocabulary. Anything else on the object (an amount, a currency, a contract) is
 *  never copied, and a value outside the vocabulary reads as "cannot be read" (null), never as a guess. */
export function normalizePrice(v: unknown): RequestPrice | null {
  const o = obj(v);
  if (!o) return null;
  const impact = (PRICE_IMPACTS as readonly unknown[]).includes(o.impact) ? (o.impact as PriceImpact) : null;
  if (!impact) return null;
  const agreement = (PRICE_AGREEMENTS as readonly unknown[]).includes(o.agreement) ? (o.agreement as PriceAgreement) : null;
  return { impact, agreement: impact === "changes_price" ? agreement : null };
}

/** `outbound`: a row from the sender's routes (§60.5) rather than §32's. */
export function normalizeRequestRow(raw: unknown, opts: { outbound?: boolean } = {}): RequestRow | null {
  const r = obj(raw);
  if (!r) return null;
  const outbound = opts.outbound === true;
  const id = str(r.id);
  const kind = r.kind === "assets" || r.kind === "engineering" ? r.kind : null;
  if (!id || !kind) return null;
  const by = obj(r.requestedBy);
  const camp = obj(r.campaign);
  const campId = camp ? str(camp.id) : null;
  return {
    id,
    kind,
    title: str(r.title) ?? "(untitled)",
    status: str(r.status) ?? "open",
    neededBy: str(r.neededBy),
    createdAt: str(r.createdAt),
    closedAt: str(r.closedAt),
    fromUnit: unitRef(r.fromUnit, outbound),
    toUnit: unitRef(r.toUnit, outbound) ?? { id: "", name: null, unitMissing: true },
    requestedBy: { id: (by && str(by.id)) ?? "", name: (by && str(by.name)) ?? "Unknown" },
    campaign: camp && campId ? { id: campId, name: str(camp.name) ?? "(unnamed)", partId: str(camp.partId) ?? "" } : null,
    work: normalizeWork(r.work, outbound),
    assetCount: count(r.assetCount),
    requestingCompany: companyRef(r.requestingCompany),
    requesterUnit: requesterUnitRef(r.requesterUnit),
    client: companyRef(r.client),
    receivingCompany: outbound ? companyRef(r.receivingCompany) ?? { id: "", name: "Another company" } : null,
    routeId: outbound ? str(r.routeId) : null,
    price: outbound && kind === "engineering" ? normalizePrice(r.price) : null,
  };
}

export function normalizeRequestDetail(raw: unknown, opts: { outbound?: boolean } = {}): RequestDetail | null {
  const row = normalizeRequestRow(raw, opts);
  const r = obj(raw);
  if (!row || !r) return null;
  const assets = (Array.isArray(r.assets) ? r.assets : []).flatMap((a): RequestAsset[] => {
    const o = obj(a);
    const id = o ? str(o.id) : null;
    return o && id ? [{ id, name: str(o.name) ?? id, contentType: str(o.contentType) ?? "", href: str(o.href) ?? "" }] : [];
  });
  return { ...row, brief: str(r.brief) ?? "", form: obj(r.form) ?? {}, declineReason: str(r.declineReason), assets };
}

export function normalizeSummary(raw: unknown): RequestSummary | null {
  const r = obj(raw);
  const inc = r ? obj(r.incoming) : null;
  const sent = r ? obj(r.sent) : null;
  if (!inc || !sent || typeof inc.open !== "number" || typeof sent.open !== "number") return null;
  return { incoming: { open: inc.open, oldestOpenAt: str(inc.oldestOpenAt) }, sent: { open: sent.open } };
}

// ── DW-10e: requests across group companies (docs/FRONTEND-BFF-CONTRACT.md §60) ──────────────────────────────

/** DW-D40: `company` = everything the company sent (the caller is a manager or company admin there); `own` = only what the caller sent. */
export type OutboundScope = "company" | "own";

export interface OutboundSummary { scope: OutboundScope; sent: { open: number } }

/** `GET requests/outbound/summary` (§60.5). A missing or unknown scope is a broken answer, not a guess at `own`. */
export function normalizeOutboundSummary(raw: unknown): OutboundSummary | null {
  const r = obj(raw);
  const sent = r ? obj(r.sent) : null;
  if (!r || !sent || typeof sent.open !== "number" || !Number.isFinite(sent.open) || sent.open < 0) return null;
  if (r.scope !== "company" && r.scope !== "own") return null;
  return { scope: r.scope, sent: { open: sent.open } };
}

/** One route of the active company (§60.5 `GET requests/routes`): the requesting company may send `kind` requests to `unit` of `company`. */
export interface RequestRoute { routeId: string; kind: RequestKind; company: CompanyRef; unit: { name: string } }
export interface RoutesRead { enabled: boolean; routes: RequestRoute[] }

/** A 200 that is not `{enabled, routes[]}` is a broken read (null), so a page never reads it as "no routes". A route that is not
 *  readable is dropped alone. */
export function normalizeRoutes(raw: unknown): RoutesRead | null {
  const r = obj(raw);
  if (!r || typeof r.enabled !== "boolean" || !Array.isArray(r.routes)) return null;
  const routes = r.routes.flatMap((x): RequestRoute[] => {
    const o = obj(x);
    const routeId = o ? str(o.routeId) : null;
    const kind = o && (o.kind === "assets" || o.kind === "engineering") ? o.kind : null;
    const company = o ? companyRef(o.company) : null;
    const unit = o ? obj(o.unit) : null;
    const unitName = unit ? str(unit.name) : null;
    return routeId && kind && company && unitName ? [{ routeId, kind, company, unit: { name: unitName } }] : [];
  });
  return { enabled: r.enabled, routes };
}

/** "To Creatives · Gaia Digital Agency": the route as the form and the chooser name it. */
export const routeToText = (r: Pick<RequestRoute, "company" | "unit">): string => `To ${r.unit.name} · ${r.company.name}`;

/** The quick action's words (§60.9): "Ask Creatives at Gaia Digital Agency for assets", or "Ask Web Dev at Gaia Digital Agency". */
export const routeAskLabel = (r: Pick<RequestRoute, "kind" | "company" | "unit">): string =>
  `Ask ${r.unit.name} at ${r.company.name}${r.kind === "assets" ? " for assets" : ""}`;

export const routeHref = (routeId: string): string => `/requests/new?route=${encodeURIComponent(routeId)}`;

/** The route a `?route=` names, among the routes the company has. Null when it is not one of them. */
export function findRoute(routes: readonly RequestRoute[], raw: string | string[] | undefined): RequestRoute | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ? routes.find((r) => r.routeId === v) ?? null : null;
}

/** A row the sender's routes returned (it names the company that takes it), as opposed to §32's. */
export const isOutboundRow = (r: Pick<RequestRow, "receivingCompany">): boolean => !!r.receivingCompany;

/** A row on the RECEIVING side that another company asked for (§60.6). */
export const isAcrossIncoming = (r: Pick<RequestRow, "requestingCompany">): boolean => !!r.requestingCompany;

/** Where a row opens: the sender's page for a request to another company, else the ordinary request page. */
export const requestHref = (r: Pick<RequestRow, "id" | "receivingCompany">): string =>
  isOutboundRow(r) ? `/requests/outbound/${encodeURIComponent(r.id)}` : `/requests/${encodeURIComponent(r.id)}`;

/** The row's receiver: "To Creatives · Gaia Digital Agency" for another company, else the department's name (§60.9). */
export function toText(r: Pick<RequestRow, "toUnit" | "receivingCompany">): string {
  return r.receivingCompany ? `To ${unitText(r.toUnit)} · ${r.receivingCompany.name}` : unitText(r.toUnit);
}

/** Who asked, on the receiving side: "Viceroy · Front Office" for another company's request, else the department's name (§60.6). */
export function fromText(r: Pick<RequestRow, "fromUnit" | "requestingCompany" | "requesterUnit">): string {
  if (!r.requestingCompany) return unitText(r.fromUnit);
  return r.requesterUnit?.name ? `${r.requestingCompany.name} · ${r.requesterUnit.name}` : r.requestingCompany.name;
}

/** The price state as a sentence (§60.9). A STATE: this takes no amount and draws none. `provider` is the company doing the work,
 *  `requester` the company that asked. */
export function priceText(price: RequestPrice | null | undefined, names: { provider: string; requester: string }): string {
  if (!price) return "The price state cannot be read.";
  if (price.impact === "unassessed") return "Not assessed yet";
  if (price.impact === "none") return "No price change";
  switch (price.agreement) {
    case "awaiting_signature": return `Waiting for ${names.requester}'s signature in ${names.provider}'s client portal`;
    case "signed": return "Price agreed";
    case "closed": return `The price agreement was declined or withdrawn; ${names.provider} will re-assess`;
    default: return `${names.provider} is preparing a price agreement`;
  }
}

/** A price agreement that is a draft, sent or signed holds the request: it cannot be cancelled while one is live (§60.5). */
export const hasLiveAgreement = (price: RequestPrice | null | undefined): boolean =>
  !!price && price.impact === "changes_price"
  && (price.agreement === "preparing" || price.agreement === "awaiting_signature" || price.agreement === "signed");

export interface OutboundActionAudience {
  /** The signed-in person sent it (`requestedBy.id`). */
  isRequester: boolean;
  /** A manager or company admin of the requesting company (`work_request.read_across`, the nearest mirror of §36's `cancel`). */
  canManage: boolean;
}

/** Cancel on the sender's page (§60.9): the requester or the company's manager or admin, while `open`; an engineering request only
 *  while its change request is `new` and no price agreement is live. Cosmetic: the server decides (an owner without the manager
 *  role reads 403 as a sentence). */
export function outboundActions(
  req: Pick<RequestRow, "kind" | "status" | "work" | "price">, who: OutboundActionAudience,
): { cancel: boolean } {
  const open = req.status === "open";
  const assets = req.kind === "assets";
  const crNew = req.work.state === "live" && req.work.work.type === "change_request" && req.work.work.status === "new";
  return { cancel: (who.isRequester || who.canManage) && open && (assets || (crNew && !hasLiveAgreement(req.price))) };
}

/** One file of a request the sender may download (§60.5 `outbound/:id/files`). `url` is set on a link row, which has no bytes. */
export interface OutboundFile { id: string; filename: string; contentType: string; byteSize: number | null; createdAt: string | null; url: string | null }

export function normalizeOutboundFiles(raw: unknown): OutboundFile[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((f): OutboundFile[] => {
    const o = obj(f);
    const id = o ? str(o.id) : null;
    if (!o || !id) return [];
    return [{
      id, filename: str(o.filename) ?? id, contentType: str(o.contentType) ?? "",
      byteSize: typeof o.byteSize === "number" && Number.isFinite(o.byteSize) ? o.byteSize : null, createdAt: str(o.createdAt), url: str(o.url),
    }];
  });
}

/** The two proxies the sender's browser downloads through (`app/api/requests/outbound/...`): the platform path itself is not callable. */
export const outboundAssetHref = (requestId: string, assetId: string): string =>
  `/api/requests/outbound/${encodeURIComponent(requestId)}/assets/${encodeURIComponent(assetId)}`;
export const outboundFileHref = (requestId: string, fileId: string): string =>
  `/api/requests/outbound/${encodeURIComponent(requestId)}/files/${encodeURIComponent(fileId)}`;

/** The body of `POST requests/outbound` (§60.5). The route names the department, so there is no `toUnitId` and no campaign part. */
export interface OutboundRequestBody {
  routeId: string;
  kind: RequestKind;
  title: string;
  brief?: string;
  neededBy?: string;
  form: Record<string, unknown>;
}

/** What the form's draft check produced, as the outbound body: the route replaces the department, and a campaign part is never sent. */
export function outboundBodyFrom(routeId: string, body: RequestBody): OutboundRequestBody {
  return {
    routeId, kind: body.kind, title: body.title,
    ...(body.brief !== undefined ? { brief: body.brief } : {}),
    ...(body.neededBy !== undefined ? { neededBy: body.neededBy } : {}),
    form: body.form,
  };
}

/** Merge the §32 read with the sender read into one list, newest first (§60.9). */
export function mergeNewestFirst(...lists: readonly (readonly RequestRow[])[]): RequestRow[] {
  const t = (r: RequestRow) => {
    const v = Date.parse(r.createdAt ?? "");
    return Number.isNaN(v) ? 0 : v;
  };
  return lists.flat().slice().sort((a, b) => t(b) - t(a));
}

// ── words for the page ───────────────────────────────────────────────────────────────────────────

const GONE_UNIT = "A department that is no longer in the org chart";

export function unitText(u: UnitRef | null): string {
  if (!u) return "No department";
  return u.unitMissing || !u.name ? GONE_UNIT : u.name;
}

export const requestKindLabel = (k: RequestKind): string => (k === "assets" ? "Asset request" : "Engineering request");

export function requestStatusLabel(status: string): string {
  return (REQUEST_STATUS_LABEL as Record<string, string>)[status] ?? humanize(status);
}

/** "in_progress" -> "In progress". */
export function humanize(s: string): string {
  const t = s.replace(/[_\s]+/g, " ").trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** "Marketing to Creatives". On the receiving side of another company's request (DW-10e), "Viceroy · Front Office to Creatives". */
export function routeText(r: Pick<RequestRow, "fromUnit" | "toUnit" | "requestingCompany" | "requesterUnit">): string {
  return `${fromText(r)} to ${unitText(r.toUnit)}`;
}

/** The live work item in a sentence. A deleted item says so; an unreadable one says it cannot be read. */
export function workText(w: WorkState): string {
  if (w.state === "removed") return "The work item was removed";
  if (w.state === "unknown") return "The work item cannot be read";
  const work = w.work;
  if (work.type === "pm_task") {
    const status = work.isDone ? "Done" : work.status ? humanize(work.status) : "Status unknown";
    return `${status}. ${work.responsibleName ? `Responsible: ${work.responsibleName}` : "Nobody is responsible yet"}`;
  }
  const route = work.route ? ` (${humanize(work.route)})` : "";
  return `Change request ${work.status ? humanize(work.status).toLowerCase() : "status unknown"}${route}`;
}

/** Where a person goes to see the work item: the PM task, or the receiver's Requests page for a change request. */
export function workLink(row: Pick<RequestRow, "toUnit">, w: WorkState): { href: string; label: string } | null {
  if (w.state !== "live") return null;
  if (w.work.type === "pm_task") return { href: `/tasks/${encodeURIComponent(w.work.id)}`, label: "Open the task" };
  if (!row.toUnit.id || row.toUnit.unitMissing) return null;
  return { href: `/departments/${encodeURIComponent(row.toUnit.id)}/requests`, label: "Open in the department's Requests" };
}

/** Where a staff browser fetches a delivered asset's bytes (`app/api/creative-assets/[assetId]`, a proxy of the platform's
 *  creative-asset content route; the wire's own `href` is the platform's path, which the browser cannot call). */
export const assetDownloadHref = (assetId: string): string => `/api/creative-assets/${encodeURIComponent(assetId)}`;

/** "Needed by 12 Oct 2026", or a quiet dash. */
export const neededByText = (d: string | null): string => (d ? formatDate(d) : "No date");

/** An http(s) link is the only kind a reference may render as (plan: links in references only http and https). */
export function safeHttpHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > LIMITS.url) return null;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}

/** The form as lines of plain text for the request page (§32.4 shapes; anything else is shown as nothing, never trusted). */
export function formSummary(kind: RequestKind, form: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (kind === "assets") {
    const ds = Array.isArray(form.deliverables) ? form.deliverables : [];
    ds.forEach((d, i) => {
      const o = obj(d);
      if (!o) return;
      const f = (DELIVERABLE_FORMAT_LABEL as Record<string, string>)[String(o.format)] ?? String(o.format ?? "");
      const size = typeof o.size === "string" && o.size ? `, ${o.size}` : "";
      out.push({ label: `Deliverable ${i + 1}`, value: `${typeof o.quantity === "number" ? o.quantity : "?"} x ${f}${size}` });
    });
    if (typeof form.channel === "string" && form.channel) out.push({ label: "Channel", value: form.channel });
    if (typeof form.notes === "string" && form.notes) out.push({ label: "Notes", value: form.notes });
  } else {
    const k = (ENGINEERING_KIND_LABEL as Record<string, string>)[String(form.kind)];
    if (k) out.push({ label: "Kind", value: k });
  }
  return out;
}

/** References and the affected URL, as the links the page may draw (http and https only) plus any that are not. */
export function formLinks(form: Record<string, unknown>): { label: string; href: string | null; text: string }[] {
  const out: { label: string; href: string | null; text: string }[] = [];
  const refs = Array.isArray(form.references) ? form.references : [];
  refs.forEach((r, i) => {
    if (typeof r === "string") out.push({ label: `Reference ${i + 1}`, href: safeHttpHref(r), text: r });
  });
  if (typeof form.affectedUrl === "string" && form.affectedUrl) {
    out.push({ label: "Affected page", href: safeHttpHref(form.affectedUrl), text: form.affectedUrl });
  }
  return out;
}

// ── the request form (§32.4 + §32.1 + §32.5) and its validator ────────────────────────────────────

export interface DeliverableDraft { format: string; size: string; quantity: string }

/** What a person typed: every value a string, exactly as the inputs hold it. */
export interface RequestDraft {
  kind: RequestKind;
  toUnitId: string;
  title: string;
  brief: string;
  neededBy: string;
  campaignPartId: string;
  assets: { deliverables: DeliverableDraft[]; channel: string; references: string; notes: string };
  engineering: { kind: string; affectedUrl: string };
}

export interface RequestBody {
  kind: RequestKind;
  toUnitId: string;
  title: string;
  brief?: string;
  neededBy?: string;
  campaignPartId?: string;
  form: Record<string, unknown>;
}

/** Field name -> sentence. Field names are the server's: `title`, `form.deliverables[0].quantity`, `form.references`. */
export type FieldErrors = Record<string, string>;
export type DraftCheck = { ok: true; body: RequestBody } | { ok: false; errors: FieldErrors };

export const emptyDeliverable = (): DeliverableDraft => ({ format: "", size: "", quantity: "1" });

/** 'YYYY-MM-DD' and a real calendar date (the server's `parseDateOnly`). */
export function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const stripNul = (s: string): string => s.replace(/\u0000/g, "");

/** `http(s)`, parseable and at most 500 characters (the server's `parseHttpUrl`). */
export function isHttpUrl(v: string): boolean {
  const t = stripNul(v).trim();
  return t.length > 0 && t.length <= LIMITS.url && safeHttpHref(t) !== null;
}

/** The URLs in a one-per-line box, blank lines dropped. */
export function referenceLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Check a draft against §32.4 and the title, brief and date rules, every bound. Collects ALL mistakes so the form can
 *  show them together; on success returns the exact body `POST requests` takes (empty optionals left out). */
export function validateRequestDraft(d: RequestDraft): DraftCheck {
  const errors: FieldErrors = {};
  const toUnitId = d.toUnitId.trim();
  if (!toUnitId) errors.toUnitId = "There is no receiving department to send this to.";

  const title = stripNul(d.title).trim();
  if (!title) errors.title = "Give the request a title.";
  else if (title.length > LIMITS.title) errors.title = `A title is 1 to ${LIMITS.title} characters (this one is ${title.length}).`;

  if (d.brief.length > LIMITS.brief) errors.brief = `The brief is too long (${LIMITS.brief.toLocaleString("en-US")} characters at most; this one is ${d.brief.length.toLocaleString("en-US")}).`;

  const neededBy = d.neededBy.trim();
  if (neededBy && !isRealDate(neededBy)) errors.neededBy = "Enter a real calendar date.";

  let form: Record<string, unknown> = {};
  if (d.kind === "assets") {
    const a = d.assets;
    const items = a.deliverables;
    if (items.length < 1 || items.length > LIMITS.deliverables) {
      errors["form.deliverables"] = `List 1 to ${LIMITS.deliverables} deliverables.`;
    }
    const deliverables = items.map((it, i) => {
      const at = `form.deliverables[${i}]`;
      if (!(DELIVERABLE_FORMATS as readonly string[]).includes(it.format)) errors[`${at}.format`] = "Choose a format.";
      const size = stripNul(it.size).trim();
      if (size.length > LIMITS.size) errors[`${at}.size`] = `A size is at most ${LIMITS.size} characters.`;
      const q = it.quantity.trim();
      const qn = /^\d+$/.test(q) ? Number(q) : NaN;
      if (!Number.isInteger(qn) || qn < 1 || qn > LIMITS.quantity) errors[`${at}.quantity`] = `A quantity is a whole number from 1 to ${LIMITS.quantity}.`;
      return { format: it.format, size, quantity: qn };
    });
    const channel = stripNul(a.channel).trim();
    if (channel.length > LIMITS.channel) errors["form.channel"] = `A channel is at most ${LIMITS.channel} characters.`;
    const refs = referenceLines(a.references);
    if (refs.length > LIMITS.references) errors["form.references"] = `List at most ${LIMITS.references} reference links.`;
    else {
      const badAt = refs.findIndex((r) => !isHttpUrl(r));
      if (badAt >= 0) errors["form.references"] = `Reference ${badAt + 1} must be an http or https link of at most ${LIMITS.url} characters.`;
    }
    if (a.notes.length > LIMITS.notes) errors["form.notes"] = `Notes are at most ${LIMITS.notes.toLocaleString("en-US")} characters (these are ${a.notes.length.toLocaleString("en-US")}).`;
    form = {
      deliverables,
      ...(channel ? { channel } : {}),
      ...(refs.length > 0 ? { references: refs.map((r) => stripNul(r).trim()) } : {}),
      ...(a.notes.trim() ? { notes: a.notes } : {}),
    };
  } else {
    const e = d.engineering;
    if (!(ENGINEERING_KINDS as readonly string[]).includes(e.kind)) errors["form.kind"] = "Choose what kind of change this is.";
    const url = stripNul(e.affectedUrl).trim();
    if (url && !isHttpUrl(url)) errors["form.affectedUrl"] = `The affected page must be an http or https link of at most ${LIMITS.url} characters.`;
    form = { kind: e.kind, ...(url ? { affectedUrl: url } : {}) };
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      kind: d.kind,
      toUnitId,
      title,
      ...(d.brief.trim() ? { brief: d.brief } : {}),
      ...(neededBy ? { neededBy } : {}),
      ...(d.campaignPartId.trim() ? { campaignPartId: d.campaignPartId.trim() } : {}),
      form,
    },
  };
}

/** A decline reason: 1 to 2,000 characters after trimming. Null when fine, else the sentence. */
export function checkDeclineReason(reason: string): string | null {
  const t = stripNul(reason).trim();
  if (!t) return "Say why the request is declined, so the requester knows.";
  if (t.length > LIMITS.reason) return `A reason is at most ${LIMITS.reason.toLocaleString("en-US")} characters (this one is ${t.length.toLocaleString("en-US")}).`;
  return null;
}

/** The assets to deliver: 1 to 20, de-duplicated. Null when fine, else the sentence. */
export function checkDeliverIds(ids: readonly string[]): string | null {
  const n = new Set(ids).size;
  if (n < 1) return "Choose at least one asset from the library.";
  if (n > LIMITS.assetIds) return `Deliver at most ${LIMITS.assetIds} assets at a time.`;
  return null;
}

// ── who is offered what (cosmetic: the server decides) ────────────────────────────────────────────

export interface ActionAudience {
  /** The signed-in person asked for this (`requestedBy.id`). */
  isRequester: boolean;
  /** A manager, or the head of the receiving department (`work_request.decide`, `canInUnit`). */
  canDecide: boolean;
  /** One of the work's assignees. `null` when the task could not be read: then it is not assumed. */
  isAssignee: boolean | null;
}

export interface OfferedActions { cancel: boolean; deliver: boolean; deliverMore: boolean; decline: boolean }

/** Cancel: the requester while `open` (an engineering request only while its change request is still `new`, §32.5).
 *  Deliver and Deliver more: assets only; a manager, the receiving head or an assignee. Decline: assets only, `open`
 *  only; a manager or the receiving head. */
export function requestActions(req: Pick<RequestRow, "kind" | "status" | "work" | "requestingCompany">, who: ActionAudience): OfferedActions {
  const open = req.status === "open";
  const assets = req.kind === "assets";
  const crNew = req.work.state === "live" && req.work.work.type === "change_request" && req.work.work.status === "new";
  const mayDeliver = assets && (who.canDecide || who.isAssignee === true);
  // §60.6: the receiving company cannot cancel another company's request (409 `requester_side_only`); it declines. So a row that
  // another company asked for never offers Cancel here, whoever the viewer is.
  const crossRow = !!req.requestingCompany;
  return {
    cancel: !crossRow && who.isRequester && open && (assets || crNew),
    deliver: mayDeliver && open,
    deliverMore: mayDeliver && req.status === "delivered",
    decline: assets && open && who.canDecide,
  };
}

/** The person ids who are assignees of a PM task: the responsible person and any person assignee (§32.2). */
export function assigneeIdsOf(task: {
  assignee?: { kind?: string; refId?: string; responsibleId?: string | null } | null;
  contributors?: { userId?: string }[];
}): string[] {
  const ids = new Set<string>();
  const a = task.assignee;
  if (a?.responsibleId) ids.add(a.responsibleId);
  if (a?.kind === "person" && a.refId) ids.add(a.refId);
  for (const c of task.contributors ?? []) if (c?.userId) ids.add(c.userId);
  return [...ids];
}

// ── campaign choices for the form ────────────────────────────────────────────────────────────────

export interface PartOption { partId: string; label: string }

/** The campaigns where the RECEIVING department has a live part: the only ones a request can name (a cancelled part is
 *  refused as `campaign_part_invalid`). */
export function partOptions(rows: readonly { id: string; name: string; part: { id: string; status: string } | null }[]): PartOption[] {
  return rows.flatMap((r) => (r.part && r.part.status !== "cancelled" ? [{ partId: r.part.id, label: r.name }] : []));
}

// ── refusals, in words ───────────────────────────────────────────────────────────────────────────

export interface RequestRefusal {
  status: number | null;
  /** The machine code (`form_invalid`, `request_not_open`, ...). Branch on this, never on `message`. */
  reason?: string;
  message: string;
  /** For `form_invalid` and `asset_invalid`: the offending field. */
  field?: string;
  detail?: Record<string, unknown>;
}

/** `form.deliverables[2].quantity` as "Deliverable 3: ..." and the other §32.4 field names. */
export function formFieldText(field: string | undefined): string | null {
  if (!field) return null;
  const d = /^form\.deliverables\[(\d+)\]\.(format|size|quantity)$/.exec(field);
  if (d) {
    const n = Number(d[1]) + 1;
    if (d[2] === "format") return `Deliverable ${n}: choose a format.`;
    if (d[2] === "size") return `Deliverable ${n}: a size is at most ${LIMITS.size} characters.`;
    return `Deliverable ${n}: a quantity is a whole number from 1 to ${LIMITS.quantity}.`;
  }
  if (/^form\.deliverables/.test(field)) return `List 1 to ${LIMITS.deliverables} deliverables.`;
  if (field === "form.channel") return `A channel is at most ${LIMITS.channel} characters.`;
  if (/^form\.references/.test(field)) return `References must be http or https links (at most ${LIMITS.references}, ${LIMITS.url} characters each).`;
  if (field === "form.notes") return `Notes are at most ${LIMITS.notes.toLocaleString("en-US")} characters.`;
  if (field === "form.kind") return "Choose what kind of change this is.";
  if (field === "form.affectedUrl") return `The affected page must be an http or https link of at most ${LIMITS.url} characters.`;
  return null;
}

/** Typed refusals from the §32.5 routes (and the extra codes of §32.10 #6) as plain sentences. */
export function requestErrorText(r: RequestRefusal, opts: { company?: string } = {}): string {
  const d = r.detail ?? {};
  const company = opts.company;
  switch (r.reason) {
    case "body_invalid":
      return "The request could not be read. Reload the page and try again.";
    case "kind_invalid":
      return "That kind of request is not available.";
    case "to_unit_invalid":
      return "The receiving team is not a department of this company's org chart.";
    case "unit_invalid":
      return "That is not a department of this company's org chart.";
    case "title_invalid":
      return `A title is 1 to ${LIMITS.title} characters.`;
    case "brief_invalid":
      return "The brief must be plain text.";
    case "brief_too_long":
      return `The brief is too long (${LIMITS.brief.toLocaleString("en-US")} characters at most).`;
    case "date_invalid":
      return "Enter a real calendar date for needed by.";
    case "campaign_part_invalid":
      return "That campaign part is no longer available. Choose another campaign, or leave it blank.";
    case "form_invalid":
      return formFieldText(r.field) ?? "Something in the request details is not valid. Check the deliverables and links.";
    case "asset_invalid": {
      const invalid = d.invalid;
      if (Array.isArray(invalid) && invalid.length > 0) {
        return `${invalid.length} of the chosen assets ${invalid.length === 1 ? "is" : "are"} no longer in the Asset Library. Reload the page and choose again.`;
      }
      return `Choose 1 to ${LIMITS.assetIds} assets from the Asset Library.`;
    }
    case "reason_invalid":
      return `Give a reason of 1 to ${LIMITS.reason.toLocaleString("en-US")} characters.`;
    case "box_invalid":
    case "status_invalid":
      return "That list filter is not valid.";
    case "request_not_found":
      return "That request no longer exists. Reload the page.";
    case "request_kind_unavailable":
      return "This company cannot take that kind of request, because the module that handles it is turned off.";
    case "wrong_kind_for_action":
      return "That action applies to asset requests only. Engineering requests are handled by Web Dev triage.";
    case "request_not_open": {
      const s = typeof d.status === "string" ? requestStatusLabel(d.status).toLowerCase() : null;
      return s
        ? `This request is ${s}, so it can no longer be changed here. Reload the page.`
        : "This request is no longer open, so it can no longer be changed here. Reload the page.";
    }
    case "already_in_progress":
      return "Web Dev has already accepted this work, so it can no longer be cancelled here.";
    // DW-10e (§60.5): the sender's refusals. `company` is the receiving company's name when the caller knows it from the route.
    case "route_invalid":
      return "Choose one of your company's routes to send this request.";
    case "route_not_found":
      return "Your company can no longer send requests there.";
    case "route_inactive": {
      const s = typeof d.status === "string" ? d.status : "";
      const who = company ?? "That company";
      const why =
        s === "proposed" ? `${who} has not accepted the route yet.`
        : s === "suspended" ? `${who} has paused the route.`
        : s === "revoked" ? `The route to ${who} has been withdrawn.`
        : s === "orphaned" ? `The department there has been removed from the org chart.`
        : s === "changed" ? "The route changed while you were sending. Reload the page and look again."
        : "The route is not active.";
      return `Your company cannot send requests there right now. ${why}`;
    }
    case "route_unit_unavailable":
      return `${company ?? "That company"}'s department is no longer in its org chart, so it cannot take requests. An administrator has to relink or withdraw the route.`;
    case "group_client_missing":
      return `${company ?? "That company"} has not set your company up as a client yet. Ask an administrator.`;
    case "group_client_ambiguous":
      return `${company ?? "That company"} has your company down as a client more than once, so it cannot place the request. Ask an administrator there to merge them.`;
    case "request_routes_disabled":
      return "Requests between group companies are switched off.";
    case "requester_side_only":
      return "Only the company that sent this request can cancel it. Decline it instead, and the requester is told.";
    case "price_agreement_open":
      return "A price agreement is already open for this request, so it can no longer be cancelled here. The receiving team declines it in triage and settles the agreement.";
    case "asset_not_found":
      return "That asset is no longer part of this request.";
    case "file_not_found":
      return "That file is no longer available.";
    case "intake_project_unavailable":
      return "The receiving department's requests project has been removed, so it cannot take requests until it is restored.";
    default:
      break;
  }
  if (r.status === 403) return "You do not have permission to do that.";
  if (r.status === 404) return "That request no longer exists. Reload the page.";
  return r.message || "That did not work. Try again.";
}

/** The figures of a refusal, from `PlatformError.body.detail`. */
export function detailOf(body: unknown): Record<string, unknown> | undefined {
  const o = obj(body);
  const d = o ? obj(o.detail) : null;
  return d ?? undefined;
}

/** What every request write returns: a value, never a thrown refusal, so the UI can say what happened. */
export type RequestResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: string; field?: string };

// ── DW-5d / DW-5e: the receiving department's lists ──────────────────────────────────────────────

/** Which Requests page a department gets: Creatives' incoming asset requests (DW-5d), Web Dev's change-request triage
 *  (MI-05, with DW-5e's origin), or today's page for everyone else. Decided by the workspace KEY, the shell's own match. */
export type RequestsPageView = "creatives" | "web-dev" | "other";
export function requestsPageView(workspaceKey: string): RequestsPageView {
  return workspaceKey === "creatives" ? "creatives" : workspaceKey === "web-dev" ? "web-dev" : "other";
}

/** The delivered ones only, newest delivery first (the server's `closed` also carries declined and cancelled). */
export function deliveredOnly(rows: readonly RequestRow[]): { delivered: RequestRow[]; otherClosed: number } {
  const delivered = rows.filter((r) => r.status === "delivered");
  const time = (r: RequestRow) => {
    const t = Date.parse(r.closedAt ?? r.createdAt ?? "");
    return Number.isNaN(t) ? 0 : t;
  };
  delivered.sort((a, b) => time(b) - time(a));
  return { delivered, otherClosed: rows.length - delivered.length };
}

/** "Today", "1 day", "5 days" since the request was made; a quiet dash when the date is unknown. */
export function ageText(createdAt: string | null, now: Date = new Date()): string {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(t)) return "—";
  const days = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
  return days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;
}

/** A needed-by date strictly before today (the start of `now`'s day). */
export function isNeededByOverdue(neededBy: string | null, now: Date = new Date()): boolean {
  const t = neededBy ? Date.parse(neededBy) : NaN;
  if (Number.isNaN(t)) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return t < startOfToday;
}

/** Where an engineering request came from, keyed by the change request id its work item is (DW-5e's UI-side join). */
export interface RequestOrigin { requestId: string; from: string; person: string }
export function originsByChangeRequest(rows: readonly RequestRow[]): Record<string, RequestOrigin> {
  const out: Record<string, RequestOrigin> = {};
  for (const r of rows) {
    if (r.work.state !== "live" || r.work.work.type !== "change_request") continue;
    out[r.work.work.id] = { requestId: r.id, from: fromText(r), person: r.requestedBy.name };
  }
  return out;
}

// ── DW-10e: the lists that merge §32's read with the sender read (§60.9) ─────────────────────────────

/** A read as the readers answer it (`ReadResult`, structurally; that type is server-only and this file is not). */
type Read<T> = { kind: "ok"; data: T } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };

/** The part of a merged list that could not be read: the person's asks of other departments (§32) or of other companies (§60.5). */
export interface SentFailure { part: "departments" | "companies"; kind: "forbidden" | "unavailable"; reason?: string }

export interface MergedSent {
  /** What the two reads returned, newest first. When a part failed this is the other part alone, and the list says so. */
  rows: RequestRow[];
  /** The sender read's answer (DW-D40), or null when it did not answer. */
  scope: OutboundScope | null;
  /** How many of `rows` are requests to other companies. */
  acrossCount: number;
  failed: SentFailure[];
}

/** One list from the two reads ("My requests", a department's Sent tab). It never shows a shorter list as if it were whole: a part
 *  that failed is reported in `failed`, and the page says which part could not be read (§60.9). */
export function mergeSentReads(
  departments: Read<readonly RequestRow[]>, companies: Read<{ scope: OutboundScope; rows: readonly RequestRow[] }>,
): MergedSent {
  const failed: SentFailure[] = [];
  const part = (which: SentFailure["part"], r: Read<unknown>) => {
    if (r.kind === "forbidden") failed.push({ part: which, kind: "forbidden" });
    else if (r.kind === "unavailable") failed.push({ part: which, kind: "unavailable", reason: r.reason });
  };
  part("departments", departments);
  part("companies", companies);
  const own = departments.kind === "ok" ? departments.data : [];
  const across = companies.kind === "ok" ? companies.data.rows : [];
  return {
    rows: mergeNewestFirst(own, across),
    scope: companies.kind === "ok" ? companies.data.scope : null,
    acrossCount: across.length,
    failed,
  };
}

/** The words over a sent list, from the sender read's scope (DW-D40). In `own` only the caller's requests to other companies are
 *  shown, and the page says so; in `company` the company's managers and administrators see every one it sent. */
export function sentScopeCopy(scope: OutboundScope | null, company: string | null): { title: string; hint: string; note: string | null } {
  const co = company ?? "your company";
  if (scope === "company") {
    return { title: `Requests ${co} sent`, hint: `Asks to other departments, and every request ${co} sent to other companies. You see them all as a manager or administrator.`, note: null };
  }
  return {
    title: "Requests you sent",
    hint: "Asks you made of other departments and of other companies, and where each one stands.",
    note: scope === "own" ? `Only the requests you sent to other companies are shown. Managers and administrators of ${co} see all of them.` : null,
  };
}
