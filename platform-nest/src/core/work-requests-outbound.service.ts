// DW-10e-2 (docs/FRONTEND-BFF-CONTRACT.md §60.4 and §60.5; PERMISSION-CONTRACT §49) — the SENDER's side of a request sent
// to another group company: parsing, the read tier, the sender's row shape and every SQL statement a sender route runs.
// The routes are in work-requests-outbound.controller.ts; this file holds the rules so they are unit-testable.
//
// In this file H is the REQUESTING company (the URL's :tenantId) and P a RECEIVING company (the agency). The request row,
// its work and its files live in P (`work_requests.tenant_id = P`). A sender reads them like this, and only like this:
//
//   1. The set of P's is read FIRST, in H's own scope: the routing assignments whose TARGET is H, any status (so history stays
//      readable). It is bounded, and nobody can guess a company into it (`loadRouteProviders`).
//   2. Each P is then read in P's scope ALONE (`withTenants([P])`), one company per statement, never a two-company tenant set
//      and never `crossRoot`, with an explicit `r.tenant_id = $1 AND r.requester_tenant_id = $2` predicate (`SENDER_SCOPE`,
//      $1 = P, $2 = H). No RLS policy is widened: `work_requests` stays under `tenant_isolation` alone (§60.3, decision 5).
//   3. DW-D40 and DW-D43 narrow it further: `outboundReadScope` decides, for EVERY sender read, whether the caller reads everything
//      H sent (`company`: `read_across` allowed), what the departments they head in H sent plus their own (`unit`: active lead
//      seats in H's own `positions`, read in H's scope), or only their own (`own`: `r.requested_by = principal`). Any other
//      request is then absent from the lists and 404 by id.
//
// Node ids repeat across companies (`d-webdev`), so a node id is only ever compared inside its own company: `to_unit_id`
// against P's tree in P's scope, `requester_unit_id` against H's tree in H's scope (§60.4 "Tenancy").
//
// A static test (work-requests-outbound.service.test.ts) pins that every statement on `work_requests` in the sender files
// carries `SENDER_SCOPE`, that every `withTenants` call names exactly one company, and that every sender read goes through
// `outboundReadScope`.
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { check, type Resource } from "../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../rbac/principal";
import { loadOrgStructure } from "../modules/reports/person-scope";
import { loadLeadSeatUnits } from "./unit-reach";
import { REQUEST_ROUTE_KEYS } from "./request-routes";
import { isUuidShaped } from "./dept-resolution";
import * as svc from "./work-requests.service";

// ───────────────────────────────────────────── the read tier (DW-D40, DW-D43) ─────────────────────────────────────────────

export type OutboundScope = "company" | "unit" | "own";

/** The caller's read tier over what H sent. `ledUnits` holds the node ids of H the caller heads (each lead seat's unit and its
 *  subtree in H's tree); it is non-empty exactly when `scope` is `unit`, and empty otherwise. */
export interface OutboundTier { scope: OutboundScope; ledUnits: ReadonlySet<string> }

const NO_UNITS: ReadonlySet<string> = new Set<string>();
export const COMPANY_TIER: OutboundTier = Object.freeze({ scope: "company" as const, ledUnits: NO_UNITS });
export const OWN_TIER: OutboundTier = Object.freeze({ scope: "own" as const, ledUnits: NO_UNITS });

/** A head's tier from their seat set: `unit` with the set when it holds anything, else `own`. */
export const headTier = (ledUnits: ReadonlySet<string>): OutboundTier =>
  ledUnits.size > 0 ? { scope: "unit", ledUnits } : OWN_TIER;

/** The act-for rule (pure): the tier is never wider than EITHER side. `company` only when both are; `own` when either is;
 *  otherwise `unit` over the intersection of the two seat sets (a `company` side contributes the other side's set), and an empty
 *  intersection is `own`. */
export function narrowTier(a: OutboundTier, b: OutboundTier): OutboundTier {
  if (a.scope === "own" || b.scope === "own") return OWN_TIER;
  if (a.scope === "company") return b;
  if (b.scope === "company") return a;
  return headTier(new Set([...a.ledUnits].filter((u) => b.ledUnits.has(u))));
}

