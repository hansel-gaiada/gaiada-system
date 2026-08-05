// Phase C (Intelligence surfaces, tenant-scoped): agent goals + knowledge sources.
//
// Agent goals (B3, erp-whatsapp-and-agent-runtime-e2e.md §3.3): a thin, tenant-pinned proxy in
// front of the agent-runner service (B1). Listing/detail stay behind the ordinary tenant
// `authorize(activity read)` gate (unchanged); triggering a goal and reading a run's full step
// transcript are `isElevated`-only — a transcript can contain tool output fetched under the
// *triggering* user's authority, so only platform-wide admins may read it (§4). Degrades to
// []/404 when the runner isn't configured or unreachable, same fail-soft convention as the rest
// of this controller.
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, NotFoundException, Param, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config, knowledgeIngestEnabled } from "../config";
import { authorize } from "../core/http";
import { AuthGuard } from "../auth/guards";
import { ModuleEnabledGuard } from "../modules/module-enabled.guard";
import { lastIngestRun, runIngestSweep } from "../modules/knowledge/ingest/scheduler";
import { isElevated } from "./elevated";
import { newId, withGlobal, withTenants } from "../db";
import { fetchHandoffByRunId } from "../modules/assistant/handoffs";

async function getJson(url: string, token?: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- agent-runner reshape helpers (runner shapes -> UI AgentGoal/AgentGoalDetail/AgentRun) ----

interface RunnerBudget {
  modelCalls?: number;
  toolCalls?: number;
}
interface RunnerGoalListItem {
  id: string;
  goal: string;
  agent: string;
  status: string;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  modelCalls: number;
  toolCalls: number;
  fanOut: number;
  budget: RunnerBudget | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
interface RunnerGoalDetail extends RunnerGoalListItem {
  blackboard: unknown;
  runs: unknown[];
}
interface RunnerRunRow {
  runId: string;
  goalId: string;
  agent: string;
  status: string;
  outcome: string | null;
  steps: unknown[];
  modelCalls: number;
  toolCalls: number;
  toolsCalled: string[];
  provider: string | null;
  startedAt: number;
  endedAt: number;
}

/** Runner's GoalListItem -> the UI's AgentGoal (platform-ui/src/lib/admin.ts): budgetSpent =
 *  modelCalls+toolCalls, budgetTotal from the budget caps, fanOut passthrough, plus the
 *  additive lifecycle/error/approval fields. */
function reshapeGoal(g: RunnerGoalListItem) {
  return {
    id: g.id,
    goal: g.goal,
    status: g.status,
    budgetSpent: g.modelCalls + g.toolCalls,
    budgetTotal: g.budget ? (g.budget.modelCalls ?? 0) + (g.budget.toolCalls ?? 0) : undefined,
    fanOut: g.fanOut,
    agent: g.agent,
    createdAt: g.createdAt,
    endedAt: g.endedAt,
    errorKind: g.errorKind,
    approvalId: g.approvalId,
  };
}

function reshapeRun(r: RunnerRunRow) {
  return {
    runId: r.runId,
    goalId: r.goalId,
    agent: r.agent,
    status: r.status,
    outcome: r.outcome,
    steps: r.steps,
    modelCalls: r.modelCalls,
    toolCalls: r.toolCalls,
    toolsCalled: r.toolsCalled,
    provider: r.provider,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}

@Controller("api")
@UseGuards(AuthGuard)
export class IntelligenceController {
  // Tenant-scoped list, unchanged gate. Degrades to [] when the runner isn't configured or is
  // unreachable — the UI's getAgentGoals already treats that as "no goals yet".
  @Get(":tenantId/agents/goals")
  async agentGoals(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const svc = config.services.agents;
    if (!svc.url) return [];
    try {
      const res = (await getJson(
        `${svc.url.replace(/\/$/, "")}/goals?tenant=${encodeURIComponent(tenantId)}`,
        svc.token,
      )) as { goals?: RunnerGoalListItem[] };
      if (!Array.isArray(res.goals)) return [];
      return res.goals.map(reshapeGoal);
    } catch {
      return [];
    }
  }

  // Tenant-scoped detail, unchanged gate. 404 (not the goal's blackboard/transcript, just the
  // reshaped goal + run summaries) when the runner is unconfigured/unreachable/doesn't know the
  // goal — the UI's getAgentGoal already degrades a 404 to null.
  @Get(":tenantId/agents/goals/:goalId")
  async agentGoal(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("goalId") goalId: string) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const svc = config.services.agents;
    if (!svc.url) throw new NotFoundException("agents service not configured");
    try {
      const g = (await getJson(
        `${svc.url.replace(/\/$/, "")}/goals/${encodeURIComponent(goalId)}?tenant=${encodeURIComponent(tenantId)}`,
        svc.token,
      )) as RunnerGoalDetail;
      return { ...reshapeGoal(g), blackboard: g.blackboard ?? [], runs: g.runs ?? [] };
    } catch {
      throw new NotFoundException("goal not found");
    }
  }

  // Elevated-only (§4): a full run's step transcript can carry tool output fetched under the
  // *triggering* user's authority. Tenant-pinned by the runner itself (no cross-tenant probing).
  //
  // ASST-21 ADDITIVE, do not widen: the line above (`isElevated`) is COMPLETELY UNCHANGED — every
  // run that is NOT a handoff still 403s for a non-elevated caller exactly as before (the regression
  // this comment guards: `intelligence.test.ts`'s "run transcript is elevated-only" case still
  // exercises this exact path for a plain member and must keep failing). The block below only ever
  // RUNS when `isElevated` was false, and even then it 403s unless `assistant_handoffs` (ASST-21,
  // `modules/assistant/handoffs.ts`) says THIS runId is a handoff THIS caller triggered — the run
  // then executed under the caller's own OBO envelope (broker.ts's `oboEnvelopeFor`), so reading it
  // back is not an elevation. `resource_agent_run.yaml` is the Cerbos-authoritative form of that
  // check (owner AND origin='assistant_handoff', both required).
  @Get(":tenantId/agents/runs/:runId")
  async agentRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("runId") runId: string) {
    if (!isElevated(req)) {
      const handoff = await withTenants([tenantId], (c) => fetchHandoffByRunId(c, runId), { modules: ["assistant"] });
      if (!handoff) throw new ForbiddenException("platform admin required");
      await authorize(req.principal, { kind: "agent_run", tenantId, ownerId: handoff.ownerUserId, origin: "assistant_handoff" }, "read");
    }
    const svc = config.services.agents;
    if (!svc.url) throw new NotFoundException("agents service not configured");
    try {
      const r = (await getJson(
        `${svc.url.replace(/\/$/, "")}/runs/${encodeURIComponent(runId)}?tenant=${encodeURIComponent(tenantId)}`,
        svc.token,
      )) as RunnerRunRow;
      return reshapeRun(r);
    } catch {
      throw new NotFoundException("run not found");
    }
  }

  // Elevated-only trigger (§4). Two steps, in order:
  //   (1) Platform self-link upsert (§5.2): identity_links(provider='platform',
  //       external_id=userId, user_id=userId) — BOTH sides pinned from the authenticated
  //       principal, NEVER from the request body (a body-supplied provider/externalId is
  //       ignored outright — there is no code path that reads them). ON CONFLICT DO NOTHING
  //       keeps it idempotent; the row is unforgeable because it always points at the caller.
  //   (2) Runner POST /goals with envelope={provider:'platform', externalId:userId} — the OBO
  //       identity every subsequent hub/knowledge/Cerbos check resolves through is the caller's
  //       own verified link, exactly like a normal identity_links row (D11 revocation etc. all
  //       apply unchanged).
  @Post(":tenantId/agents/goals")
  @HttpCode(202)
  async triggerAgentGoal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { goal?: string; agent?: string },
  ) {
    if (!isElevated(req)) throw new ForbiddenException("platform admin required");
    const userId = req.principal.userId;
    if (!userId) throw new UnauthorizedException("no user");
    const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
    if (!goal) throw new BadRequestException("goal required");

    const svc = config.services.agents;
    if (!svc.url) throw new HttpException("agent runner not configured", 503);

    // (1) Self-link upsert — external_id and user_id both pinned to req.principal.userId.
    await withGlobal((c) =>
      c.query(
        `INSERT INTO identity_links (id, user_id, provider, external_id, verified_at)
         VALUES ($1, $2, 'platform', $3, now())
         ON CONFLICT (provider, external_id) DO NOTHING`,
        [newId(), userId, userId],
      ),
    );

    // (2) Trigger the runner with the platform OBO envelope (never the request body's own
    // provider/externalId, if any were sent — this handler never reads those fields).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
    let res: Response;
    try {
      res = await fetch(`${svc.url.replace(/\/$/, "")}/goals`, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json", ...(svc.token ? { authorization: `Bearer ${svc.token}` } : {}) },
        body: JSON.stringify({
          tenantId,
          goal,
          agent: body?.agent,
          envelope: { provider: "platform", externalId: userId },
          requestedBy: userId,
        }),
      });
    } catch {
      throw new HttpException("agent runner unreachable", 503);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const message = json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : "agent runner error";
      // Passthrough the runner's own status (400 bad agent/goal, 429 queue full, ...); only a
      // 5xx from the runner itself is normalized to 503 (matches the "unreachable" case above).
      throw new HttpException(message, res.status >= 500 ? 503 : res.status);
    }
    return json;
  }

  // Proxies the knowledge service's per-tenant source list (D9), reshaped to the UI's
  // KnowledgeSource. Degrades to [] if the service isn't configured or lacks /sources.
  // Method-scoped (not class-scoped) guard: agentGoals above is not part of the knowledge
  // module contract and must stay reachable regardless of the "knowledge" enable flag.
  @Get(":tenantId/knowledge/sources")
  @UseGuards(ModuleEnabledGuard("knowledge"))
  async knowledgeSources(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const svc = config.services.knowledge;
    if (!svc.url) return [];
    try {
      const rows = (await getJson(
        `${svc.url.replace(/\/$/, "")}/sources?tenant=${encodeURIComponent(tenantId)}`,
        svc.token,
      )) as Array<{ sourceRef?: string; provenance?: string; status?: string }>;
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => ({
        id: r.sourceRef ?? "",
        source: r.sourceRef ?? "",
        provenance: r.provenance,
        status: r.status ?? "indexed",
      }));
    } catch {
      return [];
    }
  }

  // Approve/reject a quarantined knowledge source. Proxies the write to the knowledge service
  // (service-token). 404 when the service isn't configured/reachable so the UI degrades to
  // "reviewing isn't available yet" instead of erroring.
  @Post(":tenantId/knowledge/sources/:sourceId/review")
  @UseGuards(ModuleEnabledGuard("knowledge"))
  @HttpCode(200)
  async reviewSource(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("sourceId") sourceId: string,
    @Body() body: { decision?: string },
  ) {
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BadRequestException("decision must be approved|rejected");
    await authorize(req.principal, { kind: "knowledge_source", tenantId }, "update");
    const svc = config.services.knowledge;
    if (!svc.url) throw new NotFoundException("knowledge service not configured");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
    try {
      const res = await fetch(`${svc.url.replace(/\/$/, "")}/sources/${encodeURIComponent(sourceId)}/review`, {
        method: "POST",
        signal: ac.signal,
        headers: { "Content-Type": "application/json", ...(svc.token ? { authorization: `Bearer ${svc.token}` } : {}) },
        body: JSON.stringify({ tenantId, decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      throw new NotFoundException("knowledge review unavailable");
    } finally {
      clearTimeout(timer);
    }
    // Audit lives in the knowledge service (D9-owned); the source ref is not a platform uuid,
    // so we do not write it to the tenant activity feed here.
    return { ok: true };
  }

  // ---- knowledge ingestion (RAG corpus refresh) ----------------------------------------------
  // The scheduled sweep is the normal path; these two exist so an operator can see whether the
  // index is fresh and force a refresh after bulk-editing content, without waiting out the interval.

  /** Last sweep's per-tier outcome (sources, chunks, retirements, errors) + whether one is running. */
  @Get(":tenantId/knowledge/ingest/status")
  @UseGuards(ModuleEnabledGuard("knowledge"))
  async ingestStatus(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "knowledge_source", tenantId }, "read");
    return { enabled: knowledgeIngestEnabled(), intervalMs: config.knowledgeIngest.intervalMs, ...lastIngestRun() };
  }

  /** Force a refresh. Elevated-only: a sweep re-embeds every chunk of every company, which is real
   *  gateway load and a cross-company action — not something a single tenant's member should be able
   *  to trigger at will. It returns as soon as the sweep is kicked off; poll the status route. */
  @Post(":tenantId/knowledge/ingest/run")
  @UseGuards(ModuleEnabledGuard("knowledge"))
  @HttpCode(202)
  async ingestRun(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "knowledge_source", tenantId }, "update");
    if (!isElevated(req)) throw new ForbiddenException("knowledge ingest is a platform-wide action");
    if (!knowledgeIngestEnabled()) throw new NotFoundException("knowledge ingest not configured");
    // Fire-and-forget: a full sweep can run for minutes, far past any sane HTTP timeout. The
    // scheduler's `running` gate makes a double-click a no-op rather than a second sweep.
    void runIngestSweep().catch((err) => console.error("knowledge ingest (manual) failed", err));
    return { ok: true, started: true };
  }
}
