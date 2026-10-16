// DW-10a-2 (BFF §57): the department notice board, client-safe half. Types of the wire shapes (§57.4, §57.5), the words, and the pure
// rules the pages, the Overview blocks, the form and the Inbox share. No server import and no I/O, so the `"use client"` form can use
// it and every rule here is a plain unit test. The readers are `notices-data.ts`, the writes `noticeActions.ts`.
//
// Nothing here decides who may do what. `mayPostNotice` mirrors Cerbos (`notices.post`) so a person is not OFFERED a form the server
// will refuse; the server stays the authority on every write (PERMISSION-CONTRACT §47) and its refusals are shown as the form's error.
import { can, canInUnit, type Capability } from "./rbac";
import type { Me } from "./platform";

export type NoticeScope = "unit" | "company";
export type NoticeState = "current" | "past";

/** §57.5. `unitName` is read from the org tree at read time: `null` is a unit that has left the tree ("a former unit"). */
export interface NoticeRow {
  id: string;
  scope: NoticeScope;
  unitNodeId: string | null;
  unitName: string | null;
  title: string;
  /** Plain text. Line breaks are kept; it is never rendered as HTML or Markdown. */
  body: string;
  pinned: boolean;
  /** `YYYY-MM-DD`, the last day the notice is current. */
  endsOn: string | null;
  state: NoticeState;
  author: { id: string; name: string };
  createdAt: string;
  editedAt: string | null;
  /** The caller's `edit` right on this row. The UI offers Edit and Withdraw only when it is true; the server decides again. */
  canEdit: boolean;
}

/** §57.4: `GET /notices` answers `{items, nextCursor}`, `nextCursor` null at the end. */
export interface NoticeList {
  items: NoticeRow[];
  nextCursor: string | null;
}

/** What the list readers are asked: a unit's notices (with the ones above it and the company's), or the company-wide ones. */
export type NoticeQuery = { unitNodeId: string; scope?: undefined } | { scope: "company"; unitNodeId?: undefined };

/** The form's fields, as typed. `endsOn` is "" for none. */
export interface NoticeFormInput {
  title: string;
  body: string;
  pinned: boolean;
  endsOn: string;
}

export const emptyNoticeForm: NoticeFormInput = { title: "", body: "", pinned: false, endsOn: "" };

export type NoticeActionResult = { ok: boolean; error?: string; field?: string; id?: string };

export const TITLE_MAX = 120;
export const BODY_MAX = 4000;
/** At most this many current pins per unit and for the company scope (§57.1). */
export const PIN_MAX = 3;
/** The Overview blocks show this many notices, and this many characters of each body (§57.8). */
export const BLOCK_NOTICES_MAX = 3;
export const EXCERPT_MAX = 140;

export const WHOLE_COMPANY = "Whole company";
export const FORMER_UNIT = "a former unit";
/** The page's address for a unit's notices, and for the company-wide ones. */
export const NOTICES_COMPANY_HREF = "/notices";
export const noticesUnitHref = (unitNodeId: string): string => `/departments/${encodeURIComponent(unitNodeId)}/notices`;
export const noticesPastHref = (base: string): string => `${base}?state=past`;

/** The address the backend's `notice.posted` notification carries (`dept-notices.service.ts::noticeHref`). */
export function noticeHref(scope: NoticeScope, unitNodeId: string | null, id: string): string {
  return scope === "company" || unitNodeId === null ? `/notices#${id}` : `${noticesUnitHref(unitNodeId)}#${id}`;
}

