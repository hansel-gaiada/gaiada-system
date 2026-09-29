// Pure validation for the clients CRUD + notes bodies (CC-D10). No DB, no Nest DI — every function
// either returns a normalised value or throws BadRequestException, so the rules are unit-testable in
// `client-input.test.ts` without a database.
//
// ── CONTACT IS A KEY-LEVEL MERGE, NOT A REPLACE ─────────────────────────────────────────────────────
// Before CC-D10, `PATCH /clients/:id` replaced the whole `contact` jsonb. A caller changing one key
// (the UI's email field) had to read, merge and send the whole object back, and any caller that forgot
// silently erased every other key. PATCH now MERGES: a string sets that key, `null` or "" deletes it,
// an omitted key is untouched. `normalizeContactPatch` returns the two halves the SQL needs.
import { BadRequestException } from "@nestjs/common";

/** The contact keys the staff UI edits. Other keys an importer or the API wrote are preserved on read
 *  and on merge — this list is what the UI knows how to label, not an allow-list for storage. */
export const CONTACT_KEYS = ["email", "phone", "address", "billingName", "billingEmail"] as const;
const EMAIL_KEYS = new Set(["email", "billingEmail"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const STATUS_RE = /^[a-z][a-z_]{0,39}$/;

export const NAME_MAX = 200;
export const CONTACT_VALUE_MAX = 1000;
export const CONTACT_KEYS_MAX = 30;
export const NOTE_MAX = 5000;

export function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") throw new BadRequestException("name must be a string");
  const name = raw.trim();
  if (!name) throw new BadRequestException("name must not be blank");
  if (name.length > NAME_MAX) throw new BadRequestException(`name must be at most ${NAME_MAX} characters`);
  return name;
}

/** Status stays free text in the DB (0001 has no CHECK, and existing rows may hold any value), but a
 *  WRITE must be a plain lowercase token so a typo like "Active " cannot mint a new facet in the list. */
export function normalizeStatus(raw: unknown): string {
  if (typeof raw !== "string" || !STATUS_RE.test(raw.trim())) {
    throw new BadRequestException("status must be a lowercase word such as active, prospect or archived");
  }
  return raw.trim();
}

/** `undefined` = leave unchanged; `null` = clear the owner; a string = that user id (the caller still
 *  has to prove it is active staff of THIS tenant — shape only here). */
export function normalizeOwner(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^[0-9a-f-]{36}$/i.test(raw)) throw new BadRequestException("ownerUserId must be a user id or null");
  return raw;
}

/** For CREATE: a full contact object, every value a non-empty string (blank values are dropped). */
export function normalizeContactCreate(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  const { set } = normalizeContactPatch(raw);
  return set;
}

/** For PATCH: `set` merges in, `remove` lists keys to delete. */
export function normalizeContactPatch(raw: unknown): { set: Record<string, string>; remove: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BadRequestException("contact must be an object");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > CONTACT_KEYS_MAX) throw new BadRequestException(`contact may hold at most ${CONTACT_KEYS_MAX} keys`);
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) throw new BadRequestException(`contact key "${key}" is not a valid name`);
    if (value === null || value === "") { remove.push(key); continue; }
    if (typeof value !== "string") throw new BadRequestException(`contact.${key} must be a string or null`);
    const v = value.trim();
    if (!v) { remove.push(key); continue; }
    if (v.length > CONTACT_VALUE_MAX) throw new BadRequestException(`contact.${key} must be at most ${CONTACT_VALUE_MAX} characters`);
    if (EMAIL_KEYS.has(key) && !EMAIL_RE.test(v)) throw new BadRequestException(`contact.${key} is not a valid email address`);
    set[key] = v;
  }
  return { set, remove };
}

export function normalizeNoteBody(raw: unknown): string {
  if (typeof raw !== "string") throw new BadRequestException("body must be a string");
  const body = raw.trim();
  if (!body) throw new BadRequestException("body must not be blank");
  if (body.length > NOTE_MAX) throw new BadRequestException(`body must be at most ${NOTE_MAX} characters`);
  return body;
}

/** The before/after list an update's activity row carries, so the client's History tab can say WHAT
 *  changed, not just "updated". Values are truncated to 200 characters, as the Client Centre does. */
export function diffForActivity(
  before: { name: string; status: string | null; owner_user_id: string | null; contact: Record<string, unknown> | null },
  after: { name: string; status: string | null; owner_user_id: string | null; contact: Record<string, unknown> | null },
): { field: string; before: string | null; after: string | null }[] {
  const t = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 200));
  const out: { field: string; before: string | null; after: string | null }[] = [];
  for (const f of ["name", "status", "owner_user_id"] as const) {
    if (t(before[f]) !== t(after[f])) out.push({ field: f === "owner_user_id" ? "owner" : f, before: t(before[f]), after: t(after[f]) });
  }
  const bc = before.contact ?? {};
  const ac = after.contact ?? {};
  for (const k of new Set([...Object.keys(bc), ...Object.keys(ac)])) {
    if (t(bc[k]) !== t(ac[k])) out.push({ field: `contact.${k}`, before: t(bc[k]), after: t(ac[k]) });
  }
  return out;
}
