// DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32) — requests between departments: the form validator, the status rules, the
// org derivation and the SQL of every write and read, kept out of the controller so the rules are unit-testable and the
// controller stays a thin authorize-then-delegate layer.
//
// Two halves in one file, on purpose (the DW-5a layout):
//   1. PURE rules — body and form parsing, the lifecycle transitions, the change-request sync plan, the org walk and the
//      plain-text summaries. No DB, no Nest: `work-requests.service.test.ts` drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one `withTenants`
//      transaction (the outbox event rides in that same transaction).
//
// A request is the ASK; the work stays where each receiver already works (§32 preamble): an asset request is a PM task in
// the receiving department's intake project, an engineering request is a Web Dev change request (`source = 'internal'`).
// `work_requests` carries only the ask and its own lifecycle. Progress inside that lifecycle is read live from the work
// item and is never copied here.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { loadOrgStructure, type OrgNode } from "../admin/org-structure.service";
import { emitEvent } from "../events/outbox.service";
import { isUuidShaped, todayIso } from "./dept-resolution";
import { deriveUniqueShortCode } from "./project-short-codes";
import { loadUnitAncestors } from "./org-unit-closure";
import { scrubText } from "./scrub";
import { notifyBestEffort } from "./client-notify";

// ───────────────────────────────────────────── vocabulary ─────────────────────────────────────────────

export const REQUEST_KINDS = ["assets", "engineering"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATUSES = ["open", "delivered", "declined", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
/** The change-request kinds an engineering request may carry (`webdev_change_requests.kind`). */
export const ENGINEERING_KINDS = ["content", "design", "feature", "bug"] as const;
export const DELIVERABLE_FORMATS = ["image", "video", "copy", "document", "other"] as const;

export const TITLE_MAX = 200;
export const BRIEF_MAX = 10_000;
export const REASON_MAX = 2_000;
export const UNIT_ID_MAX = 200;
export const DELIVERABLES_MAX = 10;
export const QUANTITY_MAX = 50;
export const SIZE_MAX = 60;
export const CHANNEL_MAX = 60;
export const REFERENCES_MAX = 10;
export const URL_MAX = 500;
export const NOTES_MAX = 2_000;
export const ASSET_IDS_MAX = 20;
export const LIST_LIMIT = 200;
/** What a requester's cancel writes on the change request it withdraws (§32.5). */
export const CANCELLED_BY_REQUESTER = "Cancelled by the requester";
/** The reason an engineering request carries when triage declined the change request without one (the CHECK demands one). */
export const DECLINED_BY_TRIAGE = "Declined by Web Dev triage";

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class WorkRequestRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    /** The machine code the contract names (`form_invalid`, `request_not_open`, ...). */
    readonly reason: string,
    message: string,
    readonly field?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkRequestRuleError";
  }
}
const bad = (reason: string, message: string, field?: string) => new WorkRequestRuleError(400, reason, message, field);
const badForm = (message: string, field: string) => new WorkRequestRuleError(400, "form_invalid", message, field);

// ───────────────────────────────────────── pure input parsing ─────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Plain text: a NUL cannot live in a Postgres text column (it would be a 500), and nothing here is ever interpreted as
 *  markup. PAN, national ids and e-mail addresses are scrubbed exactly as change requests scrub them (`scrubText`). */
export function plain(s: string): string {
  return scrubText(s.replace(/\u0000/g, "")).text;
}
const stripNul = (s: string): string => s.replace(/\u0000/g, "");

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

/** An `http(s)` URL of at most `URL_MAX` characters, or a `form_invalid` naming the field. */
export function parseHttpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw badForm(`${field} must be an http(s) URL`, field);
  const v = stripNul(value).trim();
  if (!v || v.length > URL_MAX) throw badForm(`${field} must be an http(s) URL of at most ${URL_MAX} characters`, field);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw badForm(`${field} must be an http(s) URL`, field);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badForm(`${field} must be an http(s) URL`, field);
  return v;
}

function refuseUnknownKeys(o: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw badForm(`${prefix}.${k} is not a field of this request form`, `${prefix}.${k}`);
  }
}

export interface Deliverable { format: (typeof DELIVERABLE_FORMATS)[number]; size: string; quantity: number }
export interface AssetsForm { deliverables: Deliverable[]; channel?: string; references?: string[]; notes?: string }
export interface EngineeringForm { kind: (typeof ENGINEERING_KINDS)[number]; affectedUrl?: string }
export type RequestForm = AssetsForm | EngineeringForm;

/** §32.4 `assets`: 1 to 10 deliverables of `{format, size ≤ 60, quantity 1..50}`, an optional channel ≤ 60, 0 to 10 http(s)
 *  references ≤ 500 each and optional notes ≤ 2,000. Unknown keys are refused at every level. The result carries only
 *  the keys that were sent, with strings trimmed. */
export function parseAssetsForm(value: unknown): AssetsForm {
  if (!isPlainObject(value)) throw badForm("form must be an object", "form");
  refuseUnknownKeys(value, ["deliverables", "channel", "references", "notes"], "form");
  const d = value.deliverables;
  if (!Array.isArray(d) || d.length < 1 || d.length > DELIVERABLES_MAX) {
    throw badForm(`form.deliverables must list 1 to ${DELIVERABLES_MAX} items`, "form.deliverables");
  }
  const deliverables: Deliverable[] = d.map((item, i) => {
    const at = `form.deliverables[${i}]`;
    if (!isPlainObject(item)) throw badForm(`${at} must be an object`, at);
    refuseUnknownKeys(item, ["format", "size", "quantity"], at);
    if (typeof item.format !== "string" || !(DELIVERABLE_FORMATS as readonly string[]).includes(item.format)) {
      throw badForm(`${at}.format must be one of ${DELIVERABLE_FORMATS.join("|")}`, `${at}.format`);
    }
    if (typeof item.size !== "string" || stripNul(item.size).trim().length > SIZE_MAX) {
      throw badForm(`${at}.size must be a string of at most ${SIZE_MAX} characters`, `${at}.size`);
    }
    if (typeof item.quantity !== "number" || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > QUANTITY_MAX) {
      throw badForm(`${at}.quantity must be a whole number from 1 to ${QUANTITY_MAX}`, `${at}.quantity`);
    }
    return { format: item.format as Deliverable["format"], size: stripNul(item.size).trim(), quantity: item.quantity };
  });
  const out: AssetsForm = { deliverables };
  if (value.channel !== undefined) {
    if (typeof value.channel !== "string" || stripNul(value.channel).trim().length > CHANNEL_MAX) {
      throw badForm(`form.channel must be a string of at most ${CHANNEL_MAX} characters`, "form.channel");
    }
    out.channel = stripNul(value.channel).trim();
  }
  if (value.references !== undefined) {
    if (!Array.isArray(value.references) || value.references.length > REFERENCES_MAX) {
      throw badForm(`form.references must list at most ${REFERENCES_MAX} http(s) URLs`, "form.references");
    }
    out.references = value.references.map((r, i) => parseHttpUrl(r, `form.references[${i}]`));
  }
  if (value.notes !== undefined) {
    if (typeof value.notes !== "string" || stripNul(value.notes).length > NOTES_MAX) {
      throw badForm(`form.notes must be a string of at most ${NOTES_MAX} characters`, "form.notes");
    }
    out.notes = plain(value.notes);
  }
  return out;
}

