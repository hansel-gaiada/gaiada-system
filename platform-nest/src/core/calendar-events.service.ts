// DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47) — calendar events and meeting scheduling: the body validators, the time-change,
// attendee-diff and response-reset rules, the notification wording and the SQL of every read and write, kept out of the
// controller so the rules are unit-testable and the controller stays a thin authorize-then-delegate layer.
//
// Two halves in one file, on purpose (the DW-5a / DW-5c layout):
//   1. PURE rules — body and query parsing, the time shapes and the 14-day span, the attendee diff, the response reset after a
//      time change, the time in words. No DB, no Nest: `calendar-events.service.test.ts` drives them directly.
//   2. SQL helpers that take the caller's `PoolClient`, so every write runs inside the controller's one `withTenants`
//      transaction (the outbox event rides in that same transaction).
//
// An event is one row on a company's calendar with attendees. A MEETING is an event that links the `scheduled` recording it
// created (`meeting_recording_id`); the recording keeps its own access rule (`resource_meeting_recording.yaml`), an event's
// privacy never narrows it (§47.2).
import type { PoolClient } from "pg";
import { scrubText } from "./scrub";
import { isUuidShaped } from "./dept-resolution";

// ───────────────────────────────────────────── vocabulary ─────────────────────────────────────────────

/** `department` (DW-10c, BFF §59.3) is an event for one org-tree unit's people: it names a `unitNodeId`, and the people placed in that
 *  unit or below it today, the heads over it and the company-wide tiers read it, besides the organizer and the attendees. */
export const VISIBILITIES = ["attendees", "company", "department"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const EVENT_STATUSES = ["confirmed", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const RESPONSES = ["needs_action", "accepted", "declined", "tentative"] as const;
export type AttendeeResponse = (typeof RESPONSES)[number];
/** What an attendee may answer (`needs_action` is the state before any answer, never an answer). */
export const ANSWERS = ["accepted", "declined", "tentative"] as const;
export type Answer = (typeof ANSWERS)[number];

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5_000;
export const LOCATION_MAX = 300;
export const VIDEO_URL_MAX = 2_048;
export const ATTENDEES_MAX = 50;
/** A timed event spans at most 14 days (a CHECK on the table too). */
export const TIMED_SPAN_MAX_MS = 14 * 24 * 60 * 60 * 1000;
/** The `mine` window is at most 92 days. */
export const MINE_WINDOW_MAX_MS = 92 * 24 * 60 * 60 * 1000;
export const MINE_LIMIT = 500;

/** A refusal the controller maps to an HTTP exception. Pure data: no Nest import, so unit tests need no app. */
export class CalendarRuleError extends Error {
  constructor(
    readonly httpStatus: 400 | 404 | 409 | 422,
    /** The machine code the contract names (`event_cancelled`, `attendee_not_member`, ...). */
    readonly reason: string,
    message: string,
    readonly field?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CalendarRuleError";
  }
}
const bad = (reason: string, message: string, field?: string) => new CalendarRuleError(400, reason, message, field);

// ───────────────────────────────────────── pure input parsing ─────────────────────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Plain text: a NUL cannot live in a Postgres text column (it would be a 500), and nothing here is ever interpreted as
 *  markup. PAN, national ids and e-mail addresses are scrubbed exactly as other free text is (`scrubText`). */
export function plain(s: string): string {
  return scrubText(s.replace(/\u0000/g, "")).text;
}
const stripNul = (s: string): string => s.replace(/\u0000/g, "");

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO 8601 instant WITH an offset (`Z` or `+08:00`): a bare local time would be read in the server's zone. */
export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) {
    throw bad("time_invalid", `${field} must be an ISO 8601 date-time with a UTC offset, like 2026-10-20T09:00:00+08:00`, field);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad("time_invalid", `${field} is not a real date-time`, field);
  return d;
}

/** 'YYYY-MM-DD' that is a real calendar date. */
export function parseDay(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DAY_RE.test(value)) throw bad("date_invalid", `${field} must be a YYYY-MM-DD date`, field);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw bad("date_invalid", `${field} is not a real calendar date`, field);
  }
  return value;
}

export type TimeSpec =
  | { allDay: false; startsAt: Date; endsAt: Date }
  | { allDay: true; startsOn: string; endsOn: string };

const TIME_KEYS = ["allDay", "startsAt", "endsAt", "startsOn", "endsOn"] as const;

/** Exactly one of the two time shapes, or `null` when the body carries none of the five time keys (a PATCH that leaves the
 *  time alone). A timed event needs `startsAt` and `endsAt` (an instant with an offset, `endsAt` after `startsAt`, at most 14
 *  days apart); an all-day event needs `allDay: true` and `startsOn` and `endsOn` (inclusive, `endsOn` not before `startsOn`).
 *  Mixing the two is a 400, never a silent pick. */
