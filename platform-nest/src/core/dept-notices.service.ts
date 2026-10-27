// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57) — the department notice board: the body and query validators, the cursor, the current/past
// rule, the pin limit, the row shape and the SQL of every read and write, kept out of the controller so the rules are unit-testable
// and the controller stays a thin authorize-then-delegate layer (the DW-8g calendar-events layout).
//
// Two halves in one file, on purpose:
//   1. PURE rules: body and query parsing, the scope the Cerbos check needs BEFORE validation, the cursor, `stateOf`, `toNoticeRow`.
//      No DB, no Nest: `dept-notices.service.test.ts` drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one `withTenants` transaction.
//
// A notice is one row on a unit's board (`scope = 'unit'`, an org-tree node) or on the company's (`scope = 'company'`, no unit). It is
// never deleted: a withdrawal stamps `withdrawn_at` and the row leaves every list and read. CURRENT = not withdrawn and `ends_on` is
// NULL or on or after the company's report day (`todayIsoInTz(config.reportsTz)`); otherwise PAST.
import type { PoolClient } from "pg";
import { scrubText } from "./scrub";

// ───────────────────────────────────────────── vocabulary ─────────────────────────────────────────────

export const SCOPES = ["unit", "company"] as const;
export type NoticeScope = (typeof SCOPES)[number];
export const STATES = ["current", "past"] as const;
export type NoticeState = (typeof STATES)[number];

export const TITLE_MAX = 120;
export const BODY_MAX = 4_000;
/** At most this many CURRENT pinned notices per unit, and per company scope (§57.1). */
export const PIN_LIMIT = 3;
export const LIST_DEFAULT = 20;
export const LIST_MAX = 50;
/** The notification type a post fans out (§57.6). */
export const NOTICE_POSTED = "notice.posted";

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class NoticeRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    /** The machine code the contract names (`unit_not_found`, `notice_not_found`, `pin_limit`); for a 400 the human text. */
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "NoticeRuleError";
  }
}
const bad = (message: string, field: string) => new NoticeRuleError(400, message, field);
export const noticeNotFound = () => new NoticeRuleError(404, "notice_not_found");
export const unitNotFound = () => new NoticeRuleError(404, "unit_not_found", "unitNodeId");

// ───────────────────────────────────────── pure input parsing ─────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Plain text: a NUL cannot live in a Postgres text column (it would be a 500), and nothing here is ever interpreted as markup. PAN,
 *  national ids and e-mail addresses are scrubbed exactly as other free text is (`scrubText`), BEFORE the length is measured: the
 *  scrubbed text is what is stored, and a redaction tag can be longer than what it replaced. CRLF becomes LF (line breaks are kept). */
function plainText(s: string): string {
  return scrubText(s.replace(/\u0000/g, "").replace(/\r\n?/g, "\n")).text;
}
/** Length in code points, as Postgres `char_length` counts them (a JS string's `.length` counts UTF-16 units). */
const cpLength = (s: string): number => Array.from(s).length;

/** `YYYY-MM-DD` that is a real calendar date (2026-02-30 is not). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The two body fields the Cerbos check needs BEFORE anything is validated (§57.3): `scope` and `unitNodeId`. Nothing else is read.
 * Anything that is not exactly `unit` is authorized as a COMPANY-WIDE notice (the narrowest right, company_admin only), so a head
 * who sends a missing, mistyped or `company` scope is refused with 403, never widened and never answered with a 400 that would show
 * the validation ran first. A company_admin passes the check and then meets the 400 from `parsePost`.
 */
export function authFactsOf(body: unknown): { scope: NoticeScope; unitNodeId: string } {
  const b = isPlainObject(body) ? body : {};
  if (b.scope === "unit") return { scope: "unit", unitNodeId: typeof b.unitNodeId === "string" ? b.unitNodeId : "" };
  return { scope: "company", unitNodeId: "" };
}

export interface PostInput {
  scope: NoticeScope;
  unitNodeId: string | null;
  title: string;
  body: string;
  pinned: boolean;
  endsOn: string | null;
}

const POST_KEYS = new Set(["scope", "unitNodeId", "title", "body", "pinned", "endsOn"]);
const PATCH_KEYS = new Set(["title", "body", "pinned", "endsOn"]);

