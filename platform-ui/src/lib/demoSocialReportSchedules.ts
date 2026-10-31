import "server-only";
// SCP-5 W5-A6 (BFF §63.24.9) — what DEMO_MODE answers for report automation, in the server's order of checks:
//
//   GET    report-schedules                  {items: [Schedule]}
//   POST   report-schedules                  201 {schedule, created}; 200 for a replayed id; 409 `schedule_exists` for a second all-clients schedule of a kind
//   PATCH  report-schedules/:id              {scope?, engagementIds?, timing?, enabled?}; the caller becomes the owner; resuming clears the pause
//   DELETE report-schedules/:id              a soft delete
//   POST   report-schedules/:id/run          "Run now": 202 `{runId, kind, period, total, clients}`, 200 `{alreadyApplied, runId, period}`, 409 `generation_running`
//   GET    reports/generate/:runId           ONLY a run this file made or seeded (id `demo-sched-run-…`): progress and usage; any other id is left to the Reports page's own demo
//
// THE ORDER OF CHECKS is the server's own (`report-schedules.ts`): an automation account 403 `automation_cannot_act`, then anyone but the four 403 `not_a_social_approver` (a client contact
// included), then 404 `schedule_not_found`, then 400 `invalid_field` `{field}` (the body's keys first, then each part in the server's order), then 409.
//
// THE DATA is invented and mock-worded: a weekly schedule on all clients (Monday 08:00) whose last run settled, with its spend, and a monthly one on two clients paused because its owner may no
// longer run it (its last period is the month that just ended, so "Run now" on it answers `alreadyApplied`). The days are worked out with Monday to Friday and no holidays (the demo has none),
// in UTC. A run made here settles a client a second, so its progress can be watched.
import { PIPE_ENGAGEMENTS, isDemoSocialApprover, pipelineEngagement, who, type DemoResult } from "./demoSocialPipeline";
import {
  MAX_CHOSEN_CLIENTS, SCHEDULE_KINDS, addDays, lastEndedPeriod, previewRuns, timingWords, type PausedReason, type ScheduleKind, type Spend, type Timing,
} from "./socialReportSchedules";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const bad = (field: string): DemoResult => err(400, "invalid_field", { field });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const UUIDISH = /^[\w-]{1,64}$/;
const isAutomation = (userId: string): boolean => /^(demo-)?(automation|bot)\b/.test(userId);

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface DemoRun {
  id: string; scheduleId: string; kind: ScheduleKind; period: string; total: number; createdMs: number; created: number; skipped: number; missed: number;
  /** A seeded run is already settled; one this store made settles a client a second. */
  seeded: boolean;
}
interface DemoSchedule {
  id: string; ownerId: string; ownerName: string | null; kind: ScheduleKind; scope: "all" | "chosen"; engagementIds: string[]; timing: Timing; enabled: boolean;
  pausedReason: PausedReason | null; lastRunAt: string | null; lastPeriod: string | null; deleted: boolean;
  /** The spend of the runs before the ones this store made (invented): the last 30 days and the month so far. */
  base: { d30: Spend; mtd: Spend };
}
interface Store { schedules: DemoSchedule[]; runs: DemoRun[]; seq: number }
const STORE = "__demoReportSchedules";
type G = typeof globalThis & { [STORE]?: Store };

const PER_CALL = { promptTokens: 1800, completionTokens: 650, costUsd: 0.0061 };
const MS_PER_CLIENT = 1000;
const DAY_MS = 86_400_000;
const today = (): string => new Date().toISOString().slice(0, 10);
const activeClients = (): string[] => PIPE_ENGAGEMENTS.filter((e) => e.status !== "closed").map((e) => e.id);
const noSpend = (): Spend => ({ runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null });
const spendOfCalls = (runs: number, calls: number): Spend => calls === 0
  ? { ...noSpend(), runs }
  : { runs, calls, promptTokens: calls * PER_CALL.promptTokens, completionTokens: calls * PER_CALL.completionTokens, costUsd: Number((calls * PER_CALL.costUsd).toFixed(6)) };