/** The query string's `state`: anything but `past` reads as `current` (a hand-typed value never reaches the backend as a 400). */
export function parseNoticeState(raw: string | readonly string[] | null | undefined): NoticeState {
  const v = typeof raw === "string" || raw == null ? raw : raw[0];
  return v === "past" ? "past" : "current";
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

/** Where a notice was posted: "Whole company", the unit's own name, or "From <unit>" when it was posted to a unit above the one
 *  being looked at (`here`, the unit whose page or Overview this is). A unit that has left the tree reads "A former unit" / "From a
 *  former unit"; the notice is still shown, never dropped. */
export function noticeUnitLabel(row: Pick<NoticeRow, "scope" | "unitNodeId" | "unitName">, here?: string | null): string {
  if (row.scope === "company" || row.unitNodeId === null) return WHOLE_COMPANY;
  const name = row.unitName ?? FORMER_UNIT;
  if (here && row.unitNodeId !== here) return `From ${name}`;
  return row.unitName ?? "A former unit";
}

/** The Inbox's line for a `notice.posted` notification: "<unit or Whole company>: <title>" (§57.6). The payload is the backend's
 *  `{noticeId, title, scope, unitNodeId, unitName}`; a field that is missing or the wrong type falls back to the notification's own
 *  title, so a malformed row still reads as something. Null when this is not a notice notification. */
export function noticePostedLine(type: string, payload: Record<string, unknown> | null | undefined): string | null {
  if (type !== "notice.posted") return null;
  const title = typeof payload?.title === "string" ? payload.title.trim() : "";
  if (!title) return null;
  const where = payload?.scope === "company" ? WHOLE_COMPANY : typeof payload?.unitName === "string" && payload.unitName.trim() ? payload.unitName.trim() : FORMER_UNIT;
  return `${where}: ${title}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-10-14` becomes "14 Oct 2026". Pure string work (no `Intl`), so the server and the client always agree. "" for anything else. */
export function formatNoticeDay(day: string | null | undefined): string {
  const m = typeof day === "string" ? ISO_DAY.exec(day) : null;
  if (!m) return "";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "";
  return `${Number(m[3])} ${MONTHS[month - 1]} ${m[1]}`;
}

/** "Just now", "5 min ago", "3 h ago", "2 d ago", then the date. "" for a time it cannot read. `now` is a parameter so a test can pin it. */
export function noticeAge(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatNoticeDay(new Date(t).toISOString().slice(0, 10));
}

/** The first `max` characters of a body, whitespace collapsed to single spaces, with an ellipsis when it was cut. Plain text in, plain text out. */
export function noticeExcerpt(body: string, max: number = EXCERPT_MAX): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("").trimEnd()}…`;
}

/** Pinned first, then the backend's own order (newest first). Stable: the server already answers in this order, so this only keeps a
 *  block honest if it ever did not. */
export function pinnedFirst<T extends { pinned: boolean }>(rows: readonly T[]): T[] {
  return [...rows.map((r, i) => ({ r, i }))].sort((a, b) => Number(b.r.pinned) - Number(a.r.pinned) || a.i - b.i).map((x) => x.r);
}

// ── Who is OFFERED the form (a mirror, never the authority) ───────────────────────────────────────

/** May the UI offer "Post a notice"? A unit's page passes the unit and its ancestors (`unitPath`, nearest first; a head's grant is
 *  unit-scoped, so `canInUnit`); the company-wide page passes `null`, and only a company-wide holder of `notices.post` (the company
 *  admin tier) is offered it, because a head posting company-wide is a 403. The server decides again. */
export function mayPostNotice(me: Me, tenantId: string | null | undefined, unitPath: readonly string[] | null): boolean {
  const cap: Capability = "notices.post";
  if (unitPath === null) return can(me, cap, tenantId);
  return canInUnit(me, cap, tenantId, unitPath);
}

// ── The form (checked before any request; the server checks again) ────────────────────────────────

const isRealDay = (s: string): boolean => {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

export type NoticeFormCheck =
  | { ok: true; title: string; body: string; pinned: boolean; endsOn: string | null }
  | { ok: false; error: string; field: "title" | "body" | "endsOn" };

/** Trims the title and the body, and checks the lengths and the date's shape. Whether the date is before today is the server's call
 *  (its day is the company's report day, which the browser does not know). Line breaks in the body are kept as typed. */
export function checkNoticeForm(input: NoticeFormInput): NoticeFormCheck {
  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: "Give the notice a title.", field: "title" };
  if ([...title].length > TITLE_MAX) return { ok: false, error: `The title can be at most ${TITLE_MAX} characters.`, field: "title" };
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) return { ok: false, error: "Write the notice.", field: "body" };
  if ([...body].length > BODY_MAX) return { ok: false, error: `The notice can be at most ${BODY_MAX} characters.`, field: "body" };
  const endsOn = input.endsOn.trim();
  if (endsOn !== "" && !isRealDay(endsOn)) return { ok: false, error: "The end date must be a date.", field: "endsOn" };
  return { ok: true, title, body, pinned: input.pinned === true, endsOn: endsOn === "" ? null : endsOn };
}

/** The server's refusal, in words for the form. `field` is the backend's (400s), `code` its machine code (`error` / `reason`). */
export function noticeErrorText(e: { status: number; message: string; field?: string; reason?: string }, scope: NoticeScope = "unit"): string {
  const code = e.reason ?? e.message;
  if (e.status === 409 && (code === "pin_limit" || e.message === "pin_limit" || e.field === "pinned")) {
    return `${scope === "company" ? "The company" : "This unit"} already has ${PIN_MAX} pinned notices. Unpin one, or let one end, to pin another.`;
  }
  if (e.status === 403) {
    return scope === "company"
      ? "Only a company admin can post, change or withdraw a company-wide notice."
      : "You can't post, change or withdraw notices for this unit. Its head and company admins can.";
  }
  if (e.status === 404) {
    if (code === "unit_not_found" || e.field === "unitNodeId") return "That unit is not in this company's structure.";
    return "This notice no longer exists, or it was withdrawn.";
  }
  if (e.status === 400) return e.message || "The notice could not be saved. Check the fields.";
  return e.message || "The notice could not be saved just now. Try again.";
}
