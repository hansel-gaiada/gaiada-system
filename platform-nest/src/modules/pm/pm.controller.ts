// Project-management subsystem (BFF §5) — Repsona-style rich tasks over the base projects.
// Backs platform-ui lib/pm.ts + lib/pmActions.ts. Dedicated pm_* tables (migration 0018);
// task comments reuse the generic /api/:t/comments endpoint. The AI Tracker here is the
// deterministic baseline (progress-from-subtasks + status coupling); the WS8 PM specialist
// agent replaces the analysis later behind the same contract.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity, notify } from "../../core/http";
import { validateCustomFields } from "../../core/custom-fields";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { allocateTaskSeq, deriveUniqueShortCode, displayCode } from "../../core/project-short-codes";
import { todayIso, addDaysIso } from "../../core/dept-resolution";

type Assignee = {
  kind: "person" | "department" | "division";
  refId: string;
  refName: string;
  responsibleId: string;
  responsibleName: string;
} | null;

// TR-02 (§3.1) — a task's contributors: zero or more PERSONS, listed with logged hours, never
// outcome-credited. Read-only shape on task GET (joined off pm_task_assignees role='contributor');
// written only via the addContributor/removeContributor PATCH ops below.
interface Contributor { userId: string; name: string }

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Closed palette (P2-01 / pm-console-ux-design-spec §6): the stored value is the slug, never a hex.
const TAG_COLORS = new Set(["bronze", "champagne", "olive", "slate", "clay", "moss", "dust", "ink"]);
const STATUS_ID_RE = /^[a-z0-9_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------- Recurring tasks (P2-06, pm-console-ux-design-spec §8) ----------------
type RecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly";
const RECURRENCE_FREQS = new Set<RecurrenceFreq>(["daily", "weekly", "biweekly", "monthly"]);
interface TaskRecurrence { freq: RecurrenceFreq; until?: string }

function validRecurrence(v: unknown): TaskRecurrence | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new BadRequestException("recurrence must be an object or null");
  const r = v as Record<string, unknown>;
  if (typeof r.freq !== "string" || !RECURRENCE_FREQS.has(r.freq as RecurrenceFreq)) {
    throw new BadRequestException("recurrence.freq must be one of daily|weekly|biweekly|monthly");
  }
  const out: TaskRecurrence = { freq: r.freq as RecurrenceFreq };
  if (r.until !== undefined && r.until !== null) {
    if (typeof r.until !== "string" || !DATE_RE.test(r.until)) throw new BadRequestException("recurrence.until must be a YYYY-MM-DD date");
    out.until = r.until;
  }
  return out;
}

// Shift a YYYY-MM-DD date forward by one occurrence of `freq`. Monthly clamps
// the day-of-month to the target month's last day (calendar-month semantics —
// Jan 31 + 1 month = Feb 28/29, never overflowing into March).
function addFreq(dateStr: string, freq: RecurrenceFreq): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  if (freq === "monthly") {
    let ny = y;
    let nm = mo + 1;
    if (nm > 12) { nm = 1; ny += 1; }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(d, lastDay);
    return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
  }
  const days = freq === "daily" ? 1 : freq === "weekly" ? 7 : 14;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The next occurrence's dates, or null when there's nothing to spawn: no due
// date to anchor on, or the shifted due date would land after `until`. Shifts
// startDate too (preserving the original start→due offset) when the task has
// one; dueDate-only tasks shift just the due date, per the locked contract.
function computeNextOccurrence(dueDate: string | null, startDate: string | null, rec: TaskRecurrence): { startDate: string | null; dueDate: string } | null {
  if (!dueDate) return null;
  const nextDue = addFreq(dueDate, rec.freq);
  if (rec.until && nextDue > rec.until) return null;
  const nextStart = startDate ? addFreq(startDate, rec.freq) : null;
  return { startDate: nextStart, dueDate: nextDue };
}

// ---------------- Custom statuses (P2-04, pm-console-ux-design-spec §7) ----------------
// A per-project ordered status registry with is_done/is_blocked ENGINE FLAGS. done/blocked
// semantics everywhere on the BE derive from these flags, never from string-matching the id.
interface StatusRow {
  id: string; position: number; label: string; color: string;
  isDone: boolean; isBlocked: boolean; wipLimit: number | null;
}
type ProjectStatus = { id: string; label: string; color: string; isDone: boolean; isBlocked: boolean; position: number; wipLimit?: number };

// D-3: default ids ARE the legacy literals so existing pm_tasks.status values stay valid with zero
// row rewrites; labels/colors mirror platform-ui's lib/pmVocabulary.ts PM_STATUS_LADDER +
// styles/tokens/pm.css (byte-identical read-back for a project that never opens the editor).
//
// P4-B8b (2026-08-06): the owner's ladder is `Backlog · ToDo · Doing · Blocked · Done`. `backlog` is
// the only new id; `in_progress` KEEPS its id and only gains the label "Doing" — renaming the id
// would orphan every existing pm_tasks.status value. Colours are the Repsona-faithful PM palette,
// which is why they changed too.
//
// NO MIGRATION accompanies this, deliberately. Statuses are synth-on-read: a project with zero
// `pm_project_statuses` rows — the overwhelming majority, i.e. everything that never opened the
// editor — picks up the 5-status ladder automatically on the next read. A project that HAS
// materialized rows customized its workflow on purpose, and injecting a status at position 0 would
// silently reorder someone's board; those keep exactly what they have. This also sidesteps the
// backfill-under-RLS trap entirely, since there is no backfill.
//
// Known wart, pre-existing: these are literal hex, so a MATERIALIZED status carries a fixed colour
// that cannot adapt to dark mode, while a synthesized one is rendered by the UI through
// `var(--pm-status-*)` and does. Same values, so the two agree in light mode. Out of scope here.
const DEFAULT_STATUSES: readonly StatusRow[] = [
  { id: "backlog", position: 0, label: "Backlog", color: "#90A4AE", isDone: false, isBlocked: false, wipLimit: null },
  { id: "todo", position: 1, label: "ToDo", color: "#8BC34A", isDone: false, isBlocked: false, wipLimit: null },
  { id: "in_progress", position: 2, label: "Doing", color: "#CDDC39", isDone: false, isBlocked: false, wipLimit: null },
  { id: "blocked", position: 3, label: "Blocked", color: "#FF7043", isDone: false, isBlocked: true, wipLimit: null },
  { id: "done", position: 4, label: "Done", color: "#FFC107", isDone: true, isBlocked: false, wipLimit: null },
];

// ---- "where does a new task start?" — two DIFFERENT answers (P4-B8b) ----
// Four call sites below used to share one expression ("first by position", or "first non-done")
// while meaning two different things. That was harmless while `todo` was position 0 and became a
// SILENT bug the moment `Backlog` took that slot: a fired recurrence lands in Backlog, nobody sees
// it in ToDo, and the recurrence looks broken while every test asserting "a child was spawned"
// still passes. platform-ui carries the identical pair (lib/pm.ts) — keep them in step.

// Narrowest possible input: these two only ever need an id, an order and the done flag, so they
// accept both `StatusRow` (wipLimit: number|null) and `ProjectStatus` (wipLimit?: number) without a
// cast at any call site.
type StatusPick = { id: string; position: number; isDone: boolean; isBlocked: boolean };

/** Fresh, uncommitted work (a duplicate): the earliest non-done status — Backlog when one exists. */
function intakeStatus(statuses: readonly StatusPick[]): string {
  const ordered = [...statuses].sort((a, z) => a.position - z.position);
  return (ordered.find((s) => !s.isDone) ?? ordered[0])?.id ?? "todo";
}

/**
 * Work that is READY to be picked up now: a fired recurrence, a task created from the form, or (once
 * workstream I lands) a task whose last blocker just cleared. Prefers the canonical `todo` id;
 * otherwise the earliest non-done, non-blocked status — which reproduces the pre-Backlog behaviour
 * exactly for a registry that was customized away from our ids.
 */
function readyStatus(statuses: readonly StatusPick[]): string {
  const ordered = [...statuses].sort((a, z) => a.position - z.position);
  // The `todo` preference is by id, so it MUST be re-checked against the flags: a project is free to
  // mark the literal `todo` status done or blocked (the suite has exactly such a project), and
  // trusting the id alone would drop new work straight into a done column. The flags are the
  // authority; the id is only a tie-breaker among statuses that are already valid landing spots.
  const canonical = ordered.find((s) => s.id === "todo" && !s.isDone && !s.isBlocked);
  if (canonical) return canonical.id;
  return (ordered.find((s) => !s.isDone && !s.isBlocked) ?? ordered.find((s) => !s.isDone) ?? ordered[0])?.id ?? "todo";
}

function toProjectStatus(r: StatusRow): ProjectStatus {
  const out: ProjectStatus = { id: r.id, label: r.label, color: r.color, isDone: r.isDone, isBlocked: r.isBlocked, position: r.position };
  if (r.wipLimit != null) out.wipLimit = r.wipLimit;
  return out;
}

const STATUS_SELECT = `SELECT id, position, label, color, is_done AS "isDone", is_blocked AS "isBlocked", wip_limit AS "wipLimit"
  FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL ORDER BY position, id`;

// Synth-on-read: materialized rows if ANY exist for the project, else the 4 synthesized defaults.
export async function effectiveStatuses(c: PoolClient, projectId: string): Promise<StatusRow[]> {
  const r = await c.query<StatusRow>(STATUS_SELECT, [projectId]);
  return r.rows.length > 0 ? r.rows : DEFAULT_STATUSES.map((s) => ({ ...s }));
}

// True once ANY status row exists for the project (incl. soft-deleted) — the "never re-synth after
// the first write" gate.
async function statusesMaterialized(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM pm_project_statuses WHERE project_id = $1 LIMIT 1`, [projectId]);
  return !!r.rows[0];
}

// The first status-editor write materializes the 4 defaults so the synthesized set is never
// silently lost once real rows start to exist.
async function ensureMaterialized(c: PoolClient, tenantId: string, projectId: string): Promise<void> {
  if (await statusesMaterialized(c, projectId)) return;
  for (const s of DEFAULT_STATUSES) {
    await c.query(
      `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, project_id, id) DO NOTHING`,
      [s.id, tenantId, projectId, s.position, s.label, s.color, s.isDone, s.isBlocked, s.wipLimit, config.originSite],
    );
  }
}

// ---------------- Dependency-chain enforcement (P4-I1/I2/I3, decision 17; migration 0088) ----------------
// `dependsOn` (task ids), the cycle guard, the reschedule cascade and the Gantt dependency edges
// were already built — see platform-ui's `lib/pm.ts` — but were advisory only: nothing on the
// server stopped a blocked task from being started. This section is the enforcement half, kept
// on the EXISTING `dependsOn` DAG per the plan's own recommendation ("a chain is the linear case
// of the graph we already have; a second overlapping model needs its own cycle guard and its own
// bugs") — there is no separate "chain" table.
//
// Minimal shape of one open blocker, named so a 409/blocked-task read can tell a caller WHICH
// task(s) are in the way (decision 17: "name the blocker").
interface OpenBlocker { id: string; title: string; projectId: string; status: string }

/** The open (non-done) tasks among `dependsOn`, resolved against EACH dependency's OWN project's
 *  effective statuses (a dependency can live in a different project than the task that depends on
 *  it) — mirrors platform-ui's `openDependencies()` (lib/pm.ts) exactly, so client and server
 *  agree on what "open" means. A soft-deleted or cross-tenant (RLS-invisible) dependency task
 *  simply doesn't come back from the SELECT, so it silently stops counting as a blocker — the
 *  same "gone == closed" reading `deleteTask` below relies on. */
async function openDependencies(c: PoolClient, dependsOn: readonly string[]): Promise<OpenBlocker[]> {
  if (dependsOn.length === 0) return [];
  const rows = await c.query<{ id: string; title: string; projectId: string; status: string }>(
    `SELECT id, title, project_id AS "projectId", status FROM pm_tasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [dependsOn],
  );
  const open: OpenBlocker[] = [];
  const cache = new Map<string, StatusRow[]>();
  for (const r of rows.rows) {
    let statuses = cache.get(r.projectId);
    if (!statuses) {
      statuses = await effectiveStatuses(c, r.projectId);
      cache.set(r.projectId, statuses);
    }
    const isDone = statuses.find((s) => s.id === r.status)?.isDone ?? false;
    if (!isDone) open.push(r);
  }
  return open;
}

// P4-I3 (decision 14, ADOPTED): hard-block is the ONLY enforced mode — there is deliberately no
// per-project "warn" setting (a warn-only mode is the thing the plan explicitly rejected: "the
// constraint does not exist"). The per-project knob is a binary override instead — enforcement ON
// (default) or explicitly turned OFF for this project — and the override is audited for free: it
// is written through `patchProject`'s existing "manage"-gated, event+activity-logged path below,
// never a second, unaudited mechanism.
async function dependencyEnforcementEnabled(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query<{ enforcement: boolean }>(
    `SELECT dependency_enforcement AS enforcement FROM pm_project_meta WHERE project_id = $1`,
    [projectId],
  );
  return r.rows[0]?.enforcement ?? true; // no meta row yet -> the default, hard-enforced
}

/** P4-I1 — applied to the status a `patchTask` write is about to persist, AFTER the existing
 *  subtask/progress/custom-status coupling above has computed it. FLAG/FUNCTION-DRIVEN — never a
 *  literal id match (the same discipline `readyStatus`/`intakeStatus` already use, precisely
 *  because a project is free to flag the literal `todo` status done or blocked).
 *
 *  ═══ THE RULE (coordinated with the platform-ui `reachableStatusIds` gate — the two must agree
 *  byte-for-byte, this is the wording pinned against both sides) ═══
 *  While a task has open dependencies (`openDeps` non-empty) and enforcement is on for its
 *  project:
 *    1. Blocked work cannot START. A transition is rejected (409) into any status that is
 *       NEITHER `isDone` NOR `isBlocked` and is NOT the project's intake status (`intakeStatus`,
 *       Backlog) — i.e. the active-work spine (ToDo/Doing/any custom in-between column).
 *    2. Blocked work CAN be closed. A transition into an `isDone` status is always allowed even
 *       with open dependencies — closing a blocked task never unblocks anything (only closing
 *       its BLOCKER does, via `promoteClearedDependents` below), and refusing to let someone
 *       close work they actually finished is the behaviour that gets a constraint like this
 *       disabled entirely. The caller is expected to note the override in its own audit trail
 *       (decision 14's philosophy) — `patchTask` does, via `completedWithOpenDependencies` on its
 *       `pm.task.updated` event/activity metadata.
 *    3. The task's OWN current status is ALWAYS reachable (a true no-op with respect to status).
 *       An unrelated field edit (retitling, adding a subtask, logging time) on an already-blocked
 *       task must never 400 just because the status happened to carry over unchanged.
 *  `openDeps` empty, or enforcement off for this project, is a full pass-through (today's fully
 *  advisory behaviour restored; a project may opt out entirely via P4-I3's override).
 */
function enforceStartGate(args: {
  status: string;
  priorStatus: string;
  statuses: readonly StatusRow[];
  openDeps: readonly OpenBlocker[];
}): void {
  const { status, priorStatus, statuses, openDeps } = args;
  if (openDeps.length === 0) return;
  if (status === priorStatus) return; // rule 3 — never disable a no-op
  const row = statuses.find((s) => s.id === status);
  const reachable = status === intakeStatus(statuses) || !!row?.isBlocked || !!row?.isDone;
  if (reachable) return;
  // NOTE — the platform's global `HttpErrorFilter` reshapes EVERY HttpException response down to
  // `{ error, field? }` (contract parity with the old Fastify core), discarding any other key a
  // thrown exception's response object carries. So "name the blocker" (decision 17) has to live
  // IN the message string here — a structured `blockedBy` field would silently vanish before it
  // ever reached a caller. `blockedBy` is still available, unconditionally, on the task's own GET
  // (via `openDependencies()`), for a UI that wants to render it ahead of ever attempting the PATCH.
  const names = openDeps.map((d) => `"${d.title}"`).join(", ");
  throw new ConflictException(
    `cannot move to "${status}": blocked by ${openDeps.length} open dependenc${openDeps.length === 1 ? "y" : "ies"} (${names})`,
  );
}