/** §32.4 `engineering`: the change-request kind (required) and an optional http(s) `affectedUrl`. */
export function parseEngineeringForm(value: unknown): EngineeringForm {
  if (!isPlainObject(value)) throw badForm("form must be an object", "form");
  refuseUnknownKeys(value, ["kind", "affectedUrl"], "form");
  if (typeof value.kind !== "string" || !(ENGINEERING_KINDS as readonly string[]).includes(value.kind)) {
    throw badForm(`form.kind must be one of ${ENGINEERING_KINDS.join("|")}`, "form.kind");
  }
  const out: EngineeringForm = { kind: value.kind as EngineeringForm["kind"] };
  if (value.affectedUrl !== undefined) out.affectedUrl = parseHttpUrl(value.affectedUrl, "form.affectedUrl");
  return out;
}

export interface CreateInput {
  kind: RequestKind;
  toUnitId: string;
  title: string;
  brief: string;
  neededBy: string | null;
  campaignPartId: string | null;
  form: RequestForm;
}

/** §32.5 `POST requests`. Reads ONLY the documented fields: `requested_by`, `from_unit_id`, `status`, the work item ids
 *  and `tenant_id` are server-derived and never read from a body (§32.3). */
export function parseCreate(body: unknown): CreateInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  if (typeof body.kind !== "string" || !(REQUEST_KINDS as readonly string[]).includes(body.kind)) {
    throw bad("kind_invalid", `kind must be one of ${REQUEST_KINDS.join("|")}`, "kind");
  }
  const kind = body.kind as RequestKind;
  if (typeof body.toUnitId !== "string" || !body.toUnitId.trim() || body.toUnitId.length > UNIT_ID_MAX) {
    throw bad("to_unit_invalid", "toUnitId must be a department of this company", "toUnitId");
  }
  const title = typeof body.title === "string" ? plain(body.title).trim() : "";
  if (!title || title.length > TITLE_MAX) throw bad("title_invalid", `title must be 1 to ${TITLE_MAX} characters`, "title");
  let brief = "";
  if (body.brief !== undefined) {
    if (typeof body.brief !== "string") throw bad("brief_invalid", "brief must be a string", "brief");
    if (body.brief.length > BRIEF_MAX) throw bad("brief_too_long", `brief must be at most ${BRIEF_MAX} characters`, "brief");
    brief = plain(body.brief);
  }
  const neededBy = body.neededBy === undefined ? null : parseDateOnly(body.neededBy, "neededBy");
  let campaignPartId: string | null = null;
  if (body.campaignPartId !== undefined && body.campaignPartId !== null) {
    if (typeof body.campaignPartId !== "string" || !isUuidShaped(body.campaignPartId)) {
      throw bad("campaign_part_invalid", "campaignPartId must be a live part of a campaign of this company", "campaignPartId");
    }
    campaignPartId = body.campaignPartId;
  }
  const form = kind === "assets" ? parseAssetsForm(body.form) : parseEngineeringForm(body.form);
  return { kind, toUnitId: body.toUnitId.trim(), title, brief, neededBy, campaignPartId, form };
}

/** `POST requests/:id/deliver` body: 1 to 20 asset ids, de-duplicated, order kept. */
export function parseDeliver(body: unknown): { assetIds: string[] } {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  const ids = body.assetIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ASSET_IDS_MAX || !ids.every((i) => typeof i === "string" && isUuidShaped(i))) {
    throw bad("asset_invalid", `assetIds must list 1 to ${ASSET_IDS_MAX} asset ids`, "assetIds");
  }
  return { assetIds: [...new Set((ids as string[]).map((i) => i.toLowerCase()))] };
}

/** `POST requests/:id/decline` body: a reason of 1 to 2,000 characters. */
export function parseDecline(body: unknown): { reason: string } {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON object body is required");
  const reason = typeof body.reason === "string" ? plain(body.reason).trim() : "";
  if (!reason || reason.length > REASON_MAX) throw bad("reason_invalid", `reason must be 1 to ${REASON_MAX} characters`, "reason");
  return { reason };
}

export type Box = "incoming" | "sent" | "mine";
export interface ListQuery {
  box: Box;
  unitId: string | null;
  status: "open" | "closed" | "all";
  kind: RequestKind | null;
}
/** `GET requests?box=&unitId=&status=&kind=`. `unitId` is required for `incoming` and `sent`; whether it names a
 *  department is the org check's job (`requireDepartment`). The default status is `open`. */
export function parseListQuery(q: { box?: unknown; unitId?: unknown; status?: unknown; kind?: unknown }): ListQuery {
  if (q.box !== "incoming" && q.box !== "sent" && q.box !== "mine") {
    throw bad("box_invalid", "box must be one of incoming|sent|mine", "box");
  }
  const status = q.status === undefined || q.status === "" ? "open" : q.status;
  if (status !== "open" && status !== "closed" && status !== "all") {
    throw bad("status_invalid", "status must be one of open|closed|all", "status");
  }
  let kind: RequestKind | null = null;
  if (q.kind !== undefined && q.kind !== "") {
    if (typeof q.kind !== "string" || !(REQUEST_KINDS as readonly string[]).includes(q.kind)) {
      throw bad("kind_invalid", `kind must be one of ${REQUEST_KINDS.join("|")}`, "kind");
    }
    kind = q.kind as RequestKind;
  }
  const unitId = typeof q.unitId === "string" && q.unitId.trim() ? q.unitId.trim() : null;
  if (q.box !== "mine" && !unitId) throw bad("unit_invalid", `unitId (a department) is required for box=${q.box}`, "unitId");
  return { box: q.box, unitId: q.box === "mine" ? null : unitId, status, kind };
}

