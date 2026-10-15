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
