import "server-only";
// DW-4h-3 / DW-4i — DEMO_MODE twin of the all-work activity series (docs/FRONTEND-BFF-CONTRACT.md section 44.3, 44.4):
//
//   GET /api/:t/activity/series?userId=&from=&to=   -> { userId, from, to, timezone, kinds, days, totals }
//   GET /api/:t/activity/day?userId=&date=          -> { userId, date, items: [{ kind, title, at, link? }] }
//
// Routed from demoFixtures.getDemoResponse (own file, `(method, p, params, userId) => result | null`, one-way dependency:
// this file never imports demoFixtures, so the small identity and roster maps below are copied, as demoReports.ts does).
//
// Deterministic: a date hashes to the same counts every time, so the build gate and the e2e runs are reproducible. The mix of
// kinds follows the person: a developer commits and edits sites, an SEO person drafts briefs and reports, and so on. There is no
// `total` and no `score` key (DW-D19), and a day's items carry the work's own NAME, never message or comment text (blueprint 11).
//
// THE GATE is the real one (BFF section 44.3, `person-axis-gate.ts`): yourself; a company-wide identity; the head of a unit for
// the people on that unit's roster; else 403 "outside your reporting line". A client-portal identity is refused outright. (The
// demo's `GET /pm/productivity` has no gate at all, so there is nothing to mirror there: the refusal is reachable here on purpose.)

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const TIMEZONE = "UTC";
const MAX_WINDOW_DAYS = 400;
const DEFAULT_WINDOW_DAYS = 365;
const DAY_ITEM_LIMIT = 200;
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KINDS: { key: string; label: string; source: string }[] = [
  { key: "pm.tasks_completed", label: "Tasks completed", source: "pm" },
  { key: "pm.comments", label: "Comments", source: "pm" },
  { key: "pm.docs", label: "Notes and docs", source: "pm" },
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "github.pull_requests", label: "Pull requests", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "webdesk.publishes", label: "Publishes", source: "webdesk" },
  { key: "social.posts", label: "Posts scheduled or sent", source: "social" },
  { key: "seo.audits", label: "Audits", source: "seo" },
  { key: "seo.briefs", label: "Content briefs", source: "seo" },
  { key: "seo.reports", label: "Client reports", source: "seo" },
  { key: "creatives.versions", label: "Asset versions", source: "creatives" },
  { key: "creatives.reviews", label: "Review decisions", source: "creatives" },
  { key: "finance.journals", label: "Journals posted", source: "finance" },
  { key: "hr.leave_decided", label: "Leave decided", source: "hr" },
  { key: "meetings.recorded", label: "Meetings recorded", source: "system" },
  { key: "learning.completed", label: "Learning completed", source: "learning" },
  { key: "time.logged", label: "Time logged", source: "time" },
  { key: "checkins.submitted", label: "Check-ins", source: "checkins" },
];

/** How often (percent of days) and how much (at most) a person does a kind. A kind a person has no entry for is always 0. */
interface Habit { rate: number; cap: number }
const h = (rate: number, cap: number): Habit => ({ rate, cap });
const HABITS: Record<string, Record<string, Habit>> = {
  "demo-hansel": {
    "pm.tasks_completed": h(55, 3), "pm.comments": h(60, 4), "pm.docs": h(20, 2), "meetings.recorded": h(35, 2),
    "checkins.submitted": h(70, 1), "time.logged": h(65, 3), "learning.completed": h(4, 1), "hr.leave_decided": h(8, 2), "finance.journals": h(10, 3),
  },
  "u-dev": {
    "github.commits": h(80, 6), "github.pull_requests": h(40, 2), "webdesk.edits": h(35, 3), "webdesk.publishes": h(15, 1),
    "pm.tasks_completed": h(55, 3), "pm.comments": h(45, 3), "time.logged": h(70, 3), "checkins.submitted": h(70, 1),
  },
  "u-pm": {
    "pm.tasks_completed": h(35, 2), "pm.comments": h(50, 3), "pm.docs": h(25, 2), "meetings.recorded": h(30, 2),
    "time.logged": h(55, 2), "checkins.submitted": h(60, 1),
  },
  "u-webhead": {
    "pm.tasks_completed": h(30, 2), "pm.comments": h(55, 4), "github.pull_requests": h(35, 2), "meetings.recorded": h(40, 2),
    "hr.leave_decided": h(15, 2), "checkins.submitted": h(75, 1),
  },
  "gede-ic": {
    "seo.audits": h(15, 1), "seo.briefs": h(30, 2), "pm.tasks_completed": h(45, 3), "pm.comments": h(40, 3),
    "time.logged": h(65, 3), "checkins.submitted": h(70, 1),
  },
  "seo-staff": {
    "seo.briefs": h(25, 2), "seo.reports": h(12, 1), "pm.comments": h(30, 2), "time.logged": h(50, 2),
  },
  "dept-manager": {
    "seo.reports": h(20, 1), "seo.briefs": h(25, 2), "meetings.recorded": h(40, 2), "pm.comments": h(45, 3), "checkins.submitted": h(70, 1),
  },
};
/** Anyone else the demo can sign in as (an owner, a viewer): a light, generic mix. */
const GENERIC: Record<string, Habit> = { "pm.comments": h(30, 2), "meetings.recorded": h(25, 1), "checkins.submitted": h(50, 1) };

