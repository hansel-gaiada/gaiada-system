// AIP-23b (docs/plans/2026-10-31-aip-23-department-notes.md §4; owner rulings AIP-D20 to AIP-D24; docs/FRONTEND-BFF-CONTRACT.md §67;
// PERMISSION-CONTRACT §59) — department notes, a department's shared assistant memory: the body validators, the answer's shape, the facts Cerbos
// sees and the SQL, kept out of the controller so the rules are unit-testable and the controller stays a thin authorize-then-delegate layer (the
// dept-assistant-preamble layout).
//
// Three parts, on purpose:
//   1. PURE rules: `parseProposeBody`, `parseDecideBody`, `parsePinBody`, `toNoteView`, `noteResource`. No DB, no Nest:
//      `dept-assistant-notes.service.test.ts` drives them directly.
//   2. The FACTS Cerbos sees (`loadNoteFacts`): the unit's ancestry, the caller's home ancestry and the GM seats, read from the rows on the
//      caller's `withTenants([tenantId])` client and never from a body.
//   3. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one `withTenants` transaction.
//
// A note is `proposed` (waiting) or `approved`. A rejected or withdrawn note is DELETED, text and all (plan §4.1). Names are snapshot as text
// when a person suggests or decides, and kept after erasure (AIP-D23); `toNoteView` shows the current name while the person is still an active
// member of the company, else the stored one with `former: true`.
import type { PoolClient } from "pg";
import type { Resource } from "../rbac/cerbos";
import { FAMILIES, type Family } from "../modules/knowledge/search-filter";
import { loadGmSeatIds } from "../modules/ai-usage/authz";
import { loadUnitAncestors } from "./org-unit-closure";
import { scrubText } from "./scrub";

export const NOTE_KIND = "dept_assistant_note";
/** The seven actions of the kind. `manage` is the company tier (the owner, through its mirror; the superadmin, through the wildcard). */
export const NOTE_ACTIONS = ["read", "propose", "withdraw", "decide", "delete", "pin", "manage"] as const;
export type NoteAction = (typeof NOTE_ACTIONS)[number];

