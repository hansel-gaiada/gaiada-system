// MI-03 — the STAFF half of webdev maintenance intake (D-7): triage queue, internal logging, and the
// mini-run spawner. Design: docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md
// §2 (the triage gate's place in the spine), §3 (the spawner + its idempotency argument), §4.2 (authz).
//
// ── WHY THIS LIVES IN CORE, NOT IN A `webdev` MODULE ─────────────────────────────────────────────
// There is no `src/modules/webdev/` — every shipped webdev surface (pipeline runs, stages, gates,
// scope sign-offs, the portal) is core, and `webdev_change_requests` takes the PLAIN tenant wall
// (D-2a, migration 0088's header) precisely so the client portal can write it. Consequently NO
// `ModuleEnabledGuard` sits in front of triage, and no `withTenants(..., {modules:['webdev']})` scope
// is declared anywhere in this file: `app_module_allowed()` is a two-sided handshake, and this table
// is deliberately not on the far side of it. Declaring the scope would not break these reads (the
// table has no module predicate), which is exactly what the plain-wall regression guard in
// webdev-change-requests.test.ts asserts in BOTH directions — the failure this decision avoids is a
// third-walled table reading ZERO rows, silently, on the portal path.
//
// ── THE TRIAGE GATE IS NOT A `pipeline_gates` ROW ────────────────────────────────────────────────
// A change request has no run yet, so triage sits IN FRONT OF the gate spine rather than inside it
// (§2.1). For a CR-born run, triage plays the role `prd_review` plays for a meeting-born run: the
// requester authored the text, a PM disposes of it, and the CLIENT-side confirmation is the run's
// ordinary `prd_sign` gate. From the moment the mini-run exists the spine applies UNMODIFIED — which
// is the whole claim D-7 is making, and the reason step 5 of the spawner below (the
// `pipeline.run.created` emit) is load-bearing rather than decorative.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException,
  NotImplementedException, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { scrubText } from "./scrub";
import { lockChangeRequest } from "./webdev-cr-lock";
import { notifyBestEffort, resolveClientRecipients } from "./client-notify";
import { createPmTaskInTx, normalizePmTaskInput } from "../modules/pm/pm.controller";

const KINDS = new Set(["content", "design", "feature", "bug"]);
const ROUTES = new Set(["control_plane", "mini_run", "pm_task"]);
const TRIAGE_ACTIONS = new Set(["decline", "convert"]);
// Severity is a TRIAGE OUTPUT, not an intake field — see migration 202608271000's §3 header. The
// portal deliberately cannot set it: asking a client to rank their own bug against everyone else's
// reliably yields "critical". `wcr_bug_has_severity` enforces the same rule structurally, so a bug
// converted without one is refused by the database rather than by this check alone.
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

// §2.3's routing table. This is the DEFAULT the drawer renders as a suggestion when the PM does not
// name a route — "the PM's triage decision is the record" (blueprint §07), so an explicit
// `body.route` always wins. `content` defaults to `pm_task` in v1 because its natural route
// (`control_plane`) needs webdesk P4, which does not exist (see convert()).
const DEFAULT_ROUTE_BY_KIND: Record<string, string> = {
  content: "pm_task",
  design: "mini_run",
  feature: "mini_run",
  bug: "pm_task",
};

const TITLE_CAP = 300;
const BODY_CAP = 5000;
const REASON_CAP = 1000;
// Bug-detail caps — same values as the portal controller's MAX_* block, deliberately. Two intake
// paths that truncate the same field at different lengths is a difference nobody discovers until a
// repro step is silently shorter depending on who filed it.
const REPRO_CAP = 5_000;
const ENVIRONMENT_CAP = 200;
const SEEN_ON_VERSION_CAP = 100;
const AFFECTED_URL_CAP = 2_000;

interface CrRow {
  id: string;
  client_id: string | null;
  project_id: string | null;
  source: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  route: string | null;
  pipeline_run_id: string | null;
  pm_task_id: string | null;
  requested_by: string | null;
  requester_name: string | null;
}

/** The columns the triage transition reads UNDER THE LOCK. Kept as one constant so the re-read and
 *  the (identical) shape used by the read endpoints cannot drift — the precondition re-check is only
 *  as trustworthy as the row it evaluates. */
