import "server-only";
// TR-10/TR-38 — DEMO_MODE fixtures for the check-in subsystem (checkins.controller.ts, §5.3/§6.2).
// Routed from demoFixtures.getDemoResponse for every `/api/:t/checkins*` path.
//
// Mirrors demoPm.ts's STATEFUL in-memory-store convention (module-level state persists across
// requests within one running dev-server process; resets on restart) rather than demoReports.ts's
// stateless per-request fixtures — TR-10's whole point is that a submit today reads back as
// "already submitted" on the SAME server, which a stateless fixture can't exercise. One-way
// dependency: this file must NOT import demoFixtures.ts.
//
// Only `/checkins/today`, `POST /checkins`, and `GET /checkins` (history) are modelled — the
// lead/exec/HR-only `/checkins/compliance` grid and the manager `/checkins/:id/excuse` action are
// deliberately NOT wired here: TR-10/TR-38 are a self-service My Work card and a person-grain
// calendar, neither of which calls those two endpoints (see lib/checkins.ts's header comment on why
// self can never call /compliance). A future manager-facing compliance surface is a separate
// ticket's job to seed.
import { formatMinutes, type CheckinHistoryEntry, type CheckinPrefill, type CheckinToday, type CheckinSubmitResult } from "./checkins";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

const DAY_MS = 86_400_000;
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}
function isWeekend(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

interface DemoRow {
  status: "submitted" | "auto_missed" | "excused";
  summary: string;
  blockers: string | null;
  edited: boolean;
  source: string;
  submittedAt: string | null;
  excusedReason: string | null;
}

// `${tenantId}|${userId}|${date}` -> row. Real submissions (POST) mutate this same map the seed
// walk below populates, exactly like demoPm.ts's task/comment stores.
const store = new Map<string, DemoRow>();
const seededScopes = new Set<string>(); // `${tenantId}|${userId}` already seeded

function key(tenantId: string, userId: string, date: string): string {
  return `${tenantId}|${userId}|${date}`;
}

// Small local project/task name catalogue for the demo prefill text — duplicated rather than
// imported from demoReports.ts (same one-way, no-cross-demo-import rule demoReports.ts itself
// documents relative to demoFixtures.ts; keeping demo modules independent of each other too avoids
// a load-order dependency nobody asked for).
const DEMO_PROJECTS = [
  { id: "p-web-1", name: "Client site redesign" },
  { id: "p-seo-1", name: "SEO audit — Q3" },
  { id: "p-web-2", name: "Mobile app revamp" },
];
const DEMO_TASK_TITLES = ["Wire the checkout flow", "Draft onboarding copy", "Fix nav regression", "Ship keyword report"];

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** A deterministic, plausible draft for one (userId, date) — stands in for the real backend's
 *  `composeCheckinPrefill` (fed by real `time_entries`/`work_activity` rows), which this demo layer
 *  has no equivalent tables for. Not a re-implementation of that function; just enough shape to
 *  exercise "the prefill is visibly a prefill" in a browser. */
function demoDraft(userId: string, date: string): CheckinPrefill {
  const n = hashSeed(`${userId}|${date}`);
  const minutesLogged = 180 + (n % 5) * 30;
  const minutesBillable = Math.round(minutesLogged * 0.7);
  const project = DEMO_PROJECTS[n % DEMO_PROJECTS.length];
  const task = DEMO_TASK_TITLES[n % DEMO_TASK_TITLES.length];
  const byProject = [{ projectId: project.id, projectName: project.name, minutes: minutesLogged }];
  const tasksCompleted = [{ taskId: `t-demo-${n % 97}`, title: task }];
  const commentsAuthored = n % 3;
  const docsUpdated = n % 2;
  const summaryText = `Logged ${formatMinutes(minutesLogged)} on ${project.name}. Completed: ${task}.${
    commentsAuthored > 0 ? ` ${commentsAuthored} comment${commentsAuthored === 1 ? "" : "s"}.` : ""
  }`;
  return {
    summaryText, minutesLogged, minutesBillable, byProject,
    tasksCompleted, tasksCreated: [], tasksMoved: [],
    commentsAuthored, docsUpdated, otherActivityEvents: 0,
  };
}

const SEED_WINDOW_DAYS = 45;
// A fixed offset inside the seed window deliberately left with NO row at all — standing in for a
// company holiday. Mechanically this is identical to a weekend gap (both are "no row"), which is
// the point: §5.3's guard means a holiday and a weekend and approved leave are ALL represented the
// same honest way (absence of evidence), never fabricated as a distinct positive "holiday" status.
// It may itself land on a weekend depending on the real calendar date the demo runs on — harmless,
// since a weekend is already skipped the same way (both are "no row").
const HOLIDAY_OFFSET = -18;
const MISSED_FROM_END = 3;   // 3rd-most-recent WORKING day exercises the "missed" state
const EXCUSED_FROM_END = 6;  // 6th-most-recent WORKING day exercises the "excused" state

function seedIfNeeded(tenantId: string, userId: string): void {
  const scope = `${tenantId}|${userId}`;
  if (seededScopes.has(scope)) return;
  seededScopes.add(scope);
  const today = todayIso();

  // Collect every WORKING day in the seed window (skipping weekends and the one deliberate holiday
  // offset), oldest-to-newest, then assign the missed/excused states by POSITION among those
  // working days rather than a fixed calendar offset. A fixed offset would silently land on a
  // weekend depending on what real-world weekday "today" happens to be when the demo runs, and
  // skip its intended state entirely — caught by this file's own test suite.
  const workingDays: string[] = [];
  for (let offset = -SEED_WINDOW_DAYS; offset < 0; offset++) {
    const date = addDaysIso(today, offset);
    if (isWeekend(date) || offset === HOLIDAY_OFFSET) continue; // no row => not_expected
    workingDays.push(date);
  }
  const missedDate = workingDays[workingDays.length - MISSED_FROM_END];
  const excusedDate = workingDays[workingDays.length - EXCUSED_FROM_END];

  for (const date of workingDays) {
    const k = key(tenantId, userId, date);
    if (date === missedDate) {
      store.set(k, { status: "auto_missed", summary: "", blockers: null, edited: false, source: "system", submittedAt: null, excusedReason: null });
    } else if (date === excusedDate) {
      store.set(k, { status: "excused", summary: "", blockers: null, edited: false, source: "system", submittedAt: null, excusedReason: "Approved short leave — confirmed by manager." });
    } else {
      const draft = demoDraft(userId, date);
      store.set(k, {
        status: "submitted", summary: draft.summaryText, blockers: null, edited: false, source: "ui",
        submittedAt: `${date}T17:45:00Z`, excusedReason: null,
      });
    }
  }
}

export function checkinsDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const todayMatch = p.match(/^\/api\/([^/]+)\/checkins\/today$/);
  if (todayMatch && method === "GET") {
    const tenantId = todayMatch[1];
    seedIfNeeded(tenantId, userId);
    const date = todayIso();
    const row = store.get(key(tenantId, userId, date));
    // Demo approximation of §5.3's expected() for TODAY specifically: no per-user leave/attendance
    // is modelled for "today" (the seeded leave/holiday cases sit safely in the past window so the
    // history/calendar views can exercise them) — only the weekend half of the predicate applies.
    const expected = !isWeekend(date);
    const draft = demoDraft(userId, date);
    const today: CheckinToday = {
      date,
      expected,
      alreadySubmitted: row?.status === "submitted",
      existing: row
        ? { id: `demo-checkin-${tenantId}-${userId}-${date}`, status: row.status, summary: row.summary, blockers: row.blockers, edited: row.edited, source: row.source, submittedAt: row.submittedAt }
        : null,
      draft,
    };
    return ok(today);
  }

  const collectionMatch = p.match(/^\/api\/([^/]+)\/checkins$/);
  if (collectionMatch && method === "POST") {
    const tenantId = collectionMatch[1];
    seedIfNeeded(tenantId, userId);
    const b = body ? (JSON.parse(body) as { date?: string; summary?: string; blockers?: string; source?: string }) : {};
    const summary = typeof b.summary === "string" ? b.summary.trim() : "";
    if (!summary) return err(400, "summary must be non-empty");
    const today = todayIso();
    const yesterday = addDaysIso(today, -1);
    const date = b.date || today;
    if (date !== today && date !== yesterday) return err(400, "date must be today or yesterday");

    const k = key(tenantId, userId, date);
    const prior = store.get(k);
    if (prior?.status === "excused") return err(409, "this day was already excused — ask your manager/HR to reopen it");

    const draft = demoDraft(userId, date);
    const edited = summary !== draft.summaryText.trim();
    const blockers = typeof b.blockers === "string" && b.blockers.trim().length > 0 ? b.blockers.trim() : null;
    const source = typeof b.source === "string" ? b.source : "ui";
    store.set(k, { status: "submitted", summary, blockers, edited, source, submittedAt: new Date().toISOString(), excusedReason: null });

    const result: CheckinSubmitResult = { id: `demo-checkin-${tenantId}-${userId}-${date}`, date, status: "submitted", summary, blockers, edited, source };
    return ok(result);
  }

  if (collectionMatch && method === "GET") {
    const tenantId = collectionMatch[1];
    const subjectUserId = params.get("userId") || userId;
    seedIfNeeded(tenantId, subjectUserId);
    const from = params.get("from");
    const to = params.get("to");
    if (!from) return err(400, "from must be a YYYY-MM-DD date");
    if (!to) return err(400, "to must be a YYYY-MM-DD date");
    if (to < from) return err(400, "to must be on or after from");

    const checkins: CheckinHistoryEntry[] = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1)) {
      const row = store.get(key(tenantId, subjectUserId, d));
      if (!row) continue; // no row = not-expected (weekend/holiday/leave) — never fabricated as a miss
      checkins.push({
        id: `demo-checkin-${tenantId}-${subjectUserId}-${d}`, date: d, status: row.status,
        summary: row.summary, blockers: row.blockers, edited: row.edited, source: row.source,
        submittedAt: row.submittedAt, excusedReason: row.excusedReason,
      });
    }
    checkins.sort((a, c) => c.date.localeCompare(a.date));
    return ok({ userId: subjectUserId, from, to, checkins });
  }

  return null;
}
