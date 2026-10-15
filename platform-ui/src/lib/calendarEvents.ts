// DW-8g (BFF §47): calendar events and meeting scheduling. Types and pure functions only, no I/O and no
// `server-only`, so the form (a client component) and the grids can share them. The readers are in
// `calendarEvents-data.ts`, the writes in `calendarEventsActions.ts`, the demo store in `demoCalendarEvents.ts`.
import { DISPLAY_TZ } from "./format";
import type { CalItem } from "./calendar";
import { monthGrid, weekDays } from "./calendar";
import { allDayEventDays, timedEventDays, windowForDays, zoneDay, zoneTime, zonedToInstant, zonedToMs } from "./zoneTime";

export type EventStatus = "confirmed" | "cancelled";
export type EventResponse = "needs_action" | "accepted" | "declined" | "tentative";
export type EventVisibility = "attendees" | "company";
/** What a person may answer; `needs_action` is only ever a starting state. */
export type EventAnswer = "accepted" | "tentative" | "declined";

/** A row of `GET /api/calendar/events/mine` (§47.3). */
export interface CalendarEventRow {
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
  myResponse: EventResponse | null;
  organizer: { id: string; name: string };
  attendeeCount: number;
  recording: { id: string; status: string } | null;
  client: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  href: string;
}

