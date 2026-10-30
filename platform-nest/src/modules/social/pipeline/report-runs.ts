// SCP-5 W5-A3 (docs/FRONTEND-BFF-CONTRACT.md §63.24.5, §63.24.6; owner rulings SCP-Q17, Q26, Q37, Q40) — "Generate with AI" for every
// client the person may draft for: the background run, its progress read and the job `social-report-runs`. The listing and each client's
// result are decided in report-run-plan.ts (pure); this file reads, writes and runs. W5-A5's schedules start runs through this engine: "Run
// now" through `startReportRun` (`trigger: 'run_now'`), the schedule job through `planReportRun` + `insertReportRun` inside the schedule
// row's transaction + `launchReportRun` (`trigger: 'schedule'`, the owner, `via` {automation, scheduleId, missed}); everything below holds.
//
// ── THE LIFE OF A RUN ────────────────────────────────────────────────────────────────────────────────────────────────────────
//   start    The route checks (403 automation, the `create` gate, 400 validation, 409 refusals), lists the clients ONCE (report-run-plan.ts)
//            and inserts the run `queued` with every listed client in `results` (`pending` for the ones to draft). It then tries to make
//            it `running`: `ux_social_report_runs_running` admits one running run per company, so while another runs this one waits
//            `queued` (the job, or the end of the current run, starts it). `ux_social_report_runs_active` admits one queued-or-running run
//            per company, kind and period: a second start is 409 `generation_running` `{runId}` (the index decides, not a read, so two
//            starts at once cannot both pass).
//   work     The worker drafts the pending clients with at most FOUR in flight (`runBounded`). Each goes through the create route's own
//            path (`createSocialReport`), as the person, re-authorized for every client, with the run's `rules_ref` and the run id on its
//            usage row and its `created` activity.
//   results  Each client's result replaces its `pending` entry as it finishes, in one UPDATE guarded by "that entry is still pending"
//            (`done_count` moves with it), so a result is never counted twice. One failure is `failed` with its reason; the others go on.
//   resume   The worker beats (`heartbeat_at`) with every result and every minute. A `running` run whose beat is over five minutes old lost
//            its worker (a crash, a deploy): the job claims it (an UPDATE of the beat guarded by its age, so two instances never both
//            take it) and drafts only its `pending` clients. A client is never drafted twice: its entry is no longer pending once written,
//            and its report id is fixed by the run and the engagement (`runReportId`), so a draft whose report was inserted before the crash
//            but whose result was not is found again by id, answered `created`, with no second gateway call.
//   end      When no client is pending the run ends `done` and the person gets `social.reports.generated`; the next queued run of the
//            company starts. A run ends `failed` only when it cannot go on at all (its person is no longer an active user), its results
//            kept and the clients it never reached `failed` with `requester_inactive`.
//   usage    Every gateway call is recorded by the gateway client as the person's, with `run_id` (SCP-Q40); the progress read sums the
//            run's rows. Nothing is capped or refused on spend.
//
// ── IDENTITY (SCP-Q17, §63.15) ───────────────────────────────────────────────────────────────────────────────────────────────
// `requested_by` is the person (the principal of the request; with the OBO envelope that is the person the agent acts for). `via` keeps the
// request's channel and agent as `metadata.via` would, and `actFor` when a persona acted for a person, so the worker rebuilds the same
// principal (`assemblePrincipal` afresh: a person deactivated meanwhile cannot run anything) and `authorize()` keeps the intersection.
// An unattended automation (`users.kind` automation or bot) is refused 403 `automation_cannot_act` before anything else.
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../../../db";
import { config } from "../../../config";
import { authorize, notify } from "../../../core/http";
import { runWithRequestContext, type RequestVia } from "../../../core/request-context";
import { check } from "../../../rbac/cerbos";
import { assemblePrincipal, type Principal } from "../../../rbac/principal";
import { todayIsoInTz } from "../../reports/person-scope";
import { loadSocialApproverIds, socialEngagementResource, socialReportResource } from "../pipeline-authz";
import { createSocialReport } from "../social-reports.controller";
import { resolvePeriod } from "../report-kinds";
import { findDepartmentBySlug } from "./pipeline-data";
import { PERIODIC_KINDS, reportKindRules, rulesRefFor, socialRules, type PeriodicKind } from "./rules";
import {
  MAX_CHOSEN_CLIENTS, MAX_DRAFTS_IN_FLIGHT, STALE_HEARTBEAT_MINUTES, countResults, failureReason, finishedResults, generatedNoticeTitle,
  pendingEntries, planRunEntries, resultFromAnswer, runBounded, runReportId, type RunCandidate, type RunEntry,
} from "./report-run-plan";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The job's cadence (every minute, §63.24.5). */
export const REPORT_RUNS_INTERVAL_MS = 60_000;
/** The worker's own beat while it runs (a result also beats). */
const HEARTBEAT_MS = 60_000;