export function parseTimeSpec(body: Record<string, unknown>): TimeSpec | null {
  if (!TIME_KEYS.some((k) => body[k] !== undefined)) return null;
  if (body.allDay !== undefined && typeof body.allDay !== "boolean") throw bad("time_shape_invalid", "allDay must be true or false", "allDay");
  if (body.allDay === true) {
    if (body.startsAt !== undefined || body.endsAt !== undefined) {
      throw bad("time_shape_invalid", "an all-day event takes startsOn and endsOn, not startsAt and endsAt", "startsAt");
    }
    if (body.startsOn === undefined || body.endsOn === undefined) {
      throw bad("time_shape_invalid", "an all-day event needs both startsOn and endsOn", "startsOn");
    }
    const startsOn = parseDay(body.startsOn, "startsOn");
    const endsOn = parseDay(body.endsOn, "endsOn");
    if (endsOn < startsOn) throw bad("time_range_invalid", "endsOn must not be before startsOn", "endsOn");
    return { allDay: true, startsOn, endsOn };
  }
  if (body.startsOn !== undefined || body.endsOn !== undefined) {
    throw bad("time_shape_invalid", "startsOn and endsOn are for an all-day event: send allDay: true", "startsOn");
  }
  if (body.startsAt === undefined || body.endsAt === undefined) {
    throw bad("time_shape_invalid", "a timed event needs both startsAt and endsAt", "startsAt");
  }
  const startsAt = parseInstant(body.startsAt, "startsAt");
  const endsAt = parseInstant(body.endsAt, "endsAt");
  if (endsAt.getTime() <= startsAt.getTime()) throw bad("time_range_invalid", "endsAt must be after startsAt", "endsAt");
  if (endsAt.getTime() - startsAt.getTime() > TIMED_SPAN_MAX_MS) {
    throw bad("time_span_too_long", "a timed event lasts at most 14 days", "endsAt");
  }
  return { allDay: false, startsAt, endsAt };
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw bad("title_invalid", "title is required", "title");
  const t = plain(value).trim();
  if (!t || t.length > TITLE_MAX) throw bad("title_invalid", `title must be 1 to ${TITLE_MAX} characters`, "title");
  return t;
}

function parseDescription(value: unknown): string {
  if (typeof value !== "string") throw bad("description_invalid", "description must be text", "description");
  const t = plain(value).trim();
  if (t.length > DESCRIPTION_MAX) throw bad("description_invalid", `description is at most ${DESCRIPTION_MAX} characters`, "description");
  return t;
}

/** A place, or `null` to clear. Blank is "no place". */
function parseLocation(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw bad("location_invalid", "location must be text, or null", "location");
  const t = plain(value).trim();
  if (t.length > LOCATION_MAX) throw bad("location_invalid", `location is at most ${LOCATION_MAX} characters`, "location");
  return t || null;
}

/** An `https:` link of at most 2,048 characters, or `null` to clear. Blank is "no link". */
function parseVideoUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw bad("video_url_invalid", "videoUrl must be an https link, or null", "videoUrl");
  const v = stripNul(value).trim();
  if (!v) return null;
  if (v.length > VIDEO_URL_MAX) throw bad("video_url_invalid", `videoUrl is at most ${VIDEO_URL_MAX} characters`, "videoUrl");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw bad("video_url_invalid", "videoUrl must be an https link", "videoUrl");
  }
  if (u.protocol !== "https:") throw bad("video_url_invalid", "videoUrl must be an https link", "videoUrl");
  return v;
}

function parseVisibility(value: unknown): Visibility {
  if (typeof value !== "string" || !(VISIBILITIES as readonly string[]).includes(value)) {
    throw bad("visibility_invalid", `visibility must be one of ${VISIBILITIES.join("|")}`, "visibility");
  }
  return value as Visibility;
}

export const UNIT_NODE_ID_MAX = 200;

/** An org-tree node id as the body names it: 1 to 200 characters, no control characters (the node ids are free text, short slugs or
 *  uuids). Shape only; whether the unit exists in this company's tree, and whether the caller reaches it, are the controller's. */
export function isUnitNodeIdShaped(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= UNIT_NODE_ID_MAX && ![...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
}

function parseUnitNodeId(value: unknown): string | null {
  if (value === null) return null;
  if (!isUnitNodeIdShaped(value)) throw bad("unit_invalid", `unitNodeId must be an org unit id of 1 to ${UNIT_NODE_ID_MAX} characters, or null`, "unitNodeId");
  return value;
}

/** What authorization needs from a create or PATCH body BEFORE any other field is looked at (the DW-5a / DW-10a order: a refused caller
 *  always gets 403, never a 400): only `visibility` and `unitNodeId`, and only to say which unit a `department` event names. A body that
 *  is not an object, a visibility that is not `department`, or a unit that is not even shaped like one names no unit here: the parse
 *  that follows refuses it with its own 400. `visibilityGiven` is whether the body named a visibility at all (a PATCH may leave it). */
export function departmentFactsOf(body: unknown): { visibilityGiven: boolean; department: boolean; unitNodeId: string | null; unitGiven: boolean } {
  if (!isPlainObject(body)) return { visibilityGiven: false, department: false, unitNodeId: null, unitGiven: false };
  return {
    visibilityGiven: body.visibility !== undefined,
    department: body.visibility === "department",
    unitNodeId: isUnitNodeIdShaped(body.unitNodeId) ? body.unitNodeId : null,
    unitGiven: body.unitNodeId !== undefined,
  };
}

function parseOptionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isUuidShaped(value)) throw bad("id_invalid", `${field} must be an id, or null`, field);
  return value.toLowerCase();
}

/** A list of at most 50 distinct people (ids, lower-cased, input order kept). The caller's own id and unknown people are the
 *  SQL half's business; this is shape and size only. */
