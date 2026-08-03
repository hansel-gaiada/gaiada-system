// WS11 build item 4 — client portal BFF. The client-facing surface (transparency + the client's own
// sign-offs) is served here, SEPARATELY from the staff /api pipeline routes.
//
// AUTH, corrected 2026-08-03 against the live server (this header used to describe a design that was
// never built): a client authenticates against the SAME `gaiada` realm as staff, not an external client
// realm. W0's invite accept provisions the Keycloak user, `provisionUser()` links it on first login, and
// ownership resolves through `client_contacts` UNIONed with the legacy `clients.portal_user_id` — the
// invite flow never writes that column. Driven end to end via the real PKCE flow: the client's token is
// accepted, `/portal/runs` answers 200, and `/clients` + `/meetings/recordings` answer 403.
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
import { lockPipelineRun } from "./pipeline-lock";
import { notifyBestEffort, notifyScopeSignedBothSides, resolveClientRecipients } from "./client-notify";
import type { PoolClient } from "pg";

const CLIENT_DECISIONS = new Set(["signed", "approved", "changes_requested"]);
const REQUIRED_SCOPE_PARTIES = ["provider", "client"] as const;

// D-3 — "a client decides a gate -> notify the internal side": human-readable pieces for that
// notification's title. Kept local (not exported from client-notify.ts) because it is display text for
// ONE call site, not a recipient-resolution rule other callers would need.
const GATE_KIND_LABEL: Partial<Record<string, string>> = {
  prd_sign: "the PRD",
  customer_feedback: "your feedback request",
  scope_signoff: "the Scope Agreement",
};
function decisionVerb(decision: string): string {
  if (decision === "signed") return "signed";
  if (decision === "approved") return "approved";
  return "requested changes on"; // changes_requested
}

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
  /** Every client this caller is a portal contact of.
   *
   *  ⚠ W0 GAP THIS CLOSES — the whole invite flow was unreachable without it. `client_contacts`
   *  (migration 0072) is what the invite/accept flow writes; `clients.portal_user_id` is the older
   *  single-contact column, and it is the ONLY thing this method used to read. So an invited contact
   *  could accept, get a Keycloak account, receive the `client` role, gain the tenant via
   *  principal.ts's client_contacts union, pass `resource_portal` authz — and then be refused right
   *  here with "not a portal client". Everything upstream succeeded and the portal still showed
   *  nothing. The W0 spec said the portal "resolves through this table instead"; that intent was
   *  never implemented, which is exactly the kind of gap a design doc cannot catch.
   *
   *  Returns a SET, because D-1 made contacts many-per-client: one person can legitimately be a
   *  stakeholder for two clients of the same agency.
   *
   *  The legacy `portal_user_id` lookup is UNIONed in rather than dropped: it still has live rows and
   *  its own tests, and removing it here would be a silent access regression for anyone provisioned
   *  the old way. It is retired by a later migration, not by this method. */
  /** Convenience for the four read/write paths: the caller's client set plus their project
   *  restriction (null = all projects). */
  private async callerScope(
    c: PoolClient,
    principal: { userId: string | null },
  ): Promise<{ clientIds: string[]; projectIds: string[] | null }> {
    const clientIds = await this.callerClientIds(c, principal);
    const projectIds = await this.allowedProjectIds(c, principal.userId as string, clientIds);
    return { clientIds, projectIds };
  }

  private async callerClientIds(c: PoolClient, principal: { userId: string | null }): Promise<string[]> {
    if (!principal.userId) throw new ForbiddenException("not a portal client");
    const r = await c.query<{ id: string }>(
      `SELECT cc.client_id AS id
         FROM client_contacts cc
        WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
        UNION
       SELECT cl.id FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL`,
      [principal.userId],
    );
    const ids = r.rows.map((row) => row.id);
    // A `revoked` or still-`invited` contact resolves to nothing and is refused here — status governs
    // ACCESS, which is precisely the question this method asks.
    if (!ids.length) throw new ForbiddenException("not a portal client");
    return ids;
  }

  /** The projects this caller may see for a given client, or `null` meaning ALL of them.
   *
   *  D-1 allows a contact to be scoped to one project (`project_id`) or to the whole client
   *  (`project_id IS NULL`). A client-wide row therefore WIDENS access and must win over any
   *  narrower row — otherwise adding a project-scoped row to someone who already had client-wide
   *  access would silently take access away. */
  private async allowedProjectIds(
    c: PoolClient,
    userId: string,
    clientIds: string[],
  ): Promise<string[] | null> {
    const r = await c.query<{ project_id: string | null; legacy: boolean }>(
      `SELECT cc.project_id, false AS legacy
         FROM client_contacts cc
        WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
          AND cc.client_id = ANY($2::uuid[])
        UNION ALL
       SELECT NULL::uuid AS project_id, true AS legacy
         FROM clients cl WHERE cl.portal_user_id = $1 AND cl.deleted_at IS NULL`,
      [userId, clientIds],
    );
    // Any client-wide grant (or the legacy whole-client scheme) => unrestricted.
    if (r.rows.some((row) => row.project_id === null)) return null;
    return r.rows.map((row) => row.project_id as string);
  }

  @Get(":tenantId/portal/runs")
  async listRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const { clientIds, projectIds } = await this.callerScope(c, req.principal);
      const runs = await c.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status, created_at FROM pipeline_runs
         WHERE client_id = ANY($1::uuid[]) AND deleted_at IS NULL
           AND ($2::uuid[] IS NULL OR project_id = ANY($2::uuid[]))
         ORDER BY created_at DESC LIMIT 100`,
        [clientIds, projectIds],
      );
      // C3: blockage needs each run's stages + client gates, but fetched in TWO batched queries rather
      // than two per run. The loop this replaces issued 2N+1 round trips — 201 for a full page — and
      // the client portal is the one surface where that latency is paid by someone outside the company.
      // Same filters as before (report track excluded, client-side undeleted gates only), so the
      // grouping below is a transport change, not a semantic one.
      if (!runs.rows.length) return [];
      const runIds = runs.rows.map((r) => r.id);
      const [allStages, allGates] = await Promise.all([
        c.query<{ run_id: string; status: string }>(
          `SELECT run_id, status FROM pipeline_stages WHERE run_id = ANY($1::uuid[]) AND track <> 'report'`,
          [runIds],
        ),
        c.query<{ run_id: string; kind: string; status: string }>(
          `SELECT run_id, kind, status FROM pipeline_gates
            WHERE run_id = ANY($1::uuid[]) AND actor_side = 'client' AND deleted_at IS NULL`,
          [runIds],
        ),
      ]);
      const groupBy = <T extends { run_id: string }>(rows: T[]) => {
        const m = new Map<string, T[]>();
        for (const r of rows) {
          const list = m.get(r.run_id);
          if (list) list.push(r);
          else m.set(r.run_id, [r]);
        }
        return m;
      };
      const stagesByRun = groupBy(allStages.rows);
      const gatesByRun = groupBy(allGates.rows);
      // `?? []` is load-bearing: a run with no stages or no client gates returns no rows at all, and
      // the per-run loop passed an empty array in exactly that case. Passing `undefined` into
      // currentBlockage() instead would throw on a brand-new run — the most common state in the portal.
      return runs.rows.map((run) => {
        const gates = gatesByRun.get(run.id) ?? [];
        return {
          id: run.id,
          title: run.title,
          status: run.status,
          currentBlockage: currentBlockage(run, stagesByRun.get(run.id) ?? [], gates),
          // C5: how many client decisions are outstanding on this run. Added so the list can badge
          // "needs you" accurately WITHOUT the page fetching each run's detail — which is what it used
          // to do (one HTTP call per run, four queries each). Free here: the batch above already holds
          // every client-side gate, so this costs no extra query.
          pendingActions: gates.filter((g) => g.status === "pending").length,
        };
      });
    });
  }

  @Get(":tenantId/portal/runs/:runId")
  async getRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const { clientIds, projectIds } = await this.callerScope(c, req.principal);
      const run = await c.query<{ id: string; title: string; status: string }>(
        `SELECT id, title, status, created_at FROM pipeline_runs
          WHERE id = $1 AND client_id = ANY($2::uuid[]) AND deleted_at IS NULL
            AND ($3::uuid[] IS NULL OR project_id = ANY($3::uuid[]))`,
        [runId, clientIds, projectIds],
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
      const { clientIds, projectIds } = await this.callerScope(c, req.principal);
      // WD-29 (DEF-2): this is the CLIENT-side twin of PipelineController.decideGate and it is where
      // BOTH of DEF-2's triggering decisions actually land in production — `prd_sign` and
      // `customer_feedback` are client gates, decided here through the portal. Locking only the
      // internal controller would have left the real-world race fully alive, so this path takes the
      // SAME per-run advisory lock (same namespace + key) — one shared lock space is what makes a
      // portal decision and an automation stage-create mutually exclusive on one run.
      // Addressed by gate id, so read the immutable run key first, then lock, then run the original
      // ownership-checked UPDATE unchanged (its `status = 'pending'` predicate stays authoritative and
      // is now evaluated under the lock).
      const owner = await c.query<{ run_id: string }>(
        `SELECT g.run_id FROM pipeline_gates g JOIN pipeline_runs r ON g.run_id = r.id
         WHERE g.id = $1 AND r.client_id = ANY($2::uuid[]) AND g.actor_side = 'client' AND g.deleted_at IS NULL
           AND r.deleted_at IS NULL`,
        [id, clientIds],
      );
      if (!owner.rows[0]) return null;
      await lockPipelineRun(c, owner.rows[0].run_id);
      // The gate must be a CLIENT-side gate on a run this client owns, and still pending. Also returns
      // the run's owner_id/created_by (r is already joined for the ownership check) — D-3's "a client
      // decides a gate -> notify the internal side" needs exactly that pair and this is the one query
      // that has both the gate and its run in scope under the lock.
      const res = await c.query<{ run_id: string; kind: string; owner_id: string | null; created_by: string | null }>(
        `UPDATE pipeline_gates g SET status = 'decided', decision = $2, note = COALESCE($3, note),
           decided_by = $4, decided_at = now(), updated_at = now()
         FROM pipeline_runs r
         WHERE g.id = $1 AND g.run_id = r.id AND r.client_id = ANY($5::uuid[])
           AND g.actor_side = 'client' AND g.status = 'pending' AND g.deleted_at IS NULL
         RETURNING g.run_id, g.kind, r.owner_id, r.created_by`,
        [id, decision, note ?? null, req.principal.userId, clientIds],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      await emitEvent(c, tenantId, "pipeline_gate", id, "pipeline.gate.decided", { runId: row.run_id, kind: row.kind, actorSide: "client", decision });
      return row;
    });
    if (!decided) throw new NotFoundException("gate not found, not yours, or already decided");
    await writeActivity(tenantId, req.principal.userId, decision, "pipeline_gate", id, { runId: decided.run_id, kind: decided.kind, via: "portal" });
    // D-3: notify the internal side — the run's owner, or its creator if no owner is assigned. Best-
    // effort, AFTER the write stands: a notify() failure must not turn a decision the client already
    // made into an error response.
    const internalRecipient = decided.owner_id ?? decided.created_by;
    if (internalRecipient) {
      await notifyBestEffort(tenantId, req.principal.userId, [internalRecipient], "pipeline.gate.decided", {
        title: `Client ${decisionVerb(decision)} ${GATE_KIND_LABEL[decided.kind] ?? "a gate"}`,
        href: `/pipeline/${decided.run_id}`,
        entityType: "pipeline_gate",
        entityId: id,
        severity: decision === "changes_requested" ? "warning" : "info",
      });
    }
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
      const { clientIds, projectIds } = await this.callerScope(c, req.principal);
      // WD-29 (DEF-2): the client-side scope sign-off — the second of the two events whose near-
      // simultaneous arrival with `prd_sign` produced the duplicate design stages. Same per-run lock
      // as every other transition, taken before the party set is read.
      await lockPipelineRun(c, runId);
      const run = await c.query<{ project_id: string | null; owner_id: string | null; created_by: string | null; client_id: string | null }>(
        `SELECT project_id, owner_id, created_by, client_id FROM pipeline_runs
          WHERE id = $1 AND client_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [runId, clientIds],
      );
      if (!run.rows[0]) throw new NotFoundException("run not found");
      // The client always signs the 'client' party. ON CONFLICT keeps it idempotent.
      const ins = await c.query(
        `INSERT INTO scope_signoffs (id, tenant_id, run_id, gate_id, party, signer, signer_name, signature_ref, origin_site)
         VALUES ($1, $2, $3, $4, 'client', $5, $6, $7, $8) ON CONFLICT (run_id, party) DO NOTHING`,
        [newId(), tenantId, runId, body?.gateId ?? null, req.principal.userId, body?.signerName ?? null, body?.signatureRef ?? null, config.originSite],
      );
      const parties = await c.query<{ party: string }>(`SELECT party FROM scope_signoffs WHERE run_id = $1`, [runId]);
      const have = new Set(parties.rows.map((r) => r.party));
      const complete = REQUIRED_SCOPE_PARTIES.every((p) => have.has(p));
      // WD-29: emit on the TRANSITION to complete only — a client re-signing an already-complete run
      // must not announce `scope.signed` again and start another delivery execution. Mirrors the same
      // change in PipelineController.recordScopeSignoff; see that comment for the full rationale.
      if (complete && ins.rowCount === 1) {
        if (body?.gateId) {
          await c.query(
            `UPDATE pipeline_gates SET status = 'decided', decision = 'signed', decided_by = $2, decided_at = now(), updated_at = now()
             WHERE id = $1 AND run_id = $3 AND status = 'pending' AND deleted_at IS NULL`,
            [body.gateId, req.principal.userId, runId],
          );
        }
        await emitEvent(c, tenantId, "scope", runId, "scope.signed", { runId, parties: [...have] });
      }
      // D-3: "scope.signed completes (both parties) -> notify both sides." Resolved on the same
      // connection as the write, inside the transaction (a plain read); the notify() calls themselves
      // are deferred until after the transaction commits, below. Mirrors
      // PipelineController.recordScopeSignoff — see client-notify.ts's notifyScopeSignedBothSides doc.
      const justCompleted = complete && ins.rowCount === 1;
      const internalRecipient = justCompleted ? (run.rows[0].owner_id ?? run.rows[0].created_by) : null;
      const clientRecipients = justCompleted
        // The run's OWN client, not the caller's whole client set: a contact representing two clients
        // must not cause the other client's contacts to be notified about this run.
        ? await resolveClientRecipients(c, { clientId: run.rows[0].client_id, projectId: run.rows[0].project_id, kind: "general" })
        : [];
      return { complete, parties: [...have], internalRecipient, clientRecipients };
    });
    await writeActivity(tenantId, req.principal.userId, "signed", "scope_signoff", runId, { party: "client", via: "portal" });
    await notifyScopeSignedBothSides(tenantId, req.principal.userId, runId, result.internalRecipient, result.clientRecipients);
    return { runId, party: "client", complete: result.complete, parties: result.parties };
  }
}
