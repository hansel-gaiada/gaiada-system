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
import { authorize, writeActivity } from "./http";
import {
  CLIENT_CREATABLE_OWNER_KINDS, CLIENT_SETTABLE_STATUSES, CONNECTION_PROVIDERS,
  createConnection, getConnectionRow, listConnections, patchConnection, revokeConnection,
  type ConnectionDbRow,
} from "./integrations.service";
import { fileAutomationApproval } from "./approval-filing";
import {
  INTEGRATION_CONNECTION_REVEAL_TOOL, INTEGRATION_CONNECTION_REVEAL_WORKFLOW,
  redeemConnectionReveal, throwForRevealDenial,
} from "./connection-reveal";

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

/**
 * IAM-14c — which ACTION to authorize for a given target row.
 *
 * The four per-row actions (`read`/`create`/`update`/`delete`) are the SELF tier: member and viewer
 * hold them, gated on `owns`. Reaching anyone else's row, or a company-owned one, is a different
 * capability and now has its own key — `core.integration_connection.manage`.
 *
 * ⚠ THIS IS THE BEHAVIOURAL HALF OF THE KEY SPLIT, AND IT IS WHY THE SPLIT WORKS. Without it the
 * new `manage` action would exist in the policy and catalog and never be checked, so `owner` — which
 * is permission-native and therefore reaches this kind only through the perm arm — would still be
 * unable to touch a company connection. Adding the key without changing the caller would have been
 * dead config that looked like a fix.
 *
 * company_admin/manager are unaffected: they hold `manage` on the role arm. member/viewer stay
 * denied on other people's rows exactly as before, because they hold no `manage`.
 *
 * `authCerbosOwnerId` is what the caller already passes to Cerbos: the row's owner for a user row,
 * `""` for a company row or someone else's. So "is this mine" is `=== me`, and `me` being empty
 * (an unauthenticated/service principal) can never accidentally match `""`.
 */
export function connectionAction(perRowAction: string, authCerbosOwnerId: string, me: string): string {
  return me !== "" && authCerbosOwnerId === me ? perRowAction : "manage";
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
    await authorize(
      req.principal,
      { kind: "integration_connection", tenantId, ownerId: authOwnerId },
      connectionAction("read", authOwnerId, me),
    );
    return listConnections(tenantId, { ...filter, provider });
  }

  @Post(":tenantId/integrations/connections")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: CreateBody) {
    const ownerKind = body?.ownerKind ?? "user";
    // Client-facing surface, NOT the full DB-valid set — 'github_app' is ops-provisioned only
    // (github/credential-store.ts), never created through this endpoint. See
    // CLIENT_CREATABLE_OWNER_KINDS's doc comment in integrations.service.ts.
    if (!CLIENT_CREATABLE_OWNER_KINDS.has(ownerKind)) throw new BadRequestException("ownerKind must be user|company");
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
    const createAuthOwner = cerbosOwnerId(ownerKind, ownerId);
    await authorize(
      req.principal,
      { kind: "integration_connection", tenantId, ownerId: createAuthOwner },
      // Creating a COMPANY connection is a company-tier act (`manage`); creating your own is `create`.
      connectionAction("create", createAuthOwner, me),
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
    const patchAuthOwner = cerbosOwnerId(row.owner_kind, row.owner_id);
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: patchAuthOwner },
      connectionAction("update", patchAuthOwner, req.principal.userId ?? ""),
    );
    return patchConnection(tenantId, id, {
      externalAccount: body.externalAccount, meta: body.meta, status: body.status, scopes: body.scopes,
    });
  }

  @Delete(":tenantId/integrations/connections/:id")
  async revoke(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const row = await this.loadOrThrow(tenantId, id);
    const revokeAuthOwner = cerbosOwnerId(row.owner_kind, row.owner_id);
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: revokeAuthOwner },
      connectionAction("delete", revokeAuthOwner, req.principal.userId ?? ""),
    );
    return revokeConnection(tenantId, id);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // VLT-3 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the reveal path. See
  // `connection-reveal.ts`'s header for the full design (why `automation_approvals` and not a new
  // table, why no new Cerbos action, why the redeem step is separate from decide()).
  //
  // FILE: any principal who could `update` this connection (self-owner, or manager+ for a company
  // row / someone else's) may ASK for a reveal — filing is not a promise of outcome, same as every
  // other automation_approval in this table (GH-12's own comment states the same for repo creation).
  // The REAL gate is at decide() time: a DIFFERENT principal, holding `manage` on this exact
  // connection, must approve — self-decision is refused there, never here.
  @Post(":tenantId/integrations/connections/:id/reveal-requests")
  @HttpCode(201)
  async requestReveal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    const row = await this.loadOrThrow(tenantId, id);
    if (!row.access_token_enc) {
      throw new BadRequestException("this connection has no stored credential to reveal");
    }
    const authOwner = cerbosOwnerId(row.owner_kind, row.owner_id);
    const me = req.principal.userId ?? "";
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: authOwner },
      connectionAction("update", authOwner, me),
    );
    if (!req.principal.userId) throw new BadRequestException("an authenticated user is required");
    return fileAutomationApproval({
      tenantId,
      workflowId: INTEGRATION_CONNECTION_REVEAL_WORKFLOW,
      toolName: INTEGRATION_CONNECTION_REVEAL_TOOL,
      toolArgs: { connectionId: id },
      impact: "high",
      reason: body?.reason ?? `reveal the stored credential for connection ${id}`,
      origin: "credential_reveal",
      requestedBy: req.principal.userId,
    });
  }

  /** REDEEM: the one-time, TTL'd, single-use step that actually decrypts. Requires an `approved`
   *  grant filed by THIS SAME principal (enforced inside `redeemConnectionReveal`, independent of
   *  Cerbos — Cerbos has no notion of "the row that filed a specific approval"). The plaintext is
   *  returned in this response body and NOWHERE else: never logged, never written to
   *  `execution_result`, never re-servable on a second call with the same `approvalId`. */
  @Post(":tenantId/integrations/connections/:id/reveal")
  @HttpCode(200)
  async redeemReveal(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { approvalId?: string },
  ) {
    const row = await this.loadOrThrow(tenantId, id);
    const authOwner = cerbosOwnerId(row.owner_kind, row.owner_id);
    const me = req.principal.userId ?? "";
    await authorize(
      req.principal,
      { kind: "integration_connection", id, tenantId, ownerId: authOwner },
      connectionAction("update", authOwner, me),
    );
    if (!req.principal.userId) throw new BadRequestException("an authenticated user is required");
    if (!body?.approvalId) throw new BadRequestException("approvalId is required");
    const outcome = await redeemConnectionReveal(tenantId, id, body.approvalId, req.principal.userId);
    if (!outcome.ok) throwForRevealDenial(outcome.reason);
    // Exactly ONE audit row per successful reveal. Metadata NEVER carries the plaintext — only the
    // grant it was authorized under, which is what the acceptance bar asks the audit trail to prove.
    await writeActivity(tenantId, req.principal.userId, "revealed", "integration_connection", id, {
      approvalId: body.approvalId,
    });
    return { connectionId: outcome.connectionId, revealedAt: outcome.revealedAt, value: outcome.value };
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
