import "server-only";
// SCP-5 W5-A4 (BFF §63.24.5, §63.30.4) — what DEMO_MODE answers for "Generate with AI" for every client, and for the company's rules the report pages read:
//
//   POST  reports/generate           start a run for every client the person may draft for      GET  reports/generate/:runId   the run's progress, each client's result as it lands
//   GET   reports/generate           the last 30 days' runs (the company's for the four, one's own otherwise)
//   GET   rules                      the company's rules, as the seed (version 0): every kind on, AI drafting on (the Settings page's writes are W5-A6's)
//
// THE ORDER OF CHECKS is the server's (`pipeline/report-runs.ts`): the role (403 `not authorized`), the body (400 `invalid_field` `{field}`), a replayed id (200, the run as it stands), the
// kind's period (400 `period_not_over` for every kind frozen at create, the monthly included), then 409 `generation_running` `{detail: {runId}}` while a run of the same kind and period goes.
// THE RUN SETTLES CLIENT BY CLIENT: every `DEMO_RUN_STEP_MS` one more pending client is drafted, through the report store's own create (so each is validated, deduplicated and drafted as a
// person's one-client create is, as the person who asked), and the progress read drafts what has fallen due before it answers. A client the person may not draft for is left out, a client not due
// the kind is `skipped` with `kind_not_due`, a client whose report exists is `existing` and never redrafted, a client whose create is refused is `failed` with that code, and the simulated
// client's draft is the plain template (`fallback`), as if the gateway were down. The demo has no internal client.
// SPLIT WITH W5-A6: a scheduled or "Run now" run is `demo-sched-run-…` and is answered by `demoSocialReportSchedules.ts`; this file returns null for those ids, and for a list asked by schedule.
import { PIPE_ENGAGEMENTS, isClientContact, isDemoSocialApprover, allocStore, type DemoResult } from "./demoSocialPipeline";
import { demoReports, dueKindsOf } from "./demoSocialReports";
import { isPeriodicKind, isShortKind, periodOf, periodRange, shiftPeriod } from "./socialReportKinds";
import { todayIsoInDisplayZone } from "./format";
import defaults from "./socialRulesDefaults.json";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const ID = /^[\w-]{1,64}$/;
/** One more client is drafted this often while a run goes. */
export const DEMO_RUN_STEP_MS = 1500;
const SCHEDULE_RUN_PREFIX = "demo-sched-run-";

interface Entry { engagementId: string; clientName: string; status: "pending" | "created" | "existing" | "skipped" | "failed"; reportId?: string; draftedVia?: string; reason?: string; simulated?: boolean }
export interface DemoRun { id: string; kind: string; period: string; requestedBy: string; startedMs: number; entries: Entry[]; finishedMs: number | null }
export interface RunStore { runs: DemoRun[] }

const KEY = Symbol.for("gaiada.demoSocial.reportRuns");
const store: RunStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= { runs: [] }) as RunStore;
export const demoRunStore = store;

const canCreate = (userId: string): boolean => !isClientContact(userId) && demoReports.canWrite(userId);
const nameOf = (id: string): string => PIPE_ENGAGEMENTS.find((e) => e.id === id)?.clientName ?? "A client";
const mayDraftFor = (userId: string, engagementId: string): boolean => isDemoSocialApprover(userId) || allocStore.byEngagement[engagementId]?.officerId === userId;
const mayRead = (userId: string, r: DemoRun): boolean => isDemoSocialApprover(userId) || r.requestedBy === userId;

/** The clients of a run, decided once (BFF §63.24.5): the active ones the person may draft for, `kind_not_due` and the rest skipped. */
function planEntries(userId: string, kind: string): Entry[] {
  return PIPE_ENGAGEMENTS.filter((e) => e.status === "active" && mayDraftFor(userId, e.id))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.id.localeCompare(b.id))
    .map((e): Entry => (kind !== "monthly" && !dueKindsOf(e.id).includes(kind)
      ? { engagementId: e.id, clientName: e.clientName, status: "skipped", reason: "kind_not_due" }
      : { engagementId: e.id, clientName: e.clientName, status: "pending" }));
}

