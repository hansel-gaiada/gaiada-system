// DW-5a (docs/FRONTEND-BFF-CONTRACT.md §31) — campaign parts: the money rules, the input validation and the SQL
// of every write, kept out of the controller so the rules are unit-testable and the controller stays a thin
// authorize-then-delegate layer.
//
// Two halves in one file, on purpose:
//   1. PURE rules — parsing, the department check against the org index, and the money arithmetic (all `bigint`,
//      never a float). No DB, no Nest: `agency-campaign-parts.test.ts` drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one
//      `withTenants` transaction (the outbox event rides in that same transaction).
//
// ── THE MONEY LOCK (§31.3 rule 4) ────────────────────────────────────────────────────────────────
// Every write that can change what a campaign's budget is measured against — an allocation, a budget or currency
// change, a part moving out of `cancelled` — starts with `lockCampaign()` (`SELECT … FOR UPDATE` on the campaign
// row). The lock serialises concurrent allocations on ONE campaign: the second transaction waits, then re-reads the
// sum the first one committed. Two allocations that together exceed the budget therefore leave exactly one
// committed. Authorization (an HTTP call to Cerbos) is deliberately done BEFORE the transaction, never inside it,
// so the lock is never held across a network round trip.
import type { PoolClient } from "pg";
import { loadOrgStructure } from "../../admin/org-structure.service";
import { isUuidShaped, type OrgNodeForWalk } from "../../core/dept-resolution";
import { loadUnitAncestors } from "../../core/org-unit-closure";

// ───────────────────────────────────────────── vocabulary ─────────────────────────────────────────────

export const PART_STATUSES = ["planned", "active", "blocked", "done", "cancelled"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];
/** `agency_campaigns.status` today's values (0002). */
export const CAMPAIGN_STATUSES = ["active", "paused", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const BRIEF_MAX = 4000;
export const NAME_MAX = 200;
export const UNIT_ID_MAX = 200;
export const LINK_KINDS = ["search_campaign", "social_campaign"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class PartRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    /** The machine code the contract names (`allocation_exceeds_budget`, `unit_invalid`, ...). */
    readonly reason: string,
    message: string,
    readonly field?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PartRuleError";
  }
}
const bad = (reason: string, message: string, field?: string) => new PartRuleError(400, reason, message, field);

// ───────────────────────────────────────── pure input parsing ─────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Minor units: a JSON number that is a safe integer >= 0, or `null`. Anything else (a float, a string, a negative,
 *  an unsafe integer) is refused: money never travels as a float, and a value JS cannot hold exactly is not money. */
export function parseMinorUnits(value: unknown, field = "budgetMinor"): bigint | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw bad("budget_invalid", `${field} must be a whole number of minor units >= 0, or null`, field);
  }
  return BigInt(value);
}

/** 'YYYY-MM-DD', a real calendar date, or `null`. */
export function parseDateOnly(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw bad("date_invalid", `${field} must be a YYYY-MM-DD date, or null`, field);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw bad("date_invalid", `${field} is not a real calendar date`, field);
  }
  return value;
}

export function parseCurrency(value: unknown): string | null {
  if (value === null) return null;
  const v = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(v)) throw bad("currency_invalid", "currency must be a 3-letter code, or null", "currency");
  return v;
}

export function parseBrief(value: unknown): string {
  if (typeof value !== "string") throw bad("brief_invalid", "brief must be a string", "brief");
  if (value.length > BRIEF_MAX) throw bad("brief_too_long", `brief must be at most ${BRIEF_MAX} characters`, "brief");
  return value;
}

export function parseName(value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.length > NAME_MAX) throw bad("name_invalid", `name must be 1 to ${NAME_MAX} characters`, "name");
  return v;
}

export function parsePartStatus(value: unknown): PartStatus {
  if (typeof value !== "string" || !(PART_STATUSES as readonly string[]).includes(value)) {
    throw bad("status_invalid", `status must be one of ${PART_STATUSES.join("|")}`, "status");
  }
  return value as PartStatus;
}

export function parseCampaignStatus(value: unknown): CampaignStatus {
  if (typeof value !== "string" || !(CAMPAIGN_STATUSES as readonly string[]).includes(value)) {
    throw bad("status_invalid", `status must be one of ${CAMPAIGN_STATUSES.join("|")}`, "status");
  }
  return value as CampaignStatus;
}