export function parseAttendeeIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw bad("attendees_invalid", "attendeeIds must be a list of user ids", "attendeeIds");
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !isUuidShaped(v)) throw bad("attendees_invalid", "attendeeIds must be a list of user ids", "attendeeIds");
    seen.add(v.toLowerCase());
  }
  if (seen.size > ATTENDEES_MAX) {
    throw bad("attendees_too_many", `an event has at most ${ATTENDEES_MAX} attendees`, "attendeeIds");
  }
  return [...seen];
}

export interface CreateInput {
  title: string;
  time: TimeSpec;
  description: string;
  location: string | null;
  videoUrl: string | null;
  attendeeIds: string[];
  visibility: Visibility;
  /** The org unit of a `department` event; `null` for every other visibility. */
  unitNodeId: string | null;
  clientId: string | null;
  projectId: string | null;
  record: boolean;
}

/** §47.3 `POST /calendar/events`. `record: true` needs a timed event (the recording's `scheduledAt` is the start). */
export function parseCreate(body: unknown): CreateInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON body is required");
  const title = parseTitle(body.title);
  const time = parseTimeSpec(body);
  if (!time) throw bad("time_shape_invalid", "a timed event needs startsAt and endsAt; an all-day event needs allDay: true, startsOn and endsOn", "startsAt");
  if (body.record !== undefined && typeof body.record !== "boolean") throw bad("record_invalid", "record must be true or false", "record");
  const record = body.record === true;
  if (record && time.allDay) {
    throw bad("record_needs_timed_event", "an all-day event cannot be recorded: the recording is scheduled for a start time", "record");
  }
  const visibility = body.visibility === undefined ? "attendees" : parseVisibility(body.visibility);
  const unitNodeId = body.unitNodeId === undefined ? null : parseUnitNodeId(body.unitNodeId);
  if (visibility === "department" && unitNodeId === null) {
    throw bad("unit_required", "a department event needs unitNodeId: the org unit it belongs to", "unitNodeId");
  }
  if (visibility !== "department" && unitNodeId !== null) {
    throw bad("unit_not_allowed", "unitNodeId is only for an event whose visibility is department", "unitNodeId");
  }
  return {
    title,
    time,
    description: body.description === undefined ? "" : parseDescription(body.description),
    location: body.location === undefined ? null : parseLocation(body.location),
    videoUrl: body.videoUrl === undefined ? null : parseVideoUrl(body.videoUrl),
    attendeeIds: body.attendeeIds === undefined ? [] : parseAttendeeIds(body.attendeeIds),
    visibility,
    unitNodeId,
    clientId: parseOptionalUuid(body.clientId, "clientId"),
    projectId: parseOptionalUuid(body.projectId, "projectId"),
    record,
  };
}

export interface PatchInput {
  title?: string;
  description?: string;
  time?: TimeSpec;
  location?: string | null;
  videoUrl?: string | null;
  visibility?: Visibility;
  /** `undefined` leaves the unit alone; `null` clears it (only valid when the event ends up not `department`). */
  unitNodeId?: string | null;
  attendeeIds?: string[];
  clientId?: string | null;
  projectId?: string | null;
}

/** §47.3 `PATCH`: any field above except `record` (a recording is chosen when the event is made). A time change is a whole
 *  time spec (both ends), never half of one. An empty patch is a 400. */
export function parsePatch(body: unknown): PatchInput {
  if (!isPlainObject(body)) throw bad("body_invalid", "a JSON body is required");
  if (body.record !== undefined) throw bad("record_not_editable", "record is chosen when the event is made and cannot be changed", "record");
  const out: PatchInput = {};
  if (body.title !== undefined) out.title = parseTitle(body.title);
  if (body.description !== undefined) out.description = parseDescription(body.description);
  const time = parseTimeSpec(body);
  if (time) out.time = time;
  if (body.location !== undefined) out.location = parseLocation(body.location);
  if (body.videoUrl !== undefined) out.videoUrl = parseVideoUrl(body.videoUrl);
  if (body.visibility !== undefined) out.visibility = parseVisibility(body.visibility);
  if (body.unitNodeId !== undefined) out.unitNodeId = parseUnitNodeId(body.unitNodeId);
  if (body.attendeeIds !== undefined) out.attendeeIds = parseAttendeeIds(body.attendeeIds);
  if (body.clientId !== undefined) out.clientId = parseOptionalUuid(body.clientId, "clientId");
  if (body.projectId !== undefined) out.projectId = parseOptionalUuid(body.projectId, "projectId");
  if (Object.keys(out).length === 0) throw bad("nothing_to_change", "the body names no field to change");
  return out;
}

/** §47.3 `POST …/respond`: `{response: accepted | declined | tentative}`. */
export function parseRespond(body: unknown): { response: Answer } {
  if (!isPlainObject(body) || typeof body.response !== "string" || !(ANSWERS as readonly string[]).includes(body.response)) {
    throw bad("response_invalid", `response must be one of ${ANSWERS.join("|")}`, "response");
  }
  return { response: body.response as Answer };
}

export interface MineWindow {
  from: Date;
  to: Date;
  /** `all`, or one company id. */
  scope: "all" | string;
}

/** §47.3 `GET /calendar/events/mine?from=&to=&scope=`: the window `[from, to)` is required and at most 92 days. A date alone
 *  (`2026-10-01`) is that day's UTC midnight. */