/** Plan §4.1 and §4.7: a note is 1 to 500 characters; 50 approved per department; 10 waiting per person per department. */
export const NOTE_BODY_MAX_CHARS = 500;
export const APPROVED_PER_DEPARTMENT_MAX = 50;
export const WAITING_PER_PERSON_MAX = 10;
/** The reject reason the decide route accepts (it is NOT stored: the notice that carries it is AIP-23d). */
export const REJECT_REASON_MAX_CHARS = 300;
/** The table's CHECKs: the unit id and a stored name. */
export const UNIT_NODE_ID_MAX_CHARS = 120;
export const NAME_MAX_CHARS = 200;
/** The linkable record kinds: exactly the families the knowledge filter checks (DW-D26). Reports, people and org are NOT linkable. */
export const LINKABLE_KINDS: readonly Family[] = FAMILIES;

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class NoteRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "NoteRuleError";
  }
}
export const departmentNotFound = () => new NoteRuleError(404, "department_not_found", "unitNodeId");
export const noteNotFound = () => new NoteRuleError(404, "note_not_found", "id");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Length in code points, as Postgres `char_length` counts them (a JS string's `.length` counts UTF-16 units). */
export const cpLength = (s: string): number => Array.from(s).length;

/** Plain text, as a preamble's is (dept-assistant-preamble.service.ts `plainText`): a NUL cannot live in a Postgres text column, CRLF becomes
 *  LF, and PAN, national ids and e-mail addresses are scrubbed BEFORE the length is measured: the scrubbed text is what is stored (and what will
 *  reach a prompt), and a redaction tag can be longer than what it replaced. */
function plainText(s: string): string {
  return scrubText(s.replace(/\u0000/g, "").replace(/\r\n?/g, "\n")).text;
}

/** A name to store: one line, at most `NAME_MAX_CHARS` code points; an empty name becomes a neutral word so the NOT NULL column holds. */
export function snapshotName(name: string | null | undefined): string {
  const flat = String(name ?? "").replace(/\s+/g, " ").trim();
  const capped = Array.from(flat).slice(0, NAME_MAX_CHARS).join("");
  return capped || "A colleague";
}

export interface ProposeInput {
  text: string;
  record: { kind: Family; id: string } | null;
}

/**
 * The suggest body: `{ body: string, record?: { kind, id } | null }`, nothing else. The text is trimmed and scrubbed; 1 to 500 characters; the
 * record (optional) names a linkable kind and a uuid. Anything else is a 400 naming the field. Called AFTER the authorization decision, so a
 * refused caller always gets 403 and never learns that the body was invalid. Whether the record exists and the caller may open it is the
 * controller's next check (it needs Cerbos).
 */
export function parseProposeBody(body: unknown): ProposeInput {
  if (!isPlainObject(body)) throw new NoteRuleError(400, "the body must be an object with a `body` string", "body");
  for (const k of Object.keys(body)) {
    if (k !== "body" && k !== "record") throw new NoteRuleError(400, `${k} is not a field of a note`, k);
  }
  if (typeof body.body !== "string") throw new NoteRuleError(400, "body is required and must be a string", "body");
  const text = plainText(body.body).trim();
  const n = cpLength(text);
  if (n === 0) throw new NoteRuleError(400, "body must not be empty", "body");
  if (n > NOTE_BODY_MAX_CHARS) throw new NoteRuleError(400, `body must be at most ${NOTE_BODY_MAX_CHARS} characters`, "body");
  let record: ProposeInput["record"] = null;
  if (body.record !== undefined && body.record !== null) {
    const r = body.record;
    if (!isPlainObject(r)) throw new NoteRuleError(400, "record must be an object { kind, id }", "record");
    for (const k of Object.keys(r)) {
      if (k !== "kind" && k !== "id") throw new NoteRuleError(400, `record.${k} is not a field of a record link`, "record");
    }
    if (typeof r.kind !== "string" || !(LINKABLE_KINDS as readonly string[]).includes(r.kind)) {
      throw new NoteRuleError(400, `record.kind must be one of ${LINKABLE_KINDS.join(", ")}`, "record");
    }
    if (!isUuid(r.id)) throw new NoteRuleError(400, "record.id must be a uuid", "record");
    record = { kind: r.kind as Family, id: r.id.toLowerCase() };
  }
  return { text, record };
}

/** The decide body: `{ approve: boolean, reason?: string }`, nothing else. The reason (at most 300 characters after the trim) is accepted and
 *  NOT stored anywhere: the notice that carries it to the person is AIP-23d (plan §5 rule 6). */
export function parseDecideBody(body: unknown): { approve: boolean; reason: string | null } {
  if (!isPlainObject(body)) throw new NoteRuleError(400, "the body must be an object with an `approve` boolean", "approve");
  for (const k of Object.keys(body)) {
    if (k !== "approve" && k !== "reason") throw new NoteRuleError(400, `${k} is not a field of a decision`, k);
  }
  if (typeof body.approve !== "boolean") throw new NoteRuleError(400, "approve is required and must be a boolean", "approve");
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") throw new NoteRuleError(400, "reason must be a string", "reason");
    const t = plainText(body.reason).trim();
    if (cpLength(t) > REJECT_REASON_MAX_CHARS) throw new NoteRuleError(400, `reason must be at most ${REJECT_REASON_MAX_CHARS} characters`, "reason");
    reason = t || null;
  }
  return { approve: body.approve, reason };
}

/** The pin body: `{ pinned: boolean }`, nothing else. */
export function parsePinBody(body: unknown): { pinned: boolean } {
  if (!isPlainObject(body)) throw new NoteRuleError(400, "the body must be an object with a `pinned` boolean", "pinned");
  for (const k of Object.keys(body)) {
    if (k !== "pinned") throw new NoteRuleError(400, `${k} is not a field of a pin`, k);
  }
  if (typeof body.pinned !== "boolean") throw new NoteRuleError(400, "pinned is required and must be a boolean", "pinned");
  return { pinned: body.pinned };
}