export type RunTrigger = "person" | "schedule" | "run_now";

interface RunRow {
  id: string; kind: PeriodicKind; period: string; requested_by: string; via: Record<string, unknown> | null; rules_ref: string;
  trigger: RunTrigger; schedule_id: string | null; status: "queued" | "running" | "done" | "failed"; total: number; done_count: number;
  results: RunEntry[]; started_at: string | null; finished_at: string | null; created_at: string;
}

const RUN_COLUMNS = `id::text AS id, kind, period, requested_by::text AS requested_by, via, rules_ref, trigger, schedule_id::text AS schedule_id,
  status, total, done_count, results, started_at, finished_at, created_at`;

const iso = (v: string | Date | null): string | null => (v === null ? null : new Date(v).toISOString());
const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  (e as { code?: string } | null)?.code === "23505" && (constraint === undefined || (e as { constraint?: string }).constraint === constraint);
function invalidField(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}
export const isAutomationPrincipal = (p: Principal): boolean => p.kind === "automation" || p.kind === "bot";

async function loadRun(c: PoolClient, tenantId: string, runId: string): Promise<RunRow | null> {
  const r = await c.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM social_report_runs WHERE tenant_id = $1 AND id = $2`, [tenantId, runId]);
  return r.rows[0] ?? null;
}

const approverIdsOf = (tenantId: string): Promise<string[]> => withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), SOCIAL);

/** One of the four (`social_engagement` · `plan`), asked as a plain check (never a throw); a persona acting for a person needs both. */
export async function mayPlan(principal: Principal, tenantId: string, approverIds: string[]): Promise<boolean> {
  const resource = socialEngagementResource(tenantId, approverIds);
  if (!(await check(principal, resource, "plan")).allow) return false;
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const person = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    if (!person || !(await check({ ...person, via: principal.via }, resource, "plan")).allow) return false;
  }
  return true;
}

/** The person a principal stands for: the person a persona acts for, else the principal itself. */
export const personOf = (p: Principal): string | null => (p.actFor && p.actFor.userId !== p.userId ? p.actFor.userId : p.userId);

/** The run as the progress read answers it (§63.24.5), with the run's spend summed from `ai_usage_events` by `run_id` (SCP-Q40). */
export interface RunProgress {
  runId: string; kind: string; period: string; status: string; total: number; done: number; results: RunEntry[];
  startedAt: string | null; finishedAt: string | null; trigger: RunTrigger; scheduleId: string | null;
  usage: { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null };
}

/** The run's AI usage: every gateway call recorded with its id (§64). `costUsd` is null while no call has a cost. */
export async function runUsage(tenantId: string, runId: string): Promise<RunProgress["usage"]> {
  const r = await withTenants([tenantId], (c) => c.query<{ calls: number; prompt: string | null; completion: string | null; cost: string | null; costed: number }>(
    `SELECT count(*)::int AS calls, sum(prompt_tokens)::text AS prompt, sum(completion_tokens)::text AS completion,
            sum(cost_usd)::text AS cost, count(cost_usd)::int AS costed
       FROM ai_usage_events WHERE tenant_id = $1 AND run_id = $2`,
    [tenantId, runId]), SOCIAL);
  const u = r.rows[0];
  return {
    calls: u?.calls ?? 0, promptTokens: Number(u?.prompt ?? 0), completionTokens: Number(u?.completion ?? 0),
    costUsd: u && u.costed > 0 && u.cost !== null ? Number(u.cost) : null,
  };
}

function progressOf(run: RunRow, usage: RunProgress["usage"]): RunProgress {
  return {
    runId: run.id, kind: run.kind, period: run.period, status: run.status, total: Number(run.total), done: Number(run.done_count),
    results: finishedResults(run.results ?? []), startedAt: iso(run.started_at), finishedAt: iso(run.finished_at), trigger: run.trigger,
    scheduleId: run.schedule_id, usage,
  };
}

/** Whether `principal` may see `run`: the run's person (or the persona that started it), or one of the four. */
async function maySeeRun(principal: Principal, tenantId: string, run: RunRow): Promise<boolean> {
  const me = principal.userId?.toLowerCase();
  if (me && (run.requested_by.toLowerCase() === me || String(run.via?.actFor ?? "").toLowerCase() === me)) return true;
  const person = personOf(principal)?.toLowerCase();
  if (person && run.requested_by.toLowerCase() === person) return true;
  return mayPlan(principal, tenantId, await approverIdsOf(tenantId));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Start: POST reports/generate
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface StartRunBody { id?: unknown; kind?: unknown; period?: unknown; engagementIds?: unknown }
export interface StartRunOptions {
  trigger?: RunTrigger;
  scheduleId?: string | null;
  /** The run's `via` when it is not the request's (a schedule's `{automation: 'report_schedule', scheduleId, missed?}`). */
  via?: Record<string, unknown> | null;
  /** False for a schedule's `chosen` list: a chosen engagement deleted since is left out instead of a 400 (`planReportRun`). */
  strictChosen?: boolean;
}
export type StartRunAnswer =
  | { status: 202; body: { runId: string; kind: string; period: string; total: number; clients: Array<{ engagementId: string; clientName: string }> } }
  | { status: 200; body: RunProgress & { clients: Array<{ engagementId: string; clientName: string }> } };

const clientsOf = (entries: readonly RunEntry[]) => entries.map((e) => ({ engagementId: e.engagementId, clientName: e.clientName }));

/** The run's `via`: the request's channel and agent (as `metadata.via`), and the person a persona acted for. */
export function viaOfRequest(principal: Principal): Record<string, unknown> | null {
  const via: Record<string, unknown> = principal.via ? { ...principal.via } : {};
  if (principal.actFor && principal.actFor.userId !== principal.userId) via.actFor = principal.actFor.userId;
  return Object.keys(via).length > 0 ? via : null;
}

/**
 * Start a run (see the header for the order of the checks). Answers 202 with the listing, or 200 with the run as it stands for a replayed
 * `id`. The run is started in this process without waiting for it; the job picks it up when this process dies or another run holds the
 * company.
 */
export async function startReportRun(principal: Principal, tenantId: string, body: StartRunBody, opts: StartRunOptions = {}): Promise<StartRunAnswer> {
  if (isAutomationPrincipal(principal)) throw new ForbiddenException({ message: "automation_cannot_act" });
  const approverIds = await approverIdsOf(tenantId);
  await authorize(principal, socialReportResource(tenantId, "", approverIds), "create");

  if (body.id !== undefined && (typeof body.id !== "string" || !UUID_RE.test(body.id))) invalidField("id");
  const runId = (body.id as string | undefined)?.toLowerCase() ?? newId();
  if (body.id !== undefined) {
    const prior = await withTenants([tenantId], (c) => loadRun(c, tenantId, runId), SOCIAL);
    if (prior) {
      if (!(await maySeeRun(principal, tenantId, prior))) throw new NotFoundException({ message: "run_not_found" });
      return { status: 200, body: { ...progressOf(prior, await runUsage(tenantId, runId)), clients: clientsOf(prior.results ?? []) } };
    }
  }

  const plan = await planReportRun(principal, tenantId, approverIds, body, { strictChosen: opts.strictChosen !== false });
  const { kind, period, entries } = plan;

  const trigger = opts.trigger ?? "person";
  const via = opts.via !== undefined ? opts.via : viaOfRequest(principal);
  try {
    await withTenants([tenantId], (c) => insertReportRun(c, tenantId, plan, {
      runId, requestedBy: principal.userId!, via, trigger, scheduleId: opts.scheduleId ?? null,
    }), SOCIAL);
  } catch (e) {
    if (isUniqueViolation(e, "social_report_runs_pkey") && body.id !== undefined) {
      // The same id replayed at the same moment: answer the run the first one made.
      const prior = await withTenants([tenantId], (c) => loadRun(c, tenantId, runId), SOCIAL);
      if (prior && (await maySeeRun(principal, tenantId, prior))) {
        return { status: 200, body: { ...progressOf(prior, await runUsage(tenantId, runId)), clients: clientsOf(prior.results ?? []) } };
      }
      throw new NotFoundException({ message: "run_not_found" });
    }
    throw e;
  }

  // Make it the company's running run, or leave it queued behind the one that is; either way the work is not awaited.
  await launchReportRun(tenantId, runId);
  return { status: 202, body: { runId, kind, period, total: entries.length, clients: clientsOf(entries) } };
}

/** A run decided but not yet written: its kind and period, its listing (decided once) and the company's rules it is made under. */
export interface PlannedRun { kind: PeriodicKind; period: string; entries: RunEntry[]; rulesRef: string }

/**
 * The checks after the gate and the listing, with no write (shared by `POST reports/generate`, a schedule's "Run now" and the schedule
 * job, W5-A5): 400 for the kind, the period (every kind frozen at create needs it ended, the monthly included: a run over a period still
 * going would freeze half of it) and the chosen clients; 409 `report_kind_off` / `ai_drafting_off` from the company's current rules; then
 * the clients `principal` may draft for (report-run-plan.ts). With `strictChosen` false (a schedule's `chosen` list, whose clients may have
 * been deleted since it was set), a chosen engagement that no longer exists is left out instead of a 400.
 */
export async function planReportRun(
  principal: Principal, tenantId: string, approverIds: string[], body: Pick<StartRunBody, "kind" | "period" | "engagementIds">,
  o: { strictChosen?: boolean } = {},
): Promise<PlannedRun> {
  if (typeof body.kind !== "string" || !(PERIODIC_KINDS as readonly string[]).includes(body.kind)) invalidField("kind");
  const kind = body.kind as PeriodicKind;
  const company = await withTenants([tenantId], (c) => socialRules(c, tenantId), SOCIAL);
  const kindRules = reportKindRules(company.rules, kind);
  const resolved = resolvePeriod(kind, body.period, company.rules.reports.fiscalYearStartMonth, todayIsoInTz(config.reportsTz), kindRules.freezeAt === "create");
  if (!resolved.ok) {
    if (resolved.code === "period_not_over") throw new BadRequestException({ message: "period_not_over" });
    invalidField("period");
  }
  const period = body.period as string;
  let chosen: string[] | null = null;
  if (body.engagementIds !== undefined) {
    const ids = body.engagementIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_CHOSEN_CLIENTS || !ids.every((x) => typeof x === "string" && UUID_RE.test(x))) {
      invalidField("engagementIds");
    }
    chosen = [...new Set((ids as string[]).map((x) => x.toLowerCase()))];
  }

  // 409: the company's current rules.
  if (!kindRules.enabled) throw new ConflictException({ message: "report_kind_off" });
  if (!kindRules.aiDrafting) throw new ConflictException({ message: "ai_drafting_off" });

  // The listing, decided once.
  const planner = await mayPlan(principal, tenantId, approverIds);
  const person = personOf(principal);
  const candidates = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ id: string; client_name: string; status: string; is_internal: boolean; owner_id: string | null; report_kinds: string[] | null }>(
      `SELECT e.id::text AS id, cl.name AS client_name, e.status, cl.is_internal, e.owner_id::text AS owner_id, e.report_kinds
         FROM social_engagements e
         JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1 AND e.deleted_at IS NULL
          AND ($2::uuid[] IS NULL OR e.id = ANY($2::uuid[]))
          AND ($2::uuid[] IS NOT NULL OR $3::boolean OR e.owner_id::text = $4)`,
      [tenantId, chosen, planner, person?.toLowerCase() ?? null]);
    return r.rows;
  }, SOCIAL);
  if (o.strictChosen !== false && chosen && chosen.some((id) => !candidates.some((c) => c.id.toLowerCase() === id))) invalidField("engagementIds");
  const entries = planRunEntries(
    candidates.map((c): RunCandidate => ({
      engagementId: c.id, clientName: c.client_name, status: c.status, isInternal: c.is_internal === true, ownerId: c.owner_id, reportKinds: c.report_kinds ?? [],
    })),
    { kind, mayPlan: planner, personId: person, chosen },
  );
  return { kind, period, entries, rulesRef: rulesRefFor(company) };
}

export interface RunInsert {
  runId: string;
  /** The person the run acts as (`requested_by`): the caller, or a schedule's owner. */
  requestedBy: string;
  via: Record<string, unknown> | null;
  trigger: RunTrigger;
  scheduleId: string | null;
}

/**
 * Write a planned run `queued` on `c`, inside the caller's transaction (the schedule job's row transaction, W5-A5), under a savepoint so a
 * refusal leaves that transaction usable: 409 `generation_running` `{runId}` while a run of the same company, kind and period is queued or
 * running (`ux_social_report_runs_active`), 409 `schedule_period_has_run` `{runId}` when the schedule already has a run of the period
 * (`ux_social_report_runs_schedule`). Any other error (a replayed primary key included) is thrown as it is. Nothing is started here: after
 * the transaction commits, `launchReportRun`.
 */
export async function insertReportRun(c: PoolClient, tenantId: string, plan: PlannedRun, ins: RunInsert): Promise<void> {
  const done = plan.entries.length - pendingEntries(plan.entries).length;
  await c.query("SAVEPOINT social_report_run_insert");
  try {
    await c.query(
      `INSERT INTO social_report_runs (id, tenant_id, kind, period, requested_by, via, rules_ref, trigger, schedule_id, status, total, done_count, results, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'queued', $10, $11, $12::jsonb, $13)`,
      [ins.runId, tenantId, plan.kind, plan.period, ins.requestedBy, ins.via === null ? null : JSON.stringify(ins.via), plan.rulesRef, ins.trigger,
        ins.scheduleId, plan.entries.length, done, JSON.stringify(plan.entries), config.originSite]);
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT social_report_run_insert");
    if (isUniqueViolation(e, "ux_social_report_runs_active")) {
      const active = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM social_report_runs WHERE tenant_id = $1 AND kind = $2 AND period = $3 AND status IN ('queued','running') LIMIT 1`,
        [tenantId, plan.kind, plan.period]);
      throw new ConflictException({ message: "generation_running", detail: { runId: active.rows[0]?.id ?? null } });
    }
    if (isUniqueViolation(e, "ux_social_report_runs_schedule")) {
      const prior = await c.query<{ id: string }>(
        `SELECT id::text AS id FROM social_report_runs WHERE tenant_id = $1 AND schedule_id = $2 AND period = $3 LIMIT 1`,
        [tenantId, ins.scheduleId, plan.period]);
      throw new ConflictException({ message: "schedule_period_has_run", detail: { runId: prior.rows[0]?.id ?? null } });
    }
    throw e;
  }
  await c.query("RELEASE SAVEPOINT social_report_run_insert");
}

