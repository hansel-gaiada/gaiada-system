import { describe, it, expect } from "vitest";
import { calendarEventsDemo } from "./demoCalendarEvents";
import { todayIsoInDisplayZone } from "./format";
import { windowForDays } from "./zoneTime";

// The demo store answers the endpoints the UI consumes (BFF §47.3). It is a fixture, so these pin only the rules the
// UI depends on.
const call = (method: string, p: string, user: string, body?: unknown, q = "") =>
  calendarEventsDemo(method, p, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body), user);

const today = todayIsoInDisplayZone();
const w = windowForDays(today, today);
const mine = (user: string, scope = "all") => call("GET", "/api/calendar/events/mine", user, undefined, `from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}&scope=${scope}`);

describe("demoCalendarEvents", () => {
  it("answers `mine` in the envelope, with today's seeded events for an attendee", () => {
    const r = mine("demo-hansel");
    expect(r?.status).toBe(200);
    const json = r?.json as { items: { title: string; href: string }[]; companies: { included: boolean }[] };
    expect(json.items.map((i) => i.title)).toEqual(expect.arrayContaining(["Team standup", "Northwind check-in"]));
    expect(json.items[0].href).toMatch(/^\/calendar\/events\/.+\?company=co-/);
    expect(json.companies.every((c) => c.included)).toBe(true);
  });

  it("refuses a window over 92 days with 400", () => {
    const r = call("GET", "/api/calendar/events/mine", "demo-hansel", undefined, "from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z");
    expect(r?.status).toBe(400);
  });

  it("returns nothing for someone with no events, and 404 (not 403) for an event they cannot read", () => {
    expect((mine("seo-staff")?.json as { items: unknown[] }).items).toEqual([]);
    const id = ((mine("demo-hansel")?.json as { items: { id: string }[] }).items[0]).id;
    expect(call("GET", `/api/co-agency/calendar/events/${id}`, "seo-staff")?.status).toBe(404);
  });

  it("canEdit and canRespond follow the caller, and a cancelled event offers neither", () => {
    const items = (mine("gede-ic")?.json as { items: { id: string; title: string }[] }).items;
    const standup = items.find((i) => i.title === "Team standup") as { id: string };
    const d = call("GET", `/api/co-agency/calendar/events/${standup.id}`, "gede-ic")?.json as { canEdit: boolean; canRespond: boolean };
    expect(d).toMatchObject({ canEdit: false, canRespond: true });
    const org = call("GET", `/api/co-agency/calendar/events/${standup.id}`, "demo-hansel")?.json as { canEdit: boolean };
    expect(org.canEdit).toBe(true);
  });

  it("creates, answers, cancels (idempotently), and then refuses an answer with 409", () => {
    const made = call("POST", "/api/co-agency/calendar/events", "demo-hansel", {
      title: "Demo made", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), attendeeIds: ["gede-ic"], visibility: "attendees",
    });
    expect(made?.status).toBe(201);
    const id = (made?.json as { id: string }).id;
    expect(call("POST", `/api/co-agency/calendar/events/${id}/respond`, "gede-ic", { response: "accepted" })?.status).toBe(200);
    expect(call("POST", `/api/co-agency/calendar/events/${id}/cancel`, "demo-hansel")?.status).toBe(200);
    expect(call("POST", `/api/co-agency/calendar/events/${id}/cancel`, "demo-hansel")?.status).toBe(200);
    const late = call("POST", `/api/co-agency/calendar/events/${id}/respond`, "gede-ic", { response: "declined" });
    expect(late?.status).toBe(409);
    expect(late?.json).toMatchObject({ reason: "event_cancelled" });
  });

  it("422 attendee_not_member carries the person in detail.userId", () => {
    const r = call("POST", "/api/co-agency/calendar/events", "demo-hansel", {
      title: "x", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), attendeeIds: ["u-finance"],
    });
    expect(r?.status).toBe(422);
    expect(r?.json).toMatchObject({ reason: "attendee_not_member", detail: { userId: "u-finance" } });
  });

  it("a time change puts the answers back to needs_action", () => {
    const made = call("POST", "/api/co-agency/calendar/events", "demo-hansel", {
      title: "Move me", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), attendeeIds: ["gede-ic"],
    });
    const id = (made?.json as { id: string }).id;
    call("POST", `/api/co-agency/calendar/events/${id}/respond`, "gede-ic", { response: "accepted" });
    const moved = call("PATCH", `/api/co-agency/calendar/events/${id}`, "demo-hansel", {
      startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    });
    const att = (moved?.json as { attendees: { userId: string; response: string }[] }).attendees;
    expect(att.find((a) => a.userId === "gede-ic")?.response).toBe("needs_action");
    expect(att.find((a) => a.userId === "demo-hansel")?.response).toBe("accepted");
  });

  it("does not claim paths that are not events", () => {
    expect(call("GET", "/api/co-agency/meetings/recordings", "demo-hansel")).toBeNull();
  });
});