export function parseMineQuery(q: Record<string, unknown>): MineWindow {
  const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const fromRaw = one(q.from);
  const toRaw = one(q.to);
  if (!fromRaw || !toRaw) throw bad("window_required", "from and to are required", "from");
  const asInstant = (raw: string, field: string): Date => (ISO_DAY_RE.test(raw) ? new Date(`${parseDay(raw, field)}T00:00:00.000Z`) : parseInstant(raw, field));
  const from = asInstant(fromRaw, "from");
  const to = asInstant(toRaw, "to");
  if (to.getTime() <= from.getTime()) throw bad("window_invalid", "to must be after from", "to");
  if (to.getTime() - from.getTime() > MINE_WINDOW_MAX_MS) throw bad("window_too_large", "the window is at most 92 days", "to");
  const scopeRaw = one(q.scope) ?? "all";
  if (scopeRaw !== "all" && !isUuidShaped(scopeRaw)) throw bad("scope_invalid", "scope must be all or a company id", "scope");
  return { from, to, scope: scopeRaw === "all" ? "all" : scopeRaw.toLowerCase() };
}

// ───────────────────────────────────────── pure rules ─────────────────────────────────────────

export interface AttendeeDiff {
  /** In `next`, not in `current`: they are invited. */
  added: string[];
  /** In `current`, not in `next`: they are told it is off for them. */
  removed: string[];
  /** In both. */
  kept: string[];
}

/** The attendee diff for a PATCH. The ORGANIZER is always an attendee: absent from `next`, they are added back (and never
 *  removed), so an edit that forgot them cannot orphan the event. */
export function diffAttendees(current: readonly string[], next: readonly string[], organizerId: string): AttendeeDiff {
  const want = new Set(next);
  want.add(organizerId);
  const have = new Set(current);
  return {
    added: [...want].filter((u) => !have.has(u)),
    removed: [...have].filter((u) => !want.has(u)),
    kept: [...have].filter((u) => want.has(u)),
  };
}

/** The stored time of an event, in the shape of a `TimeSpec`. */
export function timeOfFacts(f: Pick<EventFacts, "startsAt" | "endsAt" | "startsOn" | "endsOn">): TimeSpec {
  if (f.startsAt && f.endsAt) return { allDay: false, startsAt: f.startsAt, endsAt: f.endsAt };
  return { allDay: true, startsOn: f.startsOn as string, endsOn: f.endsOn as string };
}

/** Whether `after` is a different time from `before`: another shape, another instant or another day. */
export function timeChanged(before: TimeSpec, after: TimeSpec): boolean {
  if (before.allDay !== after.allDay) return true;
  if (!before.allDay && !after.allDay) {
    return before.startsAt.getTime() !== after.startsAt.getTime() || before.endsAt.getTime() !== after.endsAt.getTime();
  }
  if (before.allDay && after.allDay) return before.startsOn !== after.startsOn || before.endsOn !== after.endsOn;
  return true;
}

/** The answer a person holds after the event's time changed (§47.3): everyone goes back to `needs_action`, EXCEPT the
 *  organizer, who is always `accepted`. */
export function responseAfterTimeChange(userId: string, organizerId: string): AttendeeResponse {
  return userId === organizerId ? "accepted" : "needs_action";
}

export interface PatchPlan {
  title: string;
  description: string;
  time: TimeSpec;
  location: string | null;
  videoUrl: string | null;
  visibility: Visibility;
  unitNodeId: string | null;
  clientId: string | null;
  projectId: string | null;
  attendees: AttendeeDiff;
  timeChanged: boolean;
  /** Field names that changed (never their values: the activity row carries ids and names, not the description). */
  changed: string[];
}

/** The event after a PATCH, and what moved. A linked recording needs a start time, so a recorded event cannot become all-day
 *  (409 `recording_needs_timed_event`). */
export function planPatch(facts: EventFacts, patch: PatchInput): PatchPlan {
  const before = timeOfFacts(facts);
  const time = patch.time ?? before;
  const moved = timeChanged(before, time);
  if (moved && time.allDay && facts.meetingRecordingId) {
    throw new CalendarRuleError(409, "recording_needs_timed_event", "this event has a scheduled recording, so it must keep a start time");
  }
  const title = patch.title ?? facts.title;
  const description = patch.description ?? facts.description;
  const location = patch.location !== undefined ? patch.location : facts.location;
  const videoUrl = patch.videoUrl !== undefined ? patch.videoUrl : facts.videoUrl;
  const visibility = patch.visibility ?? facts.visibility;
  // The unit follows the visibility: a `department` event keeps (or is given) a unit, any other visibility has none. Moving an event
  // off `department` clears the unit; naming a unit for a non-department event, or making an event `department` without one, is a 400.
  const unitNodeId = visibility === "department" ? (patch.unitNodeId !== undefined ? patch.unitNodeId : facts.unitNodeId) : null;
  if (visibility === "department" && unitNodeId === null) {
    throw bad("unit_required", "a department event needs unitNodeId: the org unit it belongs to", "unitNodeId");
  }
  if (visibility !== "department" && patch.unitNodeId !== undefined && patch.unitNodeId !== null) {
    throw bad("unit_not_allowed", "unitNodeId is only for an event whose visibility is department", "unitNodeId");
  }
  const clientId = patch.clientId !== undefined ? patch.clientId : facts.clientId;
  const projectId = patch.projectId !== undefined ? patch.projectId : facts.projectId;
  const attendees = diffAttendees(facts.attendees.map((a) => a.userId), patch.attendeeIds ?? facts.attendees.map((a) => a.userId), facts.organizerId);
  const changed: string[] = [];
  if (title !== facts.title) changed.push("title");
  if (description !== facts.description) changed.push("description");
  if (moved) changed.push("time");
  if (location !== facts.location) changed.push("location");
  if (videoUrl !== facts.videoUrl) changed.push("videoUrl");
  if (visibility !== facts.visibility) changed.push("visibility");
  if (unitNodeId !== facts.unitNodeId) changed.push("unitNodeId");
  if (clientId !== facts.clientId) changed.push("clientId");
  if (projectId !== facts.projectId) changed.push("projectId");
  if (attendees.added.length || attendees.removed.length) changed.push("attendees");
  return { title, description, time, location, videoUrl, visibility, unitNodeId, clientId, projectId, attendees, timeChanged: moved, changed };
}