/** P4-I2 (decision 13) + decision 17's auto-clear half — given a task CURRENTLY sitting in
 *  `currentStatus` whose open dependencies just became empty, returns the promotion to apply, or
 *  `null` if this task isn't in a state that clearing should touch. Two cases promote, both
 *  landing on the project's `readyStatus` (never the literal "todo" — a project may have
 *  flagged that id done or blocked, see `readyStatus`'s own header):
 *   - Backlog (the project's `intakeStatus`) -> ToDo: decision 13's literal ask.
 *   - a SYSTEM-set Blocked (`blockReason === null`) -> ToDo: decision 17's "clear automatically
 *     when it closes". A HUMAN-set block (non-null reason — an external wait unrelated to this
 *     dependency graph) is deliberately NOT touched here; only the system half auto-clears. */
function clearedStatusIfReady(
  statuses: readonly StatusRow[],
  currentStatus: string,
  currentBlockReason: string | null,
): { status: string; blockReason: null } | null {
  const row = statuses.find((s) => s.id === currentStatus);
  const isSystemBlocked = !!row?.isBlocked && currentBlockReason === null;
  if (currentStatus === intakeStatus(statuses) || isSystemBlocked) {
    return { status: readyStatus(statuses), blockReason: null };
  }
  return null;
}

/** P4-I2/decision 17 — after `closedTaskId` stops counting as an open blocker (it just completed,
 *  or is being deleted — see the two call sites below), re-checks every task that named it in
 *  `dependsOn`: if it was the LAST open blocker, promotes per `clearedStatusIfReady`. This is a
 *  write triggered by someone ELSE's action (the plan's own words), so it is never silent — every
 *  caller emits a `pm.task.dependencyCleared` event (inside the same transaction) and, once that
 *  transaction commits, a `writeActivity` audit row (P4-I6's ball-holder notification is a
 *  separate, not-yet-built ticket; this only guarantees the event+audit trail the plan requires).
 *  Returns the promoted rows for the caller to audit/notify with, mirroring how `patchTask`
 *  already surfaces its recurrence-spawn result to the code after the transaction commits. */
async function promoteClearedDependents(
  c: PoolClient,
  closedTaskId: string,
): Promise<{ id: string; projectId: string; fromStatus: string; toStatus: string }[]> {
  const dependents = await c.query<{ id: string; projectId: string; status: string; blockReason: string | null; dependsOn: string[] }>(
    `SELECT id, project_id AS "projectId", status, block_reason AS "blockReason", depends_on AS "dependsOn"
     FROM pm_tasks WHERE $1 = ANY(depends_on) AND deleted_at IS NULL`,
    [closedTaskId],
  );
  const promoted: { id: string; projectId: string; fromStatus: string; toStatus: string }[] = [];
  for (const d of dependents.rows) {
    const stillOpen = await openDependencies(c, d.dependsOn);
    if (stillOpen.length > 0) continue; // another blocker remains — nothing to promote yet
    const statuses = await effectiveStatuses(c, d.projectId);
    const cleared = clearedStatusIfReady(statuses, d.status, d.blockReason);
    if (!cleared) continue;
    await c.query(
      `UPDATE pm_tasks SET status = $2, block_reason = NULL, updated_at = now() WHERE id = $1`,
      [d.id, cleared.status],
    );
    promoted.push({ id: d.id, projectId: d.projectId, fromStatus: d.status, toStatus: cleared.status });
  }
  return promoted;
}

// ---------------- Burndown snapshots (P2-07, pm-console-ux-design-spec §4, §0 D-2) ----------------
// One row per (tenant, project, day) in pm_progress_snapshots (migration 0040). The nightly job
// (burndown-job.ts) pre-warms every project; the LAZY upsert-on-read below is the correctness
// backstop — called on every burndown GET so a project the job never reached is still current.
// ON CONFLICT keeps this to exactly one row per day no matter how many times it runs that day.
export async function upsertTodaySnapshot(c: PoolClient, tenantId: string, projectId: string): Promise<void> {
  // Reuses effectiveStatuses()'s is_done FLAG derivation — never a literal status id — so a
  // renamed/custom done status (P2-04) still counts correctly.
  const statuses = await effectiveStatuses(c, projectId);
  const doneIds = statuses.filter((s) => s.isDone).map((s) => s.id);
  const agg = await c.query<{ open: string; done: string; avg: string | null }>(
    `SELECT
       COUNT(*) FILTER (WHERE NOT (status = ANY($2::text[]))) AS open,
       COUNT(*) FILTER (WHERE status = ANY($2::text[])) AS done,
       AVG(progress) AS avg
     FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`,
    [projectId, doneIds],
  );
  const row = agg.rows[0];
  const openCount = Number(row?.open ?? 0);
  const doneCount = Number(row?.done ?? 0);
  const avgProgress = Math.round(Number(row?.avg ?? 0));
  // P3-05: per-status counts keyed by the task's raw status id (incl. any orphan id left over
  // from a since-deleted status — kept as-is, never pruned) for the flow-diagram view.
  const byStatus = await c.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL GROUP BY status`,
    [projectId],
  );
  const statusCounts: Record<string, number> = {};
  for (const r of byStatus.rows) statusCounts[r.status] = Number(r.n);
  await c.query(
    `INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, status_counts, origin_site)
     VALUES ($1, $2, current_date, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, project_id, snapshot_date)
     DO UPDATE SET open_count = $3, done_count = $4, avg_progress = $5, status_counts = $6, updated_at = now()`,
    [tenantId, projectId, openCount, doneCount, avgProgress, JSON.stringify(statusCounts), config.originSite],
  );
}

function slugifyStatusId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "status";
}

function uniqueStatusId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 37)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}_${Date.now().toString(36)}`;
}

// ---------------- Templates (P3-01) ----------------
// Tenant-scoped (not project-scoped — templates outlive/precede any one project) registry of two
// payload kinds. Payload shape is validated app-side (never trusted from the client past this
// gate); `kind` is immutable once created (PATCH only ever validates against the EXISTING row's
// kind, read from the DB, never from the request body).
type TemplateKind = "task" | "doc";
const TEMPLATE_KINDS = new Set<TemplateKind>(["task", "doc"]);

interface TaskTemplatePayload {
  title: string; description?: string; priority?: string; estimateMinutes?: number;
  subtasks?: string[]; tagLabels?: string[];
}
interface DocTemplatePayload { title: string; body: string }

