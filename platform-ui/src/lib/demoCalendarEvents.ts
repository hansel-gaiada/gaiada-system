import "server-only";
// TEMP DEMO MODE: stateful in-memory store for calendar events (DW-8g, BFF §47.3), after `demoMeetings.ts`. Module-level
// state lasts for the dev-server process. Active only via DEMO_MODE=1, routed from `demoFixtures.getDemoResponse`, so
// the calendar, the event page, the form and the Overview's Today block all work with no backend. It models the rules the
// UI depends on (404 for an event you cannot read, `canEdit` / `canRespond`, 409 on a cancelled event, 422 for a
// non-member, the answers reset on a time change) and nothing more: no notifications, no recording row.
import { DISPLAY_TZ, todayIsoInDisplayZone } from "./format";
import { zonedToInstant } from "./zoneTime";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
/** A refusal in the backend's shape: `{error, reason}` with the machine code in both. */
const err = (error: string, status = 400): DemoResult => ({ status, json: { error, reason: error } });

type Resp = "needs_action" | "accepted" | "declined" | "tentative";
interface DemoEvent {
  id: string; tenantId: string; title: string; description: string;
  startsAt: string | null; endsAt: string | null; startsOn: string | null; endsOn: string | null;
  location: string | null; videoUrl: string | null; visibility: "attendees" | "company"; status: "confirmed" | "cancelled";
  cancelledAt: string | null; organizerId: string; attendees: Map<string, Resp>;
  clientId: string | null; projectId: string | null; recording: { id: string; status: string } | null;
  createdAt: string; updatedAt: string;
}

const NAMES: Record<string, string> = {
  "demo-hansel": "Clement Hansel", "gede-ic": "Gede Kusuma", "seo-staff": "Nyoman Ari", "u-pm": "Dewi Santoso", "u-dev": "Made Putra", "u-finance": "Rina Wibawa",
};
const COMPANY_NAMES: Record<string, string> = { "co-holding": "D & A Syrowatka", "co-agency": "Gaia Digital Agency", "co-resort": "Resort Co" };
// Who is a member where (mirrors the MEMBERS fixture in demoFixtures.ts, for the 422 rule).
const MEMBERS: Record<string, string[]> = {
  "co-holding": ["demo-hansel", "u-finance"],
  "co-agency": ["demo-hansel", "gede-ic", "seo-staff", "u-pm", "u-dev"],
  "co-resort": ["demo-hansel"],
};
const CLIENTS: Record<string, string> = { "cl-1": "Northwind Traders", "cl-2": "Cedar Group" };
const PROJECTS: Record<string, string> = { "p-web-1": "Northwind site redesign", "p-seo-1": "Cedar SEO" };

let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const now = () => new Date().toISOString();
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, time: string) => zonedToInstant(day, time, DISPLAY_TZ) as string;

function seed(): DemoEvent[] {
  const today = todayIsoInDisplayZone();
  const mk = (e: Partial<DemoEvent> & Pick<DemoEvent, "title" | "organizerId" | "attendees">): DemoEvent => ({
    id: nid(), tenantId: "co-agency", description: "", startsAt: null, endsAt: null, startsOn: null, endsOn: null, location: null, videoUrl: null,
    visibility: "attendees", status: "confirmed", cancelledAt: null, clientId: null, projectId: null, recording: null, createdAt: now(), updatedAt: now(), ...e,
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
  ];
}
const EVENTS: DemoEvent[] = seed();

const canRead = (e: DemoEvent, uid: string) =>
  e.organizerId === uid || e.attendees.has(uid) || (e.visibility === "company" && (MEMBERS[e.tenantId] ?? []).includes(uid));
const live = (e: DemoEvent) => e.status === "confirmed";
/** The organizer, or the demo's company admin. */
const mayChange = (e: DemoEvent, uid: string) => e.organizerId === uid || uid === "demo-hansel";

function detail(e: DemoEvent, uid: string) {
  const attendees = [...e.attendees.entries()]
    .map(([userId, response]) => ({ userId, name: NAMES[userId] ?? "", response }))
    .sort((a, b) => (a.userId === e.organizerId ? -1 : b.userId === e.organizerId ? 1 : a.name.localeCompare(b.name)));
  return {
    id: e.id, tenantId: e.tenantId, title: e.title, description: e.description, startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.startsOn !== null,
    startsOn: e.startsOn, endsOn: e.endsOn, location: e.location, videoUrl: e.videoUrl, visibility: e.visibility, status: e.status, cancelledAt: e.cancelledAt,
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
  if (b.visibility === "attendees" || b.visibility === "company") e.visibility = b.visibility;
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

export function calendarEventsDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();

  if (p === "/api/calendar/events/mine" && m === "GET") {
    const from = Date.parse(params.get("from") ?? ""), to = Date.parse(params.get("to") ?? "");
    if (Number.isNaN(from) || Number.isNaN(to)) return err("window_required");
    if (to <= from) return err("window_invalid");
    if (to - from > 92 * DAY) return err("window_too_large");
    const scope = params.get("scope") ?? "all";
    const items = EVENTS
      .filter((e) => (scope === "all" || e.tenantId === scope) && (e.organizerId === userId || e.attendees.has(userId)))
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
    if (b.record === true && b.allDay === true) return err("record_needs_timed_event");
    if (typeof b.title !== "string") return err("title_invalid");
    if (b.allDay !== true && (b.startsAt === undefined || b.endsAt === undefined)) return err("time_shape_invalid");
    const e: DemoEvent = {
      id: nid(), tenantId: tenant, title: "", description: "", startsAt: null, endsAt: null, startsOn: null, endsOn: null, location: null, videoUrl: null,
      visibility: "attendees", status: "confirmed", cancelledAt: null, organizerId: userId, attendees: new Map<string, Resp>([[userId, "accepted"]]),
      clientId: null, projectId: null, recording: null, createdAt: now(), updatedAt: now(),
    };
    const bad = applyBody(e, b, tenant);
    if (bad) return bad;
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
    const before = `${e.startsAt}|${e.endsAt}|${e.startsOn}|${e.endsOn}`;
    const bad = applyBody(e, b, tenant);
    if (bad) return bad;
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