// ───────────────────────────────────────── pure status rules (§32.5, §32.6) ─────────────────────────────────────────

const notOpen = (status: string) =>
  new WorkRequestRuleError(409, "request_not_open", `this request is ${status}; only an open request can be acted on`, undefined, { status });

/** `deliver`: an `open` request becomes `delivered` (and is closed); an already `delivered` one only takes more assets
 *  ("deliver more"); anything else is refused. */
export function planDeliver(status: string): { closes: boolean } {
  if (status === "open") return { closes: true };
  if (status === "delivered") return { closes: false };
  throw notOpen(status);
}
/** `decline` and `cancel` act on an `open` request only. */
export function requireOpen(status: string): void {
  if (status !== "open") throw notOpen(status);
}
/** Assets only for deliver and decline; an engineering request is declined by Web Dev triage. */
export function requireAssets(kind: string): void {
  if (kind !== "assets") {
    throw new WorkRequestRuleError(409, "wrong_kind_for_action", "this action applies to asset requests only; engineering requests are handled by Web Dev triage");
  }
}
/** An engineering request can be withdrawn only while its change request is still `new`: once triage has accepted the
 *  work, Web Dev owns it (§32.5). */
export function requireChangeRequestNew(changeRequestStatus: string): void {
  if (changeRequestStatus !== "new") {
    throw new WorkRequestRuleError(409, "already_in_progress", "Web Dev has already triaged this request; it can no longer be cancelled", undefined, { changeRequestStatus });
  }
}

/** §32.6: what the ask's status should be, given the change request's. Triage `declined` declines the ask, `verified`
 *  delivers it, every other change-request status leaves it (or puts it back to) `open`. */
export function desiredStatusFromChangeRequest(changeRequestStatus: string): "open" | "delivered" | "declined" {
  if (changeRequestStatus === "declined") return "declined";
  if (changeRequestStatus === "verified") return "delivered";
  return "open";
}
/** The move `syncWorkRequestFromChangeRequest` should make, or `null` for none. A CANCELLED ask never moves (the requester
 *  withdrew it; the change request they declined is the echo of that), and an ask already in the desired state stays. */
export function planSync(askStatus: string, changeRequestStatus: string): "open" | "delivered" | "declined" | null {
  if (askStatus === "cancelled") return null;
  const want = desiredStatusFromChangeRequest(changeRequestStatus);
  return want === askStatus ? null : want;
}

// ───────────────────────────────────────── pure org walk ─────────────────────────────────────────

export interface OrgUnitInfo { name: string | null; kind: string; parentId: string | null }

/** Index the org tree by node id, with each node's parent. First occurrence of an id wins (the sanitizer already
 *  de-duplicates ids, so this is belt and braces). Iterative, so a deep tree cannot overflow the stack. */
export function indexOrgTree(root: OrgNode | null | undefined): Map<string, OrgUnitInfo> {
  const out = new Map<string, OrgUnitInfo>();
  if (!root) return out;
  const stack: Array<{ node: OrgNode; parentId: string | null }> = [{ node: root, parentId: null }];
  while (stack.length) {
    const { node, parentId } = stack.pop()!;
    if (!out.has(node.id)) out.set(node.id, { name: typeof node.name === "string" ? node.name : null, kind: node.kind, parentId });
    for (const ch of node.children ?? []) stack.push({ node: ch, parentId: node.id });
  }
  return out;
}

/** §32.3: walk a node up to its DEPARTMENT ancestor (itself when it is one), so a person in a division counts for that
 *  division's department. `null` when the node is unknown or no department sits above it. */
export function departmentOf(index: Map<string, OrgUnitInfo>, unitId: string): string | null {
  let cur: string | null = unitId;
  for (let hops = 0; cur !== null && hops < 64; hops++) {
    const n = index.get(cur);
    if (!n) return null;
    if (n.kind === "department") return cur;
    cur = n.parentId;
  }
  return null;
}

/** §32.3: `to_unit_id` must be a department node of this tenant's org tree, or 400 `to_unit_invalid`. */
export function requireToDepartment(index: Map<string, OrgUnitInfo>, unitId: string): OrgUnitInfo {
  const u = index.get(unitId);
  if (!u || u.kind !== "department") {
    throw bad("to_unit_invalid", `toUnitId "${unitId}" is not a department of this company`, "toUnitId");
  }
  return u;
}
/** A `unitId` filter must be a department node too (`incoming` / `sent` boxes, `summary`): 400 `unit_invalid`. */
export function requireFilterDepartment(index: Map<string, OrgUnitInfo>, unitId: string): OrgUnitInfo {
  const u = index.get(unitId);
  if (!u || u.kind !== "department") throw bad("unit_invalid", `unitId "${unitId}" is not a department of this company`, "unitId");
  return u;
}

/** `{id, name}` for a unit as the reads show it: a unit that has since left the tree reads `name: null` with
 *  `unitMissing: true`, never a stale name (§32.5). */
export function unitView(index: Map<string, OrgUnitInfo>, id: string) {
  const u = index.get(id);
  return { id, name: u ? u.name : null, unitMissing: !u };
}

// ───────────────────────────────────────── pure text ─────────────────────────────────────────

/** A plain-text rendering of the asset form, for the PM task description (the form itself stays data on the request). */
export function summarizeAssetsForm(form: AssetsForm): string {
  const lines: string[] = ["Deliverables:"];
  for (const d of form.deliverables) lines.push(`- ${d.quantity} x ${d.format}${d.size ? ` (${d.size})` : ""}`);
  if (form.channel) lines.push(`Channel: ${form.channel}`);
  if (form.references?.length) {
    lines.push("References:");
    for (const r of form.references) lines.push(`- ${r}`);
  }
  if (form.notes) lines.push(`Notes: ${form.notes}`);
  return lines.join("\n");
}

