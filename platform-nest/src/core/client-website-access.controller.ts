// WSK-49f / WSK-D60 (amended 2026-10-11) -- who may edit a client's website, and who may say so.
//
// Two endpoint families over ONE implementation, so the bounds cannot drift between them:
//
//   STAFF   /api/:tenantId/clients/:clientId/contacts/:contactId/website-editor   PUT | DELETE
//           /api/:tenantId/clients/:clientId/contacts/:contactId/admin            PUT | DELETE   (staff only)
//           /api/:tenantId/clients/:clientId/website-access                        GET
//   PORTAL  /api/:tenantId/portal/clients/:clientId/contacts/:contactId/website-editor   PUT | DELETE
//           /api/:tenantId/portal/clients/:clientId/website-access                        GET
//           (a client contact holding capability `admin` on THAT client; the website editor ONLY)
//
// ── THE ORDER IS THE SECURITY PROPERTY ──────────────────────────────────────────────────────────────
//   1. AUTHORIZE FIRST (Cerbos, `client_contact` . `manage_website_editor` | `manage_admin`). A caller who may
//      not act learns nothing about whether the contact exists.
//   2. THEN load the target contact on a tenant-scoped connection and verify it belongs to the client named
//      in the URL (RLS: another company's contact is simply not found). A contact id of ANOTHER client is a
//      404, never a write.
//   3. THEN write, in the SAME transaction as the audit row. A grant that committed without its audit row
//      cannot exist.
//
// ── WHAT A CLIENT ADMIN CANNOT DO, AND WHY IT IS STRUCTURAL ─────────────────────────────────────────
//   * There is no role, scope, permission or capability parameter on any portal route: the role is a literal
//     in the path (`website-editor`), the scope is the client in the path, and `grantClientWebsiteEditor()`
//     (the grant-write choke point) takes no role at all. Extra body fields are ignored, never read.
//   * `manage_admin` has no client-admin rule in Cerbos, so a client admin can never mint another admin.
//   * The portal route's Cerbos resource names the client, which is what lets the `client_contact_admin`
//     derived role match; the STAFF route deliberately sends no clientId, so a client admin hitting the
//     staff URL is denied (they use the portal one). Every portal handler also resolves the caller's
//     portal scope (`resolvePortalScope`) and requires the URL's client to be in it.
//   * The ceiling is re-checked in the choke point against the caller's own `clientAdminOf`.
//
// ── IDEMPOTENCY (chosen, not defaulted) ─────────────────────────────────────────────────────────────
// Granting twice, or revoking what is not held, is a no-op 200 with `changed: false` and NO second audit row.
// The audit trail records state changes, not requests; the write itself is `ON CONFLICT DO NOTHING ...
// RETURNING`, so two racing grants produce one row and one audit entry.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode,
  NotFoundException, Param, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { AuthGuard } from "../auth/guards";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { grantClientWebsiteEditor, revokeClientWebsiteEditor, CLIENT_WEBSITE_EDITOR_ROLE } from "../admin/grant-write.service";
import { authorize } from "./http";
import { currentApproval, currentVia } from "./request-context";
import { resolvePortalScope } from "./portal-scope";
import { clientContactInPortalScope } from "./portal-visibility";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuidParam(name: string, v: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`${name} must be a uuid`);
  return v;
}

interface ContactRow {
  id: string;
  client_id: string;
  user_id: string;
  project_id: string | null;
  capability: string;
  status: string;
  email: string;
  name: string | null;
}

