import "server-only";
// SCP-5h (BFF §63.29) — what DEMO_MODE answers for client onboarding, in the server's order of checks:
//
//   GET   onboarding                              {template, items, canStart}
//   POST  engagements/:engagementId/onboarding    404 `engagement_not_found`, 403 `not_a_social_approver`, 400, 409 `no_project`, 409 `template_already_applied`, then 201 (200 for a replayed id)
//   POST  audits                                  only for an onboarding client: the "Open baseline audit" button (the audit pages themselves are SCP-5g's UI)
//   PATCH <pm>/tasks/:taskId                      a tick (PM's own route), for an onboarding task
//   PATCH <pm>/template-applications/:id          the kickoff move (PM's own route): re-dates the open steps, never a done one
//
// THE DATA is invented and mock-worded: the seeded template ("Social media client onboarding", the team's fifteen steps in six phases, reworded; the roles are the lead, the officer and
// the client, whose steps the officer chases), Larkspur Bakery mid-onboarding (five steps done, TWO late: two inputs the client still owes), and Tidewater Surf School not started.
// The kickoff is placed from today so the two late steps are late on any day: it is six working days before the first working day on or after today, so every step due at 5 working days
// or fewer is already past and every step due at 6 or more is not.
//
// THE GATES. Starting needs the four (`isDemoSocialApprover`) and, as the server does, the project's manage right, which the demo gives to the same four. A tick is any staff member's;
// the kickoff move is the four's (a refusal is the bare `not authorized` 403 PM gives). The page's own words for each refusal are in `socialOnboarding.ts`.
import { demoWalkBack, isClientContact, isDemoSocialApprover, who, type DemoResult } from "./demoSocialPipeline";
import { todayIsoInDisplayZone } from "./format";
import { groupByPhase, type Onboarding, type OnboardingItem, type OnboardingStep } from "./socialOnboarding";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const UUIDISH = /^[\w-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── the template ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DEMO_ONBOARDING_TEMPLATE = { id: "onb-tpl-1", name: "Social media client onboarding" };
export const DEMO_ONBOARDING_PHASES = [
  { key: "kickoff", title: "Kickoff" }, { key: "access", title: "Access" }, { key: "brand", title: "Brand inputs" },
  { key: "baseline", title: "Baseline audit" }, { key: "strategy", title: "Strategy" }, { key: "first", title: "First cycle" },
] as const;
export const DEMO_ONBOARDING_ROLES: Readonly<Record<string, string>> = { lead: "Lead", officer: "Officer", client: "Client" };
interface TemplateStep { key: string; title: string; phase: string; role: string; offset: number }
export const DEMO_ONBOARDING_STEPS: readonly TemplateStep[] = [
  { key: "meet", title: "Kickoff meeting held and its notes shared", phase: "kickoff", role: "lead", offset: 0 },
  { key: "chat", title: "Chat groups opened with the client", phase: "kickoff", role: "lead", offset: 0 },
  { key: "meta", title: "Partner access to the client's Meta tools granted", phase: "access", role: "officer", offset: 2 },
  { key: "networks", title: "Access to the other networks in scope granted", phase: "access", role: "officer", offset: 2 },
  { key: "folder", title: "The client's shared folder linked to this project", phase: "access", role: "lead", offset: 3 },
  { key: "logo", title: "Logo, fonts and brand guide received", phase: "brand", role: "client", offset: 5 },
  { key: "library", title: "Photo and video library, or the last agency's handover, received", phase: "brand", role: "client", offset: 5 },
  { key: "rules", title: "Dos and don'ts, must-haves and approval contacts agreed", phase: "brand", role: "client", offset: 6 },
  { key: "audit", title: "The client's baseline audit finalized", phase: "baseline", role: "officer", offset: 8 },
  { key: "pillars", title: "Pillars, tone and format mix agreed", phase: "strategy", role: "lead", offset: 10 },
  { key: "kpis", title: "KPIs and the monthly report's format and day agreed", phase: "strategy", role: "lead", offset: 10 },
  { key: "alloc", title: "Officer, batch and monthly target set in the allocation", phase: "strategy", role: "lead", offset: 11 },
  { key: "plan", title: "The first content plan approved by the client", phase: "first", role: "officer", offset: 15 },
  { key: "portal", title: "The client's portal contacts invited", phase: "first", role: "lead", offset: 16 },
  { key: "scheduled", title: "The first posts scheduled", phase: "first", role: "officer", offset: 20 },
];

// ── dates (Monday to Friday; the demo has no holiday data) ───────────────────────────────────────────────────────────────────

const dow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isWeekday = (iso: string): boolean => dow(iso) !== 0 && dow(iso) !== 6;
/** The first working day on or after `iso`. */
export const demoFirstWorkingOnOrAfter = (iso: string): string => { let d = iso; while (!isWeekday(d)) d = shift(d, 1); return d; };
/** `n` working days after the start day (the kickoff, or the next working day when it is a day off). */
export function demoDueDate(kickoff: string, n: number): string {
  let d = demoFirstWorkingOnOrAfter(kickoff);
  for (let left = n; left > 0; ) { d = shift(d, 1); if (isWeekday(d)) left -= 1; }
  return d;
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DemoStep { key: string; taskId: string; done: boolean; dueDate: string }
interface DemoApplication { id: string; engagementId: string; kickoff: string; steps: DemoStep[] }
interface DemoClient { engagementId: string; clientId: string; clientName: string; status: string; officerId: string; projectId: string | null; auditId: string | null }
interface Store { clients: DemoClient[]; apps: DemoApplication[]; auditSeq: number }

const STORE = Symbol.for("gaiada.demoSocialOnboarding.store");
type G = typeof globalThis & { [STORE]?: Store };

function appFor(id: string, engagementId: string, kickoff: string, doneKeys: readonly string[]): DemoApplication {
  return {
    id, engagementId, kickoff,
    steps: DEMO_ONBOARDING_STEPS.map((s) => ({ key: s.key, taskId: `onb-t-${id}-${s.key}`, done: doneKeys.includes(s.key), dueDate: demoDueDate(kickoff, s.offset) })),
  };
}

function seed(): Store {
  const today = todayIsoInDisplayZone();
  // Six working days before the first working day on or after today: every step due within 5 working days is already past, every step due at 6 or more is not.
  const kickoff = demoWalkBack(demoFirstWorkingOnOrAfter(today), 6);
  return {
    auditSeq: 0,
    clients: [
      { engagementId: "onb-eng-1", clientId: "onb-cl-1", clientName: "Larkspur Bakery", status: "draft", officerId: "u-social", projectId: "onb-proj-1", auditId: null },
      { engagementId: "onb-eng-2", clientId: "onb-cl-2", clientName: "Tidewater Surf School", status: "draft", officerId: "u-social-2", projectId: "onb-proj-2", auditId: null },
    ],
    // Five steps done; the two the client still owes (logo, library) are the late ones.
    apps: [appFor("onb-app-1", "onb-eng-1", kickoff, ["meet", "chat", "meta", "networks", "folder"])],
  };
}
const store = (): Store => ((globalThis as G)[STORE] ??= seed());
/** Test hook: back to the seed. */
export function resetDemoOnboarding(): void { delete (globalThis as G)[STORE]; }

// ── the answer ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const lateOf = (dueDate: string | null, done: boolean, today: string): boolean => !done && dueDate !== null && dueDate < today;

function itemOf(c: DemoClient, today: string): OnboardingItem {
  const app = store().apps.find((a) => a.engagementId === c.engagementId) ?? null;
  const steps: OnboardingStep[] = app
    ? app.steps.map((s) => {
      const t = DEMO_ONBOARDING_STEPS.find((x) => x.key === s.key)!;
      return {
        key: s.key, taskId: s.taskId, title: t.title, phase: t.phase, phaseTitle: DEMO_ONBOARDING_PHASES.find((p) => p.key === t.phase)!.title, role: t.role,
        roleLabel: DEMO_ONBOARDING_ROLES[t.role], dueDate: s.dueDate, done: s.done, late: lateOf(s.dueDate, s.done, today),
      };
    })
    : [];
  const open = steps.filter((s) => !s.done);
  // earliest due first; template order breaks a tie (the server's rule)
  const next = open.reduce<OnboardingStep | null>((m, s) => (m === null || (s.dueDate !== null && (m.dueDate === null || s.dueDate < m.dueDate)) ? s : m), null);
  return {
    engagementId: c.engagementId, clientId: c.clientId, clientName: c.clientName, engagementStatus: c.status, officer: who(c.officerId), projectId: c.projectId,
    applicationId: app?.id ?? null, kickoff: app?.kickoff ?? null, progress: { done: steps.length - open.length, total: steps.length },
    next: next ? { taskId: next.taskId, title: next.title, dueDate: next.dueDate, late: next.late } : null,
    baselineAudit: c.auditId ? { auditId: c.auditId, status: "draft", overall: null } : null,
    steps, doneStatusId: "done", startBlock: app ? null : c.projectId ? null : "no_project",
  };
}

/** The sort the server applies: started clients first (soonest next step first), then the others by name. */
function sorted(items: OnboardingItem[]): OnboardingItem[] {
  return [...items].sort((a, z) => {
    const sa = a.applicationId !== null; const sz = z.applicationId !== null;
    if (sa !== sz) return sa ? -1 : 1;
    if (sa) {
      const ad = a.next?.dueDate ?? null; const zd = z.next?.dueDate ?? null;
      if (ad !== zd) return ad === null ? 1 : zd === null ? -1 : ad < zd ? -1 : 1;
    }
    return a.clientName.localeCompare(z.clientName);
  });
}

export function demoOnboarding(userId: string): Onboarding {
  const today = todayIsoInDisplayZone();
  return { template: DEMO_ONBOARDING_TEMPLATE, items: sorted(store().clients.map((c) => itemOf(c, today))), canStart: isDemoSocialApprover(userId) };
}

/** The checklist's phases, for a test. */
export const demoPhasesOf = (i: OnboardingItem) => groupByPhase(i.steps);

// ── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The social routes; null for a path that is not onboarding's. `tail` is the path after `/modules/social/`. */
export function demoOnboardingRoute(m: string, tail: string, body: string | undefined, userId: string): DemoResult | null {
  if (tail === "onboarding" && m === "GET") {
    if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_post");
    return ok(demoOnboarding(userId));
  }
  const startM = tail.match(/^engagements\/([^/]+)\/onboarding$/);
  if (startM && m === "POST") return start(startM[1], body, userId);
  if (tail === "audits" && m === "POST") {
    let b: unknown = null;
    try { b = body ? JSON.parse(body) : null; } catch { b = null; }
    const c = isObj(b) && typeof b.engagementId === "string" ? store().clients.find((x) => x.engagementId === b.engagementId) : undefined;
    if (!c) return null; // not an onboarding client: the audit pages' own demo (SCP-5g's UI) answers
    if (!c.auditId) { store().auditSeq += 1; c.auditId = `onb-audit-${store().auditSeq}`; return ok({ audit: { id: c.auditId }, created: true }, 201); }
    return ok({ audit: { id: c.auditId }, created: false });
  }
  return null;
}

function start(engagementId: string, body: string | undefined, userId: string): DemoResult {
  const c = store().clients.find((x) => x.engagementId === engagementId);
  if (!c) return err(404, "engagement_not_found");
  if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
  let b: unknown = null;
  try { b = body ? JSON.parse(body) : null; } catch { b = null; }
  const o = isObj(b) ? b : {};
  if (typeof o.id !== "string" || !UUIDISH.test(o.id)) return err(400, "invalid_field", { field: "id" });
  if (typeof o.kickoff !== "string" || !DAY.test(o.kickoff) || Number.isNaN(Date.parse(`${o.kickoff}T00:00:00Z`)) || new Date(`${o.kickoff}T00:00:00Z`).toISOString().slice(0, 10) !== o.kickoff) {
    return err(400, "invalid_field", { field: "kickoff" });
  }
  if (!c.projectId) return err(409, "no_project");
  const s = store();
  const same = s.apps.find((a) => a.id === o.id);
  if (same && same.engagementId === c.engagementId) return ok({ applicationId: same.id, tasks: same.steps.map((t) => ({ key: t.key, taskId: t.taskId, dueDate: t.dueDate })), milestones: [] });
  const already = s.apps.find((a) => a.engagementId === c.engagementId);
  if (already) return err(409, "template_already_applied", { detail: { applicationId: already.id } });
  const app = appFor(o.id, c.engagementId, o.kickoff, []);
  s.apps.push(app);
  return ok({ applicationId: app.id, tasks: app.steps.map((t) => ({ key: t.key, taskId: t.taskId, dueDate: t.dueDate })), milestones: [] }, 201);
}

/** PM's two routes onboarding uses, for an onboarding task or application (`path` is the full path); null for anything else, so PM's own demo answers. */
export function demoOnboardingPmRoute(m: string, path: string, body: string | undefined, userId: string): DemoResult | null {
  let b: unknown = null;
  try { b = body ? JSON.parse(body) : null; } catch { b = null; }
  const o = isObj(b) ? b : {};
  const taskM = path.match(/^\/api\/[^/]+\/pm\/tasks\/(onb-t-[^/]+)$/);
  if (taskM && m === "PATCH") {
    for (const a of store().apps) {
      const step = a.steps.find((x) => x.taskId === taskM[1]);
      if (!step) continue;
      if (isClientContact(userId)) return err(403, "not authorized: cerbos denied update on pm_task");
      if (typeof o.status !== "string" || o.status !== "done") return err(400, "invalid status");
      step.done = true;
      return ok({ id: step.taskId, status: "done" });
    }
    return err(404, "task not found");
  }
  const moveM = path.match(/^\/api\/[^/]+\/pm\/template-applications\/([^/]+)$/);
  if (moveM && m === "PATCH") {
    const app = store().apps.find((a) => a.id === moveM[1]);
    if (!app) return null; // not an onboarding application of this store: PM's own demo answers
    if (typeof o.kickoff !== "string" || !DAY.test(o.kickoff) || new Date(`${o.kickoff}T00:00:00Z`).toISOString().slice(0, 10) !== o.kickoff) return err(400, "invalid_field", { field: "kickoff" });
    if (!isDemoSocialApprover(userId)) return err(403, "not authorized: cerbos denied manage on pm_project");
    app.kickoff = o.kickoff;
    for (const s of app.steps) {
      if (s.done) continue;
      const t = DEMO_ONBOARDING_STEPS.find((x) => x.key === s.key)!;
      s.dueDate = demoDueDate(o.kickoff, t.offset);
    }
    const c = store().clients.find((x) => x.engagementId === app.engagementId)!;
    const item = itemOf(c, todayIsoInDisplayZone());
    return ok({ id: app.id, kickoff: app.kickoff, progress: item.progress, next: item.next });
  }
  return null;
}
