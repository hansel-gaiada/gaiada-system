// SCP-Sb — seed and tear down the social simulator's accounts of one client (BFF §63.1 file 8, §63.16; plan §5).
//
//   POST   engagements/:engagementId/simulated-accounts            social_engagement · plan   one simulated account per requested network
//   DELETE engagements/:engagementId/simulated-accounts?networks=  social_engagement · plan   soft-deletes the client's simulated accounts
//
// THE ORDER OF REFUSALS, which the tests pin: (1) the decision, `plan` on `social_engagement` (the four approvers, PERMISSION
// §53.6): 403 `not_a_social_approver`, whatever the body holds or the flag says; (2) POST only: Sa's fence 4, 409
// `simulation_disabled` while `SOCIAL_SIMULATION_ENABLED` is off, through `assertSimulatedWriteAllowed` (never a second rule
// here); (3) the body: 400 `unknown_field` / `invalid_field`; (4) the engagement: 404 `engagement_not_found` (another company's
// engagement is hidden by the walls and answers the same); (5) the data: 409 `account_exists_not_simulated`,
// `publisher_org_not_active`, `simulated_account_in_use`. DELETE has no step 2: teardown happens with the switch OFF.
//
// WHICH CLIENT: the engagement's. Nothing in the body names a client, an account or an org, so a caller cannot seed another
// client's accounts by naming them; the engagement id is validated against the caller's own company by RLS.
//
// THE ANSWER of POST is `{accounts: [{id, network, handle, simulated: true, created, networkEnabled}]}` (the contract names the
// first five; `networkEnabled` is additive, see simulated-accounts.ts). DELETE answers `{removed: [{id, network, handle}]}`.
// Both write an activity row on the engagement.
//
// THE MODULE WALL. Every query runs inside `withTenants` with `{ modules: ["social"] }` and `declareSocialModuleScope`.
import { Body, Controller, Delete, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { declareSocialModuleScope } from "./module-scope";
import { authorizePlan } from "./pipeline/plan-authz";
import { assertSimulatedWriteAllowed } from "./publisher/simulation";
import {
  parseSeedBody, parseTeardownNetworks, removeSimulatedAccounts, seedSimulatedAccounts,
  type RemovedAccount, type SeededAccount,
} from "./simulated-accounts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Locks the engagement row and answers its client; 404 `engagement_not_found` when this company has no such open-or-closed engagement. */
async function lockEngagementClient(
  c: PoolClient, tenantId: string, engagementId: string,
): Promise<{ clientId: string; clientName: string }> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ client_id: string; client_name: string }>(
    `SELECT e.client_id, cl.name AS client_name
       FROM social_engagements e JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL
        FOR UPDATE OF e`,
    [tenantId, engagementId],
  );
  if (rows.length === 0) throw new NotFoundException({ message: "engagement_not_found" });
  return { clientId: rows[0].client_id, clientName: rows[0].client_name };
}

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialSimulatedAccountsController {
  // ==================================================================== POST engagements/:engagementId/simulated-accounts
  @Post("engagements/:engagementId/simulated-accounts")
  // 200, not Nest's default 201: the seed is idempotent and each account says whether it was `created`.
  @HttpCode(200)
  async seed(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Body() body: unknown,
  ): Promise<{ accounts: SeededAccount[] }> {
    // (1) The decision first: it reads only the path ids.
    await authorizePlan(req, tenantId, UUID_RE.test(engagementId) ? engagementId.toLowerCase() : undefined);
    // (2) Sa's fence 4, before the body is read. A typed `SocialPublisherError`, rendered `{error, code: "simulation_disabled"}` (409).
    assertSimulatedWriteAllowed("simulated-account seed");
    // (3) The body.
    const networks = parseSeedBody(body);
    // (4) The engagement.
    if (!UUID_RE.test(engagementId)) throw new NotFoundException({ message: "engagement_not_found" });
    const id = engagementId.toLowerCase();
    const accounts = await withTenants(
      [tenantId],
      async (c) => {
        const { clientId, clientName } = await lockEngagementClient(c, tenantId, id);
        return seedSimulatedAccounts(c, tenantId, clientId, clientName, networks);
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "seeded", "social_engagement", id, {
      simulatedAccounts: accounts.map((a) => ({ id: a.id, network: a.network, handle: a.handle, created: a.created })),
    });
    return { accounts };
  }

  // ==================================================================== DELETE engagements/:engagementId/simulated-accounts
  @Delete("engagements/:engagementId/simulated-accounts")
  async teardown(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("engagementId") engagementId: string, @Query("networks") networksQ?: string,
  ): Promise<{ removed: RemovedAccount[] }> {
    await authorizePlan(req, tenantId, UUID_RE.test(engagementId) ? engagementId.toLowerCase() : undefined);
    const networks = parseTeardownNetworks(networksQ);
    if (!UUID_RE.test(engagementId)) throw new NotFoundException({ message: "engagement_not_found" });
    const id = engagementId.toLowerCase();
    const removed = await withTenants(
      [tenantId],
      async (c) => {
        const { clientId } = await lockEngagementClient(c, tenantId, id);
        return removeSimulatedAccounts(c, tenantId, clientId, networks);
      },
      { modules: ["social"] },
    );
    await writeActivity(tenantId, req.principal.userId, "removed", "social_engagement", id, { simulatedAccounts: removed });
    return { removed };
  }
}
