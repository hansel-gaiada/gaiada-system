// DW-10c-3 (BFF §59): the department calendar. Types and pure functions only, no I/O and no `server-only`, so the page, the
// grid and the tests share them. The reader is `deptCalendar-data.ts`, the demo store `demoDeptCalendar.ts`.
//
// The read answers four legs (holidays, away, deadlines, events), each `{included: true, items}` or `{included: false, reason}`.
// A leg that is not included is NEVER drawn as an empty one: "nobody is away" is a claim, and a leg that could not be read does
// not get to make it. `legNotes` words each missing leg; `agendaEmptyText` never says "nothing" about a leg that did not load.
import { DISPLAY_TZ } from "./format";
import { WEEKDAY_LABELS, addDays, fromIso, startOfMonth, startOfWeek } from "./calendar";
import { allDayEventDays, timedEventDays, zoneTime } from "./zoneTime";
import { eventHref } from "./calendarEvents";
import { leadUnits } from "./rbac";
import type { Me } from "./platform";

export type LeaveKind = "vacation" | "sick" | "unpaid" | "other";
export type LegReason = "module_off" | "read_failed";
export type HolidayKind = "public" | "joint_leave" | "company";

/** One leg of the answer. `truncated` appears only on an included leg that was cut at 200 items. */
export type Leg<T> = { included: true; items: T[]; truncated?: true } | { included: false; reason: LegReason };

export interface DeptHoliday { day: string; name: string; kind: HolidayKind }
/** DW-D33: exactly these five fields. Never minutes, the note, the approver, or leave that is not approved. */
export interface DeptAway { userId: string; name: string; startsOn: string; endsOn: string; leaveType: LeaveKind }
export interface DeptDeadline { milestoneId: string; name: string; dueDate: string; projectId: string; projectName: string }
export interface DeptEvent {
  id: string; title: string;
  startsAt: string | null; endsAt: string | null; startsOn: string | null; endsOn: string | null;
  visibility: "company" | "department"; unitNodeId: string | null;
}

/** `GET /api/:t/departments/:unitNodeId/calendar?from&to` (§59.1). */
export interface DeptCalendar {
  unit: { id: string; name: string };
  from: string;
  to: string;
  holidays: Leg<DeptHoliday>;
  away: Leg<DeptAway>;
  deadlines: Leg<DeptDeadline>;
  events: Leg<DeptEvent>;
}

// ---- reading the answer, checked -------------------------------------------------------------------------------

const REASONS: readonly LegReason[] = ["module_off", "read_failed"];

/** One leg, checked. A leg whose shape is wrong is a leg that could not be read (`read_failed`), never an empty list. */
function asLeg<T>(raw: unknown): Leg<T> {
  const o = raw && typeof raw === "object" ? (raw as { included?: unknown; items?: unknown; reason?: unknown; truncated?: unknown }) : null;
  if (o && o.included === true && Array.isArray(o.items)) {
    return o.truncated === true ? { included: true, items: o.items as T[], truncated: true } : { included: true, items: o.items as T[] };
  }
  if (o && o.included === false && REASONS.includes(o.reason as LegReason)) return { included: false, reason: o.reason as LegReason };
  return { included: false, reason: "read_failed" };
}

/** The answer, checked: the unit and the window must be there (a body without them is a failed read), and each leg is
 *  checked on its own so one bad leg does not take the others with it. */
export function asDeptCalendar(raw: unknown): DeptCalendar {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const unit = o && o.unit && typeof o.unit === "object" ? (o.unit as { id?: unknown; name?: unknown }) : null;
  if (!o || !unit || typeof unit.id !== "string" || typeof o.from !== "string" || typeof o.to !== "string") {
    throw new Error("the department calendar answer had no unit or window");
  }
  return {
    unit: { id: unit.id, name: typeof unit.name === "string" ? unit.name : "" },
    from: o.from, to: o.to,
    holidays: asLeg<DeptHoliday>(o.holidays), away: asLeg<DeptAway>(o.away),
    deadlines: asLeg<DeptDeadline>(o.deadlines), events: asLeg<DeptEvent>(o.events),
  };
}

