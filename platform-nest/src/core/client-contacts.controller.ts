// W0-4 — the PM-facing client-contact surface plus the public invite-acceptance route.
//
// Owner decisions this implements (2026-08-03):
//   D-1  contacts are one OR several per client, scoped per project        -> client_contacts (0072)
//   D-2  a PM delegates internally AND starts the external setup          -> manager-tier authz
//   D-3  clients get access BEFORE the meeting, so everyone is trackable  -> no recording required
//   A+C  magic-link invite whose acceptance PROVISIONS a Keycloak account -> accept() below
//
// ── WHAT A WORKING PORTAL CONTACT ACTUALLY NEEDS ─────────────────────────────────────────────────
// Five things, and only the first had a write path before this file existed:
//   1. a `users` row                              — created here at invite time (no idp_subject yet)
//   2. a `roles` row named `client`                — seeded by migration 0072 (it had NEVER existed)
//   3. a `user_roles` grant of `client` @ company  — granted here on ACCEPT
//   4. a tenant in `principal.companies`           — from client_contacts, via the union in principal.ts
//   5. a Keycloak account                          — provisioned here on ACCEPT
// Miss any one and the contact authenticates and is then refused everything with nothing to say why.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";

import { AuthGuard } from "../auth/guards";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { authorize, notify, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { createInvite, consumeInvite, generatePassword } from "./client-invites";
import {
  createUser as kcCreateUser,
  findUserByEmail as kcFindUserByEmail,
  setPassword as kcSetPassword,
  disableUser as kcDisableUser,
  enableUser as kcEnableUser,
  KeycloakUserExistsError,
} from "./keycloak-admin";

interface ContactRow {
  id: string;
  client_id: string;
  user_id: string;
  project_id: string | null;
  capability: string;
  status: string;
  email: string;
  name: string | null;
  invited_at: string;
  activated_at: string | null;
}

/** The masked shape every response uses. No token, no password, and `hasAccount` rather than any
 *  credential detail — the same discipline the connections vault applies with `hasToken`. */
function view(r: ContactRow & { has_account?: boolean }) {
  return {
    id: r.id,
    clientId: r.client_id,
    userId: r.user_id,
    projectId: r.project_id,
    capability: r.capability,
    status: r.status,
    email: r.email,
    name: r.name,
    invitedAt: r.invited_at,
    activatedAt: r.activated_at,
    hasAccount: r.has_account === true,
  };
}

const SELECT_CONTACT = `
  SELECT cc.id, cc.client_id, cc.user_id, cc.project_id, cc.capability, cc.status,
         cc.invited_at, cc.activated_at, u.email, u.name,
         (u.idp_subject IS NOT NULL) AS has_account
    FROM client_contacts cc JOIN users u ON u.id = cc.user_id
   WHERE cc.deleted_at IS NULL`;

@Controller("api")
@UseGuards(AuthGuard)
export class ClientContactsController {
  // ---- List ----
  @Get(":tenantId/clients/:clientId/contacts")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string) {
    await authorize(req.principal, { kind: "client_contact", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<ContactRow>(`${SELECT_CONTACT} AND cc.client_id = $1 ORDER BY cc.invited_at`, [clientId]),
    );
    return rows.rows.map(view);
  }

  // ---- Invite ----
  @Post(":tenantId/clients/:clientId/contacts")
  @HttpCode(201)
  async invite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("clientId") clientId: string,
    @Body() body: { email?: string; name?: string; capability?: string; projectId?: string | null },
  ) {
    await authorize(req.principal, { kind: "client_contact", tenantId }, "create");

    const email = String(body?.email ?? "").trim().toLowerCase();
    // Intentionally a shape check, not an RFC-5322 validator: the address's real proof is that someone
    // reachable at it consumes the token. A regex that rejects valid exotic addresses would be worse
    // than one that lets a typo through, because a typo simply never gets accepted.
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException("a valid email is required");
    const capability = body?.capability ?? "viewer";
    if (capability !== "signer" && capability !== "viewer") {
      throw new BadRequestException("capability must be 'signer' or 'viewer'");
    }
    const projectId = body?.projectId ?? null;

    const clientRow = await withTenants([tenantId], (c) =>
      c.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]),
    );
    if (!clientRow.rows[0]) throw new NotFoundException("client not found");
    if (projectId) {
      const p = await withTenants([tenantId], (c) =>
        c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]),
      );
      // Resolved through the SAME tenant-scoped connection, so a project id from another tenant matches
      // zero rows rather than being accepted by an FK check (FK checks run as the table owner, OUTSIDE
      // RLS — the hazard 0072's header documents).
      if (!p.rowCount) throw new NotFoundException("project not found in this tenant");
    }

    // The platform user row is global (users has no tenant), so find-or-create outside withTenants.
    // Find-or-create rather than create: the same person may already be staff, or a contact of another
    // client, and minting a second users row for one human is how an identity model rots.
    const userId = await withGlobal(async (c) => {
      const found = await c.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email]);
      if (found.rows[0]) return found.rows[0].id;
      const id = newId();
      await c.query(`INSERT INTO users (id, email, name, origin_site) VALUES ($1, $2, $3, $4)`, [
        id,
        email,
        String(body?.name ?? email.split("@")[0]),
        config.originSite,
      ]);
      return id;
    });

    const result = await withTenants([tenantId], async (c: PoolClient) => {
      // Re-inviting a known contact must not duplicate the row (0072's partial uniques would refuse
      // it anyway); adopt and reset it to `invited` so a revoked contact can be brought back.
      const existing = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM client_contacts
          WHERE client_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
        [clientId, userId, projectId],
      );
      let contactId: string;
      if (existing.rows[0]) {
        contactId = existing.rows[0].id;
        await c.query(
          `UPDATE client_contacts
              SET status = 'invited', capability = $2, invited_by = $3, invited_at = now(),
                  revoked_at = NULL, updated_at = now()
            WHERE id = $1`,
          [contactId, capability, req.principal.userId],
        );
      } else {
        contactId = newId();
        await c.query(
          `INSERT INTO client_contacts
             (id, tenant_id, client_id, user_id, project_id, capability, status, invited_by, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'invited', $7, $8)`,
          [contactId, tenantId, clientId, userId, projectId, capability, req.principal.userId, config.originSite],
        );
      }
      const invite = await createInvite({ tenantId, clientContactId: contactId, email, invitedBy: req.principal.userId }, c);
      await emitEvent(c, tenantId, "client_contact", contactId, "client_contact.invited", {
        clientId,
        projectId,
        capability,
        actorId: req.principal.userId,
      });
      return { contactId, invite };
    });

    await writeActivity(tenantId, req.principal.userId, "invited_client_contact", "client_contact", result.contactId, {
      clientId,
      capability,
    });

    const row = await withTenants([tenantId], (c) =>
      c.query<ContactRow>(`${SELECT_CONTACT} AND cc.id = $1`, [result.contactId]),
    );

    // ⚠ The RAW token is returned HERE AND NOWHERE ELSE. It is stored only as a sha256 hash, so it
    // cannot be re-read or re-sent — a lost link means issuing a new invite. There is no email
    // transport in this estate (verified: no mail dependency anywhere), so W0 hands the link to the PM
    // to forward. Automated send is a later change that does not alter this contract.
    return {
      contact: view(row.rows[0]),
      invite: {
        token: result.invite.token,
        expiresAt: result.invite.expiresAt,
        acceptPath: `/invite/${result.invite.token}`,
      },
    };
  }

  // ---- Revoke ----
  @Post(":tenantId/client-contacts/:id/revoke")
  @HttpCode(200)
  async revoke(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "client_contact", id, tenantId }, "revoke");

    const row = await withTenants([tenantId], (c) =>
      c.query<ContactRow>(`${SELECT_CONTACT} AND cc.id = $1`, [id]),
    );
    const contact = row.rows[0];
    if (!contact) throw new NotFoundException("contact not found");

    await withTenants([tenantId], async (c) => {
      await c.query(
        `UPDATE client_contacts SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
      // Kill any invite that has not been used, or a revoked contact could still accept an old link.
      await c.query(
        `UPDATE client_invites SET consumed_at = now() WHERE client_contact_id = $1 AND consumed_at IS NULL`,
        [id],
      );
      await emitEvent(c, tenantId, "client_contact", id, "client_contact.revoked", { actorId: req.principal.userId });
    });

    // Disable at the IdP too — the platform side alone would still let them hold a live session until
    // it expired. Best-effort and AFTER the local revoke: the local state is authoritative, and a
    // Keycloak hiccup must not leave the contact active on our side. Reported, never swallowed.
    let idpDisabled = false;
    let idpError: string | null = null;
    const stillElsewhere = await withGlobal((c) =>
      c.query(
        `SELECT 1 FROM client_contacts WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
        [contact.user_id],
      ),
    );
    // Only disable the account if this was their LAST active contact row anywhere. The same person may
    // be a stakeholder on another client or project; revoking one engagement must not lock them out of
    // the others.
    if (!stillElsewhere.rowCount) {
      try {
        const kc = await kcFindUserByEmail(contact.email);
        if (kc) {
          await kcDisableUser(kc.id);
          idpDisabled = true;
        }
      } catch (e) {
        idpError = String((e as Error)?.message ?? e).slice(0, 200);
      }
    }

    await writeActivity(tenantId, req.principal.userId, "revoked_client_contact", "client_contact", id, { idpDisabled });
    return { id, status: "revoked", idpDisabled, idpError, keptAccountForOtherEngagements: !!stillElsewhere.rowCount };
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The PUBLIC accept route — deliberately its own controller with NO AuthGuard
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WHY UNAUTHENTICATED, STATED PLAINLY: the person clicking has no account yet — creating it is the
// whole point — so there is no session, no bearer token and no `:tenantId` they could supply. Every
// other route in this file is guarded; this one's ONLY authority is the invite token, which is why
// client-invites.ts carries a published attack list (forgery, replay, wrong-address redemption,
// leaked-DB redemption, indefinite validity, cross-tenant read) and why the tenant travels inside the
// token's HMAC rather than in the URL.
//
// It is a separate @Controller class rather than a route exception because a guard is applied per
// controller in Nest: leaving it in the class above and trying to exempt one route is exactly the kind
// of arrangement that silently loses its exemption — or silently loses the guard on its siblings.
@Controller("api")
export class ClientInviteAcceptController {
  // ⚠ THE TOKEN TRAVELS IN THE BODY, NOT THE PATH. Two independent reasons, and the first one is a bug
  // this route actually had:
  //
  //  1. ROUTING. A real token is `inv1.<b64url(uuid)>.<b64url(uuid)>.<b64url(32-byte hmac)>` = **146
  //     characters**, measured. Fastify's router (find-my-way) refuses to match a `:param` segment
  //     longer than `maxParamLength`, which defaults to **100** and is not overridden anywhere in
  //     main.ts. As `POST invites/:token/accept` this route therefore 404'd at the raw router — before
  //     Nest, DI or this controller were reached — for EVERY invite it has ever minted. The magic-link
  //     flow was dead on arrival, and the symptom (a 404) looks nothing like the cause.
  //     Raising maxParamLength would also work, but it just moves the ceiling: a longer tenant id or a
  //     future token revision would silently re-break it.
  //  2. SECRET HYGIENE. The token is bearer-equivalent — it grants account creation. In a URL it lands
  //     in web-server access logs, proxy logs, `Referer` headers and browser history. A request body
  //     does not get logged by default anywhere in this stack.
  //
  // The magic LINK still carries the token, because a link must: it points at the FRONT-END page
  // `/invite/<token>` (what `invite.acceptPath` returns), and that page reads the token off its own URL
  // and POSTs it here in the body. So the token is in a URL exactly once — in the user's browser — and
  // never in ours.
  @Post("invites/accept")
  @HttpCode(200)
  async accept(@Body() body: { token?: string; password?: string; name?: string }) {
    const token = String(body?.token ?? "");
    if (!token) throw new BadRequestException("token is required");
    // Consumes the token atomically FIRST: single-use is enforced before any account work, so two
    // concurrent clicks cannot both provision.
    const invite = await consumeInvite(token);
    const password = String(body?.password ?? "").trim() || generatePassword();
    if (password.length < 10) throw new BadRequestException("password must be at least 10 characters");

    const contact = await withTenants([invite.tenantId], (c) =>
      c.query<{ id: string; user_id: string; client_id: string; status: string }>(
        `SELECT id, user_id, client_id, status FROM client_contacts WHERE id = $1 AND deleted_at IS NULL`,
        [invite.clientContactId],
      ),
    );
    const cc = contact.rows[0];
    if (!cc) throw new NotFoundException("invitation is no longer valid");
    // A contact revoked between issue and acceptance must not be able to complete. (The revoke path
    // also spends open invites, so this is defence in depth rather than the only guard.)
    if (cc.status === "revoked") throw new BadRequestException("this invitation has been withdrawn");

    // ---- Provision the IdP account ----
    // emailVerified:true is set inside kcCreateUser and is load-bearing: `provisionUser()` refuses to
    // link a first login to this pre-existing users row unless the IdP says the address is verified.
    // Consuming a token delivered to that address is what makes the flag honest.
    let kcUserId: string;
    try {
      kcUserId = await kcCreateUser({ email: invite.email, password });
    } catch (e) {
      if (e instanceof KeycloakUserExistsError) {
        // ADOPT rather than fail: the same human may already have an account (staff, or a contact of
        // another client). Re-enable it and set the password they just chose.
        const existing = await kcFindUserByEmail(invite.email);
        if (!existing) throw e;
        kcUserId = existing.id;
        await kcEnableUser(kcUserId);
        await kcSetPassword(kcUserId, password);
      } else {
        throw e;
      }
    }

    // ---- Activate on the platform side ----
    await withTenants([invite.tenantId], async (c) => {
      await c.query(
        `UPDATE client_contacts SET status = 'active', activated_at = now(), updated_at = now() WHERE id = $1`,
        [cc.id],
      );
      await emitEvent(c, invite.tenantId, "client_contact", cc.id, "client_contact.activated", {
        clientId: cc.client_id,
        actorExternal: "client-invite-accept",
      });
    });

    // ---- Grant the `client` role, or the portal still refuses everything ----
    // `resource_portal.yaml` grants its actions to the derived role `client`, and derived_roles.yaml
    // defines that as a grant NAMED `client` at company scope. Without this row the contact has a
    // tenant (via the client_contacts union in principal.ts) but no role, so every portal action is
    // denied. The role itself is seeded by 0072 — it had never existed in the codebase.
    await withGlobal(async (c) => {
      const role = await c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`);
      if (!role.rows[0]) return; // 0072 seeds it; a missing row is a deployment fault, not this request's
      await c.query(
        `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
         VALUES ($1, $2, $3, 'company', $4)
         ON CONFLICT DO NOTHING`,
        [newId(), cc.user_id, role.rows[0].id, invite.tenantId],
      );
    });

    // Tell the inviting side it landed. This works only because notify() was widened to accept client
    // contacts (W0-2) — before that every client-facing notification vanished silently.
    await notify(invite.tenantId, cc.user_id, null, "client_contact.activated", {
      title: "Your client portal access is active",
      href: "/portal",
    });

    return { ok: true, email: invite.email, status: "active", portalPath: "/portal" };
  }
}