/** Does the tier reach a request sent from `requesterUnitId`, beyond the caller's own (which every tier reads)? */
export function tierReachesUnit(tier: OutboundTier, requesterUnitId: string | null): boolean {
  if (tier.scope === "company") return true;
  return tier.scope === "unit" && requesterUnitId !== null && tier.ledUnits.has(requesterUnitId);
}

/** One principal's own tier, act-for aside: `company` when `read_across` allows; else `unit` when they hold an active lead seat
 *  in H (`loadLeadSeatUnits`: H's own `positions.is_lead`, read in H's scope, never the `org_unit_lead` role, whose grant carries
 *  no company); else `own`. */
async function tierOf(principal: Principal, tenantId: string, resource: Resource): Promise<OutboundTier> {
  if ((await check(principal, resource, "read_across")).allow) return COMPANY_TIER;
  if (!principal.userId) return OWN_TIER;
  const userId = principal.userId;
  const led = await withTenants([tenantId], async (c) => loadLeadSeatUnits(c, tenantId, userId, await loadOrgStructure(c, tenantId)));
  return headTier(led);
}

/** DW-D40 and DW-D43: THE one helper every sender read goes through. Three tiers, widest first:
 *   - `company`: the caller may read EVERY request H sent (`read_across` on `{work_request, H}`: H's company_admin and manager,
 *     the permission-native `owner` through the mirror, `platform_admin`);
 *   - `unit`: the caller heads departments of H (an active lead seat in H's own `positions`); they read their own requests plus
 *     every one whose `requester_unit_id` is in `ledUnits`;
 *   - `own`: everyone else, the caller's own requests only (which §36's `read` already covers).
 *
 *  A soft probe through `check()`, not `authorize()`: a narrower tier is a narrowing, not a refusal, so it must not file a denial
 *  row every time a member opens their list. The delegation half of `authorize()` is mirrored: an `x-act-for` caller's tier is
 *  never wider than the acting human's (`narrowTier`). A Cerbos or database failure is NOT swallowed into `own`: a failed read is
 *  a failure, never a shorter list presented as whole. */
export async function outboundReadScope(principal: Principal, tenantId: string, id?: string): Promise<OutboundTier> {
  const resource: Resource = { kind: "work_request", tenantId, ...(id ? { id } : {}) };
  const mine = await tierOf(principal, tenantId, resource);
  if (mine.scope === "own") return OWN_TIER;
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const human = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    if (!human) return OWN_TIER;
    return narrowTier(mine, await tierOf({ ...human, via: principal.via }, tenantId, resource));
  }
  return mine;
}

// ───────────────────────────────────────────── pure parsing (§60.5) ─────────────────────────────────────────────

const bad = (reason: string, message: string, field?: string) => new svc.WorkRequestRuleError(400, reason, message, field);

export interface OutboundCreateInput {
  routeId: string;
  title: string;
  brief: string;
  neededBy: string | null;
  /** The `kind` the body named, or `null`. When named, the form was already parsed with it (`form` is set). */
  kind: svc.RequestKind | null;
  /** The parsed form when `kind` was named; otherwise `null` and `rawForm` is parsed by the route's kind. */
  form: svc.RequestForm | null;
  rawForm: unknown;
}

/** `POST requests/outbound {routeId, title, brief?, neededBy?, form, kind?}`. Reads ONLY these fields; `requested_by`, the
 *  department, the client, the project and both companies are server-derived. `toUnitId` and `campaignPartId` are refused
 *  outright (the route names the department; a cross request links no campaign part, §60.8). A null `campaignPartId` or
 *  `toUnitId` is "none" and passes, as §32's parser treats a null part.
 *
 *  The form's rules depend on the kind, which is the ROUTE's: when the body names `kind`, the form is parsed here with it
 *  (and the route must then match, 400 `kind_invalid`); otherwise it is parsed after the route resolved
 *  (`parseFormForKind`). */