const CR_TRIAGE_COLUMNS = `cr.id, cr.client_id, cr.project_id, cr.source, cr.kind, cr.title, cr.body,
        cr.status, cr.route, cr.pipeline_run_id, cr.pm_task_id, cr.requested_by,
        ru.name AS requester_name`;

/** The requirement doc the mini-run's `delivery/prd_extract` stage carries (§3.1 step 2). Rendered
 *  from the CR so the run is self-describing in the workspace AND in the portal, and carries a link
 *  back to the request that caused it. Markdown, like every other artifact_ref in the pipeline. */
function renderRequirementDoc(cr: CrRow): string {
  return [
    `# ${cr.title}`,
    "",
    `**Origin:** maintenance change request (\`${cr.kind}\`, source \`${cr.source}\`)`,
    `**Requested by:** ${cr.requester_name ?? cr.requested_by ?? "unknown"}`,
    `**Change request:** \`${cr.id}\``,
    "",
    "## Requirement",
    "",
    cr.body?.trim() ? cr.body.trim() : "_The requester supplied no further detail._",
  ].join("\n");
}

/** The scope note the mini-run's `scope/scope_extract` stage carries (§3.1 step 2). Deliberately
 *  describes the WORK only: the estimate/pricing embed arrives with the D-6 estimates program, not
 *  here, and inventing a number the agency has not agreed to would be worse than omitting one. */
function renderScopeNote(cr: CrRow): string {
  return [
    `# Scope — ${cr.title}`,
    "",
    `Maintenance change request \`${cr.id}\` (\`${cr.kind}\`).`,
    "",
    "## Work",
    "",
    cr.body?.trim() ? cr.body.trim() : `Address the ${cr.kind} request titled "${cr.title}".`,
    "",
    "## Not included",
    "",
    "_Commercials (estimate, rate, timeline) are agreed separately; this note describes the work only._",
  ].join("\n");
}