function parseTitle(v: unknown): string {
  if (typeof v !== "string") throw bad("title is required", "title");
  const t = plainText(v).trim();
  const n = cpLength(t);
  if (n < 1 || n > TITLE_MAX) throw bad(`title must be 1 to ${TITLE_MAX} characters`, "title");
  return t;
}
function parseBodyText(v: unknown): string {
  if (typeof v !== "string") throw bad("body is required", "body");
  const t = plainText(v).trim();
  const n = cpLength(t);
  if (n < 1 || n > BODY_MAX) throw bad(`body must be 1 to ${BODY_MAX} characters`, "body");
  return t;
}
function parsePinned(v: unknown): boolean {
  if (typeof v !== "boolean") throw bad("pinned must be true or false", "pinned");
  return v;
}
function parseEndsOn(v: unknown): string {
  if (typeof v !== "string" || !isIsoDate(v)) throw bad("endsOn must be a date, YYYY-MM-DD", "endsOn");
  return v;
}
function refuseUnknownKeys(b: Record<string, unknown>, allowed: Set<string>): void {
  for (const k of Object.keys(b)) if (!allowed.has(k)) throw bad(`${k} is not a field of a notice`, k);
}

/** The POST body, validated AFTER the authorization decision. `today` is the company's report day: an end date before it is refused. */
export function parsePost(body: unknown, today: string): PostInput {
  if (!isPlainObject(body)) throw bad("the body must be an object", "scope");
  refuseUnknownKeys(body, POST_KEYS);
  if (body.scope !== "unit" && body.scope !== "company") throw bad("scope must be unit or company", "scope");
  const scope: NoticeScope = body.scope;
  let unitNodeId: string | null = null;
  if (scope === "unit") {
    if (typeof body.unitNodeId !== "string" || body.unitNodeId.trim() === "") throw bad("unitNodeId is required for a unit notice", "unitNodeId");
    unitNodeId = body.unitNodeId;
  } else if (body.unitNodeId !== undefined && body.unitNodeId !== null) {
    throw bad("a company-wide notice has no unitNodeId", "unitNodeId");
  }
  const title = parseTitle(body.title);
  const text = parseBodyText(body.body);
  const pinned = body.pinned === undefined ? false : parsePinned(body.pinned);
  let endsOn: string | null = null;
  if (body.endsOn !== undefined && body.endsOn !== null) {
    endsOn = parseEndsOn(body.endsOn);
    if (endsOn < today) throw bad("endsOn must not be before today", "endsOn");
  }
  return { scope, unitNodeId, title, body: text, pinned, endsOn };
}

export interface PatchInput {
  title?: string;
  body?: string;
  pinned?: boolean;
  /** `null` clears the end date; absent leaves it. */
  endsOn?: string | null;
}

/** The PATCH body, validated AFTER the edit decision. An end date in the past is allowed here (it is how a notice is put away). */
export function parsePatch(body: unknown): PatchInput {
  if (!isPlainObject(body)) throw bad("the body must be an object", "title");
  refuseUnknownKeys(body, PATCH_KEYS);
  const out: PatchInput = {};
  if (body.title !== undefined) out.title = parseTitle(body.title);
  if (body.body !== undefined) out.body = parseBodyText(body.body);
  if (body.pinned !== undefined) out.pinned = parsePinned(body.pinned);
  if (body.endsOn !== undefined) out.endsOn = body.endsOn === null ? null : parseEndsOn(body.endsOn);
  if (Object.keys(out).length === 0) throw new NoticeRuleError(400, "nothing to change");
  return out;
}

// ───────────────────────────────────────── list query + cursor ─────────────────────────────────────────

/** `all` is the house sentinel for "not given" (conversation.listThreads), so a generic hub tool can send every key. `home` is the
 *  agent form of "the caller's own department" (§57.7). */
const UNSET = new Set(["", "all"]);
export const HOME = "home";

export interface ListQuery {
  /** `company`: the company-wide notices only. `unit`: a unit's board, `unitNodeId` set (possibly the `home` sentinel). */
  mode: "company" | "unit";
  unitNodeId: string | null;
  state: NoticeState;
  limit: number;
  cursor: Cursor | null;
}

/** The mode alone, which the Cerbos `read` check needs before the rest of the query is looked at. */
export function listModeOf(query: Record<string, unknown>): "company" | "unit" {
  return query.scope === "company" ? "company" : "unit";
}