/** §32.5 asset task description: the brief, a plain-text summary of the form, and a "Requested by" line. */
export function buildTaskDescription(input: {
  brief: string; form: AssetsForm; requesterName: string; fromUnitName: string | null;
}): string {
  const who = input.fromUnitName ? `${input.requesterName} (${input.fromUnitName})` : input.requesterName;
  return [input.brief.trim(), summarizeAssetsForm(input.form), `Requested by ${who}`].filter((p) => p.length > 0).join("\n\n");
}

// ───────────────────────────────────────── SQL helpers (caller's transaction) ─────────────────────────────────────────

/** This tenant's org tree indexed by id, with parents (the one tree parser: the sanitizer). */
export async function loadOrgIndex(c: PoolClient, tenantId: string): Promise<Map<string, OrgUnitInfo>> {
  const structure = await loadOrgStructure(c, tenantId);
  return indexOrgTree(structure?.root);
}

/** §32.3 `from_unit_id`: the requester's open primary membership (`is_primary`, `valid_to` NULL or today or later), walked
 *  up to its department. `null` when there is no membership or no department above it (for example an owner).
 *  `today` is the application's own date (`todayIso`), the same one the membership sweep stamps `valid_from` with, never the
 *  database session's `current_date`: the two can sit on different sides of midnight, and a row the sweep wrote today must
 *  never read as "not started yet". */