// ---- the month ---------------------------------------------------------------------------------------------------

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `?month=YYYY-MM`; anything else (absent, `2026-13`, `2026-1`, a year outside 1970 to 2200) is `fallback` (the current month). */
export function parseMonth(raw: string | undefined, fallback: string): string {
  const m = raw ? MONTH_RE.exec(raw) : null;
  if (!m) return fallback;
  const year = Number(m[1]);
  return year >= 1970 && year <= 2200 ? raw as string : fallback;
}

/** `YYYY-MM` moved by whole months (Dec + 1 is January of the next year). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** "October 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Always six weeks of seven days, Monday first: from the Monday on or before the 1st, 42 days. A month that fits in four or
 *  five weeks still gets six, so the grid does not change height as a person steps through the months. */
export function sixWeekGrid(month: string): string[][] {
  const first = startOfWeek(startOfMonth(`${month}-01`));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)));
}

/** The 42 days the page asks the server for: the grid's first and last cell, which is the server's longest window. */
export function monthWindow(month: string): { from: string; to: string } {
  const weeks = sixWeekGrid(month);
  return { from: weeks[0][0], to: weeks[5][6] };
}

export const isCurrentMonth = (month: string, today: string): boolean => month === today.slice(0, 7);
export const inMonth = (iso: string, month: string): boolean => iso.slice(0, 7) === month;
export { WEEKDAY_LABELS };

