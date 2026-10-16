import { describe, it, expect } from "vitest";
import {
  busyClashes, busyDayWindow, busyText, defaultFormInput, describeWhen, eventButtons, eventErrorText, eventToCalItems, formInputOf, gridDays, mergeCalItems,
  todayEventsOf, validateEventForm,
  type CalendarEventDetail, type CalendarEventRow, type EventFormInput,
} from "./calendarEvents";
import { counts, type CalItem } from "./calendar";

const SG = "Asia/Singapore";

const row = (id: string, extra: Partial<CalendarEventRow> = {}): CalendarEventRow => ({
  id, tenantId: "co-a", company: "Agency", title: `Event ${id}`,
  startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z", allDay: false, startsOn: null, endsOn: null,
  location: null, videoUrl: null, status: "confirmed", myResponse: "accepted", organizer: { id: "u1", name: "Dewi" }, attendeeCount: 2,
  recording: null, client: null, project: null, href: `/calendar/events/${id}?company=co-a`, ...extra,
});
const task = (id: string, date: string): CalItem => ({ id, title: `Task ${id}`, status: "todo", date, href: `/tasks/${id}` });
const W = { firstDay: "2026-10-12", lastDay: "2026-10-18" };

describe("grid merge: tasks and events in one list", () => {
  it("places a timed event by its start in the display zone, with its time", () => {
    // 02:00Z is 10:00 in Singapore, on the 14th.
    const [it] = eventToCalItems(row("e1"), W, SG);
    expect(it).toMatchObject({ date: "2026-10-14", kind: "event", time: "10:00–11:00", startTime: "10:00", href: "/calendar/events/e1?company=co-a" });
  });

  it("puts an event at 23:30 local on its local day, and one at 00:30 local on the next (the midnight edge)", () => {
    const late = row("late", { startsAt: "2026-10-14T15:30:00.000Z", endsAt: "2026-10-14T15:45:00.000Z" }); // 23:30 SGT
    const early = row("early", { startsAt: "2026-10-14T16:30:00.000Z", endsAt: "2026-10-14T16:45:00.000Z" }); // 00:30 SGT, the 15th
    expect(eventToCalItems(late, W, SG)[0].date).toBe("2026-10-14");
    expect(eventToCalItems(early, W, SG)[0].date).toBe("2026-10-15");
  });

  it("drops a day outside the window, so a long event only fills what the grid draws", () => {
    const long = row("long", { allDay: true, startsAt: null, endsAt: null, startsOn: "2026-10-10", endsOn: "2026-10-20" });
    const days = eventToCalItems(long, W, SG).map((i) => i.date);
    expect(days[0]).toBe("2026-10-12");
    expect(days[days.length - 1]).toBe("2026-10-18");
    expect(days).toHaveLength(7);
  });

  it("an all-day event spans its days, each marked All day", () => {
    const off = row("off", { allDay: true, startsAt: null, endsAt: null, startsOn: "2026-10-15", endsOn: "2026-10-16" });
    const items = eventToCalItems(off, W, SG);
    expect(items.map((i) => [i.date, i.time])).toEqual([["2026-10-15", "All day"], ["2026-10-16", "All day"]]);
    expect(items.every((i) => i.startTime === undefined)).toBe(true);
  });

  it("an overnight event is on both days, 'from' on the first and 'until' on the last", () => {
    const night = row("night", { startsAt: "2026-10-14T14:00:00.000Z", endsAt: "2026-10-14T18:00:00.000Z" }); // 22:00 to 02:00 SGT
    expect(eventToCalItems(night, W, SG).map((i) => [i.date, i.time])).toEqual([["2026-10-14", "from 22:00"], ["2026-10-15", "until 02:00"]]);
  });

  it("marks a cancelled event cancelled and one the caller declined declined; a plain one has no state", () => {
    expect(eventToCalItems(row("c", { status: "cancelled" }), W, SG)[0].state).toBe("cancelled");
    expect(eventToCalItems(row("d", { myResponse: "declined" }), W, SG)[0].state).toBe("declined");
    expect(eventToCalItems(row("p"), W, SG)[0].state).toBeUndefined();
    // Cancelled wins when both are true.
    expect(eventToCalItems(row("cd", { status: "cancelled", myResponse: "declined" }), W, SG)[0].state).toBe("cancelled");
  });

  it("keeps tasks and events together, all-day events first, then timed by start, then tasks, within a day", () => {
    const merged = mergeCalItems(
      [task("t1", "2026-10-14"), task("t0", "2026-10-13")],
      [
        row("b", { startsAt: "2026-10-14T06:00:00.000Z", endsAt: "2026-10-14T07:00:00.000Z" }),
        row("a"),
        row("all", { allDay: true, startsAt: null, endsAt: null, startsOn: "2026-10-14", endsOn: "2026-10-14" }),
      ],
      W, SG,
    );
    expect(merged.map((i) => i.title)).toEqual(["Task t0", "Event all", "Event a", "Event b", "Task t1"]);
  });

  it("leaves the task counts alone: events are not 'assigned to me' tasks", () => {
    const tasks = [task("t1", "2026-10-14")];
    const merged = mergeCalItems(tasks, [row("e1")], W, SG);
    expect(merged).toHaveLength(2);
    expect(counts(tasks, "2026-10-14").total).toBe(1);
  });

  it("gridDays: a month grid is at most 42 days, a week 7, a day 1", () => {
    const m = gridDays("month", "2026-10-14");
    expect(m).toEqual({ firstDay: "2026-09-28", lastDay: "2026-11-01" });
    expect(gridDays("week", "2026-10-14")).toEqual({ firstDay: "2026-10-12", lastDay: "2026-10-18" });
    expect(gridDays("day", "2026-10-14")).toEqual({ firstDay: "2026-10-14", lastDay: "2026-10-14" });
  });
});