export async function resolveFromUnit(
  c: PoolClient, tenantId: string, userId: string, index: Map<string, OrgUnitInfo>, today: string = todayIso(),
): Promise<string | null> {
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND (valid_to IS NULL OR valid_to >= $3::date)
      ORDER BY valid_from DESC LIMIT 1`,
    [tenantId, userId, today],
  );
  return rows[0] ? departmentOf(index, rows[0].unit_node_id) : null;
}

/** §32.1 intake: the receiving department's "<Department> · Requests" project, created ONCE.
 *
 *  ORDER IS THE FEATURE. Two concurrent first requests both reach here. The project id is minted first and the intake row
 *  is inserted FIRST, `ON CONFLICT DO NOTHING ... RETURNING`: the unique-index insert of the second transaction waits for
 *  the first's COMMIT, then inserts nothing. Only the transaction that WON (a row came back) creates the project row, so a
 *  loser never leaves an orphan project. The intake's FK to projects is DEFERRABLE INITIALLY DEFERRED (migration
 *  202610140600) precisely so the intake row can precede the project row it names; it is checked at COMMIT, by which time
 *  the winner has inserted the project. The loser then re-selects the winner's committed row.
 *
 *  The project is internal (`is_internal = true`, no client), carries `department_id = unit`, and has no owner: it is
 *  provisioning on behalf of an authorized request, not a project a person created, so there is no project `create` gate. */
export async function ensureIntakeProject(
  c: PoolClient, tenantId: string, unitId: string, unitName: string, originSite: string,
): Promise<{ projectId: string; created: boolean }> {
  const candidate = newId();
  const won = await c.query<{ project_id: string }>(
    `INSERT INTO work_request_intakes (tenant_id, unit_id, project_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, unit_id) DO NOTHING RETURNING project_id`,
    [tenantId, unitId, candidate],
  );
  if (won.rows[0]) {
    const name = `${unitName} · Requests`;
    const shortCode = await deriveUniqueShortCode(c, tenantId, name);
    await c.query(
      `INSERT INTO projects (id, tenant_id, name, client_id, is_internal, owner_id, custom_fields, department_id, short_code, origin_site)
       VALUES ($1, $2, $3, NULL, true, NULL, '{}'::jsonb, $4, $5, $6)`,
      [candidate, tenantId, name, unitId, shortCode, originSite],
    );
    return { projectId: candidate, created: true };
  }
  const { rows } = await c.query<{ project_id: string; deleted_at: string | null }>(
    `SELECT i.project_id, p.deleted_at FROM work_request_intakes i
       JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.unit_id = $2`,
    [tenantId, unitId],
  );
  if (!rows[0] || rows[0].deleted_at) {
    throw new WorkRequestRuleError(409, "intake_project_unavailable", "this department's requests project is missing or deleted; restore it before asking this department");
  }
  return { projectId: rows[0].project_id, created: false };
}

/** The longest name a project carries (`projects.name` has no CHECK; this is the contract's own bound, BFF §60.6a). */
export const CLIENT_INTAKE_NAME_MAX = 200;

/** §60.6a: "<Department> · Requests · <Client>", at most 200 characters, the CLIENT's name cut to fit. A department name so long
 *  that nothing of the client fits is cut itself (never a name over the bound). Counts characters (code points), not UTF-16
 *  units, so a cut never splits a surrogate pair. Pure: unit-tested without a database. */
export function clientIntakeProjectName(unitName: string, clientName: string): string {
  const prefix = `${unitName} · Requests · `;
  const full = [...`${prefix}${clientName}`];
  if (full.length <= CLIENT_INTAKE_NAME_MAX) return full.join("");
  return full.slice(0, CLIENT_INTAKE_NAME_MAX).join("").trimEnd();
}

/** §60.6a intake for a CROSS-COMPANY request: the receiving department's "<Department> · Requests · <Client>" project for ONE
 *  client, created ONCE. The client twin of `ensureIntakeProject`, in the SAME race-safe order (see its comment, and
 *  migration 202610160500): mint the project id, INSERT the `work_request_client_intakes` row first with
 *  `ON CONFLICT (tenant_id, unit_id, client_id) DO NOTHING RETURNING`, and create the project row ONLY when that insert won;
 *  the project FK is DEFERRED to COMMIT, so a loser never leaves an orphan project and re-selects the winner's committed row.
 *
 *  The project is CLIENT work, not internal: `client_id` = the client (the requesting company's record at this company),
 *  `is_internal = false`, `department_id` = the unit, no owner (provisioning for an authorized request, so there is no project
 *  `create` gate) and a derived short code. Time logged on it, ticked Billable, is invoiced to that client (DW-D41).
 *
 *  Runs on the caller's `PoolClient`, inside `withTenants([tenantId])`; the caller has already resolved the client (one live
 *  record linked to the requester, `resolveGroupClient`) and the unit's name from the receiving company's own tree. */
export async function ensureClientIntakeProject(
  c: PoolClient, tenantId: string, unitId: string, unitName: string, clientId: string, clientName: string, originSite: string,
): Promise<{ projectId: string; created: boolean }> {
  const candidate = newId();
  const won = await c.query<{ project_id: string }>(
    `INSERT INTO work_request_client_intakes (tenant_id, unit_id, client_id, project_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, unit_id, client_id) DO NOTHING RETURNING project_id`,
    [tenantId, unitId, clientId, candidate],
  );
  if (won.rows[0]) {
    const name = clientIntakeProjectName(unitName, clientName);
    const shortCode = await deriveUniqueShortCode(c, tenantId, name);
    await c.query(
      `INSERT INTO projects (id, tenant_id, name, client_id, is_internal, owner_id, custom_fields, department_id, short_code, origin_site)
       VALUES ($1, $2, $3, $4, false, NULL, '{}'::jsonb, $5, $6, $7)`,
      [candidate, tenantId, name, clientId, unitId, shortCode, originSite],
    );
    return { projectId: candidate, created: true };
  }
  const { rows } = await c.query<{ project_id: string; deleted_at: string | null }>(
    `SELECT i.project_id, p.deleted_at FROM work_request_client_intakes i
       JOIN projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1 AND i.unit_id = $2 AND i.client_id = $3`,
    [tenantId, unitId, clientId],
  );
  if (!rows[0] || rows[0].deleted_at) {
    throw new WorkRequestRuleError(409, "intake_project_unavailable", "this department's requests project for this client is missing or deleted; restore it before asking this department");
  }
  return { projectId: rows[0].project_id, created: false };
}

export interface AuthFacts {
  id: string;
  kind: RequestKind;
  requestedBy: string;
  toUnitId: string;
  pmTaskId: string | null;
  changeRequestId: string | null;
  /** DW-10e (§60.6): the company that asked. Equals the row's `tenant_id` on a same-company request. Not a Cerbos attribute:
   *  the §32 handlers read it only to refuse the receiving company's cancel of a cross row (409 `requester_side_only`). */
  requesterTenantId: string;
  /** The facts Cerbos must see, read from the DB and never from a body (§32.2). */
  assigneeIds: string[];
  unitAncestors: string[];
}

/** The request row and the three resource attributes Cerbos reads (`requestedBy`, `assigneeIds`, `unitAncestors`), or
 *  `null` (absent, deleted, another tenant's). `assigneeIds` is the PM task's responsible person and every person who
 *  holds an open owner, responsible or contributor row on it, unioned with the person fields of the task's assignee blob. */
export async function loadAuthFacts(c: PoolClient, tenantId: string, requestId: string): Promise<AuthFacts | null> {
  if (!isUuidShaped(requestId)) return null;
  const { rows } = await c.query<{
    id: string; kind: RequestKind; requested_by: string; to_unit_id: string; pm_task_id: string | null; change_request_id: string | null;
    requester_tenant_id: string;
  }>(
    `SELECT id, kind, requested_by, to_unit_id, pm_task_id, change_request_id, requester_tenant_id
       FROM work_requests WHERE id = $1 AND deleted_at IS NULL`,
    [requestId],
  );
  const r = rows[0];
  if (!r) return null;
  const ids = new Set<string>();
  if (r.pm_task_id) {
    const blob = await c.query<{ responsible: string | null; ball_kind: string | null; ball_ref: string | null }>(
      `SELECT assignee->>'responsibleId' AS responsible, assignee->>'kind' AS ball_kind, assignee->>'refId' AS ball_ref
         FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`,
      [r.pm_task_id],
    );
    const b = blob.rows[0];
    if (b?.responsible && isUuidShaped(b.responsible)) ids.add(b.responsible.toLowerCase());
    if (b?.ball_kind === "person" && b.ball_ref && isUuidShaped(b.ball_ref)) ids.add(b.ball_ref.toLowerCase());
    const rel = await c.query<{ user_id: string }>(
      `SELECT DISTINCT user_id::text AS user_id FROM pm_task_assignees
        WHERE tenant_id = $1 AND task_id = $2 AND user_id IS NOT NULL AND valid_to IS NULL`,
      [tenantId, r.pm_task_id],
    );
    for (const a of rel.rows) ids.add(a.user_id.toLowerCase());
  }
  return {
    id: r.id, kind: r.kind, requestedBy: r.requested_by, toUnitId: r.to_unit_id,
    pmTaskId: r.pm_task_id, changeRequestId: r.change_request_id, requesterTenantId: r.requester_tenant_id,
    assigneeIds: [...ids],
    unitAncestors: await loadUnitAncestors(c, tenantId, r.to_unit_id),
  };
}

/** §32.7 `request.received`: the active holders of a `positions.is_lead = true` seat on the receiving unit (migration 0109).
 *  An active assignment is one with `valid_to IS NULL` on an `active` position. With no head, nobody is told. */
export async function loadUnitHeads(c: PoolClient, tenantId: string, unitId: string): Promise<string[]> {
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT DISTINCT pa.user_id::text AS user_id
       FROM positions p
       JOIN position_assignments pa ON pa.position_id = p.id AND pa.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.unit_node_id = $2 AND p.is_lead AND p.status = 'active' AND pa.valid_to IS NULL`,
    [tenantId, unitId],
  );
  return rows.map((r) => r.user_id);
}

// ───────────────────────────────────────── reads ─────────────────────────────────────────

export interface RequestRow {
  id: string; kind: RequestKind; title: string; status: RequestStatus; needed_by: string | null; created_at: string; closed_at: string | null;
  to_unit_id: string; from_unit_id: string | null; requested_by: string; requested_by_name: string | null;
  brief: string; form: unknown; decline_reason: string | null;
  campaign_part_id: string | null; campaign_id: string | null; campaign_name: string | null;
  pm_task_id: string | null; t_id: string | null; t_project_id: string | null; t_status: string | null; t_is_done: boolean | null;
  t_responsible_name: string | null;
  change_request_id: string | null; cr_id: string | null; cr_status: string | null; cr_route: string | null;
  asset_count: number;
  // DW-10e (§60.6, §60.5): the requester side of a cross-company row, and the price state the SENDER reads. `tenant_id` and
  // `requester_tenant_id` are equal on a same-company row, where the four others are NULL.
  tenant_id: string; requester_tenant_id: string; requester_unit_id: string | null; requester_unit_name: string | null;
  service_assignment_id: string | null; client_id: string | null;
  requesting_company_name: string | null; client_name: string | null;
  cr_price_impact: string | null; cr_amendment_contract_id: string | null; amendment_status: string | null;
}

