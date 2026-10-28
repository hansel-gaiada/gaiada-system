// SCP-3e (BFF §63.10 `GET calendar`, the date-move rule; §59 the department calendar; plan §6.2, §8 row 3e) — the Social Media calendar's pure helpers. No
// server-only import, so the grid (a client component) and the tests share them.
//
// THE GRID IS `monthGrid` (lib/socialClient.ts): Monday first, whole weeks. The page asks for the grid's own first and last day, which is at most 42 days:
// inside the server's 62 for `GET calendar` and exactly the department calendar's longest window (§59.1), so one window serves both reads.
//
// THE DATE-MOVE RULE IS THE SERVER'S (`GET calendar` carries `dateMove` and `dateMoveRefusal` on every item, decided by `dateMoveOf`, the fixture's
// `systemRules.date_moves`, the same function the feed preview uses; nothing is restated or guessed here):
//   edit        planned, drafting and a team copy `changes` case: `PATCH posts/:postId/pipeline` with `scheduledAt`
//   reschedule  approved, scheduled: the client is asked again (SCP-Q13), so the dialog says so BEFORE the move commits
//   locked      every other status; `dateMoveRefusal` is `field_locked`, or `post_is_live` for a live post, and `lockedWords` says why in words
import { chipsByDay, dayLabel, legNotes, type DeptCalendar } from "./deptCalendar";
import { todayIsoInDisplayZone } from "./format";
import { isoToZoneInput, lockedWords, zoneInputToIso } from "./socialPipeline";
import { asCalendarItems, monthGrid, shiftMonth, type CalendarItem } from "./socialClient";
import type { AllocationRow } from "./socialAllocation";
import type { CycleTable } from "./socialCycles";

export const CALENDAR_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The legend entry for a Composer post (a post with no pipeline status): it has no phase, so it is drawn with a dashed edge and the word, not a phase colour. */
export const COMPOSER_LEGEND = { key: "composer", label: "Composer post" } as const;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ── The day and the time, in the zone every date on screen is shown in ──────────────────────────────────────────────────────────

/** The day (`YYYY-MM-DD`) an instant falls on, in the display zone. */
export const dayOfIso = (iso: string): string => todayIsoInDisplayZone(new Date(iso));
/** The time of day an instant falls on ("09:30"), in the display zone. */
export const timeOfIso = (iso: string): string => isoToZoneInput(iso).slice(11);

/** A calendar item placed on its day: the server works the day and the time out (a function cannot cross to the grid), the grid only draws them. */
export interface DayItem extends CalendarItem { day: string; time: string }
export const placeItem = (it: CalendarItem): DayItem => ({ ...it, day: dayOfIso(it.scheduledAt), time: timeOfIso(it.scheduledAt) });

// ── The date-move rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MoveRule =
  /** An edit: `PATCH posts/:postId/pipeline` with the new `scheduledAt`. */
  | { kind: "edit" }
  /** `reschedule`: the post goes back to the client. */
  | { kind: "reschedule" }
  /** Not movable, and why. */
  | { kind: "locked"; why: string };

/** What dragging (or "Move to date…") does to a post, as the server said (`dateMove`), with the reason in words when it is locked. */
export function moveRuleOf(post: Pick<CalendarItem, "pipelineStatus" | "dateMove" | "dateMoveRefusal">): MoveRule {
  if (post.dateMove === "edit") return { kind: "edit" };
  if (post.dateMove === "reschedule") return { kind: "reschedule" };
  return { kind: "locked", why: lockedReason(post) };
}

/** Why a locked date is locked, in words: `post_is_live`, or `field_locked` by the status (a locked `changes` post is a design change or the client's own). */
function lockedReason(post: Pick<CalendarItem, "pipelineStatus" | "dateMoveRefusal">): string {
  const s = post.pipelineStatus;
  if (post.dateMoveRefusal === "post_is_live" || s === "live") return "The post is live, so its date cannot change.";
  if (s === "changes") return "The post is back for a design change or a change the client asked for, so the date stays as the client saw it. After the next approval, Reschedule asks the client again.";
  return lockedWords({ pipelineStatus: s, scheduleVia: null }, "scheduledAt");
}

/** A post's instant moved to another day, keeping its time of day in the display zone; "" when that time does not exist on that day (a DST gap). */
export function shiftToDay(iso: string, day: string): string {
  const local = isoToZoneInput(iso);
  return local ? zoneInputToIso(`${day}${local.slice(10)}`) : "";
}

/** What the confirm says before an approved or scheduled post moves (SCP-Q13). */
export function rescheduleWarning(post: Pick<CalendarItem, "title" | "pipelineStatus">, nextIso: string): string[] {
  const lines = [
    `"${post.title}" was approved by the client for its present date. The client will be asked to approve ${dayLabel(dayOfIso(nextIso))} at ${timeOfIso(nextIso)} again, on every network.`,
  ];
  if (post.pipelineStatus === "scheduled") lines.push("It is unscheduled first, and any dispatch queued for the old date is cancelled.");
  return lines;
}

/** The line said after a move went through. */
export function movedWords(post: Pick<CalendarItem, "title">, rule: MoveRule, nextIso: string): string {
  const to = `${dayLabel(dayOfIso(nextIso))} at ${timeOfIso(nextIso)}`;
  return rule.kind === "reschedule"
    ? `Moved "${post.title}" to ${to}. The client will be asked to approve it again.`
    : `Moved "${post.title}" to ${to}.`;
}

// ── Composer posts (a post with no pipeline status) ────────────────────────────────────────────────────────────────────────────