/** Draft every pending client whose turn has come, in order. */
function advance(run: DemoRun, nowMs = Date.now()): void {
  const due = Math.floor((nowMs - run.startedMs) / DEMO_RUN_STEP_MS);
  const drafted = run.entries.filter((e) => e.status !== "pending" && e.status !== "skipped").length;
  let quota = due - drafted;
  for (const [i, e] of run.entries.entries()) {
    if (quota <= 0) break;
    if (e.status !== "pending") continue;
    quota -= 1;
    const a = demoReports.create(e.engagementId, JSON.stringify({ id: `soc-rep-run-${run.id.slice(0, 8)}-${i}`, kind: run.kind, period: run.period }), run.requestedBy);
    const j = a.json as Record<string, unknown>;
    if (a.status >= 400) { Object.assign(e, { status: "failed", reason: String(j.error ?? "draft_failed") }); continue; }
    const via = String(j.draftedVia ?? "ai");
    Object.assign(e, { status: via === "existing" ? "existing" : "created", reportId: String(j.id), simulated: j.simulated === true, ...(via === "existing" ? {} : { draftedVia: via }) });
  }
  if (run.finishedMs === null && !run.entries.some((e) => e.status === "pending")) run.finishedMs = Math.max(run.startedMs, Math.min(nowMs, run.startedMs + run.entries.length * DEMO_RUN_STEP_MS));
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const counts = (r: DemoRun) => {
  const c = { created: 0, existing: 0, skipped: 0, failed: 0 };
  for (const e of r.entries) if (e.status !== "pending") c[e.status] += 1;
  return c;
};
const resultOf = (e: Entry) => ({ engagementId: e.engagementId, clientName: e.clientName, ...(e.reportId ? { reportId: e.reportId } : {}), status: e.status, ...(e.draftedVia ? { draftedVia: e.draftedVia } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.simulated !== undefined ? { simulated: e.simulated } : {}) });
const progressOf = (r: DemoRun) => {
  advance(r);
  const finished = r.entries.filter((e) => e.status !== "pending");
  const c = counts(r);
  return {
    runId: r.id, kind: r.kind, period: r.period, status: r.finishedMs === null ? "running" : "done", total: r.entries.length, done: finished.length, results: finished.map(resultOf),
    startedAt: iso(r.startedMs), finishedAt: iso(r.finishedMs), trigger: "person", scheduleId: null,
    usage: { calls: c.created, promptTokens: c.created * 900, completionTokens: c.created * 300, costUsd: null },
  };
};

function start(body: string | undefined, userId: string): DemoResult {
  if (!canCreate(userId)) return err(403, "not authorized: cerbos denied create on social_report");
  let b: Record<string, unknown>;
  try { b = body ? (JSON.parse(body) as Record<string, unknown>) : {}; } catch { b = {}; }
  if (b.id !== undefined && (typeof b.id !== "string" || !ID.test(b.id))) return err(400, "invalid_field", { field: "id" });
  if (typeof b.id === "string") {
    const prior = store.runs.find((r) => r.id === b.id);
    if (prior) return mayRead(userId, prior) ? ok({ ...progressOf(prior), clients: prior.entries.map((e) => ({ engagementId: e.engagementId, clientName: e.clientName })) }) : err(404, "run_not_found");
  }
  if (typeof b.kind !== "string" || !isPeriodicKind(b.kind)) return err(400, "invalid_field", { field: "kind" });
  const kind = b.kind;
  const range = typeof b.period === "string" ? periodRange(kind, b.period) : null;
  if (!range || range.start > todayIsoInDisplayZone()) return err(400, "invalid_field", { field: "period" });
  // Every kind frozen at create needs its period ended, the monthly included: a run over a period still going would freeze half of it.
  if (!isShortKind(kind) && range.end >= todayIsoInDisplayZone()) return err(400, "period_not_over");
  const period = b.period as string;
  const going = store.runs.find((r) => r.kind === kind && r.period === period && (advance(r), r.finishedMs === null));
  if (going) return err(409, "generation_running", { detail: { runId: going.id } });
  const run: DemoRun = { id: typeof b.id === "string" ? b.id : `demo-run-${store.runs.length + 1}-${Date.now().toString(36)}`, kind, period, requestedBy: userId, startedMs: Date.now(), entries: planEntries(userId, kind), finishedMs: null };
  if (!run.entries.some((e) => e.status === "pending")) run.finishedMs = run.startedMs;
  store.runs.push(run);
  return ok({ runId: run.id, kind, period, total: run.entries.length, clients: run.entries.map((e) => ({ engagementId: e.engagementId, clientName: e.clientName })) }, 202);
}

function read(runId: string, userId: string): DemoResult | null {
  if (runId.startsWith(SCHEDULE_RUN_PREFIX)) return null; // W5-A6's: a scheduled or "Run now" run
  if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_report");
  const r = store.runs.find((x) => x.id === runId);
  if (!r || !mayRead(userId, r)) return err(404, "run_not_found");
  return ok(progressOf(r));
}

function list(params: URLSearchParams, userId: string): DemoResult | null {
  if (params.get("scheduleId") !== null) return null; // W5-A6's: one schedule's runs
  if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_report");
  const since = Date.now() - 30 * 86_400_000;
  const items = store.runs.filter((r) => r.startedMs > since && mayRead(userId, r)).sort((a, b) => b.startedMs - a.startedMs).map((r) => {
    advance(r);
    return {
      runId: r.id, kind: r.kind, period: r.period, status: r.finishedMs === null ? "running" : "done", total: r.entries.length, done: r.entries.filter((e) => e.status !== "pending").length,
      counts: counts(r), trigger: "person", scheduleId: null, requestedBy: r.requestedBy, createdAt: iso(r.startedMs), startedAt: iso(r.startedMs), finishedAt: iso(r.finishedMs),
    };
  });
  return ok({ items });
}

/** The demo's one earlier run, so the list of recent runs is not empty: last week's weekly reports, drafted three days ago by the HoD. */
export function seedRunStore(s: RunStore): void {
  if (s.runs.length > 0) return;
  const today = todayIsoInDisplayZone();
  const lastWk = shiftPeriod("weekly", periodOf("weekly", today), -1);
  if (!lastWk) return;
  const started = Date.now() - 3 * 86_400_000;
  const entries: Entry[] = planEntries("u-pm", "weekly").map((e) => {
    if (e.status !== "pending") return e;
    const rep = demoReports.store.reports.find((r) => r.engagementId === e.engagementId && r.kind === "weekly" && r.period === lastWk);
    return rep ? { ...e, status: "created", reportId: rep.id, draftedVia: rep.simulated ? "fallback" : "ai", simulated: rep.simulated } : { ...e, status: "failed", reason: "draft_failed" };
  });
  s.runs.push({ id: "demo-run-seed-1", kind: "weekly", period: lastWk, requestedBy: "u-pm", startedMs: started, entries, finishedMs: started + entries.length * DEMO_RUN_STEP_MS });
}
seedRunStore(store);

/** `GET rules`: the company's rules as the seed (version 0), the part of Settings the report pages read. */
function rules(userId: string): DemoResult {
  if (isClientContact(userId)) return err(403, "not authorized: cerbos denied read on social_post");
  return ok({ version: 0, defaultsVersion: (defaults as { defaultsVersion: string }).defaultsVersion, rules: defaults, defaults, sections: {}, canEdit: isDemoSocialApprover(userId) });
}

/** The run routes and `GET rules` by `tail`; null for any other path or method (the caller falls through). */
export function demoReportRunsRoute(method: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();
  if (tail === "rules") return m === "GET" ? rules(userId) : null;
  if (tail === "reports/generate") return m === "POST" ? start(body, userId) : m === "GET" ? list(params, userId) : null;
  const x = /^reports\/generate\/([^/]+)$/.exec(tail);
  if (x && m === "GET") return read(decodeURIComponent(x[1]), userId);
  return null;
}