/** A unit id as sent: a non-empty string. Whether it is a real department is the org check's job (`requireDepartment`). */
export function parseUnitId(value: unknown, field = "unitId"): string {
  if (typeof value !== "string" || !value.trim() || value.length > UNIT_ID_MAX) {
    throw bad("unit_invalid", `${field} must be a department id of this company`, field);
  }
  return value.trim();
}

/** `ownerId`: a uuid, or `null` to clear it. Whether it is an active member is the DB check (`requireActiveOwner`). */
export function parseOwnerId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isUuidShaped(value)) {
    throw bad("owner_invalid", "ownerId must be the id of an active member of this company, or null", "ownerId");
  }
  return value;
}

export function parseLinkKind(value: unknown): LinkKind {
  if (typeof value !== "string" || !(LINK_KINDS as readonly string[]).includes(value)) {
    throw bad("link_kind_invalid", `kind must be one of ${LINK_KINDS.join("|")}`, "kind");
  }
  return value as LinkKind;
}

export function requireUuid(value: string, reason: string, message: string): string {
  if (!isUuidShaped(value)) throw new PartRuleError(404, reason, message);
  return value;
}

// ───────────────────────────────────────── pure body parsers ─────────────────────────────────────────
// One parser per write. Each reads ONLY the fields its route documents (§31.4): `tenantId`, `campaignId`, `id` and
// the `status` DEFAULT are never read from a body. A field that is `undefined` is "not sent"; `null` is a value
// (clear it), except where a parser says otherwise.

export interface PartCreateInput {
  unitId: string;
  ownerId: string | null;
  brief: string;
  dueOn: string | null;
  budgetMinor: bigint | null;
}
export function parsePartCreate(body: unknown): PartCreateInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  return {
    unitId: parseUnitId(body.unitId),
    ownerId: body.ownerId === undefined ? null : parseOwnerId(body.ownerId),
    brief: body.brief === undefined ? "" : parseBrief(body.brief),
    dueOn: body.dueOn === undefined ? null : parseDateOnly(body.dueOn, "dueOn"),
    budgetMinor: body.budgetMinor === undefined ? null : parseMinorUnits(body.budgetMinor),
  };
}

export interface PartPatchInput {
  status?: PartStatus;
  ownerId?: string | null;
  brief?: string;
  dueOn?: string | null;
  budgetMinor?: bigint | null;
}
export const PART_NON_MONEY_KEYS = ["status", "ownerId", "brief", "dueOn"] as const;
/** Which gates a PATCH body needs, read from the RAW body BEFORE any value is validated, so a caller who may not
 *  write is refused 403 whatever they sent (validation never pre-empts authorization). */
export function partPatchGates(body: unknown): { nonMoney: boolean; money: boolean } {
  const o = isPlainObject(body) ? body : {};
  return {
    nonMoney: PART_NON_MONEY_KEYS.some((k) => o[k] !== undefined),
    money: o.budgetMinor !== undefined,
  };
}
export function parsePartPatch(body: unknown): PartPatchInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  const out: PartPatchInput = {};
  if (body.status !== undefined) out.status = parsePartStatus(body.status);
  if (body.ownerId !== undefined) out.ownerId = parseOwnerId(body.ownerId);
  if (body.brief !== undefined) out.brief = parseBrief(body.brief);
  if (body.dueOn !== undefined) out.dueOn = parseDateOnly(body.dueOn, "dueOn");
  if (body.budgetMinor !== undefined) out.budgetMinor = parseMinorUnits(body.budgetMinor);
  if (Object.keys(out).length === 0) throw bad("nothing_to_update", "send at least one of status, ownerId, brief, dueOn, budgetMinor");
  return out;
}

export interface CampaignPatchInput {
  name?: string;
  status?: CampaignStatus;
  budgetMinor?: bigint | null;
  currency?: string | null;
  leadUnitId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}
