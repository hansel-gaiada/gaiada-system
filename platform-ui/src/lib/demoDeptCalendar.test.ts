import { describe, it, expect } from "vitest";
import { deptCalendarDemo } from "./demoDeptCalendar";
import { calendarEventsDemo, demoMonthDay } from "./demoCalendarEvents";
import { todayIsoInDisplayZone } from "./format";
import { monthWindow, shiftMonth, asDeptCalendar, type DeptCalendar } from "./deptCalendar";

// DW-10c-3 (BFF section 59.1): the demo store answers the department calendar in the server's order of checks, and holds what must never reach
// the answer so that the rules are proved by data.
const month = todayIsoInDisplayZone().slice(0, 7);
const W = monthWindow(month);
const call = (tenant: string, unit: string, user: string, q: Record<string, string> = W) =>
  deptCalendarDemo("GET", `/api/${tenant}/departments/${unit}/calendar`, new URLSearchParams(q), user);
const read = (tenant: string, unit: string, user: string, q?: Record<string, string>): DeptCalendar => {
  const r = call(tenant, unit, user, q);
  expect(r?.status).toBe(200);
  return asDeptCalendar(r?.json);
};
const items = <T,>(leg: { included: boolean; items?: T[] }): T[] => { expect(leg.included).toBe(true); return leg.items ?? []; };

