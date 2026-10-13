// PV6-02 — Client Centre "Services & results", PORTAL route. See docs/plans/2026-10-13-pv6-business-areas-tickets.md.
//   GET /api/:tenantId/portal/centre/:clientId/results
//
// CORE, no ModuleEnabledGuard, like every other Portal*Controller (portal-centre.controller.ts header): a client contact
// has no view of, and no reason to care about, their agency's own module configuration. The composer decides per service
// whether the company offers it.
//
// THE ORDER (authorization before anything else):
//   1. Cerbos: portal `read`.
//   2. portal scope: the URL's clientId must be one of the caller's clients, else 404 (never 403: no existence oracle).
//   3. client-wide for THIS client (`scope.wideClientIds`, the per-client portal scope): a contact who is in scope but
//      limited to some projects may be someone outside the client's organisation, so they get 200
//      `{visible: false, services: []}` (PV-D33; PV6-Q1), never a partial or project-filtered view.
//   4. only then the composer, the same function the staff route calls, so the two payloads are equal.
import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { composeBusinessResults, hiddenBusinessResults } from "../modules/clients/centre/results/compose";

@Controller("api")
@UseGuards(AuthGuard)
export class PortalCentreResultsController {
  @Get(":tenantId/portal/centre/:clientId/results")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const wide = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      if (!scope.clientIds.includes(clientId)) throw new NotFoundException("client not found");
      return scope.wideClientIds.includes(clientId);
    });
    if (!wide) return hiddenBusinessResults(clientId);
    return composeBusinessResults(tenantId, clientId);
  }
}