export function parseCampaignPatch(body: unknown): CampaignPatchInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  const out: CampaignPatchInput = {};
  if (body.name !== undefined) out.name = parseName(body.name);
  if (body.status !== undefined) out.status = parseCampaignStatus(body.status);
  if (body.budgetMinor !== undefined) out.budgetMinor = parseMinorUnits(body.budgetMinor);
  if (body.currency !== undefined) out.currency = parseCurrency(body.currency);
  if (body.leadUnitId !== undefined) out.leadUnitId = body.leadUnitId === null ? null : parseUnitId(body.leadUnitId, "leadUnitId");
  if (body.startsOn !== undefined) out.startsOn = parseDateOnly(body.startsOn, "startsOn");
  if (body.endsOn !== undefined) out.endsOn = parseDateOnly(body.endsOn, "endsOn");
  if (Object.keys(out).length === 0) {
    throw bad("nothing_to_update", "send at least one of name, status, budgetMinor, currency, leadUnitId, startsOn, endsOn");
  }
  return out;
}

/** The resulting date pair must be ordered; the DB CHECK is the backstop, this gives the caller a 400, not a 500. */
export function checkDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn && endsOn && endsOn < startsOn) throw bad("dates_invalid", "endsOn must not be before startsOn", "endsOn");
}

// ───────────────────────────────────────── pure org check ─────────────────────────────────────────

/** A node of the (sanitized) org blob, as far as this file reads it: the walker type plus a display name. */
export type OrgNodeLike = OrgNodeForWalk & { name?: string };
export interface OrgUnitInfo { name: string | null; kind: string }

/** Index the org tree by node id. Walks the tree once; first occurrence of an id wins (the sanitizer already
 *  de-duplicates ids, so this is belt and braces). Iterative, so a deep tree cannot overflow the stack. */
export function indexOrgUnits(root: OrgNodeLike | null | undefined): Map<string, OrgUnitInfo> {
  const out = new Map<string, OrgUnitInfo>();
  if (!root) return out;
  const stack: OrgNodeLike[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (!out.has(n.id)) out.set(n.id, { name: typeof n.name === "string" ? n.name : null, kind: n.kind });
    for (const ch of n.children ?? []) stack.push(ch as OrgNodeLike);
  }
  return out;
}

/** §31.4 shared rule: the node must exist AND be of kind `department`, or 400 `unit_invalid` (a division, a role,
 *  a person, the company root and an unknown id are all refused). */
export function requireDepartment(units: Map<string, OrgUnitInfo>, unitId: string, field = "unitId"): OrgUnitInfo {
  const u = units.get(unitId);
  if (!u || u.kind !== "department") {
    throw bad("unit_invalid", `${field} "${unitId}" is not a department of this company`, field);
  }
  return u;
}

// ───────────────────────────────────────── pure money rules (§31.3) ─────────────────────────────────────────

const num = (b: bigint): number => Number(b);

/** Rules 3 and 4 for ONE part's allocation. `allocatedByOthers` is the sum over the campaign's OTHER live,
 *  non-cancelled parts. Throws the contract's refusal, or returns. */
export function checkAllocation(input: {
  campaignBudget: bigint | null;
  campaignCurrency: string | null;
  allocatedByOthers: bigint;
  requested: bigint;
}): void {
  const { campaignBudget, campaignCurrency, allocatedByOthers, requested } = input;
  if (campaignBudget === null || campaignCurrency === null) {
    throw new PartRuleError(
      409, "campaign_has_no_budget",
      "the campaign has no budget and currency yet; set them on the campaign before allocating to a part",
    );
  }
  if (allocatedByOthers + requested > campaignBudget) {
    throw new PartRuleError(
      409, "allocation_exceeds_budget",
      "this allocation would take the sum of the parts' allocations above the campaign budget",
      undefined,
      { budgetMinor: num(campaignBudget), allocatedMinor: num(allocatedByOthers), requestedMinor: num(requested) },
    );
  }
}

/** Rule 5 for a campaign PATCH that touches money. `allocatedMinor` and `allocationCount` describe the campaign's
 *  live, non-cancelled parts that hold a (possibly zero) allocation. Currency is checked first: changing it under
 *  allocations would silently re-denominate them. */