describe("the gate, in the server's order", () => {
  it("answers only its own route", () => {
    expect(deptCalendarDemo("GET", "/api/co-agency/departments/dept-1", new URLSearchParams(W), "u-dev")).toBeNull();
    expect(deptCalendarDemo("POST", "/api/co-agency/departments/dept-1/calendar", new URLSearchParams(W), "u-dev")).toBeNull();
  });

  it("lets a person placed in the unit, its head and the company-wide roles read it", () => {
    for (const user of ["u-dev", "u-webhead", "demo-hansel", "demo-owner", "u-hr"]) expect(call("co-agency", "dept-1", user)?.status, user).toBe(200);
  });

  it("refuses a person of a sibling department with 403 `outside your reporting line`, BEFORE any word on whether the unit exists", () => {
    for (const user of ["seo-staff", "u-seo", "u-creative", "dept-manager"]) {
      expect(call("co-agency", "dept-1", user), user).toEqual({ status: 403, json: { error: "outside your reporting line" } });
    }
    // The same 403 for a unit that does not exist: the narrowing answers first.
    expect(call("co-agency", "no-such-unit", "u-dev")).toEqual({ status: 403, json: { error: "outside your reporting line" } });
  });

  it("answers 404 `unit_not_found` for an unknown unit to a company-wide caller, and for the root", () => {
    expect(call("co-agency", "no-such-unit", "demo-hansel")).toEqual({ status: 404, json: { error: "unit_not_found", field: "unitNodeId" } });
    expect(call("co-agency", "root", "demo-hansel")?.status).toBe(404);
  });

  it("refuses a client contact with 403, even with a bad window (never 400)", () => {
    expect(call("co-agency", "dept-1", "demo-client")?.status).toBe(403);
    expect(call("co-agency", "dept-1", "demo-client", { from: "nope", to: "x" })?.status).toBe(403);
    expect(call("co-agency", "dept-1", "demo-viceroy-marketing")?.status).toBe(403);
  });

  it("refuses a company the demo does not hold", () => {
    expect(call("co-other", "dept-1", "demo-hansel")?.status).toBe(403);
  });

  it("checks the window: real days, `to` not before `from`, at most 42 days counting both ends, naming the field", () => {
    const bad = (q: Record<string, string>) => call("co-agency", "dept-1", "demo-hansel", q);
    expect(bad({ to: "2026-10-31" })).toMatchObject({ status: 400, json: { field: "from" } });
    expect(bad({ from: "2026-10-01" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(bad({ from: "2026-02-30", to: "2026-03-05" })).toMatchObject({ status: 400, json: { field: "from" } });
    expect(bad({ from: "2026-10-05", to: "2026-10-04" })).toMatchObject({ status: 400, json: { field: "to" } });
    // 42 days is the longest; 43 is refused on `to`.
    expect(bad({ from: "2026-09-28", to: "2026-11-08" })?.status).toBe(200);
    expect(bad({ from: "2026-09-28", to: "2026-11-09" })).toMatchObject({ status: 400, json: { field: "to" } });
    expect(bad({ from: "2026-10-05", to: "2026-10-05" })?.status).toBe(200);
  });

  it("checks the window before the narrowing: a bad window is 400 even outside the reporting line", () => {
    expect(call("co-agency", "dept-1", "seo-staff", { from: "2026-10-05", to: "2026-10-04" })?.status).toBe(400);
  });

  it("refuses a malformed unit id with 400 naming unitNodeId", () => {
    expect(call("co-agency", "x".repeat(201), "demo-hansel")).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
    expect(call("co-agency", "d%01x", "demo-hansel")).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
  });
});

describe("Web Dev's four legs", () => {
  it("holds the demo holiday for the month, and none from another month", () => {
    const r = read("co-agency", "dept-1", "u-dev");
    expect(r.unit).toEqual({ id: "dept-1", name: "Web Dev" });
    expect(items(r.holidays).map((h) => [h.day, h.name, h.kind])).toEqual([[demoMonthDay(9), "Nyepi (Day of Silence)", "public"]]);
  });

  it("holds two away colleagues with their leave types, by date, and exactly the five fields", () => {
    const r = read("co-agency", "dept-1", "u-dev");
    const away = items(r.away);
    expect(away.map((a) => [a.name, a.leaveType, a.startsOn, a.endsOn])).toEqual([
      ["Andre Wijaya", "vacation", demoMonthDay(13), demoMonthDay(15)],
      ["Sari Dewi", "sick", demoMonthDay(20), demoMonthDay(20)],
    ]);
    for (const a of away) expect(Object.keys(a).sort()).toEqual(["endsOn", "leaveType", "name", "startsOn", "userId"]);
  });

  it("never carries the note, the minutes, the status or the approver on the wire", () => {
    const body = JSON.stringify(call("co-agency", "dept-1", "u-dev")?.json);
    expect(body).not.toMatch(/Family trip|Dentist|Wedding|Retreat|minutes|"note"|"status"|approv/i);
  });

  it("leaves out leave that is pending, and leave of a person placed in another unit", () => {
    const names = items(read("co-agency", "dept-1", "u-dev").away).map((a) => a.name);
    expect(names).not.toContain("Dewi Santoso"); // pending
    expect(names).not.toContain("Luh Ayu"); // placed in SEO, approved
    expect(items(read("co-agency", "dept-3", "u-seo").away).map((a) => a.name)).toEqual(["Luh Ayu"]);
  });

  it("holds a milestone of a Web Dev project, and not a done one nor another unit's", () => {
    const d = items(read("co-agency", "dept-1", "u-dev").deadlines);
    expect(d).toEqual([{ milestoneId: "m-web-2", name: "Staging sign-off", dueDate: demoMonthDay(21), projectId: "p-web-1", projectName: "Client site redesign" }]);
    expect(items(read("co-agency", "dept-3", "demo-hansel").deadlines).map((x) => x.name)).toEqual(["Audit delivered"]);
  });

  it("holds the department event and the company events, in date order, and not another unit's department event", () => {
    const e = items(read("co-agency", "dept-1", "u-dev").events);
    const mine = e.filter((x) => ["Web Dev sprint review", "Gaia all-hands"].includes(x.title));
    expect(mine.map((x) => [x.title, x.visibility, x.unitNodeId])).toEqual([["Web Dev sprint review", "department", "dept-1"], ["Gaia all-hands", "company", null]]);
    expect(e.map((x) => x.title)).not.toContain("SEO ranking review");
    // Every item is a department event for THIS unit or a company-visible one: nothing attendee-only.
    for (const x of e) expect(x.visibility === "company" || x.unitNodeId === "dept-1", x.title).toBe(true);
    const seo = items(read("co-agency", "dept-3", "seo-staff").events).map((x) => x.title);
    expect(seo).toContain("SEO ranking review");
    expect(seo).not.toContain("Web Dev sprint review");
  });

  it("changes with the month: the next month holds its own holiday and event, and none of this month's", () => {
    const next = monthWindow(shiftMonth(month, 1));
    const r = read("co-agency", "dept-1", "u-dev", next);
    expect(items(r.holidays).map((h) => h.name)).toEqual(["Galungan"]);
    expect(items(r.events).map((x) => x.title)).toEqual(["Web Dev retro"]);
    expect(items(r.away)).toEqual([]);
    expect(items(r.deadlines)).toEqual([]);
  });

  it("answers an included, empty leg for a window with nothing in it (a read that succeeded)", () => {
    const far = monthWindow(shiftMonth(month, 9));
    const r = read("co-agency", "dept-1", "u-dev", far);
    for (const leg of [r.holidays, r.away, r.deadlines, r.events]) expect(leg).toEqual({ included: true, items: [] });
  });

  it("shows a department event made on the schedule form, and only to the unit's people", () => {
    const made = calendarEventsDemo("POST", "/api/co-agency/calendar/events", new URLSearchParams(), JSON.stringify({
      title: "Demo made for Web Dev", startsOn: demoMonthDay(25), endsOn: demoMonthDay(25), allDay: true, attendeeIds: [], visibility: "department", unitNodeId: "dept-1",
    }), "u-webhead");
    expect(made?.status).toBe(201);
    const id = (made?.json as { id: string }).id;
    expect(items(read("co-agency", "dept-1", "u-dev").events).map((x) => x.id)).toContain(id);
    expect(items(read("co-agency", "dept-3", "seo-staff").events).map((x) => x.id)).not.toContain(id);
    calendarEventsDemo("POST", `/api/co-agency/calendar/events/${id}/cancel`, new URLSearchParams(), undefined, "u-webhead");
    expect(items(read("co-agency", "dept-1", "u-dev").events).map((x) => x.id)).not.toContain(id);
  });
});

describe("the HR module off (Viceroy)", () => {
  it("answers holidays and away as module_off, not as empty, while the other two legs are read and empty", () => {
    const r = read("co-resort", "hosp-dept-1", "u-resort");
    expect(r.unit).toEqual({ id: "hosp-dept-1", name: "Front Office" });
    expect(r.holidays).toEqual({ included: false, reason: "module_off" });
    expect(r.away).toEqual({ included: false, reason: "module_off" });
    expect(r.deadlines).toEqual({ included: true, items: [] });
    expect(r.events).toEqual({ included: true, items: [] });
  });

  it("holds the same gate: a person placed there and a company-wide caller read it, a stranger does not", () => {
    expect(call("co-resort", "hosp-dept-1", "demo-hansel")?.status).toBe(200);
    expect(call("co-resort", "hosp-dept-1", "u-dev")?.status).toBe(403);
    expect(call("co-resort", "hosp-dept-9", "demo-hansel")?.status).toBe(404);
  });
});