/** One SELECT shared by the list and the detail read: the ask, its routing, its campaign and the work item read LIVE.
 *  `isDone` follows the PM reads' rule: the project's status-registry done row when its status set is materialized, else
 *  `status = 'done'`. A deleted work item joins to nothing, which the shaper reads as `work: null`. */
export const REQUEST_SELECT = `
  SELECT r.id, r.kind, r.title, r.status, r.needed_by::text AS needed_by, r.created_at, r.closed_at,
         r.to_unit_id, r.from_unit_id, r.requested_by, ru.name AS requested_by_name,
         r.brief, r.form, r.decline_reason,
         r.campaign_part_id, c.id AS campaign_id, c.name AS campaign_name,
         r.pm_task_id, t.id AS t_id, t.project_id AS t_project_id, t.status AS t_status,
         CASE WHEN t.id IS NULL THEN NULL
              WHEN reg.materialized THEN COALESCE(reg.is_done_row, false)
              ELSE (t.status = 'done') END AS t_is_done,
         CASE WHEN COALESCE(t.assignee->>'responsibleId', '') = '' THEN NULL ELSE t.assignee->>'responsibleName' END AS t_responsible_name,
         r.change_request_id, cr.id AS cr_id, cr.status AS cr_status, cr.route AS cr_route,
         (SELECT count(*)::int FROM work_request_assets a WHERE a.request_id = r.id) AS asset_count,
         r.tenant_id, r.requester_tenant_id, r.requester_unit_id, r.requester_unit_name, r.service_assignment_id, r.client_id,
         rc.name AS requesting_company_name, cl.name AS client_name,
         cr.price_impact AS cr_price_impact, cr.amendment_contract_id AS cr_amendment_contract_id, ac.status AS amendment_status
    FROM work_requests r
    JOIN users ru ON ru.id = r.requested_by
    LEFT JOIN companies rc ON rc.id = r.requester_tenant_id AND r.requester_tenant_id <> r.tenant_id
    LEFT JOIN clients cl ON cl.id = r.client_id
    LEFT JOIN agency_campaign_parts pt ON pt.id = r.campaign_part_id
    LEFT JOIN agency_campaigns c ON c.id = pt.campaign_id
    LEFT JOIN pm_tasks t ON t.id = r.pm_task_id AND t.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT EXISTS(SELECT 1 FROM pm_project_statuses s2 WHERE s2.project_id = t.project_id AND s2.deleted_at IS NULL) AS materialized,
             (SELECT s.is_done FROM pm_project_statuses s WHERE s.project_id = t.project_id AND s.id = t.status AND s.deleted_at IS NULL) AS is_done_row
    ) reg ON t.id IS NOT NULL
    LEFT JOIN webdev_change_requests cr ON cr.id = r.change_request_id AND cr.deleted_at IS NULL
    LEFT JOIN contracts ac ON ac.id = cr.amendment_contract_id AND ac.deleted_at IS NULL`;

/** True for a request sent from another group company (DW-10e). */
export const isCrossRow = (r: { tenant_id: string; requester_tenant_id: string }): boolean => r.requester_tenant_id !== r.tenant_id;

const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** The row of §32.5, shared by the list and the detail read. DW-10e (§60.6) adds `requestingCompany`, `requesterUnit` and
 *  `client`: all three `null` on a same-company row. On a cross row `requesterUnit.name` is the name stored when the request
 *  was sent (the receiving company never reads the requester's tree), and `fromUnit` is `null` (`from_unit_id` is NULL by
 *  CHECK). */
export function shapeRequest(r: RequestRow, index: Map<string, OrgUnitInfo>) {
  let work: Record<string, unknown> | null = null;
  if (r.kind === "assets" && r.t_id) {
    work = {
      type: "pm_task", id: r.t_id, projectId: r.t_project_id, status: r.t_status, isDone: r.t_is_done === true,
      responsibleName: r.t_responsible_name,
    };
  } else if (r.kind === "engineering" && r.cr_id) {
    work = { type: "change_request", id: r.cr_id, status: r.cr_status, route: r.cr_route };
  }
  return {
    id: r.id, kind: r.kind, title: r.title, status: r.status, neededBy: r.needed_by,
    createdAt: iso(r.created_at), closedAt: iso(r.closed_at),
    fromUnit: r.from_unit_id ? unitView(index, r.from_unit_id) : null,
    toUnit: unitView(index, r.to_unit_id),
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name, partId: r.campaign_part_id } : null,
    work,
    assetCount: r.asset_count,
    requestingCompany: isCrossRow(r) ? { id: r.requester_tenant_id, name: r.requesting_company_name } : null,
    requesterUnit: isCrossRow(r) && r.requester_unit_id ? { id: r.requester_unit_id, name: r.requester_unit_name } : null,
    client: isCrossRow(r) && r.client_id ? { id: r.client_id, name: r.client_name } : null,
  };
}

export async function listRequests(
  c: PoolClient, q: ListQuery, principalId: string, index: Map<string, OrgUnitInfo>,
) {
  const where: string[] = ["r.deleted_at IS NULL"];
  const args: unknown[] = [];
  const push = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (q.box === "incoming") where.push(`r.to_unit_id = ${push(q.unitId)}`);
  else if (q.box === "sent") where.push(`r.from_unit_id = ${push(q.unitId)}`);
  // DW-10e (§60.6): "mine" is what I asked of THIS company. A person who is a member of both companies (the owner) would
  // otherwise find their own cross request, sent from the other company, among this company's.
  else where.push(`r.requested_by = ${push(principalId)}::uuid AND r.requester_tenant_id = r.tenant_id`);
  if (q.status === "open") where.push("r.status = 'open'");
  else if (q.status === "closed") where.push("r.status <> 'open'");
  if (q.kind) where.push(`r.kind = ${push(q.kind)}`);
  // `incoming` lists the OLDEST first (the oldest waiting is the one to act on); `sent` and `mine` the newest first.
  const order = q.box === "incoming" ? "r.created_at ASC, r.id ASC" : "r.created_at DESC, r.id DESC";
  const { rows } = await c.query<RequestRow>(
    `${REQUEST_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${LIST_LIMIT}`,
    args,
  );
  return rows.map((r) => shapeRequest(r, index));
}