/** The target contact, pinned to BOTH the tenant (RLS, via the caller's withTenants) and the client in the URL. */
async function loadContact(c: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<ContactRow> {
  const { rows } = await c.query<ContactRow>(
    `SELECT cc.id, cc.client_id, cc.user_id, cc.project_id, cc.capability, cc.status, u.email, u.name
       FROM client_contacts cc JOIN users u ON u.id = cc.user_id
      WHERE cc.id = $1 AND cc.client_id = $2 AND cc.tenant_id = $3 AND cc.deleted_at IS NULL`,
    [contactId, clientId, tenantId],
  );
  if (!rows[0]) throw new NotFoundException("contact not found for this client");
  return rows[0];
}

/** The audit row, written on the SAME connection (and therefore in the SAME transaction) as the change it
 *  records. Same columns and ambient stamping as `writeActivity()` (core/http.ts), which cannot join an
 *  existing transaction because it opens its own. */
export async function writeClientAccessAuditTx(
  c: PoolClient, tenantId: string, actorId: string | null, verb: string, contactId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const via = currentVia();
  const withVia = via && metadata.via === undefined ? { ...metadata, via } : metadata;
  const appr = currentApproval();
  await c.query(
    `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site,
                             approved_by, approval_channel, executed_by)
     VALUES ($1, $2, $3, $4, 'client_contact', $5, $6, $7, $8, $9, $10)`,
    [newId(), tenantId, actorId, verb, contactId, JSON.stringify(withVia), config.originSite,
     appr?.approvedBy ?? null, appr?.channel ?? null, appr?.executedBy ?? null],
  );
}

/** Revoking a role is a de-escalation: cut the target's live sessions (D11), as the other revoke surfaces do. */
async function bumpSession(userId: string): Promise<void> {
  await withGlobal((c) =>
    c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
  );
}

type Surface = "staff" | "portal";

async function setWebsiteEditor(
  req: FastifyRequest, tenantId: string, clientId: string, contactId: string, grant: boolean, surface: Surface,
) {
  const principal = req.principal;
  const result = await withTenants([tenantId], async (c) => {
    if (surface === "portal") {
      // The portal scope predicate, kept on every portal write: the URL's client must be one of the caller's
      // OWN clients (resolvePortalScope throws 403 "not a portal client" for anyone who is not a contact).
      const scope = await resolvePortalScope(c, principal);
      if (!scope.clientIds.includes(clientId)) throw new ForbiddenException("not a contact of this client");
    }
    const contact = await loadContact(c, tenantId, clientId, contactId);
    if (grant && contact.project_id !== null) {
      throw new BadRequestException("website_editor_is_client_wide: this contact row is scoped to one project");
    }
    const spec = {
      tenantId, clientId, targetUserId: contact.user_id, actorUserId: principal.userId,
      actorVia: surface === "portal" ? ("client_admin" as const) : ("staff" as const),
      actorClientAdminOf: principal.clientAdminOf,
    };
    const rowId = grant ? await grantClientWebsiteEditor(c, spec) : await revokeClientWebsiteEditor(c, spec);
    if (rowId) {
      await writeClientAccessAuditTx(c, tenantId, principal.userId, grant ? "client_website_editor.granted" : "client_website_editor.revoked", contactId, {
        clientId, contactId, targetUserId: contact.user_id, role: CLIENT_WEBSITE_EDITOR_ROLE, grantId: rowId,
        surface, actorKind: surface === "portal" ? "client_admin" : "staff",
      });
    }
    return { contact, changed: rowId !== null };
  });
  if (!grant && result.changed) await bumpSession(result.contact.user_id);
  return {
    clientId, contactId, userId: result.contact.user_id, role: CLIENT_WEBSITE_EDITOR_ROLE,
    websiteEditor: grant, changed: result.changed,
  };
}

async function listAccess(tenantId: string, clientId: string, surface: Surface, req: FastifyRequest) {
  return withTenants([tenantId], async (c) => {
    if (surface === "portal") {
      const scope = await resolvePortalScope(c, req.principal);
      if (!scope.clientIds.includes(clientId)) throw new ForbiddenException("not a contact of this client");
    }
    const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]);
    if (!client.rowCount) throw new NotFoundException("client not found");
    // The contact rule is the portal People one (portal-visibility.ts: not soft-deleted, not `revoked`), so an
    // `invited` contact is listed and staff can grant ahead of acceptance. This list is narrower than People in
    // one way only: client-wide contacts (`project_id IS NULL`, WSK-D60), because website access is per client.
    const { rows } = await c.query(
      `SELECT cc.id AS "contactId", cc.user_id AS "userId", u.name, u.email, cc.capability, cc.status,
              (cc.capability = 'admin') AS "isAdmin",
              EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = cc.user_id AND r.company_id IS NULL AND r.name = $3
                         AND ur.scope_type = 'client' AND ur.scope_id = cc.client_id::text) AS "websiteEditor"
         FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE ${clientContactInPortalScope("cc", { clients: 1 })} AND cc.tenant_id = $2
          AND cc.project_id IS NULL
        ORDER BY u.name, u.email`,
      [[clientId], tenantId, CLIENT_WEBSITE_EDITOR_ROLE],
    );
    return { clientId, role: CLIENT_WEBSITE_EDITOR_ROLE, contacts: rows };
  });
}

@Controller("api")
@UseGuards(AuthGuard)
export class ClientWebsiteAccessController {
  // ═══════════════════════════ STAFF ═══════════════════════════
  // NOTE: the resource below carries NO clientId on purpose. Only the portal routes feed it, because that is
  // what lets the `client_contact_admin` derived role match; here only the staff rules can.

  @Get(":tenantId/clients/:clientId/website-access")
  async staffList(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client_contact", tenantId }, "read");
    uuidParam("clientId", clientId);
    return listAccess(tenantId, clientId, "staff", req);
  }