function validateTemplatePayload(kind: string, payload: unknown): TaskTemplatePayload | DocTemplatePayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BadRequestException("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (!title) throw new BadRequestException("payload.title required");

  if (kind === "doc") {
    if (typeof p.body !== "string") throw new BadRequestException("payload.body must be a string");
    return { title, body: p.body };
  }
  if (kind === "task") {
    const out: TaskTemplatePayload = { title };
    if (p.description !== undefined) {
      if (typeof p.description !== "string") throw new BadRequestException("payload.description must be a string");
      out.description = p.description;
    }
    if (p.priority !== undefined) {
      if (typeof p.priority !== "string" || !PRIORITIES.has(p.priority)) throw new BadRequestException("payload.priority invalid");
      out.priority = p.priority;
    }
    if (p.estimateMinutes !== undefined) {
      if (typeof p.estimateMinutes !== "number" || !Number.isInteger(p.estimateMinutes) || p.estimateMinutes <= 0) {
        throw new BadRequestException("payload.estimateMinutes must be a positive integer");
      }
      out.estimateMinutes = p.estimateMinutes;
    }
    if (p.subtasks !== undefined) {
      if (!Array.isArray(p.subtasks) || !p.subtasks.every((s) => typeof s === "string")) {
        throw new BadRequestException("payload.subtasks must be an array of strings");
      }
      out.subtasks = (p.subtasks as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    if (p.tagLabels !== undefined) {
      if (!Array.isArray(p.tagLabels) || !p.tagLabels.every((s) => typeof s === "string")) {
        throw new BadRequestException("payload.tagLabels must be an array of strings");
      }
      out.tagLabels = (p.tagLabels as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return out;
  }
  // Unreachable when called after the TEMPLATE_KINDS.has() gate at the call sites, but kept
  // fail-closed in case this is ever called with an unvalidated kind.
  throw new BadRequestException("invalid kind");
}

function validWipLimit(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new BadRequestException("wipLimit must be a positive integer or null");
  }
  return v;
}

// Full PmTask projection (dates as YYYY-MM-DD text; loggedMinutes summed from time_entries).
// WD-28: shortCode/seq come from the joined project + the task's own column; displayCode is
// computed server-side (CODE-SEQ, e.g. "WEB-142") so every consumer reads one canonical string
// rather than re-deriving the "-" join in N places. Either half can be null (a project that
// somehow predates the 0050 backfill, or a task created outside the allocator) — displayCode is
// null in that case rather than a malformed partial string.
const TASK_SELECT = `
  SELECT t.id, t.project_id AS "projectId", p.name AS "projectName", t.title, t.description,
         t.status, t.priority, t.progress, t.assignee, t.subtasks, t.milestone_id AS "milestoneId",
         to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate",
         t.estimate_minutes AS "estimateMinutes", t.depends_on AS "dependsOn", t.tags, t.custom_fields AS "customFields", t.updated_at AS "updatedAt",
         t.block_reason AS "blockReason",
         t.recurrence, p.short_code AS "projectShortCode", t.seq,
         CASE WHEN p.short_code IS NOT NULL AND t.seq IS NOT NULL THEN p.short_code || '-' || t.seq ELSE NULL END AS "displayCode",
         COALESCE((SELECT SUM(minutes) FROM time_entries te WHERE te.pm_task_id = t.id AND te.deleted_at IS NULL), 0)::int AS "loggedMinutes",
         COALESCE((
           SELECT json_agg(json_build_object('userId', pta.user_id, 'name', u.name) ORDER BY u.name)
           FROM pm_task_assignees pta JOIN users u ON u.id = pta.user_id
           WHERE pta.tenant_id = t.tenant_id AND pta.task_id = t.id AND pta.role = 'contributor'
         ), '[]'::json) AS "contributors"
  FROM pm_tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL`;

interface TaskRow {
  id: string; projectId: string; projectName: string; title: string; description: string;
  status: string; priority: string; progress: number; assignee: Assignee; subtasks: unknown[];
  milestoneId: string | null; startDate: string | null; dueDate: string | null;
  estimateMinutes: number | null; dependsOn: string[]; tags: string[]; customFields: Record<string, unknown>; updatedAt: string | null; loggedMinutes: number;
  blockReason: string | null; // P4-I decision 17 — non-null = HUMAN-set Blocked (a required reason); null while isBlocked = SYSTEM-set (an open dependency)
  recurrence: TaskRecurrence | null;
  projectShortCode: string | null; seq: number | null; displayCode: string | null;
  contributors: Contributor[]; // TR-02 — additive; joined off pm_task_assignees, never the blob
}

interface TagRow { id: string; label: string; color: string; }

async function fetchProjectTag(c: PoolClient, projectId: string, tagId: string): Promise<TagRow | undefined> {
  const r = await c.query<TagRow>(
    `SELECT id, label, color FROM pm_project_tags WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [tagId, projectId],
  );
  return r.rows[0];
}

function validAssignee(a: unknown): Assignee {
  if (!a || typeof a !== "object") return null;
  const r = a as Record<string, unknown>;
  const kind = r.kind as string;
  if (kind !== "person" && kind !== "department" && kind !== "division") return null;
  if (typeof r.refId !== "string" || typeof r.responsibleId !== "string" || !r.refId || !r.responsibleId) return null;
  return {
    kind,
    refId: r.refId,
    refName: typeof r.refName === "string" ? r.refName : r.refId,
    responsibleId: r.responsibleId,
    responsibleName: typeof r.responsibleName === "string" ? r.responsibleName : r.responsibleId,
  };
}

// ---------------- TR-02/TR-34 — pm_task_assignees dual-write (§3.1, migrations 0054/0063) ----------------
// Every PM write path that sets/updates the `assignee` JSONB blob calls this in the SAME
// `withTenants` transaction as the blob write itself (never a separate connection/transaction) —
// a partial write (blob without rows, or vice versa) is structurally impossible: either both
// halves commit together or an error rolls the WHOLE transaction back, blob included.
//
// TR-01/TR-02 hard constraints honoured here (§15 amendment log rulings, not preference):
//  (1) person rows pass `ref::uuid::text` — NEVER the raw blob string — as assignee_ref, so it is
//      byte-identical to `user_id::text` no matter how the blob's string happened to be cased. A
//      malformed or unknown ref fails LOUDLY at this INSERT (uuid-parse error or FK violation) and
//      rolls back the entire task write, by design.
//  (2) `origin_site` is passed explicitly from `config.originSite` on every insert — never left to
//      the column's `DEFAULT 'central'`.
//  (4) unit-owned tasks (kind department/division) never get an invented person row: assignee_kind
//      stays the unit kind, user_id stays NULL. The responsible row (if any) is the ONLY
//      person-grain row for a unit-owned task.
//
// TR-34 (0063, §15 ①): owner/responsible are now TIME-AWARE — a reassignment must CLOSE the old
// interval and OPEN a new one, never DELETE+INSERT (which would erase the fact that the old value
// was ever true, letting a recomputed PAST fact slice silently move to the new owner). Point (3) of
// the TR-01 list above ("respected by DELETING the existing rows first, then INSERTing") is
// SUPERSEDED by this ticket for owner/responsible specifically — see the four-case transition below,
// which achieves the same "never transiently violate the invariant" property through the EXCLUDE
// constraint (0063) instead of through delete-then-insert ordering.
//
// Contributors are NOT touched here — they are a separate, additive capability with their own
// add/removeContributor lifecycle (below), never implied by the owner/responsible blob, and
// deliberately NOT interval-tracked (see 0063's design-judgement header comment for why).
type AssigneeKindDb = "person" | "department" | "division";
interface RoleTarget { kind: AssigneeKindDb; ref: string; userId: string | null }

/** What the blob says role's value SHOULD be, or null when the role should have no open row.
 *  Person refs are canonicalized (lowercased) HERE, not just at the SQL boundary: the "same value
 *  as what's already open" comparison in applyRoleTransition below compares `target.ref` directly
 *  against the STORED (already-canonical) `assignee_ref`, so a same-self dedup or a same-value skip
 *  must not be defeated by a harmless case difference in the incoming blob (TR-01 hard constraint 1,
 *  restated for the interval-aware write path). The `::uuid::text` cast at every actual INSERT/
 *  UPDATE below is kept as the AUTHORITATIVE, format-VALIDATING canonicalization (fails loudly on a
 *  malformed ref) — this lowercase is a cheap pre-comparison normalization, not a replacement for it. */
function ownerTarget(assignee: Assignee): RoleTarget | null {
  if (!assignee) return null;
  if (assignee.kind === "person") {
    const ref = assignee.refId.toLowerCase();
    return { kind: "person", ref, userId: ref };
  }
  return { kind: assignee.kind, ref: assignee.refId, userId: null };
}
function responsibleTarget(assignee: Assignee): RoleTarget | null {
  if (!assignee || !assignee.responsibleId) return null;
  const ref = assignee.responsibleId.toLowerCase();
  // Same-self dedup mirrors the 0054 backfill's rule: a person owner who IS the responsible gets no
  // separate responsible row (pm-task-assignees.test.ts case 1 / pm-dual-write.test.ts). Compared
  // case-INsensitively (both lowercased) so a harmless case difference between refId/responsibleId
  // never manufactures a phantom separate responsible row.
  if (assignee.kind === "person" && assignee.refId.toLowerCase() === ref) return null;
  return { kind: "person", ref, userId: ref };
}

/** The ONE open row for (tenant, task, role), if any. The 0063 EXCLUDE constraint guarantees there
 *  is at most one — this SELECT never needs to disambiguate multiple candidates. */
async function openRoleRow(
  c: PoolClient,
  tenantId: string,
  taskId: string,
  role: "owner" | "responsible",
): Promise<{ id: string; assigneeKind: string; assigneeRef: string; validFrom: string } | null> {
  const r = await c.query<{ id: string; assignee_kind: string; assignee_ref: string; valid_from: string }>(
    `SELECT id, assignee_kind, assignee_ref, valid_from::text AS valid_from FROM pm_task_assignees
      WHERE tenant_id = $1 AND task_id = $2 AND role = $3 AND valid_to IS NULL`,
    [tenantId, taskId, role],
  );
  const row = r.rows[0];
  return row ? { id: row.id, assigneeKind: row.assignee_kind, assigneeRef: row.assignee_ref, validFrom: row.valid_from } : null;
}

/** Apply ONE role's (owner or responsible) close/open transition for a single task, inside the
 *  caller's transaction. `today` is passed in (not defaulted) so it is computed exactly once per
 *  syncTaskAssignees call, matching diffMembershipSweep's pattern in core/dept-resolution.ts.
 *
 *  Four cases (never a fifth — this is deliberately exhaustive, mirrors diffMembershipSweep's
 *  add/amend/transfer/remove shape for the unit axis):
 *   - no existing open row, a target is wanted           -> INSERT a fresh open row (valid_from=today)
 *   - existing open row, target is null (role removed)   -> opened TODAY: DELETE outright (never
 *                                                             represented a day boundary beyond
 *                                                             today, nothing to preserve); opened
 *                                                             EARLIER: close it (valid_to = today-1)
 *   - existing open row, target DIFFERS                  -> opened TODAY: UPDATE in place (amend,
 *                                                             same as diffMembershipSweep's "amend");
 *                                                             opened EARLIER: close (valid_to =
 *                                                             today-1) + INSERT a new open row
 *   - existing open row, target is IDENTICAL              -> no-op (preserves valid_from/updated_at,
 *                                                             avoids churning history on every save)
 *
 *  Closing always uses `today - 1`, NEVER `today` (unlike diffMembershipSweep's "remove" case,
 *  which closes at `today` for org memberships) — a deliberate, documented deviation from the 0055
 *  precedent. Reason: org-structure edits are rare (one sweep per PUT), but a task's assignee can
 *  realistically be changed more than once on the SAME day. If "remove" closed at `today` and a
 *  LATER call the same day opened a fresh row for that role, the fresh row's range (starting today)
 *  would overlap the just-closed row (also covering today) and the EXCLUDE constraint would reject
 *  it. Always closing at `today - 1` keeps `today` permanently free for whatever this-or-a-later
 *  same-day call needs to open, and the "opened today -> delete/amend instead of close" branches
 *  above mean a row is NEVER closed with `valid_to = today` in the first place — so this file never
 *  produces the state the org-membership convention relies on being rare. */
/** INSERT one fresh open interval. Deliberately TWO DIFFERENT statement texts branched IN
 *  TYPESCRIPT (mirroring the original 0054 dual-write's own person-vs-unit split), NOT a single
 *  statement with a SQL-side `CASE WHEN $n = 'person' THEN ...::uuid::text ELSE ... END`: Postgres's
 *  extended-query-protocol parameter typing fixes ONE type per parameter for the WHOLE statement,
 *  inferred from ANY of its occurrences — so a bind parameter used as both `$5::uuid::text` and
 *  `$5::text` in the same query gets typed as `uuid` throughout, and a unit ref like
 *  "dept-engineering" then fails `invalid input syntax for type uuid` even on the branch that would
 *  never have executed. Confirmed the hard way (pm-dual-write.test.ts's department-owner case) —
 *  branching in JS is the only reliable fix, not a style preference. */
async function insertOpenRow(
  c: PoolClient,
  tenantId: string,
  taskId: string,
  role: "owner" | "responsible",
  target: RoleTarget,
  actorUserId: string | null,
  validFrom: string,
): Promise<void> {
  const cols =
    "tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, created_by, origin_site, valid_from, valid_to";
  if (target.kind === "person") {
    // `$5::uuid::text` validates format + normalizes case (deviation (1)), fails loudly on a
    // malformed/unknown ref (uuid-parse error here, or the user_id FK violation just after).
    await c.query(
      `INSERT INTO pm_task_assignees (${cols})
       VALUES ($1, $2, $3, 'person', $4::uuid::text, $4::uuid, $5, $6, $7::date, NULL)`,
      [tenantId, taskId, role, target.ref, actorUserId, config.originSite, validFrom],
    );
  } else {
    // A unit ref (department/division) is an arbitrary org-node string, NEVER a valid uuid — no
    // cast, user_id stays NULL (deviation (4)).
    await c.query(
      `INSERT INTO pm_task_assignees (${cols})
       VALUES ($1, $2, $3, $4, $5::text, NULL, $6, $7, $8::date, NULL)`,
      [tenantId, taskId, role, target.kind, target.ref, actorUserId, config.originSite, validFrom],
    );
  }
}

/** UPDATE an existing row's VALUE in place (the "amend" case — see applyRoleTransition). Same
 *  JS-side kind branch as insertOpenRow, for the identical Postgres parameter-typing reason. */
async function amendRow(c: PoolClient, rowId: string, target: RoleTarget, actorUserId: string | null): Promise<void> {
  if (target.kind === "person") {
    await c.query(
      `UPDATE pm_task_assignees
          SET assignee_kind = 'person', assignee_ref = $2::uuid::text, user_id = $2::uuid,
              created_by = $3, origin_site = $4, updated_at = now()
        WHERE id = $1`,
      [rowId, target.ref, actorUserId, config.originSite],
    );
  } else {
    await c.query(
      `UPDATE pm_task_assignees
          SET assignee_kind = $2, assignee_ref = $3::text, user_id = NULL,
              created_by = $4, origin_site = $5, updated_at = now()
        WHERE id = $1`,
      [rowId, target.kind, target.ref, actorUserId, config.originSite],
    );
  }
}

// P4-B3: returns whether this role's open value actually changed (insert / amend / transfer /
// remove), so the caller (syncTaskAssignees) knows whether to append a ledger row. A true no-op
// (nothing open, nothing wanted; or the incoming target is identical to what's already open) must
// NOT append — see pm_task_assignment_events' own header: it is a log of WRITES, not a heartbeat.
async function applyRoleTransition(
  c: PoolClient,
  tenantId: string,
  taskId: string,
  role: "owner" | "responsible",
  target: RoleTarget | null,
  actorUserId: string | null,
  today: string,
): Promise<boolean> {
  const existing = await openRoleRow(c, tenantId, taskId, role);

  if (!existing) {
    if (!target) return false; // nothing open, nothing wanted -> true no-op
    await insertOpenRow(c, tenantId, taskId, role, target, actorUserId, today);
    return true;
  }

  const sameValue = existing.assigneeKind === target?.kind && existing.assigneeRef === target?.ref;
  if (sameValue) return false; // identical to what's already open -> no-op, don't churn history

  const openedToday = existing.validFrom === today;

  if (!target) {
    // role removed
    if (openedToday) {
      await c.query(`DELETE FROM pm_task_assignees WHERE id = $1`, [existing.id]);
    } else {
      await c.query(
        `UPDATE pm_task_assignees SET valid_to = $2::date, updated_at = now() WHERE id = $1`,
        [existing.id, addDaysIso(today, -1)],
      );
    }
    return true;
  }

  if (openedToday) {
    // amend the row opened earlier today in place — never close+reopen on the same valid_from,
    // which would try to set valid_to one day BEFORE valid_from and violate the valid_range CHECK.
    // origin_site IS re-stamped here (unlike the close-only path below): an amend replaces the
    // row's actual VALUE with a new true one, exactly like an INSERT establishing a fresh value —
    // ruling (2)'s "explicit config.originSite on every write that establishes a value" applies to
    // it the same way. A mere close (ending an interval's validity, not changing what it once was)
    // does not re-stamp origin_site, on purpose.
    await amendRow(c, existing.id, target, actorUserId);
    return true;
  }

  // genuine transfer: close yesterday, open a new interval today.
  await c.query(
    `UPDATE pm_task_assignees SET valid_to = $2::date, updated_at = now() WHERE id = $1`,
    [existing.id, addDaysIso(today, -1)],
  );
  await insertOpenRow(c, tenantId, taskId, role, target, actorUserId, today);
  return true;
}

// P4-B1..B3 — the assignment-history LEDGER (migration 0087). One row per WRITE that actually
// changed the ball (assignee.refId/kind) or the responsible (assignee.responsibleId), recording the
// task's status "at the moment of handoff" (plan §1.5). Deliberately centralized HERE, inside the
// one function every assignee-writing path already calls (createTask, patchTask reassignment,
// recurrence spawn, duplicateTask — see syncTaskAssignees below), rather than a call added at each
// of those four sites separately: a write path that forgets to call this ledger insert would lose
// history silently and nothing would surface it (the whole risk this ticket exists to close), so the
// append is made structurally impossible to skip by living inside the SAME dual-write choke point
// the blob/pm_task_assignees invariant already depends on, instead of being one more thing four
// different call sites must each remember to do.
async function appendAssignmentEvent(
  c: PoolClient,
  tenantId: string,
  taskId: string,
  assignee: Assignee,
  statusId: string,
  note: string | null,
  actorUserId: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO pm_task_assignment_events
       (tenant_id, task_id, ref_id, ref_kind, responsible_id, status_id, note, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, taskId, assignee?.refId ?? null, assignee?.kind ?? null, assignee?.responsibleId ?? null, statusId, note, actorUserId],
  );
}

async function syncTaskAssignees(
  c: PoolClient,
  tenantId: string,
  taskId: string,
  assignee: Assignee,
  actorUserId: string | null,
  statusId: string,
  note: string | null = null,
): Promise<void> {
  const today = todayIso();
  const ownerChanged = await applyRoleTransition(c, tenantId, taskId, "owner", ownerTarget(assignee), actorUserId, today);
  const responsibleChanged = await applyRoleTransition(c, tenantId, taskId, "responsible", responsibleTarget(assignee), actorUserId, today);
  // Append ONLY when something actually changed — a syncTaskAssignees call that turned out to be a
  // true no-op (e.g. a PATCH that included `assignee` but with the same value already open) must not
  // churn the ledger, mirroring applyRoleTransition's own no-churn rule for pm_task_assignees itself.
  if (ownerChanged || responsibleChanged) {
    await appendAssignmentEvent(c, tenantId, taskId, assignee, statusId, note, actorUserId);
  }
}

export interface AssigneeDriftResult {
  taskId: string;
  drift: boolean;
  blobOwnerKind: string | null;
  blobOwnerRef: string | null;
  blobResponsibleRef: string | null;
  rowOwnerKind: string | null;
  rowOwnerRef: string | null;
  rowResponsibleRef: string | null;
}

// TR-02 drift guard (§3.1 point 5 — the write-time HOOK; TR-07 wires this into a nightly
// per-tenant sweep, same shape as the ORG-7 service-reconciler's sweepDriftAndOrphans /
// startDriftSweepLoop). Re-derives the row-side owner/responsible refs from pm_task_assignees and
// compares them against the CURRENT pm_tasks.assignee blob for one task, inside the SAME
// transaction as the write that just happened. Read-only; never mutates. In a correctly-functioning
// dual-write this never reports drift — it exists so a future edit that breaks the invariant is
// caught the moment it happens, not months later at appraisal time.
export async function assigneeDrift(c: PoolClient, tenantId: string, taskId: string): Promise<AssigneeDriftResult> {
  const taskRow = await c.query<{ assignee: Assignee }>(
    `SELECT assignee FROM pm_tasks WHERE id = $1 AND tenant_id = $2`,
    [taskId, tenantId],
  );
  const blob = taskRow.rows[0]?.assignee ?? null;

  // TR-34: scope to the OPEN row only — the blob reflects CURRENT state, and closed historical
  // intervals now coexist beside it (0063). `valid_to IS NULL` picks exactly the row that competes
  // with the blob; the 0063 EXCLUDE constraint guarantees there is at most one per role.
  const rows = await c.query<{ role: string; assignee_kind: string; assignee_ref: string }>(
    `SELECT role, assignee_kind, assignee_ref FROM pm_task_assignees
      WHERE tenant_id = $1 AND task_id = $2 AND role IN ('owner','responsible') AND valid_to IS NULL`,
    [tenantId, taskId],
  );
  const ownerRow = rows.rows.find((r) => r.role === "owner") ?? null;
  const responsibleRow = rows.rows.find((r) => r.role === "responsible") ?? null;

  const blobOwnerKind = blob?.kind ?? null;
  // person refs are compared canonically (lowercased) — the row side is ALWAYS canonical
  // (cast through ::uuid::text at write time), so a case-only difference in the blob must not
  // read as drift.
  const blobOwnerRef = blob ? (blob.kind === "person" ? blob.refId.toLowerCase() : blob.refId) : null;
  const blobResponsibleRef = blob?.responsibleId ? blob.responsibleId.toLowerCase() : null;

  const rowOwnerKind = ownerRow?.assignee_kind ?? null;
  const rowOwnerRef = ownerRow?.assignee_ref ?? null;
  // Same-self dedup mirrors syncTaskAssignees: a person-owner who IS the responsible has no
  // separate responsible row, so the effective row-side responsible ref falls back to the owner's.
  const rowResponsibleRef = responsibleRow?.assignee_ref ?? (ownerRow?.assignee_kind === "person" ? ownerRow.assignee_ref : null);

  const drift = blobOwnerKind !== rowOwnerKind || blobOwnerRef !== rowOwnerRef || blobResponsibleRef !== rowResponsibleRef;

  return { taskId, drift, blobOwnerKind, blobOwnerRef, blobResponsibleRef, rowOwnerKind, rowOwnerRef, rowResponsibleRef };
}

// Logs (never throws) when assigneeDrift finds a mismatch — called right after every dual-write so
// a regression surfaces immediately as a greppable log line, matching the codebase's existing
// drift-sweep convention (see reconcile-consumer.ts's "[SERVICE-DRIFT-SWEEP]"). A drift guard that
// could itself fail the request it's guarding would be worse than no guard, so this never throws.
export async function logAssigneeDriftIfAny(c: PoolClient, tenantId: string, taskId: string): Promise<AssigneeDriftResult> {
  const result = await assigneeDrift(c, tenantId, taskId);
  if (result.drift) {
    // eslint-disable-next-line no-console
    console.warn("[PM-ASSIGNEE-DRIFT] reports.assignee_drift", result);
  }
  return result;
}

async function fetchTask(c: PoolClient, id: string): Promise<TaskRow | undefined> {
  const rows = await c.query<TaskRow>(`${TASK_SELECT} AND t.id = $1`, [id]);
  return rows.rows[0];
}

async function projectExists(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
  return !!r.rows[0];
}

// ---------------- Doc versions (P3-10) ----------------
// Append-only history for pm_docs. The doc row itself stays "latest"; every version that ever
// changed title/body lives here, never mutated once written.
const VERSION_RE = /^\d+$/;

function parseVersion(v: string): number {
  if (!VERSION_RE.test(v)) throw new BadRequestException("version must be a positive integer");
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException("version must be a positive integer");
  return n;
}

// Inserts the next append-only history row for `docId`. Pass an explicit `version` (only ever 1,
// from createDoc) or null to have it computed as MAX(version)+1 — callers computing MAX(version)+1
// MUST already hold the pm_docs row lock (SELECT ... FOR UPDATE) so concurrent writers serialize
// through it and can never race to the same next version number (UNIQUE(tenant_id, doc_id,
// version) is the hard backstop if that invariant is ever violated).
async function appendDocVersion(
  c: PoolClient,
  tenantId: string,
  docId: string,
  version: number | null,
  title: string,
  body: string,
  authorId: string | null,
): Promise<void> {
  let v = version;
  if (v === null) {
    const next = await c.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pm_doc_versions WHERE tenant_id = $1 AND doc_id = $2`,
      [tenantId, docId],
    );
    v = next.rows[0].next;
  }
  await c.query(
    `INSERT INTO pm_doc_versions (id, tenant_id, doc_id, version, title, body, author_id, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), tenantId, docId, v, title, body, authorId, config.originSite],
  );
}

// Resolves a doc-scoped route's projectId for authz (kind: "pm_project" needs a project id) from
// the doc row itself — the doc-scoped version endpoints never take projectId as a route param.
// Tenant-scoped (RLS), so a doc belonging to another tenant or a soft-deleted doc reads as absent
// -> the caller 404s, exactly like every other cross-tenant/forged-id probe in this file.
async function resolveDocProjectId(tenantId: string, docId: string): Promise<string> {
  const projectId = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM pm_docs WHERE id = $1 AND deleted_at IS NULL`, [docId]);
    return r.rows[0]?.projectId;
  });
  if (!projectId) throw new NotFoundException("doc not found");
  return projectId;
}

