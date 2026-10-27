// SCP-1c — cycles, deadlines and schedule health: THE MATHS (BFF §63.5, plan §4.4 and §10). PURE: no database, no clock, no
// config. Every date is an ISO `YYYY-MM-DD` string and every working-day question goes through `hr/working-days.ts`
// (`countWorkingDays`, `addDays`, `WorkingCalendar`), the one calendar HR's leave, accrual and payroll already agree on. This
// file writes no second calendar: it asks `countWorkingDays(d, d, calendar).workingDays === 1` whether a day works, and counts
// ranges with the same function.
//
// THE GOLDEN TABLE. `schedule-health-golden.json` pins every number below, computed BY HAND (a calendar written out, not run
// through this file). `schedule-health.test.ts` replays it. A change to a rule here is a change to that table first.
//
// THE DAY. "Today" is the caller's `todayIsoInTz(config.reportsTz)` (modules/reports/person-scope.ts). `REPORTS_TZ` is unset on
// live, so live counts UTC days until DW-4 sets it (BFF §63.0, plan §10). This file never reads a clock; it takes `today`.
//
// ── THE DEFINITIONS (each one a decision, written down) ────────────────────────────────────────────────────────────────────
//
// WORKING DAY. Not a weekend day of the calendar (Saturday and Sunday when it names none) and not one of its holidays. A company
// with no default holiday calendar passes `{}` and works Monday to Friday. NOTE the HR rule this inherits: an EMPTY `weekendDays`
// array reads as the default Saturday and Sunday (`countWorkingDays`), not as "no weekend".
//
// THE A/B PRE-FILL. For content month M (the 1st of `YYYY-MM`), P is the month before it (December of the year before, for
// January). Batch A is the last working day on or before the 15th of P; batch B is the last working day of P. No batch: no
// pre-fill. The result is a SUGGESTION in the deadline table; the person may type any other day.
//
// READY-BY = the deadline less the buffer, in working days. `addWorkingDays(deadline, -buffer)` steps back one calendar day at a
// time and counts only working days, so the DEADLINE DAY ITSELF is never counted: a deadline that is a Saturday, a Sunday or a
// holiday is taken as the client set it, and a buffer of 0 answers the deadline unchanged (never earlier, never moved to a
// working day). With a buffer of 1 a Monday deadline is ready by the Friday before, and a Saturday deadline by the Friday
// before as well (the first working day back). Ready-by is always on or before the deadline (the `social_cycles_ready_by_ck`).
//
// WHICH STEPS REMAIN, per status (the first open decision). The six estimated steps, in order, are
//     proofread · hod · design · final · client · schedule
// `remaining` is the sum of the client's estimates for the steps AFTER the one the post is in, because the holder's own step is the
// work they are doing now: `latestSafeHandoff` is the day the CURRENT holder must hand the post on (BFF §63.5: "the steps after the
// post's current step"). Where the post is not inside any estimated step, it is counted as standing BEFORE the step it will enter:
//     planned, drafting      the officer drafts: every step remains (proofread first)
//     proofread              hod, design, final, client, schedule
//     hod                    design, final, client, schedule
//     design                 final, client, schedule
//     final                  client, schedule
//     client                 schedule
//     changes                from the change case's RETURN step INCLUSIVE (`return_to`): the post is back with whoever fixes it
//                            (the officer or the designer) and will ENTER that step next, so that step's estimate is still to
//                            come. copywriter_copy and client_copy return to proofread (all six), hod_copy to hod (five),
//                            final_copy, final_design and client_design to final (three). A design change is the designer's
//                            revision of `design`, and "after design" is the same three steps.
//     blocked                counted from `blocked_from`, as if the post had not been blocked: `blocked_from` is one of the
//                            blockable statuses (planned, drafting, proofread, hod, design, final, changes) and a post blocked
//                            from `changes` counts from its `return_to` (the row keeps its change case while blocked).
//     approved, scheduled, live   DONE: nothing remains (BFF §63.5: "`done` from `approved` on").
// A missing estimate counts as 0. With no estimates at all `remaining` is 0 and the latest safe handoff is ready-by itself.
//
// LOOP E (`changed_only`, plan section 1, fixture `approve_copy`): after the client asked for a COPY change, the fixed copy goes
// proofread -> client, skipping the HoD approval, Creative and the final check (`approve_copy`'s `to` is `client` when `changedOnly`).
// So for a post with `changed_only` true that is in `proofread`, or in `changes` returning to `proofread` (the `client_copy` case, which
// `return_copy` also sets while `changedOnly`), or blocked from either of those, the steps `hod`, `design` and `final` do not remain:
//     changes (client_copy: `change_by` client, back to proofread)   proofread, client, schedule
//     proofread               client, schedule
// The skipped steps are DERIVED from the fixture, never retyped: the steps strictly between `proofread` and the status `approve_copy`
// goes to when `changedOnly` is true (`changedOnlySkippedSteps`). A fixture edit that moves that target changes the answer, and the test
// pins what it derives. `changed_only` on any OTHER status (which the database allows only with a client or no change case, so it does not
// arise there) is ignored: the cautious, longer path. Likewise a `client_copy` post whose `changedOnly` is false or absent counts the full
// path from proofread (all six steps): the cautious answer, pinned in the golden table as a contrast.
//
// LATEST SAFE HANDOFF = ready-by less `remaining` working days (`addWorkingDays`, the same stepping as above). It is reported
// literally, so with no estimates and a ready-by that is itself a holiday it is that holiday; only the SPARE count snaps it.
//
// SPARE DAYS = working days from today to the latest safe handoff, negative when it is past. Today and the handoff are both
// SNAPPED onto working days first: today to the first working day ON OR AFTER it (on a Saturday the next day anyone can act is
// Monday), the handoff to the last working day ON OR BEFORE it. The spare count is then the distance between those two working
// days in the working-day index: 0 when they are the same day, +n when the handoff is n working days ahead, -n when it passed n
// working days ago. So on the handoff day itself the post is `tight` (0), the day before it is 1, and a Saturday whose handoff
// was the Friday is -1 (one working day overdue), never a misleading 0.
//
// THE FIVE STATES (BFF §63.5), tested in this order:
//     done      approved, scheduled or live.
//     late      today is AFTER ready-by (strictly). `lateDays` = working days in (ready-by, today]; on the Saturday after a Friday
//               ready-by that is 0 and the post is still `late` (the first late working day is Monday). `lateWith` = the holder.
//     at_risk   spare is below 0 and today is on or before ready-by.
//     tight     spare is 0, or (the post is WITH THE CLIENT and the client is slower than usual, below) and spare would otherwise
//               be 1 or more.
//     on_track  spare is 1 or more.
// So the state never improves as today advances for a fixed post: on_track, tight, at_risk, late.
//
// "THE CLIENT IS SLOWER THAN USUAL" (the second open decision) = the client's AVERAGE approval time over the last 90 days is
// ABOVE their `client` step estimate. The average is over the DECIDED rows of `social_post_client_reviews` (status approved or
// changes_requested, `decided_at` inside the last 90 days, the client's own engagement), one sample per review row, each sample the
// working days in (the day the review was requested, the day it was decided] (`averageApprovalDays`). With no decided row, or with
// no `client` estimate, the client is NOT slower than usual: absence of evidence is not "slow". Equal to the estimate is not slower.
//
// THE HOLDER (`lateWith`) is the fixture's: `holders[status]`, or for `changes` the change case's holder, or for `blocked` the
// one the post waits on (`block_waiting_on`, which may be `external`). Waiting time counts against the holder, never the officer
// when someone else holds the post (plan §4.4): the officer is named only while the post is with the officer.
//
// THE CLIENT'S STATE = the worst of their posts' states (late, at_risk, tight, on_track, done). Its figures are the worst post's:
// the fewest spare days, the most late days (and who they are late with), the earliest latest-safe-handoff. All posts done: done.
// No posts: no health (null), because nothing is on the way to be early or late.
//
// THE COUNTS (`tallyCounts`) cover the twelve statuses through the fixture's phases: planned (phase brief, blocked included),
// inProduction, withClient, clientChanges, approved and scheduled (the two statuses of the client_approved phase) and live
// (phase posted). They count COUNTED posts only (not a story, not extra) so they sum to `counted`; `extra` and `stories` count
// those posts beside the target.
//
// The fixture is read here (statuses' holders, phases, change cases), never retyped; the test pins it against the file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Emits the fixture into dist/ beside `dist/modules/social/` (the same one line the stage machine's loader carries): tsc copies a
// JSON file only when a module imports it. Side-effect only; the text read below is the file's own bytes.
import "../scp-stage-machine.json";
import { addDays, countWorkingDays, type WorkingCalendar } from "../../hr/working-days";

