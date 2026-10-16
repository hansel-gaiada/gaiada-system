// DW-8g (FRONTEND-BFF-CONTRACT §47.1 to §47.3) — the PURE rules of calendar-events.service.ts: the body and query parsers, the
// two time shapes and the 14-day span, the attendee diff, the answer reset after a time change, the patch plan and the time in
// words. No database, no Cerbos: runs everywhere. The HTTP/DB proof of the same rules is calendar-events.test.ts, which runs on
// the Linux gate.
import { describe, it, expect } from "vitest";
import {
  CalendarRuleError, ATTENDEES_MAX, BUSY_USERS_MAX, UNIT_NODE_ID_MAX, VISIBILITIES, departmentFactsOf, isUnitNodeIdShaped, describeWhen, mergeIntervals, parseBusyQuery, diffAttendees, eventHref, mineSortKey, parseAttendeeIds, parseCreate, parseDay,
  parseInstant, parseMineQuery, parsePatch, parseRespond, parseTimeSpec, planPatch, responseAfterTimeChange, timeChanged,
  timeOfFacts, type EventFacts,
} from "./calendar-events.service";

function refusal(fn: () => unknown): CalendarRuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CalendarRuleError);
    return e as CalendarRuleError;
  }
  throw new Error("expected a CalendarRuleError, but nothing was thrown");
}
const reasonOf = (fn: () => unknown) => refusal(fn).reason;

const U1 = "0190a000-0000-7000-8000-000000000001";
const U2 = "0190a000-0000-7000-8000-000000000002";
const U3 = "0190a000-0000-7000-8000-000000000003";
const ORG = "0190a000-0000-7000-8000-0000000000aa";
const REC = "0190a000-0000-7000-8000-0000000000bb";
const T = "0190a000-0000-7000-8000-0000000000cc";