// ══════════════════════ Task-creation SERVICE (MI-03) ══════════════════════════════════════════
// Extracted from `PmController.createTask` — SAME code, now callable in-process by another
// subsystem, so nothing outside this module ever writes `pm_tasks`.
//
// WHY: the webdev maintenance-intake triage endpoint (core/webdev-change-requests.controller.ts,
// route=`pm_task`) has to create a task INSIDE its own already-open `withTenants` transaction,
// atomically with the change-request UPDATE and its events. Re-implementing the INSERT in core would
// have duplicated everything the PM module keeps correct here — the effective-status ladder and its
// is_done/progress coupling, D17 custom-field validation, the cross-project tag check, WD-28's atomic
// per-project `seq` allocation, TR-02's assignee dual-write + drift log, and the `pm.task.created`
// event — and every one of those would then drift the first time PM changed one of them.
//
// Split in two on purpose so the controller's observable ORDER of failures is unchanged:
//   `normalizePmTaskInput` is pure input validation (no DB) and runs BEFORE `authorize`, exactly
//   where it ran before; `createPmTaskInTx` is everything that needs the connection and runs inside
//   the transaction. Folding both into one function would have turned a 400 on a malformed payload
//   into a 403 for an unauthorized caller (or vice versa) — a contract change nobody asked for.
export interface NormalizedPmTaskInput {
  projectId: string;
  title: string;
  description: string;
  status?: string;
  priority: string;
  dueDate: string | null;
  startDate: string | null;
  milestoneId: string | null;
  estimateMinutes: number | null;
  assignee: Assignee;
  customFields: Record<string, unknown>;
  recurrence: TaskRecurrence | null;
  subtasks: Array<{ id: string; title: string; done: boolean }>;
  tags: string[];
}

/** Pure validation/normalization of a create-task payload. Throws BadRequestException. No DB. */
export function normalizePmTaskInput(b: {
  projectId?: string; title?: string; status?: string; priority?: string; dueDate?: string; startDate?: string;
  milestoneId?: string; description?: string; estimateMinutes?: number; assignee?: unknown;
  customFields?: Record<string, unknown>; recurrence?: unknown; subtasks?: unknown; tags?: unknown;
}): NormalizedPmTaskInput {
  const title = b?.title?.trim();
  if (!b?.projectId || !title) throw new BadRequestException("projectId and title required");
  if (b.priority && !PRIORITIES.has(b.priority)) throw new BadRequestException("invalid priority");
  // ---- subtasks (P3-01): string[] -> [{id,title,done:false}] ----
  if (b.subtasks !== undefined && (!Array.isArray(b.subtasks) || !b.subtasks.every((s) => typeof s === "string"))) {
    throw new BadRequestException("subtasks must be an array of strings");
  }
  const subtasks = Array.isArray(b.subtasks)
    ? (b.subtasks as string[]).map((t) => t.trim()).filter((t) => t.length > 0).map((t) => ({ id: newId(), title: t.slice(0, 200), done: false }))
    : [];
  // ---- tags (P3-01): same cross-project-id validation as patchTask ----
  if (b.tags !== undefined && !Array.isArray(b.tags)) throw new BadRequestException("tags must be an array of tag ids");
  const tagIds = Array.isArray(b.tags) ? (b.tags as unknown[]) : [];
  if (!tagIds.every((tg) => typeof tg === "string" && UUID_RE.test(tg))) throw new BadRequestException("tags must be an array of tag ids");
  return {
    projectId: b.projectId,
    title,
    description: b.description ?? "",
    status: typeof b.status === "string" ? b.status : undefined,
    priority: b.priority ?? "normal",
    dueDate: b.dueDate || null,
    startDate: b.startDate || null,
    milestoneId: b.milestoneId || null,
    estimateMinutes: b.estimateMinutes ?? null,
    assignee: validAssignee(b.assignee),
    customFields: b.customFields ?? {},
    recurrence: validRecurrence(b.recurrence),
    subtasks,
    tags: Array.from(new Set(tagIds as string[])),
  };
}

/** Create ONE pm_task on an already-open tenant-scoped connection.
 *
 *  MUST be called inside `withTenants([tenantId], ...)`: the seq allocation, the INSERT, the
 *  assignee dual-write and the `pm.task.created` event all have to commit or roll back together
 *  (TR-02's rule), and the caller may have further writes of its own in the same transaction.
 *  Returns the new id plus the resolved status so the caller can report/notify without re-reading. */