/** The display zone for times in words (the UI's `NEXT_PUBLIC_DISPLAY_TZ`; the server reads the same variable). */
export function displayTimeZone(): string {
  return process.env.DISPLAY_TZ || process.env.NEXT_PUBLIC_DISPLAY_TZ || "Asia/Singapore";
}

/** "Tue 20 Oct, 09:00 to 10:00" / "Tue 20 Oct, all day" / "Tue 20 Oct to Thu 22 Oct, all day", in the display zone. */
export function describeWhen(time: TimeSpec, timeZone: string = displayTimeZone()): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone }).format(d);
  const hm = (d: Date) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);
  const dayOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00.000Z`));
  if (time.allDay) {
    return time.startsOn === time.endsOn ? `${dayOf(time.startsOn)}, all day` : `${dayOf(time.startsOn)} to ${dayOf(time.endsOn)}, all day`;
  }
  const sameDay = day(time.startsAt) === day(time.endsAt);
  return sameDay
    ? `${day(time.startsAt)}, ${hm(time.startsAt)} to ${hm(time.endsAt)}`
    : `${day(time.startsAt)}, ${hm(time.startsAt)} to ${day(time.endsAt)}, ${hm(time.endsAt)}`;
}

export const eventHref = (tenantId: string, id: string): string => `/calendar/events/${id}?company=${tenantId}`;

// ───────────────────────────────────────── SQL: facts and reads ─────────────────────────────────────────

export interface AttendeeFact { userId: string; response: AttendeeResponse }

/** One event as the rows hold it, and the three attributes Cerbos must see (`ownerId`, `attendeeIds`, `visibility`). */
export interface EventFacts {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  startsAt: Date | null;
  endsAt: Date | null;
  startsOn: string | null;
  endsOn: string | null;
  location: string | null;
  videoUrl: string | null;
  organizerId: string;
  visibility: Visibility;
  /** The org unit of a `department` event (`calendar_events.unit_node_id`); `null` otherwise. */
  unitNodeId: string | null;
  status: EventStatus;
  cancelledAt: Date | null;
  clientId: string | null;
  projectId: string | null;
  meetingRecordingId: string | null;
  createdAt: Date;
  updatedAt: Date;
  attendees: AttendeeFact[];
}

interface EventRow {
  id: string; tenant_id: string; title: string; description: string;
  starts_at: Date | null; ends_at: Date | null; starts_on: string | null; ends_on: string | null;
  location: string | null; video_url: string | null; organizer_id: string; visibility: Visibility; unit_node_id: string | null; status: EventStatus;
  cancelled_at: Date | null; client_id: string | null; project_id: string | null; meeting_recording_id: string | null;
  created_at: Date; updated_at: Date;
}

/** The event and its attendees, or `null` when the id is not a live event of this tenant (RLS bounds the tenant). `lock`
 *  re-reads the event row FOR UPDATE inside a write transaction, so the status the rules judge is the committed one. */
export async function loadFacts(c: PoolClient, tenantId: string, id: string, lock = false): Promise<EventFacts | null> {
  if (!isUuidShaped(id)) return null;
  const ev = await c.query<EventRow>(
    `SELECT id, tenant_id, title, description, starts_at, ends_at,
            to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
            location, video_url, organizer_id, visibility, unit_node_id, status, cancelled_at, client_id, project_id, meeting_recording_id,
            created_at, updated_at
       FROM calendar_events WHERE id = $1 AND tenant_id = $2${lock ? " FOR UPDATE" : ""}`,
    [id, tenantId],
  );
  const r = ev.rows[0];
  if (!r) return null;
  const at = await c.query<{ user_id: string; response: AttendeeResponse }>(
    `SELECT user_id, response FROM calendar_event_attendees WHERE event_id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return {
    id: r.id, tenantId: r.tenant_id, title: r.title, description: r.description,
    startsAt: r.starts_at, endsAt: r.ends_at, startsOn: r.starts_on, endsOn: r.ends_on,
    location: r.location, videoUrl: r.video_url, organizerId: r.organizer_id, visibility: r.visibility, unitNodeId: r.unit_node_id, status: r.status,
    cancelledAt: r.cancelled_at, clientId: r.client_id, projectId: r.project_id, meetingRecordingId: r.meeting_recording_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
    attendees: at.rows.map((a) => ({ userId: a.user_id, response: a.response })),
  };
}

/** The first person in `userIds` (input order) who is not an ACTIVE member of the company, else `null` (§47.3: 422
 *  `attendee_not_member`). Active means a live membership row of an active person. */
