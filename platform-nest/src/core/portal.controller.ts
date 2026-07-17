// WS11 build item 4 — client portal BFF. The client-facing surface (transparency + the client's own
// sign-offs) is served here, SEPARATELY from the staff /api pipeline routes. A client authenticates
// via the external client Keycloak realm (OIDC), auto-provisioned as a users row with a `client` role
// scoped to the tenant, and linked to a clients row via clients.portal_user_id.
//
// Three isolation layers: RLS (tenant) + Cerbos (`client` role on `portal`) + this controller
// (run.client_id must map to the caller's client — the "owned by caller" pattern). A client sees only
// THEIR runs, the client-safe view (no internal report track, no internal gates, no PM notes), and a
// plain-language "current blockage". Client decisions flow through the SAME pipeline_gates state
// machine + events as staff decisions, so the waiting n8n workflow resumes identically.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import type { PoolClient } from "pg";

const CLIENT_DECISIONS = new Set(["signed", "approved", "changes_requested"]);
const REQUIRED_SCOPE_PARTIES = ["provider", "client"] as const;

/** Plain-language status the portal shows the client. Pending client gates win (they need the client). */
function currentBlockage(
  run: { status: string },
  stages: Array<{ status: string }>,
  clientGates: Array<{ kind: string; status: string }>,
): string {
  const pending = clientGates.find((g) => g.status === "pending");
  if (pending) {
    if (pending.kind === "prd_sign") return "Waiting for your signature on the PRD to proceed";
    if (pending.kind === "scope_signoff") return "Waiting for your signature on the Scope Agreement";
    if (pending.kind === "customer_feedback") return "Waiting for your feedback";
    return "Waiting for your input";
  }
  if (run.status === "blocked") return "On hold — our team will follow up with you";
  if (run.status === "complete") return "Delivered — nothing outstanding";
  if (stages.some((s) => s.status === "running" || s.status === "awaiting_gate")) return "In progress — our team is working on it";
  return "Up to date — nothing needed from you right now";
}

@Controller("api")
@UseGuards(AuthGuard)
export class PortalController {
  /** Resolve the caller's client row for this tenant, or 403 if they are not a portal client. */
  private async callerClientId(c: PoolClient, principal: { userId: string | null }): Promise<string> {
    if (!principal.userId) throw new ForbiddenException("not a portal client");
    const r = await c.query<{ id: string }>(
      `SELECT id FROM clients WHERE portal_user_id = $1 AND deleted_at IS NULL`,
      [principal.userId],
    );
    if (!r.rows[0]) throw new ForbiddenException("not a portal client");
    return r.rows[0].id;
  }