// ── Types ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The six estimated steps of a post, in order (`social_engagements.step_estimates` keys, BFF §63.1). */
export const STEP_KEYS = ["proofread", "hod", "design", "final", "client", "schedule"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
/** Working days per step, per client. A key may be absent (0). */
export type StepEstimates = Partial<Record<StepKey, number>>;

export type HealthState = "on_track" | "tight" | "at_risk" | "late" | "done";
/** Worst first. */
export const HEALTH_SEVERITY: Readonly<Record<HealthState, number>> = { done: 0, on_track: 1, tight: 2, at_risk: 3, late: 4 };

/** Who holds a post (the fixture's `holders`), or who a blocked post waits on (`external` included). */
export type HolderRole = "officer" | "copywriter" | "approver" | "designer" | "client" | "publisher" | "external";

/** BFF §63.5's Health. */
export interface Health {
  state: HealthState;
  spareDays: number | null;
  lateDays: number | null;
  lateWith: HolderRole | null;
  latestSafeHandoff: string | null;
  readyBy: string;
}

/** What the health of ONE post needs to know about it (the `social_posts` columns, BFF §63.1). */
export interface HealthPost {
  /** `pipeline_status`. */
  status: string;
  /** `change_by` and `change_kind`: with `status` `changes` (or `blocked` from `changes`) they name the change case. */
  changeBy?: string | null;
  changeKind?: string | null;
  /** `return_to`: the step a `changes` post re-enters. */
  returnTo?: string | null;
  /** `changed_only` (loop e): the client asked for a copy change, so the fixed copy skips the HoD, Creative and the final check. */
  changedOnly?: boolean | null;
  /** `blocked_from`, `block_waiting_on`. */
  blockedFrom?: string | null;
  blockWaitingOn?: string | null;
}

export type DeliveryBatch = "A" | "B";

// ── The fixture (read, never retyped) ──────────────────────────────────────────────────────────────────────────────────────

interface FixtureSlice {
  statuses: string[];
  blockableStatuses: string[];
  phases: Array<{ key: string; label: string }>;
  phaseOf: Record<string, string>;
  holders: Record<string, string | null>;
  actions: Array<{ action: string; to?: unknown }>;
  changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string; phase: string; holder: string }>;
}
let slice: FixtureSlice | null = null;
/** The parts of `scp-stage-machine.json` this file reads. Loaded once. */
export function fixtureSlice(): FixtureSlice {
  if (!slice) {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "scp-stage-machine.json"), "utf8")) as FixtureSlice;
    slice = {
      statuses: raw.statuses, blockableStatuses: raw.blockableStatuses, phases: raw.phases, phaseOf: raw.phaseOf,
      holders: raw.holders, actions: raw.actions, changeCases: raw.changeCases,
    };
  }
  return slice;
}