/** `GET /api/:t/calendar/events/:id` (§47.3, as built §47.7). */
export interface CalendarEventDetail {
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
  visibility: EventVisibility;
  status: EventStatus;
  cancelledAt: string | null;
  organizer: { id: string; name: string };
  attendees: { userId: string; name: string; response: EventResponse }[];
  attendeeCount: number;
  myResponse: EventResponse | null;
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

export const RESPONSE_LABEL: Record<EventResponse, string> = {
  needs_action: "Not answered", accepted: "Accepted", tentative: "Maybe", declined: "Declined",
};

// ---- the grid -------------------------------------------------------------------------------------------------

/** One grid item per day the event occupies inside `[firstDay, lastDay]`, all in the display zone. A timed event is
 *  placed by its start and end INSTANTS converted to that zone (so one at 23:30 in the zone sits on that day whatever
 *  the server's clock says); an all-day event by its plain dates. */
export function eventToCalItems(
  ev: CalendarEventRow, window: { firstDay: string; lastDay: string }, tz: string = DISPLAY_TZ,
): CalItem[] {
  const timed = !ev.allDay && ev.startsAt && ev.endsAt;
  const days = timed
    ? timedEventDays(ev.startsAt as string, ev.endsAt as string, tz)
    : ev.startsOn && ev.endsOn ? allDayEventDays(ev.startsOn, ev.endsOn) : [];
  const state: CalItem["state"] = ev.status === "cancelled" ? "cancelled" : ev.myResponse === "declined" ? "declined" : undefined;
  const out: CalItem[] = [];
  days.forEach((day, i) => {
    if (day < window.firstDay || day > window.lastDay) return;
    let time = "All day";
    let startTime: string | undefined;
    if (timed) {
      const first = i === 0, last = i === days.length - 1;
      const from = zoneTime(ev.startsAt as string, tz), to = zoneTime(ev.endsAt as string, tz);
      if (first && last) { time = `${from}–${to}`; startTime = from; }
      else if (first) { time = `from ${from}`; startTime = from; }
      else if (last) { time = `until ${to}`; startTime = "00:00"; }
      else { time = "All day"; startTime = undefined; }
    }
    out.push({
      id: `${ev.id}@${day}`, title: ev.title, status: state ?? ev.myResponse ?? "confirmed",
      date: day, href: ev.href, company: ev.company, projectName: ev.project?.name,
      kind: "event", state, time, startTime,
    });
  });
  return out;
}

/** Order within a day: all-day events, then timed ones by start, then tasks. */
function rank(it: CalItem): number {
  if (it.kind !== "event") return 2;
  return it.startTime ? 1 : 0;
}

/** Tasks and events as one list for the grids, sorted by day, then the order above, then title. */
export function mergeCalItems(
  tasks: CalItem[], events: CalendarEventRow[], window: { firstDay: string; lastDay: string }, tz: string = DISPLAY_TZ,
): CalItem[] {
  const all = [...tasks, ...events.flatMap((e) => eventToCalItems(e, window, tz))];
  return all.sort((a, b) =>
    a.date.localeCompare(b.date) || rank(a) - rank(b)
    || (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.title.localeCompare(b.title));
}

/** The days a view draws (the read window, as days): a month grid's first to last cell (at most 42 days, well inside
 *  the endpoint's 92-day cap), a week, or one day. */
export function gridDays(view: "month" | "week" | "day", anchor: string): { firstDay: string; lastDay: string } {
  if (view === "month") { const w = monthGrid(anchor); return { firstDay: w[0][0], lastDay: w[w.length - 1][6] }; }
  if (view === "week") { const d = weekDays(anchor); return { firstDay: d[0], lastDay: d[6] }; }
  return { firstDay: anchor, lastDay: anchor };
}

/** Whether an event is in the window's days at all (used to drop a row the server returned for the UTC edge). */
export function eventTouchesDay(ev: CalendarEventRow, day: string, tz: string = DISPLAY_TZ): boolean {
  return eventToCalItems(ev, { firstDay: day, lastDay: day }, tz).length > 0;
}

// ---- the Overview's Today block ---------------------------------------------------------------------------------

/** One line of the Today block. */
export interface TodayEvent {
  id: string;
  title: string;
  /** "10:00–10:45", "from 22:00", "until 01:00" or "All day", in the display zone. */
  time: string;
  href: string;
  state?: "cancelled" | "declined";
}

/** The events on `today` (a display-zone day), earliest first, all-day ones leading. Cancelled and declined ones stay in
 *  the list, marked, so a meeting that was called off is not mistaken for a free hour. */
export function todayEventsOf(rows: CalendarEventRow[], today: string, tz: string = DISPLAY_TZ): TodayEvent[] {
  return rows
    .flatMap((r) => eventToCalItems(r, { firstDay: today, lastDay: today }, tz))
    .sort((a, b) => rank(a) - rank(b) || (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.title.localeCompare(b.title))
    .map((it) => ({ id: it.id, title: it.title, time: it.time ?? "", href: it.href, ...(it.state ? { state: it.state } : {}) }));
}

// ---- the detail page ------------------------------------------------------------------------------------------

/** One readable line for when an event happens, in the display zone. */
export function describeWhen(
  ev: Pick<CalendarEventDetail, "allDay" | "startsAt" | "endsAt" | "startsOn" | "endsOn">, tz: string = DISPLAY_TZ,
): string {
  // Spelled out, not `toLocaleDateString`, so the words never depend on the runtime's ICU data.
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${WD[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, "0")} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  if (ev.allDay && ev.startsOn && ev.endsOn) {
    return ev.startsOn === ev.endsOn ? `${day(ev.startsOn)}, all day` : `${day(ev.startsOn)} to ${day(ev.endsOn)}, all day`;
  }
  if (ev.startsAt && ev.endsAt) {
    const d1 = zoneDay(ev.startsAt, tz), d2 = zoneDay(ev.endsAt, tz);
    const t1 = zoneTime(ev.startsAt, tz), t2 = zoneTime(ev.endsAt, tz);
    return d1 === d2 ? `${day(d1)}, ${t1}–${t2}` : `${day(d1)} ${t1} to ${day(d2)} ${t2}`;
  }
  return "";
}

/** The buttons the event page draws. Cerbos's answer (`canEdit`, `canCancel`, `canRespond`) is the only input: the
 *  UI never works it out from roles. A cancelled event has none. */
export function eventButtons(ev: Pick<CalendarEventDetail, "canEdit" | "canCancel" | "canRespond" | "status">): { respond: boolean; edit: boolean; cancel: boolean } {
  const live = ev.status === "confirmed";
  return { respond: live && ev.canRespond, edit: live && ev.canEdit, cancel: live && ev.canCancel };
}

// ---- the form -------------------------------------------------------------------------------------------------

export interface EventFormInput {
  title: string;
  allDay: boolean;
  /** Timed: the day, and the two times, all in the display zone. */
  date: string;
  startTime: string;
  endTime: string;
  /** All day: first and last day, inclusive. */
  startDate: string;
  endDate: string;
  attendeeIds: string[];
  location: string;
  videoUrl: string;
  description: string;
  visibility: EventVisibility;
  clientId: string;
  projectId: string;
  record: boolean;
}

/** The body of POST (create) or PATCH (edit). On PATCH a blank place, link, client or project is `null` (clears it). */
export type EventPayload = Record<string, unknown>;

export type EventFormCheck = { ok: true; payload: EventPayload } | { ok: false; error: string; field: string };

export const TITLE_MAX = 200;
export const LOCATION_MAX = 300;
export const DESCRIPTION_MAX = 5000;
export const ATTENDEES_MAX = 50;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const fail = (field: string, error: string): EventFormCheck => ({ ok: false, error, field });

/** True for an https link the browser can open. */
export function isHttpsUrl(v: string): boolean {
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

/** Checks the form and builds the request body, in plain sentences. Mirrors the backend's rules (§47.1, §47.3) so a
 *  mistake is caught before the round trip; the backend still decides. Times are read in `tz` (the display zone). */
export function validateEventForm(i: EventFormInput, mode: "create" | "edit" = "create", tz: string = DISPLAY_TZ): EventFormCheck {
  const title = i.title.trim();
  if (!title) return fail("title", "Give the meeting a title.");
  if (title.length > TITLE_MAX) return fail("title", `The title can be at most ${TITLE_MAX} characters.`);

  let time: EventPayload;
  if (i.allDay) {
    if (!ISO_DAY.test(i.startDate)) return fail("startDate", "Pick the first day.");
    if (!ISO_DAY.test(i.endDate)) return fail("endDate", "Pick the last day.");
    if (i.endDate < i.startDate) return fail("endDate", "The last day can't be before the first day.");
    time = { allDay: true, startsOn: i.startDate, endsOn: i.endDate };
    if (i.record) return fail("record", "A recording needs a start time, so it can't be set on an all-day event.");
  } else {
    if (!ISO_DAY.test(i.date)) return fail("date", "Pick a date.");
    if (!i.startTime) return fail("startTime", "Pick a start time.");
    if (!i.endTime) return fail("endTime", "Pick an end time.");
    const startsAt = zonedToInstant(i.date, i.startTime, tz);
    const endsAt = zonedToInstant(i.date, i.endTime, tz);
    if (!startsAt) return fail("date", "That date or start time isn't valid.");
    if (!endsAt) return fail("endTime", "That end time isn't valid.");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return fail("endTime", "The end must be after the start.");
    time = { startsAt, endsAt };
  }

  if (i.attendeeIds.length > ATTENDEES_MAX) return fail("attendeeIds", `At most ${ATTENDEES_MAX} people can be invited.`);
  const location = i.location.trim();
  if (location.length > LOCATION_MAX) return fail("location", `The place can be at most ${LOCATION_MAX} characters.`);
  const videoUrl = i.videoUrl.trim();
  if (videoUrl && !isHttpsUrl(videoUrl)) return fail("videoUrl", "The video link must be a web address starting with https://.");
  if (videoUrl.length > 2048) return fail("videoUrl", "The video link is too long.");
  const description = i.description.trim();
  if (description.length > DESCRIPTION_MAX) return fail("description", `The notes can be at most ${DESCRIPTION_MAX} characters.`);

  const blank = mode === "edit" ? null : undefined;
  const payload: EventPayload = {
    title, ...time, attendeeIds: i.attendeeIds, visibility: i.visibility, description,
    location: location || blank, videoUrl: videoUrl || blank,
    clientId: i.clientId || blank, projectId: i.projectId || blank,
  };
  if (mode === "create" && i.record) payload.record = true;
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return { ok: true, payload };
}

/** The form's starting values for a new meeting: the next whole hour today, one hour long, in the display zone. */
export function defaultFormInput(today: string, nowTime: string): EventFormInput {
  const h = Math.min(Number(nowTime.slice(0, 2)) + 1, 22);
  const hh = (n: number) => String(n).padStart(2, "0");
  return {
    title: "", allDay: false, date: today, startTime: `${hh(h)}:00`, endTime: `${hh(h + 1)}:00`,
    startDate: today, endDate: today, attendeeIds: [], location: "", videoUrl: "", description: "",
    visibility: "attendees", clientId: "", projectId: "", record: false,
  };
}

/** The form's values from an existing event, for the edit form. */
export function formInputOf(ev: CalendarEventDetail, tz: string = DISPLAY_TZ): EventFormInput {
  const timed = !ev.allDay && ev.startsAt && ev.endsAt;
  const today = timed ? zoneDay(ev.startsAt as string, tz) : ev.startsOn ?? "";
  return {
    title: ev.title, allDay: ev.allDay,
    date: today, startTime: timed ? zoneTime(ev.startsAt as string, tz) : "09:00", endTime: timed ? zoneTime(ev.endsAt as string, tz) : "10:00",
    startDate: ev.startsOn ?? today, endDate: ev.endsOn ?? today,
    attendeeIds: ev.attendees.map((a) => a.userId), location: ev.location ?? "", videoUrl: ev.videoUrl ?? "", description: ev.description,
    visibility: ev.visibility, clientId: ev.client?.id ?? "", projectId: ev.project?.id ?? "", record: false,
  };
}

// ---- refusals, in words ---------------------------------------------------------------------------------------

export interface EventErrorInput {
  status: number;
  /** The machine code (`reason`, else the `error` text). */
  reason?: string;
  /** The body's `detail` object (422 `attendee_not_member` carries `{userId}`). */
  detail?: Record<string, unknown>;
}

/** A refusal as one sentence. 422 names the person when `detail.userId` resolves through `nameOf` (the members list
 *  the page already holds). */
export function eventErrorText(
  e: EventErrorInput, nameOf: (userId: string) => string | undefined = () => undefined, kind: "create" | "change" | "respond" = "change",
): string {
  const r = e.reason ?? "";
  switch (e.status) {
    case 400:
      switch (r) {
        case "title_invalid": return `The title must be 1 to ${TITLE_MAX} characters.`;
        case "time_invalid": case "date_invalid": return "That date or time isn't valid.";
        case "time_shape_invalid": case "time_range_invalid": return "The start and end don't fit together. The end must be after the start.";
        case "time_span_too_long": return "A timed event can last at most 14 days.";
        case "description_invalid": return `The notes can be at most ${DESCRIPTION_MAX} characters.`;
        case "location_invalid": return `The place can be at most ${LOCATION_MAX} characters.`;
        case "video_url_invalid": return "The video link must be a web address starting with https://.";
        case "attendees_too_many": return `At most ${ATTENDEES_MAX} people can be invited.`;
        case "attendees_invalid": return "The list of people couldn't be read.";
        case "link_invalid": return "That client or project isn't in this company.";
        case "record_needs_timed_event": return "A recording needs a start time, so it can't be set on an all-day event.";
        case "record_not_editable": return "Recording is chosen when the meeting is made and can't be changed.";
        case "nothing_to_change": return "Nothing was changed.";
        case "window_too_large": return "That window is too long to read at once.";
        default: return "Check the details and try again.";
      }
    case 403:
      if (kind === "create") return "You can't schedule meetings in this company.";
      if (kind === "respond") return "Only the people invited to this event can answer it.";
      return "You can't change this event. Only its organizer or a company admin can.";
    case 404: return "This event doesn't exist or isn't visible to you.";
    case 409:
      if (r === "event_cancelled") return "This event was cancelled, so it can't be changed or answered.";
      if (r === "recording_needs_timed_event") return "A meeting with a recording needs a start time, so it can't become all-day.";
      return "This event changed while you were looking at it. Reload and try again.";
    case 422: {
      if (r === "attendee_not_member") {
        const id = typeof e.detail?.userId === "string" ? e.detail.userId : "";
        const name = id ? nameOf(id) : undefined;
        return name
          ? `${name} isn't an active member of this company, so they can't be invited.`
          : "One of the people you picked isn't an active member of this company, so they can't be invited.";
      }
      return "Check the details and try again.";
    }
    default: return "Could not save that. Please try again.";
  }
}

/** What an action returns: a value, never a thrown refusal. */
export type EventActionResult = { ok: true; id?: string; href?: string } | { ok: false; error: string; field?: string };

/** The event page's address. `company` carries the event's company, so a link from another company's calendar opens it
 *  where it lives. */
export const eventHref = (tenantId: string, id: string): string => `/calendar/events/${encodeURIComponent(id)}?company=${encodeURIComponent(tenantId)}`;

// ───────────────────────────────────────── busy times (§47.4, DW-D28) ─────────────────────────────────────────

/** `GET /api/:t/calendar/busy` (§47.4): times only, one entry per person asked, in the order asked. */
export interface BusyPerson { userId: string; intervals: { startsAt: string; endsAt: string }[] }
/** What the form's `loadBusy` and the action return: a value, never a thrown refusal. `{ ok: false }` means "unknown", which
 *  the form says in words and never draws as "everyone is free". */
export type BusyResult = { ok: true; busy: BusyPerson[] } | { ok: false };
export type LoadBusy = (userIds: string[], fromIso: string, toIso: string) => Promise<BusyResult>;
/** The most people one busy read takes (the backend's limit). */
export const BUSY_PEOPLE_MAX = 20;

/** The window `[00:00, 24:00)` of a day in `tz`, as ISO instants; null for a date that is not real. */
export function busyDayWindow(day: string, tz: string = DISPLAY_TZ): { from: string; to: string } | null {
  if (Number.isNaN(zonedToMs(day, "00:00", tz))) return null;
  return windowForDays(day, day, tz);
}

/** The busy intervals of one person, cut to the picked day for DISPLAY (the answer itself is never clipped: an interval
 *  that began the day before reads here as "00:00-..."). Each is `[startMs, endMs)`; `end24` marks an end at the day's end. */
function onDay(intervals: BusyPerson["intervals"], day: string, tz: string): { s: number; e: number; end24: boolean }[] {
  const w = busyDayWindow(day, tz);
  if (!w) return [];
  const from = Date.parse(w.from), to = Date.parse(w.to);
  const out: { s: number; e: number; end24: boolean }[] = [];
  for (const i of intervals) {
    const s = Date.parse(i.startsAt), e = Date.parse(i.endsAt);
    if (Number.isNaN(s) || Number.isNaN(e) || !(s < to && e > from)) continue;
    out.push({ s: Math.max(s, from), e: Math.min(e, to), end24: e >= to });
  }
  return out.sort((a, b) => a.s - b.s || a.e - b.e);
}

/** A person's busy times on a day, in `tz`: "09:00-10:30, 14:00-15:00", or "Free". A block that runs to the end of the day
 *  reads "-24:00", never "-00:00". */
export function busyText(intervals: BusyPerson["intervals"], day: string, tz: string = DISPLAY_TZ): string {
  const list = onDay(intervals, day, tz);
  if (list.length === 0) return "Free";
  return list.map((i) => `${zoneTime(i.s, tz)}-${i.end24 ? "24:00" : zoneTime(i.e, tz)}`).join(", ");
}

/** Whether any busy interval overlaps the chosen `[start, end)` on `day` (typed in `tz`). False while the chosen time is not
 *  a real range, so a half-typed time never flags a clash. */
export function busyClashes(
  intervals: BusyPerson["intervals"], day: string, startTime: string, endTime: string, tz: string = DISPLAY_TZ,
): boolean {
  const s = zonedToMs(day, startTime, tz), e = zonedToMs(day, endTime, tz);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return false;
  return intervals.some((i) => Date.parse(i.startsAt) < e && Date.parse(i.endsAt) > s);
}