function one(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const scope = one(query.scope);
  if (scope !== undefined && !UNSET.has(scope) && scope !== "company" && scope !== "unit") throw bad("scope must be company", "scope");
  const rawUnit = one(query.unitNodeId);
  const unitGiven = rawUnit !== undefined && !UNSET.has(rawUnit);
  const mode = scope === "company" ? "company" : "unit";
  let unitNodeId: string | null = null;
  if (mode === "company") {
    // The hub tool sends its `home` default beside `scope=company`: that is the company list, not a conflict. A real unit id is.
    if (unitGiven && rawUnit !== HOME) throw bad("unitNodeId cannot be combined with scope=company", "unitNodeId");
  } else if (!unitGiven) {
    throw bad("unitNodeId is required (or scope=company)", "unitNodeId");
  } else {
    unitNodeId = rawUnit as string;
  }

  const rawState = one(query.state);
  const state = rawState === undefined || UNSET.has(rawState) ? "current" : rawState;
  if (state !== "current" && state !== "past") throw bad("state must be current or past", "state");

  let limit = LIST_DEFAULT;
  const rawLimit = one(query.limit);
  if (rawLimit !== undefined && !UNSET.has(rawLimit)) {
    if (!/^\d{1,3}$/.test(rawLimit)) throw bad(`limit must be 1 to ${LIST_MAX}`, "limit");
    limit = Number(rawLimit);
    if (limit < 1 || limit > LIST_MAX) throw bad(`limit must be 1 to ${LIST_MAX}`, "limit");
  }

  const rawCursor = one(query.cursor);
  const cursor = rawCursor === undefined || UNSET.has(rawCursor) ? null : decodeCursor(rawCursor, state);
  return { mode, unitNodeId, state, limit, cursor };
}

/** Where the last returned row sat in the order. `createdKey` is the row's `created_at` at MICROSECOND precision, as text: a JS Date
 *  would cut it to milliseconds and the keyset comparison would skip or repeat rows. */