/** A Composer post on the grid: read-only, a link to the Composer. */
export interface ComposerEntry { postId: string; title: string; status: string; engagementId: string; scheduledAt: string; day: string; time: string }

/** `GET posts`' rows, the Composer's own: those without a pipeline status and with a date. The same list also holds the pipeline posts (the server's `GET posts`
 *  selects every post), which the calendar already draws from `GET calendar`. Throws on a body that is not a list. */
export function asComposerEntries(raw: unknown): ComposerEntry[] {
  if (!Array.isArray(raw)) throw new Error("posts: not a list");
  const out: ComposerEntry[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    if (r.pipelineStatus !== undefined && r.pipelineStatus !== null) continue;
    const at = str(r.scheduledAt);
    if (!at || Number.isNaN(Date.parse(at))) continue;
    out.push({ postId: r.id, title: str(r.title) ?? "Untitled post", status: str(r.status) ?? "", engagementId: str(r.engagementId) ?? "", scheduledAt: at, day: dayOfIso(at), time: timeOfIso(at) });
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.postId.localeCompare(b.postId));
}

/** Entries that fall inside the grid's window, for the client filter if one is set. */
export function composerInWindow(entries: readonly ComposerEntry[], window: { from: string; to: string }, engagementId: string | null): ComposerEntry[] {
  return entries.filter((e) => e.day >= window.from && e.day <= window.to && (!engagementId || e.engagementId === engagementId));
}

// ── Holidays and approved leave (§59) ───────────────────────────────────────────────────────────────────────────────────────────

/** A holiday or an away colleague on a day: information only, never a link. */
export interface DayNote { key: string; kind: "holiday" | "away"; label: string; detail: string }

/** The holiday and away chips by day, from the department calendar's two HR legs. Milestones and events are the Schedule page's, not this one's. A leg that did not
 *  load has no chips (its note says why), so a missing chip is never read as "nobody is away". */
export function holidayAwayByDay(cal: DeptCalendar): Record<string, DayNote[]> {
  const hrOnly: DeptCalendar = { ...cal, deadlines: { included: true, items: [] }, events: { included: true, items: [] } };
  const out: Record<string, DayNote[]> = {};
  for (const [day, chips] of chipsByDay(hrOnly, "")) {
    const notes = chips.filter((c): c is typeof c & { kind: "holiday" | "away" } => c.kind === "holiday" || c.kind === "away")
      .map((c) => ({ key: c.key, kind: c.kind, label: c.label, detail: c.detail }));
    if (notes.length > 0) out[day] = notes;
  }
  return out;
}

/** One line for each of the two HR legs that did not load or was cut. */
export const hrLegNotes = (cal: DeptCalendar): string[] => legNotes(cal).filter((n) => n.leg === "holidays" || n.leg === "away").map((n) => n.text);

// ── The window, the month and the links ──────────────────────────────────────────────────────────────────────────────────────

/** The window every read of the page asks for: the grid's first and last day. */
export function calendarWindow(month: string): { from: string; to: string } {
  const weeks = monthGrid(month);
  return { from: weeks[0][0].iso, to: weeks[weeks.length - 1][6].iso };
}

/** The page's own address, with its month and client filter. The current month is the bare address, as the Schedule page's is. */
export function calendarHref(deptId: string, month: string, today: string, engagementId?: string | null): string {
  const q = new URLSearchParams();
  if (month !== today.slice(0, 7)) q.set("month", month);
  if (engagementId) q.set("engagementId", engagementId);
  const qs = q.toString();
  return `/departments/${encodeURIComponent(deptId)}/calendar${qs ? `?${qs}` : ""}`;
}
export { shiftMonth };

/** `GET calendar`'s body, checked. */
export const asDayItems = (raw: unknown): DayItem[] => asCalendarItems(raw).map(placeItem);

// ── Planning a post on a day ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A client the "+" can plan a post for. `cycleId` is the client's cycle for the month on show, or null when it has none (then it is listed, and says why). */
export interface PlanClient {
  engagementId: string;
  clientName: string;
  cycleId: string | null;
  platforms: string[];
  defaultPostTime: string | null;
  /** The viewer is the client's officer: their clients are listed first. */
  mine: boolean;
  /** The viewer may create a post for this client: its officer, or one of the four approvers (`canPlan` on the allocation row). The server is the authority. */
  canCreate: boolean;
}

/** The clients to offer, the viewer's own first, then by name. A client's cycle for the month on show comes from the month's cycle table, or, when that could
 *  not be read, from the allocation's own `thisCycle` when it is the same month (so a failed table read never takes away the current month's "+"). */
export function planClients(rows: readonly AllocationRow[], table: CycleTable | null, month: string, viewerId: string): PlanClient[] {
  return rows
    .map((r): PlanClient => ({
      engagementId: r.engagementId, clientName: r.clientName,
      cycleId: table?.rows.find((c) => c.engagementId === r.engagementId)?.cycleId ?? (r.thisCycle?.month === month ? r.thisCycle.cycleId : null),
      platforms: [...r.platforms], defaultPostTime: r.defaultPostTime, mine: r.officer?.id === viewerId,
      canCreate: r.canPlan || r.officer?.id === viewerId,
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.clientName.localeCompare(b.clientName));
}

/** The client's default post time on a day, as an ISO instant in the display zone (09:00 when the client has none); "" for a time that does not exist that day. */
export function defaultPostIso(day: string, defaultPostTime: string | null): string {
  const t = defaultPostTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(defaultPostTime) ? defaultPostTime : "09:00";
  return zoneInputToIso(`${day}T${t}`);
}
