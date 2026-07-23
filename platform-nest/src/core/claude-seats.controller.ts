// WSUX-17 (ex-P1-10) — C1 Claude seat registry API. Sits ALONGSIDE (not instead of) WSUX-14's generic
// connections endpoint, at a base path that avoids any collision:
//   GET    /api/:t/integrations/claude-seats?owner=me|team|user:<id>
//   POST   /api/:t/integrations/claude-seats             (map own seat, or admin-map another user's)
//   PATCH  /api/:t/integrations/claude-seats/:id          (codeSeatEmail / designLogin / status)
//   DELETE /api/:t/integrations/claude-seats/:id          (unmap — soft revoke, row kept)
//
// AUTHZ reuses resource_integration_connection.yaml VERBATIM — a seat is that exact same resource kind
// (kind: "integration_connection", provider='claude' under the hood), so no new Cerbos policy file is
// needed or introduced. Own-seat self-service vs. team-roster/other-person mapping = company.manage,
// mirroring integrations.controller.ts's own-vs-company split exactly (cerbosOwnerId is IMPORTED from
// there, not re-derived, so the two controllers can never drift on what "owns" means).
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { authorize } from "./http";
import { cerbosOwnerId } from "./integrations.controller";
import { CLIENT_SETTABLE_STATUSES, getConnectionRow, type ConnectionDbRow } from "./integrations.service";
import { getPersonSeat, listTeamSeats, mapSeat, patchSeat, unmapSeat } from "./claude-seats.service";

interface MapBody {
  userId?: string;
  codeSeatEmail?: string;
  designLogin?: string | null;
}
interface PatchBody {
  codeSeatEmail?: string | null;
  designLogin?: string | null;
  status?: string;
}

@Controller("api")
@UseGuards(AuthGuard)
export class ClaudeSeatsController {
  @Get(":tenantId/integrations/claude-seats")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("owner") owner?: string,
  ) {
    const me = req.principal.userId ?? "";
    const sel = owner ?? "me";
    if (sel === "me") {
      if (!me) throw new BadRequestException("owner=me requires an authenticated user");
      await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: me }, "read");
      const seat = await getPersonSeat(tenantId, me);
      return seat ? [seat] : [];
    }
    if (sel === "team") {
      // Company-wide roster (every member's seat) -> ownerId="" -> company.manage tier only, same
      // gate as the generic API's owner=company case.
      await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: "" }, "read");
      return listTeamSeats(tenantId);
    }
    if (sel.startsWith("user:")) {
      const uid = sel.slice("user:".length);
      if (!uid) throw new BadRequestException("owner=user:<id> requires an id");
      const authOwnerId = uid === me ? me : "";
      await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: authOwnerId }, "read");
      const seat = await getPersonSeat(tenantId, uid);
      return seat ? [seat] : [];
    }
    throw new BadRequestException("owner must be me | team | user:<id>");
  }

  @Post(":tenantId/integrations/claude-seats")
  @HttpCode(201)
  async map(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: MapBody) {
    const me = req.principal.userId ?? "";
    const personId = body?.userId ?? me;
    if (!personId) throw new BadRequestException("userId required (or call as an authenticated user)");
    if (!body?.codeSeatEmail) throw new BadRequestException("codeSeatEmail is required");
    // Mapping your own seat is self-service; mapping someone else's is company.manage (admin mapping).
    const authOwnerId = personId === me ? me : "";
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: authOwnerId }, "create");
    return mapSeat(tenantId, {
      personId, codeSeatEmail: body.codeSeatEmail, designLogin: body.designLogin, createdBy: me || null,
    });
  }

  @Patch(":tenantId/integrations/claude-seats/:id")
  async patch(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: PatchBody,
  ) {
    const row = await this.loadOrThrow(tenantId, id);
    if (body?.status !== undefined && !CLIENT_SETTABLE_STATUSES.has(body.status)) {
      throw new BadRequestException(
        `status must be one of ${[...CLIENT_SETTABLE_STATUSES].join(",")} (linked is reserved for a future token path; use DELETE to unmap)`,
      );
    }
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: cerbosOwnerId(row.owner_kind, row.owner_id) },
      "update",
    );
    return patchSeat(tenantId, id, {
      codeSeatEmail: body.codeSeatEmail, designLogin: body.designLogin, status: body.status,
    });
  }

  @Delete(":tenantId/integrations/claude-seats/:id")
  async unmap(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await this.loadOrThrow(tenantId, id);
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: cerbosOwnerId(row.owner_kind, row.owner_id) },
      "delete",
    );
    return unmapSeat(tenantId, id);
  }

  /** Load a row scoped to the tenant (RLS) AND to provider='claude' — this controller must never let
   *  a claude-seats :id reach into a github/google_drive connection row. Missing/other-tenant/other-
   *  provider is a uniform 404 BEFORE authz, so a probe can't distinguish "forbidden" from "doesn't
   *  exist" across tenant or provider boundaries. */
  private async loadOrThrow(tenantId: string, id: string): Promise<ConnectionDbRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException("seat not found");
    const row = await getConnectionRow(tenantId, id);
    if (!row || row.provider !== "claude") throw new NotFoundException("seat not found");
    return row;
  }
}