export function parseOutboundCreate(body: unknown): OutboundCreateInput {
  if (!svc.isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  const title = typeof body.title === "string" ? svc.plain(body.title).trim() : "";
  if (!title || title.length > svc.TITLE_MAX) throw bad("title_invalid", `title must be 1 to ${svc.TITLE_MAX} characters`, "title");
  let brief = "";
  if (body.brief !== undefined) {
    if (typeof body.brief !== "string") throw bad("brief_invalid", "brief must be a string", "brief");
    if (body.brief.length > svc.BRIEF_MAX) throw bad("brief_too_long", `brief must be at most ${svc.BRIEF_MAX} characters`, "brief");
    brief = svc.plain(body.brief);
  }
  const neededBy = body.neededBy === undefined ? null : svc.parseDateOnly(body.neededBy, "neededBy");
  if (typeof body.routeId !== "string" || !isUuidShaped(body.routeId)) {
    throw bad("route_invalid", "routeId must be the id of one of your company's request routes", "routeId");
  }
  let kind: svc.RequestKind | null = null;
  if (body.kind !== undefined) {
    if (typeof body.kind !== "string" || !(svc.REQUEST_KINDS as readonly string[]).includes(body.kind)) {
      throw bad("kind_invalid", `kind must be one of ${svc.REQUEST_KINDS.join("|")}, and the route's own`, "kind");
    }
    kind = body.kind as svc.RequestKind;
  }
  if (body.toUnitId !== undefined && body.toUnitId !== null) {
    throw bad("to_unit_invalid", "a request to another company goes to its route's department: send routeId, not toUnitId", "toUnitId");
  }
  if (body.campaignPartId !== undefined && body.campaignPartId !== null) {
    throw bad("campaign_part_invalid", "a request to another company links no campaign part", "campaignPartId");
  }
  const form = kind ? parseFormForKind(kind, body.form) : null;
  return { routeId: body.routeId.toLowerCase(), title, brief, neededBy, kind, form, rawForm: body.form };
}

/** §32.4's form rules for one kind. */
export function parseFormForKind(kind: svc.RequestKind, raw: unknown): svc.RequestForm {
  return kind === "assets" ? svc.parseAssetsForm(raw) : svc.parseEngineeringForm(raw);
}

export type OutboundBox = "mine" | "sent" | "all";
export interface OutboundListQuery {
  box: OutboundBox;
  unitId: string | null;
  status: "open" | "closed" | "all";
  kind: svc.RequestKind | null;
}

/** `GET requests/outbound?box=mine|sent|all&unitId=&status=&kind=`. `unitId` is required for `sent` (whether it is a department
 *  of H is the org check's job); the default status is `open`. */
export function parseOutboundListQuery(q: { box?: unknown; unitId?: unknown; status?: unknown; kind?: unknown }): OutboundListQuery {
  if (q.box !== "mine" && q.box !== "sent" && q.box !== "all") throw bad("box_invalid", "box must be one of mine|sent|all", "box");
  const status = q.status === undefined || q.status === "" ? "open" : q.status;
  if (status !== "open" && status !== "closed" && status !== "all") throw bad("status_invalid", "status must be one of open|closed|all", "status");
  let kind: svc.RequestKind | null = null;
  if (q.kind !== undefined && q.kind !== "") {
    if (typeof q.kind !== "string" || !(svc.REQUEST_KINDS as readonly string[]).includes(q.kind)) {
      throw bad("kind_invalid", `kind must be one of ${svc.REQUEST_KINDS.join("|")}`, "kind");
    }
    kind = q.kind as svc.RequestKind;
  }
  const unitId = typeof q.unitId === "string" && q.unitId.trim() ? q.unitId.trim() : null;
  if (q.box === "sent" && !unitId) throw bad("unit_invalid", "unitId (a department of your company) is required for box=sent", "unitId");
  return { box: q.box, unitId: q.box === "sent" ? unitId : null, status, kind };
}

// ───────────────────────────────────────────── the price state (§60.5, §60.6a) ─────────────────────────────────────────────

export type PriceImpact = "unassessed" | "none" | "changes_price";
export type PriceAgreement = "preparing" | "awaiting_signature" | "signed" | "closed";
export interface PriceState { impact: PriceImpact; agreement: PriceAgreement | null }

/** The agreement's STATE, never its value, currency, id or terms. `preparing` while the contract is a draft,
 *  `awaiting_signature` once sent, `signed`, and `closed` when it was declined, voided, expired or is unreadable (P re-assesses
 *  at triage). */
export function agreementState(contractStatus: string | null): PriceAgreement {
  if (contractStatus === "draft") return "preparing";
  if (contractStatus === "sent") return "awaiting_signature";
  if (contractStatus === "signed") return "signed";
  return "closed";
}

/** `price` of the sender's row: engineering only (`null` for assets and for an engineering request whose change request is
 *  gone). `agreement` is set only when the impact is `changes_price`. An unknown impact reads as `unassessed`. */
export function priceState(kind: string, crPresent: boolean, impact: string | null, contractStatus: string | null): PriceState | null {
  if (kind !== "engineering" || !crPresent) return null;
  const i: PriceImpact = impact === "none" || impact === "changes_price" ? impact : "unassessed";
  return { impact: i, agreement: i === "changes_price" ? agreementState(contractStatus) : null };
}

/** §60.5: a cancel of an engineering request is refused while its change request carries a LIVE price agreement (a draft, a
 *  sent or a signed amendment): the receiver declines it in triage and settles the agreement in Contracts & billing (PV4-04's
 *  `amendment_exists` rule). A declined, void or expired one does not hold the cancel. Fails closed on a pointer to a contract
 *  whose status reads as live, whatever the recorded impact. */
export function liveAgreement(amendmentContractId: string | null, contractStatus: string | null): PriceAgreement | null {
  if (!amendmentContractId) return null;
  if (contractStatus === "draft" || contractStatus === "sent" || contractStatus === "signed") return agreementState(contractStatus);
  return null;
}

// ───────────────────────────────────────────── the sender's row (§60.5) ─────────────────────────────────────────────

export interface Company { id: string; name: string | null }

/** §60.5 "The sender's row": §32.5's row with the receiver's ids taken out. `toUnit` is named from P's tree (read in P's
 *  scope with the row), `fromUnit` is the requester's department named from H's tree, `campaign` is always `null`, `work`
 *  carries progress and no id, and `price` a state and never an amount. A test pins the exact key set. */
export function shapeOutbound(
  r: svc.RequestRow, receiving: Company, indexP: Map<string, svc.OrgUnitInfo>, indexH: Map<string, svc.OrgUnitInfo>,
) {
  let work: Record<string, unknown> | null = null;
  if (r.kind === "assets" && r.t_id) {
    work = { type: "pm_task", status: r.t_status, isDone: r.t_is_done === true, responsibleName: r.t_responsible_name };
  } else if (r.kind === "engineering" && r.cr_id) {
    work = { type: "change_request", status: r.cr_status };
  }
  const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
  return {
    id: r.id, kind: r.kind, title: r.title, status: r.status, neededBy: r.needed_by,
    createdAt: iso(r.created_at), closedAt: iso(r.closed_at),
    receivingCompany: { id: receiving.id, name: receiving.name },
    routeId: r.service_assignment_id,
    toUnit: svc.unitView(indexP, r.to_unit_id),
    fromUnit: r.requester_unit_id ? svc.unitView(indexH, r.requester_unit_id) : null,
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    campaign: null,
    work,
    price: priceState(r.kind, r.cr_id !== null, r.cr_price_impact, r.amendment_status),
    assetCount: r.asset_count,
  };
}
export type OutboundRow = ReturnType<typeof shapeOutbound>;

/** The detail's asset link: the SENDER's download route, never the receiver's creative route (§60.5). */
export const outboundAssetHref = (tenantId: string, requestId: string, assetId: string): string =>
  `/api/${tenantId}/requests/outbound/${requestId}/assets/${assetId}/content`;

// ───────────────────────────────────────────── SQL (one company per statement) ─────────────────────────────────────────────

/** The predicate EVERY sender statement on `work_requests` carries: $1 = the receiving company P (the transaction's ONLY
 *  tenant), $2 = the requesting company H. */
export const SENDER_SCOPE = "r.tenant_id = $1 AND r.requester_tenant_id = $2 AND r.deleted_at IS NULL";

/** The receiving companies H can have sent requests to: every routing assignment whose TARGET is H, any status (a suspended or
 *  revoked route keeps its history readable), read in H's own scope (`sa_select`, the target side). Ordered for a stable
 *  merge. Never a company H could not name: it is read, not taken from input. */
export async function loadRouteProviders(requesterTenantId: string): Promise<Company[]> {
  const { rows } = await withTenants([requesterTenantId], (c) =>
    c.query<{ id: string; name: string | null }>(
      `SELECT DISTINCT sa.provider_tenant_id AS id, co.name
         FROM service_assignments sa JOIN companies co ON co.id = sa.provider_tenant_id
        WHERE sa.target_tenant_id = $1 AND sa.module_key = ANY($2::text[])
        ORDER BY sa.provider_tenant_id`,
      [requesterTenantId, [...REQUEST_ROUTE_KEYS]],
    ),
  );
  return rows;
}

/** The narrowing filter of one sender list, as SQL appended to `SENDER_SCOPE` ($1, $2 taken). `box=mine` and the `own` tier
 *  bind the caller's own rows; the `unit` tier binds the caller's own OR a row sent from a unit they head; `company` binds
 *  nothing more. */
export function outboundFilter(q: OutboundListQuery, tier: OutboundTier, principalId: string): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  const push = (v: unknown) => { args.push(v); return `$${args.length + 2}`; };
  if (q.box === "mine" || tier.scope === "own") parts.push(`r.requested_by = ${push(principalId)}::uuid`);
  else if (tier.scope === "unit") {
    const me = push(principalId);
    parts.push(`(r.requested_by = ${me}::uuid OR r.requester_unit_id = ANY(${push([...tier.ledUnits].sort())}::text[]))`);
  }
  if (q.box === "sent") parts.push(`r.requester_unit_id = ${push(q.unitId)}`);
  if (q.status === "open") parts.push("r.status = 'open'");
  else if (q.status === "closed") parts.push("r.status <> 'open'");
  if (q.kind) parts.push(`r.kind = ${push(q.kind)}`);
  return { sql: parts.map((p) => ` AND ${p}`).join(""), args };
}