describe("the Today list", () => {
  it("lists only today's events, all-day first then by time, and keeps a cancelled one marked", () => {
    const list = todayEventsOf([
      row("b", { startsAt: "2026-10-14T07:00:00.000Z", endsAt: "2026-10-14T08:00:00.000Z" }),
      row("a"),
      row("c", { status: "cancelled", startsAt: "2026-10-14T04:00:00.000Z", endsAt: "2026-10-14T05:00:00.000Z" }),
      row("tomorrow", { startsAt: "2026-10-15T02:00:00.000Z", endsAt: "2026-10-15T03:00:00.000Z" }),
      row("all", { allDay: true, startsAt: null, endsAt: null, startsOn: "2026-10-14", endsOn: "2026-10-14" }),
    ], "2026-10-14", SG);
    expect(list.map((e) => e.title)).toEqual(["Event all", "Event a", "Event c", "Event b"]);
    expect(list[0].time).toBe("All day");
    expect(list[2]).toMatchObject({ state: "cancelled" });
  });
});

describe("describeWhen", () => {
  const ev = (o: Partial<CalendarEventDetail>) => ({ allDay: false, startsAt: null, endsAt: null, startsOn: null, endsOn: null, ...o });
  it("words a timed event in the display zone", () => {
    expect(describeWhen(ev({ startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z" }), SG)).toBe("Wed, 14 Oct 2026, 10:00–11:00");
  });
  it("words an all-day range", () => {
    expect(describeWhen(ev({ allDay: true, startsOn: "2026-10-15", endsOn: "2026-10-16" }), SG)).toBe("Thu, 15 Oct 2026 to Fri, 16 Oct 2026, all day");
  });
});

const form = (o: Partial<EventFormInput> = {}): EventFormInput => ({ ...defaultFormInput("2026-10-14", "09:12"), title: "Kickoff", ...o });

describe("validateEventForm: the sentences", () => {
  it("defaults to the next whole hour, one hour long", () => {
    expect(defaultFormInput("2026-10-14", "09:12")).toMatchObject({ date: "2026-10-14", startTime: "10:00", endTime: "11:00" });
    // Late in the day it stays on the same date.
    expect(defaultFormInput("2026-10-14", "23:40")).toMatchObject({ startTime: "22:00", endTime: "23:00" });
  });

  it("asks for a title", () => {
    expect(validateEventForm(form({ title: "   " }), "create", SG)).toEqual({ ok: false, field: "title", error: "Give the meeting a title." });
    expect(validateEventForm(form({ title: "x".repeat(201) }), "create", SG)).toMatchObject({ ok: false, field: "title", error: "The title can be at most 200 characters." });
  });

  it("asks for a date and both times", () => {
    expect(validateEventForm(form({ date: "" }), "create", SG)).toMatchObject({ field: "date", error: "Pick a date." });
    expect(validateEventForm(form({ startTime: "" }), "create", SG)).toMatchObject({ field: "startTime", error: "Pick a start time." });
    expect(validateEventForm(form({ endTime: "" }), "create", SG)).toMatchObject({ field: "endTime", error: "Pick an end time." });
  });

  it("refuses an end that is not after the start", () => {
    expect(validateEventForm(form({ startTime: "10:00", endTime: "10:00" }), "create", SG)).toMatchObject({ field: "endTime", error: "The end must be after the start." });
    expect(validateEventForm(form({ startTime: "10:00", endTime: "09:00" }), "create", SG)).toMatchObject({ ok: false, error: "The end must be after the start." });
  });

  it("sends the times as UTC instants computed in the display zone", () => {
    const r = validateEventForm(form({ date: "2026-10-15", startTime: "00:30", endTime: "01:30" }), "create", SG);
    expect(r).toMatchObject({ ok: true, payload: { startsAt: "2026-10-14T16:30:00.000Z", endsAt: "2026-10-14T17:30:00.000Z" } });
  });

  it("checks an all-day event's days", () => {
    expect(validateEventForm(form({ allDay: true, startDate: "" }), "create", SG)).toMatchObject({ field: "startDate", error: "Pick the first day." });
    expect(validateEventForm(form({ allDay: true, endDate: "" }), "create", SG)).toMatchObject({ field: "endDate", error: "Pick the last day." });
    expect(validateEventForm(form({ allDay: true, startDate: "2026-10-16", endDate: "2026-10-15" }), "create", SG))
      .toMatchObject({ field: "endDate", error: "The last day can't be before the first day." });
    const ok = validateEventForm(form({ allDay: true, startDate: "2026-10-15", endDate: "2026-10-16" }), "create", SG);
    expect(ok).toMatchObject({ ok: true, payload: { allDay: true, startsOn: "2026-10-15", endsOn: "2026-10-16" } });
    if (ok.ok) { expect(ok.payload).not.toHaveProperty("startsAt"); }
  });

  it("accepts only an https video link", () => {
    expect(validateEventForm(form({ videoUrl: "http://meet.example.com/x" }), "create", SG)).toMatchObject({ field: "videoUrl", error: "The video link must be a web address starting with https://." });
    expect(validateEventForm(form({ videoUrl: "javascript:alert(1)" }), "create", SG)).toMatchObject({ ok: false, field: "videoUrl" });
    expect(validateEventForm(form({ videoUrl: "meet.example.com" }), "create", SG)).toMatchObject({ ok: false, field: "videoUrl" });
    expect(validateEventForm(form({ videoUrl: "https://meet.example.com/x" }), "create", SG)).toMatchObject({ ok: true, payload: { videoUrl: "https://meet.example.com/x" } });
  });

  it("refuses recording an all-day event, and caps invitees and field lengths", () => {
    expect(validateEventForm(form({ allDay: true, record: true }), "create", SG)).toMatchObject({ field: "record", error: "A recording needs a start time, so it can't be set on an all-day event." });
    expect(validateEventForm(form({ attendeeIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }), "create", SG)).toMatchObject({ field: "attendeeIds", error: "At most 50 people can be invited." });
    expect(validateEventForm(form({ location: "x".repeat(301) }), "create", SG)).toMatchObject({ field: "location" });
    expect(validateEventForm(form({ description: "x".repeat(5001) }), "create", SG)).toMatchObject({ field: "description" });
  });

  it("on create leaves blanks out and carries record; on edit clears a blank place, link, client and project with null and never sends record", () => {
    const c = validateEventForm(form({ record: true }), "create", SG);
    expect(c.ok && c.payload).toMatchObject({ record: true });
    expect(c.ok && "location" in c.payload).toBe(false);
    const e = validateEventForm(form({ record: true }), "edit", SG);
    expect(e.ok && e.payload).toMatchObject({ location: null, videoUrl: null, clientId: null, projectId: null });
    expect(e.ok && "record" in e.payload).toBe(false);
  });

  it("round-trips an event through the edit form's values", () => {
    const detail = {
      title: "Kickoff", allDay: false, startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z", startsOn: null, endsOn: null,
      attendees: [{ userId: "u1", name: "Dewi", response: "accepted" }], location: "Room 2", videoUrl: null, description: "", visibility: "company",
      client: null, project: null,
    } as unknown as CalendarEventDetail;
    expect(formInputOf(detail, SG)).toMatchObject({ title: "Kickoff", date: "2026-10-14", startTime: "10:00", endTime: "11:00", attendeeIds: ["u1"], visibility: "company", location: "Room 2" });
  });
});

describe("eventErrorText: refusals in words", () => {
  const names: Record<string, string> = { u9: "Made Putra" };
  const text = (status: number, reason?: string, detail?: Record<string, unknown>, kind?: "create" | "change" | "respond") =>
    eventErrorText({ status, reason, detail }, (id) => names[id], kind);

  it("422 names the person when the id is in the members list", () => {
    expect(text(422, "attendee_not_member", { userId: "u9" })).toBe("Made Putra isn't an active member of this company, so they can't be invited.");
  });
  it("422 without a known person still says what happened", () => {
    expect(text(422, "attendee_not_member", { userId: "zz" })).toMatch(/One of the people you picked isn't an active member/);
    expect(text(422, "attendee_not_member")).toMatch(/One of the people you picked/);
  });
  it("404 is the one sentence for 'no such event' and 'not yours to read'", () => {
    expect(text(404, "not_found")).toBe("This event doesn't exist or isn't visible to you.");
  });
  it("409 tells a cancelled event from a stale one", () => {
    expect(text(409, "event_cancelled")).toMatch(/was cancelled/);
    expect(text(409, "recording_needs_timed_event")).toMatch(/needs a start time/);
    expect(text(409, "something_else")).toMatch(/changed while you were looking/);
  });
  it("403 depends on what was attempted", () => {
    expect(text(403, "forbidden", undefined, "create")).toBe("You can't schedule meetings in this company.");
    expect(text(403, "forbidden", undefined, "respond")).toMatch(/Only the people invited/);
    expect(text(403, "forbidden")).toMatch(/organizer or a company admin/);
  });
  it("400 words the machine code", () => {
    expect(text(400, "video_url_invalid")).toMatch(/https:\/\//);
    expect(text(400, "time_span_too_long")).toMatch(/14 days/);
    expect(text(400, "attendees_too_many")).toMatch(/50/);
    expect(text(400, "link_invalid")).toMatch(/client or project/);
    expect(text(400, "weird_code")).toBe("Check the details and try again.");
  });
});

describe("eventButtons: Cerbos's answer is the only input", () => {
  const caps = (o: Partial<Pick<CalendarEventDetail, "canEdit" | "canCancel" | "canRespond" | "status">>) =>
    ({ canEdit: false, canCancel: false, canRespond: false, status: "confirmed" as const, ...o });
  it("shows what the backend allows and nothing more", () => {
    expect(eventButtons(caps({}))).toEqual({ respond: false, edit: false, cancel: false });
    expect(eventButtons(caps({ canRespond: true }))).toEqual({ respond: true, edit: false, cancel: false });
    expect(eventButtons(caps({ canEdit: true, canCancel: true, canRespond: true }))).toEqual({ respond: true, edit: true, cancel: true });
  });
  it("shows nothing on a cancelled event even if the flags say otherwise", () => {
    expect(eventButtons(caps({ status: "cancelled", canEdit: true, canCancel: true, canRespond: true }))).toEqual({ respond: false, edit: false, cancel: false });
  });
});

describe("busy times (§47.4, DW-D28)", () => {
  // The day 2026-10-14 in Singapore (UTC+8) is 2026-10-13T16:00Z to 2026-10-14T16:00Z.
  it("the day window is 00:00 to 24:00 in the zone, as instants", () => {
    expect(busyDayWindow("2026-10-14", SG)).toEqual({ from: "2026-10-13T16:00:00.000Z", to: "2026-10-14T16:00:00.000Z" });
    expect(busyDayWindow("2026-10-14", "UTC")).toEqual({ from: "2026-10-14T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z" });
    expect(busyDayWindow("2026-02-30", SG)).toBeNull();
    expect(busyDayWindow("", SG)).toBeNull();
  });

  it("the times are written in the zone, joined by commas, 'Free' when there are none", () => {
    const iv = [{ startsAt: "2026-10-14T06:00:00.000Z", endsAt: "2026-10-14T07:00:00.000Z" }, { startsAt: "2026-10-14T01:00:00.000Z", endsAt: "2026-10-14T02:30:00.000Z" }];
    expect(busyText(iv, "2026-10-14", SG)).toBe("09:00-10:30, 14:00-15:00");
    expect(busyText(iv, "2026-10-14", "UTC")).toBe("01:00-02:30, 06:00-07:00");
    expect(busyText([], "2026-10-14", SG)).toBe("Free");
    // an interval on another day does not read as busy on this one
    expect(busyText(iv, "2026-10-15", SG)).toBe("Free");
  });

  it("a block that runs in from the day before or out to the next day is cut to the day for display, and ends '24:00', never '00:00'", () => {
    const runsIn = [{ startsAt: "2026-10-13T14:00:00.000Z", endsAt: "2026-10-13T17:30:00.000Z" }]; // 22:00 on the 13th to 01:30 on the 14th
    expect(busyText(runsIn, "2026-10-14", SG)).toBe("00:00-01:30");
    const runsOut = [{ startsAt: "2026-10-14T14:00:00.000Z", endsAt: "2026-10-14T20:00:00.000Z" }]; // 22:00 to 04:00 next day
    expect(busyText(runsOut, "2026-10-14", SG)).toBe("22:00-24:00");
    expect(busyText(runsOut, "2026-10-15", SG)).toBe("00:00-04:00");
    // one that ends exactly at the day's start is not on that day
    expect(busyText([{ startsAt: "2026-10-13T15:00:00.000Z", endsAt: "2026-10-13T16:00:00.000Z" }], "2026-10-14", SG)).toBe("Free");
  });

  it("a clash is an overlap with the chosen start and end; touching is not a clash; a half-typed time never clashes", () => {
    const iv = [{ startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:30:00.000Z" }]; // 10:00-11:30 SG
    expect(busyClashes(iv, "2026-10-14", "11:00", "12:00", SG)).toBe(true);
    expect(busyClashes(iv, "2026-10-14", "09:00", "10:01", SG)).toBe(true);
    expect(busyClashes(iv, "2026-10-14", "10:30", "11:00", SG)).toBe(true);
    expect(busyClashes(iv, "2026-10-14", "11:30", "12:30", SG)).toBe(false);
    expect(busyClashes(iv, "2026-10-14", "09:00", "10:00", SG)).toBe(false);
    expect(busyClashes(iv, "2026-10-14", "11:00", "10:00", SG)).toBe(false);
    expect(busyClashes(iv, "2026-10-14", "", "12:00", SG)).toBe(false);
    expect(busyClashes([], "2026-10-14", "10:00", "11:00", SG)).toBe(false);
  });
});

describe("the `department` visibility (DW-10c-2, BFF section 59.3)", () => {
  it("sends the unit with a department event, on create and on edit", () => {
    const c = validateEventForm(form({ visibility: "department", unitNodeId: "dept-1" }), "create", SG);
    expect(c.ok && c.payload).toMatchObject({ visibility: "department", unitNodeId: "dept-1" });
    const e = validateEventForm(form({ visibility: "department", unitNodeId: "dept-1" }), "edit", SG);
    expect(e.ok && e.payload).toMatchObject({ visibility: "department", unitNodeId: "dept-1" });
  });

  it("asks which department when none is chosen, on the visibility field, before any request", () => {
    expect(validateEventForm(form({ visibility: "department", unitNodeId: "" }), "create", SG)).toEqual({ ok: false, field: "visibility", error: "Choose which department can see it." });
  });

  it("sends NO unit with any other visibility, even a stale one (the server refuses a unit on those: unit_not_allowed)", () => {
    for (const visibility of ["attendees", "company"] as const) {
      const r = validateEventForm(form({ visibility, unitNodeId: "dept-1" }), "create", SG);
      expect(r.ok && "unitNodeId" in r.payload, visibility).toBe(false);
      const edit = validateEventForm(form({ visibility, unitNodeId: "dept-1" }), "edit", SG);
      expect(edit.ok && "unitNodeId" in edit.payload, visibility).toBe(false);
    }
  });

  it("starts a new meeting with no unit, and reads the unit back from a department event for the edit form", () => {
    expect(defaultFormInput("2026-10-14", "09:12").unitNodeId).toBe("");
    const detail = {
      title: "Sprint review", allDay: false, startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z", startsOn: null, endsOn: null,
      attendees: [], location: null, videoUrl: null, description: "", visibility: "department", unitNodeId: "dept-1", client: null, project: null,
    } as unknown as CalendarEventDetail;
    expect(formInputOf(detail, SG)).toMatchObject({ visibility: "department", unitNodeId: "dept-1" });
    expect(formInputOf({ ...detail, visibility: "company", unitNodeId: null }, SG).unitNodeId).toBe("");
  });

  it("words the unit refusals", () => {
    const t = (status: number, reason: string, kind?: "create" | "change") => eventErrorText({ status, reason }, () => undefined, kind);
    expect(t(403, "outside your reporting line", "create")).toBe("You can only share an event with a department you belong to or lead.");
    expect(t(403, "outside your reporting line", "change")).toBe("You can only share an event with a department you belong to or lead.");
    expect(t(400, "unit_required")).toBe("Choose which department can see it.");
    expect(t(400, "unit_not_allowed")).toBe("Only an event shared with a department can name one.");
    expect(t(400, "unit_invalid")).toBe("That department couldn't be read. Choose one from the list.");
    expect(t(404, "unit_not_found")).toBe("That department isn't in this company's structure.");
    // The other 404 and 403 are unchanged.
    expect(t(404, "not_found")).toBe("This event doesn't exist or isn't visible to you.");
    expect(t(403, "forbidden", "create")).toBe("You can't schedule meetings in this company.");
  });
});