describe("demoCalendarEvents: busy times (§47.4)", () => {
  const busy = (user: string, q: string, tenant = "co-agency") => call("GET", `/api/${tenant}/calendar/busy`, user, undefined, q);
  const win = `from=${encodeURIComponent(w.from)}&to=${encodeURIComponent(w.to)}`;

  it("answers one entry per person in the order asked, times only: today's seeded events show, a declined one does not", () => {
    const r = busy("demo-hansel", `userIds=u-pm,demo-hansel,u-dev&${win}`);
    expect(r?.status).toBe(200);
    const json = r?.json as { busy: { userId: string; intervals: Record<string, string>[] }[] };
    expect(json.busy.map((b) => b.userId)).toEqual(["u-pm", "demo-hansel", "u-dev"]);
    // u-pm: the standup 10:00-10:45 and the Northwind check-in 15:00-16:00 today
    expect(json.busy[0].intervals).toHaveLength(2);
    for (const b of json.busy) for (const i of b.intervals) expect(Object.keys(i).sort()).toEqual(["endsAt", "startsAt"]);
    expect(JSON.stringify(json)).not.toMatch(/Team standup|Northwind check-in|title|location/);
  });

  it("refuses a non-member (422), a bad list (400), a long window (400) and an outsider caller (403)", () => {
    expect(busy("demo-hansel", `userIds=u-finance&${win}`)?.status).toBe(422);
    expect(busy("demo-hansel", `userIds=&${win}`)?.status).toBe(400);
    expect(busy("demo-hansel", "userIds=u-pm&from=2026-10-01T00:00:00Z&to=2026-10-20T00:00:00Z")?.status).toBe(400);
    expect(busy("u-finance", `userIds=u-pm&${win}`)?.status).toBe(403);
  });

  it("excludeEventId drops that event", () => {
    const items = (mine("demo-hansel")?.json as { items: { id: string; title: string }[] }).items;
    const standup = items.find((i) => i.title === "Team standup") as { id: string };
    const all = (busy("demo-hansel", `userIds=gede-ic&${win}`)?.json as { busy: { intervals: unknown[] }[] }).busy[0].intervals;
    const without = (busy("demo-hansel", `userIds=gede-ic&${win}&excludeEventId=${standup.id}`)?.json as { busy: { intervals: unknown[] }[] }).busy[0].intervals;
    expect(without.length).toBe(all.length - 1);
  });
});