/** Work titles by kind: the work's own name, never message or comment text. */
const TITLES: Record<string, string[]> = {
  "pm.tasks_completed": ["Draft onboarding flow", "Keyword gap analysis", "Push notifications spike", "Review homepage copy", "Fix checkout redirect"],
  "pm.comments": ["Comment on Draft onboarding flow", "Comment on Keyword gap analysis", "Comment on Push notifications spike"],
  "pm.docs": ["Notes: kickoff", "Notes: launch checklist", "Doc: tone of voice"],
  "github.commits": ["Fix header spacing on mobile", "Add sitemap route", "Refactor nav component", "Update dependencies", "Tighten form validation"],
  "github.pull_requests": ["Pull request: footer redesign", "Pull request: faster image loading"],
  "webdesk.edits": ["Edited: Home page", "Edited: About us", "Edited: Pricing", "Restored a version of: Contact"],
  "webdesk.publishes": ["Published: northwind.example", "Rebuilt: northwind.example"],
  "social.posts": ["Post: spring campaign teaser", "Post: product launch reel"],
  "seo.audits": ["Audit: northwind.example"],
  "seo.briefs": ["Brief: winter boots guide", "Brief: size chart explainer", "Brief: care instructions"],
  "seo.reports": ["Report: July performance"],
  "creatives.versions": ["Version: homepage hero", "Version: campaign banner"],
  "creatives.reviews": ["Approved: campaign banner", "Changes requested: homepage hero"],
  "finance.journals": ["Journal posted: accrued expenses", "Journal posted: month-end revenue"],
  "hr.leave_decided": ["Leave decided"],
  "meetings.recorded": ["Meeting: weekly sync", "Meeting: client review", "Meeting: sprint planning"],
  "learning.completed": ["Completed: Using the ERP"],
  "time.logged": ["Time logged: Keyword research", "Time logged: Onboarding flow draft"],
  "checkins.submitted": ["Daily check-in"],
};
/** The demo's own tasks have pages, so a completed task links to one. */
const TASK_LINKS = ["/tasks/t-1", "/tasks/t-6", "/tasks/t-9"];

// ── The gate (BFF section 44.3) ───────────────────────────────────────────────────────────────────

const CLIENT_IDENTITIES = new Set(["demo-client", "demo-client-admin", "demo-client-viewer", "demo-two-company-client"]);
const COMPANY_WIDE = new Set(["demo-hansel", "demo-owner"]);
/** The people on the roster of the unit each head leads (the same rosters `demoReports.ts` serves). */
const LED_ROSTER: Record<string, string[]> = {
  "u-webhead": ["u-dev", "u-pm"],
  "dept-manager": ["gede-ic", "seo-staff"],
};

function mayRead(caller: string, subject: string): boolean {
  if (caller === subject) return true;
  if (COMPANY_WIDE.has(caller)) return true;
  return (LED_ROSTER[caller] ?? []).includes(subject);
}