export function checkCampaignMoneyChange(input: {
  currentCurrency: string | null;
  nextBudget: bigint | null;
  nextCurrency: string | null;
  allocatedMinor: bigint;
  allocationCount: number;
}): void {
  const { currentCurrency, nextBudget, nextCurrency, allocatedMinor, allocationCount } = input;
  if (allocationCount === 0) return;
  if (nextCurrency !== currentCurrency) {
    throw new PartRuleError(
      409, "currency_locked_by_allocations",
      "the campaign currency cannot change while any part holds an allocation",
      undefined,
      { currency: currentCurrency, allocatedMinor: num(allocatedMinor) },
    );
  }
  if (nextBudget === null || nextBudget < allocatedMinor) {
    throw new PartRuleError(
      409, "budget_below_allocations",
      "the campaign budget cannot be cleared or lowered below the sum of its parts' allocations",
      undefined,
      { budgetMinor: nextBudget === null ? null : num(nextBudget), allocatedMinor: num(allocatedMinor) },
    );
  }
}

/** Does this part write need rule 4 re-checked? Only a part that will COUNT (not cancelled) and holds an allocation,
 *  and only when something moved: its allocation, or its status leaving `cancelled` (rule 6). */
export function needsAllocationCheck(input: {
  finalStatus: PartStatus;
  finalBudget: bigint | null;
  budgetTouched: boolean;
  leavingCancelled: boolean;
}): boolean {
  return input.finalStatus !== "cancelled" && input.finalBudget !== null && (input.budgetTouched || input.leavingCancelled);
}

/** `unallocatedMinor` is null when there is no budget (rule 7: the server does the sums). */
export function moneySnapshot(budget: bigint | null, currency: string | null, allocated: bigint) {
  return {
    budgetMinor: budget === null ? null : num(budget),
    currency,
    allocatedMinor: num(allocated),
    unallocatedMinor: budget === null ? null : num(budget - allocated),
  };
}

export const toBig = (s: string | null | undefined): bigint | null => (s === null || s === undefined ? null : BigInt(s));
export const toNum = (s: string | null | undefined): number | null => (s === null || s === undefined ? null : Number(s));

// ───────────────────────────────────────── SQL helpers (caller's transaction) ─────────────────────────────────────────

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  project_id: string;
  budget_minor: string | null;
  currency: string | null;
  lead_unit_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

const CAMPAIGN_COLS = `id, name, status, project_id, budget_minor::text AS budget_minor, currency, lead_unit_id,
                       starts_on::text AS starts_on, ends_on::text AS ends_on`;

/** Take the campaign's row lock (the money lock; see the header). `null` = absent, soft-deleted or another tenant's (RLS). */
export async function lockCampaign(c: PoolClient, campaignId: string): Promise<CampaignRow | null> {
  const { rows } = await c.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLS} FROM agency_campaigns WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [campaignId],
  );
  return rows[0] ?? null;
}

export async function readCampaign(c: PoolClient, campaignId: string): Promise<CampaignRow | null> {
  const { rows } = await c.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLS} FROM agency_campaigns WHERE id = $1 AND deleted_at IS NULL`,
    [campaignId],
  );
  return rows[0] ?? null;
}

/** The campaign's allocation: the sum (and count) over its live, NON-CANCELLED parts that hold an allocation, in SQL
 *  `bigint`. `excludePartId` leaves one part out (the part being written). */
export async function allocationOf(
  c: PoolClient, campaignId: string, excludePartId: string | null = null,
): Promise<{ allocated: bigint; count: number }> {
  const { rows } = await c.query<{ allocated: string; n: number }>(
    `SELECT COALESCE(sum(budget_minor), 0)::text AS allocated, count(budget_minor)::int AS n
       FROM agency_campaign_parts
      WHERE campaign_id = $1 AND deleted_at IS NULL AND status <> 'cancelled'
        AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [campaignId, excludePartId],
  );
  return { allocated: BigInt(rows[0].allocated), count: rows[0].n };
}

/** This tenant's departments and other nodes, indexed by id, from the org blob (the one tree parser: the sanitizer). */
export async function loadOrgUnits(c: PoolClient, tenantId: string): Promise<Map<string, OrgUnitInfo>> {
  const structure = await loadOrgStructure(c, tenantId);
  return indexOrgUnits(structure?.root as OrgNodeLike | undefined);
}

/** §31.4 shared rule: an owner must be an ACTIVE member of this tenant, or 400 `owner_invalid`. */
export async function requireActiveOwner(c: PoolClient, tenantId: string, ownerId: string): Promise<void> {
  const { rows } = await c.query(
    `SELECT 1 FROM company_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'active'`,
    [tenantId, ownerId],
  );
  if (!rows[0]) throw bad("owner_invalid", "ownerId is not an active member of this company", "ownerId");
}

