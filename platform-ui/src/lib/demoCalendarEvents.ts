import "server-only";
// TEMP DEMO MODE: stateful in-memory store for calendar events (DW-8g, BFF §47.3), after `demoMeetings.ts`. Module-level
// state lasts for the dev-server process. Active only via DEMO_MODE=1, routed from `demoFixtures.getDemoResponse`, so
// the calendar, the event page, the form and the Overview's Today block all work with no backend. It models the rules the
// UI depends on (404 for an event you cannot read, `canEdit` / `canRespond`, 409 on a cancelled event, 422 for a
// non-member, the answers reset on a time change) and nothing more: no notifications, no recording row.
//
// DW-10c-2 (BFF §59.3): the `department` visibility. A department event names its unit (`unitNodeId`) and is read by the organizer, the
// invited, and the unit's own people, its heads and the company-wide roles (`demoReachesUnit`, the same table as the department notices).
// A write that names `department` is narrowed FIRST (403 `outside your reporting line`, before any other field is read), then
// `unit_required` / `unit_not_allowed` / `unit_invalid` (400) and `unit_not_found` (404, the root included), all with `field: "unitNodeId"`.
import { DISPLAY_TZ, todayIsoInDisplayZone } from "./format";
import { zoneDay, zonedToInstant } from "./zoneTime";
import { DEMO_ORG_ROOT, DEMO_UNIT_NAMES, demoPlacedOrLeads, demoReachesUnit } from "./demoNotices";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
/** A refusal in the backend's shape: `{error, reason}` with the machine code in both. */
const err = (error: string, status = 400, field?: string): DemoResult => ({ status, json: { error, reason: error, ...(field ? { field } : {}) } });

type Resp = "needs_action" | "accepted" | "declined" | "tentative";
interface DemoEvent {
  id: string; tenantId: string; title: string; description: string;
  startsAt: string | null; endsAt: string | null; startsOn: string | null; endsOn: string | null;
  location: string | null; videoUrl: string | null; visibility: "attendees" | "company" | "department"; unitNodeId: string | null; status: "confirmed" | "cancelled";
  cancelledAt: string | null; organizerId: string; attendees: Map<string, Resp>;
  clientId: string | null; projectId: string | null; recording: { id: string; status: string } | null;
  createdAt: string; updatedAt: string;
}

const NAMES: Record<string, string> = {
  "demo-hansel": "Clement Hansel", "gede-ic": "Gede Kusuma", "seo-staff": "Nyoman Ari", "u-pm": "Dewi Santoso", "u-dev": "Made Putra", "u-finance": "Rina Wibawa",
  "u-webhead": "Ketut Arta",
};
const COMPANY_NAMES: Record<string, string> = { "co-holding": "D & A Syrowatka", "co-agency": "Gaia Digital Agency", "co-resort": "Resort Co" };
// Who is a member where (mirrors the MEMBERS fixture in demoFixtures.ts, for the 422 rule).
const MEMBERS: Record<string, string[]> = {
  "co-holding": ["demo-hansel", "u-finance"],
  "co-agency": ["demo-hansel", "gede-ic", "seo-staff", "u-pm", "u-dev", "u-webhead"],
  "co-resort": ["demo-hansel"],
};
const CLIENTS: Record<string, string> = { "cl-1": "Northwind Traders", "cl-2": "Cedar Group" };
const PROJECTS: Record<string, string> = { "p-web-1": "Northwind site redesign", "p-seo-1": "Cedar SEO" };

let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const now = () => new Date().toISOString();
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, time: string) => zonedToInstant(day, time, DISPLAY_TZ) as string;
const pad2 = (n: number) => String(n).padStart(2, "0");
/** A fixed day of the display zone's current month (days 1 to 28 exist in every month), so the department calendar's seed lands in the
 *  month the page opens on whatever today is. */
