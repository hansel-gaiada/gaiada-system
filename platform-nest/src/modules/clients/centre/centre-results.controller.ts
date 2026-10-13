// PV6-02 — Client Centre "Services & results", STAFF route. See docs/plans/2026-10-13-pv6-business-areas-tickets.md.
//   GET /api/:tenantId/clients/:clientId/centre/results
//
// Authorized as `client` read, the SAME authority as the Business profile (`GET .../centre`). The payload carries only
// figures the client itself sees (every card is `clientVisible: true`), which is why `client` read is enough and a
// narrower module kind (`social_account`, `search_property`, `monitor`) is not needed: anything internal (budgets,
// costs, usage, audit detail, inbox) stays in the department screens. The hub Overview already reads social counts
// under `client` read (clients.controller.ts).
//
// Mounted under the `clients` module (ModuleEnabledGuard("clients")) like the profile routes. The service modules
// (social, search, webdev, monitoring) are NOT guarded here: a company that has not enabled one is simply not offered
// that service, which the composer reports by leaving it out. Authorization runs before the id is looked at.
import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { composeBusinessResults } from "./results/compose";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("clients"))
export class CentreResultsController {
  @Get(":tenantId/clients/:clientId/centre/results")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client", id: clientId, tenantId }, "read");
    if (!UUID_RE.test(clientId)) throw new NotFoundException("client not found");
    const exists = await withTenants([tenantId], (c) =>
      c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]),
    );
    if (!exists.rows[0]) throw new NotFoundException("client not found");
    return composeBusinessResults(tenantId, clientId);
  }
}
