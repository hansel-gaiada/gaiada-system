// PV6-04 (CC-D6) — STAFF routes: preview and run the "fill the Business profile from the discovery
// answers" action for a client converted from a lead. Authorized on the `client` kind exactly like the
// Business profile itself (read for the preview, update for the fill); authorization runs before any
// lookup. See discovery-map.ts for the mapping and centre-discovery.service.ts for the writes.
import { Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { loadDiscoveryAnswers, previewDiscoveryFill, fillProfileFromAnswers } from "./centre-discovery.service";

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class CentreDiscoveryController {
  @Get(":tenantId/clients/:clientId/centre/discovery")
  async preview(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const plan = await previewDiscoveryFill(c, tenantId, clientId);
      return { available: plan !== null, fillable: plan ? Object.keys(plan.fill) : [] };
    });
  }

  @Post(":tenantId/clients/:clientId/centre/fill-from-discovery")
  async fill(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "update");
    return withTenants([tenantId], async (c) => {
      const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
      if (!client.rows[0]) throw new NotFoundException("client not found");
      const answers = await loadDiscoveryAnswers(c, tenantId, clientId);
      if (!answers) throw new NotFoundException("no discovery answers for this client");
      return fillProfileFromAnswers(c, { tenantId, clientId, actorId: req.principal.userId, answers });
    });
  }
}