/** One provider's rows for one list, newest first, at most `LIST_LIMIT`. Runs on a client inside `withTenants([P])`. */
export async function readOutboundRows(
  c: PoolClient, providerId: string, requesterTenantId: string, filter: { sql: string; args: unknown[] },
): Promise<svc.RequestRow[]> {
  const { rows } = await c.query<svc.RequestRow>(
    `${svc.REQUEST_SELECT} WHERE ${SENDER_SCOPE}${filter.sql} ORDER BY r.created_at DESC, r.id DESC LIMIT ${svc.LIST_LIMIT}`,
    [providerId, requesterTenantId, ...filter.args],
  );
  return rows;
}

/** One row by id at one provider, or null. Runs inside `withTenants([P])`. */
export async function readOutboundRow(c: PoolClient, providerId: string, requesterTenantId: string, requestId: string): Promise<svc.RequestRow | null> {
  const { rows } = await c.query<svc.RequestRow>(
    `${svc.REQUEST_SELECT} WHERE ${SENDER_SCOPE} AND r.id = $3`,
    [providerId, requesterTenantId, requestId],
  );
  return rows[0] ?? null;
}

/** The open requests H sent from one of its departments, at one provider (the summary). Runs inside `withTenants([P])`. */
export async function countOpenFromUnit(
  c: PoolClient, providerId: string, requesterTenantId: string, unitId: string, onlyBy: string | null,
): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_requests r
      WHERE ${SENDER_SCOPE} AND r.status = 'open' AND r.requester_unit_id = $3 AND ($4::uuid IS NULL OR r.requested_by = $4::uuid)`,
    [providerId, requesterTenantId, unitId, onlyBy],
  );
  return rows[0]?.n ?? 0;
}

export interface VisibleOutbound {
  provider: Company;
  row: svc.RequestRow;
  scope: OutboundScope;
}

/** §60.4: the request `requestId` that H sent, as the caller may see it, or `null` (absent, deleted, not H's, or another
 *  person's while the caller's tier is `own`, or `unit` and it was sent from a unit they do not head). Looks at H's providers one
 *  at a time, each in its own scope. The tier is asked only when the row is NOT the caller's own (the sender reads their own with
 *  §36's `read` alone). */
export async function findVisibleOutbound(principal: Principal, requesterTenantId: string, requestId: string): Promise<VisibleOutbound | null> {
  if (!isUuidShaped(requestId)) return null;
  const id = requestId.toLowerCase();
  for (const provider of await loadRouteProviders(requesterTenantId)) {
    const row = await withTenants([provider.id], (c) => readOutboundRow(c, provider.id, requesterTenantId, id));
    if (!row) continue;
    if (row.requested_by === principal.userId) return { provider, row, scope: "own" };
    const tier = await outboundReadScope(principal, requesterTenantId, id);
    return tierReachesUnit(tier, row.requester_unit_id) ? { provider, row, scope: tier.scope } : null;
  }
  return null;
}
