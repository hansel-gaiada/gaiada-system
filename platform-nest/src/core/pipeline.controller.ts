// WS11 §4B — meeting-to-delivery pipeline state surface. The n8n workflows own orchestration and
// call these endpoints (via mcp-hub `pipeline.*` tools, OBO) to create runs, advance stages, and open
// human gates; humans decide gates from the ADNARA ERP inbox (and, later, the client portal). Every
// state change that a workflow must react to emits an event (`pipeline.*` / `scope.signed`) in the SAME
// transaction as the write — the event->n8n bridge resumes the waiting workflow. Backbone rule holds:
// no business logic lives in n8n; the durable state + its transitions live here.
//
// Auth mirrors the automation-approvals surface: automation accounts (member/manager) create + advance;
// elevated humans read; company_admin/group_executive decide/sign. Client-originated decisions
// (prd_sign, customer_feedback, scope) arrive through the portal BFF in WS11 build item 4.
import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { lockPipelineRun } from "./pipeline-lock";
import { clientNotifyKindForGate, notifyBestEffort, notifyScopeSignedBothSides, resolveClientRecipients } from "./client-notify";

const TRACKS = new Set(["delivery", "report", "scope"]);
const RUN_STATUS = new Set(["extracting", "delivery_active", "report_done", "scope_pending", "complete", "blocked"]);
const STAGE_STATUS = new Set(["pending", "running", "awaiting_gate", "done", "failed"]);
const GATE_KINDS = new Set(["prd_review", "prd_sign", "pm_review", "customer_feedback", "pm_approval", "scope_signoff"]);
const ACTOR_SIDES = new Set(["internal", "client"]);
const DECISIONS = new Set(["approved", "changes_requested", "rejected", "signed"]);
const REQUIRED_SCOPE_PARTIES = ["provider", "client"] as const;

// WD-03 (D-3, webdev-design.md §07/§14) — a stage's CLIENT sign gate, keyed by track. No FK links a
// gate to a stage today: pipeline_gates.stage_id is optional and, in the shipped fan-out workflow,
// is always left null (verified against the live "Acme Coffee kickoff" run — see WD-03 evidence).
// Gates are therefore matched to the stage(s) whose artifact they govern by (run_id, track), the
// SAME convention PortalController.currentBlockage() already uses to word "waiting on your PRD
// signature" / "waiting on your Scope signature". `report` deliberately has no entry: the report
// artifact is internal-only (§07 — no client ever signs it), so it can never lock under D-3.
const CLIENT_SIGN_GATE_KIND_BY_TRACK: Partial<Record<string, string[]>> = {
  delivery: ["prd_sign", "customer_feedback"],
  scope: ["scope_signoff"],
};

// D-3 — the notification title shown to a client contact when a client-actionable gate opens on
// their run. Deliberately NOT sent for a stage artifact simply landing (e.g. a stage flipping to
// 'done' with a fresh artifactRef): the gate that follows it is the actionable event, and a separate
// "your PRD draft is ready" notice ahead of "please sign your PRD" would be noise the client has to
// read twice for one decision — the owner's own "three notifications that matter, not six that get
// ignored" guidance. Falls back to a generic line for any client-side kind not listed (there is none
// today per CLIENT_SIGN_GATE_KIND_BY_TRACK, but a future kind must not silently notify with `undefined`).
const CLIENT_GATE_OPEN_TITLE: Partial<Record<string, string>> = {
  prd_sign: "Your signature is needed on the PRD",
  scope_signoff: "Your signature is needed on the Scope Agreement",
  customer_feedback: "We'd like your feedback",
};

// WD-29 (DEF-2) — stage IDENTITY classes. Read pipeline-lock.ts first for the defect and the lock
// scope; this is the other half of the fix (the precondition re-check the lock makes atomic).
//
// SINGLE_SHOT: names the state machine creates EXACTLY ONCE per run. `prd_extract`/`report_extract`/
// `scope_extract` are written once by `createRun` from the extraction flow; `claude_code`, `staging`
// and `production` are each guarded in `Load + decide` by a bare existence test (`!code`, `!staging`,
// `!prodStage`). Every one of those tests is a read-then-write window with the same shape as the
// observed `!design` race, so all six are guarded identically here. A second create is a stale-
// snapshot retrigger, never an intent — it resolves to the existing row.
const SINGLE_SHOT_STAGE_NAMES = new Set(["prd_extract", "report_extract", "scope_extract", "claude_code", "staging", "production"]);