// ── Working-day primitives (all over hr/working-days.ts) ───────────────────────────────────────────────────────────────────

/** Scans never run longer than this many calendar days: a calendar with no working day at all (every weekday off) must end, not loop. */
const MAX_SCAN_DAYS = 400;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `iso` is a working day of `calendar` (neither one of its weekend days nor one of its holidays). */
export function isWorkingDay(iso: string, calendar: WorkingCalendar): boolean {
  return countWorkingDays(iso, iso, calendar).workingDays === 1;
}

/** The first working day on or after `iso`. A calendar with none in the scan range answers `iso` unchanged. */
export function firstWorkingDayOnOrAfter(iso: string, calendar: WorkingCalendar): string {
  let d = iso;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (isWorkingDay(d, calendar)) return d;
    d = addDays(d, 1);
  }
  return iso;
}

/** The last working day on or before `iso`. A calendar with none in the scan range answers `iso` unchanged. */
export function lastWorkingDayOnOrBefore(iso: string, calendar: WorkingCalendar): string {
  let d = iso;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    if (isWorkingDay(d, calendar)) return d;
    d = addDays(d, -1);
  }
  return iso;
}

/**
 * Step `n` working days from `iso` (back when `n` is negative). Each step moves one calendar day and counts only a working day, so
 * `iso` itself is never counted and `n = 0` answers `iso` unchanged, even when `iso` is not a working day.
 */
export function addWorkingDays(iso: string, n: number, calendar: WorkingCalendar): string {
  const dir = n < 0 ? -1 : 1;
  let left = Math.abs(Math.trunc(n));
  let d = iso;
  let scanned = 0;
  while (left > 0 && scanned < MAX_SCAN_DAYS * 40) {
    d = addDays(d, dir);
    scanned += 1;
    if (isWorkingDay(d, calendar)) left -= 1;
  }
  return d;
}