// ───────────────────────────────────────── the Cerbos resource ─────────────────────────────────────────

/** Everything one request needs to authorize: the unit's ancestry, the caller's home ancestry and the GM seats. Never from a body. */
export interface NoteFacts {
  unitAncestors: string[];
  homeAncestors: string[];
  gmIds: string[];
}

/** The `dept_assistant_note` resource: the company, the ROUTE's unit, its ancestry, the caller's home ancestry, the GM seats, and (for a named
 *  note) its id and author. Built only from `NoteFacts` and a stored row. */
export function noteResource(
  tenantId: string,
  unitNodeId: string,
  facts: NoteFacts,
  note?: { id: string; proposedBy: string | null } | null,
): Resource {
  return {
    kind: NOTE_KIND,
    tenantId,
    ...(note ? { id: note.id } : {}),
    unitNodeId,
    unitAncestors: [...facts.unitAncestors],
    homeAncestors: [...facts.homeAncestors],
    gmIds: [...facts.gmIds],
    proposedBy: note?.proposedBy ?? "",
  };
}

/**
 * The caller's HOME placement in this company, as Cerbos's home rules read it: their primary `org_unit_memberships` row(s) valid today (UTC),
 * each node with every ancestor from the per-tenant closure (WITH the tenant: node ids repeat across companies). The home node itself is always
 * included, so a placement on a node the closure has not seen still counts for that node alone. No placement: `[]` (no home rule can match).
 * Runs on the caller's `withTenants([tenantId])` client (org_unit_memberships and org_unit_closure are FORCE RLS).
 */