/** Start a committed run: make it the company's running run and work it in this process, or leave it queued behind the one that runs. */
export async function launchReportRun(tenantId: string, runId: string): Promise<void> {
  if (await promoteRun(tenantId, runId)) void executeReportRun(tenantId, runId);
}

/** queued -> running, when the company has no running run (`ux_social_report_runs_running` decides). True when this call promoted it. */
async function promoteRun(tenantId: string, runId: string): Promise<boolean> {
  try {
    const r = await withTenants([tenantId], (c) => c.query(
      `UPDATE social_report_runs SET status = 'running', started_at = now(), heartbeat_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
      [tenantId, runId]), SOCIAL);
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    if (isUniqueViolation(e, "ux_social_report_runs_running")) return false;
    throw e;
  }
}

/** The company's oldest queued run, made running when no other runs; its id, or null. */
async function promoteNextQueued(tenantId: string): Promise<string | null> {
  try {
    const r = await withTenants([tenantId], (c) => c.query<{ id: string }>(
      `UPDATE social_report_runs SET status = 'running', started_at = now(), heartbeat_at = now()
        WHERE id = (SELECT id FROM social_report_runs WHERE tenant_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
          AND status = 'queued'
        RETURNING id::text AS id`,
      [tenantId]), SOCIAL);
    return r.rows[0]?.id ?? null;
  } catch (e) {
    if (isUniqueViolation(e, "ux_social_report_runs_running")) return null;
    throw e;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Work: the worker
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The runs this process is working on, so the job never starts a second worker for one of them here. */
const working = new Map<string, Promise<void>>();

/**
 * TEST SEAM: called after a client's create returned and BEFORE its result is written. Returning true kills the worker right there, as a
 * crash would: nothing more is written, no new client starts, the run stays `running`. Null in production.
 */
let interruptForTests: ((engagementId: string) => boolean) | null = null;
export function setReportRunInterruptForTests(fn: ((engagementId: string) => boolean) | null): void {
  interruptForTests = fn;
}

/** Every worker of this process has finished (tests). */
export async function reportRunsIdle(): Promise<void> {
  while (working.size > 0) await Promise.allSettled([...working.values()]);
}

/** The principal a run acts as: its person, afresh, with the run's channel and the person a persona acted for. Null when they cannot act. */
async function principalOfRun(run: RunRow): Promise<Principal | null> {
  const p = await assemblePrincipal(run.requested_by, "linked");
  if (!p || isAutomationPrincipal(p)) return null;
  const v = run.via ?? {};
  const via = typeof v.provider === "string" && typeof v.externalId === "string"
    ? { provider: v.provider, externalId: v.externalId, ...(typeof v.agent === "string" ? { agent: v.agent } : {}) }
    : undefined;
  const actFor = typeof v.actFor === "string" && UUID_RE.test(v.actFor) ? { userId: v.actFor } : undefined;
  return { ...p, ...(via ? { via } : {}), ...(actFor ? { actFor } : {}) };
}

/** Run (or resume) one run's pending clients in this process. Never throws: a failure leaves the run running for the job to resume. */
export function executeReportRun(tenantId: string, runId: string): Promise<void> {
  const key = runId.toLowerCase();
  const already = working.get(key);
  if (already) return already;
  const p = work(tenantId, key)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-REPORT-RUNS] run ${key} (tenant ${tenantId}) stopped; the job resumes it:`, (err as Error)?.message ?? err);
    })
    .finally(() => working.delete(key));
  working.set(key, p);
  return p;
}

async function work(tenantId: string, runId: string): Promise<void> {
  const run = await withTenants([tenantId], (c) => loadRun(c, tenantId, runId), SOCIAL);
  if (!run || run.status !== "running") return;
  const principal = await principalOfRun(run);
  if (!principal) {
    await failRun(tenantId, runId, "requester_inactive");
    await afterRun(tenantId, runId);
    return;
  }
  const pending = pendingEntries(run.results ?? []);
  let dead = false;
  const beat = setInterval(() => {
    void withTenants([tenantId], (c) => c.query(`UPDATE social_report_runs SET heartbeat_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'running'`, [tenantId, runId]), SOCIAL)
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  if (typeof beat.unref === "function") beat.unref();
  // One result write at a time per run: the writes are small, and the row is the run's one lock anyway.
  let writes: Promise<unknown> = Promise.resolve();
  const writeResult = (entry: RunEntry): Promise<unknown> => {
    writes = writes.then(() => withTenants([tenantId], (c) => c.query(
      `UPDATE social_report_runs r
          SET results = (SELECT jsonb_agg(CASE WHEN x.e->>'engagementId' = $3 AND x.e->>'status' = 'pending' THEN $4::jsonb ELSE x.e END ORDER BY x.ord)
                           FROM jsonb_array_elements(r.results) WITH ORDINALITY AS x(e, ord)),
              done_count = r.done_count + 1, heartbeat_at = now()
        WHERE r.tenant_id = $1 AND r.id = $2 AND r.status = 'running'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.results) AS z(e) WHERE z.e->>'engagementId' = $3 AND z.e->>'status' = 'pending')`,
      [tenantId, runId, entry.engagementId, JSON.stringify(entry)]), SOCIAL)).catch((err) => {
      // A result that could not be written stays pending: the job's resume drafts nothing twice (the report id is fixed) and writes it then.
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-REPORT-RUNS] run ${runId}: a result could not be written:`, (err as Error)?.message ?? err);
    });
    return writes;
  };

  try {
    await runWithRequestContext(() => runBounded(pending, MAX_DRAFTS_IN_FLIGHT, async (entry) => {
      const ownId = runReportId(runId, entry.engagementId);
      let result: RunEntry;
      try {
        const answer = await createSocialReport(principal, tenantId, entry.engagementId, { id: ownId, kind: run.kind, period: run.period }, {
          runId, rulesRef: run.rules_ref, via: run.via,
        });
        result = resultFromAnswer(entry, {
          id: answer.id, draftedVia: answer.draftedVia, simulated: answer.simulated,
          narrativeSource: (answer.metrics as { narrativeSource?: string } | undefined)?.narrativeSource ?? null,
        }, ownId);
      } catch (err) {
        result = { engagementId: entry.engagementId, clientName: entry.clientName, status: "failed", reason: failureReason(err) };
      }
      if (dead || (interruptForTests && interruptForTests(entry.engagementId))) {
        dead = true;
        return;
      }
      await writeResult(result);
    }, () => dead), { via: requestViaOf(run.via) });
    await writes;
  } finally {
    clearInterval(beat);
  }
  if (dead) return;
  await afterRun(tenantId, runId);
}

/** The request channel the background writes are attributed with (writeActivity's ambient `via`); the run's own `via` is passed too. */
function requestViaOf(v: Record<string, unknown> | null): RequestVia | undefined {
  if (!v || typeof v.provider !== "string" || typeof v.externalId !== "string") return undefined;
  return { provider: v.provider, externalId: v.externalId, ...(typeof v.agent === "string" ? { agent: v.agent } : {}) };
}

/** End the run when nothing is pending (then the notice and the company's next run); otherwise leave it for the job. */
async function afterRun(tenantId: string, runId: string): Promise<void> {
  const ended = await withTenants([tenantId], (c) => c.query<RunRow>(
    `UPDATE social_report_runs SET status = 'done', finished_at = now(), heartbeat_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(results) AS z(e) WHERE z.e->>'status' = 'pending')
      RETURNING ${RUN_COLUMNS}`,
    [tenantId, runId]), SOCIAL);
  if (ended.rows[0]) await noticeOfRun(tenantId, ended.rows[0]);
  // The company's next queued run, if this one no longer runs (the running-run index refuses it otherwise, and the job retries).
  const next = await promoteNextQueued(tenantId);
  if (next) void executeReportRun(tenantId, next);
}

/** The run cannot go on: `failed`, its results kept, the clients it never reached `failed` with `reason`. */
async function failRun(tenantId: string, runId: string, reason: string): Promise<void> {
  const r = await withTenants([tenantId], (c) => c.query<RunRow>(
    `UPDATE social_report_runs r
        SET status = 'failed', finished_at = now(), heartbeat_at = now(), done_count = r.total,
            results = coalesce((SELECT jsonb_agg(CASE WHEN x.e->>'status' = 'pending'
                                                      THEN x.e || jsonb_build_object('status', 'failed', 'reason', $3::text) ELSE x.e END ORDER BY x.ord)
                                  FROM jsonb_array_elements(r.results) WITH ORDINALITY AS x(e, ord)), '[]'::jsonb)
      WHERE r.tenant_id = $1 AND r.id = $2 AND r.status = 'running'
      RETURNING ${RUN_COLUMNS}`,
    [tenantId, runId, reason]), SOCIAL);
  if (r.rows[0]) await noticeOfRun(tenantId, r.rows[0]);
}

/** `social.reports.generated` to the run's person, linking to the list filtered to the kind and period. Never throws. */
async function noticeOfRun(tenantId: string, run: RunRow): Promise<void> {
  try {
    const counts = countResults(run.results ?? []);
    const dept = await withTenants([tenantId], (c) => findDepartmentBySlug(c, tenantId, "social-media"));
    const base = dept ? `/departments/${dept.id}/social-reports` : "/departments#";
    const recipient = typeof run.via?.actFor === "string" ? run.via.actFor : run.requested_by;
    await notify(tenantId, recipient, null, "social.reports.generated", {
      title: generatedNoticeTitle(counts),
      href: dept ? `${base}?kind=${encodeURIComponent(run.kind)}&period=${encodeURIComponent(run.period)}` : base,
      entityType: "social_report_run", entityId: run.id, severity: counts.failed > 0 || run.status === "failed" ? "warning" : "info",
      runId: run.id, kind: run.kind, period: run.period, status: run.status, counts,
    });
  } catch (err) {
    // A notice never undoes the run.
    // eslint-disable-next-line no-console
    console.error(`[SOCIAL-REPORT-RUNS] the notice of run ${run.id} failed:`, (err as Error)?.message ?? err);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Read: GET reports/generate/:runId and GET reports/generate
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The progress read: `social_report` · `read`; the run's person or one of the four, else 404 `run_not_found`. */
export async function readReportRun(principal: Principal, tenantId: string, runId: string): Promise<RunProgress> {
  const approverIds = await approverIdsOf(tenantId);
  await authorize(principal, socialReportResource(tenantId, "", approverIds), "read");
  if (typeof runId !== "string" || !UUID_RE.test(runId)) throw new NotFoundException({ message: "run_not_found" });
  const run = await withTenants([tenantId], (c) => loadRun(c, tenantId, runId.toLowerCase()), SOCIAL);
  if (!run || !(await maySeeRun(principal, tenantId, run))) throw new NotFoundException({ message: "run_not_found" });
  return progressOf(run, await runUsage(tenantId, run.id));
}

export interface RunListItem {
  runId: string; kind: string; period: string; status: string; total: number; done: number;
  counts: { created: number; existing: number; skipped: number; failed: number };
  trigger: RunTrigger; scheduleId: string | null; requestedBy: string; createdAt: string | null; startedAt: string | null; finishedAt: string | null;
}

/** The last 30 days' runs, or one schedule's: the company's for the four, one's own for anyone else. */
export async function listReportRuns(principal: Principal, tenantId: string, scheduleId?: unknown): Promise<{ items: RunListItem[] }> {
  const approverIds = await approverIdsOf(tenantId);
  await authorize(principal, socialReportResource(tenantId, "", approverIds), "read");
  if (scheduleId !== undefined && (typeof scheduleId !== "string" || !UUID_RE.test(scheduleId))) invalidField("scheduleId");
  const planner = await mayPlan(principal, tenantId, approverIds);
  const person = personOf(principal);
  const rows = await withTenants([tenantId], (c) => c.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM social_report_runs
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR schedule_id = $2::uuid)
        AND ($2::uuid IS NOT NULL OR created_at > now() - interval '30 days')
        AND ($3::boolean OR requested_by::text = $4)
      ORDER BY created_at DESC, id LIMIT 200`,
    [tenantId, (scheduleId as string | undefined) ?? null, planner, person?.toLowerCase() ?? null]), SOCIAL);
  return {
    items: rows.rows.map((r) => {
      const { created, existing, skipped, failed } = countResults(r.results ?? []);
      return {
        runId: r.id, kind: r.kind, period: r.period, status: r.status, total: Number(r.total), done: Number(r.done_count),
        counts: { created, existing, skipped, failed }, trigger: r.trigger, scheduleId: r.schedule_id, requestedBy: r.requested_by,
        createdAt: iso(r.created_at), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
      };
    }),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The job `social-report-runs` (every minute, on every instance)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface ReportRunsSweepResult { tenants: number; resumed: number; started: number; errors: number }

/**
 * One sweep: per company, claim a `running` run whose beat is older than five minutes (its worker died; this process is not working on it)
 * and resume it; with no run running, start the oldest queued one. The workers are not awaited (`wait` does, for tests).
 */
export async function runReportRunsSweep(o: { only?: string[]; wait?: boolean } = {}): Promise<ReportRunsSweepResult> {
  const { rows: all } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id::text AS id FROM companies WHERE deleted_at IS NULL`));
  const tenants = o.only ? all.filter((t) => o.only!.some((x) => x.toLowerCase() === t.id.toLowerCase())) : all;
  const out: ReportRunsSweepResult = { tenants: tenants.length, resumed: 0, started: 0, errors: 0 };
  const started: Promise<void>[] = [];
  for (const { id: tenantId } of tenants) {
    try {
      const stale = await withTenants([tenantId], (c) => c.query<{ id: string }>(
        `UPDATE social_report_runs SET heartbeat_at = now()
          WHERE tenant_id = $1 AND status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(mins => $2))
            AND NOT (id = ANY($3::uuid[]))
          RETURNING id::text AS id`,
        [tenantId, STALE_HEARTBEAT_MINUTES, [...working.keys()]]), SOCIAL);
      for (const r of stale.rows) { out.resumed += 1; started.push(executeReportRun(tenantId, r.id)); }
      if (stale.rows.length === 0) {
        const next = await promoteNextQueued(tenantId);
        if (next) { out.started += 1; started.push(executeReportRun(tenantId, next)); }
      }
    } catch (err) {
      out.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-REPORT-RUNS] tenant ${tenantId} failed:`, (err as Error)?.message ?? err);
    }
  }
  if (o.wait) await Promise.allSettled(started);
  return out;
}

/** The loop `main.ts` starts. The first sweep runs at once; each later one an interval after the last ended. */
export function startReportRunsLoop(intervalMs: number = REPORT_RUNS_INTERVAL_MS): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runReportRunsSweep();
      if (r.resumed > 0 || r.started > 0 || r.errors > 0) {
        // eslint-disable-next-line no-console
        console.log("[SOCIAL-REPORT-RUNS] sweep run:", r);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-REPORT-RUNS] tick failed:", (err as Error)?.message ?? err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