// REVISABLE: `claude_design` is the ONE name that is legitimately repeated — WD-05's bounded revise
// loop creates a NEW design row per revision (WD-08 §1.6 proves a run correctly holding rev 1 + rev
// 2). So "more than one design exists" is NOT the defect signal and must never be treated as one; a
// blanket uniqueness rule on this name would break the revise loop, which is precisely why the
// partial unique index in migration 0052 deliberately does NOT cover it.
//
// What separates a legitimate revision from a raced duplicate is CAUSAL, not structural: a revision
// is only justified by a fresh `changes_requested` on the CURRENT head design. That is exactly the
// precondition `Load + decide` itself evaluates —
//   `cfd = gof('customer_feedback', design.id); ... cfd.decision === 'changes_requested' -> revise_design`
// — so this re-asserts the workflow's own rule server-side, where it can be evaluated under the run
// lock instead of against a snapshot read seconds earlier in n8n:
//   - no design yet                                   -> allow (the initial `release_design`)
//   - head design HAS a decided changes_requested cfd -> allow (a genuine revision; that gate is
//     attached to the head design, so the next revision needs its OWN new changes_requested)
//   - anything else                                   -> SUPPRESS: the workflow would not have
//     chosen to create a design in this state, so this caller is acting on a consumed snapshot.
// Note the loser is resolved to the CURRENT HEAD design, not to its own would-be row: `Load + decide`
// always operates on `designs[designs.length - 1]`, so the head is the row the pipeline continues
// with, and pointing the loser at it keeps its follow-up gate-open on the live lineage (where
// `openGate`'s own duplicate-pending guard then absorbs it).
const REVISABLE_STAGE_NAME = "claude_design";

/** WD-29: decide whether a stage create is a genuine transition or a raced/stale-snapshot repeat.
 *  MUST be called with the run's advisory lock already held (see lockPipelineRun) — evaluated
 *  without it, both racers pass and the duplicate survives.
 *  Returns the existing row's id when the create should be suppressed, else null. */