const timed = { title: "Kickoff", startsAt: "2026-10-20T09:00:00+08:00", endsAt: "2026-10-20T10:00:00+08:00" };
const allDay = { title: "Offsite", allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21" };

describe("time shapes (§47.1)", () => {
  it("a timed event takes two instants WITH an offset; a bare local time is refused, never read in the server's zone", () => {
    const t = parseTimeSpec(timed)!;
    expect(t.allDay).toBe(false);
    if (!t.allDay) expect(t.startsAt.toISOString()).toBe("2026-10-20T01:00:00.000Z");
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-10-20T09:00:00", endsAt: "2026-10-20T10:00:00Z" }))).toBe("time_invalid");
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-10-20", endsAt: "2026-10-21" }))).toBe("time_invalid");
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-13-40T09:00:00Z", endsAt: "2026-10-20T10:00:00Z" }))).toBe("time_invalid");
  });

  it("an all-day event takes allDay: true and two inclusive dates; a same-day range is fine, a backwards one is not", () => {
    expect(parseTimeSpec(allDay)).toEqual({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21" });
    expect(parseTimeSpec({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-20" })).toMatchObject({ allDay: true });
    expect(reasonOf(() => parseTimeSpec({ allDay: true, startsOn: "2026-10-21", endsOn: "2026-10-20" }))).toBe("time_range_invalid");
    expect(reasonOf(() => parseTimeSpec({ allDay: true, startsOn: "2026-02-30", endsOn: "2026-03-01" }))).toBe("date_invalid");
  });

  it("exactly one shape: mixing the two, half of one, or dates without allDay is a 400, never a silent pick", () => {
    expect(reasonOf(() => parseTimeSpec({ allDay: true, startsAt: timed.startsAt, startsOn: "2026-10-20", endsOn: "2026-10-20" }))).toBe("time_shape_invalid");
    expect(reasonOf(() => parseTimeSpec({ allDay: true, startsOn: "2026-10-20" }))).toBe("time_shape_invalid");
    expect(reasonOf(() => parseTimeSpec({ startsAt: timed.startsAt }))).toBe("time_shape_invalid");
    expect(reasonOf(() => parseTimeSpec({ startsOn: "2026-10-20", endsOn: "2026-10-20" }))).toBe("time_shape_invalid");
    expect(reasonOf(() => parseTimeSpec({ allDay: "yes", startsOn: "2026-10-20", endsOn: "2026-10-20" }))).toBe("time_shape_invalid");
    expect(parseTimeSpec({ title: "no time keys at all" })).toBeNull();
  });

  it("ends_at must be after starts_at, and the span is at most 14 days (the boundary is allowed)", () => {
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-10-20T10:00:00Z", endsAt: "2026-10-20T10:00:00Z" }))).toBe("time_range_invalid");
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-10-20T10:00:00Z", endsAt: "2026-10-20T09:00:00Z" }))).toBe("time_range_invalid");
    expect(parseTimeSpec({ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-15T00:00:00Z" })).toMatchObject({ allDay: false });
    expect(reasonOf(() => parseTimeSpec({ startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-15T00:00:01Z" }))).toBe("time_span_too_long");
  });

  it("parseInstant and parseDay name the field they refuse", () => {
    expect(refusal(() => parseInstant("tomorrow", "startsAt")).field).toBe("startsAt");
    expect(refusal(() => parseDay("2026-1-1", "from")).field).toBe("from");
  });
});

describe("parseCreate (§47.3)", () => {
  it("a timed event with the defaults: attendees visibility, no recording, empty attendee list", () => {
    const c = parseCreate({ ...timed, attendeeIds: [U1] });
    expect(c).toMatchObject({ title: "Kickoff", description: "", location: null, videoUrl: null, visibility: "attendees", record: false, attendeeIds: [U1], clientId: null, projectId: null });
    expect(parseCreate(timed).attendeeIds).toEqual([]);
  });

  it("an all-day event, and record:true on it is a 400 (the recording is scheduled for a start time)", () => {
    expect(parseCreate(allDay).time).toEqual({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21" });
    expect(reasonOf(() => parseCreate({ ...allDay, record: true }))).toBe("record_needs_timed_event");
    expect(parseCreate({ ...timed, record: true }).record).toBe(true);
    expect(reasonOf(() => parseCreate({ ...timed, record: "yes" }))).toBe("record_invalid");
  });

  it("a time is required, and the title is 1 to 200 characters", () => {
    expect(reasonOf(() => parseCreate({ title: "No time" }))).toBe("time_shape_invalid");
    expect(reasonOf(() => parseCreate({ ...timed, title: "   " }))).toBe("title_invalid");
    expect(reasonOf(() => parseCreate({ ...timed, title: "x".repeat(201) }))).toBe("title_invalid");
    expect(parseCreate({ ...timed, title: "x".repeat(200) }).title.length).toBe(200);
    expect(reasonOf(() => parseCreate({ startsAt: timed.startsAt, endsAt: timed.endsAt }))).toBe("title_invalid");
    expect(reasonOf(() => parseCreate("not an object"))).toBe("body_invalid");
  });

  it("description is scrubbed like other free text and capped at 5,000; a NUL byte never reaches Postgres", () => {
    const d = parseCreate({ ...timed, description: "call 4111 1111 1111 1111 or mail a@b.co\u0000" }).description;
    expect(d).toContain("[REDACTED-PAN]");
    expect(d).toContain("[REDACTED-EMAIL]");
    expect(d).not.toContain("\u0000");
    expect(parseCreate({ ...timed, description: "d".repeat(5000) }).description.length).toBe(5000);
    expect(reasonOf(() => parseCreate({ ...timed, description: "d".repeat(5001) }))).toBe("description_invalid");
  });

  it("location is at most 300 characters; videoUrl is https only, at most 2,048; blank clears; null clears", () => {
    expect(parseCreate({ ...timed, location: "Room 1" }).location).toBe("Room 1");
    expect(parseCreate({ ...timed, location: "  " }).location).toBeNull();
    expect(reasonOf(() => parseCreate({ ...timed, location: "l".repeat(301) }))).toBe("location_invalid");
    expect(parseCreate({ ...timed, videoUrl: "https://meet.example.com/abc" }).videoUrl).toBe("https://meet.example.com/abc");
    expect(parseCreate({ ...timed, videoUrl: null }).videoUrl).toBeNull();
    expect(reasonOf(() => parseCreate({ ...timed, videoUrl: "http://meet.example.com/abc" }))).toBe("video_url_invalid");
    expect(reasonOf(() => parseCreate({ ...timed, videoUrl: "javascript:alert(1)" }))).toBe("video_url_invalid");
    expect(reasonOf(() => parseCreate({ ...timed, videoUrl: "not a url" }))).toBe("video_url_invalid");
    expect(reasonOf(() => parseCreate({ ...timed, videoUrl: `https://x.test/${"a".repeat(2048)}` }))).toBe("video_url_invalid");
  });

  it("visibility is attendees or company; client and project are ids or null", () => {
    expect(parseCreate({ ...timed, visibility: "company" }).visibility).toBe("company");
    expect(reasonOf(() => parseCreate({ ...timed, visibility: "public" }))).toBe("visibility_invalid");
    expect(parseCreate({ ...timed, clientId: T, projectId: null }).clientId).toBe(T);
    expect(reasonOf(() => parseCreate({ ...timed, clientId: "acme" }))).toBe("id_invalid");
  });
});

describe("attendee list (§47.3: at most 50)", () => {
  it("de-duplicates, lower-cases and keeps the input order", () => {
    expect(parseAttendeeIds([U2, U1, U2.toUpperCase()])).toEqual([U2, U1]);
  });

  it("50 is allowed and 51 is a 400 attendees_too_many; a non-id is a 400", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `0190a000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`);
    expect(parseAttendeeIds(many(ATTENDEES_MAX)).length).toBe(50);
    expect(reasonOf(() => parseAttendeeIds(many(51)))).toBe("attendees_too_many");
    expect(reasonOf(() => parseAttendeeIds(["nobody"]))).toBe("attendees_invalid");
    expect(reasonOf(() => parseAttendeeIds("everyone"))).toBe("attendees_invalid");
  });
});

describe("the attendee diff (§47.3)", () => {
  it("added are invited, removed are told it is off, kept are the rest", () => {
    expect(diffAttendees([ORG, U1, U2], [ORG, U2, U3], ORG)).toEqual({ added: [U3], removed: [U1], kept: [ORG, U2] });
  });

  it("the organizer is ALWAYS an attendee: absent from the new list they are added back, never removed", () => {
    expect(diffAttendees([ORG, U1], [U1, U2], ORG)).toEqual({ added: [U2], removed: [], kept: [ORG, U1] });
    expect(diffAttendees([ORG], [], ORG)).toEqual({ added: [], removed: [], kept: [ORG] });
  });

  it("an identical list changes nothing", () => {
    expect(diffAttendees([ORG, U1], [U1, ORG], ORG)).toEqual({ added: [], removed: [], kept: [ORG, U1] });
  });
});

describe("a time change resets the answers (§47.3)", () => {
  it("everyone goes back to needs_action, and the organizer stays accepted", () => {
    expect(responseAfterTimeChange(U1, ORG)).toBe("needs_action");
    expect(responseAfterTimeChange(ORG, ORG)).toBe("accepted");
  });

  it("timeChanged: another instant, another day, or another shape counts; the same time does not", () => {
    const a = parseTimeSpec(timed)!;
    expect(timeChanged(a, parseTimeSpec(timed)!)).toBe(false);
    expect(timeChanged(a, parseTimeSpec({ ...timed, endsAt: "2026-10-20T11:00:00+08:00" })!)).toBe(true);
    // the same instant written in another offset is NOT a change
    expect(timeChanged(a, parseTimeSpec({ startsAt: "2026-10-20T01:00:00Z", endsAt: "2026-10-20T02:00:00Z" })!)).toBe(false);
    const d = parseTimeSpec(allDay)!;
    expect(timeChanged(d, parseTimeSpec(allDay)!)).toBe(false);
    expect(timeChanged(d, parseTimeSpec({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-22" })!)).toBe(true);
    expect(timeChanged(a, d)).toBe(true);
  });
});

function facts(over: Partial<EventFacts> = {}): EventFacts {
  return {
    id: T, tenantId: T, title: "Kickoff", description: "Agenda", startsAt: new Date("2026-10-20T01:00:00Z"), endsAt: new Date("2026-10-20T02:00:00Z"),
    startsOn: null, endsOn: null, location: "Room 1", videoUrl: null, organizerId: ORG, visibility: "attendees", unitNodeId: null, status: "confirmed",
    cancelledAt: null, clientId: null, projectId: null, meetingRecordingId: null, createdAt: new Date(0), updatedAt: new Date(0),
    attendees: [{ userId: ORG, response: "accepted" }, { userId: U1, response: "accepted" }], ...over,
  };
}

describe("parsePatch and planPatch (§47.3)", () => {
  it("an empty patch is a 400, and `record` is never editable", () => {
    expect(reasonOf(() => parsePatch({}))).toBe("nothing_to_change");
    expect(reasonOf(() => parsePatch({ record: true }))).toBe("record_not_editable");
    expect(reasonOf(() => parsePatch(null))).toBe("body_invalid");
  });

  it("a time change is a whole time spec: half of one is refused", () => {
    expect(reasonOf(() => parsePatch({ endsAt: "2026-10-20T11:00:00Z" }))).toBe("time_shape_invalid");
    expect(parsePatch({ startsAt: "2026-10-21T01:00:00Z", endsAt: "2026-10-21T02:00:00Z" }).time).toMatchObject({ allDay: false });
  });

  it("null clears a place, a link, a client and a project", () => {
    expect(parsePatch({ location: null, videoUrl: null, clientId: null, projectId: null })).toEqual({ location: null, videoUrl: null, clientId: null, projectId: null });
  });

  it("a title edit alone moves no time and leaves the answers alone", () => {
    const plan = planPatch(facts(), parsePatch({ title: "Kickoff v2" }));
    expect(plan.title).toBe("Kickoff v2");
    expect(plan.timeChanged).toBe(false);
    expect(plan.changed).toEqual(["title"]);
    expect(plan.attendees).toEqual({ added: [], removed: [], kept: [ORG, U1] });
  });

  it("a new time is a time change; the plan names it and the field names carry no values", () => {
    const plan = planPatch(facts(), parsePatch({ startsAt: "2026-10-21T01:00:00Z", endsAt: "2026-10-21T02:00:00Z", description: "New agenda" }));
    expect(plan.timeChanged).toBe(true);
    expect(plan.changed).toEqual(["description", "time"]);
    expect(JSON.stringify(plan.changed)).not.toContain("New agenda");
  });

  it("an attendee list is a replacement: added, removed, and the organizer kept", () => {
    const plan = planPatch(facts(), parsePatch({ attendeeIds: [U2] }));
    expect(plan.attendees).toEqual({ added: [U2], removed: [U1], kept: [ORG] });
    expect(plan.changed).toEqual(["attendees"]);
  });

  it("an event with a recording cannot become all-day (409); one without can", () => {
    const toAllDay = parsePatch({ allDay: true, startsOn: "2026-10-22", endsOn: "2026-10-22" });
    const e = refusal(() => planPatch(facts({ meetingRecordingId: REC }), toAllDay));
    expect([e.httpStatus, e.reason]).toEqual([409, "recording_needs_timed_event"]);
    const ok = planPatch(facts(), toAllDay);
    expect(ok.time).toEqual({ allDay: true, startsOn: "2026-10-22", endsOn: "2026-10-22" });
    expect(ok.timeChanged).toBe(true);
  });

  it("timeOfFacts reads either stored shape", () => {
    expect(timeOfFacts(facts())).toMatchObject({ allDay: false });
    expect(timeOfFacts(facts({ startsAt: null, endsAt: null, startsOn: "2026-10-20", endsOn: "2026-10-21" }))).toEqual({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-21" });
  });
});

describe("parseRespond (§47.3)", () => {
  it("accepted, declined and tentative are answers; needs_action and anything else are not", () => {
    for (const response of ["accepted", "declined", "tentative"]) expect(parseRespond({ response })).toEqual({ response });
    expect(reasonOf(() => parseRespond({ response: "needs_action" }))).toBe("response_invalid");
    expect(reasonOf(() => parseRespond({ response: "yes" }))).toBe("response_invalid");
    expect(reasonOf(() => parseRespond({}))).toBe("response_invalid");
    expect(reasonOf(() => parseRespond(undefined))).toBe("response_invalid");
  });
});

describe("parseMineQuery (§47.3: the window is required and at most 92 days)", () => {
  it("both ends are required", () => {
    expect(reasonOf(() => parseMineQuery({}))).toBe("window_required");
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-01" }))).toBe("window_required");
  });

  it("a date alone is that day's UTC midnight; an instant needs an offset", () => {
    const w = parseMineQuery({ from: "2026-10-01", to: "2026-11-01" });
    expect(w.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.scope).toBe("all");
    expect(parseMineQuery({ from: "2026-09-30T16:00:00Z", to: "2026-10-31T16:00:00Z" }).to.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-01T00:00:00", to: "2026-11-01" }))).toBe("time_invalid");
  });

  it("92 days is allowed, 93 is a 400, and to must follow from", () => {
    expect(parseMineQuery({ from: "2026-10-01", to: "2026-12-31" }).to.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-01", to: "2027-01-02" }))).toBe("window_too_large");
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-02", to: "2026-10-01" }))).toBe("window_invalid");
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-01", to: "2026-10-01" }))).toBe("window_invalid");
  });

  it("scope is all or one company id", () => {
    expect(parseMineQuery({ from: "2026-10-01", to: "2026-10-08", scope: T.toUpperCase() }).scope).toBe(T);
    expect(reasonOf(() => parseMineQuery({ from: "2026-10-01", to: "2026-10-08", scope: "acme" }))).toBe("scope_invalid");
  });
});

describe("the time in words, and the row helpers", () => {
  it("a timed event is described in the display zone, an all-day one by its days", () => {
    expect(describeWhen(parseTimeSpec(timed)!, "Asia/Singapore")).toBe("Tue 20 Oct, 09:00 to 10:00");
    expect(describeWhen(parseTimeSpec(timed)!, "UTC")).toBe("Tue 20 Oct, 01:00 to 02:00");
    expect(describeWhen(parseTimeSpec({ startsAt: "2026-10-20T20:00:00Z", endsAt: "2026-10-21T02:00:00Z" })!, "Asia/Singapore")).toBe("Wed 21 Oct, 04:00 to 10:00");
    expect(describeWhen(parseTimeSpec({ startsAt: "2026-10-20T09:00:00Z", endsAt: "2026-10-22T09:00:00Z" })!, "UTC")).toBe("Tue 20 Oct, 09:00 to Thu 22 Oct, 09:00");
    expect(describeWhen({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-20" })).toBe("Tue 20 Oct, all day");
    expect(describeWhen({ allDay: true, startsOn: "2026-10-20", endsOn: "2026-10-22" })).toBe("Tue 20 Oct to Thu 22 Oct, all day");
  });

  it("the href is the UI route with the company, and rows sort by start (an all-day event by its day)", () => {
    expect(eventHref(T, ORG)).toBe(`/calendar/events/${ORG}?company=${T}`);
    expect(mineSortKey({ startsAt: "2026-10-20T01:00:00.000Z", startsOn: null })).toBe(Date.parse("2026-10-20T01:00:00Z"));
    expect(mineSortKey({ startsAt: null, startsOn: "2026-10-20" })).toBe(Date.parse("2026-10-20T00:00:00Z"));
  });
});

describe("busy times (§47.4, DW-D28): the query and the merge", () => {
  const WIN = { from: "2027-03-10T00:00:00Z", to: "2027-03-11T00:00:00Z" };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `0190a000-0000-7000-8000-${String(i + 1).padStart(12, "0")}`);
  const d = (iso: string) => new Date(iso);

  it("a good query: a comma list (or a repeated param) of distinct uuids, lower-cased, and a window with offsets", () => {
    const q = parseBusyQuery({ userIds: `${U1}, ${U2.toUpperCase()}`, ...WIN });
    expect(q.userIds).toEqual([U1, U2]);
    expect(q.from.toISOString()).toBe("2027-03-10T00:00:00.000Z");
    expect(q.to.toISOString()).toBe("2027-03-11T00:00:00.000Z");
    expect(q.excludeEventId).toBeNull();
    expect(parseBusyQuery({ userIds: [U1, U2], ...WIN }).userIds).toEqual([U1, U2]);
    expect(parseBusyQuery({ userIds: U1, ...WIN, excludeEventId: ORG.toUpperCase() }).excludeEventId).toBe(ORG);
    expect(parseBusyQuery({ userIds: U1, ...WIN, excludeEventId: "" }).excludeEventId).toBeNull();
    expect(parseBusyQuery({ userIds: U1, from: "2027-03-10T08:00:00+08:00", to: "2027-03-10T09:00:00+08:00" }).from.toISOString()).toBe("2027-03-10T00:00:00.000Z");
  });

  it("userIds is 1 to 20 distinct uuids: none, a bad one, a repeat, an empty slot and 21 are each a 400", () => {
    expect(reasonOf(() => parseBusyQuery({ ...WIN }))).toBe("user_ids_required");
    expect(reasonOf(() => parseBusyQuery({ userIds: "", ...WIN }))).toBe("user_ids_required");
    expect(reasonOf(() => parseBusyQuery({ userIds: "nope", ...WIN }))).toBe("user_ids_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: `${U1},${U1}`, ...WIN }))).toBe("user_ids_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: `${U1},,${U2}`, ...WIN }))).toBe("user_ids_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: ids(BUSY_USERS_MAX + 1).join(","), ...WIN }))).toBe("user_ids_too_many");
    expect(parseBusyQuery({ userIds: ids(BUSY_USERS_MAX).join(","), ...WIN }).userIds).toHaveLength(20);
    expect(refusal(() => parseBusyQuery({ userIds: "nope", ...WIN })).httpStatus).toBe(400);
  });

  it("the window: required, offsets on both, from before to, at most 14 days (14 exactly is fine, 15 is not)", () => {
    expect(reasonOf(() => parseBusyQuery({ userIds: U1 }))).toBe("window_required");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: WIN.from }))).toBe("window_required");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: "2027-03-10T09:00:00", to: "2027-03-10T10:00:00" }))).toBe("time_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: "2027-03-10", to: "2027-03-11" }))).toBe("time_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: WIN.to, to: WIN.from }))).toBe("window_invalid");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: WIN.from, to: WIN.from }))).toBe("window_invalid");
    expect(parseBusyQuery({ userIds: U1, from: "2027-03-01T00:00:00Z", to: "2027-03-15T00:00:00Z" }).to.getTime()).toBeGreaterThan(0);
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, from: "2027-03-01T00:00:00Z", to: "2027-03-15T00:00:00.001Z" }))).toBe("window_too_large");
    expect(reasonOf(() => parseBusyQuery({ userIds: U1, ...WIN, excludeEventId: "nope" }))).toBe("id_invalid");
  });

  it("mergeIntervals sorts by start and joins overlapping or touching intervals, keeping the real ends (nothing clipped)", () => {
    expect(mergeIntervals([])).toEqual([]);
    const m = mergeIntervals([
      { startsAt: d("2027-03-10T14:00:00Z"), endsAt: d("2027-03-10T15:00:00Z") },
      { startsAt: d("2027-03-10T10:00:00Z"), endsAt: d("2027-03-10T11:00:00Z") },
      { startsAt: d("2027-03-10T09:00:00Z"), endsAt: d("2027-03-10T10:00:00Z") }, // touches the next: one block
      { startsAt: d("2027-03-10T09:30:00Z"), endsAt: d("2027-03-10T09:45:00Z") }, // inside the first
      { startsAt: d("2027-03-09T23:00:00Z"), endsAt: d("2027-03-10T01:00:00Z") }, // runs in from the day before
      { startsAt: d("2027-03-10T14:30:00Z"), endsAt: d("2027-03-10T16:00:00Z") }, // overlaps and extends the last
    ]);
    expect(m.map((i) => [i.startsAt.toISOString(), i.endsAt.toISOString()])).toEqual([
      ["2027-03-09T23:00:00.000Z", "2027-03-10T01:00:00.000Z"],
      ["2027-03-10T09:00:00.000Z", "2027-03-10T11:00:00.000Z"],
      ["2027-03-10T14:00:00.000Z", "2027-03-10T16:00:00.000Z"],
    ]);
    // a gap of one millisecond keeps two blocks
    expect(mergeIntervals([
      { startsAt: d("2027-03-10T09:00:00.000Z"), endsAt: d("2027-03-10T10:00:00.000Z") },
      { startsAt: d("2027-03-10T10:00:00.001Z"), endsAt: d("2027-03-10T11:00:00.000Z") },
    ])).toHaveLength(2);
  });

  it("mergeIntervals does not mutate its input", () => {
    const a = { startsAt: d("2027-03-10T09:00:00Z"), endsAt: d("2027-03-10T10:00:00Z") };
    const b = { startsAt: d("2027-03-10T09:30:00Z"), endsAt: d("2027-03-10T11:00:00Z") };
    mergeIntervals([a, b]);
    expect(a.endsAt.toISOString()).toBe("2027-03-10T10:00:00.000Z");
  });
});

// ── DW-10c · the `department` visibility (BFF §59.3) ──────────────────────────────────────────────────────────────
describe("the department visibility: parsing and the patch plan (§59.3)", () => {
  it("`department` is one of the three visibilities, and `attendees` and `company` are still there", () => {
    expect([...VISIBILITIES]).toEqual(["attendees", "company", "department"]);
  });

  it("create: `department` needs `unitNodeId`; any other visibility refuses one; a null or absent unit on a non-department event is fine", () => {
    const ok = parseCreate({ ...timed, visibility: "department", unitNodeId: "d-web" });
    expect(ok).toMatchObject({ visibility: "department", unitNodeId: "d-web" });
    expect(reasonOf(() => parseCreate({ ...timed, visibility: "department" }))).toBe("unit_required");
    expect(reasonOf(() => parseCreate({ ...timed, visibility: "department", unitNodeId: null }))).toBe("unit_required");
    expect(reasonOf(() => parseCreate({ ...timed, visibility: "company", unitNodeId: "d-web" }))).toBe("unit_not_allowed");
    expect(reasonOf(() => parseCreate({ ...timed, unitNodeId: "d-web" }))).toBe("unit_not_allowed"); // the default visibility is attendees
    expect(parseCreate({ ...timed, visibility: "company", unitNodeId: null }).unitNodeId).toBeNull();
    expect(parseCreate({ ...timed }).unitNodeId).toBeNull();
    expect(refusal(() => parseCreate({ ...timed, visibility: "department" })).field).toBe("unitNodeId");
  });

  it("the unit id is shaped like an id: 1 to 200 characters, a string, no control character", () => {
    for (const bad of [123, "", "x".repeat(UNIT_NODE_ID_MAX + 1), "a\nb", "a\u0000b", "a\u007fb", {}, ["d-web"]]) {
      expect(isUnitNodeIdShaped(bad), JSON.stringify(bad)).toBe(false);
      expect(reasonOf(() => parseCreate({ ...timed, visibility: "department", unitNodeId: bad }))).toBe("unit_invalid");
    }
    expect(isUnitNodeIdShaped("d-web")).toBe(true);
    expect(isUnitNodeIdShaped("x".repeat(UNIT_NODE_ID_MAX))).toBe(true);
    expect(isUnitNodeIdShaped("0190a000-0000-7000-8000-000000000001")).toBe(true);
  });

  it("departmentFactsOf reads ONLY visibility and the unit, tolerates any body, and names no unit for a non-department or a malformed one", () => {
    expect(departmentFactsOf({ visibility: "department", unitNodeId: "d-web", title: "" })).toEqual({ visibilityGiven: true, department: true, unitNodeId: "d-web", unitGiven: true });
    expect(departmentFactsOf({ visibility: "company", unitNodeId: "d-web" })).toEqual({ visibilityGiven: true, department: false, unitNodeId: "d-web", unitGiven: true });
    expect(departmentFactsOf({ unitNodeId: "d-web" })).toMatchObject({ visibilityGiven: false, department: false, unitGiven: true });
    expect(departmentFactsOf({ visibility: "department", unitNodeId: 5 })).toMatchObject({ department: true, unitNodeId: null, unitGiven: true });
    expect(departmentFactsOf({ visibility: "department" })).toMatchObject({ department: true, unitNodeId: null, unitGiven: false });
    for (const body of [null, undefined, "x", 7, [], [{ visibility: "department" }]]) {
      expect(departmentFactsOf(body), JSON.stringify(body)).toEqual({ visibilityGiven: false, department: false, unitNodeId: null, unitGiven: false });
    }
  });

  it("parsePatch carries the unit (a string, or null to clear), and refuses a malformed one", () => {
    expect(parsePatch({ visibility: "department", unitNodeId: "d-web" })).toEqual({ visibility: "department", unitNodeId: "d-web" });
    expect(parsePatch({ visibility: "company", unitNodeId: null })).toEqual({ visibility: "company", unitNodeId: null });
    expect(reasonOf(() => parsePatch({ unitNodeId: 9 }))).toBe("unit_invalid");
    expect(reasonOf(() => parsePatch({ unitNodeId: "" }))).toBe("unit_invalid");
  });

  it("planPatch: the unit follows the visibility; leaving `department` clears it, entering it needs one, and a stray unit is refused", () => {
    const base = facts();
    const dept = facts({ visibility: "department", unitNodeId: "d-web" });
    // attendees -> department with a unit
    const into = planPatch(base, { visibility: "department", unitNodeId: "d-web" });
    expect(into).toMatchObject({ visibility: "department", unitNodeId: "d-web" });
    expect(into.changed).toEqual(expect.arrayContaining(["visibility", "unitNodeId"]));
    // attendees -> department without one
    expect(reasonOf(() => planPatch(base, { visibility: "department" }))).toBe("unit_required");
    // a department event keeps its unit when the patch leaves it alone, and moves it when the patch names another
    expect(planPatch(dept, { title: "Renamed" })).toMatchObject({ visibility: "department", unitNodeId: "d-web", changed: ["title"] });
    expect(planPatch(dept, { unitNodeId: "dv-fe" })).toMatchObject({ unitNodeId: "dv-fe", changed: ["unitNodeId"] });
    // department -> company clears the unit (no explicit null needed)
    const out = planPatch(dept, { visibility: "company" });
    expect(out).toMatchObject({ visibility: "company", unitNodeId: null });
    expect(out.changed).toEqual(expect.arrayContaining(["visibility", "unitNodeId"]));
    // department -> department with the unit cleared is a refusal, not a silent keep
    expect(reasonOf(() => planPatch(dept, { unitNodeId: null }))).toBe("unit_required");
    // a unit on a non-department event
    expect(reasonOf(() => planPatch(base, { unitNodeId: "d-web" }))).toBe("unit_not_allowed");
    expect(reasonOf(() => planPatch(facts({ visibility: "company" }), { unitNodeId: "d-web" }))).toBe("unit_not_allowed");
    // an explicit null on a non-department event is a no-op, not an error
    expect(planPatch(base, { unitNodeId: null })).toMatchObject({ unitNodeId: null, changed: [] });
  });
});