/** "Mon 12 Oct 2026", spelled out so the words never depend on the runtime's ICU data. */
export function dayLabel(iso: string): string {
  const d = new Date(fromIso(iso));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "12 Oct". */
export function shortDay(iso: string): string {
  const d = new Date(fromIso(iso));
  return `${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}

// ---- chips and the agenda ----------------------------------------------------------------------------------------

export type ChipKind = "holiday" | "away" | "milestone" | "event";
export const CHIP_KIND_LABEL: Record<ChipKind, string> = { holiday: "Holiday", away: "Away", milestone: "Milestone", event: "Event" };
const KIND_RANK: Record<ChipKind, number> = { holiday: 0, away: 1, milestone: 2, event: 3 };

export interface Chip {
  key: string;
  kind: ChipKind;
  day: string;
  /** What the chip says: "Nyepi", "Andre · vacation", "Client site · Launch", "09:00 · Sprint review". */
  label: string;
  /** The words after the label in the agenda (a holiday's kind, a leave's dates, who an event is for). */
  detail: string;
  /** Where it links, or null for a chip that is only information (holidays and away). */
  href: string | null;
  /** Ordering within a day, after the kind: an all-day event leads the timed ones. */
  sort: string;
}

const HOLIDAY_DETAIL: Record<HolidayKind, string> = { public: "Public holiday", joint_leave: "Joint leave", company: "Company holiday" };

/** The chips of every day in `[from, to]`, in the order a day shows them: holidays, away (by name), milestones, events. A leg that
 *  was not included contributes none (its note says why). Events are placed in the display zone, an all-day one by its dates. */
export function chipsByDay(cal: DeptCalendar, tenantId: string, tz: string = DISPLAY_TZ): Map<string, Chip[]> {
  const inWindow = (d: string) => d >= cal.from && d <= cal.to;
  const out = new Map<string, Chip[]>();
  const put = (c: Chip) => { const l = out.get(c.day); if (l) l.push(c); else out.set(c.day, [c]); };

  if (cal.holidays.included) {
    for (const h of cal.holidays.items) {
      if (inWindow(h.day)) put({ key: `h:${h.day}:${h.name}`, kind: "holiday", day: h.day, label: h.name, detail: HOLIDAY_DETAIL[h.kind] ?? "", href: null, sort: h.name });
    }
  }
  if (cal.away.included) {
    for (const a of cal.away.items) {
      const span = a.startsOn === a.endsOn ? "" : `${shortDay(a.startsOn)} to ${shortDay(a.endsOn)}`;
      for (const day of allDayEventDays(a.startsOn, a.endsOn)) {
        if (inWindow(day)) put({ key: `a:${a.userId}:${a.startsOn}:${day}`, kind: "away", day, label: `${a.name} · ${a.leaveType}`, detail: span, href: null, sort: a.name });
      }
    }
  }
  if (cal.deadlines.included) {
    for (const m of cal.deadlines.items) {
      if (inWindow(m.dueDate)) {
        put({ key: `m:${m.milestoneId}`, kind: "milestone", day: m.dueDate, label: `${m.projectName} · ${m.name}`, detail: "", href: `/projects/${encodeURIComponent(m.projectId)}`, sort: `${m.projectName} ${m.name}` });
      }
    }
  }
  if (cal.events.included) {
    for (const e of cal.events.items) {
      const detail = e.visibility === "department" ? cal.unit.name || "This department" : "Whole company";
      const href = eventHref(tenantId, e.id);
      const timed = e.startsAt !== null && e.endsAt !== null;
      const days = timed ? timedEventDays(e.startsAt as string, e.endsAt as string, tz) : e.startsOn && e.endsOn ? allDayEventDays(e.startsOn, e.endsOn) : [];
      days.forEach((day, i) => {
        if (!inWindow(day)) return;
        let time = "All day";
        let sort = "00:00";
        if (timed) {
          const first = i === 0, last = i === days.length - 1;
          const from = zoneTime(e.startsAt as string, tz), to = zoneTime(e.endsAt as string, tz);
          if (first) { time = from; sort = `1${from}`; }
          else if (last) { time = `until ${to}`; sort = "100:00"; }
        }
        put({ key: `e:${e.id}:${day}`, kind: "event", day, label: `${time} · ${e.title}`, detail, href, sort: `${sort} ${e.title}` });
      });
    }
  }
  for (const list of out.values()) list.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.sort.localeCompare(b.sort));
  return out;
}

/** The days of the window that hold at least one chip, in order: the agenda's rows. */
export function agendaDays(byDay: Map<string, Chip[]>): { day: string; chips: Chip[] }[] {
  return [...byDay.keys()].sort().map((day) => ({ day, chips: byDay.get(day) as Chip[] }));
}

// ---- the notes: what did not load --------------------------------------------------------------------------------

export interface LegNote { leg: "holidays" | "away" | "deadlines" | "events"; text: string }

/** One line for each leg that is not included, and one for each that was cut. Never silent: a missing leg is the reason a
 *  chip is absent, and a reader must not take its absence for "nobody is away" or "no milestones". The two HR legs share a line
 *  when the HR module is off for both. */
export function legNotes(cal: DeptCalendar): LegNote[] {
  const notes: LegNote[] = [];
  const hr = cal.holidays, away = cal.away;
  if (!hr.included && !away.included && hr.reason === "module_off" && away.reason === "module_off") {
    notes.push({ leg: "away", text: "The HR module is off for this company, so holidays and who is away are not shown." });
  } else {
    if (!hr.included) notes.push({ leg: "holidays", text: hr.reason === "module_off" ? "The HR module is off for this company, so holidays are not shown." : "Holidays could not be loaded." });
    if (!away.included) notes.push({ leg: "away", text: away.reason === "module_off" ? "The HR module is off for this company, so who is away is not shown." : "Leave could not be loaded, so who is away is not shown." });
  }
  if (!cal.deadlines.included) {
    notes.push({ leg: "deadlines", text: cal.deadlines.reason === "module_off" ? "The Projects module is off for this company, so milestones are not shown." : "Projects could not be loaded, so milestones are not shown." });
  }
  if (!cal.events.included) {
    notes.push({ leg: "events", text: cal.events.reason === "module_off" ? "Calendar events are off for this company, so events are not shown." : "Events could not be loaded." });
  }
  const cut = (leg: LegNote["leg"], what: string) => notes.push({ leg, text: `Only the first 200 ${what} are shown, so some may be missing.` });
  if (cal.holidays.included && cal.holidays.truncated) cut("holidays", "holidays");
  if (cal.away.included && cal.away.truncated) cut("away", "leave entries");
  if (cal.deadlines.included && cal.deadlines.truncated) cut("deadlines", "milestones");
  if (cal.events.included && cal.events.truncated) cut("events", "events");
  return notes;
}

export const allLegsIncluded = (cal: DeptCalendar): boolean =>
  cal.holidays.included && cal.away.included && cal.deadlines.included && cal.events.included;

/** The agenda's words when it has no days. "Nothing" is said only when every leg was read; otherwise it is said about what loaded. */
export function agendaEmptyText(cal: DeptCalendar): string {
  return allLegsIncluded(cal) ? "Nothing is scheduled for this period." : "Nothing is listed for this period from what could be loaded. The notes above say what is missing.";
}

// ---- the department choices of the event form (§59.3 / 59.4) ------------------------------------------------------

export interface UnitNode { id: string; name: string; kind: string; assigneeId?: string | null; children: readonly UnitNode[] }
export interface UnitChoice { id: string; name: string; /** "My department: X" for the viewer's own or led unit, "Department: X" for one only asked for. */ label: string }

/** The units a person may be offered for a department event: the units above their own placement (a person placed in a unit
 *  reaches every unit above it, so the department as well as the division), the units they lead, and `requested` (the
 *  `?unit=` the page linked here with, when it is in the tree). Departments and divisions only: a role or a person is not a
 *  unit to share with, and the company root is refused by the server (company-wide is "Everyone in the company"). A mirror: the
 *  server narrows every write. Without the org tree there are no choices. The led units are those of `tenantId` only (a lead
 *  grant counts only in a company whose own lead seat backs it, DW-10g-2). */
export function eventUnitChoices(me: Me, tenantId: string | null | undefined, root: UnitNode | null, requested?: string | null): UnitChoice[] {
  if (!root) return [];
  const names = new Map<string, string>();
  const unitIds: string[] = [];
  const own = new Set<string>();
  const isUnit = (n: UnitNode) => n.kind === "department" || n.kind === "division";
  const walk = (n: UnitNode, above: UnitNode[]): void => {
    if (n !== root && isUnit(n)) names.set(n.id, n.name);
    if (n.kind === "person" && n.assigneeId === me.userId) {
      // Outermost first: the department before its division.
      for (const a of above) if (a !== root && isUnit(a)) { if (!own.has(a.id)) unitIds.push(a.id); own.add(a.id); }
    }
    for (const c of n.children) walk(c, [...above, n]);
  };
  walk(root, []);
  for (const id of leadUnits(me, tenantId)) if (names.has(id) && !own.has(id)) { own.add(id); unitIds.push(id); }
  const out: UnitChoice[] = unitIds.map((id) => ({ id, name: names.get(id) as string, label: `My department: ${names.get(id)}` }));
  if (requested && names.has(requested) && !own.has(requested)) out.push({ id: requested, name: names.get(requested) as string, label: `Department: ${names.get(requested)}` });
  return out;
}

/** The name of a unit in the tree, for "Visible to <unit>"; null when it is not there (a unit that has left the tree). */
export function unitNameIn(root: UnitNode | null, id: string | null | undefined): string | null {
  if (!root || !id) return null;
  const find = (n: UnitNode): string | null => (n.id === id ? n.name : n.children.reduce<string | null>((f, c) => f ?? find(c), null));
  return find(root);
}

/** The "Add an event" link of the department calendar (§59.4). */
export const addDeptEventHref = (deptId: string): string => `/calendar/new?${new URLSearchParams({ visibility: "department", unit: deptId }).toString()}`;

/** The page's own address, for the month links. The current month is the bare address. */
export function scheduleHref(deptId: string, month: string, today: string): string {
  const base = `/departments/${encodeURIComponent(deptId)}/schedule`;
  return isCurrentMonth(month, today) ? base : `${base}?month=${month}`;
}

