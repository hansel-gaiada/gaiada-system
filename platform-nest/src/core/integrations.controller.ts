// WSUX-14 (ex-P1-08) — F1 connections CRUD API (locked decision #8). The validation + authz boundary
// over integrations.service.ts. Base path avoids collision with any existing route:
//   GET    /api/:t/integrations/connections?owner=me|company|user:<id>&provider=
//   POST   /api/:t/integrations/connections          (create mapping row — NO tokens in Phase 1)
//   PATCH  /api/:t/integrations/connections/:id       (externalAccount / meta / status / scopes)
//   DELETE /api/:t/integrations/connections/:id       (SOFT revoke — status='revoked', tokens nulled)
//
// ── AUTHZ MODEL (decision #8: own user-rows = self-service; company rows + OTHERS' rows = manager+) ──
// The own-vs-company decision is made by Cerbos (resource_integration_connection.yaml) using the
// shared `owns` variable (resource.attr.ownerId == principal.id). The controller feeds Cerbos the
// right ownerId per case:
//   * a USER row       -> ownerId = that row's owner_id. If it's the caller's own id, `owns` is true
//                          and a plain member is allowed; otherwise it needs company_admin/manager.
//   * a COMPANY row     -> ownerId = "" (a company id can never equal a user's principal.id, so `owns`
//                          is false) -> always requires company_admin/manager+.
// Every mutation additionally re-checks the row's tenant is in the caller's authorized set (RLS +
// `inTenant`), so a forged :id from another tenant is unreadable (getConnectionRow returns null -> 404).
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { authorize } from "./http";
import {
  CLIENT_SETTABLE_STATUSES, CONNECTION_OWNER_KINDS, CONNECTION_PROVIDERS,
  createConnection, getConnectionRow, listConnections, patchConnection, revokeConnection,
  type ConnectionDbRow,
} from "./integrations.service";

interface CreateBody {
  ownerKind?: string;
  ownerId?: string;
  provider?: string;
  externalAccount?: string | null;
  scopes?: string[];
  meta?: Record<string, unknown>;
}
interface PatchBody {
  externalAccount?: string | null;
  meta?: Record<string, unknown>;
  status?: string;
  scopes?: string[];
}

/** The ownerId a Cerbos check should see for a row: a user row exposes its owner_id (enabling the
 *  `owns` self-service match); a company row exposes "" so `owns` is always false -> manager+ only.
 *  Exported so claude-seats.controller.ts (WSUX-17) reuses the exact same own-vs-company mapping
 *  instead of re-deriving it — both controllers gate the SAME resource kind (integration_connection). */
export function cerbosOwnerId(ownerKind: string, ownerId: string): string {
  return ownerKind === "user" ? ownerId : "";
}

@Controller("api")
@UseGuards(AuthGuard)
export class IntegrationsController {
  @Get(":tenantId/integrations/connections")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("owner") owner?: string,
    @Query("provider") provider?: string,
  ) {
    if (provider && !CONNECTION_PROVIDERS.has(provider)) {
      throw new BadRequestException(`provider must be one of ${[...CONNECTION_PROVIDERS].join(",")}`);
    }
    const me = req.principal.userId ?? "";
    // Resolve the owner scope + the ownerId Cerbos should authorize against.
    let filter: { ownerKind?: string; ownerId?: string };
    let authOwnerId: string;
    const sel = owner ?? "me";
    if (sel === "me") {
      if (!me) throw new BadRequestException("owner=me requires an authenticated user");
      filter = { ownerKind: "user", ownerId: me };
      authOwnerId = me; // own rows -> `owns` true -> member self-service
    } else if (sel === "company") {
      filter = { ownerKind: "company" };
      authOwnerId = ""; // company rows -> manager+ only
    } else if (sel.startsWith("user:")) {
      const uid = sel.slice("user:".length);
      if (!uid) throw new BadRequestException("owner=user:<id> requires an id");
      filter = { ownerKind: "user", ownerId: uid };
      authOwnerId = uid === me ? me : ""; // others' rows -> manager+
    } else {
      throw new BadRequestException("owner must be me | company | user:<id>");
    }
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: authOwnerId }, "read");
    return listConnections(tenantId, { ...filter, provider });
  }

  @Post(":tenantId/integrations/connections")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: CreateBody) {
    const ownerKind = body?.ownerKind ?? "user";
    if (!CONNECTION_OWNER_KINDS.has(ownerKind)) throw new BadRequestException("ownerKind must be user|company");
    if (!body?.provider || !CONNECTION_PROVIDERS.has(body.provider)) {
      throw new BadRequestException(`provider must be one of ${[...CONNECTION_PROVIDERS].join(",")}`);
    }
    const me = req.principal.userId ?? "";
    // ownerId defaults: a user connection defaults to the caller; a company connection is the tenant.
    let ownerId: string;
    if (ownerKind === "user") {
      ownerId = body.ownerId ?? me;
      if (!ownerId) throw new BadRequestException("ownerId required for a user connection");
    } else {
      // Company connections are always owned by the company itself (the tenant) — a client cannot
      // point a company row's owner elsewhere.
      ownerId = tenantId;
    }
    await authorize(
      req.principal,
      { kind: "integration_connection", tenantId, ownerId: cerbosOwnerId(ownerKind, ownerId) },
      "create",
    );
    return createConnection(tenantId, {
      ownerKind, ownerId, provider: body.provider,
      externalAccount: body.externalAccount, scopes: body.scopes, meta: body.meta,
      createdBy: me || null,
    });
  }

  @Patch(":tenantId/integrations/connections/:id")
  async patch(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: PatchBody,
  ) {
    const row = await this.loadOrThrow(tenantId, id);
    if (body?.status !== undefined && !CLIENT_SETTABLE_STATUSES.has(body.status)) {
      throw new BadRequestException(
        `status must be one of ${[...CLIENT_SETTABLE_STATUSES].join(",")} (linked is set by the token path; use DELETE to revoke)`,
      );
    }
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: cerbosOwnerId(row.owner_kind, row.owner_id) },
      "update",
    );
    return patchConnection(tenantId, id, {
      externalAccount: body.externalAccount, meta: body.meta, status: body.status, scopes: body.scopes,
    });
  }

  @Delete(":tenantId/integrations/connections/:id")
  async revoke(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await this.loadOrThrow(tenantId, id);
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: cerbosOwnerId(row.owner_kind, row.owner_id) },
      "delete",
    );
    return revokeConnection(tenantId, id);
  }

  /** Load a row scoped to the tenant (RLS). A missing/other-tenant id is a 404 BEFORE authz, so a
   *  probe can't distinguish "forbidden" from "doesn't exist" across tenant boundaries. */
  private async loadOrThrow(tenantId: string, id: string): Promise<ConnectionDbRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException("connection not found");
    const row = await getConnectionRow(tenantId, id);
    if (!row) throw new NotFoundException("connection not found");
    return row;
  }
}