function seed(): Store {
  const t = today();
  const all = activeClients();
  const weekly = Math.max(0, all.length - 1);
  const s: Store = { schedules: [], runs: [], seq: 0 };
  s.schedules.push({
    id: "demo-sched-1", ownerId: "u-pm", ownerName: null, kind: "weekly", scope: "all", engagementIds: [], timing: { weekday: 1, at: "08:00" }, enabled: true, pausedReason: null,
    lastRunAt: new Date(Date.now() - 4 * DAY_MS).toISOString(), lastPeriod: lastEndedPeriod("weekly", addDays(t, -7)), deleted: false,
    base: { d30: spendOfCalls(3, 3 * weekly), mtd: spendOfCalls(2, 2 * weekly) },
  });
  s.schedules.push({
    id: "demo-sched-2", ownerId: "u-social-gone", ownerName: "Wayan Sari", kind: "monthly", scope: "chosen", engagementIds: all.slice(0, 2), timing: { on: "working_day", n: 3, at: "08:00" }, enabled: false,
    pausedReason: "owner_not_allowed", lastRunAt: new Date(Date.now() - 12 * DAY_MS).toISOString(), lastPeriod: lastEndedPeriod("monthly", t), deleted: false,
    base: { d30: spendOfCalls(1, Math.min(2, all.length)), mtd: noSpend() },
  });
  s.runs.push({ id: "demo-sched-run-seed-1", scheduleId: "demo-sched-1", kind: "weekly", period: lastEndedPeriod("weekly", addDays(t, -7)), total: all.length, createdMs: Date.now() - 4 * DAY_MS, created: weekly, skipped: all.length > 0 ? 1 : 0, missed: 0, seeded: true });
  s.runs.push({ id: "demo-sched-run-seed-2", scheduleId: "demo-sched-2", kind: "monthly", period: lastEndedPeriod("monthly", t), total: Math.min(2, all.length), createdMs: Date.now() - 12 * DAY_MS, created: Math.min(2, all.length), skipped: 0, missed: 1, seeded: true });
  return s;
}
const store = (): Store => ((globalThis as G)[STORE] ??= seed());
/** Test hook: back to the seed. */
export function resetDemoReportSchedules(): void { delete (globalThis as G)[STORE]; }

// ── the reads ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A run's progress at `nowMs`. */
function progressOf(r: DemoRun, nowMs: number) {
  const done = r.seeded ? r.total : Math.min(r.total, Math.floor((nowMs - r.createdMs) / MS_PER_CLIENT));
  const status = done >= r.total ? "done" : done > 0 ? "running" : "queued";
  const created = status === "done" ? r.created : Math.min(r.created, done);
  return { done, status, created, usage: spendOfCalls(1, created) };
}

/** Base spend plus the runs this store made (they count from the moment they start). */
function spendOf(sc: DemoSchedule, which: "d30" | "mtd", nowMs: number): Spend {
  const base = sc.base[which];
  const mine = store().runs.filter((r) => r.scheduleId === sc.id && !r.seeded);
  const calls = base.calls + mine.reduce((n, r) => n + progressOf(r, nowMs).created, 0);
  const out = spendOfCalls(base.runs + mine.length, calls);
  return out;
}

function nextOf(sc: DemoSchedule): { at: string | null; period: string | null } {
  if (!sc.enabled) return { at: null, period: null };
  const n = previewRuns(sc.kind, sc.timing, Date.now(), 1)?.[0];
  return n ? { at: `${n.runDay}T${n.at}:00.000Z`, period: n.period } : { at: null, period: null };
}

function viewOf(sc: DemoSchedule) {
  const nowMs = Date.now();
  const names = new Map(PIPE_ENGAGEMENTS.map((e) => [e.id, e.clientName]));
  const last = [...store().runs].reverse().find((r) => r.scheduleId === sc.id);
  const lp = last ? progressOf(last, nowMs) : null;
  const next = nextOf(sc);
  return {
    id: sc.id, kind: sc.kind, scope: sc.scope, clients: sc.engagementIds.map((id) => ({ engagementId: id, clientName: names.get(id) ?? "" })),
    timing: sc.timing, timingText: timingWords(sc.kind, sc.timing), enabled: sc.enabled, pausedReason: sc.pausedReason,
    owner: sc.ownerName ? { id: sc.ownerId, name: sc.ownerName } : who(sc.ownerId),
    nextRunAt: next.at, nextPeriod: next.period, lastRunAt: sc.lastRunAt, lastPeriod: sc.lastPeriod,
    lastRun: last && lp ? { runId: last.id, status: lp.status, created: lp.created, existing: 0, skipped: last.skipped, failed: 0, missed: last.missed } : null,
    spend: { last30Days: spendOf(sc, "d30", nowMs), monthToDate: spendOf(sc, "mtd", nowMs) },
  };
}

// ── the body, in the server's order ──────────────────────────────────────────────────────────────────────────────────────

const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const TIMING_FIELDS = ["timing.at", "timing.weekday", "timing.on", "timing.day", "timing.n"];