export interface PartRow {
  id: string;
  tenant_id: string;
  campaign_id: string;
  unit_id: string;
  owner_id: string | null;
  status: PartStatus;
  brief: string;
  due_on: string | null;
  budget_minor: string | null;
}

const PART_COLS = `id, tenant_id, campaign_id, unit_id, owner_id, status, brief, due_on::text AS due_on,
                   budget_minor::text AS budget_minor`;

/** A live part of THIS campaign, or null (absent, deleted, another campaign's, another tenant's). `lock` takes the
 *  row lock a delete or a write needs; `share` the lighter one a link needs (so a link and a delete cannot interleave). */
export async function loadPart(
  c: PoolClient, campaignId: string, partId: string, lock: "none" | "update" | "share" = "none",
): Promise<PartRow | null> {
  const suffix = lock === "update" ? " FOR UPDATE" : lock === "share" ? " FOR SHARE" : "";
  const { rows } = await c.query<PartRow>(
    `SELECT ${PART_COLS} FROM agency_campaign_parts
      WHERE id = $1 AND campaign_id = $2 AND deleted_at IS NULL${suffix}`,
    [partId, campaignId],
  );
  return rows[0] ?? null;
}

/** The part's unit expanded through `org_unit_closure` (the HIER-2 shape employees/positions use): what the
 *  `org_unit_lead` rule matches a grant's unit against. `[]` for a unit that has left the tree: fail closed. */
export function partUnitAncestors(c: PoolClient, tenantId: string, unitId: string): Promise<string[]> {
  return loadUnitAncestors(c, tenantId, unitId);
}

/** DW-5c (FRONTEND-BFF-CONTRACT §32.1): requests link to a part through `work_requests.campaign_part_id`. This is the single
 *  seam for both the detail read's `requests` counts and the `part_has_links` check; DW-5a stubbed it, DW-5c made it real.
 *  `open`, `delivered` and `declined` are counted per part; a CANCELLED request counts in none of the three (the shape has
 *  no bucket for it) but still blocks the part's delete (`countRequestsOnPart`). */
export async function requestCountsByPart(
  c: PoolClient, partIds: string[],
): Promise<Map<string, { open: number; delivered: number; declined: number }>> {
  const out = new Map(partIds.map((id) => [id, { open: 0, delivered: 0, declined: 0 }]));
  if (partIds.length === 0) return out;
  const { rows } = await c.query<{ campaign_part_id: string; status: "open" | "delivered" | "declined"; n: number }>(
    `SELECT campaign_part_id, status, count(*)::int AS n
       FROM work_requests
      WHERE campaign_part_id = ANY($1::uuid[]) AND deleted_at IS NULL AND status IN ('open', 'delivered', 'declined')
      GROUP BY campaign_part_id, status`,
    [partIds],
  );
  for (const r of rows) {
    const bucket = out.get(r.campaign_part_id);
    if (bucket) bucket[r.status] = r.n;
  }
  return out;
}
/** Every request on the part, whatever its status (cancelled included): any request at all blocks the part's delete. */
export async function countRequestsOnPart(c: PoolClient, partId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_requests WHERE campaign_part_id = $1 AND deleted_at IS NULL`,
    [partId],
  );
  return rows[0].n;
}

/** Department campaigns (SEO, social) pointing at the part. Runs under BOTH module scopes (the caller declares
 *  `modules: ["search","social"]`), whatever is enabled today: a campaign linked while a module was on still blocks the delete. */
export async function countChildLinks(c: PoolClient, partId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM search_campaigns WHERE agency_part_id = $1 AND deleted_at IS NULL)::int
          + (SELECT count(*) FROM social_campaigns WHERE agency_part_id = $1 AND deleted_at IS NULL)::int AS n`,
    [partId],
  );
  return rows[0].n;
}

/** The two module-scoped tables a part can link to, in one place. */
export const LINK_TABLE: Record<LinkKind, { table: string; module: "search" | "social" }> = {
  search_campaign: { table: "search_campaigns", module: "search" },
  social_campaign: { table: "social_campaigns", module: "social" },
};