export async function getRequest(c: PoolClient, tenantId: string, requestId: string, index: Map<string, OrgUnitInfo>) {
  if (!isUuidShaped(requestId)) return null;
  const { rows } = await c.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1 AND r.deleted_at IS NULL`, [requestId]);
  if (!rows[0]) return null;
  const assets = await c.query<{ id: string; name: string; content_type: string }>(
    `SELECT a.id, a.name, a.content_type
       FROM work_request_assets w JOIN creative_assets a ON a.id = w.asset_id
      WHERE w.request_id = $1 ORDER BY w.added_at, a.id`,
    [requestId],
  );
  return {
    ...shapeRequest(rows[0], index),
    brief: rows[0].brief,
    form: rows[0].form,
    declineReason: rows[0].decline_reason,
    // `href` is the existing creative-asset content route.
    assets: assets.rows.map((a) => ({ id: a.id, name: a.name, contentType: a.content_type, href: `/api/${tenantId}/creative/assets/${a.id}/content` })),
  };
}

/** `GET requests/summary`: honest numbers, straight from the table. A failure is a failure (the caller's 500), never a 0. */
export async function requestSummary(c: PoolClient, unitId: string) {
  const { rows } = await c.query<{ incoming_open: number; oldest: string | null; sent_open: number }>(
    `SELECT (SELECT count(*)::int FROM work_requests WHERE deleted_at IS NULL AND status = 'open' AND to_unit_id = $1) AS incoming_open,
            (SELECT min(created_at) FROM work_requests WHERE deleted_at IS NULL AND status = 'open' AND to_unit_id = $1) AS oldest,
            (SELECT count(*)::int FROM work_requests WHERE deleted_at IS NULL AND status = 'open' AND from_unit_id = $1) AS sent_open`,
    [unitId],
  );
  const r = rows[0];
  return { incoming: { open: r.incoming_open, oldestOpenAt: iso(r.oldest) }, sent: { open: r.sent_open } };
}

// ───────────────────────────────────────── §32.6 sync from the change request ─────────────────────────────────────────

export interface WorkRequestSync {
  tenantId: string;
  requestId: string;
  requestedBy: string;
  title: string;
  from: RequestStatus;
  to: "open" | "delivered" | "declined";
  /** DW-10e (§60.6): the company that asked; equals `tenantId` on a same-company request. The requester is told, and the
   *  mirror event is written, in THIS company. */
  requesterTenantId: string;
  /** The receiving company's name, for the requester's notification title on a cross request. */
  receivingName: string | null;
}

/** DW-10e (§60.7): the three keys every `work_request.*` event of the RECEIVING company gains on a cross-company request
 *  (`{}` on a same-company one, whose payloads stay exactly as §32.7 wrote them). Ids only. */
export function crossEventKeys(r: {
  tenant_id: string; requester_tenant_id: string; service_assignment_id: string | null; client_id: string | null;
}): Record<string, unknown> {
  if (r.requester_tenant_id === r.tenant_id) return {};
  return { requesterTenantId: r.requester_tenant_id, serviceAssignmentId: r.service_assignment_id, clientId: r.client_id };
}

/** §32.6: keep the ask in step with its change request, INSIDE the change-request route's own transaction (triage decline,
 *  verify, unverify). It reads the change request's current status and moves the ask by `planSync`:
 *    declined -> the ask is `declined` (with the triage reason), verified -> `delivered`, anything else -> `open`
 *    (an unverified request reopens, with `closed_*` and the reason cleared).
 *  A change request that came from no `work_requests` row is untouched (returns `null`), and so is a cancelled ask.
 *  The ask row is locked FOR UPDATE; the CALLER already holds the change-request advisory lock, which is the one lock order
 *  every path here follows (change-request lock first, ask row second; the cancel route takes them in the same order).
 *  The caller sends the notification from the returned value AFTER its commit (`notifyWorkRequestSync`). */
export async function syncWorkRequestFromChangeRequest(c: PoolClient, changeRequestId: string): Promise<WorkRequestSync | null> {
  const ask = await c.query<{
    id: string; tenant_id: string; status: RequestStatus; requested_by: string; title: string;
    requester_tenant_id: string; service_assignment_id: string | null; client_id: string | null; receiving_name: string | null;
  }>(
    `SELECT id, tenant_id, status, requested_by, title, requester_tenant_id, service_assignment_id, client_id,
            (SELECT name FROM companies WHERE id = work_requests.tenant_id) AS receiving_name
       FROM work_requests
      WHERE change_request_id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [changeRequestId],
  );
  const wr = ask.rows[0];
  if (!wr) return null;
  const cr = await c.query<{ status: string; declined_reason: string | null; triaged_by: string | null; verified_by: string | null }>(
    `SELECT status, declined_reason, triaged_by, verified_by FROM webdev_change_requests WHERE id = $1`,
    [changeRequestId],
  );
  const row = cr.rows[0];
  if (!row) return null;
  const to = planSync(wr.status, row.status);
  if (!to) return null;
  const cross = crossEventKeys(wr);
  if (to === "declined") {
    await c.query(
      `UPDATE work_requests SET status = 'declined', closed_by = $2, closed_at = now(), decline_reason = $3, updated_at = now() WHERE id = $1`,
      [wr.id, row.triaged_by, (row.declined_reason ?? "").trim() || DECLINED_BY_TRIAGE],
    );
    await emitEvent(c, wr.tenant_id, "work_request", wr.id, "work_request.declined", { requestId: wr.id, changeRequestId, via: "triage", ...cross });
  } else if (to === "delivered") {
    await c.query(
      `UPDATE work_requests SET status = 'delivered', closed_by = $2, closed_at = now(), decline_reason = NULL, updated_at = now() WHERE id = $1`,
      [wr.id, row.verified_by],
    );
    await emitEvent(c, wr.tenant_id, "work_request", wr.id, "work_request.delivered", { requestId: wr.id, changeRequestId, via: "verify", ...cross });
  } else {
    await c.query(
      `UPDATE work_requests SET status = 'open', closed_by = NULL, closed_at = NULL, decline_reason = NULL, updated_at = now() WHERE id = $1`,
      [wr.id],
    );
    await emitEvent(c, wr.tenant_id, "work_request", wr.id, "work_request.reopened", { requestId: wr.id, changeRequestId, ...cross });
  }
  return {
    tenantId: wr.tenant_id, requestId: wr.id, requestedBy: wr.requested_by, title: wr.title, from: wr.status, to,
    requesterTenantId: wr.requester_tenant_id, receivingName: wr.receiving_name,
  };
}

