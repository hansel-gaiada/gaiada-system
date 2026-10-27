import "server-only";
// TEMP DEMO MODE: the department calendar read (DW-10c-3, BFF §59.1, `GET /api/:t/departments/:unitNodeId/calendar?from&to`), after
// `demoNotices.ts` (the same people, the same placement). Routed from `demoFixtures.getDemoResponse`, so the page works with no backend.
//
// It answers in the SERVER'S ORDER OF CHECKS: (1) the read gate (a client contact, or a company the person is not in, is 403), then (2) the
// window and the unit id's shape (400 naming `from`, `to` or `unitNodeId`: real `YYYY-MM-DD` days, `to` not before `from`, at most 42 days
// counting both ends), then (3) the unit narrowing (403 `outside your reporting line`, BEFORE any word on whether the unit exists), then
// (4) existence (404 `unit_not_found`, the root included). A client contact with a bad window is 403, never 400.
//
// WHAT THE DEMO HOLDS (co-agency, Web Dev = `dept-1`; every day is a fixed day of the current month, one more in the next month so the month
// navigation shows something different): the company holiday calendar (a holiday each month), approved leave for two Web Dev colleagues
// (Andre, vacation; Sari, sick), a milestone of a Web Dev project, and the events leg from the calendar-event store (`demoCalendarEvents.ts`:
// Web Dev's department event and a company event, so an event made on `/calendar/new` shows here too). The store ALSO holds what must NEVER
// reach the answer, so the rules are proved by data, not by absence: leave that is pending, leave of a person placed in another unit, leave
// with a note and minutes, a milestone that is done, a milestone of another unit's project, and another unit's department event.
//
// THE HR MODULE IS OFF FOR `co-resort` (Viceroy): its holidays and away legs answer `{included: false, reason: "module_off"}`, its
// deadlines and events legs are read and empty (`{included: true, items: []}`): "module off" and "nothing" are different answers.
import { demoMonthDay, deptCalendarEvents } from "./demoCalendarEvents";
import { DEMO_ORG_ROOT, DEMO_UNIT_NAMES, demoIsClientContact, demoPlacedIn, demoReachesUnit } from "./demoNotices";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const AGENCY = "co-agency";
const RESORT = "co-resort";
/** Viceroy's one unit in the demo (`org.ts`'s hospitality seed). The HR module is off for it. */
const RESORT_UNITS: Record<string, string> = { "hosp-dept-1": "Front Office" };
const RESORT_PLACED: Record<string, string[]> = { "u-resort": ["hosp-dept-1"] };
const RESORT_WIDE = new Set(["demo-hansel", "demo-owner"]);
const HR_OFF = new Set([RESORT]);

const DAY_MS = 86_400_000;
const isoDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const spanDays = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The company's default holiday calendar, by day. */
function holidays(): { day: string; name: string; kind: "public" | "joint_leave" | "company" }[] {
  return [
    { day: demoMonthDay(9), name: "Nyepi (Day of Silence)", kind: "public" },
    { day: demoMonthDay(14, 1), name: "Galungan", kind: "public" },
  ];
}

interface LeaveRow {
  userId: string; name: string; startsOn: string; endsOn: string; leaveType: "vacation" | "sick" | "unpaid" | "other";
  status: "approved" | "pending" | "denied" | "cancelled";
  /** Present on the store's rows, never in the answer (DW-D33): the reason and the minutes are the owner's and HR's. */
  note: string; minutes: number;
}
function leave(): LeaveRow[] {
  return [
    { userId: "u-andre", name: "Andre Wijaya", startsOn: demoMonthDay(13), endsOn: demoMonthDay(15), leaveType: "vacation", status: "approved", note: "Family trip to Lombok", minutes: 1440 },
    { userId: "u-sari", name: "Sari Dewi", startsOn: demoMonthDay(20), endsOn: demoMonthDay(20), leaveType: "sick", status: "approved", note: "Dentist", minutes: 480 },
    // SCP-3e: a Social Media colleague (`u-social`, dept-4), so the Social Media calendar shows an away mark in the demo too.
    { userId: "u-social", name: "Komang Lestari", startsOn: demoMonthDay(26), endsOn: demoMonthDay(27), leaveType: "vacation", status: "approved", note: "Family ceremony", minutes: 960 },
    // Never shown: not approved, or a person placed in another unit.
    { userId: "u-pm", name: "Dewi Santoso", startsOn: demoMonthDay(16), endsOn: demoMonthDay(17), leaveType: "vacation", status: "pending", note: "Wedding", minutes: 960 },
    { userId: "u-seo", name: "Luh Ayu", startsOn: demoMonthDay(13), endsOn: demoMonthDay(14), leaveType: "vacation", status: "approved", note: "Retreat", minutes: 960 },
  ];
}