export async function loadHomeAncestors(c: PoolClient, tenantId: string, userId: string | null | undefined): Promise<string[]> {
  if (!userId) return [];
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT DISTINCT unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary
        AND valid_from <= (now() AT TIME ZONE 'UTC')::date
        AND (valid_to IS NULL OR valid_to >= (now() AT TIME ZONE 'UTC')::date)`,
    [tenantId, userId],
  );
  const out = new Set<string>();
  for (const r of rows) {
    out.add(r.unit_node_id);
    for (const a of await loadUnitAncestors(c, tenantId, r.unit_node_id)) out.add(a);
  }
  return [...out].sort();
}

/** One read of the facts, on the caller's `withTenants([tenantId])` client. */
export async function loadNoteFacts(c: PoolClient, tenantId: string, unitNodeId: string, userId: string | null | undefined): Promise<NoteFacts> {
  return {
    unitAncestors: await loadUnitAncestors(c, tenantId, unitNodeId),
    homeAncestors: await loadHomeAncestors(c, tenantId, userId),
    gmIds: await loadGmSeatIds(c, tenantId),
  };
}

// ───────────────────────────────────────── the answer ─────────────────────────────────────────

export interface NoteDbRow {
  id: string;
  unit_node_id: string;
  body: string;
  status: "proposed" | "approved";
  record_kind: string | null;
  record_id: string | null;
  proposed_by: string | null;
  proposed_by_name: string;
  /** users.name when the author still exists AND holds an active membership of this company, else null. */
  proposed_by_current: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_by_current: string | null;
  pinned: boolean;
  proposed_at: Date;
  decided_at: Date | null;
}

export interface PersonRef {
  /** The user id, or null after the user row was erased. */
  id: string | null;
  /** The current name while the person is an active member of the company, else the name stored when they acted. */
  name: string;
  /** True when the person is no longer an active member of the company (or their user row is gone): the "former colleague" mark. */
  former: boolean;
}

export interface NoteView {
  id: string;
  unitNodeId: string;
  body: string;
  status: "proposed" | "approved";
  pinned: boolean;
  record: { kind: string; id: string } | null;
  proposedBy: PersonRef;
  decidedBy: PersonRef | null;
  proposedAt: string;
  decidedAt: string | null;
}

/** The person shown on a note (AIP-D22: both names; AIP-D23: kept after erasure, with the "former" mark). */
export function personRef(id: string | null, stored: string, current: string | null): PersonRef {
  return current !== null && id !== null ? { id, name: current, former: false } : { id, name: stored, former: true };
}

export function toNoteView(row: NoteDbRow): NoteView {
  return {
    id: row.id,
    unitNodeId: row.unit_node_id,
    body: row.body,
    status: row.status,
    pinned: row.pinned,
    record: row.record_kind && row.record_id ? { kind: row.record_kind, id: row.record_id } : null,
    proposedBy: personRef(row.proposed_by, row.proposed_by_name, row.proposed_by_current),
    decidedBy: row.status === "approved" && row.decided_by_name !== null ? personRef(row.decided_by, row.decided_by_name, row.decided_by_current) : null,
    proposedAt: row.proposed_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/** The capabilities the answer carries: what the screens may offer (the server still checks each action). */
export interface NoteCapabilities {
  canPropose: boolean;
  canDecide: boolean;
  canManage: boolean;
}

// ───────────────────────────────────────── SQL ─────────────────────────────────────────

/** The note columns with the current names. A name is "current" only while the user exists AND holds an active membership of the note's
 *  company (`company_memberships`, not deleted, status active); otherwise the stored snapshot shows, marked former. */
const NOTE_SELECT = `
  SELECT n.id, n.unit_node_id, n.body, n.status, n.record_kind, n.record_id::text AS record_id,
         n.proposed_by, n.proposed_by_name,
         CASE WHEN pm.user_id IS NOT NULL THEN pu.name END AS proposed_by_current,
         n.decided_by, n.decided_by_name,
         CASE WHEN dm.user_id IS NOT NULL THEN du.name END AS decided_by_current,
         n.pinned, n.proposed_at, n.decided_at
    FROM assistant_dept_notes n
    LEFT JOIN users pu ON pu.id = n.proposed_by
    LEFT JOIN company_memberships pm ON pm.tenant_id = n.tenant_id AND pm.user_id = n.proposed_by AND pm.deleted_at IS NULL AND pm.status = 'active'
    LEFT JOIN users du ON du.id = n.decided_by
    LEFT JOIN company_memberships dm ON dm.tenant_id = n.tenant_id AND dm.user_id = n.decided_by AND dm.deleted_at IS NULL AND dm.status = 'active'`;

/** One note of (tenant, unit), or `null`. A non-uuid id is `null` without a query. */
export async function loadNote(c: PoolClient, tenantId: string, unitNodeId: string, id: string): Promise<NoteDbRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await c.query<NoteDbRow>(`${NOTE_SELECT} WHERE n.tenant_id = $1 AND n.unit_node_id = $2 AND n.id = $3`, [tenantId, unitNodeId, id]);
  return rows[0] ?? null;
}

/** Only the author of a note of (tenant, unit), for the Cerbos resource of a named note (read before authorizing). */
export async function loadNoteAuthor(c: PoolClient, tenantId: string, unitNodeId: string, id: string): Promise<{ id: string; proposedBy: string | null } | null> {
  if (!isUuid(id)) return null;
  const { rows } = await c.query<{ id: string; proposed_by: string | null }>(
    `SELECT id, proposed_by FROM assistant_dept_notes WHERE tenant_id = $1 AND unit_node_id = $2 AND id = $3`,
    [tenantId, unitNodeId, id],
  );
  return rows[0] ? { id: rows[0].id, proposedBy: rows[0].proposed_by } : null;
}

/** The department's notes for the list: approved (pinned first, then newest decided), waiting (oldest first: a queue), and the caller's own
 *  (newest first). `withWaiting` false skips the queue entirely. */
export async function loadNoteLists(
  c: PoolClient,
  tenantId: string,
  unitNodeId: string,
  userId: string | null,
  withWaiting: boolean,
): Promise<{ approved: NoteDbRow[]; waiting: NoteDbRow[]; mine: NoteDbRow[] }> {
  const approved = await c.query<NoteDbRow>(
    `${NOTE_SELECT} WHERE n.tenant_id = $1 AND n.unit_node_id = $2 AND n.status = 'approved' ORDER BY n.pinned DESC, n.decided_at DESC, n.id`,
    [tenantId, unitNodeId],
  );
  const waiting = withWaiting
    ? await c.query<NoteDbRow>(
        `${NOTE_SELECT} WHERE n.tenant_id = $1 AND n.unit_node_id = $2 AND n.status = 'proposed' ORDER BY n.proposed_at ASC, n.id`,
        [tenantId, unitNodeId],
      )
    : { rows: [] as NoteDbRow[] };
  const mine = userId
    ? await c.query<NoteDbRow>(
        `${NOTE_SELECT} WHERE n.tenant_id = $1 AND n.unit_node_id = $2 AND n.proposed_by = $3 ORDER BY n.proposed_at DESC, n.id`,
        [tenantId, unitNodeId, userId],
      )
    : { rows: [] as NoteDbRow[] };
  return { approved: approved.rows, waiting: waiting.rows, mine: mine.rows };
}

/** NS for the per-department advisory lock: the caps (50 approved, 10 waiting per person) are counted and written under it, so two writers
 *  cannot both pass a count of 49. Transaction-scoped: released by COMMIT/ROLLBACK. */
export const DEPT_NOTE_LOCK_NS = 0x444e0001;
export async function lockDepartment(c: PoolClient, tenantId: string, unitNodeId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [DEPT_NOTE_LOCK_NS, `${tenantId}:${unitNodeId}`]);
}

export async function countApproved(c: PoolClient, tenantId: string, unitNodeId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM assistant_dept_notes WHERE tenant_id = $1 AND unit_node_id = $2 AND status = 'approved'`,
    [tenantId, unitNodeId],
  );
  return rows[0].n;
}