// ── Deterministic counts ──────────────────────────────────────────────────────────────────────────

function hash(...parts: string[]): number {
  let x = 2166136261;
  for (const part of parts) {
    for (const ch of part) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
    x = Math.imul(x ^ 124, 16777619) >>> 0;
  }
  return x;
}

const isWeekend = (iso: string): boolean => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
};

function countOf(user: string, kind: string, date: string, habit: Habit): number {
  const x = hash(user, kind, date);
  // Weekends are mostly quiet: a third of the usual rate.
  const rate = isWeekend(date) ? Math.floor(habit.rate / 3) : habit.rate;
  if (x % 100 >= rate) return 0;
  return 1 + (x >>> 8) % habit.cap;
}

const habitsOf = (user: string): Record<string, Habit> => HABITS[user] ?? GENERIC;

function addDaysIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}
const todayIso = (): string => new Date().toISOString().slice(0, 10);
const isRealDate = (s: string): boolean => DATE_RE.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
const windowDays = (from: string, to: string): number => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

function countsFor(user: string, date: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [kind, habit] of Object.entries(habitsOf(user))) {
    const n = countOf(user, kind, date, habit);
    if (n > 0) counts[kind] = n;
  }
  return counts;
}

// ── The routes ────────────────────────────────────────────────────────────────────────────────────

/** Both reads. Returns null for any path that is not one of them. */
export function activityDemo(method: string, p: string, search: URLSearchParams, userId: string): DemoResult | null {
  const m = p.match(/^\/api\/[^/]+\/activity\/(series|day)$/);
  if (!m || method.toUpperCase() !== "GET") return null;

  // Same order as the controller: the wall, the userId, the person-axis gate, then the dates.
  if (CLIENT_IDENTITIES.has(userId)) return err(403, "not a member of this company");
  const subject = search.get("userId") ?? "";
  if (subject === "") return err(400, "userId must be a valid uuid", "userId");
  if (!mayRead(userId, subject)) return err(403, "outside your reporting line");

  if (m[1] === "series") {
    const to = search.get("to") || todayIso();
    if (!isRealDate(to)) return err(400, "to must be a YYYY-MM-DD date", "to");
    const from = search.get("from") || addDaysIso(to, -(DEFAULT_WINDOW_DAYS - 1));
    if (!isRealDate(from)) return err(400, "from must be a YYYY-MM-DD date", "from");
    if (to < from) return err(400, "to must be on or after from", "to");
    if (windowDays(from, to) > MAX_WINDOW_DAYS) return err(400, `range too large (max ${MAX_WINDOW_DAYS} days)`, "from");

    const days: { date: string; counts: Record<string, number> }[] = [];
    const totals: Record<string, number> = {};
    for (let d = from; d <= to; d = addDaysIso(d, 1)) {
      const counts = countsFor(subject, d);
      days.push({ date: d, counts });
      for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
    }
    // No `total` and no `score` (DW-D19).
    return ok({ userId: subject, from, to, timezone: TIMEZONE, kinds: KINDS, days, totals });
  }

  const date = search.get("date") || todayIso();
  if (!isRealDate(date)) return err(400, "date must be a YYYY-MM-DD date", "date");
  const labelOf = new Map(KINDS.map((k) => [k.key, k.label]));
  const items: { kind: string; title: string; at: string; link?: string }[] = [];
  for (const [kind, n] of Object.entries(countsFor(subject, date))) {
    const names = TITLES[kind] ?? [labelOf.get(kind) ?? kind];
    for (let i = 0; i < n; i++) {
      const x = hash(subject, kind, date, String(i));
      const hh = String(8 + (x % 10)).padStart(2, "0");
      const mm = String((x >>> 4) % 60).padStart(2, "0");
      const link = kind === "pm.tasks_completed" ? TASK_LINKS[x % TASK_LINKS.length] : undefined;
      items.push({ kind, title: names[x % names.length], at: `${date}T${hh}:${mm}:00.000Z`, ...(link ? { link } : {}) });
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return ok({ userId: subject, date, items: items.slice(0, DAY_ITEM_LIMIT) });
}
