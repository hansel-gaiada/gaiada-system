// Phase C (Intelligence surfaces, tenant-scoped): agent goals + knowledge sources. Both are
// read-only and degrade to [] when there is no live source — see per-endpoint notes.
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { authorize } from "../core/http";
import { AuthGuard } from "../auth/guards";

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

@Controller("api")
@UseGuards(AuthGuard)
export class IntelligenceController {
  // ai-agents is a CLI/library with no persistent goal store, so there is genuinely nothing
  // to list yet. Honest empty rather than fabricated goals; lights up if a goal store lands.
  @Get(":tenantId/agents/goals")
  async agentGoals(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    return [];
  }

  // Proxies the knowledge service's per-tenant source list (D9), reshaped to the UI's
  // KnowledgeSource. Degrades to [] if the service isn't configured or lacks /sources.
  @Get(":tenantId/knowledge/sources")
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
}