/** The server's `parseTiming`: the first bad part's field, or the timing with only the kind's keys. */
function parseTiming(kind: ScheduleKind, raw: unknown): { ok: true; timing: Timing } | { ok: false; field: string } {
  if (!isObj(raw)) return { ok: false, field: "timing" };
  const allowed = kind === "daily" ? ["at"] : kind === "weekly" ? ["weekday", "at"] : raw.on === "working_day" ? ["on", "n", "at"] : ["on", "day", "at"];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) return { ok: false, field: TIMING_FIELDS.includes(`timing.${k}`) ? `timing.${k}` : "timing" };
  if (kind === "weekly" && !isInt(raw.weekday, 1, 7)) return { ok: false, field: "timing.weekday" };
  if (kind !== "daily" && kind !== "weekly") {
    if (raw.on !== "day" && raw.on !== "working_day") return { ok: false, field: "timing.on" };
    if (raw.on === "day" && !isInt(raw.day, 1, 28)) return { ok: false, field: "timing.day" };
    if (raw.on === "working_day" && !isInt(raw.n, 1, 20)) return { ok: false, field: "timing.n" };
  }
  if (typeof raw.at !== "string" || !AT.test(raw.at)) return { ok: false, field: "timing.at" };
  if (kind === "daily") return { ok: true, timing: { at: raw.at } };
  if (kind === "weekly") return { ok: true, timing: { weekday: raw.weekday as number, at: raw.at } };
  return { ok: true, timing: raw.on === "day" ? { on: "day", day: raw.day as number, at: raw.at } : { on: "working_day", n: raw.n as number, at: raw.at } };
}

function idsOf(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHOSEN_CLIENTS || !raw.every((x) => typeof x === "string" && x)) return null;
  return [...new Set(raw as string[])];
}
const parse = (body: string | undefined): unknown => { try { return body ? JSON.parse(body) : null; } catch { return undefined; } };
const emptyList = (v: unknown): boolean => Array.isArray(v) && v.length === 0;

function gate(userId: string): DemoResult | null {
  if (isAutomation(userId)) return err(403, "automation_cannot_act");
  if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
  return null;
}

function create(body: string | undefined, userId: string): DemoResult {
  const raw = parse(body);
  if (raw === undefined || (raw !== null && !isObj(raw))) return bad("body");
  const b = raw ?? {};
  for (const k of Object.keys(b)) if (!["id", "kind", "scope", "engagementIds", "timing", "enabled"].includes(k)) return bad(k);
  if (b.id !== undefined && (typeof b.id !== "string" || !UUIDISH.test(b.id))) return bad("id");
  const s = store();
  if (typeof b.id === "string") {
    const prior = s.schedules.find((x) => x.id === b.id);
    if (prior) return ok({ schedule: viewOf(prior), created: false });
  }
  if (typeof b.kind !== "string" || !(SCHEDULE_KINDS as readonly string[]).includes(b.kind)) return bad("kind");
  const kind = b.kind as ScheduleKind;
  if (b.scope !== "all" && b.scope !== "chosen") return bad("scope");
  let ids: string[] = [];
  if (b.scope === "chosen") { const x = idsOf(b.engagementIds); if (!x) return bad("engagementIds"); ids = x; }
  else if (b.engagementIds !== undefined && !emptyList(b.engagementIds)) return bad("engagementIds");
  if (b.timing === undefined) return bad("timing");
  const t = parseTiming(kind, b.timing);
  if (!t.ok) return bad(t.field);
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad("enabled");
  if (ids.some((id) => !pipelineEngagement(id))) return bad("engagementIds");
  if (b.scope === "all") {
    const dupe = s.schedules.find((x) => !x.deleted && x.kind === kind && x.scope === "all");
    if (dupe) return err(409, "schedule_exists", { detail: { scheduleId: dupe.id } });
  }
  const enabled = b.enabled !== false;
  s.seq += 1;
  const sc: DemoSchedule = {
    id: typeof b.id === "string" ? b.id : `demo-sched-new-${s.seq}`, ownerId: userId, ownerName: null, kind, scope: b.scope, engagementIds: ids, timing: t.timing, enabled,
    pausedReason: enabled ? null : "manual", lastRunAt: null, lastPeriod: null, deleted: false, base: { d30: noSpend(), mtd: noSpend() },
  };
  s.schedules.push(sc);
  return ok({ schedule: viewOf(sc), created: true }, 201);
}

