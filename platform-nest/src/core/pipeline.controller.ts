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
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const TRACKS = new Set(["delivery", "report", "scope"]);
const RUN_STATUS = new Set(["extracting", "delivery_active", "report_done", "scope_pending", "complete", "blocked"]);
const STAGE_STATUS = new Set(["pending", "running", "awaiting_gate", "done", "failed"]);
const GATE_KINDS = new Set(["prd_review", "prd_sign", "pm_review", "customer_feedback", "pm_approval", "scope_signoff"]);
const ACTOR_SIDES = new Set(["internal", "client"]);
const DECISIONS = new Set(["approved", "changes_requested", "rejected", "signed"]);
const REQUIRED_SCOPE_PARTIES = ["provider", "client"] as const;

@Controller("api")
@UseGuards(AuthGuard)
export class PipelineController {
  // ---- Runs ----
  @Post(":tenantId/pipeline/runs")
  @HttpCode(201)
  async createRun(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { sourceMeetingId?: string; title?: string; momRef?: string; status?: string; clientId?: string; stages?: Array<{ track?: string; name?: string; status?: string; artifactRef?: string; confidence?: number }> },
  ) {
    const { sourceMeetingId, title, momRef, status = "extracting", clientId, stages = [] } = body ?? {};
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
      const id = newId();
      await c.query(
        `INSERT INTO pipeline_runs (id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, sourceMeetingId ?? null, title ?? null, momRef ?? null, status, clientId ?? null, req.principal.userId, config.originSite],
      );
      for (const s of stages) {
        await c.query(
          `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [newId(), tenantId, id, s.track, s.name, s.status ?? "pending", s.artifactRef ?? null, s.confidence ?? null, config.originSite],
        );
      }
      await emitEvent(c, tenantId, "pipeline_run", id, "pipeline.run.created", { sourceMeetingId: sourceMeetingId ?? null, title: title ?? null });
      return { id, deduped: false };
    });
  }

  @Get(":tenantId/pipeline/runs")
  async listRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("status") status?: string) {
    await authorize(req.principal, { kind: "pipeline_run", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, source_meeting_id, title, mom_ref, status, created_by, created_at, updated_at
         FROM pipeline_runs WHERE deleted_at IS NULL ${status ? "AND status = $1" : ""}
         ORDER BY created_at DESC LIMIT 200`,
        status ? [status] : [],
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/pipeline/runs/:runId")
  async getRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    await authorize(req.principal, { kind: "pipeline_run", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const run = await c.query(
        `SELECT id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, created_by, created_at, updated_at
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
    await withTenants([tenantId], async (c) => {
      const run = await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId]);
      if (!run.rows[0]) throw new NotFoundException("run not found");
      await c.query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, runId, track, name, status, artifactRef ?? null, confidence ?? null, config.originSite],
      );
    });
    return { id };
  }

  @Patch(":tenantId/pipeline/stages/:id")
  async updateStage(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { status?: string; artifactRef?: string; confidence?: number },
  ) {
    if (body?.status !== undefined && !STAGE_STATUS.has(body.status)) throw new BadRequestException("invalid stage status");
    await authorize(req.principal, { kind: "pipeline_stage", id, tenantId }, "update");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<{ run_id: string; track: string; name: string; status: string }>(
        `UPDATE pipeline_stages SET
           status = COALESCE($2, status),
           artifact_ref = COALESCE($3, artifact_ref),
           confidence = COALESCE($4, confidence),
           updated_at = now()
         WHERE id = $1 RETURNING run_id, track, name, status`,
        [id, body?.status ?? null, body?.artifactRef ?? null, body?.confidence ?? null],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      await emitEvent(c, tenantId, "pipeline_stage", id, "pipeline.stage.updated", {
        runId: row.run_id, track: row.track, name: row.name, status: row.status,
      });
      return row;
    });
    if (!updated) throw new NotFoundException("stage not found");
    return { id, status: updated.status };
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
    await withTenants([tenantId], async (c) => {
      const run = await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId]);
      if (!run.rows[0]) throw new NotFoundException("run not found");
      await c.query(
        `INSERT INTO pipeline_gates (id, tenant_id, run_id, stage_id, kind, actor_side, note, opened_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, tenantId, runId, stageId ?? null, kind, actorSide, note ?? null, req.principal.userId, config.originSite],
      );
      await emitEvent(c, tenantId, "pipeline_gate", id, "pipeline.gate.opened", { runId, kind, actorSide });
    });
    await writeActivity(tenantId, req.principal.userId, "opened", "pipeline_gate", id, { runId, kind, actorSide });
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
    await authorize(req.principal, { kind: "scope_signoff", tenantId }, "create");
    const result = await withTenants([tenantId], async (c) => {
      const run = await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId]);
      if (!run.rows[0]) throw new NotFoundException("run not found");
      // One signature per party (unique (run_id, party)); a re-file is a no-op, not a 500.
      await c.query(
        `INSERT INTO scope_signoffs (id, tenant_id, run_id, gate_id, party, signer, signer_name, signature_ref, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (run_id, party) DO NOTHING`,
        [newId(), tenantId, runId, gateId ?? null, party, req.principal.userId, signerName ?? null, signatureRef ?? null, config.originSite],
      );
      const parties = await c.query<{ party: string }>(`SELECT party FROM scope_signoffs WHERE run_id = $1`, [runId]);
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = REQUIRED_SCOPE_PARTIES.every((p) => have.has(p));
      if (complete) {
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
      return { complete, parties: [...have] };
    });
    await writeActivity(tenantId, req.principal.userId, "signed", "scope_signoff", runId, { party });
    return { runId, party, ...result };
  }
}