// ───────────────────────────────────────── DW-10e: the requesting company's side effects ─────────────────────────────────────────
// BFF §60.7. A cross-company request lives in the receiving company P; its requester belongs to H. Everything the REQUESTER
// is told, and the mirror event an n8n flow on H's side reacts to, is written in H's OWN tenant, in a transaction of its own
// over H alone (`withTenants([H])`), AFTER the receiving company's transaction committed. Best-effort and logged loudly, as
// §32.7: a failure here never undoes the committed write.

export const OUTBOUND_TRANSITIONS = ["created", "cancelled", "delivered", "declined", "reopened"] as const;
export type OutboundTransition = (typeof OUTBOUND_TRANSITIONS)[number];

/** The sender's page for a request (platform-ui `/requests/outbound/[id]`, §60.9). */
export const outboundHref = (requestId: string): string => `/requests/outbound/${requestId}`;

/** H's mirror event of one transition: `work_request.outbound.<transition>`, ids only, correlated by the request id (the
 *  `emitDual` precedent of service assignments). Never throws. */
export async function emitOutboundMirror(
  requesterTenantId: string, requestId: string, receivingTenantId: string, transition: OutboundTransition,
): Promise<void> {
  try {
    await withTenants([requesterTenantId], (c) =>
      emitEvent(c, requesterTenantId, "work_request", requestId, `work_request.outbound.${transition}`, {
        requestId, receivingTenantId, correlationId: requestId,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[work-requests] outbound mirror event failed (request=${requestId}, transition=${transition}):`, (err as Error)?.message ?? err);
  }
}

/** The requester hears that the work was delivered (or more was) or declined: in their OWN company, with the link their side
 *  can open. A same-company request keeps §32.7's link and titles; a cross one names the receiving company. */
export async function notifyRequesterOutcome(o: {
  requestTenantId: string; requesterTenantId: string; receivingName: string | null; actorId: string | null; requestedBy: string;
  requestId: string; title: string; outcome: "delivered" | "delivered_more" | "declined"; body?: string;
}): Promise<void> {
  const cross = o.requesterTenantId !== o.requestTenantId;
  const p = o.receivingName ?? "the other company";
  const title = o.outcome === "declined"
    ? (cross ? `Your request to ${p} was declined: ${o.title}` : `Your request was declined: ${o.title}`)
    : o.outcome === "delivered_more"
      ? (cross ? `${p} delivered more assets: ${o.title}` : `More assets were delivered: ${o.title}`)
      : (cross ? `Your request to ${p} was delivered: ${o.title}` : `Your request was delivered: ${o.title}`);
  await notifyBestEffort(o.requesterTenantId, o.actorId, [o.requestedBy], o.outcome === "declined" ? "request.declined" : "request.delivered", {
    title,
    ...(o.body !== undefined ? { body: o.body } : {}),
    href: cross ? outboundHref(o.requestId) : `/requests/${o.requestId}`,
    entityType: "work_request", entityId: o.requestId, severity: o.outcome === "declined" ? "warning" : "info",
  });
}

/** BFF §60.6: triage's `awaiting_amendment` outcome drafted a price agreement for a change request; when that change request
 *  carries a CROSS request, its requester is told in their own company (`request.price_agreement`), once per new draft (each
 *  `awaiting_amendment` is a fresh draft). Reads the request in its own transaction over the receiving company, then notifies
 *  in the requester's. Never throws. */
export async function notifyPriceAgreement(receivingTenantId: string, actorId: string | null, changeRequestId: string): Promise<void> {
  try {
    const row = await withTenants([receivingTenantId], async (c) => {
      const r = await c.query<{ id: string; requester_tenant_id: string; requested_by: string; title: string; receiving_name: string | null }>(
        `SELECT id, requester_tenant_id, requested_by, title,
                (SELECT name FROM companies WHERE id = work_requests.tenant_id) AS receiving_name
           FROM work_requests
          WHERE tenant_id = $1 AND change_request_id = $2 AND deleted_at IS NULL AND requester_tenant_id <> tenant_id`,
        [receivingTenantId, changeRequestId],
      );
      return r.rows[0] ?? null;
    });
    if (!row) return;
    await notifyBestEffort(row.requester_tenant_id, actorId, [row.requested_by], "request.price_agreement", {
      title: `${row.receiving_name ?? "The other company"} needs a price agreement before starting: ${row.title}`,
      href: outboundHref(row.id), entityType: "work_request", entityId: row.id, severity: "info",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[work-requests] request.price_agreement notification failed (change request=${changeRequestId}):`, (err as Error)?.message ?? err);
  }
}

// ───────────────────────────────────────── §32.7 notifications (best-effort, never fail the write) ─────────────────────────────────────────

/** The requester hears the outcome of an engineering request that the change-request routes just moved. Called AFTER the
 *  change-request transaction commits, with whatever `syncWorkRequestFromChangeRequest` returned (a reopen is silent).
 *  DW-10e (§60.7): on a CROSS request the requester is told in THEIR company with the sender's link, and every transition,
 *  the reopen included, also writes H's mirror event. */
export async function notifyWorkRequestSync(actorId: string | null, sync: WorkRequestSync | null): Promise<void> {
  if (!sync) return;
  const cross = sync.requesterTenantId !== sync.tenantId;
  if (cross) await emitOutboundMirror(sync.requesterTenantId, sync.requestId, sync.tenantId, sync.to === "open" ? "reopened" : sync.to);
  if (sync.to === "open") return;
  await notifyRequesterOutcome({
    requestTenantId: sync.tenantId, requesterTenantId: sync.requesterTenantId, receivingName: sync.receivingName, actorId,
    requestedBy: sync.requestedBy, requestId: sync.requestId, title: sync.title, outcome: sync.to,
  });
}