@Controller("api")
@UseGuards(AuthGuard)
export class WebdevChangeRequestsController {
  // ── Reads ─────────────────────────────────────────────────────────────────────────────────────
  /** The triage queue + full list. `status=new` (the default the console opens on) is served by
   *  `ix_wcr_new`. Cerbos gates this at manager/module-manager+ (plain `member` is excluded on
   *  purpose — the queue exposes every client's asks tenant-wide, resource_pipeline_gate.yaml:18's
   *  rationale); row reach beyond that is RLS's job, since a staff reader legitimately sees the
   *  whole tenant's queue. */
  @Get(":tenantId/webdev/change-requests")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    @Query("clientId") clientId?: string,
    @Query("projectId") projectId?: string,
    @Query("kind") kind?: string,
  ) {
    await authorize(req.principal, { kind: "webdev_change_request", tenantId, module: "webdev" }, "read");
    const clauses = ["cr.deleted_at IS NULL"];
    const args: unknown[] = [];
    if (status) clauses.push(`cr.status = $${args.push(status)}`);
    if (kind) clauses.push(`cr.kind = $${args.push(kind)}`);
    // Compared as text, not cast to uuid, so a malformed id from a hand-edited query string matches
    // nothing instead of 500ing the request on an invalid-uuid cast (listRuns's precedent).
    if (clientId) clauses.push(`cr.client_id::text = $${args.push(clientId)}`);
    if (projectId) clauses.push(`cr.project_id::text = $${args.push(projectId)}`);
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT cr.id, cr.client_id AS "clientId", cl.name AS "clientName",
                cr.project_id AS "projectId", p.name AS "projectName",
                cr.source, cr.kind, cr.title, cr.status, cr.route,
                cr.pipeline_run_id AS "pipelineRunId", cr.pm_task_id AS "pmTaskId",
                cr.requested_by AS "requestedBy", ru.name AS "requestedByName",
                cr.triaged_by AS "triagedBy", tu.name AS "triagedByName", cr.triaged_at AS "triagedAt",
                cr.declined_reason AS "declinedReason", cr.created_at AS "createdAt", cr.updated_at AS "updatedAt"
           FROM webdev_change_requests cr
           LEFT JOIN clients cl ON cl.id = cr.client_id
           LEFT JOIN projects p ON p.id = cr.project_id
           LEFT JOIN users ru ON ru.id = cr.requested_by
           LEFT JOIN users tu ON tu.id = cr.triaged_by
          WHERE ${clauses.join(" AND ")}
          -- Oldest-first WITHIN the queue: a triage queue is worked front-to-back, and a
          -- newest-first list quietly buries the request that has waited longest.
          ORDER BY cr.created_at ASC
          LIMIT 200`,
        args,
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/webdev/change-requests/:id")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "webdev_change_request", tenantId, id, module: "webdev" }, "read");
    return withTenants([tenantId], async (c) => {
      const r = await c.query(
        `SELECT cr.id, cr.client_id AS "clientId", cl.name AS "clientName",
                cr.project_id AS "projectId", p.name AS "projectName",
                cr.source, cr.kind, cr.title, cr.body, cr.status, cr.route,
                cr.pipeline_run_id AS "pipelineRunId", cr.pm_task_id AS "pmTaskId",
                cr.requested_by AS "requestedBy", ru.name AS "requestedByName",
                cr.triaged_by AS "triagedBy", tu.name AS "triagedByName", cr.triaged_at AS "triagedAt",
                cr.declined_reason AS "declinedReason", cr.created_at AS "createdAt", cr.updated_at AS "updatedAt",
                -- §2.2: the linked artifact is joined at READ time, so the CR shows live run/task
                -- status without a status-copy that would go stale (and without OQ-5's deferred
                -- "run complete => request done" mapping, which has judgment in it).
                run.status AS "runStatus", run.title AS "runTitle",
                t.title AS "taskTitle", t.status AS "taskStatus"
           FROM webdev_change_requests cr
           LEFT JOIN clients cl ON cl.id = cr.client_id
           LEFT JOIN projects p ON p.id = cr.project_id
           LEFT JOIN users ru ON ru.id = cr.requested_by
           LEFT JOIN users tu ON tu.id = cr.triaged_by
           LEFT JOIN pipeline_runs run ON run.id = cr.pipeline_run_id
           LEFT JOIN pm_tasks t ON t.id = cr.pm_task_id
          WHERE cr.id = $1 AND cr.deleted_at IS NULL`,
        [id],
      );
      if (!r.rows[0]) throw new NotFoundException("change request not found");
      return r.rows[0];
    });
  }

  // ── Internal create (source='internal') ───────────────────────────────────────────────────────
  /** Staff logging internal maintenance work as a change request, so it lands in the same queue and
   *  routes through the same triage. `source='internal'` is the ONE case the DDL lets `client_id` be
   *  NULL (`wcr_portal_has_requester`); `requested_by` is still the acting staff member, because
   *  "who asked this?" must never be NULL in the queue.
   *
   *  `status`, `route` and `source` are NEVER read from the body — same rule as the portal path. */
  @Post(":tenantId/webdev/change-requests")
  @HttpCode(201)
  async createInternal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: {
      kind?: string; title?: string; body?: string; clientId?: string; projectId?: string;
      reproSteps?: string; environment?: string; seenOnVersion?: string; affectedUrl?: string;
    },
  ) {
    const { kind, clientId, projectId } = body ?? {};
    const rawTitle = body?.title?.trim();
    if (!kind || !KINDS.has(kind)) throw new BadRequestException("kind must be content|design|feature|bug");
    if (!rawTitle) throw new BadRequestException("title required");
    await authorize(req.principal, { kind: "webdev_change_request", tenantId, module: "webdev" }, "create");
    const id = newId();
    const title = scrubText(rawTitle).text.slice(0, TITLE_CAP);
    const bodyText = body?.body ? scrubText(body.body).text.slice(0, BODY_CAP) : null;
    try {
      await withTenants([tenantId], async (c) => {
        await c.query(
          `INSERT INTO webdev_change_requests
             (id, tenant_id, client_id, project_id, source, kind, title, body, status, requested_by, origin_site,
              repro_steps, environment, seen_on_version, affected_url)
           VALUES ($1, $2, $3, $4, 'internal', $5, $6, $7, 'new', $8, $9, $10, $11, $12, $13)`,
          // Same four reporter-supplied fields the portal accepts. Parity is the point: this is the
          // path a QA engineer, an n8n flow and (later) the D-9 CI receiver all file through, and a
          // capability that only carries full detail on the portal path is the "UI as the definition"
          // failure the agentic-native bar names.
          // Severity is absent here too — internal or not, it is set at triage.
          [
            id, tenantId, clientId ?? null, projectId ?? null, kind, title, bodyText,
            req.principal.userId, config.originSite,
            body?.reproSteps ? scrubText(body.reproSteps).text.slice(0, REPRO_CAP) : null,
            body?.environment ? scrubText(body.environment).text.slice(0, ENVIRONMENT_CAP) : null,
            body?.seenOnVersion ? scrubText(body.seenOnVersion).text.slice(0, SEEN_ON_VERSION_CAP) : null,
            body?.affectedUrl ? scrubText(body.affectedUrl).text.slice(0, AFFECTED_URL_CAP) : null,
          ],
        );
        await emitEvent(c, tenantId, "webdev_change_request", id, "webdev.change_request.created", {
          source: "internal", kind, clientId: clientId ?? null, projectId: projectId ?? null, actorId: req.principal.userId,
        });
      });
    } catch (err) {
      // The composite FKs (client_id, tenant_id) / (project_id, tenant_id) are the TENANCY guarantee
      // — an FK check runs as the table owner OUTSIDE RLS, so a cross-tenant or non-existent id is
      // refused here rather than being silently accepted. Surfaced as a 400, not a 500: the caller
      // named a bad id, which is their mistake to fix.
      if ((err as { code?: string }).code === "23503") {
        throw new BadRequestException("clientId/projectId must belong to this tenant");
      }
      throw err;
    }
    await writeActivity(tenantId, req.principal.userId, "created", "webdev_change_request", id, {
      source: "internal", kind, clientId: clientId ?? null,
    });
    // Deliberately NO notification here: §5.3's "CR submitted" row addresses the PORTAL path (tell the
    // internal side a client asked for something). A staff member logging their own request does not
    // need to be told they did it, and notifying the client's project owners about internal work
    // would be the notification storm portal-commerce.controller.ts:548–566 exists to avoid.
    return { id, status: "new" };
  }

  // ── Triage ────────────────────────────────────────────────────────────────────────────────────
  /** The WHOLE disposition — decline or convert — as one action, one Cerbos check (`triage`) and one
   *  audit row, mirroring `pipeline_gate`'s single `decide` for approve/reject/sign.
   *
   *  ⚠ THE ORDER INSIDE THE TRANSACTION IS THE FEATURE. See webdev-cr-lock.ts for the full argument;
   *  in one sentence: a lock WITHOUT a server-side precondition re-check does nothing, so it must be
   *  lock -> re-read -> re-check `status='new'` -> spawn -> UPDATE the CR -> emit events, all inside
   *  ONE `withTenants` transaction (BEGIN/COMMIT is what makes an xact-scoped advisory lock real). */
  @Post(":tenantId/webdev/change-requests/:id/triage")
  @HttpCode(200)
  async triage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { action?: string; route?: string; reason?: string; kindOverride?: string; severity?: string },
  ) {
    const { action, route: requestedRoute, kindOverride, severity } = body ?? {};
    // AUTHORIZE BEFORE VALIDATE — see core.controller's createProject for the same fix and why.
    // A caller who may not triage learns only that; and no future required field can quietly demote
    // a denial test here to a payload 400 (which is exactly what the `severity` gate below did to
    // webdev-cr-race.test.ts's MI-03 probe). Nothing above depends on the body.
    await authorize(req.principal, { kind: "webdev_change_request", tenantId, id, module: "webdev" }, "triage");
    if (!action || !TRIAGE_ACTIONS.has(action)) throw new BadRequestException("action must be decline|convert");
    if (kindOverride !== undefined && !KINDS.has(kindOverride)) {
      throw new BadRequestException("kindOverride must be content|design|feature|bug");
    }
    if (severity !== undefined && !SEVERITIES.has(severity)) {
      throw new BadRequestException("severity must be critical|high|medium|low");
    }
    if (requestedRoute !== undefined && !ROUTES.has(requestedRoute)) {
      throw new BadRequestException("route must be control_plane|mini_run|pm_task");
    }
    // A decline that records no reason is how a requester learns their ask "vanished". §2.2 writes the
    // reason into the state machine, so it is required rather than optional.
    const reason = action === "decline" ? scrubText(String(body?.reason ?? "")).text.trim().slice(0, REASON_CAP) : null;
    if (action === "decline" && !reason) throw new BadRequestException("reason required when declining");

    const result = await withTenants([tenantId], async (c) => {
      // 1 · SERIALIZE on the change request. First statement in the transaction, before any read whose
      //     result this handler acts on.
      await lockChangeRequest(c, id);

      // 2 · RE-READ under the lock. THIS, not the lock, is the fix: a racer whose decision was
      //     computed from a snapshot taken before the lock discovers here that the state which
      //     justified it has been consumed.
      const cur = await c.query<CrRow>(
        `SELECT ${CR_TRIAGE_COLUMNS}
           FROM webdev_change_requests cr
           LEFT JOIN users ru ON ru.id = cr.requested_by
          WHERE cr.id = $1 AND cr.deleted_at IS NULL`,
        [id],
      );
      const cr = cur.rows[0];
      if (!cr) return { outcome: "not_found" as const };

      // 3 · RE-CHECK THE PRECONDITION. `status='new'` is the only state a disposition may act on, and
      //     the DDL's `wcr_route_matches_status` CHECK ties it to `route IS NULL`, so this single test
      //     also establishes "nothing has been spawned yet". A second triage is a stale retrigger or a
      //     double-click, NEVER a second intent (existingStageForRepeatedCreate's ruling,
      //     pipeline.controller.ts:89–124) — so the loser resolves to the artifact that already
      //     exists instead of spawning a twin.
      if (cr.status !== "new") {
        return {
          outcome: "already_triaged" as const,
          existing: {
            status: cr.status,
            route: cr.route,
            pipelineRunId: cr.pipeline_run_id,
            pmTaskId: cr.pm_task_id,
          },
        };
      }

      const kind = kindOverride ?? cr.kind;

      // A bug leaving triage must carry a severity. Resolved HERE, under the lock and after
      // `kindOverride` is applied, because a PM re-kinding `feature -> bug` at triage creates the
      // obligation that did not exist when the row was filed. Declines are exempt: `declined` is a
      // pre-triage terminal state in `wcr_bug_has_severity`, and ranking something you are throwing
      // away is busywork. A typed 400 rather than letting the CHECK surface as a 500 (agentic-native
      // criterion 2: refusals are typed, not incidental).
      if (action === "convert" && kind === "bug" && !severity) {
        throw new BadRequestException("severity required when converting a bug: critical|high|medium|low");
      }
      // Non-bug kinds carry NULL, per `wcr_severity_vocab`.
      const severityToWrite = kind === "bug" ? severity ?? null : null;

      if (action === "decline") {
        // `declined` carries no route — the CHECK enforces `(route IS NULL) = (status IN ('new','declined'))`.
        await c.query(
          `UPDATE webdev_change_requests
              SET status = 'declined', kind = $4, declined_reason = $2,
                  triaged_by = $3, triaged_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'new' AND deleted_at IS NULL`,
          [id, reason, req.principal.userId, kind],
        );
        await emitEvent(c, tenantId, "webdev_change_request", id, "webdev.change_request.updated", {
          status: "declined", route: null, kind, actorId: req.principal.userId,
        });
        const clientRecipients = await dispositionClientRecipients(c, cr);
        return {
          outcome: "declined" as const, kind,
          recipients: recipientsFor(cr.requested_by, clientRecipients),
        };
      }

      // ---- convert ----
      const routeChoice = requestedRoute ?? DEFAULT_ROUTE_BY_KIND[kind];
      if (routeChoice === "control_plane") {
        // Schema-admitted (so no migration is needed the day webdesk lands) but not implementable:
        // there is no control plane to drive. Refused explicitly, naming what is missing, rather than
        // silently falling back to another route — a PM who picked `control_plane` needs to know the
        // edit has to be done by hand off a PM task until webdesk P4 exists (§2.3).
        throw new NotImplementedException(
          "route 'control_plane' needs the webdesk control plane (webdesk phase 4), which does not exist yet — convert to pm_task and make the edit by hand",
        );
      }

      if (routeChoice === "pm_task") {
        // A PM task hangs off a project; the CR may legitimately be client-wide (project_id NULL),
        // and there is no defensible way to guess which project such a request belongs to.
        if (!cr.project_id) {
          throw new BadRequestException("this request names no project — a pm_task route needs one (convert to mini_run, or re-file against a project)");
        }
        // Created through the PM module's OWN service function, on THIS connection, inside THIS
        // transaction — so the task, the CR update and both events commit or roll back together, and
        // core never carries a second copy of PM's insert (status ladder, D17 validation, WD-28 seq
        // allocation, TR-02 assignee dual-write, `pm.task.created`).
        const task = await createPmTaskInTx(c, tenantId, req.principal.userId, normalizePmTaskInput({
          projectId: cr.project_id,
          title: cr.title,
          description: renderRequirementDoc(cr),
          priority: kind === "bug" ? "high" : "normal",
        }));
        await c.query(
          `UPDATE webdev_change_requests
              SET status = 'in_progress', route = 'pm_task', pm_task_id = $2, kind = $4,
                  severity = $5,
                  triaged_by = $3, triaged_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'new' AND deleted_at IS NULL`,
          [id, task.id, req.principal.userId, kind, severityToWrite],
        );
        await emitEvent(c, tenantId, "webdev_change_request", id, "webdev.change_request.updated", {
          status: "in_progress", route: "pm_task", pmTaskId: task.id, kind, actorId: req.principal.userId,
        });
        const clientRecipients = await dispositionClientRecipients(c, cr);
        return {
          outcome: "converted" as const, route: "pm_task" as const, kind, pmTaskId: task.id,
          recipients: recipientsFor(cr.requested_by, clientRecipients),
          signers: [] as string[],
        };
      }

      // ---- route = mini_run: §3.1, ordinary pipeline rows only ----
      const runId = newId();
      // `owner_id` = the triaging PM, validated by the existing staff-membership rule
      // (assertOwnerIsStaff, pipeline.controller.ts:141–149) — but NON-FATALLY here, which is a real
      // interaction with trap #4 rather than a shortcut: `group_executive` is a GLOBAL grant and is
      // deliberately allowed to triage with NO `company_memberships` row in this tenant, so demanding
      // staff membership would 400 exactly the principal the policy just allowed. An owner-less run is
      // a shipped, supported state (`pipeline_runs.owner_id` is nullable and client-notify.ts already
      // falls back to `created_by`), so the honest value for a non-member triager is NULL.
      const ownerId = await staffMemberOrNull(c, req.principal.userId);
      await c.query(
        `INSERT INTO pipeline_runs
           (id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, project_id, owner_id, created_by, origin_site)
         VALUES ($1, $2, NULL, $3, NULL, 'delivery_active', $4, $5, $6, $7, $8)`,
        // source_meeting_id NULL is the HONEST value — a mini-run has no meeting. (0017's dedupe index
        // is partial on non-null, so NULLs are fine; it is also why meeting-id dedupe can do nothing
        // for this path and the advisory lock + re-check above has to.)
        [runId, tenantId, cr.title, cr.client_id, cr.project_id, ownerId, req.principal.userId, config.originSite],
      );
      // Two pre-filled extraction stages, exactly the shape `createRun` writes for a meeting-born run
      // (pipeline.controller.ts:215–219). No `report` track: there is no meeting to minute, and the
      // fanout's "Has report track?" branch reads the run, so it correctly skips.
      for (const stage of [
        { track: "delivery", name: "prd_extract", artifact: renderRequirementDoc(cr) },
        { track: "scope", name: "scope_extract", artifact: renderScopeNote(cr) },
      ]) {
        await c.query(
          `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'done', $6, NULL, $7)`,
          [newId(), tenantId, runId, stage.track, stage.name, stage.artifact, config.originSite],
        );
      }
      // The delivery-track CLIENT `prd_sign` gate — an ordinary `pipeline_gates` row in openGate's
      // shape (run-level, so `stage_id` is NULL, exactly as the fanout leaves it). This substitutes
      // the dispatcher step that opens it for meeting-born runs; triage already served as the internal
      // review beat (§2.1). NOTHING ELSE IS PRE-SEEDED: the client `scope_signoff` gate is opened by
      // the shipped `pipeline-fanout` workflow off the event emitted below, and the hard build gate
      // must be satisfied by REAL client signatures, never by pre-seeded rows that would forge what a
      // client agreed to.
      const gateId = newId();
      await c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, stage_id, kind, actor_side, note, opened_by, origin_site)
         VALUES ($1, $2, $3, NULL, 'prd_sign', 'client', $4, $5, $6)`,
        [gateId, tenantId, runId, "Requirement doc ready for your signature", req.principal.userId, config.originSite],
      );
      await c.query(
        `UPDATE webdev_change_requests
            SET status = 'in_progress', route = 'mini_run', pipeline_run_id = $2, kind = $4,
                severity = $5,
                triaged_by = $3, triaged_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'new' AND deleted_at IS NULL`,
        [id, runId, req.principal.userId, kind, severityToWrite],
      );
      // ⚠ THE ZERO-SPECIAL-CASING LINE (§3.1 step 5). The shipped `pipeline-fanout` n8n workflow
      // triggers on exactly this event (automation/workflows/pipeline-fanout.json:11) and opens the
      // client `scope_signoff` gate + notifies the PM itself. Payload shape is byte-parity with
      // `createRun`'s emit (pipeline.controller.ts:222) — same three keys, `sourceMeetingId` honestly
      // null — so a mini-run is indistinguishable from a meeting-born run to every downstream
      // consumer. Test-pinned in webdev-change-requests.test.ts by comparing the key sets of the two
      // emits, because "it looks the same" is not a guarantee anyone can rely on later.
      await emitEvent(c, tenantId, "pipeline_run", runId, "pipeline.run.created", {
        sourceMeetingId: null, title: cr.title, actorId: req.principal.userId,
      });
      // Gate-open parity with openGate: the same event that surface emits, so anything watching for a
      // gate to open sees this one too.
      await emitEvent(c, tenantId, "pipeline_gate", gateId, "pipeline.gate.opened", {
        runId, kind: "prd_sign", actorSide: "client",
      });
      await emitEvent(c, tenantId, "webdev_change_request", id, "webdev.change_request.updated", {
        status: "in_progress", route: "mini_run", pipelineRunId: runId, kind, actorId: req.principal.userId,
      });
      const clientRecipients = await dispositionClientRecipients(c, cr);
      // §5.3 row 3 — the `prd_sign` open reaches SIGNERS ONLY. The design calls this "already shipped,
      // nothing to build", which is true only when `openGate` is what opens the gate; this path writes
      // the gate row directly (it is inside the spawner's transaction), so the signers-only notify is
      // resolved here and sent after commit. A viewer contact must NOT be asked to sign.
      const signers = await resolveClientRecipients(c, {
        clientId: cr.client_id, projectId: cr.project_id, kind: "signature",
      });
      return {
        outcome: "converted" as const, route: "mini_run" as const, kind, runId, gateId,
        recipients: recipientsFor(cr.requested_by, clientRecipients),
        signers,
      };
    });

    if (result.outcome === "not_found") throw new NotFoundException("change request not found");
    if (result.outcome === "already_triaged") {
      // The loser of a race (or a retry, or a double-click) gets the EXISTING artifact, not a twin and
      // not a bare error: `existing` rides the response so the caller can navigate to the run/task
      // that already exists. HttpErrorFilter forwards this field (see its header) — without that, the
      // filter's `{error}` reshape would have silently dropped it and the AC would be unverifiable.
      throw new ConflictException({
        message: `change request already triaged (status ${result.existing.status})`,
        existing: result.existing,
      });
    }

    if (result.outcome === "declined") {
      await writeActivity(tenantId, req.principal.userId, "declined", "webdev_change_request", id, {
        kind: result.kind, reason,
      });
      // Best-effort, AFTER commit: a notify() failure must never roll back a recorded decision
      // (client-notify.ts:63–68).
      await notifyBestEffort(tenantId, req.principal.userId, result.recipients, "webdev.change_request.declined", {
        title: "Your change request was declined",
        body: reason ?? undefined,
        href: "/portal/requests",
        entityType: "webdev_change_request",
        entityId: id,
        severity: "warning",
      });
      return { id, status: "declined", route: null };
    }

    // ---- converted ----
    await writeActivity(tenantId, req.principal.userId, "converted", "webdev_change_request", id, {
      kind: result.kind, route: result.route,
      ...(result.route === "mini_run" ? { pipelineRunId: result.runId } : { pmTaskId: result.pmTaskId }),
    });
    await notifyBestEffort(tenantId, req.principal.userId, result.recipients, "webdev.change_request.converted", {
      title: "Your change request is now in progress",
      href: result.route === "mini_run" ? `/portal/approvals/${result.runId}` : "/portal/requests",
      entityType: "webdev_change_request",
      entityId: id,
      severity: "info",
    });
    if (result.route === "mini_run" && result.signers.length) {
      await notifyBestEffort(tenantId, req.principal.userId, result.signers, "pipeline.gate.opened", {
        title: "Your signature is needed on the PRD",
        href: `/portal/approvals/${result.runId}`,
        entityType: "pipeline_gate",
        entityId: result.gateId,
        severity: "warning",
      });
    }
    return result.route === "mini_run"
      ? { id, status: "in_progress", route: "mini_run", pipelineRunId: result.runId }
      : { id, status: "in_progress", route: "pm_task", pmTaskId: result.pmTaskId };
  }
}