/** Working days in the half-open range (`fromIso`, `toIso`]: 0 when `toIso` is not after `fromIso`. */
export function workingDaysBetween(fromIso: string, toIso: string, calendar: WorkingCalendar): number {
  if (toIso <= fromIso) return 0;
  return countWorkingDays(addDays(fromIso, 1), toIso, calendar).workingDays;
}

// ── The pre-fill and ready-by ──────────────────────────────────────────────────────────────────────────────────────────────

/** True for a real `YYYY-MM` month. */
export function isMonthKey(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** `YYYY-MM` of the month before `month` (the year turn included). */
export function previousMonth(month: string): string {
  if (!isMonthKey(month)) throw new Error(`expected YYYY-MM, got ${JSON.stringify(month)}`);
  return addDays(`${month}-01`, -1).slice(0, 7);
}

/** The last calendar day of `month` (`YYYY-MM`). */
export function lastDayOfMonth(month: string): string {
  if (!isMonthKey(month)) throw new Error(`expected YYYY-MM, got ${JSON.stringify(month)}`);
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const next = m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/**
 * The A/B batch pre-fill for content month `month` (`YYYY-MM`): batch A is the last working day on or before the 15th of the month
 * before; batch B is the last working day of the month before. Null when the client has no batch.
 */
export function prefillDeadline(month: string, batch: DeliveryBatch | null, calendar: WorkingCalendar): string | null {
  if (!batch) return null;
  const prev = previousMonth(month);
  const anchor = batch === "A" ? `${prev}-15` : lastDayOfMonth(prev);
  return lastWorkingDayOnOrBefore(anchor, calendar);
}

/** Ready-by = the deadline less `bufferWorkingDays` working days (see the header: the deadline day is never counted; 0 is the deadline). */
export function readyByFor(deadline: string, bufferWorkingDays: number, calendar: WorkingCalendar): string {
  return addWorkingDays(deadline, -Math.max(0, Math.trunc(bufferWorkingDays)), calendar);
}

// ── Which steps remain, and for how long ───────────────────────────────────────────────────────────────────────────────────

const stepIndex = (k: string): number => (STEP_KEYS as readonly string[]).indexOf(k);

/**
 * The estimated steps still ahead of `post` (the header's table), or `null` when the post is done. A `changes` post counts from its
 * return step inclusive; a `blocked` post counts as if it were in `blocked_from` (from `return_to` when that is `changes`). A post whose
 * data cannot place it (a `changes` post with no known `returnTo`) counts every step: the cautious answer.
 */
export function remainingSteps(post: HealthPost): StepKey[] | null {
  let status = post.status;
  if (status === "blocked") status = post.blockedFrom ?? "planned";
  if (status === "approved" || status === "scheduled" || status === "live") return null;
  if (status === "planned" || status === "drafting") return [...STEP_KEYS];
  if (status === "changes") {
    const i = stepIndex(post.returnTo ?? "");
    const from = i >= 0 ? STEP_KEYS.slice(i) : [...STEP_KEYS];
    // Loop e: only the CLIENT's copy change (`client_copy`, returning to proofread) skips the middle steps. The database allows
    // `changed_only` only with a client or no change case, so any other case carrying it cannot arise and takes the cautious path.
    return post.changedOnly === true && post.changeBy === "client" && i === stepIndex("proofread") ? withoutChangedOnlySkips(from) : from;
  }
  const i = stepIndex(status);
  if (i < 0) return [...STEP_KEYS];
  const after = STEP_KEYS.slice(i + 1);
  return post.changedOnly === true && status === "proofread" ? withoutChangedOnlySkips(after) : after;
}

/**
 * The steps loop e skips, DERIVED from the fixture: those strictly between `proofread` and the status `approve_copy` goes to when
 * `changedOnly` is true (the fixture's `to` is a list of `{when: {changedOnly}, status}`). Empty when the fixture names no such rule or a
 * target that is not an estimated step, so a fixture change cannot silently leave the old three hard-coded.
 */
export function changedOnlySkippedSteps(): StepKey[] {
  const action = fixtureSlice().actions.find((a) => a.action === "approve_copy");
  const to = Array.isArray(action?.to) ? (action!.to as Array<{ when?: { changedOnly?: boolean }; status?: string }>) : [];
  const target = to.find((t) => t.when?.changedOnly === true)?.status;
  const from = stepIndex("proofread");
  const end = target ? stepIndex(target) : -1;
  return from >= 0 && end > from ? STEP_KEYS.slice(from + 1, end) : [];
}

const withoutChangedOnlySkips = (steps: readonly StepKey[]): StepKey[] => {
  const skip = new Set<StepKey>(changedOnlySkippedSteps());
  return steps.filter((k) => !skip.has(k));
};

/** The sum of `estimates` over `steps`; a missing, negative or non-integer value counts as 0 (the route validates 0 to 30; this never trusts it). */
export function remainingWorkingDays(steps: readonly StepKey[], estimates: StepEstimates): number {
  let n = 0;
  for (const k of steps) {
    const v = estimates[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) n += v;
  }
  return n;
}

/** The latest safe day to hand the post on: ready-by less `remaining` working days (ready-by itself when `remaining` is 0). */
export function latestSafeHandoffFor(readyBy: string, remaining: number, calendar: WorkingCalendar): string {
  return remaining > 0 ? addWorkingDays(readyBy, -remaining, calendar) : readyBy;
}

/** Spare working days from `today` to `handoff` (the header: both snapped onto working days; negative when past). */
export function spareDaysBetween(today: string, handoff: string, calendar: WorkingCalendar): number {
  const t = firstWorkingDayOnOrAfter(today, calendar);
  const h = lastWorkingDayOnOrBefore(handoff, calendar);
  if (h >= t) return Math.max(0, countWorkingDays(t, h, calendar).workingDays - 1);
  return -countWorkingDays(addDays(h, 1), t, calendar).workingDays;
}

// ── Holder and phase (from the fixture) ────────────────────────────────────────────────────────────────────────────────────

function changeCaseOf(post: HealthPost) {
  return fixtureSlice().changeCases.find((c) => c.changeBy === post.changeBy && c.changeKind === post.changeKind);
}

/** Who holds the post: the fixture's holder of its status, of its change case, or the party a blocked post waits on. Null when nobody (live). */
export function postHolder(post: HealthPost): HolderRole | null {
  const fx = fixtureSlice();
  if (post.status === "blocked") {
    if (post.blockWaitingOn) return post.blockWaitingOn as HolderRole;
    return post.blockedFrom ? postHolder({ ...post, status: post.blockedFrom }) : null;
  }
  if (post.status === "changes") return (changeCaseOf(post)?.holder as HolderRole | undefined) ?? "officer";
  const h = fx.holders[post.status];
  if (h === undefined || h === null) return null;
  // `scheduled`'s entry is prose ("officer when scheduleVia is 'manual'; publisher when 'publisher'"): a scheduled post is done, never late.
  return (h.split(" ")[0] as HolderRole) ?? null;
}

/** The phase a post is in (the fixture's `phaseOf`; for `changes`, its change case's phase). */
export function postPhase(post: HealthPost): string | null {
  const fx = fixtureSlice();
  if (post.status === "changes") return changeCaseOf(post)?.phase ?? null;
  return fx.phaseOf[post.status] ?? null;
}

// ── Health ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PostHealthInput {
  /** The company's report day (`todayIsoInTz(config.reportsTz)`). */
  today: string;
  readyBy: string;
  calendar: WorkingCalendar;
  estimates: StepEstimates;
  /** `isClientSlower(...)`: true when the client's 90-day average approval time is above their `client` estimate. */
  clientSlower: boolean;
  post: HealthPost;
}

/** The health of one post (BFF §63.5; the header). */
export function postHealth(input: PostHealthInput): Health {
  const { today, readyBy, calendar, estimates, post } = input;
  const steps = remainingSteps(post);
  if (steps === null) return { state: "done", spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy };
  const handoff = latestSafeHandoffFor(readyBy, remainingWorkingDays(steps, estimates), calendar);
  const spare = spareDaysBetween(today, handoff, calendar);
  if (today > readyBy) {
    return {
      state: "late", spareDays: spare, lateDays: workingDaysBetween(readyBy, today, calendar),
      lateWith: postHolder(post), latestSafeHandoff: handoff, readyBy,
    };
  }
  let state: HealthState;
  if (spare < 0) state = "at_risk";
  else if (spare === 0) state = "tight";
  else state = post.status === "client" && input.clientSlower ? "tight" : "on_track";
  return { state, spareDays: spare, lateDays: null, lateWith: null, latestSafeHandoff: handoff, readyBy };
}

/**
 * The client's health: the worst of their posts' (the header). Null for no posts. `done` when every post is done.
 * Figures are the worst posts': fewest spare days, most late days (and who with), earliest latest-safe-handoff.
 */
export function clientHealth(posts: readonly Health[], readyBy: string): Health | null {
  if (posts.length === 0) return null;
  let worst: HealthState = "done";
  for (const h of posts) if (HEALTH_SEVERITY[h.state] > HEALTH_SEVERITY[worst]) worst = h.state;
  if (worst === "done") return { state: "done", spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy };
  const open = posts.filter((h) => h.state !== "done");
  const spares = open.map((h) => h.spareDays).filter((n): n is number => n !== null);
  const handoffs = open.map((h) => h.latestSafeHandoff).filter((s): s is string => s !== null).sort();
  let lateDays: number | null = null;
  let lateWith: HolderRole | null = null;
  if (worst === "late") {
    for (const h of open) {
      if (h.state !== "late") continue;
      if (lateDays === null || (h.lateDays ?? 0) > lateDays) { lateDays = h.lateDays ?? 0; lateWith = h.lateWith; }
    }
  }
  return {
    state: worst, spareDays: spares.length ? Math.min(...spares) : null, lateDays, lateWith,
    latestSafeHandoff: handoffs[0] ?? null, readyBy,
  };
}

// ── "The client is slower than usual" ──────────────────────────────────────────────────────────────────────────────────────

/** The look-back window of the client's average approval time (BFF §63.5). */
export const APPROVAL_WINDOW_DAYS = 90;

export interface ApprovalSample {
  /** The company-day the review was requested (`requested_at`), `YYYY-MM-DD`. */
  requestedOn: string;
  /** The company-day it was decided (`decided_at`). */
  decidedOn: string;
}

/** The mean working days between request and decision over `samples`, or null with none. */
export function averageApprovalDays(samples: readonly ApprovalSample[], calendar: WorkingCalendar): number | null {
  if (samples.length === 0) return null;
  let total = 0;
  for (const s of samples) total += workingDaysBetween(s.requestedOn, s.decidedOn, calendar);
  return total / samples.length;
}

/** True when the client is slower than usual: a known average strictly above a set `client` estimate. Otherwise false. */
export function isClientSlower(averageDays: number | null, clientEstimate: number | undefined): boolean {
  return averageDays !== null && typeof clientEstimate === "number" && averageDays > clientEstimate;
}

// ── The counts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CycleCounts {
  counted: number; planned: number; inProduction: number; withClient: number; clientChanges: number;
  approved: number; scheduled: number; live: number; extra: number; stories: number;
}