describe("demoCalendarEvents: the `department` visibility (BFF section 59.3)", () => {
  const D = "/api/co-agency/calendar/events";
  const dept = (extra: Record<string, unknown> = {}) => ({
    title: "Web Dev planning", startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    attendeeIds: [], visibility: "department", unitNodeId: "dept-1", ...extra,
  });
  const make = (user: string, body: Record<string, unknown>) => call("POST", D, user, body);
  const idOf = (r: ReturnType<typeof call>) => (r?.json as { id: string }).id;
  const get = (user: string, id: string) => call("GET", `${D}/${id}`, user);

  it("creates one for a unit the caller is placed in or leads, and the detail names the unit", () => {
    for (const user of ["u-dev", "u-webhead"]) {
      const r = make(user, dept());
      expect(r?.status, user).toBe(201);
      expect(r?.json).toMatchObject({ visibility: "department", unitNodeId: "dept-1" });
    }
  });

  it("is read by the unit's people, its head and the company-wide roles, and is a 404 (never a 403) for a sibling department", () => {
    const id = idOf(make("u-webhead", dept()));
    for (const user of ["u-dev", "u-pm", "u-webhead", "demo-hansel", "demo-owner", "u-hr"]) expect(get(user, id)?.status, user).toBe(200);
    for (const user of ["seo-staff", "u-seo", "dept-manager", "u-creative"]) expect(get(user, id)?.status, user).toBe(404);
  });

  it("canEdit follows the organizer and the admin, not the unit's people", () => {
    const id = idOf(make("u-webhead", dept()));
    expect(get("u-dev", id)?.json).toMatchObject({ canEdit: false, canCancel: false, canRespond: false });
    expect(get("u-webhead", id)?.json).toMatchObject({ canEdit: true });
  });

  it("is on the personal list of the unit's people and its head, not on a sibling's and not on a company-wide caller's", () => {
    const id = idOf(make("u-webhead", dept({ title: "Listed for Web Dev" })));
    // The event is tomorrow, so ask for a window that holds it.
    const wide = (user: string) => (call("GET", "/api/calendar/events/mine", user, undefined, `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 5 * 86_400_000).toISOString())}`)?.json as { items: { id: string }[] }).items.some((i) => i.id === id);
    expect(wide("u-dev")).toBe(true);
    expect(wide("u-webhead")).toBe(true);
    expect(wide("seo-staff")).toBe(false);
    expect(wide("demo-hansel")).toBe(false);
  });

  it("refuses a unit the caller is not in with 403 `outside your reporting line`, BEFORE any other field is read (an invalid body is still 403)", () => {
    const r = make("u-dev", dept({ unitNodeId: "dept-3" }));
    expect(r).toEqual({ status: 403, json: { error: "outside your reporting line", reason: "outside your reporting line", field: "unitNodeId" } });
    expect(make("u-dev", { visibility: "department", unitNodeId: "dept-3", title: 5, startsAt: "garbage" })?.status).toBe(403);
    expect(make("seo-staff", dept())?.status).toBe(403);
  });

  it("lets a company-wide caller make one for any unit, but refuses the root and an unknown unit with 404 `unit_not_found`", () => {
    expect(make("demo-hansel", dept({ unitNodeId: "dept-3" }))?.status).toBe(201);
    expect(make("demo-hansel", dept({ unitNodeId: "root" }))).toMatchObject({ status: 404, json: { reason: "unit_not_found", field: "unitNodeId" } });
    expect(make("demo-hansel", dept({ unitNodeId: "no-such-unit" }))).toMatchObject({ status: 404, json: { reason: "unit_not_found" } });
  });

  it("needs a unit with `department` (400 unit_required), allows none on another visibility (400 unit_not_allowed), and refuses a malformed one (400 unit_invalid)", () => {
    const { unitNodeId, ...noUnit } = dept();
    void unitNodeId;
    expect(make("u-dev", noUnit)).toMatchObject({ status: 400, json: { reason: "unit_required", field: "unitNodeId" } });
    expect(make("u-dev", dept({ visibility: "company" }))).toMatchObject({ status: 400, json: { reason: "unit_not_allowed", field: "unitNodeId" } });
    expect(make("u-dev", dept({ visibility: "attendees" }))).toMatchObject({ status: 400, json: { reason: "unit_not_allowed" } });
    expect(make("demo-hansel", dept({ unitNodeId: "" }))).toMatchObject({ status: 400, json: { reason: "unit_invalid" } });
    expect(make("demo-hansel", dept({ unitNodeId: 7 }))).toMatchObject({ status: 400, json: { reason: "unit_invalid" } });
  });

  it("still makes attendee-only and company events with no unit (the CHECK keeps both working)", () => {
    for (const visibility of ["attendees", "company"]) {
      const r = make("u-dev", dept({ visibility, unitNodeId: undefined }));
      expect(r?.status, visibility).toBe(201);
      expect(r?.json).toMatchObject({ visibility, unitNodeId: null });
    }
  });

  it("follows the unit on an edit: moving off `department` clears it, moving to it needs one, and an unrelated edit never re-checks the unit", () => {
    const id = idOf(make("u-webhead", dept()));
    // An unrelated edit by the organizer (who stays in the unit): fine, and the unit stays.
    expect(call("PATCH", `${D}/${id}`, "u-webhead", { title: "Renamed" })?.json).toMatchObject({ title: "Renamed", visibility: "department", unitNodeId: "dept-1" });
    // Off `department`: the unit is cleared with no explicit null.
    expect(call("PATCH", `${D}/${id}`, "u-webhead", { visibility: "company" })?.json).toMatchObject({ visibility: "company", unitNodeId: null });
    // Back to it: a unit is needed.
    expect(call("PATCH", `${D}/${id}`, "u-webhead", { visibility: "department" })).toMatchObject({ status: 400, json: { reason: "unit_required" } });
    expect(call("PATCH", `${D}/${id}`, "u-webhead", { visibility: "department", unitNodeId: "dept-1" })?.json).toMatchObject({ visibility: "department", unitNodeId: "dept-1" });
  });

  it("narrows an edit that MOVES the event to another unit, and not one that keeps the unit", () => {
    const id = idOf(make("u-webhead", dept()));
    const moved = call("PATCH", `${D}/${id}`, "u-webhead", { visibility: "department", unitNodeId: "dept-3" });
    expect(moved).toMatchObject({ status: 403, json: { reason: "outside your reporting line" } });
    // Naming the unit it already has is not a move.
    expect(call("PATCH", `${D}/${id}`, "u-webhead", { visibility: "department", unitNodeId: "dept-1", title: "Same unit" })?.status).toBe(200);
  });
});