async function existingStageForRepeatedCreate(
  c: PoolClient,
  runId: string,
  track: string,
  name: string,
): Promise<string | null> {
  if (SINGLE_SHOT_STAGE_NAMES.has(name)) {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM pipeline_stages WHERE run_id = $1 AND track = $2 AND name = $3
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [runId, track, name],
    );
    return existing.rows[0]?.id ?? null;
  }
  if (name === REVISABLE_STAGE_NAME) {
    const head = await c.query<{ id: string }>(
      `SELECT id FROM pipeline_stages WHERE run_id = $1 AND track = $2 AND name = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [runId, track, name],
    );
    const headId = head.rows[0]?.id;
    if (!headId) return null; // no design yet -> the initial release is always allowed
    const revisionJustified = await c.query(
      `SELECT 1 FROM pipeline_gates
       WHERE run_id = $1 AND stage_id = $2 AND kind = 'customer_feedback'
         AND status = 'decided' AND decision = 'changes_requested' AND deleted_at IS NULL LIMIT 1`,
      [runId, headId],
    );
    return revisionJustified.rows[0] ? null : headId;
  }
  return null; // an unrecognised (human-authored) stage name is never auto-deduped
}

@Controller("api")
@UseGuards(AuthGuard)
export class PipelineController {
  // ---- Runs ----
  /** Validate a proposed run owner. Returns the id, or throws.
   *
   *  The owner must be STAFF of this tenant — a `company_memberships` row — and deliberately NOT a
   *  client contact. `owner_id` is who INTERNAL notifications are addressed to (client-notify.ts
   *  resolves "owner_id, else created_by" for the internal side), so accepting a client contact here
   *  would quietly route internal-side messages to the client. Membership is also what makes the
   *  notification deliverable at all.
   *
   *  Read through the tenant-scoped connection, so a userId from another tenant matches zero rows and
   *  is refused rather than being accepted by an FK check — FK checks run as the table owner, OUTSIDE
   *  RLS, and are not a tenancy control. */
  private async assertOwnerIsStaff(c: PoolClient, ownerId: string): Promise<string> {
    const r = await c.query(
      `SELECT 1 FROM company_memberships
        WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
      [ownerId],
    );
    if (!r.rowCount) throw new BadRequestException("ownerId must be an active staff member of this tenant");
    return ownerId;
  }

  @Post(":tenantId/pipeline/runs")
  @HttpCode(201)
  async createRun(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { sourceMeetingId?: string; title?: string; momRef?: string; status?: string; clientId?: string; projectId?: string; ownerId?: string; stages?: Array<{ track?: string; name?: string; status?: string; artifactRef?: string; confidence?: number }> },
  ) {
    const { sourceMeetingId, title, momRef, status = "extracting", clientId, projectId, ownerId, stages = [] } = body ?? {};
    if (!RUN_STATUS.has(status)) throw new BadRequestException("invalid run status");
    for (const s of stages) {
      if (!s.track || !TRACKS.has(s.track)) throw new BadRequestException("stage.track must be delivery|report|scope");
      if (!s.name) throw new BadRequestException("stage.name required");
      if (s.status !== undefined && !STAGE_STATUS.has(s.status)) throw new BadRequestException("invalid stage status");
    }
    await authorize(req.principal, { kind: "pipeline_run", tenantId }, "create");
    return withTenants([tenantId], async (c) => {
      // Dedupe on the bot's meeting id (the dispatcher also dedupes; this is the durable backstop).
      if (sourceMeetingId) {
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM pipeline_runs WHERE source_meeting_id = $1 AND deleted_at IS NULL`,
          [sourceMeetingId],
        );
        if (existing.rows[0]) return { id: existing.rows[0].id, deduped: true };
      }
      // WD-30: inherit client/project from the source meeting when the caller did not say.
      //
      // `createRun` has always ACCEPTED clientId/projectId, and the n8n extraction flow has never
      // passed them — so every run on gda-aicenter carried `client_id = NULL` (verified live: 5 of 5).
      // That made the client portal structurally blind: `/portal/runs` filters by the caller's client
      // ids, so it returned `[]` for a correctly-authorized contact and no amount of fixing invites,
      // roles or Cerbos could ever have populated it. The recording ALREADY knows its client and
      // project; only the hand-off dropped them.
      //
      // Derived here rather than by editing the workflow, because the workflow is an external artifact
      // that can be re-imported or edited in the n8n UI, and a contract this load-bearing should not
      // depend on every caller remembering. An explicit value in the body still WINS — this only fills
      // a gap, so a caller deliberately creating an unattached run keeps that ability.
      let derivedClientId = clientId ?? null;
      let derivedProjectId = projectId ?? null;
      if (sourceMeetingId && (derivedClientId === null || derivedProjectId === null)) {
        const src = await c.query<{ client_id: string | null; project_id: string | null }>(
          `SELECT client_id, project_id FROM meeting_recordings
            WHERE meeting_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [sourceMeetingId],
        );
        if (src.rows[0]) {
          derivedClientId = derivedClientId ?? src.rows[0].client_id;
          derivedProjectId = derivedProjectId ?? src.rows[0].project_id;
        }
      }
      const id = newId();
      await c.query(
        `INSERT INTO pipeline_runs (id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, project_id, owner_id, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, tenantId, sourceMeetingId ?? null, title ?? null, momRef ?? null, status, derivedClientId, derivedProjectId, ownerId ? await this.assertOwnerIsStaff(c, ownerId) : null, req.principal.userId, config.originSite],
      );
      for (const s of stages) {
        // WD-29: the same identity guard as createStage. No lock is needed here (the run id was just
        // minted, so no concurrent transaction can address this run yet), but the guard still matters:
        // it sees rows inserted by EARLIER iterations of this very loop, so a caller that passes the
        // same single-shot stage twice in one payload resolves to one row instead of hitting migration
        // 0052's unique index as a 500. This is the only other INSERT into pipeline_stages.
        const existingId = await existingStageForRepeatedCreate(c, id, s.track!, s.name!);
        if (existingId) continue;
        await c.query(
          `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newId(), tenantId, id, s.track, s.name, s.status ?? "pending", s.artifactRef ?? null, s.confidence ?? null, config.originSite],
        );
      }
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link (work-activity-linker.ts rule a).
      await emitEvent(c, tenantId, "pipeline_run", id, "pipeline.run.created", { sourceMeetingId: sourceMeetingId ?? null, title: title ?? null, actorId: req.principal.userId });
      return { id, deduped: false };
    });
  }

  // WD-05: the bounded revise loop's escalation path needs to durably PARK a run once the
  // revise budget (N=3) is exhausted, so a later unrelated gate.decided/scope.signed retrigger
  // does not keep re-evaluating (and re-escalating) it. `status` is the only field this endpoint
  // owns — stage/gate transitions stay on their own PATCH surfaces.
  @Patch(":tenantId/pipeline/runs/:runId")
  async updateRun(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
    @Body() body: { status?: string; ownerId?: string | null },
  ) {
    if (body?.status !== undefined && !RUN_STATUS.has(body.status)) throw new BadRequestException("invalid run status");
    await authorize(req.principal, { kind: "pipeline_run", id: runId, tenantId }, "update");
    const updated = await withTenants([tenantId], async (c) => {
      // WD-29: WD-05's escalation parks the run 'blocked' HERE, and `Load + decide` short-circuits on
      // `run.status === 'blocked'`. That makes this write part of the same state machine, so it takes
      // the same run lock: a park must not interleave with a concurrent decider that already read the
      // run as un-parked and is about to create another design behind it.
      await lockPipelineRun(c, runId);
      // `ownerId` joins `status` on this surface. WD-05's note said status was "the only field this
      // endpoint owns", meaning stage/gate TRANSITIONS live on their own surfaces — run ownership is
      // not a transition, it is a property of the run, so it belongs here rather than needing a third
      // endpoint. Explicit `null` CLEARS the owner (unassign); omitting the key leaves it untouched,
      // which is why this cannot be a bare COALESCE.
      const ownerProvided = body !== undefined && body !== null && Object.prototype.hasOwnProperty.call(body, "ownerId");
      const ownerValue = ownerProvided && body.ownerId ? await this.assertOwnerIsStaff(c, body.ownerId) : null;
      const res = await c.query<{ status: string; owner_id: string | null }>(
        `UPDATE pipeline_runs
            SET status = COALESCE($2, status),
                owner_id = CASE WHEN $4::boolean THEN $3::uuid ELSE owner_id END,
                updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING status, owner_id`,
        [runId, body?.status ?? null, ownerValue, ownerProvided],
      );
      if (res.rowCount === 0) return null;
      // TR-31: actorId -> work_activity.actor_user_id + an EXACT person link.
      await emitEvent(c, tenantId, "pipeline_run", runId, "pipeline.run.updated", { status: res.rows[0].status, ownerId: res.rows[0].owner_id, actorId: req.principal.userId });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("run not found");
    await writeActivity(tenantId, req.principal.userId, "updated", "pipeline_run", runId, { status: updated.status });
    return { id: runId, status: updated.status };
  }

  @Get(":tenantId/pipeline/runs")
  async listRuns(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    // E1 follow-up: a narrow additive filter so the hub's read-only `pipeline.runBySourceMeeting`
    // tool can resolve the authoritative pipeline_runs.source_meeting_id link (the same column
    // pipeline.createRun's own dedupe SELECT already uses, and the same unique index —
    // pipeline_runs_meeting_idx from migration 0017 — so this is an indexed lookup, not a scan).
    // No schema change, no new authz surface: still gated by the existing "read" action below.
    @Query("sourceMeetingId") sourceMeetingId?: string,
  ) {
    await authorize(req.principal, { kind: "pipeline_run", tenantId }, "read");
    const conditions = ["deleted_at IS NULL"];
    const params: string[] = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (sourceMeetingId) { params.push(sourceMeetingId); conditions.push(`source_meeting_id = $${params.length}`); }
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        // C4/C6: client_id + project_id are selected here so the list can show WHOSE work a run is and
        // link to it. Their absence is why `lib/pipeline.ts` had to cross-reference the recordings
        // registry to render a client column, and why run->project navigation did not exist at all.
        `SELECT id, source_meeting_id, title, mom_ref, status, client_id, project_id, owner_id,
                created_by, created_at, updated_at
         FROM pipeline_runs WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT 200`,
        params,
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/pipeline/runs/:runId")
  async getRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    await authorize(req.principal, { kind: "pipeline_run", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const run = await c.query(
        // C6: project_id added so the run workspace can link to the project this delivery belongs to.
        `SELECT id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, project_id, owner_id,
                created_by, created_at, updated_at
         FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`,
        [runId],
      );
      if (!run.rows[0]) throw new NotFoundException("run not found");
      const stages = await c.query(
        `SELECT id, track, name, status, artifact_ref, confidence, updated_at FROM pipeline_stages
         WHERE run_id = $1 ORDER BY created_at ASC`,
        [runId],
      );
      const gates = await c.query(
        `SELECT id, stage_id, kind, actor_side, status, decision, note, decided_by, decided_at, created_at
         FROM pipeline_gates WHERE run_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [runId],
      );
      const signoffs = await c.query(
        `SELECT party, signer, signer_name, signed_at FROM scope_signoffs WHERE run_id = $1 ORDER BY signed_at ASC`,
        [runId],
      );
      return { ...run.rows[0], stages: stages.rows, gates: gates.rows, scopeSignoffs: signoffs.rows };
    });
  }

  // ---- Stages ----
  @Post(":tenantId/pipeline/runs/:runId/stages")
  @HttpCode(201)
  async createStage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
    @Body() body: { track?: string; name?: string; status?: string; artifactRef?: string; confidence?: number },
  ) {
    const { track, name, status = "pending", artifactRef, confidence } = body ?? {};
    if (!track || !TRACKS.has(track)) throw new BadRequestException("track must be delivery|report|scope");
    if (!name) throw new BadRequestException("name required");
    if (!STAGE_STATUS.has(status)) throw new BadRequestException("invalid stage status");
    await authorize(req.principal, { kind: "pipeline_stage", tenantId }, "create");
    const id = newId();
    // WD-29 (DEF-2): the run lock is taken BEFORE the existence/precondition read, so this handler's
    // read-then-insert is atomic against a concurrent decider acting on the same run. Without the
    // lock the two racers interleave between the SELECT and the INSERT and both insert.
    const created = await withTenants([tenantId], async (c) => {
      await lockPipelineRun(c, runId);
      const run = await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId]);
      if (!run.rows[0]) throw new NotFoundException("run not found");
      const existingId = await existingStageForRepeatedCreate(c, runId, track, name);
      if (existingId) return { id: existingId, deduped: true as const };
      await c.query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, runId, track, name, status, artifactRef ?? null, confidence ?? null, config.originSite],
      );
      return { id, deduped: false as const };
    });
    // `deduped` mirrors createRun's existing shape: the caller (an n8n node) gets a usable stage id
    // either way and stays on the live lineage, so a suppressed duplicate is a no-op, not an error
    // the workflow would have to handle. Deliberately still 201 — same as createRun's dedupe branch.
    return created.deduped ? { id: created.id, deduped: true } : { id: created.id };
  }

  // WD-03 (D-3): this PATCH now carries two kinds of caller — automation advancing stage status
  // (`pending -> running -> awaiting_gate -> done`), and a human editing the drafted artifact text
  // in the run workspace. Only the SECOND kind is subject to the signature lock: `body.artifactRef`
  // present is what marks a call as an "artifact edit" (vs. a bare status/confidence transition).
  // The lock itself is deliberately ONE condition (client sign gate decided), not two — see the
  // CLIENT_SIGN_GATE_KIND_BY_TRACK comment + WD-03 evidence for why "stage.status === 'done'" is NOT
  // also an OR-trigger here: extraction lands every stage at 'done' the instant its content exists,
  // long before any client has seen a sign gate, so locking on 'done' would make "editable until
  // signed" (D-3's entire point) unreachable for every ingested run — falsified directly against the
  // live "Acme Coffee kickoff" run this ticket tests against (all 3 stages already 'done').
  @Patch(":tenantId/pipeline/stages/:id")
  async updateStage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { status?: string; artifactRef?: string; confidence?: number },
  ) {
    if (body?.status !== undefined && !STAGE_STATUS.has(body.status)) throw new BadRequestException("invalid stage status");
    await authorize(req.principal, { kind: "pipeline_stage", id, tenantId }, "update");
    const editingArtifact = body?.artifactRef !== undefined;
    const result = await withTenants([tenantId], async (c) => {
      // WD-29: this handler is addressed by STAGE id, so the run key has to be read before the lock
      // can be taken. `pipeline_stages.run_id` is immutable, so that one read is safe stale; the
      // WD-03 signature-lock check below is then (re-)evaluated under the lock, which is what makes
      // "is this artifact already signed?" a decision that a concurrent gate-decide cannot slip past.
      const owner = await c.query<{ run_id: string }>(`SELECT run_id FROM pipeline_stages WHERE id = $1`, [id]);
      if (!owner.rows[0]) return { outcome: "not_found" as const };
      await lockPipelineRun(c, owner.rows[0].run_id);

      const stage = await c.query<{ run_id: string; track: string }>(
        `SELECT run_id, track FROM pipeline_stages WHERE id = $1`,
        [id],
      );
      if (!stage.rows[0]) return { outcome: "not_found" as const };
      const { run_id: runId, track } = stage.rows[0];

      if (editingArtifact) {
        const clientKinds = CLIENT_SIGN_GATE_KIND_BY_TRACK[track];
        if (clientKinds && clientKinds.length > 0) {
          const decided = await c.query(
            `SELECT 1 FROM pipeline_gates
             WHERE run_id = $1 AND actor_side = 'client' AND status = 'decided'
               AND kind = ANY($2) AND deleted_at IS NULL LIMIT 1`,
            [runId, clientKinds],
          );
          if (decided.rows[0]) return { outcome: "locked" as const };
        }
      }

      const res = await c.query<{ run_id: string; track: string; name: string; status: string }>(
        `UPDATE pipeline_stages SET
           status = COALESCE($2, status),
           artifact_ref = COALESCE($3, artifact_ref),
           confidence = COALESCE($4, confidence),
           updated_at = now()
         WHERE id = $1 RETURNING run_id, track, name, status`,
        [id, body?.status ?? null, body?.artifactRef ?? null, body?.confidence ?? null],
      );
      const row = res.rows[0];
      await emitEvent(c, tenantId, "pipeline_stage", id, "pipeline.stage.updated", {
        runId: row.run_id, track: row.track, name: row.name, status: row.status, artifactEdited: editingArtifact,
      });
      return { outcome: "ok" as const, row };
    });
    if (result.outcome === "not_found") throw new NotFoundException("stage not found");
    if (result.outcome === "locked") {
      throw new ConflictException("artifact is locked — the client has already signed this stage");
    }
    // Edit provenance (WD-03 AC): every successful PATCH — status transition or artifact edit —
    // gets a writeActivity row, same pattern as the rest of this controller's write paths.
    await writeActivity(tenantId, req.principal.userId, editingArtifact ? "edited" : "updated", "pipeline_stage", id, {
      runId: result.row.run_id, track: result.row.track, name: result.row.name, status: result.row.status, artifactEdited: editingArtifact,
    });
    return { id, status: result.row.status };
  }

  // ---- Gates (human-in-the-loop) ----
  @Post(":tenantId/pipeline/gates")
  @HttpCode(201)
  async openGate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { runId?: string; stageId?: string; kind?: string; actorSide?: string; note?: string },
  ) {
    const { runId, stageId, kind, actorSide, note } = body ?? {};
    if (!runId) throw new BadRequestException("runId required");
    if (!kind || !GATE_KINDS.has(kind)) throw new BadRequestException("invalid gate kind");
    if (!actorSide || !ACTOR_SIDES.has(actorSide)) throw new BadRequestException("actorSide must be internal|client");
    await authorize(req.principal, { kind: "pipeline_gate", tenantId }, "create");
    const id = newId();
    const opened = await withTenants([tenantId], async (c) => {
      await lockPipelineRun(c, runId);
      const run = await c.query<{ client_id: string | null; project_id: string | null }>(
        `SELECT client_id, project_id FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId],
      );
      if (!run.rows[0]) throw new NotFoundException("run not found");
      // WD-29 (DEF-2): gate-opens race exactly like stage-creates — every `open_gate` branch in
      // `Load + decide` is guarded by a snapshot existence test (`!has('customer_feedback', design.id)`),
      // so two retriggers open the same beat twice. A duplicate PENDING gate is worse than cosmetic:
      // `gof()` resolves a beat by taking the LAST gate of that kind for the stage, so once a human
      // decides the older twin the newer one stays pending and the run STALLS at that beat forever.
      // Identity is (run, stage, kind, actor_side) among PENDING rows only — `IS NOT DISTINCT FROM`
      // because stage_id is legitimately NULL for run-level gates (prd_sign, scope_signoff), and NULL
      // = NULL must count as the same gate there. A DECIDED gate never suppresses a new one: the
      // revise loop reopens `pm_review` on each new revision, which is a different stage_id anyway.
      const dup = await c.query<{ id: string }>(
        `SELECT id FROM pipeline_gates
         WHERE run_id = $1 AND stage_id IS NOT DISTINCT FROM $2 AND kind = $3 AND actor_side = $4
           AND status = 'pending' AND deleted_at IS NULL
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [runId, stageId ?? null, kind, actorSide],
      );
      if (dup.rows[0]) return { id: dup.rows[0].id, deduped: true as const, recipients: [] as string[] };
      await c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, stage_id, kind, actor_side, note, opened_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, runId, stageId ?? null, kind, actorSide, note ?? null, req.principal.userId, config.originSite],
      );
      await emitEvent(c, tenantId, "pipeline_gate", id, "pipeline.gate.opened", { runId, kind, actorSide });
      // D-3: this is the "a client-actionable gate opens" trigger. Resolved on the SAME connection,
      // inside the transaction, because it is a plain read (no write) — the actual notify() calls are
      // deferred until after the transaction commits (see below), same as every other notify() call
      // site in this file's siblings (collab.controller.ts, client-contacts.controller.ts).
      const recipients = actorSide === "client"
        ? await resolveClientRecipients(c, { clientId: run.rows[0].client_id, projectId: run.rows[0].project_id, kind: clientNotifyKindForGate(kind) })
        : [];
      return { id, deduped: false as const, recipients };
    });
    // No activity row (and no event, above) for a suppressed duplicate — nothing was opened, and a
    // phantom "opened" would misreport the audit trail as if a second beat had really been created; the
    // client was already told about the original gate, so notifying again here would be a duplicate.
    if (opened.deduped) return { id: opened.id, status: "pending", deduped: true };
    await writeActivity(tenantId, req.principal.userId, "opened", "pipeline_gate", id, { runId, kind, actorSide });
    // Best-effort, AFTER the write stands: a notify() failure here must not turn a real gate-open into
    // a 500 the caller (an n8n workflow) might retry into a duplicate.
    if (opened.recipients.length) {
      await notifyBestEffort(tenantId, req.principal.userId, opened.recipients, "pipeline.gate.opened", {
        title: CLIENT_GATE_OPEN_TITLE[kind] ?? "Action needed on your project",
        href: "/portal",
        entityType: "pipeline_gate",
        entityId: id,
        severity: clientNotifyKindForGate(kind) === "signature" ? "warning" : "info",
      });
    }
    return { id, status: "pending" };
  }

  @Get(":tenantId/pipeline/gates")
  async listGates(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    @Query("actorSide") actorSide?: string,
    @Query("kind") kind?: string,
  ) {
    await authorize(req.principal, { kind: "pipeline_gate", tenantId }, "read");
    const clauses: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    // Default to the pending inbox, like the approvals surface.
    clauses.push(`status = $${args.push(status ?? "pending")}`);
    if (actorSide) clauses.push(`actor_side = $${args.push(actorSide)}`);
    if (kind) clauses.push(`kind = $${args.push(kind)}`);
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, run_id, stage_id, kind, actor_side, status, decision, note, opened_by, decided_by, decided_at, created_at
         FROM pipeline_gates WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
        args,
      ),
    );
    return rows.rows;
  }

  @Post(":tenantId/pipeline/gates/:id/decide")
  @HttpCode(200)
  async decideGate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { decision?: string; note?: string },
  ) {
    const { decision, note } = body ?? {};
    if (!decision || !DECISIONS.has(decision)) throw new BadRequestException("decision must be approved|changes_requested|rejected|signed");
    await authorize(req.principal, { kind: "pipeline_gate", id, tenantId }, "decide");
    const decided = await withTenants([tenantId], async (c) => {
      // WD-29: addressed by GATE id, so read the (immutable) run key first, then lock, then run the
      // original UPDATE unchanged. The UPDATE's own `status = 'pending'` predicate stays the
      // authoritative guard — re-evaluated under the lock now, so two concurrent deciders on one gate
      // resolve to exactly one winner and the loser still gets the existing "already decided" 404.
      const owner = await c.query<{ run_id: string }>(
        `SELECT run_id FROM pipeline_gates WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!owner.rows[0]) return null;
      await lockPipelineRun(c, owner.rows[0].run_id);
      const res = await c.query<{ run_id: string; kind: string; actor_side: string }>(
        `UPDATE pipeline_gates SET status = 'decided', decision = $2, note = COALESCE($3, note),
           decided_by = $4, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING run_id, kind, actor_side`,
        [id, decision, note ?? null, req.principal.userId],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      await emitEvent(c, tenantId, "pipeline_gate", id, "pipeline.gate.decided", {
        runId: row.run_id, kind: row.kind, actorSide: row.actor_side, decision,
      });
      return row;
    });
    if (!decided) throw new NotFoundException("gate not found or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "pipeline_gate", id, { runId: decided.run_id, kind: decided.kind });
    return { id, status: "decided", decision };
  }

  // ---- Scope sign-off (dual-party) ----
  @Post(":tenantId/pipeline/runs/:runId/scope-signoffs")
  @HttpCode(201)
  async recordScopeSignoff(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
    @Body() body: { party?: string; gateId?: string; signerName?: string; signatureRef?: string },
  ) {
    const { party, gateId, signerName, signatureRef } = body ?? {};
    if (!party) throw new BadRequestException("party required");
    // VALIDATE against the required set, not merely for truthiness. Found the hard way during a live
    // server walk: `{party:"agency"}` was accepted, stored, and returned `complete:false` — which
    // looked exactly like "correctly waiting on the client" while actually recording a signature that
    // can NEVER satisfy `REQUIRED_SCOPE_PARTIES.every(...)`. A typo'd or well-meant-but-wrong party
    // silently produces a run that can never complete its scope agreement, and nothing anywhere says
    // so. The unique index is on (run_id, party), so the junk row also permanently occupies a slot.
    if (!(REQUIRED_SCOPE_PARTIES as readonly string[]).includes(party)) {
      throw new BadRequestException(`party must be one of ${REQUIRED_SCOPE_PARTIES.join("|")}`);
    }
    await authorize(req.principal, { kind: "scope_signoff", tenantId }, "create");
    const result = await withTenants([tenantId], async (c) => {
      // WD-29: `scope.signed` is one of DEF-2's two triggering events, and this handler decides
      // whether to emit it by COUNTING the parties it just read — a textbook read-then-write window.
      // Under the run lock, two parties signing simultaneously can no longer both observe
      // "complete" and emit `scope.signed` twice (which would start two delivery executions from a
      // single sign-off, the exact fan-out that produced the duplicate design stages).
      await lockPipelineRun(c, runId);
      const run = await c.query<{ client_id: string | null; project_id: string | null; owner_id: string | null; created_by: string | null }>(
        `SELECT client_id, project_id, owner_id, created_by FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId],
      );
      if (!run.rows[0]) throw new NotFoundException("run not found");
      // One signature per party (unique (run_id, party)); a re-file is a no-op, not a 500.
      const ins = await c.query(
        `INSERT INTO scope_signoffs (id, tenant_id, run_id, gate_id, party, signer, signer_name, signature_ref, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (run_id, party) DO NOTHING`,
        [newId(), tenantId, runId, gateId ?? null, party, req.principal.userId, signerName ?? null, signatureRef ?? null, config.originSite],
      );
      const parties = await c.query<{ party: string }>(`SELECT party FROM scope_signoffs WHERE run_id = $1`, [runId]);
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = REQUIRED_SCOPE_PARTIES.every((p) => have.has(p));
      // WD-29: emit on the TRANSITION to complete, not on every call made while complete. The
      // ON CONFLICT above makes a re-filed signature a row-level no-op, but the old code still
      // recomputed `complete` and re-emitted `scope.signed` — so re-signing an already-complete run
      // started a fresh delivery execution from nothing, feeding DEF-2's fan-out. `rowCount === 0`
      // means this party had already signed, so nothing transitioned and there is nothing to announce.
      // The response still reports the true current `complete`/`parties`, unchanged.
      const justCompleted = complete && ins.rowCount === 1;
      if (justCompleted) {
        // Both parties signed: close the linked scope gate (if any) and announce it for the delivery
        // track's hard gate (which waits on prd_sign AND scope.signed).
        if (gateId) {
          await c.query(
            `UPDATE pipeline_gates SET status = 'decided', decision = 'signed', decided_by = $2, decided_at = now(), updated_at = now()
             WHERE id = $1 AND run_id = $3 AND status = 'pending' AND deleted_at IS NULL`,
            [gateId, req.principal.userId, runId],
          );
        }
        await emitEvent(c, tenantId, "scope", runId, "scope.signed", { runId, parties: [...have] });
      }
      // D-3: "scope.signed completes (both parties) -> notify both sides." Resolved on the same
      // connection as the write, inside the transaction (a plain read); the notify() calls themselves
      // are deferred until after the transaction commits, below.
      const internalRecipient = justCompleted ? (run.rows[0].owner_id ?? run.rows[0].created_by) : null;
      const clientRecipients = justCompleted
        ? await resolveClientRecipients(c, { clientId: run.rows[0].client_id, projectId: run.rows[0].project_id, kind: "general" })
        : [];
      return { complete, parties: [...have], internalRecipient, clientRecipients };
    });
    await writeActivity(tenantId, req.principal.userId, "signed", "scope_signoff", runId, { party });
    // Best-effort, AFTER the write stands (see client-notify.ts's notifyScopeSignedBothSides doc).
    await notifyScopeSignedBothSides(tenantId, req.principal.userId, runId, result.internalRecipient, result.clientRecipients);
    return { runId, party, complete: result.complete, parties: result.parties };
  }
}