export async function countWaitingBy(c: PoolClient, tenantId: string, unitNodeId: string, userId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM assistant_dept_notes WHERE tenant_id = $1 AND unit_node_id = $2 AND proposed_by = $3 AND status = 'proposed'`,
    [tenantId, unitNodeId, userId],
  );
  return rows[0].n;
}

/** The caller's name as stored on a note (users.name, snapshot). */
export async function loadUserName(c: PoolClient, userId: string): Promise<string> {
  const { rows } = await c.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [userId]);
  return snapshotName(rows[0]?.name);
}

/** Insert a note: waiting, or approved at once when the author may decide here (a head's own note). Returns the new id. */
export async function insertNote(
  c: PoolClient,
  tenantId: string,
  unitNodeId: string,
  input: ProposeInput,
  author: { id: string; name: string },
  approved: boolean,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO assistant_dept_notes
       (tenant_id, unit_node_id, body, status, record_kind, record_id, proposed_by, proposed_by_name, decided_by, decided_by_name, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11::boolean THEN now() END)
     RETURNING id`,
    [
      tenantId, unitNodeId, input.text, approved ? "approved" : "proposed", input.record?.kind ?? null, input.record?.id ?? null,
      author.id, author.name, approved ? author.id : null, approved ? author.name : null, approved,
    ],
  );
  return rows[0].id;
}

/** Approve a waiting note. Returns whether a waiting row was there (an already-approved or vanished note answers false). */
export async function approveNote(c: PoolClient, tenantId: string, id: string, decider: { id: string; name: string }): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE assistant_dept_notes
        SET status = 'approved', decided_by = $3, decided_by_name = $4, decided_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'`,
    [tenantId, id, decider.id, decider.name],
  );
  return (rowCount ?? 0) > 0;
}

/** Delete a note (reject, withdraw, delete: the text goes with the row). Returns whether a row was there. */
export async function deleteNote(c: PoolClient, tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await c.query(`DELETE FROM assistant_dept_notes WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return (rowCount ?? 0) > 0;
}

/** Pin or unpin an approved note. Returns whether an approved row was there. */
export async function setPinned(c: PoolClient, tenantId: string, id: string, pinned: boolean): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE assistant_dept_notes SET pinned = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'approved'`,
    [tenantId, id, pinned],
  );
  return (rowCount ?? 0) > 0;
}