function update(sc: DemoSchedule, body: string | undefined, userId: string): DemoResult {
  const raw = parse(body);
  if (raw === undefined || (raw !== null && !isObj(raw))) return bad("body");
  const b = raw ?? {};
  for (const k of Object.keys(b)) if (!["scope", "engagementIds", "timing", "enabled"].includes(k)) return bad(k);
  if (b.scope !== undefined && b.scope !== "all" && b.scope !== "chosen") return bad("scope");
  const scope = (b.scope as "all" | "chosen" | undefined) ?? sc.scope;
  let ids: string[] | undefined;
  if (scope === "chosen") {
    if (b.engagementIds !== undefined) { const x = idsOf(b.engagementIds); if (!x) return bad("engagementIds"); ids = x; }
    else if (sc.scope !== "chosen") return bad("engagementIds");
  } else if (b.engagementIds !== undefined && !emptyList(b.engagementIds)) return bad("engagementIds");
  else ids = [];
  let timing: Timing | null = null;
  if (b.timing !== undefined) { const t = parseTiming(sc.kind, b.timing); if (!t.ok) return bad(t.field); timing = t.timing; }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") return bad("enabled");
  if (ids && ids.some((id) => !pipelineEngagement(id))) return bad("engagementIds");
  if (scope === "all" && sc.scope !== "all") {
    const dupe = store().schedules.find((x) => x !== sc && !x.deleted && x.kind === sc.kind && x.scope === "all");
    if (dupe) return err(409, "schedule_exists", { detail: { scheduleId: dupe.id } });
  }
  sc.ownerId = userId;
  sc.ownerName = null;
  sc.scope = scope;
  if (ids) sc.engagementIds = ids;
  if (timing) sc.timing = timing;
  if (b.enabled === false && sc.enabled) { sc.enabled = false; sc.pausedReason = "manual"; }
  if (b.enabled === true && !sc.enabled) { sc.enabled = true; sc.pausedReason = null; }
  return ok({ schedule: viewOf(sc) });
}

function runNow(sc: DemoSchedule): DemoResult {
  const s = store();
  const period = lastEndedPeriod(sc.kind, today());
  const prior = s.runs.find((r) => r.scheduleId === sc.id && r.period === period);
  if (prior) return ok({ alreadyApplied: true, runId: prior.id, period });
  const going = s.runs.find((r) => r.kind === sc.kind && r.period === period && progressOf(r, Date.now()).status !== "done");
  if (going) return err(409, "generation_running", { detail: { runId: going.id } });
  const clients = sc.scope === "chosen" ? sc.engagementIds.filter((id) => pipelineEngagement(id)) : activeClients();
  s.seq += 1;
  const run: DemoRun = { id: `demo-sched-run-${s.seq}`, scheduleId: sc.id, kind: sc.kind, period, total: clients.length, createdMs: Date.now(), created: clients.length, skipped: 0, missed: 0, seeded: false };
  s.runs.push(run);
  const names = new Map(PIPE_ENGAGEMENTS.map((e) => [e.id, e.clientName]));
  return ok({ runId: run.id, kind: run.kind, period, total: run.total, clients: clients.map((id) => ({ engagementId: id, clientName: names.get(id) ?? "" })) }, 202);
}

export function demoReportSchedulesRoute(m: string, tail: string, body: string | undefined, userId: string): DemoResult | null {
  const runM = tail.match(/^reports\/generate\/(demo-sched-run-[\w-]+)$/);
  if (runM && m === "GET") {
    const r = store().runs.find((x) => x.id === runM[1]);
    if (!r) return null;
    const refused = gate(userId);
    if (refused) return refused;
    const p = progressOf(r, Date.now());
    return ok({
      runId: r.id, kind: r.kind, period: r.period, status: p.status, total: r.total, done: p.done, results: [], startedAt: new Date(r.createdMs).toISOString(),
      finishedAt: p.status === "done" ? new Date(r.createdMs + r.total * MS_PER_CLIENT).toISOString() : null, trigger: r.seeded ? "schedule" : "run_now", scheduleId: r.scheduleId,
      usage: { calls: p.usage.calls, promptTokens: p.usage.promptTokens, completionTokens: p.usage.completionTokens, costUsd: p.usage.costUsd },
    });
  }
  if (tail === "report-schedules" && (m === "GET" || m === "POST")) {
    const refused = gate(userId);
    if (refused) return refused;
    return m === "GET" ? ok({ items: store().schedules.filter((x) => !x.deleted).map(viewOf) }) : create(body, userId);
  }
  const one = tail.match(/^report-schedules\/([^/]+)(\/run)?$/);
  if (!one) return null;
  const refused = gate(userId);
  if (refused) return refused;
  const sc = store().schedules.find((x) => x.id === one[1] && !x.deleted);
  if (!sc) return err(404, "schedule_not_found");
  if (one[2]) return m === "POST" ? runNow(sc) : null;
  if (m === "PATCH") return update(sc, body, userId);
  if (m === "DELETE") { sc.deleted = true; return ok({ id: sc.id, deleted: true }); }
  return null;
}