interface MilestoneRow { milestoneId: string; name: string; dueDate: string; status: "open" | "done"; projectId: string; projectName: string; unit: string }
function milestones(): MilestoneRow[] {
  return [
    { milestoneId: "m-web-2", name: "Staging sign-off", dueDate: demoMonthDay(21), status: "open", projectId: "p-web-1", projectName: "Client site redesign", unit: "dept-1" },
    // Never shown: done, or another unit's project.
    { milestoneId: "m-web-1", name: "Design approved", dueDate: demoMonthDay(7), status: "done", projectId: "p-web-1", projectName: "Client site redesign", unit: "dept-1" },
    { milestoneId: "m-seo-1", name: "Audit delivered", dueDate: demoMonthDay(18), status: "open", projectId: "p-seo-1", projectName: "Cedar SEO", unit: "dept-3" },
  ];
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────────────────────

function reaches(tenant: string, userId: string, unit: string): boolean {
  if (tenant === AGENCY) return demoReachesUnit(userId, unit);
  return RESORT_WIDE.has(userId) || (RESORT_PLACED[userId] ?? []).includes(unit);
}
/** The unit's name in the company's tree, or null (the root, or a node that is not there). */
const unitName = (tenant: string, unit: string): string | null =>
  unit === DEMO_ORG_ROOT ? null : (tenant === AGENCY ? DEMO_UNIT_NAMES[unit] : RESORT_UNITS[unit]) ?? null;

/** `/api/:t/departments/:unitNodeId/calendar`. Null for any other path. */
export function deptCalendarDemo(method: string, p: string, qs: URLSearchParams, userId: string): DemoResult | null {
  const m = p.match(/^\/api\/([^/]+)\/departments\/([^/]+)\/calendar$/);
  if (!m || method.toUpperCase() !== "GET") return null;
  const tenant = decodeURIComponent(m[1]);
  let unit: string;
  try { unit = decodeURIComponent(m[2]); } catch { return err(400, "unitNodeId is not valid", "unitNodeId"); }

  // 1. The read gate: staff of a company the demo knows. A client contact is refused whatever the window.
  if (demoIsClientContact(userId) || (tenant !== AGENCY && tenant !== RESORT)) return err(403, "not authorized");

  // 2. The window, then the unit id's shape.
  const from = qs.get("from"), to = qs.get("to");
  if (!isoDay(from)) return err(400, "from must be a date, YYYY-MM-DD", "from");
  if (!isoDay(to)) return err(400, "to must be a date, YYYY-MM-DD", "to");
  if (to < from) return err(400, "to must not be before from", "to");
  if (spanDays(from, to) > 42) return err(400, "the window is at most 42 days", "to");
  // eslint-disable-next-line no-control-regex
  if (unit.length < 1 || unit.length > 200 || /[\u0000-\u001f\u007f]/.test(unit)) return err(400, "unitNodeId is not valid", "unitNodeId");

  // 3. The unit narrowing, before any word on whether the unit exists.
  if (!reaches(tenant, userId, unit)) return err(403, "outside your reporting line");

  // 4. Existence.
  const name = unitName(tenant, unit);
  if (name === null) return err(404, "unit_not_found", "unitNodeId");

  const inWindow = (a: string, b: string) => a <= to && b >= from;
  const hrOff = HR_OFF.has(tenant);
  const roster = tenant === AGENCY ? new Set(demoPlacedIn(unit)) : new Set(Object.keys(RESORT_PLACED).filter((u) => RESORT_PLACED[u].includes(unit)));

  return ok({
    unit: { id: unit, name }, from, to,
    holidays: hrOff
      ? { included: false, reason: "module_off" }
      : { included: true, items: holidays().filter((h) => h.day >= from && h.day <= to).sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name)) },
    // The five fields and nothing else: the note, the minutes and the status stay in the store.
    away: hrOff
      ? { included: false, reason: "module_off" }
      : {
        included: true,
        items: leave()
          .filter((l) => l.status === "approved" && roster.has(l.userId) && inWindow(l.startsOn, l.endsOn))
          .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name))
          .map((l) => ({ userId: l.userId, name: l.name, startsOn: l.startsOn, endsOn: l.endsOn, leaveType: l.leaveType })),
      },
    deadlines: {
      included: true,
      items: tenant !== AGENCY ? [] : milestones()
        .filter((x) => x.status === "open" && x.unit === unit && x.dueDate >= from && x.dueDate <= to)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name))
        .map(({ milestoneId, name: n, dueDate, projectId, projectName }) => ({ milestoneId, name: n, dueDate, projectId, projectName })),
    },
    events: { included: true, items: deptCalendarEvents(tenant, unit, userId, from, to) },
  });
}
