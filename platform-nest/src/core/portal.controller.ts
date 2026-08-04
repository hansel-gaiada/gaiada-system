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
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { lockPipelineRun } from "./pipeline-lock";
import { notifyBestEffort, notifyScopeSignedBothSides, resolveClientRecipients } from "./client-notify";
import { requireSigner, resolvePortalScope } from "./portal-scope";

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
  // CP-1: the caller's client/project/capability resolution MOVED to ./portal-scope.ts, unchanged in
  // behaviour, because the portal is now four controllers that all need the same predicate. See that
  // file's header for why the `client_contacts` ∪ `clients.portal_user_id` union must not be
  // simplified. Call `resolvePortalScope(c, req.principal)` directly — there is no local wrapper, so
  // there is no second place for the rule to drift.

  @Get(":tenantId/portal/runs")
  async listRuns(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const { clientIds, projectIds } = await resolvePortalScope(c, req.principal);
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
      const { clientIds, projectIds } = await resolvePortalScope(c, req.principal);
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
      const scope = await resolvePortalScope(c, req.principal);
      const { clientIds } = scope;
      // CP-1 — CLOSES A GAP 0072 OPENED AND NEVER ENFORCED. `client_contacts.capability` exists
      // precisely so "contacts who WATCH but must not SIGN" is expressible (0072's own words), and
      // nothing ever read it: every invited stakeholder could countersign. A `viewer` may still send
      // FEEDBACK — that is the whole point of inviting them — so the gate is on the SIGNING decisions
      // only, not on the route. `changes_requested` stays open to viewers for the same reason.
      const isSignature = decision === "signed" || decision === "approved";
      if (isSignature) requireSigner(scope);
      // WD-29 (DEF-2): this is the CLIENT-side twin of PipelineController.decideGate and it is where
      // BOTH of DEF-2's triggering decisions actually land in production — `prd_sign` and
      // `customer_feedback` are client gates, decided here through the portal. Locking only the
      // internal controller would have left the real-world race fully alive, so this path takes the
      // SAME per-run advisory lock (same namespace + key) — one shared lock space is what makes a
      // portal decision and an automation stage-create mutually exclusive on one run.
      // Addressed by gate id, so read the immutable run key first, then lock, then run the original
      // ownership-checked UPDATE unchanged (its `status = 'pending'` predicate stays authoritative and
      // is now evaluated under the lock).
      // CP-1 — SECOND GAP CLOSED HERE: `projectIds` was resolved on this path and then never applied.
      // `listRuns`/`getRun` both carry the `($n IS NULL OR project_id = ANY($n))` predicate, so a
      // project-scoped contact could not SEE a run outside their project — but they could DECIDE a gate
      // on it, because this query filtered on the client only. Reachable with one addressable id and no
      // listing step, which is exactly the shape of an IDOR. Same predicate as the read paths, so a
      // project-less run stays invisible to a project-scoped contact on all three routes alike.
      const owner = await c.query<{ run_id: string }>(
        `SELECT g.run_id FROM pipeline_gates g JOIN pipeline_runs r ON g.run_id = r.id
         WHERE g.id = $1 AND r.client_id = ANY($2::uuid[]) AND g.actor_side = 'client' AND g.deleted_at IS NULL
           AND r.deleted_at IS NULL
           AND ($3::uuid[] IS NULL OR r.project_id = ANY($3::uuid[]))`,
        [id, clientIds, scope.projectIds],
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
      const scope = await resolvePortalScope(c, req.principal);
      const { clientIds } = scope;
      // CP-1: this route is named `sign` and signs a legal agreement, so the capability gate is
      // unconditional here (unlike decideGate, where a viewer's feedback is legitimate).
      requireSigner(scope);
      // WD-29 (DEF-2): the client-side scope sign-off — the second of the two events whose near-
      // simultaneous arrival with `prd_sign` produced the duplicate design stages. Same per-run lock
      // as every other transition, taken before the party set is read.
      await lockPipelineRun(c, runId);
      // CP-1: `projectIds` was resolved here and never applied either — same IDOR shape as decideGate
      // (a project-scoped contact could sign the scope of a run on another of their client's projects).
      const run = await c.query<{ project_id: string | null; owner_id: string | null; created_by: string | null; client_id: string | null }>(
        `SELECT project_id, owner_id, created_by, client_id FROM pipeline_runs
          WHERE id = $1 AND client_id = ANY($2::uuid[]) AND deleted_at IS NULL
            AND ($3::uuid[] IS NULL OR project_id = ANY($3::uuid[]))`,
        [runId, clientIds, scope.projectIds],
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
