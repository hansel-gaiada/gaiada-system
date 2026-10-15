// DW-7i-1 (BFF §52.12, PERMISSION §42a) — the failing workflows of the shared n8n, for the owner, the GM, the PM and the
// platform operator. The audience rule lives in core/automation-failures-audience.ts; the paging and window in
// ./automation-failures.ts. Not under /api/admin: it is addressed by company, because the rule is "in a company with the
// automation console on", and the IT workflows console (`GET /api/admin/automation/executions`) keeps its own access.
import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { AuthGuard } from "../auth/guards";
import { automationFailuresAccess } from "../core/automation-failures-audience";
import { collectFailures, type FailuresWindow, type N8nGet } from "./automation-failures";

/** GET the n8n Public API with the API key and the probe timeout (the pattern admin-systems uses); throws on non-2xx. */
function n8nGetter(base: string, apiKey: string): N8nGet {
  return async (path) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.adminProbeTimeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { signal: ac.signal, headers: { "X-N8N-API-KEY": apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
}

@Controller("api")
@UseGuards(AuthGuard)
export class AutomationFailuresController {
  @Get(":tenantId/automation/failures")
  async failures(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("window") windowQ?: string) {
    // Authorization before validation: a refused caller learns nothing, not even which windows are valid.
    const access = await automationFailuresAccess(req.principal, tenantId);
    if (access === "module_off") throw new NotFoundException("automation-console is not enabled for this company");
    if (access === "not_in_audience") throw new ForbiddenException({ error: "forbidden", reason: "not_in_audience" });

    const window = (windowQ === undefined || windowQ === "" ? "24h" : windowQ) as FailuresWindow;
    if (window !== "24h" && window !== "7d") throw new BadRequestException({ message: "window must be 24h or 7d", field: "window" });

    const asOf = new Date();
    // The browser-reachable editor origin (never `services.automation.url`, the in-cluster one), for the page's "open in n8n" links.
    const editorUrl = config.automationPublicUrl || undefined;
    const svc = config.services.automation;
    if (!svc.url || !svc.token) {
      return {
        asOf: asOf.toISOString(),
        window,
        state: "not_configured",
        reason: "The automation service has no URL or no API key",
        failed: [],
        count: 0,
        capped: false,
        editorUrl,
      };
    }
    const result = await collectFailures(n8nGetter(svc.url.replace(/\/$/, ""), svc.token), window, asOf.getTime());
    return { asOf: asOf.toISOString(), window, ...result, editorUrl };
  }
}