/** The requester plus every active contact in scope, de-duplicated (§5.3 row 2). The requester is
 *  listed explicitly rather than assumed to fall out of `resolveClientRecipients`: a contact scoped to
 *  a DIFFERENT project of the same client is correctly excluded from the scope query, and a person who
 *  raised the request must still hear its outcome. `notify()` skips self and non-members, so a staff
 *  member's own internal request quietly resolves to nobody. */
function recipientsFor(requestedBy: string | null, clientRecipients: string[]): string[] {
  return [...new Set([...(requestedBy ? [requestedBy] : []), ...clientRecipients])];
}

/** The DISPOSITION audience (declined / converted) — the client's contacts, but ONLY for a request the
 *  client actually raised.
 *
 *  F1, ruled 2026-08-08. `source='internal'` rows are staff-raised work that merely NAMES a client;
 *  nobody client-side asked for it. Resolving the general audience on `client_id` alone told those
 *  contacts "Your change request was declined" and handed them the staff `reason` VERBATIM — internal
 *  commentary delivered to the customer. `createInternal` already reasons its way to the opposite
 *  conclusion for the submit event ("notifying the client's project owners about internal work would be
 *  the notification storm..."); the disposition path simply never applied the same rule, because
 *  `resolveClientRecipients` keys on `client_id` and never sees `source`. Design §5.3 row 2 is silent
 *  on internal rows because it was written about the portal flow.
 *
 *  ⚠️ SCOPE OF THIS RULE — it is about AUTHORSHIP, not about the client's stake in the work. It gates
 *  only `kind:'general'` disposition messages. The `kind:'signature'` audience on the mini_run path is
 *  deliberately NOT gated: a mini-run spawned from internal work still opens a real `prd_sign` gate the
 *  client must actually sign, and suppressing that would strand the run exactly the way the client
 *  portal's own "waiting on client" failure did. Silence about our internal notes, never silence about
 *  a signature we are waiting on. */
async function dispositionClientRecipients(
  c: PoolClient,
  cr: { source: string; client_id: string | null; project_id: string | null },
): Promise<string[]> {
  if (cr.source !== "portal") return [];
  return resolveClientRecipients(c, { clientId: cr.client_id, projectId: cr.project_id, kind: "general" });
}

/** `userId` if they are an active staff member of the tenant this connection is scoped to, else null.
 *  The read goes through the TENANT-SCOPED connection, so a user of another tenant matches zero rows
 *  (an FK check would not have caught that — FK checks run as the table owner, outside RLS, and are
 *  not a tenancy control: pipeline.controller.ts:139–140 makes the same point). */
async function staffMemberOrNull(c: PoolClient, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const r = await c.query(
    `SELECT 1 FROM company_memberships
      WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    [userId],
  );
  return r.rowCount ? userId : null;
}