  @Put(":tenantId/clients/:clientId/contacts/:contactId/website-editor")
  @HttpCode(200)
  async staffGrantEditor(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string,
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId }, "manage_website_editor");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    return setWebsiteEditor(req, tenantId, clientId, contactId, true, "staff");
  }

  @Delete(":tenantId/clients/:clientId/contacts/:contactId/website-editor")
  @HttpCode(200)
  async staffRevokeEditor(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string,
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId }, "manage_website_editor");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    return setWebsiteEditor(req, tenantId, clientId, contactId, false, "staff");
  }

  /** Assign the `admin` client-contact capability. STAFF ONLY (`manage_admin` has no client arm).
   *
   *  `admin` REPLACES `signer`/`viewer` in the single capability column and IMPLIES signer (owner ruling
   *  2026-10-11): every place that tests for a signer also accepts an admin (portal-scope `signerClientIds`,
   *  client-notify's signature recipients, canEditCentre). Promoting a signer therefore keeps their signing
   *  and needs no confirmation; the previous capability is recorded in the audit row. */
  @Put(":tenantId/clients/:clientId/contacts/:contactId/admin")
  @HttpCode(200)
  async staffGrantAdmin(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string,
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId }, "manage_admin");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    const result = await withTenants([tenantId], async (c) => {
      const contact = await loadContact(c, tenantId, clientId, contactId);
      if (contact.project_id !== null) {
        throw new BadRequestException("admin_is_client_wide: this contact row is scoped to one project");
      }
      if (contact.status === "revoked") throw new BadRequestException("contact_revoked: a revoked contact cannot be made admin");
      if (contact.capability === "admin") return { contact, changed: false };
      const upd = await c.query(
        `UPDATE client_contacts SET capability = 'admin', updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND capability = $4 AND deleted_at IS NULL`,
        [contactId, tenantId, clientId, contact.capability],
      );
      if (!upd.rowCount) throw new ConflictException("contact changed concurrently; retry");
      await writeClientAccessAuditTx(c, tenantId, req.principal.userId, "client_contact.admin_granted", contactId, {
        clientId, contactId, targetUserId: contact.user_id, previousCapability: contact.capability, surface: "staff",
      });
      return { contact, changed: true };
    });
    return { clientId, contactId, userId: result.contact.user_id, capability: "admin", changed: result.changed };
  }

  /** Remove the `admin` capability. The target capability is explicit: `{ "to": "signer" | "viewer" }`, default
   *  `viewer` (least privilege). The prior capability is not stored, so a FORMER SIGNER must be re-made a signer
   *  deliberately (`to: "signer"`); omitting `to` never mints signing authority. */
  @Delete(":tenantId/clients/:clientId/contacts/:contactId/admin")
  @HttpCode(200)
  async staffRevokeAdmin(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string, @Body() body?: { to?: string },
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId }, "manage_admin");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    const to = body?.to ?? "viewer";
    if (to !== "signer" && to !== "viewer") throw new BadRequestException("to must be 'signer' or 'viewer'");
    const result = await withTenants([tenantId], async (c) => {
      const contact = await loadContact(c, tenantId, clientId, contactId);
      if (contact.capability !== "admin") return { contact, changed: false };
      const upd = await c.query(
        `UPDATE client_contacts SET capability = $4, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND capability = 'admin' AND deleted_at IS NULL`,
        [contactId, tenantId, clientId, to],
      );
      if (!upd.rowCount) return { contact, changed: false };
      await writeClientAccessAuditTx(c, tenantId, req.principal.userId, "client_contact.admin_revoked", contactId, {
        clientId, contactId, targetUserId: contact.user_id, restoredCapability: to, surface: "staff",
      });
      return { contact, changed: true };
    });
    if (result.changed) await bumpSession(result.contact.user_id);
    return { clientId, contactId, userId: result.contact.user_id, capability: result.changed ? to : result.contact.capability, changed: result.changed };
  }

  // ═══════════════════════════ PORTAL (client admin) ═══════════════════════════
  // The resource names the client (`clientId`): that is what lets `client_contact_admin` match, and only for
  // the client the caller administers. Staff roles also pass this rule, but then fail the portal scope check
  // (and the choke point's `client_admin` ceiling) because staff are not contacts of the client.

  @Get(":tenantId/portal/clients/:clientId/website-access")
  async portalList(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client_contact", tenantId, clientId }, "manage_website_editor");
    uuidParam("clientId", clientId);
    return listAccess(tenantId, clientId, "portal", req);
  }

  @Put(":tenantId/portal/clients/:clientId/contacts/:contactId/website-editor")
  @HttpCode(200)
  async portalGrantEditor(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string,
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId, clientId }, "manage_website_editor");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    return setWebsiteEditor(req, tenantId, clientId, contactId, true, "portal");
  }

  @Delete(":tenantId/portal/clients/:clientId/contacts/:contactId/website-editor")
  @HttpCode(200)
  async portalRevokeEditor(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("contactId") contactId: string,
  ) {
    await authorize(req.principal, { kind: "client_contact", id: contactId, tenantId, clientId }, "manage_website_editor");
    uuidParam("clientId", clientId); uuidParam("contactId", contactId);
    return setWebsiteEditor(req, tenantId, clientId, contactId, false, "portal");
  }
}