export async function createPmTaskInTx(
  c: PoolClient,
  tenantId: string,
  actorUserId: string | null,
  n: NormalizedPmTaskInput,
): Promise<{ id: string; status: string }> {
  if (!(await projectExists(c, n.projectId))) throw new NotFoundException("project not found");
  // Validate status against the project's EFFECTIVE status set (synthesized or materialized).
  // P4-B8b: when not supplied, default to the READY status, not "first by position" — that used
  // to mean 'todo' and would now mean 'backlog', silently relocating every task created from the
  // New Task form into a column nobody works from. `readyStatus` keeps today's outcome and stays
  // correct if the editor removed or reordered our ids.
  const statuses = await effectiveStatuses(c, n.projectId);
  let status = readyStatus(statuses);
  if (n.status !== undefined) {
    if (!statuses.some((s) => s.id === n.status)) throw new BadRequestException("invalid status");
    status = n.status;
  }
  // Same flag-driven done-coupling as patchTask: resolve via effectiveStatuses' isDone flag,
  // never the literal id, so a renamed/custom is_done status still forces progress = 100
  // when a task is created directly into it.
  const chosenIsDone = statuses.find((s) => s.id === status)?.isDone ?? false;
  const progress = chosenIsDone ? 100 : 0;
  const cfError = await validateCustomFields(c, tenantId, "pm_task", n.customFields);
  if (cfError) throw new BadRequestException(cfError);
  if (n.tags.length > 0) {
    const valid = await c.query<{ id: string }>(
      `SELECT id FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [n.projectId, n.tags],
    );
    if (valid.rows.length !== n.tags.length) throw new BadRequestException("one or more tag ids are not in this task's project tag registry");
  }
  // WD-28: atomic per-project seq allocation — see project-short-codes.ts / migration 0050
  // for why this single UPDATE...RETURNING (not a read-then-write) is the concurrency-correct
  // mechanism. Same connection/transaction as the INSERT below, so the row lock covers both.
  const seq = await allocateTaskSeq(c, n.projectId);
  const id = newId();
  await c.query(
    `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, seq, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13, $14, $15, $16, $17, $18, $19)`,
    [id, tenantId, n.projectId, n.title, n.description, status, n.priority, progress,
     n.assignee ? JSON.stringify(n.assignee) : null, n.milestoneId, n.startDate, n.dueDate,
     n.estimateMinutes, JSON.stringify(n.customFields), n.recurrence ? JSON.stringify(n.recurrence) : null,
     JSON.stringify(n.subtasks), n.tags, seq, config.originSite],
  );
  // TR-02 dual-write: same transaction as the INSERT above, so blob+rows commit or roll back
  // together — a malformed/unknown person ref fails loudly here and the whole task creation
  // (including the blob) is rolled back, never a partial write.
  // P4-B3: statusId is this task's freshly-chosen status — a create-with-assignee is the FIRST
  // assignment event for this task, so the ledger's very first row for it lands here.
  await syncTaskAssignees(c, tenantId, id, n.assignee, actorUserId, status);
  await logAssigneeDriftIfAny(c, tenantId, id);
  // TR-31: actorId (structured hint -> work-activity-linker.ts rule a "hint:actorId" -> an
  // EXACT person link; also becomes the outbox consumer's actor_user_id).
  await emitEvent(c, tenantId, "pm_task", id, "pm.task.created", { title: n.title, projectId: n.projectId, actorId: actorUserId });
  return { id, status };
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("pm"))
export class PmController {
  // ---------------- Projects ----------------
  @Get(":tenantId/pm/projects/:projectId")
  async getProject(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], async (c) => {
      // P4-H1 — startDate is the base `projects` row's own `start_date` column (already there,
      // simply never selected here before); dueDate remains the authored range's END. Decision 12
      // (ADOPTED): this AUTHORED range is never overwritten from task dates — the derived
      // task-envelope (min task start / max task due) is computed client-side off the tasks this
      // same project already returns via GET .../tasks (P4-H2, platform-ui); the gap between the
      // two IS the slippage signal, so the two must stay independently stored and independently
      // readable, never collapsed into one.
      const proj = await c.query<{ name: string; status: string; startDate: string | null; dueDate: string | null; shortCode: string | null }>(
        `SELECT name, status, to_char(start_date, 'YYYY-MM-DD') AS "startDate", to_char(due_date, 'YYYY-MM-DD') AS "dueDate", short_code AS "shortCode"
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!proj.rows[0]) throw new NotFoundException("project not found");
      // P4-I3/decision 14 — the per-project override: defaults to hard-enforced (true) when no
      // meta row exists yet, exactly like `dependencyEnforcementEnabled` used by the write path.
      const meta = await c.query<{ owner: Assignee; dependencyEnforcement: boolean | null }>(
        `SELECT owner, dependency_enforcement AS "dependencyEnforcement" FROM pm_project_meta WHERE project_id = $1`,
        [projectId],
      );
      const milestones = await c.query(
        `SELECT id, project_id AS "projectId", name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", status
         FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at`,
        [projectId],
      );
      const agg = await c.query<{ task_count: string; avg_progress: string | null }>(
        `SELECT COUNT(*) AS task_count, AVG(progress) AS avg_progress FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const docs = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]);
      const statuses = (await effectiveStatuses(c, projectId)).map(toProjectStatus);
      return {
        id: projectId,
        name: proj.rows[0].name,
        status: proj.rows[0].status,
        shortCode: proj.rows[0].shortCode,
        progress: Math.round(Number(agg.rows[0].avg_progress ?? 0)),
        owner: meta.rows[0]?.owner ?? null,
        startDate: proj.rows[0].startDate,
        dueDate: proj.rows[0].dueDate,
        dependencyEnforcement: meta.rows[0]?.dependencyEnforcement ?? true,
        milestones: milestones.rows,
        statuses,
        docCount: Number(docs.rows[0].n),
        taskCount: Number(agg.rows[0].task_count),
      };
    });
  }

  @Patch(":tenantId/pm/projects/:projectId")
  @HttpCode(200)
  async patchProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { owner?: unknown; status?: string; startDate?: string | null; dueDate?: string | null; dependencyEnforcement?: boolean },
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // P4-H1 — startDate/dueDate together are the AUTHORED range (decision 12); both are plain
      // COALESCE updates on the base row, same shape as the pre-existing dueDate/status pair.
      if (b?.status !== undefined || b?.startDate !== undefined || b?.dueDate !== undefined) {
        await c.query(
          `UPDATE projects SET status = COALESCE($2, status), start_date = COALESCE($3::date, start_date), due_date = COALESCE($4::date, due_date), updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [projectId, b?.status ?? null, b?.startDate ?? null, b?.dueDate ?? null],
        );
      }
      const hasOwnerField = Object.prototype.hasOwnProperty.call(b ?? {}, "owner");
      const hasEnforcementField = Object.prototype.hasOwnProperty.call(b ?? {}, "dependencyEnforcement");
      if (hasOwnerField || hasEnforcementField) {
        const owner = hasOwnerField ? validAssignee(b.owner) : null;
        const enforcement = hasEnforcementField ? !!b.dependencyEnforcement : true; // true = the column DEFAULT on a fresh row
        // P4-I3/decision 14 — this IS the "explicit, audited" override: gated on "manage" above
        // (same authz as every other project-setting write here) and this whole call already
        // emits `pm.project.updated` + `writeActivity` below, exactly like a status/dueDate edit.
        // No separate, unaudited toggle exists. CASE-guarded per field so a patch touching ONLY
        // one of {owner, dependencyEnforcement} never clobbers the other back to null/default.
        await c.query(
          `INSERT INTO pm_project_meta (tenant_id, project_id, owner, dependency_enforcement, origin_site)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, project_id) DO UPDATE SET
             owner = CASE WHEN $6 THEN $3 ELSE pm_project_meta.owner END,
             dependency_enforcement = CASE WHEN $7 THEN $4 ELSE pm_project_meta.dependency_enforcement END,
             updated_at = now()`,
          [tenantId, projectId, owner ? JSON.stringify(owner) : null, enforcement, config.originSite, hasOwnerField, hasEnforcementField],
        );
      }
      // TR-31: actorId is a structured link hint (work-activity-linker.ts rule a, hint:actorId)
      // AND the source of the outbox consumer's actor_user_id — see that file's header.
      await emitEvent(c, tenantId, "pm_project", projectId, "pm.project.updated", { status: b?.status ?? null, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project", projectId);
    return { ok: true };
  }

  @Get(":tenantId/pm/projects/:projectId/tasks")
  async projectTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, projectId }, "read");
    return withTenants([tenantId], (c) =>
      c.query<TaskRow>(`${TASK_SELECT} AND t.project_id = $1 ORDER BY t.created_at`, [projectId]).then((r) => r.rows),
    );
  }

  // ---------------- Tasks ----------------
  @Get(":tenantId/pm/tasks")
  async listTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("assignee") assignee?: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "read");
    const mine = assignee === "me";
    return withTenants([tenantId], (c) =>
      c
        .query<TaskRow>(
          `${TASK_SELECT} ${mine ? `AND (t.assignee->>'responsibleId' = $1 OR (t.assignee->>'kind' = 'person' AND t.assignee->>'refId' = $1))` : ""}
           ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 500`,
          mine ? [req.principal.userId] : [],
        )
        .then((r) => r.rows),
    );
  }

  @Get(":tenantId/pm/tasks/:taskId")
  async getTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    const { task, blockedBy } = await withTenants([tenantId], async (c) => {
      const t = await fetchTask(c, taskId);
      if (!t) return { task: undefined, blockedBy: [] as { id: string; title: string }[] };
      // P4-I decision 17 — "name the blocker": computed live off `openDependencies()` on every
      // read, never a stored string (a stored list would drift the moment a blocker closes and
      // nobody re-read this task). Only on the single-task GET, not the list endpoints — the
      // per-row per-project status lookup inside `openDependencies` is cheap for one task, not for
      // a 500-row list.
      const open = await openDependencies(c, t.dependsOn);
      return { task: t, blockedBy: open.map((d) => ({ id: d.id, title: d.title })) };
    });
    if (!task) throw new NotFoundException("task not found");
    return { ...task, blockedBy };
  }

  // P4-B4 — the full ball/assignment-history chain for one task (migration 0087). Read-gated
  // IDENTICALLY to the task itself (same authorize() call as getTask above, same "read" action) —
  // this is a view of the task's own history, not a separate resource with its own permission
  // surface. RLS (pm_task_assignment_events' plain tenant_isolation policy) is the second wall: a
  // forged cross-tenant taskId 404s (the task lookup below finds nothing under this tenant's RLS
  // scope) exactly like every other cross-tenant probe in this file, never a 200 with someone
  // else's history. Newest first (created_at DESC), matching the ledger's own index order.
  @Get(":tenantId/pm/tasks/:taskId/assignment-history")
  async getAssignmentHistory(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], async (c) => {
      const task = await c.query(`SELECT 1 FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
      if (!task.rows[0]) throw new NotFoundException("task not found");
      const r = await c.query<{
        id: string; refId: string | null; refKind: string | null; refName: string | null;
        responsibleId: string | null; responsibleName: string | null;
        statusId: string; note: string | null; changedBy: string | null; changedByName: string | null;
        createdAt: string;
      }>(
        `SELECT e.id, e.ref_id AS "refId", e.ref_kind AS "refKind", ru.name AS "refName",
                e.responsible_id AS "responsibleId", rp.name AS "responsibleName",
                e.status_id AS "statusId", e.note, e.changed_by AS "changedBy", cb.name AS "changedByName",
                e.created_at AS "createdAt"
         FROM pm_task_assignment_events e
         LEFT JOIN users ru ON e.ref_kind = 'person' AND ru.id::text = e.ref_id
         LEFT JOIN users rp ON rp.id = e.responsible_id
         LEFT JOIN users cb ON cb.id = e.changed_by
         WHERE e.tenant_id = $1 AND e.task_id = $2
         ORDER BY e.created_at DESC`,
        [tenantId, taskId],
      );
      return r.rows;
    });
  }

  @Post(":tenantId/pm/tasks")
  @HttpCode(201)
  async createTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { projectId?: string; title?: string; status?: string; priority?: string; dueDate?: string; startDate?: string; milestoneId?: string; description?: string; estimateMinutes?: number; assignee?: unknown; customFields?: Record<string, unknown>; recurrence?: unknown; subtasks?: unknown; tags?: unknown },
  ) {
    // MI-03: input validation, then authz, then the DB work — the SAME three steps in the SAME
    // order as before, now expressed through the two exported service functions above so that the
    // webdev triage endpoint (core) creates tasks through this exact code instead of its own INSERT.
    const n = normalizePmTaskInput(b ?? {});
    const { title, assignee } = n;
    await authorize(req.principal, { kind: "pm_task", tenantId, projectId: n.projectId }, "create");
    const { id } = await withTenants([tenantId], (c) => createPmTaskInTx(c, tenantId, req.principal.userId, n));
    if (assignee?.responsibleId) {
      await notify(tenantId, assignee.responsibleId, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: id, href: `/tasks/${id}`,
      });
    }
    await writeActivity(tenantId, req.principal.userId, "created", "pm_task", id, { title });
    return { id };
  }

  @Patch(":tenantId/pm/tasks/:taskId")
  @HttpCode(200)
  async patchTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("taskId") taskId: string,
    @Body() b: Record<string, unknown>,
  ) {
    // Changing the assignee is the privileged operation; execution edits are member-level.
    const managing = Object.prototype.hasOwnProperty.call(b ?? {}, "assignee");
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, managing ? "manage" : "update");

    // Both reassigned inside the transaction closure and returned at the end,
    // rather than mutating outer `let`s — read via the awaited return value
    // instead (TS's closure-narrowing can't soundly track outer mutations).
    let notifyResponsible: string | null = null;
    const { spawned, statusChanged, newStatusLabel, taskTitle, clearedDependents } = await withTenants([tenantId], async (c) => {
      let spawnedResult: { id: string; dueDate: string } | null = null;
      // Row-lock FIRST (before reading the "old" status the done-transition/spawn
      // guard depends on): a second concurrent PATCH completing the same task blocks
      // here until this transaction commits, then observes the row ALREADY done —
      // so its own not-done→done edge never fires and it can never double-spawn.
      const lock = await c.query(`SELECT 1 FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [taskId]);
      if (!lock.rows[0]) throw new NotFoundException("task not found");
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");

      // Mutable working copy of the fields the coupling rules touch.
      let subtasks = Array.isArray(task.subtasks) ? [...(task.subtasks as { id: string; title: string; done: boolean }[])] : [];
      let subtasksChanged = false;
      let progress = task.progress;
      let status = task.status;
      let dependsOn = [...(task.dependsOn ?? [])];
      let tags = [...(task.tags ?? [])];

      // ---- subtasks ----
      if (typeof b.addSubtask === "string" && b.addSubtask.trim()) {
        subtasks.push({ id: newId(), title: b.addSubtask.trim().slice(0, 200), done: false });
        subtasksChanged = true;
      }
      if (typeof b.toggleSubtask === "string") {
        subtasks = subtasks.map((s) => (s.id === b.toggleSubtask ? { ...s, done: !s.done } : s));
        subtasksChanged = true;
      }
      if (typeof b.removeSubtask === "string") {
        subtasks = subtasks.filter((s) => s.id !== b.removeSubtask);
        subtasksChanged = true;
      }

      // ---- dependencies ----
      if (typeof b.addDependency === "string") {
        if (!UUID_RE.test(b.addDependency) || b.addDependency === taskId) throw new BadRequestException("invalid dependency");
        const dep = await c.query(`SELECT 1 FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [b.addDependency]);
        if (!dep.rows[0]) throw new BadRequestException("dependency task not found");
        if (!dependsOn.includes(b.addDependency)) dependsOn.push(b.addDependency);
      }
      if (typeof b.removeDependency === "string") dependsOn = dependsOn.filter((d) => d !== b.removeDependency);

      // ---- dependency-chain enforcement inputs (P4-I1/I2/I3) — computed off the FINAL
      // dependsOn list above (any add/removeDependency already applied), so a patch that edits
      // the graph AND asks for a status change in the same call is judged against the graph it
      // is about to leave the task with, not the stale pre-patch one.
      const openDeps = await openDependencies(c, dependsOn);
      const enforcementOn = await dependencyEnforcementEnabled(c, task.projectId);

      // ---- contributors (TR-02, §3.1): zero or more PERSONS, never outcome-credited. Same
      // op-style as addSubtask/addDependency. Writes pm_task_assignees directly (contributors
      // have no blob representation — they are a NEW capability, not read-through from the blob).
      if (typeof b.addContributor === "string") {
        const uid = b.addContributor;
        if (!UUID_RE.test(uid)) throw new BadRequestException("addContributor must be a user id");
        const member = await c.query(
          `SELECT 1 FROM company_memberships WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`,
          [uid],
        );
        if (!member.rows[0]) throw new BadRequestException("addContributor must be an active member of this tenant");
        await c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, created_by, origin_site)
           VALUES ($1, $2, 'contributor', 'person', $3::uuid::text, $3::uuid, $4, $5)
           ON CONFLICT ON CONSTRAINT ux_pm_task_assignees_row DO NOTHING`,
          [tenantId, taskId, uid, req.principal.userId, config.originSite],
        );
      }
      if (typeof b.removeContributor === "string") {
        if (!UUID_RE.test(b.removeContributor)) throw new BadRequestException("removeContributor must be a user id");
        await c.query(
          `DELETE FROM pm_task_assignees WHERE tenant_id = $1 AND task_id = $2 AND role = 'contributor' AND user_id = $3`,
          [tenantId, taskId, b.removeContributor],
        );
      }

      // ---- tags (P2-01): every id must belong to THIS TASK'S PROJECT'S tag registry ----
      if (Array.isArray(b.tags)) {
        const incoming = b.tags as unknown[];
        if (!incoming.every((tg) => typeof tg === "string" && UUID_RE.test(tg))) {
          throw new BadRequestException("tags must be an array of tag ids");
        }
        const uniq = Array.from(new Set(incoming as string[]));
        if (uniq.length > 0) {
          const valid = await c.query<{ id: string }>(
            `SELECT id FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
            [task.projectId, uniq],
          );
          if (valid.rows.length !== uniq.length) {
            throw new BadRequestException("one or more tag ids are not in this task's project tag registry");
          }
        }
        tags = uniq;
      }

      // ---- custom fields (P2-03, D17 framework reuse) ----
      let customFields = task.customFields ?? {};
      if (b.customFields !== undefined) {
        if (typeof b.customFields !== "object" || b.customFields === null || Array.isArray(b.customFields)) {
          throw new BadRequestException("customFields must be an object");
        }
        const cfError = await validateCustomFields(c, tenantId, "pm_task", b.customFields as Record<string, unknown>);
        if (cfError) throw new BadRequestException(cfError);
        customFields = b.customFields as Record<string, unknown>;
      }

      // ---- recurrence (P2-06, design spec §8) ----
      let recurrence = task.recurrence;
      const hasRecurrenceField = Object.prototype.hasOwnProperty.call(b, "recurrence");
      if (hasRecurrenceField) recurrence = validRecurrence(b.recurrence);

      // ---- progress / status (explicit + FLAG-DRIVEN coupling) ----
      // Status is validated against the project's effective set; done coupling derives from the
      // is_done FLAG, never from string-matching the id (a renamed done status still couples).
      const statuses = await effectiveStatuses(c, task.projectId);
      const byStatusId = new Map(statuses.map((s) => [s.id, s]));
      const doneStatus = [...statuses].sort((a, z) => a.position - z.position).find((s) => s.isDone);

      // P4-I2/decision 17 — SELF-triggered clearing half: this same patch may have just removed
      // the LAST open blocker via `removeDependency` above. Promote right here as the DEFAULT
      // status (an explicit `b.status` below still wins) — the cross-task half, where some OTHER
      // task's completion clears THIS one, is `promoteClearedDependents` further down.
      let blockReason = task.blockReason;
      if (openDeps.length === 0) {
        const cleared = clearedStatusIfReady(statuses, status, blockReason);
        if (cleared) { status = cleared.status; blockReason = null; }
      }

      if (typeof b.progress === "number") progress = Math.max(0, Math.min(100, Math.round(b.progress)));
      else if (subtasksChanged && subtasks.length > 0) progress = Math.round((subtasks.filter((s) => s.done).length / subtasks.length) * 100);
      if (typeof b.status === "string") {
        if (!byStatusId.has(b.status)) throw new BadRequestException("invalid status");
        status = b.status;
        // decision 17 — an EXPLICIT transition re-derives the attribution from scratch (never
        // carries a stale reason forward across an unrelated status hop):
        //  - moving OFF Blocked entirely: no reason applies any more.
        //  - moving INTO Blocked WITH open deps: SYSTEM attribution — block_reason is FORCED
        //    NULL regardless of what the body sent; "which blocker" is served live off
        //    `openDependencies()` (GET's `blockedBy`), never a stored string, so it can't go
        //    stale.
        //  - moving INTO Blocked with NO open deps: an OPTIONAL human reason (e.g. "waiting on
        //    the client") is stored verbatim when supplied. Deliberately NOT required — an
        //    `isBlocked`-flagged status is also plain product vocabulary for "blocked" outside
        //    this ticket's dependency-chain feature (a review gate, a WIP-limit column, etc.),
        //    and retrofitting a mandatory-reason gate onto every such status would 400 on
        //    perfectly ordinary board moves that have nothing to do with `dependsOn`. A present
        //    reason is an unambiguous HUMAN signal either way; its absence here is simply "no
        //    reason was given", not proof of anything either way — same honesty as leaving a
        //    field blank anywhere else in this file.
        const targetRow = byStatusId.get(status);
        if (!targetRow?.isBlocked) {
          blockReason = null;
        } else if (openDeps.length > 0) {
          blockReason = null;
        } else {
          const reason = typeof b.blockReason === "string" ? b.blockReason.trim() : "";
          blockReason = reason ? reason.slice(0, 500) : null;
        }
      }
      if (byStatusId.get(status)?.isDone) progress = 100;
      else if (progress >= 100 && doneStatus) status = doneStatus.id;

      // P4-I1 — the hard gate (throws 409 on a real violation; see enforceStartGate's header for
      // the exact rule, coordinated with platform-ui's `reachableStatusIds`). P4-I3/decision 14 —
      // a project may explicitly turn enforcement OFF (`dependencyEnforcementEnabled`), in which
      // case this is skipped and behaviour is fully advisory, exactly as it was before this ticket.
      if (enforcementOn) enforceStartGate({ status, priorStatus: task.status, statuses, openDeps });
      // decision 14 — rule 2 ALLOWS closing a blocked task despite open dependencies; that's not a
      // silent success, it's an audited override. Carried through to the emitted event/activity
      // below rather than a separate write path.
      const completedWithOpenDependencies = openDeps.length > 0 && !!byStatusId.get(status)?.isDone && !(byStatusId.get(task.status)?.isDone ?? false);

      // P2-06: the recurrence spawn trigger is the not-done→done EDGE, resolved
      // against the project's is_done FLAGS (never a literal id) — computed from
      // the task's status BEFORE this patch (task.status, untouched by the mutable
      // `status` working copy above) vs. its FINAL status after this patch.
      const wasDone = byStatusId.get(task.status)?.isDone ?? false;
      const isDoneNow = byStatusId.get(status)?.isDone ?? false;
      const completingNow = !wasDone && isDoneNow;

      // ---- validated scalar meta ----
      if (b.priority !== undefined && b.priority !== null && !PRIORITIES.has(String(b.priority))) throw new BadRequestException("invalid priority");
      let assignee = task.assignee;
      if (managing) {
        assignee = validAssignee(b.assignee);
        if (assignee?.responsibleId && assignee.responsibleId !== task.assignee?.responsibleId) notifyResponsible = assignee.responsibleId;
      }

      // Final (post-patch) scalar values — reused below when spawning the next
      // recurrence occurrence, so the clone carries whatever THIS patch just set
      // (e.g. completing a task and editing its title in the same call).
      const finalTitle = typeof b.title === "string" ? b.title : task.title;
      const finalDescription = typeof b.description === "string" ? b.description : task.description;
      const finalPriority = typeof b.priority === "string" ? b.priority : task.priority;
      const finalMilestoneId = Object.prototype.hasOwnProperty.call(b, "milestoneId") ? ((b.milestoneId as string) || null) : task.milestoneId;
      const finalEstimateMinutes = Object.prototype.hasOwnProperty.call(b, "estimateMinutes") ? ((b.estimateMinutes as number) ?? null) : task.estimateMinutes;

      await c.query(
        `UPDATE pm_tasks SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           priority = COALESCE($4, priority),
           status = $5,
           progress = $6,
           subtasks = $7,
           depends_on = $8,
           assignee = $9,
           milestone_id = CASE WHEN $10 THEN $11 ELSE milestone_id END,
           start_date = CASE WHEN $12 THEN $13::date ELSE start_date END,
           due_date = CASE WHEN $14 THEN $15::date ELSE due_date END,
           estimate_minutes = CASE WHEN $16 THEN $17 ELSE estimate_minutes END,
           tags = $18,
           custom_fields = $19,
           recurrence = CASE WHEN $20 THEN $21 ELSE recurrence END,
           block_reason = $22,
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [
          taskId,
          typeof b.title === "string" ? b.title : null,
          typeof b.description === "string" ? b.description : null,
          typeof b.priority === "string" ? b.priority : null,
          status,
          progress,
          JSON.stringify(subtasks),
          dependsOn,
          assignee ? JSON.stringify(assignee) : null,
          Object.prototype.hasOwnProperty.call(b, "milestoneId"), (b.milestoneId as string) || null,
          Object.prototype.hasOwnProperty.call(b, "startDate"), (b.startDate as string) || null,
          Object.prototype.hasOwnProperty.call(b, "dueDate"), (b.dueDate as string) || null,
          Object.prototype.hasOwnProperty.call(b, "estimateMinutes"), (b.estimateMinutes as number) ?? null,
          tags,
          JSON.stringify(customFields),
          hasRecurrenceField, recurrence ? JSON.stringify(recurrence) : null,
          blockReason,
        ],
      );
      // TR-02 dual-write: only when THIS patch actually touched the assignee (managing) — the
      // same transaction as the UPDATE above, so a malformed/unknown ref rolls back the whole
      // PATCH, blob included, never a partial write.
      // P4-B3: statusId is this patch's FINAL status (post-coupling above) — "the status at the
      // moment of handoff" per plan §1.5. `assignmentNote` is an optional free-text reason a human
      // can attach to a reassignment/correction (e.g. "wrong queue"); undefined for every other
      // write path, which is exactly right — only a human-initiated PATCH has a reason to give.
      if (managing) {
        const assignmentNote = typeof b.assignmentNote === "string" ? b.assignmentNote.slice(0, 500) : null;
        await syncTaskAssignees(c, tenantId, taskId, assignee, req.principal.userId, status, assignmentNote);
        await logAssigneeDriftIfAny(c, tenantId, taskId);
      }
      // TR-05: carry the FLAG-DRIVEN completion facts (wasDone/isDoneNow, already computed above
      // via effectiveStatuses()'s is_done FLAG — never a literal status id) so the work-activity
      // outbox consumer can classify completed/reopened/status_changed without re-deriving
      // is_done-ness itself (there must be exactly one place that decides is_done-ness).
      // TR-31: actorId propagates the patching user into work_activity.actor_user_id + mints an
      // EXACT person link (work-activity-linker.ts rule a).
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.task.updated", {
        status, statusChanged: status !== task.status, wasDone, isDoneNow, actorId: req.principal.userId,
        // decision 14 — an audited record of rule 2's override (closing a blocked task): absent
        // (not merely `false`) on every ordinary write, so it never adds noise to ordinary
        // event/activity payloads.
        ...(completedWithOpenDependencies ? { completedWithOpenDependencies: true, openBlockerIds: openDeps.map((d) => d.id) } : {}),
      });

      // ---- P4-I2/decision 17, CROSS-task clearing half: this task just closed (completingNow)
      // -> re-check every OTHER task that named it as a blocker; the self-triggered half (THIS
      // task's own deps clearing via removeDependency) already ran above. Every promotion gets its
      // own event here (inside the same transaction) and a writeActivity audit row after commit —
      // "a write triggered by someone else's action" per the plan, never a silent update.
      const clearedDependents = completingNow ? await promoteClearedDependents(c, taskId) : [];
      for (const dep of clearedDependents) {
        await emitEvent(c, tenantId, "pm_task", dep.id, "pm.task.dependencyCleared", {
          fromStatus: dep.fromStatus, toStatus: dep.toStatus, closedTaskId: taskId, actorExternal: "pm:dependency-engine",
        });
      }

      // ---- recurring-task spawn (P2-06, design spec §8) ----
      // Fires ONLY on the not-done→done edge, so re-PATCHing an already-done task
      // (e.g. re-submitting the same completion) never spawns a second child — the
      // edge is false the second time because `task.status` (read under the row
      // lock above) is already the done status. A defensive second check (no
      // existing non-deleted child already spawned from this parent for the same
      // computed next due date) guards the same invariant independent of the edge,
      // in case this handler is ever called with a stale/replayed old-status read.
      if (completingNow && recurrence) {
        const next = computeNextOccurrence(task.dueDate, task.startDate, recurrence);
        if (next) {
          const existing = await c.query(
            `SELECT id FROM pm_tasks WHERE recurrence_spawned_from = $1 AND due_date = $2::date AND deleted_at IS NULL`,
            [taskId, next.dueDate],
          );
          if (!existing.rows[0]) {
            const childId = newId();
            // P4-B8b: READY, not "first non-done" — a fired occurrence must be actionable, and
            // "first non-done" became Backlog when the ladder gained it.
            const spawnStatus = readyStatus(statuses);
            const resetSubtasks = subtasks.map((s) => ({ ...s, done: false }));
            const childSeq = await allocateTaskSeq(c, task.projectId); // WD-28: a spawned occurrence is a real new task
            await c.query(
              `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, assignee, milestone_id, start_date, due_date, estimate_minutes, subtasks, tags, custom_fields, recurrence, recurrence_spawned_from, seq, origin_site)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [
                childId, tenantId, task.projectId, finalTitle, finalDescription,
                spawnStatus, finalPriority,
                assignee ? JSON.stringify(assignee) : null, finalMilestoneId,
                next.startDate, next.dueDate, finalEstimateMinutes,
                JSON.stringify(resetSubtasks), tags, JSON.stringify(customFields),
                JSON.stringify(recurrence), taskId, childSeq, config.originSite,
              ],
            );
            // TR-02 dual-write: the spawned child carries the same assignee as its parent's
            // final (post-patch) value — same transaction as the INSERT above.
            // P4-B3: the child's own FIRST assignment event, status = spawnStatus (its own READY
            // status, not the parent's DONE status it was just completed into).
            await syncTaskAssignees(c, tenantId, childId, assignee, req.principal.userId, spawnStatus);
            await logAssigneeDriftIfAny(c, tenantId, childId);
            // TR-31: deliberately NO actorId here — a recurrence auto-spawn is a system-derived
            // side effect of the completing PATCH above (which DOES carry its own actorId), not a
            // distinct action this task's assignee/spawner "did"; actorExternal names the origin
            // instead of misattributing it to whoever happened to complete the parent.
            await emitEvent(c, tenantId, "pm_task", childId, "pm.task.spawned", { parentId: taskId, dueDate: next.dueDate, actorExternal: "pm:recurrence-engine" });
            spawnedResult = { id: childId, dueDate: next.dueDate };
          }
        }
      }
      // P3-08: fan-out inputs for the follower notify below — computed under the same row
      // lock/read as everything else, but the notify() calls themselves happen AFTER commit
      // (below), matching every other notify-after-writeTenants call site in this file.
      return {
        spawned: spawnedResult,
        statusChanged: status !== task.status,
        newStatusLabel: byStatusId.get(status)?.label ?? status,
        taskTitle: finalTitle,
        clearedDependents,
      };
    });
    // P3-08 fan-out dedup: assignee (this patch's reassignment) and followers (on a real
    // status change) are collected into ONE "already notified" set so a follower who is ALSO
    // the newly-reassigned responsible in this same PATCH gets exactly one notification, never
    // two. notify() itself auto-skips the actor (recipientId === actorId, verified in core/http.ts)
    // so there is no separate actor-skip needed here.
    const alreadyNotified = new Set<string>();
    if (notifyResponsible) {
      alreadyNotified.add(notifyResponsible);
      await notify(tenantId, notifyResponsible, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
      });
    }
    if (statusChanged) {
      const followers = await withTenants([tenantId], (c) =>
        c.query<{ user_id: string }>(`SELECT user_id FROM pm_task_followers WHERE task_id = $1`, [taskId]),
      );
      for (const { user_id: followerId } of followers.rows) {
        if (alreadyNotified.has(followerId)) continue;
        alreadyNotified.add(followerId);
        await notify(tenantId, followerId, req.principal.userId, "task_update", {
          title: `“${taskTitle}” moved to “${newStatusLabel}”`, severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
        });
      }
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_task", taskId, {});
    if (spawned) await writeActivity(tenantId, req.principal.userId, "created", "pm_task", spawned.id, { recurrenceParentId: taskId });
    // P4-I2/decision 17 audit trail — actorId NULL (system-derived, same convention as the
    // recurrence-spawn audit above): the promoted task's own owner didn't act, `taskId`'s
    // completion did.
    for (const dep of clearedDependents) {
      await writeActivity(tenantId, null, "auto_promoted", "pm_task", dep.id, {
        fromStatus: dep.fromStatus, toStatus: dep.toStatus, closedTaskId: taskId, closedByUserId: req.principal.userId,
      });
    }
    return { ok: true, spawned };
  }

  @Delete(":tenantId/pm/tasks/:taskId")
  @HttpCode(200)
  async deleteTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "delete");
    const clearedDependents = await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
      if (res.rowCount === 0) throw new NotFoundException("task not found");
      // P4-I2/decision 17 — a deleted blocker counts as "closed" for every task that named it:
      // MUST run BEFORE the array_remove cleanup below, not after — `openDependencies()` already
      // excludes `deleted_at IS NOT NULL` rows, so as long as dependents' `depends_on` arrays
      // still literally contain `taskId` at the moment this runs, the just-soft-deleted row
      // naturally reads as "no longer open" with zero special-casing. Running it AFTER the
      // array_remove would strip `taskId` from those arrays first, and this query's own
      // `$1 = ANY(depends_on)` lookup would then find no dependents to check at all.
      const cleared = await promoteClearedDependents(c, taskId);
      // Drop this task from any other task's dependency list.
      await c.query(`UPDATE pm_tasks SET depends_on = array_remove(depends_on, $1) WHERE $1 = ANY(depends_on)`, [taskId]);
      for (const dep of cleared) {
        await emitEvent(c, tenantId, "pm_task", dep.id, "pm.task.dependencyCleared", {
          fromStatus: dep.fromStatus, toStatus: dep.toStatus, closedTaskId: taskId, reason: "blocker_deleted", actorExternal: "pm:dependency-engine",
        });
      }
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.task.deleted", { actorId: req.principal.userId });
      return cleared;
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_task", taskId);
    for (const dep of clearedDependents) {
      await writeActivity(tenantId, null, "auto_promoted", "pm_task", dep.id, {
        fromStatus: dep.fromStatus, toStatus: dep.toStatus, closedTaskId: taskId, reason: "blocker_deleted", closedByUserId: req.principal.userId,
      });
    }
    return { ok: true };
  }

  // ---------------- Followers (P3-08) ----------------
  // Following is a SELF-SCOPED preference, never a client-supplied assignment: every write below
  // parameterizes user_id from req.principal.userId ONLY — the request body/params can never name
  // a different user to (un)follow on someone else's behalf. Gated on task READ (not manage/update)
  // because opting into your own notifications isn't a privileged action.
  @Get(":tenantId/pm/tasks/:taskId/followers")
  async listFollowers(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      const rows = await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.name FROM pm_task_followers f JOIN users u ON u.id = f.user_id
         WHERE f.task_id = $1 ORDER BY u.name`,
        [taskId],
      );
      return rows.rows;
    });
  }

  @Post(":tenantId/pm/tasks/:taskId/follow")
  @HttpCode(200)
  async followTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    await withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      await c.query(
        `INSERT INTO pm_task_followers (tenant_id, task_id, user_id, origin_site) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, task_id, user_id) DO NOTHING`,
        [tenantId, taskId, req.principal.userId, config.originSite],
      );
    });
    return { ok: true };
  }

  @Delete(":tenantId/pm/tasks/:taskId/follow")
  @HttpCode(200)
  async unfollowTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    await withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      await c.query(
        `DELETE FROM pm_task_followers WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3`,
        [tenantId, taskId, req.principal.userId],
      );
    });
    return { ok: true };
  }

  // ---------------- Duplicate (P3-01) ----------------
  @Post(":tenantId/pm/tasks/:taskId/duplicate")
  @HttpCode(201)
  async duplicateTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    // Gated like createTask (this IS a task creation) — the source projectId is read from the
    // DB below, never trusted from a client-supplied param, so there is nothing to authorize
    // against here beyond the source task's own tenant/id.
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "create");
    const id = newId();
    const source = await withTenants([tenantId], async (c) => {
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");
      // P4-B8b: a duplicate is uncommitted work, so it resets to the INTAKE status (Backlog when
      // the project has one) — deliberately NOT the `readyStatus` a fired recurrence gets, and never
      // the literal "todo" (the registry may not have that id at all).
      const statuses = [...(await effectiveStatuses(c, task.projectId))].sort((a, z) => a.position - z.position);
      const dupStatus = intakeStatus(statuses);
      const resetSubtasks = (Array.isArray(task.subtasks) ? (task.subtasks as { title: string }[]) : [])
        .map((s) => ({ id: newId(), title: s.title, done: false }));
      const seq = await allocateTaskSeq(c, task.projectId); // WD-28: a duplicate is a new task, gets its own seq (never copies the source's)
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, seq, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13, $14, $15, $16, $17, $18, $19)`,
        [
          id, tenantId, task.projectId, `${task.title} (copy)`, task.description,
          dupStatus, task.priority, 0,
          task.assignee ? JSON.stringify(task.assignee) : null, task.milestoneId,
          task.startDate, task.dueDate, task.estimateMinutes,
          JSON.stringify(task.customFields ?? {}), task.recurrence ? JSON.stringify(task.recurrence) : null,
          JSON.stringify(resetSubtasks), task.tags ?? [], seq, config.originSite,
        ],
      );
      // TR-02 dual-write: the copy carries the SOURCE task's owner/responsible (matching the
      // blob copy above). Contributors are deliberately NOT copied — same "comments/time/
      // suggestions dropped" policy as everything else this duplicate doesn't carry.
      // P4-B3: the copy's own FIRST assignment event, status = dupStatus (its own INTAKE status,
      // never the source task's status — a duplicate is uncommitted work, per P4-B8b above).
      await syncTaskAssignees(c, tenantId, id, task.assignee, req.principal.userId, dupStatus);
      await logAssigneeDriftIfAny(c, tenantId, id);
      // Comments/time/suggestions/dependsOn are deliberately dropped: not copied, not referenced
      // (depends_on defaults to '{}' — the INSERT above never sets it).
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pm_task", id, "pm.task.duplicated", { sourceTaskId: taskId, projectId: task.projectId, actorId: req.principal.userId });
      return task;
    });
    if (source.assignee?.responsibleId) {
      await notify(tenantId, source.assignee.responsibleId, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: id, href: `/tasks/${id}`,
      });
    }
    await writeActivity(tenantId, req.principal.userId, "created", "pm_task", id, { duplicatedFrom: taskId });
    return { id };
  }

  // ---------------- Duplicate project (P3-02) ----------------
  // Clones a project + its per-project structure (statuses, tags, milestones, docs) and EVERY task
  // into a brand-new project in ONE tenant-scoped transaction. Correctness hinges on THREE id-remap
  // maps built while copying — tag old→new, milestone old→new, task old→new — so that NO source-project
  // id ever survives into the copy: each task's tags are rewritten through the tag map, its milestone_id
  // through the milestone map, and (in a SECOND pass, once every new task id is known) its depends_on
  // through the task map with any id that didn't copy DROPPED. Owner/pm_project_meta, task assignees,
  // comments, time logs and tracker suggestions are deliberately NOT carried. TR-02: since every
  // cloned task's `assignee` blob is NULL (below), no pm_task_assignees rows are written for them
  // either — there is nothing for syncTaskAssignees to do, so it is deliberately not called here.
  @Post(":tenantId/pm/projects/:projectId/duplicate")
  @HttpCode(201)
  async duplicateProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { name?: string },
  ) {
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const newProjectId = newId();
    await withTenants([tenantId], async (c) => {
      // Source project. RLS scopes to this tenant, so a foreign/forged id reads as absent → 404,
      // never a cross-tenant read or write (the cross-tenant probe relies on exactly this).
      const src = await c.query<{ clientId: string | null; isInternal: boolean; departmentId: string | null; customFields: Record<string, unknown> }>(
        `SELECT client_id AS "clientId", is_internal AS "isInternal", department_id AS "departmentId", custom_fields AS "customFields"
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!src.rows[0]) throw new NotFoundException("project not found");
      const s = src.rows[0];

      // 1) Base project row: name from input, status reset to 'active', NO due date, owner NOT copied.
      //    Structural identity (client, internal flag, department, D17 custom-field values) is kept —
      //    none of those are source-PROJECT ids, so carrying them leaks nothing. (`projects` has no
      //    description column in this schema; department_id is the only descriptive field to carry.)
      //    WD-28: the clone is a brand-new project — gets its OWN derived short_code (never the
      //    source's), and its task_seq counter starts at 0 (the DEFAULT), so cloned tasks (pass 6
      //    below) get fresh seq numbers 1..N rather than inheriting the source's.
      const shortCode = await deriveUniqueShortCode(c, tenantId, name);
      await c.query(
        `INSERT INTO projects (id, tenant_id, client_id, is_internal, name, status, department_id, custom_fields, short_code, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)`,
        [newProjectId, tenantId, s.clientId, s.isInternal, name, s.departmentId, JSON.stringify(s.customFields ?? {}), shortCode, config.originSite],
      );

      // 2) Statuses — copied VERBATIM (same slug ids; per-project scoped, so reuse is safe). Only
      //    MATERIALIZED rows exist to copy; an unmaterialized (default) project copies ZERO rows and
      //    the clone reads the same 4 synthesized defaults, so boards render identically either way.
      await c.query(
        `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
         SELECT id, tenant_id, $2, position, label, color, is_done, is_blocked, wip_limit, $3
         FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId, newProjectId, config.originSite],
      );

      // 3) Tags — NEW uuids; build old-id→new-id (and label→new-id) maps for task-tag remapping.
      const tagMap = new Map<string, string>();
      const tagLabelMap = new Map<string, string>();
      const srcTags = await c.query<TagRow>(
        `SELECT id, label, color FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
        [projectId],
      );
      for (const t of srcTags.rows) {
        const nid = newId();
        tagMap.set(t.id, nid);
        tagLabelMap.set(t.label, nid);
        await c.query(
          `INSERT INTO pm_project_tags (id, tenant_id, project_id, label, color, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
          [nid, tenantId, newProjectId, t.label, t.color, config.originSite],
        );
      }

      // 4) Milestones — NEW ids (map old→new); status reset to 'open', dates preserved.
      const msMap = new Map<string, string>();
      const srcMs = await c.query<{ id: string; name: string; dueDate: string | null }>(
        `SELECT id, name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate" FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      for (const m of srcMs.rows) {
        const nid = newId();
        msMap.set(m.id, nid);
        await c.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site) VALUES ($1, $2, $3, $4, $5::date, 'open', $6)`,
          [nid, tenantId, newProjectId, m.name, m.dueDate, config.originSite],
        );
      }

      // 5) Docs — author is the duplicating user (this is a fresh copy authored now). Set-based
      //    insert with server-generated uuids; no source id survives.
      await c.query(
        `INSERT INTO pm_docs (id, tenant_id, project_id, title, body, author_id, origin_site)
         SELECT gen_random_uuid(), tenant_id, $2, title, body, $3, $4
         FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId, newProjectId, req.principal.userId, config.originSite],
      );

      // 6) Tasks — pass 1: copy each task, building the old→new task-id map. Per P3-01 copy semantics
      //    EXCEPT: assignee/owner CLEARED, status reset to the clone's first-by-position NON-done
      //    status (via effectiveStatuses' isDone FLAG, never a literal id), progress 0, subtasks reset
      //    (fresh ids, done=false), tags remapped through the tag map, milestone_id through the
      //    milestone map. depends_on is left empty here and rewritten in pass 2. Comments/time/
      //    suggestions are not copied; recurrence_spawned_from is NOT carried (it would be a
      //    source-project task id). Task titles are kept VERBATIM — the PROJECT is the "(copy)", so
      //    suffixing every task title (as the single-task P3-01 duplicate does) would be wrong here.
      // P4-B8b: same INTAKE intent as the single-task duplicate — a cloned project's tasks are
      // uncommitted work, so Backlog when the target project has one.
      const statuses = [...(await effectiveStatuses(c, newProjectId))].sort((a, z) => a.position - z.position);
      const cloneStatus = intakeStatus(statuses);
      const taskMap = new Map<string, string>();
      const srcTasks = await c.query<TaskRow>(`${TASK_SELECT} AND t.project_id = $1 ORDER BY t.created_at`, [projectId]);
      for (const t of srcTasks.rows) {
        const nid = newId();
        taskMap.set(t.id, nid);
        const resetSubtasks = (Array.isArray(t.subtasks) ? (t.subtasks as { title: string }[]) : [])
          .map((sub) => ({ id: newId(), title: sub.title, done: false }));
        const remappedTags = (t.tags ?? []).map((tg) => tagMap.get(tg)).filter((x): x is string => !!x);
        const remappedMilestone = t.milestoneId ? (msMap.get(t.milestoneId) ?? null) : null;
        // WD-28: each cloned task gets a FRESH seq off the clone's own counter (started at 0
        // above) — never the source task's seq, which belongs to the source project's sequence.
        const seq = await allocateTaskSeq(c, newProjectId);
        await c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, seq, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16, $17)`,
          [
            nid, tenantId, newProjectId, t.title, t.description,
            cloneStatus, t.priority, remappedMilestone,
            t.startDate, t.dueDate, t.estimateMinutes,
            JSON.stringify(t.customFields ?? {}), t.recurrence ? JSON.stringify(t.recurrence) : null,
            JSON.stringify(resetSubtasks), remappedTags, seq, config.originSite,
          ],
        );
      }

      // 7) Pass 2 — rewrite depends_on now that every new task id is known: map each source dep id
      //    through the task map, DROPPING any that didn't copy (a dep on a task outside this project,
      //    or a soft-deleted one). Guarantees no source-project task id survives in the copy.
      for (const t of srcTasks.rows) {
        const remappedDeps = (t.dependsOn ?? []).map((d) => taskMap.get(d)).filter((x): x is string => !!x);
        if (remappedDeps.length > 0) {
          await c.query(`UPDATE pm_tasks SET depends_on = $2 WHERE id = $1`, [taskMap.get(t.id), remappedDeps]);
        }
      }

      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pm_project", newProjectId, "pm.project.duplicated", { sourceProjectId: projectId, name, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project", newProjectId, { duplicatedFrom: projectId, name });
    return { id: newProjectId };
  }

  // ---------------- Time logs (reuse time_entries via pm_task_id) ----------------
  @Get(":tenantId/pm/tasks/:taskId/time")
  async listTime(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT te.id, te.pm_task_id AS "taskId", te.user_id AS "userId", u.name AS "userName", te.minutes,
                  to_char(te.entry_date, 'YYYY-MM-DD') AS "spentOn", te.billable, te.notes AS note
           FROM time_entries te LEFT JOIN users u ON u.id = te.user_id
           WHERE te.pm_task_id = $1 AND te.deleted_at IS NULL ORDER BY te.entry_date DESC, te.created_at DESC`,
          [taskId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/tasks/:taskId/time")
  @HttpCode(201)
  async logTime(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("taskId") taskId: string,
    @Body() b: { minutes?: number; spentOn?: string; billable?: boolean; note?: string },
  ) {
    if (typeof b?.minutes !== "number" || !Number.isInteger(b.minutes) || b.minutes <= 0) throw new BadRequestException("minutes must be a positive integer");
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "update");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const task = await c.query<{ project_id: string }>(`SELECT project_id FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
      if (!task.rows[0]) throw new NotFoundException("task not found");
      await c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, pm_task_id, minutes, billable, entry_date, notes, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, current_date), $9, $10)`,
        [id, tenantId, req.principal.userId, task.rows[0].project_id, taskId, b.minutes, b.billable ?? false, b.spentOn || null, b.note ?? "", config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "logged", "pm_task", taskId, { minutes: b.minutes });
    return { id };
  }

  // ---------------- Tags (P2-01) ----------------
  @Get(":tenantId/pm/projects/:projectId/tags")
  async listTags(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query<TagRow>(
          `SELECT id, label, color FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/tags")
  @HttpCode(201)
  async createTag(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { label?: string; color?: string },
  ) {
    const label = b?.label?.trim();
    if (!label) throw new BadRequestException("label required");
    if (!b?.color || !TAG_COLORS.has(b.color)) throw new BadRequestException("invalid color");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_project_tags (id, tenant_id, project_id, label, color, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, projectId, label, b.color, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_project_tag", id, "pm.tag.created", { projectId, label, color: b.color });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project_tag", id, { label });
    return { id, label, color: b.color };
  }

  @Patch(":tenantId/pm/projects/:projectId/tags/:tagId")
  @HttpCode(200)
  async patchTag(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("tagId") tagId: string,
    @Body() b: { label?: string; color?: string },
  ) {
    if (b?.color !== undefined && !TAG_COLORS.has(b.color)) throw new BadRequestException("invalid color");
    if (b?.label !== undefined && !b.label.trim()) throw new BadRequestException("label cannot be empty");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<TagRow>(
        `UPDATE pm_project_tags SET label = COALESCE($3, label), color = COALESCE($4, color), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL RETURNING id, label, color`,
        [tagId, projectId, b?.label?.trim() || null, b?.color ?? null],
      );
      if (!res.rows[0]) throw new NotFoundException("tag not found");
      await emitEvent(c, tenantId, "pm_project_tag", tagId, "pm.tag.updated", { projectId });
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project_tag", tagId);
    return updated;
  }

  @Delete(":tenantId/pm/projects/:projectId/tags/:tagId")
  async deleteTag(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("tagId") tagId: string,
    @Query("force") force?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const result = await withTenants([tenantId], async (c) => {
      const tag = await fetchProjectTag(c, projectId, tagId);
      if (!tag) throw new NotFoundException("tag not found");
      const usage = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL AND $2 = ANY(tags)`,
        [projectId, tagId],
      );
      const inUse = Number(usage.rows[0].n);
      if (inUse > 0 && force !== "1") return { blocked: true as const, inUse };
      if (inUse > 0) {
        await c.query(
          `UPDATE pm_tasks SET tags = array_remove(tags, $1), updated_at = now()
           WHERE project_id = $2 AND deleted_at IS NULL AND $1 = ANY(tags)`,
          [tagId, projectId],
        );
      }
      await c.query(`UPDATE pm_project_tags SET deleted_at = now() WHERE id = $1`, [tagId]);
      await emitEvent(c, tenantId, "pm_project_tag", tagId, "pm.tag.deleted", { projectId, strippedFrom: inUse });
      return { blocked: false as const, inUse };
    });
    if (result.blocked) {
      reply.status(409).send({ inUse: result.inUse });
      return;
    }
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_project_tag", tagId, { strippedFrom: result.inUse });
    reply.status(200).send({ ok: true });
  }

  // ---------------- Statuses (P2-04, pm-console-ux-design-spec §7) ----------------
  @Get(":tenantId/pm/projects/:projectId/statuses")
  async listStatuses(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      return (await effectiveStatuses(c, projectId)).map(toProjectStatus);
    });
  }

  @Post(":tenantId/pm/projects/:projectId/statuses")
  @HttpCode(201)
  async createStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null },
  ) {
    const label = b?.label?.trim();
    if (!label) throw new BadRequestException("label required");
    const color = typeof b?.color === "string" ? b.color.trim() : "";
    if (!color) throw new BadRequestException("color required");
    const isDone = !!b?.isDone;
    const isBlocked = !!b?.isBlocked;
    const wipLimit = validWipLimit(b?.wipLimit);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const created = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // First editor write for the project materializes the 4 defaults so the synthesized set is kept.
      await ensureMaterialized(c, tenantId, projectId);
      const taken = new Set(
        (await c.query<{ id: string }>(`SELECT id FROM pm_project_statuses WHERE project_id = $1`, [projectId])).rows.map((r) => r.id),
      );
      const id = uniqueStatusId(slugifyStatusId(label), taken);
      const posRow = await c.query<{ max: number | null }>(
        `SELECT MAX(position) AS max FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const position = (posRow.rows[0].max ?? -1) + 1;
      await c.query(
        `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, tenantId, projectId, position, label, color, isDone, isBlocked, wipLimit, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.created", { statusId: id, label });
      return { id, position, label, color, isDone, isBlocked, wipLimit } as StatusRow;
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project_status", projectId, { statusId: created.id, label });
    return toProjectStatus(created);
  }

  @Patch(":tenantId/pm/projects/:projectId/statuses/:sid")
  @HttpCode(200)
  async patchStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("sid") sid: string,
    @Body() b: { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null; position?: number },
  ) {
    const label = b?.label !== undefined ? String(b.label).trim() : null;
    if (b?.label !== undefined && !label) throw new BadRequestException("label cannot be empty");
    const color = b?.color !== undefined ? String(b.color).trim() : null;
    if (b?.color !== undefined && !color) throw new BadRequestException("color cannot be empty");
    const isDone = Object.prototype.hasOwnProperty.call(b ?? {}, "isDone") ? !!b.isDone : null;
    const isBlocked = Object.prototype.hasOwnProperty.call(b ?? {}, "isBlocked") ? !!b.isBlocked : null;
    const hasWip = Object.prototype.hasOwnProperty.call(b ?? {}, "wipLimit");
    const wipLimit = hasWip ? validWipLimit(b.wipLimit) : null;
    const position = typeof b?.position === "number" && Number.isInteger(b.position) && b.position >= 0 ? b.position : null;
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await ensureMaterialized(c, tenantId, projectId);
      const res = await c.query<StatusRow>(
        `UPDATE pm_project_statuses SET
           label = COALESCE($3, label),
           color = COALESCE($4, color),
           is_done = COALESCE($5, is_done),
           is_blocked = COALESCE($6, is_blocked),
           wip_limit = CASE WHEN $7 THEN $8 ELSE wip_limit END,
           position = COALESCE($9, position),
           updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
         RETURNING id, position, label, color, is_done AS "isDone", is_blocked AS "isBlocked", wip_limit AS "wipLimit"`,
        [sid, projectId, label, color, isDone, isBlocked, hasWip, wipLimit, position],
      );
      if (!res.rows[0]) throw new NotFoundException("status not found");
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.updated", { statusId: sid });
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project_status", projectId, { statusId: sid });
    return toProjectStatus(updated);
  }

  @Delete(":tenantId/pm/projects/:projectId/statuses/:sid")
  async deleteStatus(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("sid") sid: string,
    @Query("moveTo") moveTo?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const result = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await ensureMaterialized(c, tenantId, projectId);
      const target = await c.query(`SELECT 1 FROM pm_project_statuses WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [sid, projectId]);
      if (!target.rows[0]) throw new NotFoundException("status not found");
      const usage = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL AND status = $2`,
        [projectId, sid],
      );
      const inUse = Number(usage.rows[0].n);
      if (inUse > 0) {
        if (!moveTo) return { blocked: true as const, inUse };
        if (moveTo === sid) throw new BadRequestException("moveTo must be a different status");
        const dest = await c.query(`SELECT 1 FROM pm_project_statuses WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [moveTo, projectId]);
        if (!dest.rows[0]) throw new BadRequestException("moveTo status not found");
        await c.query(
          `UPDATE pm_tasks SET status = $1, updated_at = now() WHERE project_id = $2 AND deleted_at IS NULL AND status = $3`,
          [moveTo, projectId, sid],
        );
      }
      await c.query(`UPDATE pm_project_statuses SET deleted_at = now() WHERE id = $1 AND project_id = $2`, [sid, projectId]);
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.deleted", { statusId: sid, movedTo: moveTo ?? null, reassigned: inUse });
      return { blocked: false as const, inUse };
    });
    if (result.blocked) {
      reply.status(400).send({ inUse: result.inUse });
      return;
    }
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_project_status", projectId, { statusId: sid, reassigned: result.inUse });
    reply.status(200).send({ ok: true });
  }

  // ---------------- Burndown (P2-07, pm-console-ux-design-spec §4, §0 D-2) ----------------
  @Get(":tenantId/pm/projects/:projectId/burndown")
  async getBurndown(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    if (from !== undefined && !DATE_RE.test(from)) throw new BadRequestException("from must be a YYYY-MM-DD date");
    if (to !== undefined && !DATE_RE.test(to)) throw new BadRequestException("to must be a YYYY-MM-DD date");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // Lazy idempotent upsert-on-read (D-2): every read keeps TODAY's row current, so the
      // series is never stale even if the nightly job hasn't reached this project yet.
      await upsertTodaySnapshot(c, tenantId, projectId);
      const rows = await c.query<{ date: string; open: number; done: number; avgProgress: number }>(
        `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, open_count AS open, done_count AS done,
                avg_progress AS "avgProgress"
         FROM pm_progress_snapshots
         WHERE project_id = $1
           AND ($2::date IS NULL OR snapshot_date >= $2::date)
           AND ($3::date IS NULL OR snapshot_date <= $3::date)
         ORDER BY snapshot_date ASC`,
        [projectId, from || null, to || null],
      );
      // Empty series (no snapshots in range) returns [], never an error.
      return rows.rows;
    });
  }

  // ---------------- Flow (P3-05) ----------------
  // Byte-parallel to getBurndown above: same read-gate, same lazy upsert-on-read, same
  // from/to validation and empty-range behavior — just projects status_counts instead of
  // open/done/avgProgress off the same snapshot row.
  @Get(":tenantId/pm/projects/:projectId/flow")
  async getFlow(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    if (from !== undefined && !DATE_RE.test(from)) throw new BadRequestException("from must be a YYYY-MM-DD date");
    if (to !== undefined && !DATE_RE.test(to)) throw new BadRequestException("to must be a YYYY-MM-DD date");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // Lazy idempotent upsert-on-read (D-2, mirrored from burndown): keeps TODAY's row current.
      await upsertTodaySnapshot(c, tenantId, projectId);
      const rows = await c.query<{ date: string; counts: Record<string, number> }>(
        `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, status_counts AS counts
         FROM pm_progress_snapshots
         WHERE project_id = $1
           AND ($2::date IS NULL OR snapshot_date >= $2::date)
           AND ($3::date IS NULL OR snapshot_date <= $3::date)
         ORDER BY snapshot_date ASC`,
        [projectId, from || null, to || null],
      );
      // Empty series (no snapshots in range) returns [], never an error.
      return rows.rows;
    });
  }

  // ---------------- Milestones ----------------
  @Get(":tenantId/pm/projects/:projectId/milestones")
  async listMilestones(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT id, project_id AS "projectId", name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", status
           FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/milestones")
  @HttpCode(201)
  async createMilestone(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Body() b: { name?: string; dueDate?: string | null }) {
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, origin_site) VALUES ($1, $2, $3, $4, $5::date, $6)`,
        [id, tenantId, projectId, name, b.dueDate || null, config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_milestone", id, { name });
    return { id };
  }

  @Patch(":tenantId/pm/projects/:projectId/milestones/:milestoneId")
  @HttpCode(200)
  async patchMilestone(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("milestoneId") milestoneId: string, @Body() b: { name?: string; dueDate?: string | null; status?: string }) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(
        `UPDATE pm_milestones SET name = COALESCE($3, name),
           due_date = CASE WHEN $4 THEN $5::date ELSE due_date END, status = COALESCE($6, status), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [milestoneId, projectId, b?.name ?? null, Object.prototype.hasOwnProperty.call(b ?? {}, "dueDate"), b?.dueDate || null, b?.status ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException("milestone not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_milestone", milestoneId);
    return { ok: true };
  }

  // ---------------- Docs ----------------
  // "version" on every doc projection below is the current/max row in pm_doc_versions (P3-10),
  // COALESCEd to 1 for a doc with no version rows yet (any doc written before this migration —
  // synth-on-read, same spirit as effectiveStatuses(), rather than a backfill DML: a pre-existing
  // doc's CURRENT content IS its version 1 in every observable sense).
  @Get(":tenantId/pm/projects/:projectId/docs")
  async listDocs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt",
                  COALESCE((SELECT MAX(version) FROM pm_doc_versions WHERE doc_id = d.id), 1) AS version
           FROM pm_docs d LEFT JOIN users u ON u.id = d.author_id
           WHERE d.project_id = $1 AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/docs")
  @HttpCode(201)
  async createDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Body() b: { title?: string; body?: string }) {
    const title = b?.title?.trim();
    if (!title) throw new BadRequestException("title required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    const body = b.body ?? "";
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_docs (id, tenant_id, project_id, title, body, author_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, projectId, title, body, req.principal.userId, config.originSite],
      );
      // P3-10: the creation write IS version 1 — every doc's history starts here.
      await appendDocVersion(c, tenantId, id, 1, title, body, req.principal.userId);
      // TR-05: pm->work_activity evidence feed. object_kind 'doc' (not 'pm_doc') so this activity
      // also surfaces via the deliverable_evidence view (migration 0030 filters object_kind IN
      // ('file','doc','deliverable')); projectId is a structured link hint (work-activity-linker.ts
      // rule a) so the auto-linker resolves project + department without a DB lookup.
      // TR-31: actorId is the SAME rule-a hint mechanism for the authoring user -> an EXACT
      // person link, and doubles as the outbox consumer's actor_user_id.
      await emitEvent(c, tenantId, "pm_doc", id, "pm.doc.created", { docId: id, title, projectId, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_doc", id, { title });
    return { id };
  }

  @Get(":tenantId/pm/projects/:projectId/docs/:docId")
  async getDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt",
                COALESCE((SELECT MAX(version) FROM pm_doc_versions WHERE doc_id = d.id), 1) AS version
         FROM pm_docs d LEFT JOIN users u ON u.id = d.author_id WHERE d.id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL`,
        [docId, projectId],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("doc not found");
    return rows.rows[0];
  }

  @Patch(":tenantId/pm/projects/:projectId/docs/:docId")
  @HttpCode(200)
  async patchDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("docId") docId: string, @Body() b: { title?: string; body?: string }) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      // Row-lock FIRST (P3-10): a second concurrent PATCH on the SAME doc blocks here until this
      // transaction commits its version append, then computes MAX(version)+1 against the
      // already-committed row — so two racing PATCHes can never both compute the same next
      // version number (the UNIQUE(tenant_id, doc_id, version) constraint is the hard backstop).
      const lock = await c.query<{ title: string; body: string }>(
        `SELECT title, body FROM pm_docs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [docId, projectId],
      );
      const current = lock.rows[0];
      if (!current) throw new NotFoundException("doc not found");
      const nextTitle = typeof b?.title === "string" ? b.title : current.title;
      const nextBody = typeof b?.body === "string" ? b.body : current.body;
      // A true no-op PATCH (both title and body unchanged, whether omitted or resubmitted
      // identical) appends NOTHING to history — just returns, per the P3-10 contract.
      if (nextTitle === current.title && nextBody === current.body) return;
      await c.query(
        `UPDATE pm_docs SET title = $3, body = $4, updated_at = now() WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [docId, projectId, nextTitle, nextBody],
      );
      await appendDocVersion(c, tenantId, docId, null, nextTitle, nextBody, req.principal.userId);
      // TR-05: emitted only on a genuine change (this line is unreachable on the no-op `return`
      // above), so a resubmitted-identical PATCH never mints a bogus "updated" evidence row.
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pm_doc", docId, "pm.doc.updated", { docId, title: nextTitle, projectId, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_doc", docId);
    return { ok: true };
  }

  // ---------------- Doc versions (P3-10) ----------------
  @Get(":tenantId/pm/docs/:docId/versions")
  async listDocVersions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string) {
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT v.version, v.author_id AS "authorId", u.name AS "authorName", v.created_at AS "createdAt"
           FROM pm_doc_versions v LEFT JOIN users u ON u.id = v.author_id
           WHERE v.doc_id = $1 ORDER BY v.version ASC`,
          [docId],
        )
        .then((r) => r.rows),
    );
  }

  @Get(":tenantId/pm/docs/:docId/versions/:v")
  async getDocVersion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string, @Param("v") v: string) {
    const version = parseVersion(v);
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT v.version, v.title, v.body, u.name AS "authorName", v.created_at AS "createdAt"
         FROM pm_doc_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.doc_id = $1 AND v.version = $2`,
        [docId, version],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("doc version not found");
    return rows.rows[0];
  }

  @Post(":tenantId/pm/docs/:docId/versions/:v/restore")
  @HttpCode(200)
  async restoreDocVersion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string, @Param("v") v: string) {
    const version = parseVersion(v);
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      // Same row-lock pattern as patchDoc — serializes against any concurrent patch/restore on
      // this doc so the appended version number can never collide.
      const lock = await c.query(`SELECT 1 FROM pm_docs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`, [docId, projectId]);
      if (!lock.rows[0]) throw new NotFoundException("doc not found");
      const target = await c.query<{ title: string; body: string }>(
        `SELECT title, body FROM pm_doc_versions WHERE doc_id = $1 AND version = $2`,
        [docId, version],
      );
      if (!target.rows[0]) throw new NotFoundException("doc version not found");
      const { title, body } = target.rows[0];
      // History is APPEND-ONLY: this never rewrites version `v` (or any other row) — it sets the
      // doc row to v's content and appends a BRAND-NEW version authored by the restorer.
      await c.query(
        `UPDATE pm_docs SET title = $3, body = $4, updated_at = now() WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [docId, projectId, title, body],
      );
      await appendDocVersion(c, tenantId, docId, null, title, body, req.principal.userId);
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pm_doc", docId, "pm.doc.restored", { docId, title, projectId, toVersion: version, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "restored", "pm_doc", docId, { toVersion: version });
    return { ok: true };
  }

  // ---------------- AI Tracker ----------------
  @Get(":tenantId/pm/tasks/:taskId/suggestions")
  async listSuggestions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT id, task_id AS "taskId", kind, proposed, rationale, docs, status, created_at AS "createdAt"
           FROM pm_suggestions WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [taskId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/tasks/:taskId/tracker/run")
  @HttpCode(200)
  async runTracker(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "update");
    const result = await withTenants([tenantId], async (c) => {
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");
      const subtasks = (task.subtasks as { done: boolean }[]) ?? [];
      const done = subtasks.filter((s) => s.done).length;
      const computedProgress = subtasks.length > 0 ? Math.round((done / subtasks.length) * 100) : task.progress;
      // FLAG-DRIVEN: the "complete" target is the first is_done status; the "in-flight" target is
      // the first non-done/non-blocked status past the initial column. No literal id string-match.
      const trackerStatuses = [...(await effectiveStatuses(c, task.projectId))].sort((a, z) => a.position - z.position);
      const doneTarget = trackerStatuses.find((s) => s.isDone);
      const firstStatus = trackerStatuses[0];
      const inFlightTarget = trackerStatuses.find((s) => !s.isDone && !s.isBlocked && s.id !== firstStatus?.id);
      let computedStatus = task.status;
      if (computedProgress >= 100 && doneTarget) computedStatus = doneTarget.id;
      else if (computedProgress > 0 && task.status === firstStatus?.id && inFlightTarget) computedStatus = inFlightTarget.id;
      const rationale =
        subtasks.length > 0
          ? `${done}/${subtasks.length} subtasks complete → ${computedProgress}% progress${computedStatus !== task.status ? `, move to “${computedStatus}”` : ""}.`
          : `No subtasks to measure; holding at ${computedProgress}%. Add a checklist for finer tracking.`;

      // Deliver the project's docs as reference material (WS8 agent will source from Knowledge/D9).
      const docs = await c.query<{ id: string; title: string }>(
        `SELECT id, title FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 3`,
        [task.projectId],
      );
      const delivered = docs.rows.map((d) => ({ title: d.title, ref: `/projects/${task.projectId}?doc=${d.id}` }));

      const suggestions: { id: string; taskId: string; kind: string; proposed: string; rationale: string; docs: unknown[]; status: string; createdAt: string }[] = [];
      const insertSuggestion = async (kind: "progress" | "status", proposed: string) => {
        const sid = newId();
        const row = await c.query<{ created_at: string }>(
          `INSERT INTO pm_suggestions (id, tenant_id, task_id, kind, proposed, rationale, docs, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at`,
          [sid, tenantId, taskId, kind, proposed, rationale, JSON.stringify(delivered), config.originSite],
        );
        suggestions.push({ id: sid, taskId, kind, proposed, rationale, docs: delivered, status: "pending", createdAt: row.rows[0].created_at });
      };
      if (computedProgress !== task.progress) await insertSuggestion("progress", String(computedProgress));
      if (computedStatus !== task.status) await insertSuggestion("status", computedStatus);

      // AI-authored comment (author_id null = system/AI) delivered onto the task thread.
      await c.query(
        `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site)
         VALUES ($1, $2, NULL, 'task', $3, $4, $5)`,
        [newId(), tenantId, taskId, `AI Tracker: ${rationale}`, config.originSite],
      );
      // TR-31: deliberately NO actorId — the tracker's authored comment above is itself
      // author_id NULL (system/AI), so attributing the run to whoever clicked "run tracker"
      // would misrepresent their comment/collaboration count with an AI-authored action.
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.tracker.run", { suggestions: suggestions.length, actorExternal: "pm:ai-tracker" });
      return { suggestions, delivered, responsibleId: task.assignee?.responsibleId ?? null };
    });
    // Notify the person in charge that the tracker delivered an update.
    if (result.responsibleId) {
      await notify(tenantId, result.responsibleId, req.principal.userId, "tracker", {
        title: "AI Tracker updated your task", severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
      });
    }
    await writeActivity(tenantId, req.principal.userId, "tracker.run", "pm_task", taskId, { suggestions: result.suggestions.length });
    return { suggestions: result.suggestions, delivered: result.delivered };
  }

  @Post(":tenantId/pm/suggestions/:suggestionId/confirm")
  @HttpCode(200)
  async confirmSuggestion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("suggestionId") suggestionId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const sug = await c.query<{ task_id: string; kind: string; proposed: string; status: string }>(
        `SELECT task_id, kind, proposed, status FROM pm_suggestions WHERE id = $1`,
        [suggestionId],
      );
      const s = sug.rows[0];
      if (!s) throw new NotFoundException("suggestion not found");
      if (s.status !== "pending") throw new BadRequestException("suggestion already resolved");
      // Apply the proposal, honouring the same FLAG-DRIVEN done↔100 coupling as PATCH.
      const task = await c.query<{ project_id: string; status: string; dependsOn: string[] }>(
        `SELECT project_id, status, depends_on AS "dependsOn" FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`,
        [s.task_id],
      );
      if (!task.rows[0]) throw new NotFoundException("task not found");
      const statuses = await effectiveStatuses(c, task.rows[0].project_id);
      const doneStatus = [...statuses].sort((a, z) => a.position - z.position).find((x) => x.isDone);
      if (s.kind === "progress") {
        const p = Math.max(0, Math.min(100, Math.round(Number(s.proposed) || 0)));
        const setDone = p >= 100 && !!doneStatus;
        await c.query(
          `UPDATE pm_tasks SET progress = $2, status = CASE WHEN $3 THEN $4 ELSE status END, updated_at = now() WHERE id = $1`,
          [s.task_id, p, setDone, doneStatus?.id ?? null],
        );
      } else {
        const proposed = statuses.find((x) => x.id === s.proposed);
        if (!proposed) throw new BadRequestException("suggestion has invalid status");
        // P4-I1 — the AI Tracker is a server-side write path too (confirming its suggestion moves
        // the task's status exactly like a PATCH would), so it is gated identically. Without this,
        // "confirm suggestion" would be the one status-setting endpoint in the module that bypasses
        // I1 entirely.
        if (await dependencyEnforcementEnabled(c, task.rows[0].project_id)) {
          const openDeps = await openDependencies(c, task.rows[0].dependsOn ?? []);
          enforceStartGate({ status: s.proposed, priorStatus: task.rows[0].status, statuses, openDeps });
        }
        await c.query(
          `UPDATE pm_tasks SET status = $2, progress = CASE WHEN $3 THEN 100 ELSE progress END, block_reason = NULL, updated_at = now() WHERE id = $1`,
          [s.task_id, s.proposed, proposed.isDone],
        );
      }
      await c.query(`UPDATE pm_suggestions SET status = 'applied', updated_at = now() WHERE id = $1`, [suggestionId]);
      // TR-31: confirming a suggestion IS a genuine human decision on the task -> actorId propagates.
      await emitEvent(c, tenantId, "pm_task", s.task_id, "pm.suggestion.confirmed", { suggestionId, kind: s.kind, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "suggestion.confirmed", "pm_suggestion", suggestionId);
    return { ok: true };
  }

  @Post(":tenantId/pm/suggestions/:suggestionId/dismiss")
  @HttpCode(200)
  async dismissSuggestion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("suggestionId") suggestionId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_suggestions SET status = 'dismissed', updated_at = now() WHERE id = $1 AND status = 'pending'`, [suggestionId]);
      if (res.rowCount === 0) throw new NotFoundException("suggestion not found or already resolved");
    });
    await writeActivity(tenantId, req.principal.userId, "suggestion.dismissed", "pm_suggestion", suggestionId);
    return { ok: true };
  }

  // ---------------- Templates (P3-01) ----------------
  // Tenant-scoped (not project-scoped), manage-gated like milestones/docs/tags. `kind` is
  // immutable post-creation — PATCH validates `payload` against the EXISTING row's kind, read
  // from the DB, never re-derived from the request body.
  @Get(":tenantId/pm/templates")
  async listTemplates(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("kind") kind?: string) {
    if (kind !== undefined && !TEMPLATE_KINDS.has(kind as TemplateKind)) throw new BadRequestException("invalid kind");
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    return withTenants([tenantId], (c) =>
      c
        .query<{ id: string; kind: string; name: string; payload: unknown; updatedAt: string }>(
          `SELECT id, kind, name, payload, updated_at AS "updatedAt" FROM pm_templates
           WHERE deleted_at IS NULL ${kind ? "AND kind = $1" : ""} ORDER BY name`,
          kind ? [kind] : [],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/templates")
  @HttpCode(201)
  async createTemplate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { kind?: string; name?: string; payload?: unknown },
  ) {
    if (typeof b?.kind !== "string" || !TEMPLATE_KINDS.has(b.kind as TemplateKind)) throw new BadRequestException("invalid kind");
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    const payload = validateTemplatePayload(b.kind, b.payload);
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, b.kind, name, JSON.stringify(payload), config.originSite],
      );
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.created", { kind: b.kind, name });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_template", id, { kind: b.kind, name });
    return { id, kind: b.kind, name, payload };
  }

  @Patch(":tenantId/pm/templates/:id")
  @HttpCode(200)
  async patchTemplate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() b: { name?: string; payload?: unknown },
  ) {
    if (b?.name !== undefined && !b.name.trim()) throw new BadRequestException("name cannot be empty");
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      const existing = await c.query<{ kind: string }>(`SELECT kind FROM pm_templates WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!existing.rows[0]) throw new NotFoundException("template not found");
      let payloadJson: string | null = null;
      if (b?.payload !== undefined) {
        const payload = validateTemplatePayload(existing.rows[0].kind, b.payload);
        payloadJson = JSON.stringify(payload);
      }
      const res = await c.query<{ id: string; kind: string; name: string; payload: unknown }>(
        `UPDATE pm_templates SET name = COALESCE($2, name), payload = COALESCE($3::jsonb, payload), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id, kind, name, payload`,
        [id, b?.name?.trim() || null, payloadJson],
      );
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.updated", {});
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_template", id);
    return updated;
  }

  @Delete(":tenantId/pm/templates/:id")
  @HttpCode(200)
  async deleteTemplate(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_templates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (res.rowCount === 0) throw new NotFoundException("template not found");
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.deleted", {});
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_template", id);
    return { ok: true };
  }
}