export const demoMonthDay = (n: number, monthsAhead = 0): string => {
  const [y, m] = todayIsoInDisplayZone().split("-").map(Number);
  const idx = y * 12 + (m - 1) + monthsAhead;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}-${pad2(n)}`;
};

function seed(): DemoEvent[] {
  const today = todayIsoInDisplayZone();
  const mk = (e: Partial<DemoEvent> & Pick<DemoEvent, "title" | "organizerId" | "attendees">): DemoEvent => ({
    id: nid(), tenantId: "co-agency", description: "", startsAt: null, endsAt: null, startsOn: null, endsOn: null, location: null, videoUrl: null,
    visibility: "attendees", unitNodeId: null, status: "confirmed", cancelledAt: null, clientId: null, projectId: null, recording: null, createdAt: now(), updatedAt: now(), ...e,
  });
  return [
    mk({ title: "Team standup", organizerId: "demo-hansel", startsAt: at(today, "10:00"), endsAt: at(today, "10:45"), videoUrl: "https://meet.example.com/standup",
      attendees: new Map<string, Resp>([["demo-hansel", "accepted"], ["gede-ic", "needs_action"], ["u-pm", "accepted"]]) }),
    mk({ title: "Northwind check-in", organizerId: "u-pm", startsAt: at(today, "15:00"), endsAt: at(today, "16:00"), location: "Meeting room 2",
      clientId: "cl-1", projectId: "p-web-1", visibility: "company",
      attendees: new Map<string, Resp>([["u-pm", "accepted"], ["demo-hansel", "needs_action"], ["gede-ic", "accepted"]]) }),
    mk({ title: "Offsite planning day", organizerId: "demo-hansel", startsOn: addDay(today, 1), endsOn: addDay(today, 2),
      attendees: new Map<string, Resp>([["demo-hansel", "accepted"], ["u-pm", "tentative"], ["u-dev", "needs_action"]]) }),
    mk({ title: "Old vendor sync", organizerId: "u-pm", startsAt: at(addDay(today, 2), "11:00"), endsAt: at(addDay(today, 2), "11:30"),
      status: "cancelled", cancelledAt: now(), attendees: new Map<string, Resp>([["u-pm", "accepted"], ["demo-hansel", "accepted"]]) }),
    mk({ title: "Vendor demo", organizerId: "u-dev", startsAt: at(addDay(today, 3), "14:00"), endsAt: at(addDay(today, 3), "15:00"),
      attendees: new Map<string, Resp>([["u-dev", "accepted"], ["demo-hansel", "declined"]]) }),
    // DW-10c: what the department calendar shows (`demoDeptCalendar.ts`), on fixed days of the current month (and one of the next, so the
    // month navigation shows something different). Web Dev's head organizes: a department event for Web Dev and a company-visible one.
    mk({ title: "Web Dev sprint review", organizerId: "u-webhead", startsAt: at(demoMonthDay(11), "14:00"), endsAt: at(demoMonthDay(11), "15:00"),
      visibility: "department", unitNodeId: "dept-1", attendees: new Map<string, Resp>([["u-webhead", "accepted"]]) }),
    mk({ title: "Gaia all-hands", organizerId: "u-webhead", startsAt: at(demoMonthDay(22), "10:00"), endsAt: at(demoMonthDay(22), "11:00"),
      visibility: "company", attendees: new Map<string, Resp>([["u-webhead", "accepted"]]) }),
    mk({ title: "Web Dev retro", organizerId: "u-webhead", startsAt: at(demoMonthDay(9, 1), "16:00"), endsAt: at(demoMonthDay(9, 1), "17:00"),
      visibility: "department", unitNodeId: "dept-1", attendees: new Map<string, Resp>([["u-webhead", "accepted"]]) }),
    // A department event for another unit: Web Dev's people never read it.
    mk({ title: "SEO ranking review", organizerId: "seo-staff", startsAt: at(demoMonthDay(15), "11:00"), endsAt: at(demoMonthDay(15), "12:00"),
      visibility: "department", unitNodeId: "dept-3", attendees: new Map<string, Resp>([["seo-staff", "accepted"]]) }),
  ];
}
const EVENTS: DemoEvent[] = seed();

/** Whether a department event reaches the caller by placement (placed in the unit, leads it, or company-wide). */
const reachesDept = (e: DemoEvent, uid: string) => e.visibility === "department" && e.unitNodeId !== null && demoReachesUnit(uid, e.unitNodeId);
/** The personal list's department branch: placement or lead only (the company-wide tiers READ the event but it is not on their list). */
const listsDept = (e: DemoEvent, uid: string) => e.visibility === "department" && e.unitNodeId !== null && demoPlacedOrLeads(uid, e.unitNodeId);
const canRead = (e: DemoEvent, uid: string) =>
  e.organizerId === uid || e.attendees.has(uid) || (e.visibility === "company" && (MEMBERS[e.tenantId] ?? []).includes(uid)) || reachesDept(e, uid);
const live = (e: DemoEvent) => e.status === "confirmed";
/** The organizer, or the demo's company admin. */
const mayChange = (e: DemoEvent, uid: string) => e.organizerId === uid || uid === "demo-hansel";

function detail(e: DemoEvent, uid: string) {
  const attendees = [...e.attendees.entries()]
    .map(([userId, response]) => ({ userId, name: NAMES[userId] ?? "", response }))
    .sort((a, b) => (a.userId === e.organizerId ? -1 : b.userId === e.organizerId ? 1 : a.name.localeCompare(b.name)));
  return {
    id: e.id, tenantId: e.tenantId, title: e.title, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.startsOn !== null,
    startsOn: e.startsOn, endsOn: e.endsOn, location: e.location, videoUrl: e.videoUrl, visibility: e.visibility, unitNodeId: e.unitNodeId, status: e.status, cancelledAt: e.cancelledAt,
    organizer: { id: e.organizerId, name: NAMES[e.organizerId] ?? "" }, attendees, attendeeCount: attendees.length,
    myResponse: e.attendees.get(uid) ?? null, recording: e.recording,
    client: e.clientId ? { id: e.clientId, name: CLIENTS[e.clientId] ?? "" } : null,
    project: e.projectId ? { id: e.projectId, name: PROJECTS[e.projectId] ?? "" } : null,
    href: `/calendar/events/${e.id}?company=${e.tenantId}`,
    canEdit: live(e) && mayChange(e, uid), canCancel: live(e) && mayChange(e, uid), canRespond: live(e) && e.attendees.has(uid),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

function mineRow(e: DemoEvent, uid: string) {
  const d = detail(e, uid);
  return {
    id: d.id, tenantId: d.tenantId, company: COMPANY_NAMES[d.tenantId] ?? "", title: d.title, startsAt: d.startsAt, endsAt: d.endsAt, allDay: d.allDay,
    startsOn: d.startsOn, endsOn: d.endsOn, location: d.location, videoUrl: d.videoUrl, status: d.status, myResponse: d.myResponse, organizer: d.organizer,
    attendeeCount: d.attendeeCount, recording: d.recording, client: d.client, project: d.project, href: d.href,
  };
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Applies the fields of a create or patch body, checked the way the backend does. Returns a refusal, or null. */
function applyBody(e: DemoEvent, b: Record<string, unknown>, tenant: string): DemoResult | null {
  if (typeof b.title === "string") {
    const t = b.title.trim();
    if (!t || t.length > 200) return err("title_invalid");
    e.title = t;
  }
  if (typeof b.description === "string") e.description = b.description.trim();
  if ("location" in b) e.location = typeof b.location === "string" && b.location.trim() ? b.location.trim() : null;
  if ("videoUrl" in b) {
    const v = typeof b.videoUrl === "string" ? b.videoUrl.trim() : "";
    if (v && !/^https:\/\//i.test(v)) return err("video_url_invalid");
    e.videoUrl = v || null;
  }
  if (b.visibility === "attendees" || b.visibility === "company" || b.visibility === "department") e.visibility = b.visibility;
  if ("clientId" in b) e.clientId = typeof b.clientId === "string" && b.clientId ? b.clientId : null;
  if ("projectId" in b) e.projectId = typeof b.projectId === "string" && b.projectId ? b.projectId : null;
  if (b.allDay === true) {
    if (typeof b.startsOn !== "string" || typeof b.endsOn !== "string") return err("time_shape_invalid");
    if (b.endsOn < b.startsOn) return err("time_range_invalid");
    e.startsAt = null; e.endsAt = null; e.startsOn = b.startsOn; e.endsOn = b.endsOn;
  } else if (b.startsAt !== undefined || b.endsAt !== undefined) {
    const s = Date.parse(String(b.startsAt)), en = Date.parse(String(b.endsAt));
    if (Number.isNaN(s) || Number.isNaN(en)) return err("time_invalid");
    if (en <= s) return err("time_range_invalid");
    if (en - s > 14 * DAY) return err("time_span_too_long");
    e.startsAt = new Date(s).toISOString(); e.endsAt = new Date(en).toISOString(); e.startsOn = null; e.endsOn = null;
  }
  if (Array.isArray(b.attendeeIds)) {
    if (b.attendeeIds.length > 50) return err("attendees_too_many");
    const prev = e.attendees;
    const next = new Map<string, Resp>([[e.organizerId, "accepted"]]);
    for (const id of b.attendeeIds as string[]) {
      if (next.has(id)) continue;
      if (!prev.has(id) && !(MEMBERS[tenant] ?? []).includes(id)) {
        return { status: 422, json: { error: "attendee_not_member", reason: "attendee_not_member", detail: { userId: id } } };
      }
      next.set(id, prev.get(id) ?? "needs_action");
    }
    e.attendees = next;
  }
  return null;
}

// ---- the unit of a department event (BFF §59.3) -------------------------------------------------------------------

/** A unit id the way the server checks its shape: 1 to 200 characters, no control character. */
const wellFormedUnit = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);

/** The unit rules of a create or an edit, in the server's order. The narrowing comes FIRST and reads only `visibility` and a well-formed
 *  `unitNodeId`, so a refused caller gets 403 whatever else the body holds. On an edit it applies only when the edit MOVES the event to
 *  `department` or to another unit. Returns a refusal, or the unit the event ends up with (null for any other visibility). */
function checkUnit(b: Record<string, unknown>, userId: string, existing?: DemoEvent): DemoResult | { unit: string | null } {
  const named = "visibility" in b && b.visibility !== undefined;
  const vis = named ? b.visibility : existing?.visibility ?? "attendees";
  if (b.visibility === "department" && wellFormedUnit(b.unitNodeId)) {
    const moves = !existing || existing.visibility !== "department" || existing.unitNodeId !== b.unitNodeId;
    if (moves && !demoReachesUnit(userId, b.unitNodeId)) return err("outside your reporting line", 403, "unitNodeId");
  }
  if (vis === "department") {
    const unit = "unitNodeId" in b && b.unitNodeId !== undefined ? b.unitNodeId : existing?.unitNodeId ?? null;
    if (unit === null) return err("unit_required", 400, "unitNodeId");
    if (!wellFormedUnit(unit)) return err("unit_invalid", 400, "unitNodeId");
    // The root is refused as the unit of a department event (company-wide is `visibility: company`).
    if (unit === DEMO_ORG_ROOT || !DEMO_UNIT_NAMES[unit]) return err("unit_not_found", 404, "unitNodeId");
    return { unit };
  }
  if ("unitNodeId" in b && b.unitNodeId !== undefined && b.unitNodeId !== null) return err("unit_not_allowed", 400, "unitNodeId");
  return { unit: null };
}

/** A department event is the calendar leg's `events` (BFF §59.1): confirmed, in the window, company-visible or department-visible for the
 *  unit, and readable by the caller. `from` and `to` are display-zone days, both ends counted. */
export function deptCalendarEvents(tenant: string, unit: string, userId: string, from: string, to: string) {
  const overlaps = (e: DemoEvent) => {
    const days = e.startsAt && e.endsAt
      ? { first: zoneDay(e.startsAt), last: zoneDay(Math.max(Date.parse(e.startsAt), Date.parse(e.endsAt) - 1)) }
      : { first: e.startsOn as string, last: e.endsOn as string };
    return days.first <= to && days.last >= from;
  };
  return EVENTS
    .filter((e) => e.tenantId === tenant && live(e) && (e.visibility === "company" || (e.visibility === "department" && e.unitNodeId === unit)) && canRead(e, userId) && overlaps(e))
    .sort((a, b) => (a.startsAt ?? `${a.startsOn}T00:00:00.000Z`).localeCompare(b.startsAt ?? `${b.startsOn}T00:00:00.000Z`) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, startsOn: e.startsOn, endsOn: e.endsOn,
      visibility: e.visibility as "company" | "department", unitNodeId: e.unitNodeId,
    }));
}

export function calendarEventsDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();

  if (p === "/api/calendar/events/mine" && m === "GET") {
    const from = Date.parse(params.get("from") ?? ""), to = Date.parse(params.get("to") ?? "");
    if (Number.isNaN(from) || Number.isNaN(to)) return err("window_required");
    if (to <= from) return err("window_invalid");
    if (to - from > 92 * DAY) return err("window_too_large");
    const scope = params.get("scope") ?? "all";
    const items = EVENTS
      .filter((e) => (scope === "all" || e.tenantId === scope) && (e.organizerId === userId || e.attendees.has(userId) || listsDept(e, userId)))
      .filter((e) => {
        if (e.startsAt && e.endsAt) return Date.parse(e.startsAt) < to && Date.parse(e.endsAt) > from;
        return (e.startsOn as string) <= isoDay(to - 1) && (e.endsOn as string) >= isoDay(from);
      })
      .map((e) => mineRow(e, userId));
    const ids = scope === "all" ? Object.keys(MEMBERS).filter((c) => MEMBERS[c].includes(userId)) : [scope];
    return ok({ items, companies: ids.map((id) => ({ id, name: COMPANY_NAMES[id] ?? "", included: true })) });
  }

  // §47.4 busy times (DW-D28): times only, merged per person, confirmed timed events, declined answers left out.
  const busy = p.match(/^\/api\/([^/]+)\/calendar\/busy$/);
  if (busy && m === "GET") {
    const tenant = busy[1];
    if (!(MEMBERS[tenant] ?? []).includes(userId)) return err("forbidden", 403);
    const ids = (params.get("userIds") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length === 0) return err("user_ids_required");
    if (new Set(ids).size !== ids.length) return err("user_ids_invalid");
    if (ids.length > 20) return err("user_ids_too_many");
    const from = Date.parse(params.get("from") ?? ""), to = Date.parse(params.get("to") ?? "");
    if (Number.isNaN(from) || Number.isNaN(to)) return err("window_required");
    if (to <= from) return err("window_invalid");
    if (to - from > 14 * DAY) return err("window_too_large");
    const outsider = ids.find((id) => !(MEMBERS[tenant] ?? []).includes(id));
    if (outsider) return { status: 422, json: { error: "user_not_member", reason: "user_not_member", detail: { userId: outsider } } };
    const exclude = params.get("excludeEventId");
    return ok({
      busy: ids.map((userId) => {
        const list = EVENTS
          .filter((e) => e.tenantId === tenant && e.id !== exclude && live(e) && e.startsAt && e.endsAt && e.attendees.has(userId) && e.attendees.get(userId) !== "declined")
          .filter((e) => Date.parse(e.startsAt as string) < to && Date.parse(e.endsAt as string) > from)
          .map((e) => ({ s: Date.parse(e.startsAt as string), e: Date.parse(e.endsAt as string) }))
          .sort((x, y) => x.s - y.s);
        const merged: { s: number; e: number }[] = [];
        for (const i of list) {
          const last = merged[merged.length - 1];
          if (last && i.s <= last.e) last.e = Math.max(last.e, i.e);
          else merged.push({ ...i });
        }
        return { userId, intervals: merged.map((i) => ({ startsAt: new Date(i.s).toISOString(), endsAt: new Date(i.e).toISOString() })) };
      }),
    });
  }

  const col = p.match(/^\/api\/([^/]+)\/calendar\/events$/);
  if (col && m === "POST") {
    const tenant = col[1];
    if (!(MEMBERS[tenant] ?? []).includes(userId)) return err("forbidden", 403);
    const b = JSON.parse(body || "{}") as Record<string, unknown>;
    const unit = checkUnit(b, userId);
    if ("status" in unit) return unit;
    if (b.record === true && b.allDay === true) return err("record_needs_timed_event");
    if (typeof b.title !== "string") return err("title_invalid");
    if (b.allDay !== true && (b.startsAt === undefined || b.endsAt === undefined)) return err("time_shape_invalid");
    const e: DemoEvent = {
      id: nid(), tenantId: tenant, title: "", description: "", startsAt: null, endsAt: null, startsOn: null, endsOn: null, location: null, videoUrl: null,
      visibility: "attendees", unitNodeId: null, status: "confirmed", cancelledAt: null, organizerId: userId, attendees: new Map<string, Resp>([[userId, "accepted"]]),
      clientId: null, projectId: null, recording: null, createdAt: now(), updatedAt: now(),
    };
    const bad = applyBody(e, b, tenant);
    if (bad) return bad;
    e.unitNodeId = unit.unit;
    if (b.record === true) e.recording = { id: nid(), status: "scheduled" };
    EVENTS.push(e);
    return ok(detail(e, userId), 201);
  }

  const one = p.match(/^\/api\/([^/]+)\/calendar\/events\/([^/]+)(\/cancel|\/respond)?$/);
  if (!one) return null;
  const [, tenant, id, tail] = one;
  const e = EVENTS.find((x) => x.id === id && x.tenantId === tenant);
  // A caller who cannot read an event gets the same 404 an unknown id gets.
  if (!e || !canRead(e, userId)) return err("not_found", 404);

  if (!tail && m === "GET") return ok(detail(e, userId));

  if (!tail && m === "PATCH") {
    if (!mayChange(e, userId)) return err("forbidden", 403);
    if (!live(e)) return err("event_cancelled", 409);
    const b = JSON.parse(body || "{}") as Record<string, unknown>;
    const unit = checkUnit(b, userId, e);
    if ("status" in unit) return unit;
    const before = `${e.startsAt}|${e.endsAt}|${e.startsOn}|${e.endsOn}`;
    const bad = applyBody(e, b, tenant);
    if (bad) return bad;
    e.unitNodeId = unit.unit;
    if (before !== `${e.startsAt}|${e.endsAt}|${e.startsOn}|${e.endsOn}`) {
      for (const k of e.attendees.keys()) e.attendees.set(k, k === e.organizerId ? "accepted" : "needs_action");
    }
    e.updatedAt = now();
    return ok(detail(e, userId));
  }

  if (tail === "/cancel" && m === "POST") {
    if (!mayChange(e, userId)) return err("forbidden", 403);
    if (live(e)) { e.status = "cancelled"; e.cancelledAt = now(); e.updatedAt = now(); }
    return ok(detail(e, userId));
  }

  if (tail === "/respond" && m === "POST") {
    if (!e.attendees.has(userId)) return err("forbidden", 403);
    if (!live(e)) return err("event_cancelled", 409);
    const r = (JSON.parse(body || "{}") as { response?: string }).response;
    if (r !== "accepted" && r !== "declined" && r !== "tentative") return err("response_invalid");
    e.attendees.set(userId, r);
    e.updatedAt = now();
    return ok(detail(e, userId));
  }
  return null;
}