export async function firstNonMember(c: PoolClient, tenantId: string, userIds: readonly string[]): Promise<string | null> {
  if (!userIds.length) return null;
  const { rows } = await c.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.user_id = ANY($2::uuid[])
        AND m.deleted_at IS NULL AND m.status = 'active' AND u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'employee'`,
    [tenantId, [...userIds]],
  );
  const ok = new Set(rows.map((r) => r.user_id));
  return userIds.find((u) => !ok.has(u)) ?? null;
}

/** A client or project the body names must be a live row of THIS company (RLS hides every other company's rows, and the
 *  plain FK on `client_id` would not). `null` when it is fine, else the field name. */
export async function firstForeignLink(c: PoolClient, clientId: string | null, projectId: string | null): Promise<"clientId" | "projectId" | null> {
  if (clientId) {
    const r = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
    if (!r.rows[0]) return "clientId";
  }
  if (projectId) {
    const r = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
    if (!r.rows[0]) return "projectId";
  }
  return null;
}

export interface EventDetail {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  startsOn: string | null;
  endsOn: string | null;
  location: string | null;
  videoUrl: string | null;
  visibility: Visibility;
  /** The org unit of a `department` event; `null` otherwise. */
  unitNodeId: string | null;
  status: EventStatus;
  cancelledAt: string | null;
  organizer: { id: string; name: string };
  attendees: Array<{ userId: string; name: string; response: AttendeeResponse }>;
  attendeeCount: number;
  myResponse: AttendeeResponse | null;
  recording: { id: string; status: string } | null;
  client: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  href: string;
  canEdit: boolean;
  canCancel: boolean;
  canRespond: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DetailCaps { update: boolean; cancel: boolean; respond: boolean }

/** The §47.3 detail. Names are read live (a person renamed is renamed everywhere). The capabilities come from Cerbos and are
 *  advisory for the UI: every write still runs its own `authorize`. A cancelled event is edited, cancelled or answered by nobody. */
export async function buildDetail(c: PoolClient, facts: EventFacts, viewerId: string | null, caps: DetailCaps): Promise<EventDetail> {
  const names = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id = ANY($1::uuid[])`,
    [[facts.organizerId, ...facts.attendees.map((a) => a.userId)]],
  );
  const nameOf = new Map(names.rows.map((n) => [n.id, n.name]));
  const rec = facts.meetingRecordingId
    ? await c.query<{ id: string; status: string }>(`SELECT id, status FROM meeting_recordings WHERE id = $1`, [facts.meetingRecordingId])
    : null;
  const client = facts.clientId ? await c.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE id = $1`, [facts.clientId]) : null;
  const project = facts.projectId ? await c.query<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = $1`, [facts.projectId]) : null;
  const attendees = facts.attendees
    .map((a) => ({ userId: a.userId, name: nameOf.get(a.userId) ?? "", response: a.response }))
    .sort((x, y) => (x.userId === facts.organizerId ? -1 : y.userId === facts.organizerId ? 1 : x.name.localeCompare(y.name)));
  const live = facts.status === "confirmed";
  return {
    id: facts.id, tenantId: facts.tenantId, title: facts.title, description: facts.description,
    startsAt: facts.startsAt ? facts.startsAt.toISOString() : null,
    endsAt: facts.endsAt ? facts.endsAt.toISOString() : null,
    allDay: facts.startsOn !== null,
    startsOn: facts.startsOn, endsOn: facts.endsOn,
    location: facts.location, videoUrl: facts.videoUrl, visibility: facts.visibility, unitNodeId: facts.unitNodeId, status: facts.status,
    cancelledAt: facts.cancelledAt ? facts.cancelledAt.toISOString() : null,
    organizer: { id: facts.organizerId, name: nameOf.get(facts.organizerId) ?? "" },
    attendees,
    attendeeCount: attendees.length,
    myResponse: viewerId ? facts.attendees.find((a) => a.userId === viewerId)?.response ?? null : null,
    recording: rec?.rows[0] ? { id: rec.rows[0].id, status: rec.rows[0].status } : null,
    client: client?.rows[0] ?? null,
    project: project?.rows[0] ?? null,
    href: eventHref(facts.tenantId, facts.id),
    canEdit: live && caps.update,
    canCancel: live && caps.cancel,
    canRespond: live && caps.respond,
    createdAt: facts.createdAt.toISOString(),
    updatedAt: facts.updatedAt.toISOString(),
  };
}

export interface MineRow {
  id: string;
  tenantId: string;
  company: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  startsOn: string | null;
  endsOn: string | null;
  location: string | null;
  videoUrl: string | null;
  status: EventStatus;
  myResponse: AttendeeResponse | null;
  organizer: { id: string; name: string };
  attendeeCount: number;
  recording: { id: string; status: string } | null;
  client: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  href: string;
}

/** The units of the DEPARTMENT-visible events in the window that the caller reaches (DW-10c, BFF §59.3): the distinct `unit_node_id`s
 *  of the company's `department` events overlapping `[from, to)`, filtered by `reaches` (the caller's placement as of today, their led
 *  scope, or a company-wide tier: `loadUnitReach`). The SQL mirror of the Cerbos department rule's handler narrowing: `listMine` takes
 *  this list as its department branch, so a department event the caller may read is listed and one they may not is not. */
