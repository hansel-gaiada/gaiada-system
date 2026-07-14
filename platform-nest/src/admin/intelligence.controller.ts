// Phase C (Intelligence surfaces, tenant-scoped): agent goals + knowledge sources. Both are
// read-only and degrade to [] when there is no live source — see per-endpoint notes.
import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
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
}