export interface Cursor {
  state: NoticeState;
  pinned: boolean;
  createdKey: string;
  id: string;
}
const CREATED_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.state, c.pinned, c.createdKey, c.id]), "utf8").toString("base64url");
}
export function decodeCursor(raw: string, state: NoticeState): Cursor {
  const invalid = () => bad("cursor is not valid", "cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw invalid();
  const [s, pinned, createdKey, id] = parsed as unknown[];
  if (s !== state) throw invalid(); // a cursor belongs to the state that issued it
  if (typeof pinned !== "boolean" || typeof createdKey !== "string" || !CREATED_KEY_RE.test(createdKey)) throw invalid();
  if (typeof id !== "string" || !UUID_RE.test(id)) throw invalid();
  return { state, pinned, createdKey, id };
}

// ───────────────────────────────────────── the row ─────────────────────────────────────────

/** `current` while `ends_on` is NULL or on or after today, else `past` (a withdrawn notice never reaches this: it is not listed). */
export function stateOf(endsOn: string | null, today: string): NoticeState {
  return endsOn !== null && endsOn < today ? "past" : "current";
}

export interface NoticeDbRow {
  id: string;
  scope: NoticeScope;
  unit_node_id: string | null;
  title: string;
  body: string;
  pinned: boolean;
  ends_on: string | null;
  author_id: string;
  author_name: string | null;
  created_at: Date;
  created_key: string;
  edited_at: Date | null;
  withdrawn_at: Date | null;
}

export interface NoticeRow {
  id: string;
  scope: NoticeScope;
  unitNodeId: string | null;
  unitName: string | null;
  title: string;
  body: string;
  pinned: boolean;
  endsOn: string | null;
  state: NoticeState;
  author: { id: string; name: string };
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
}

/** `unitNameOf` reads the org tree at read time: a node that has left the tree is `null` ("a former unit"). */
export function toNoticeRow(r: NoticeDbRow, today: string, unitNameOf: (unitNodeId: string) => string | null, canEdit: boolean): NoticeRow {
  return {
    id: r.id,
    scope: r.scope,
    unitNodeId: r.unit_node_id,
    unitName: r.unit_node_id === null ? null : unitNameOf(r.unit_node_id),
    title: r.title,
    body: r.body,
    pinned: r.pinned,
    endsOn: r.ends_on,
    state: stateOf(r.ends_on, today),
    author: { id: r.author_id, name: r.author_name ?? "" },
    createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at ? r.edited_at.toISOString() : null,
    canEdit,
  };
}

/** The Inbox link of a posted notice (§57.6). */
export function noticeHref(scope: NoticeScope, unitNodeId: string | null, id: string): string {
  return scope === "company" || unitNodeId === null ? `/notices#${id}` : `/departments/${encodeURIComponent(unitNodeId)}/notices#${id}`;
}

// ───────────────────────────────────────── SQL ─────────────────────────────────────────

const COLUMNS = `n.id, n.scope, n.unit_node_id, n.title, n.body, n.pinned, to_char(n.ends_on, 'YYYY-MM-DD') AS ends_on, n.author_id,
  u.name AS author_name, n.created_at, to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key,
  n.edited_at, n.withdrawn_at`;

/** One notice by id (RLS keeps it in the tenant), WITHDRAWN rows included: the caller decides. `lock` takes the row lock for a write. */
export async function loadNotice(c: PoolClient, tenantId: string, id: string, lock = false): Promise<NoticeDbRow | null> {
  const { rows } = await c.query<NoticeDbRow>(
    `SELECT ${COLUMNS}
       FROM dept_notices n JOIN users u ON u.id = n.author_id
      WHERE n.tenant_id = $1 AND n.id = $2${lock ? " FOR UPDATE OF n" : ""}`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/** One keyset page of live (not withdrawn) notices, in the list order, `limit` rows. `unitIds` null = company-wide only; otherwise the
 *  company-wide notices and those of the listed units. The caller applies the per-notice reach on top and asks again for more. */
export async function listNoticeRows(
  c: PoolClient,
  tenantId: string,
  q: { unitIds: string[] | null; state: NoticeState; today: string; after: Cursor | null; limit: number },
): Promise<NoticeDbRow[]> {
  const args: unknown[] = [tenantId, q.today];
  const where: string[] = ["n.tenant_id = $1", "n.withdrawn_at IS NULL"];
  if (q.unitIds === null) {
    where.push("n.scope = 'company'");
  } else {
    args.push(q.unitIds);
    where.push(`(n.scope = 'company' OR (n.scope = 'unit' AND n.unit_node_id = ANY($${args.length}::text[])))`);
  }
  where.push(q.state === "current" ? "(n.ends_on IS NULL OR n.ends_on >= $2::date)" : "n.ends_on < $2::date");
  // Current: pinned first, then newest. Past: newest. Every key descends, so one row comparison is the keyset.
  const order = q.state === "current" ? "n.pinned DESC, n.created_at DESC, n.id DESC" : "n.created_at DESC, n.id DESC";
  if (q.after) {
    if (q.state === "current") {
      args.push(q.after.pinned, q.after.createdKey, q.after.id);
      where.push(`(n.pinned, n.created_at, n.id) < ($${args.length - 2}::boolean, $${args.length - 1}::timestamptz, $${args.length}::uuid)`);
    } else {
      args.push(q.after.createdKey, q.after.id);
      where.push(`(n.created_at, n.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
    }
  }
  args.push(q.limit);
  const { rows } = await c.query<NoticeDbRow>(
    `SELECT ${COLUMNS}
       FROM dept_notices n JOIN users u ON u.id = n.author_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT $${args.length}`,
    args,
  );
  return rows;
}

/** Serialise the pin check per (company, scope, unit): two simultaneous pins cannot both see room for one more. */
export async function lockPinSlot(c: PoolClient, tenantId: string, scope: NoticeScope, unitNodeId: string | null): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`dept_notice_pin:${tenantId}:${scope}:${unitNodeId ?? ""}`]);
}

/** How many CURRENT pinned notices the (scope, unit) already has, `exceptId` (the notice being edited) not counted. */
export async function countCurrentPins(
  c: PoolClient,
  tenantId: string,
  scope: NoticeScope,
  unitNodeId: string | null,
  today: string,
  exceptId: string | null,
): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dept_notices
      WHERE tenant_id = $1 AND scope = $2 AND unit_node_id IS NOT DISTINCT FROM $3
        AND pinned AND withdrawn_at IS NULL AND (ends_on IS NULL OR ends_on >= $4::date)
        AND ($5::uuid IS NULL OR id <> $5::uuid)`,
    [tenantId, scope, unitNodeId, today, exceptId],
  );
  return rows[0].n;
}

/** The ancestry (self-inclusive, from the closure, this tenant's) of each unit: what Cerbos' lead rule reads. A unit with no closure
 *  rows maps to [] and no lead grant matches it. */
export async function loadAncestorsOf(c: PoolClient, tenantId: string, unitNodeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (unitNodeIds.length === 0) return out;
  const { rows } = await c.query<{ descendant_id: string; ancestor_id: string }>(
    `SELECT descendant_id, ancestor_id FROM org_unit_closure
      WHERE tenant_id = $1 AND descendant_id = ANY($2::text[])
      ORDER BY descendant_id, depth ASC`,
    [tenantId, [...new Set(unitNodeIds)]],
  );
  for (const r of rows) {
    const list = out.get(r.descendant_id) ?? [];
    list.push(r.ancestor_id);
    out.set(r.descendant_id, list);
  }
  return out;
}

/** Every active member of the company who is a PERSON (not a service account): the audience of a company-wide notice. */
export async function loadActiveMemberIds(c: PoolClient, tenantId: string): Promise<string[]> {
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT cm.user_id FROM company_memberships cm JOIN users u ON u.id = cm.user_id
      WHERE cm.tenant_id = $1 AND cm.deleted_at IS NULL AND cm.status = 'active' AND cm.kind = 'employee'
        AND u.kind = 'employee'
      ORDER BY cm.user_id`,
    [tenantId],
  );
  return rows.map((r) => r.user_id);
}