  @Get(":tenantId/portal/runs")
  async listRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const clientId = await this.callerClientId(c, req.principal);
      const runs = await c.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status, created_at FROM pipeline_runs
         WHERE client_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
        [clientId],
      );
      // Compute the blockage per run (client-side gates + non-report stages).
      const out = [];
      for (const run of runs.rows) {
        const stages = await c.query<{ status: string }>(
          `SELECT status FROM pipeline_stages WHERE run_id = $1 AND track <> 'report'`, [run.id],
        );
        const gates = await c.query<{ kind: string; status: string }>(
          `SELECT kind, status FROM pipeline_gates WHERE run_id = $1 AND actor_side = 'client' AND deleted_at IS NULL`, [run.id],
        );
        out.push({ id: run.id, title: run.title, status: run.status, currentBlockage: currentBlockage(run, stages.rows, gates.rows) });
      }
      return out;
    });
  }

  @Get(":tenantId/portal/runs/:runId")
  async getRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const clientId = await this.callerClientId(c, req.principal);
      const run = await c.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status, created_at FROM pipeline_runs WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
        [runId, clientId],
      );
      if (!run.rows[0]) throw new NotFoundException("run not found"); // also the isolation boundary
      // Client-safe stages: hide the internal report track.
      const stages = await c.query(
        `SELECT track, name, status, artifact_ref FROM pipeline_stages WHERE run_id = $1 AND track <> 'report' ORDER BY created_at ASC`,
        [runId],
      );
      // Only client-side gates are surfaced (internal review is abstracted into the blockage line).
      const gates = await c.query(
        `SELECT id, kind, status, decision, created_at FROM pipeline_gates
         WHERE run_id = $1 AND actor_side = 'client' AND deleted_at IS NULL ORDER BY created_at ASC`,
        [runId],
      );
      const signoffs = await c.query(
        `SELECT party, signer_name, signed_at FROM scope_signoffs WHERE run_id = $1 ORDER BY signed_at ASC`, [runId],
      );
      return {
        ...run.rows[0],
        currentBlockage: currentBlockage(run.rows[0], stages.rows as Array<{ status: string }>, gates.rows as Array<{ kind: string; status: string }>),
        stages: stages.rows,
        gates: gates.rows,
        scopeSignoffs: signoffs.rows,
      };
    });
  }

  @Post(":tenantId/portal/gates/:id/decide")
  @HttpCode(200)
  async decideGate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { decision?: string; note?: string },
  ) {
    const { decision, note } = body ?? {};
    if (!decision || !CLIENT_DECISIONS.has(decision)) throw new BadRequestException("decision must be signed|approved|changes_requested");
    await authorize(req.principal, { kind: "portal", tenantId }, "decide");
    const decided = await withTenants([tenantId], async (c) => {
      const clientId = await this.callerClientId(c, req.principal);
      // The gate must be a CLIENT-side gate on a run this client owns, and still pending.
      const res = await c.query<{ run_id: string; kind: string }>(
        `UPDATE pipeline_gates g SET status = 'decided', decision = $2, note = COALESCE($3, note),
           decided_by = $4, decided_at = now(), updated_at = now()
         FROM pipeline_runs r
         WHERE g.id = $1 AND g.run_id = r.id AND r.client_id = $5
           AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
         RETURNING g.run_id, g.kind`,
        [id, decision, note ?? null, req.principal.userId, clientId],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      await emitEvent(c, tenantId, "pipeline_gate", id, "pipeline.gate.decided", { runId: row.run_id, kind: row.kind, actorSide: "client", decision });
      return row;
    });
    if (!decided) throw new NotFoundException("gate not found, not yours, or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "pipeline_gate", id, { runId: decided.run_id, kind: decided.kind, via: "portal" });
    return { id, status: "decided", decision };
  }

  @Post(":tenantId/portal/runs/:runId/scope-sign")
  @HttpCode(201)
  async scopeSign(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("runId") runId: string,
    @Body() body: { signerName?: string; signatureRef?: string; gateId?: string },
  ) {
    await authorize(req.principal, { kind: "portal", tenantId }, "sign");
    const result = await withTenants([tenantId], async (c) => {
      const clientId = await this.callerClientId(c, req.principal);
      const run = await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`, [runId, clientId]);
      if (!run.rows[0]) throw new NotFoundException("run not found");
      // The client always signs the 'client' party. ON CONFLICT keeps it idempotent.
      await c.query(
        `INSERT INTO scope_signoffs (id, tenant_id, run_id, gate_id, party, signer, signer_name, signature_ref, origin_site)
         VALUES ($1, $2, $3, $4, 'client', $5, $6, $7, $8) ON CONFLICT (run_id, party) DO NOTHING`,
        [newId(), tenantId, runId, body?.gateId ?? null, req.principal.userId, body?.signerName ?? null, body?.signatureRef ?? null, config.originSite],
      );
      const parties = await c.query<{ party: string }>(`SELECT party FROM scope_signoffs WHERE run_id = $1`, [runId]);
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = REQUIRED_SCOPE_PARTIES.every((p) => have.has(p));
      if (complete) {
        if (body?.gateId) {
          await c.query(
            `UPDATE pipeline_gates SET status = 'decided', decision = 'signed', decided_by = $2, decided_at = now(), updated_at = now()
             WHERE id = $1 AND run_id = $3 AND status = 'pending' AND deleted_at IS NULL`,
            [body.gateId, req.principal.userId, runId],
          );
        }
        await emitEvent(c, tenantId, "scope", runId, "scope.signed", { runId, parties: [...have] });
      }
      return { complete, parties: [...have] };
    });
    await writeActivity(tenantId, req.principal.userId, "signed", "scope_signoff", runId, { party: "client", via: "portal" });
    return { runId, party: "client", ...result };
  }
}