/** The fixture phase each count key stands for (`approved` and `scheduled` split the client_approved phase by status). */
export const COUNT_OF_PHASE: Readonly<Record<string, keyof CycleCounts>> = {
  brief: "planned", in_production: "inProduction", with_client: "withClient", client_changes: "clientChanges", posted: "live",
};

export interface CountedPost extends HealthPost {
  isExtra: boolean;
  /** `format`: `story` posts are shown beside the target. */
  format: string | null;
}

/** The counts of one cycle's posts (the header). The posts are the cycle's live (not deleted, not archived) pipeline posts. */
export function tallyCounts(posts: readonly CountedPost[]): CycleCounts {
  const c: CycleCounts = { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 };
  for (const p of posts) {
    if (p.isExtra) c.extra += 1;
    if (p.format === "story") c.stories += 1;
    if (p.isExtra || p.format === "story") continue;
    c.counted += 1;
    const phase = postPhase(p);
    if (phase === "client_approved") c[p.status === "scheduled" ? "scheduled" : "approved"] += 1;
    else if (phase && COUNT_OF_PHASE[phase]) c[COUNT_OF_PHASE[phase]] += 1;
  }
  return c;
}

/** Coerces a stored `step_estimates` jsonb to estimates: only the six keys, only integers 0 to 30 (anything else is dropped, never trusted). */
export function parseStepEstimates(raw: unknown): StepEstimates {
  const out: StepEstimates = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of STEP_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 30) out[k] = v;
  }
  return out;
}

/** True for a real `YYYY-MM-DD` shape (the caller still validates the calendar date through `addDays`/`parseIsoDate`). */
export const looksLikeIsoDate = (s: unknown): s is string => typeof s === "string" && ISO_RE.test(s);