export async function reachableDepartmentUnits(
  c: PoolClient, tenantId: string, w: { from: Date; to: Date }, reaches: (unitNodeId: string) => boolean,
): Promise<string[]> {
  const fromDay = w.from.toISOString().slice(0, 10);
  const toDay = new Date(w.to.getTime() - 1).toISOString().slice(0, 10);
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT DISTINCT e.unit_node_id
       FROM calendar_events e
      WHERE e.tenant_id = $1 AND e.visibility = 'department' AND e.unit_node_id IS NOT NULL
        AND ((e.starts_at IS NOT NULL AND e.starts_at < $3 AND e.ends_at > $2)
          OR (e.starts_on IS NOT NULL AND e.starts_on <= $5::date AND e.ends_on >= $4::date))`,
    [tenantId, w.from.toISOString(), w.to.toISOString(), fromDay, toDay],
  );
  return rows.map((r) => r.unit_node_id).filter((u) => reaches(u));
}

/** The caller's events in one company over `[from, to)`: the ones they organize or are invited to, cancelled and declined
 *  ones included (the calendar strikes them through or dims them), and (DW-10c) the DEPARTMENT-visible ones of `departmentUnits`, the
 *  units the caller reaches (`reachableDepartmentUnits`; empty when they reach none or Cerbos withholds the department read). A timed
 *  event is in the window when it overlaps it; an all-day event when its inclusive date range meets the window's UTC days. */
export async function listMine(
  c: PoolClient, tenantId: string, companyName: string, userId: string, w: { from: Date; to: Date }, departmentUnits: readonly string[] = [],
): Promise<MineRow[]> {
  const fromDay = w.from.toISOString().slice(0, 10);
  const toDay = new Date(w.to.getTime() - 1).toISOString().slice(0, 10);
  const { rows } = await c.query<{
    id: string; title: string; starts_at: Date | null; ends_at: Date | null; starts_on: string | null; ends_on: string | null;
    location: string | null; video_url: string | null; status: EventStatus; organizer_id: string; organizer_name: string;
    my_response: AttendeeResponse | null; attendee_count: number; recording_id: string | null; recording_status: string | null;
    client_id: string | null; client_name: string | null; project_id: string | null; project_name: string | null;
  }>(
    `SELECT e.id, e.title, e.starts_at, e.ends_at,
            to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on,
            e.location, e.video_url, e.status, e.organizer_id, o.name AS organizer_name,
            me.response AS my_response,
            (SELECT count(*) FROM calendar_event_attendees a WHERE a.event_id = e.id)::int AS attendee_count,
            r.id AS recording_id, r.status AS recording_status,
            cl.id AS client_id, cl.name AS client_name, p.id AS project_id, p.name AS project_name
       FROM calendar_events e
       JOIN users o ON o.id = e.organizer_id
       LEFT JOIN calendar_event_attendees me ON me.event_id = e.id AND me.user_id = $2
       LEFT JOIN meeting_recordings r ON r.id = e.meeting_recording_id
       LEFT JOIN clients cl ON cl.id = e.client_id
       LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.tenant_id = $1
        AND (e.organizer_id = $2 OR me.user_id IS NOT NULL
             OR (e.visibility = 'department' AND e.unit_node_id = ANY($7::text[])))
        AND ((e.starts_at IS NOT NULL AND e.starts_at < $4 AND e.ends_at > $3)
          OR (e.starts_on IS NOT NULL AND e.starts_on <= $6::date AND e.ends_on >= $5::date))
      ORDER BY COALESCE(e.starts_at, e.starts_on::timestamp AT TIME ZONE 'UTC'), e.created_at
      LIMIT ${MINE_LIMIT}`,
    [tenantId, userId, w.from.toISOString(), w.to.toISOString(), fromDay, toDay, [...departmentUnits]],
  );
  return rows.map((r) => ({
    id: r.id, tenantId, company: companyName, title: r.title,
    startsAt: r.starts_at ? r.starts_at.toISOString() : null,
    endsAt: r.ends_at ? r.ends_at.toISOString() : null,
    allDay: r.starts_on !== null,
    startsOn: r.starts_on, endsOn: r.ends_on, location: r.location, videoUrl: r.video_url, status: r.status,
    myResponse: r.my_response,
    organizer: { id: r.organizer_id, name: r.organizer_name },
    attendeeCount: r.attendee_count,
    recording: r.recording_id ? { id: r.recording_id, status: r.recording_status as string } : null,
    client: r.client_id ? { id: r.client_id, name: r.client_name as string } : null,
    project: r.project_id ? { id: r.project_id, name: r.project_name as string } : null,
    href: eventHref(tenantId, r.id),
  }));
}

/** The sort key of a row across companies: the start instant, or the start day's UTC midnight. */
export function mineSortKey(r: Pick<MineRow, "startsAt" | "startsOn">): number {
  if (r.startsAt) return new Date(r.startsAt).getTime();
  return r.startsOn ? new Date(`${r.startsOn}T00:00:00.000Z`).getTime() : 0;
}

// ───────────────────────────────────────── busy times (§47.4, DW-D28) ─────────────────────────────────────────

/** `GET /calendar/busy`: at most 20 people and a window of at most 14 days (the same span a timed event may have). */
export const BUSY_USERS_MAX = 20;
export const BUSY_WINDOW_MAX_MS = TIMED_SPAN_MAX_MS;
/** A hard row cap on the busy read (20 people over 14 days never gets near it). */
const BUSY_ROW_LIMIT = 5_000;

export interface BusyQuery { userIds: string[]; from: Date; to: Date; excludeEventId: string | null }
export interface BusyInterval { startsAt: string; endsAt: string }
export interface BusyAnswer { busy: Array<{ userId: string; intervals: BusyInterval[] }> }

/** `userIds` is a comma list (a repeated `userIds=` param is read the same way). 1 to 20 DISTINCT uuids, else 400; `from` and
 *  `to` are instants WITH an offset, `from` before `to`, at most 14 days apart; `excludeEventId` is an optional uuid. Run only
 *  AFTER the `calendar_event` create decision, so a caller without the right never sees which of these is wrong. */
export function parseBusyQuery(q: Record<string, unknown>): BusyQuery {
  const raw = q.userIds;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .flatMap((s) => s.split(","))
    .map((s) => s.trim());
  if (parts.length === 0 || parts.every((p) => p === "")) throw bad("user_ids_required", "userIds is required: 1 to 20 comma-separated user ids", "userIds");
  if (parts.some((p) => !isUuidShaped(p))) throw bad("user_ids_invalid", "userIds must be user ids (uuids)", "userIds");
  const ids = parts.map((p) => p.toLowerCase());
  if (new Set(ids).size !== ids.length) throw bad("user_ids_invalid", "userIds must not repeat a person", "userIds");
  if (ids.length > BUSY_USERS_MAX) throw bad("user_ids_too_many", `userIds takes at most ${BUSY_USERS_MAX} people`, "userIds");

  const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const fromRaw = one(q.from);
  const toRaw = one(q.to);
  if (!fromRaw || !toRaw) throw bad("window_required", "from and to are required", "from");
  const from = parseInstant(fromRaw, "from");
  const to = parseInstant(toRaw, "to");
  if (to.getTime() <= from.getTime()) throw bad("window_invalid", "to must be after from", "to");
  if (to.getTime() - from.getTime() > BUSY_WINDOW_MAX_MS) throw bad("window_too_large", "the window is at most 14 days", "to");

  const exRaw = q.excludeEventId;
  let excludeEventId: string | null = null;
  if (exRaw !== undefined && exRaw !== "") {
    if (typeof exRaw !== "string" || !isUuidShaped(exRaw)) throw bad("id_invalid", "excludeEventId must be an event id (uuid)", "excludeEventId");
    excludeEventId = exRaw.toLowerCase();
  }
  return { userIds: ids, from, to, excludeEventId };
}

/** Sorts by start and joins intervals that overlap or touch (`[a, b)` then `[b, c)` is one block), so a person's answer carries
 *  as few boundaries as possible. The real start and end of each block are kept; nothing is clipped to the window. */
export function mergeIntervals(list: ReadonlyArray<{ startsAt: Date; endsAt: Date }>): Array<{ startsAt: Date; endsAt: Date }> {
  const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime());
  const out: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.startsAt.getTime() <= last.endsAt.getTime()) {
      if (i.endsAt.getTime() > last.endsAt.getTime()) last.endsAt = i.endsAt;
    } else {
      out.push({ startsAt: i.startsAt, endsAt: i.endsAt });
    }
  }
  return out;
}

/** Every requested person must be an active employee member of the company (the attendee rule, `firstNonMember`), else the 422
 *  names the first one asked for that is not. */
export async function assertBusyMembers(c: PoolClient, tenantId: string, userIds: readonly string[]): Promise<void> {
  const outsider = await firstNonMember(c, tenantId, userIds);
  if (outsider) throw new CalendarRuleError(422, "user_not_member", "user_not_member", "userIds", { userId: outsider });
}

/** The busy answer: one entry per requested person, in the order asked. An interval is a CONFIRMED, TIMED event of THIS company
 *  that overlaps `[from, to)` and that the person attends with any answer but `declined` (the organizer is an attendee row, so
 *  the same read covers them). Cancelled and all-day events are out. The SELECT names no title, place, link, organizer or id:
 *  the answer cannot carry what the read never fetched. */
export async function loadBusy(c: PoolClient, tenantId: string, q: BusyQuery): Promise<BusyAnswer> {
  const { rows } = await c.query<{ user_id: string; starts_at: Date; ends_at: Date }>(
    `SELECT a.user_id, e.starts_at, e.ends_at
       FROM calendar_event_attendees a
       JOIN calendar_events e ON e.id = a.event_id AND e.tenant_id = a.tenant_id
      WHERE e.tenant_id = $1
        AND a.user_id = ANY($2::uuid[])
        AND a.response <> 'declined'
        AND e.status = 'confirmed'
        AND e.starts_at IS NOT NULL AND e.ends_at IS NOT NULL
        AND e.starts_at < $4 AND e.ends_at > $3
        AND ($5::uuid IS NULL OR e.id <> $5::uuid)
      ORDER BY a.user_id, e.starts_at
      LIMIT ${BUSY_ROW_LIMIT}`,
    [tenantId, q.userIds, q.from.toISOString(), q.to.toISOString(), q.excludeEventId],
  );
  const byUser = new Map<string, Array<{ startsAt: Date; endsAt: Date }>>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({ startsAt: r.starts_at, endsAt: r.ends_at });
    byUser.set(r.user_id, list);
  }
  return {
    busy: q.userIds.map((userId) => ({
      userId,
      intervals: mergeIntervals(byUser.get(userId) ?? []).map((i) => ({ startsAt: i.startsAt.toISOString(), endsAt: i.endsAt.toISOString() })),
    })),
  };
}
