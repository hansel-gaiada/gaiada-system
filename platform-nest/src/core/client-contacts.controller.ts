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
  ConflictException,
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
import { insertGrantRow, revokeClientWebsiteEditor, CLIENT_WEBSITE_EDITOR_ROLE } from "../admin/grant-write.service";
import { writeClientAccessAuditTx } from "./client-website-access.controller";
import {
  createInvite,
  createMailInvite,
  consumeInvite,
  convertMailInviteToLink,
  generatePassword,
  spendOpenInvites,
} from "./client-invites";
import { enqueueMail } from "../mail/queue";
import { CLIENT_INVITE_TEMPLATE } from "../mail/invite-mail";
import { clientContactClientVisible, staffClientVisible } from "./portal-visibility";
import {
  createUser as kcCreateUser,
  findUserByEmail as kcFindUserByEmail,
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
 *  credential detail — the same discipline the connections vault applies with `hasToken`.
 *  PV3-07: `clientVisible` = the portal People area lists this contact to the client's contacts
 *  (computed in SQL by SELECT_CONTACT from portal-visibility.ts; a revoked contact reads `false`). */
function view(r: ContactRow & { has_account?: boolean; client_visible?: boolean }) {
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
    clientVisible: r.client_visible === true,
  };
}

const SELECT_CONTACT = `
  SELECT cc.id, cc.client_id, cc.user_id, cc.project_id, cc.capability, cc.status,
         cc.invited_at, cc.activated_at, u.email, u.name,
         (u.idp_subject IS NOT NULL) AS has_account,
         ${staffClientVisible("cc", clientContactClientVisible("cc"))} AS client_visible
    FROM client_contacts cc JOIN users u ON u.id = cc.user_id
   WHERE cc.deleted_at IS NULL`;

/** The only global roles a portal contact ever holds: `client` (granted on accept) and `client_website_editor`
 *  (granted through the dedicated client-scope path). Anyone holding any OTHER role is not a portal-only identity. */
const CLIENT_CONTACT_ROLES = ["client", CLIENT_WEBSITE_EDITOR_ROLE];

/** True when this platform user is, or ever was, STAFF or holds anything beyond a client contact's access: any
 *  `company_memberships` row ever (every status, deleted rows included, so ex-staff are covered) or any role grant
 *  other than the client-contact roles. Must run on a `withPrincipalLookup` connection: `company_memberships` is
 *  FORCE RLS, and without the GUC it reads zero rows and calls everyone portal-only. `user_roles` has no RLS. */
async function holdsStaffIdentity(c: PoolClient, userId: string): Promise<boolean> {
  const m = await c.query(`SELECT 1 FROM company_memberships WHERE user_id = $1 LIMIT 1`, [userId]);
  if (m.rowCount) return true;
  const r = await c.query(
    `SELECT 1 FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id
      WHERE ur.user_id = $1 AND NOT (ro.company_id IS NULL AND ro.name = ANY($2::text[])) LIMIT 1`,
    [userId, CLIENT_CONTACT_ROLES],
  );
  return !!r.rowCount;
}

/** Run `fn` in its own transaction with `app.principal_user_id` set (transaction-local) to `userId`, so the
 *  `principal_lookup` policies (company_memberships 0001/0004, client_contacts 0072 §7b) admit exactly that one
 *  user's rows across ALL tenants. `client_contacts` and `company_memberships` are FORCE RLS: a bare `withGlobal`
 *  connection sets neither GUC and reads ZERO rows, not an error. Never a session-level SET: it would leak to the
 *  next request on this pooled connection. Same shape as `assemblePrincipal()` and step-up's `staffCompanies()`. */
async function withPrincipalLookup<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const r = await fn(c);
      await c.query("COMMIT");
      return r;
    } catch (e) {
      try { await c.query("ROLLBACK"); } catch { /* connection already gone; keep the original error */ }
      throw e;
    }
  });
}

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
    @Body() body: { email?: string; name?: string; capability?: string; projectId?: string | null; delivery?: string },
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
    // PGL-10 (BFF §62.5): `delivery` is the PM's choice. "link" (the default, today's behaviour) returns the link to
    // forward by hand; "mail" sends the invitation by mail, only when BOTH mail gates are on (MAIL_ENABLED and
    // CLIENT_MAIL_ENABLED). With either off the route answers exactly as for "link" and says it was not mailed.
    const delivery = body?.delivery ?? "link";
    if (delivery !== "link" && delivery !== "mail") throw new BadRequestException("delivery must be 'link' or 'mail'");
    const mailRequested = delivery === "mail";
    const mailOn = config.mail.enabled && config.mail.clientMailEnabled;
    const mailPath = mailRequested && mailOn;

    const clientRow = await withTenants([tenantId], (c) =>
      c.query<{ id: string; name: string }>(`SELECT id, name FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]),
    );
    if (!clientRow.rows[0]) throw new NotFoundException("client not found");
    if (projectId) {
      const p = await withTenants([tenantId], (c) =>
        c.query(`SELECT 1 FROM projects WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`, [projectId, clientId]),
      );
      // Resolved through the SAME tenant-scoped connection, so a project id from another tenant matches
      // zero rows rather than being accepted by an FK check (FK checks run as the table owner, OUTSIDE
      // RLS — the hazard 0072's header documents).
      // PV4-13: the project must also belong to THIS client. A contact row naming another client's project
      // would be read by the portal scope kernel as a reach into that project; the composite FK
      // fk_client_contacts_project_client_tenant now refuses it too, but the answer here is a 404, not a 500.
      if (!p.rowCount) throw new NotFoundException("project not found for this client");
    }

    // The platform user row is global (users has no tenant), so find-or-create outside withTenants.
    // Find-or-create rather than create: the same person may already be staff, or a contact of another
    // client, and minting a second users row for one human is how an identity model rots.
    const userId = await withGlobal(async (c) => {
      const found = await c.query<{ id: string; kind: string }>(`SELECT id, kind FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email]);
      // M5-W1d: a freelance contributor is a different principal class on the other side of the staff/client boundary, and
      // the two invites are siblings, never one another's widening: a client invite never adopts a contributor (and the
      // contributor invite never adopts a client contact). The DB trigger `client_contacts_contributor_guard` refuses the
      // row anyway; this is the typed answer in front of it. Nothing has been written at this point.
      if (found.rows[0]?.kind === "contributor") {
        throw new ConflictException({
          message: "this address belongs to a freelance contributor, who cannot also be a client contact",
          reason: "contributor_cannot_be_client_contact",
        });
      }
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
      // PV5-F4: but NEVER an ACTIVE one. Resetting it to `invited` would cut the person off until they accept again
      // and would mint a second token for a login that already works. Nothing is changed; there is no route that edits
      // a contact's capability in place, so changing it means revoking the contact and inviting again.
      const existing = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM client_contacts
          WHERE client_id = $1 AND user_id = $2 AND project_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
        [clientId, userId, projectId],
      );
      let contactId: string;
      if (existing.rows[0]?.status === "active") {
        throw new ConflictException({
          message: "this contact already has access, so it was not invited again and nothing changed. To change what they may do, revoke the contact and invite them again.",
          reason: "already_active",
          // `existing` is the one object the error filter forwards (http-error.filter.ts); a bare top-level field is dropped.
          existing: { contactId: existing.rows[0].id },
        });
      }
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
      // PGL-10: a re-invite is a RESEND. Every open invite of this contact is spent first, in this transaction, so
      // the contact holds at most ONE usable invitation: the old link (or a mail still queued for it) stops working.
      await spendOpenInvites(c, contactId);
      const inviteInput = { tenantId, clientContactId: contactId, email, invitedBy: req.principal.userId };
      // Mail: a SEALED invite and no token at all here (the sender mints it when it composes the mail).
      const invite = mailPath
        ? { ...(await createMailInvite(inviteInput, c)), token: null as string | null }
        : await createInvite(inviteInput, c);
      // The event carries the delivery the PM chose, never a token.
      await emitEvent(c, tenantId, "client_contact", contactId, "client_contact.invited", {
        clientId,
        projectId,
        capability,
        actorId: req.principal.userId,
        delivery: mailPath ? "mail" : "link",
      });
      const company = await c.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [tenantId]);
      return { contactId, invite, userId, companyName: company.rows[0]?.name ?? null };
    });

    // PGL-10: hand the mail invite to the queue AFTER the invite commits (mail_log lives behind its own RLS context).
    // The stored payload is a REFERENCE (the invite id) plus the two names and the expiry: never a link, never a token
    // (enqueueMail refuses anything else for this template). If the mail cannot be queued (the address is suppressed,
    // or the enqueue failed), the route falls back to the hand-forwarded link on the SAME invite, so the PM is never
    // left with an invitation nobody can use.
    let token: string | null = result.invite.token;
    let mail: { requested: boolean; mailed: boolean; reason: string | null; mailLogId: string | null } = {
      requested: mailRequested,
      mailed: false,
      reason: mailRequested ? (mailOn ? null : "mail_off") : "not_requested",
      mailLogId: null,
    };
    if (mailPath) {
      let queued: { id: string; status: string } | null = null;
      let reason: string | null = null;
      try {
        const r = await enqueueMail({
          stream: "notify",
          templateKey: CLIENT_INVITE_TEMPLATE,
          toEmail: email,
          tenantId,
          userId: result.userId,
          withReplyToken: false,
          payload: {
            inviteId: result.invite.inviteId,
            companyName: result.companyName ?? undefined,
            clientName: clientRow.rows[0].name,
            expiresAt: result.invite.expiresAt,
          },
        });
        if (r.skipped) reason = "mail_off";
        else if (r.status === "suppressed") reason = "suppressed";
        else queued = { id: r.id, status: r.status };
      } catch (e) {
        reason = "enqueue_failed";
        // Ids and the error only: no token exists on this path.
        console.error(`[client-contacts] invite mail could not be queued (contact=${result.contactId}):`, (e as Error)?.message ?? e);
      }
      if (queued) {
        mail = { requested: true, mailed: true, reason: null, mailLogId: queued.id };
      } else {
        token = await convertMailInviteToLink(tenantId, result.invite.inviteId);
        mail = { requested: true, mailed: false, reason, mailLogId: null };
      }
    }

    await writeActivity(tenantId, req.principal.userId, "invited_client_contact", "client_contact", result.contactId, {
      clientId,
      capability,
      delivery: mail.mailed ? "mail" : "link",
    });

    const row = await withTenants([tenantId], (c) =>
      c.query<ContactRow>(`${SELECT_CONTACT} AND cc.id = $1`, [result.contactId]),
    );

    // ⚠ The RAW token is returned HERE AND NOWHERE ELSE, and only for a hand-forwarded invite. It is stored only as a
    // sha256 hash, so it cannot be re-read or re-sent: a lost link means issuing a new invite. A MAILED invite returns
    // no token at all: the link goes only to the invitee's mailbox, which is what makes the IdP's emailVerified flag
    // honest on accept (the PM never holds a mailed credential). `mail` says whether it was mailed (BFF §62.5).
    return {
      contact: view(row.rows[0]),
      invite: token
        ? { delivery: "link" as const, token, expiresAt: result.invite.expiresAt, acceptPath: `/invite/${token}` }
        : { delivery: "mail" as const, expiresAt: result.invite.expiresAt },
      mail,
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
      // WSK-49f: a revoked contact keeps no website-editor grant. It would already be inert (assemblePrincipal
      // drops a client-scoped grant whose holder is not an ACTIVE client-wide contact), but a dormant grant
      // would silently come back to life if the contact were ever re-invited, so it is deleted here and the
      // deletion is audited in the same transaction. Only a client-wide row can hold one.
      if (contact.project_id === null) {
        const grantId = await revokeClientWebsiteEditor(c, {
          tenantId, clientId: contact.client_id, targetUserId: contact.user_id,
          actorUserId: req.principal.userId, actorVia: "staff",
        });
        if (grantId) {
          await writeClientAccessAuditTx(c, tenantId, req.principal.userId, "client_website_editor.revoked", id, {
            clientId: contact.client_id, contactId: id, targetUserId: contact.user_id, role: CLIENT_WEBSITE_EDITOR_ROLE,
            grantId, surface: "staff", reason: "contact_revoked",
          });
        }
      }
    });

    // Disable at the IdP too — the platform side alone would still let them hold a live session until
    // it expired. Best-effort and AFTER the local revoke: the local state is authoritative, and a
    // Keycloak hiccup must not leave the contact active on our side. Reported, never swallowed.
    let idpDisabled = false;
    let idpError: string | null = null;
    //
    // ⚠ THE RLS ZERO-ROW TRAP (found live 2026-10-13): `client_contacts` is FORCE RLS, and a bare `withGlobal`
    // connection sets neither `app.current_tenant_ids` nor `app.principal_user_id`, so this read saw ZERO rows
    // for everyone. `stillElsewhere` was always empty and EVERY revoke disabled the person's Keycloak account,
    // even when they held an active contact on another client (the owner's own account is one such person).
    // The sanctioned cross-tenant read is the `principal_lookup` policy (0072 §7b): it admits exactly the rows
    // of the ONE user named in `app.principal_user_id`, across all tenants (see `withPrincipalLookup`).
    const stillElsewhere = await withPrincipalLookup(contact.user_id, (c) =>
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
  //  1. ROUTING. A real v1 token was `inv1.<b64url(uuid)>.<b64url(uuid)>.<b64url(32-byte hmac)>` = **146
  //     characters**, measured (a v2 token, PGL-10, adds a 16-byte nonce segment: about 170). Fastify's router (find-my-way) refuses to match a `:param` segment
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
    //
    // ⚠ ACCOUNT TAKEOVER, closed here (2026-10-13). A token proves control of an INVITATION, never of an
    // ACCOUNT or of the mailbox. The invite route lets any company manager invite ANY email (`users` are
    // global, and most staff rows have no Keycloak account yet) and even re-invite an ACTIVE contact, and the
    // raw token is handed back to that same manager (there is no email transport). Two ways in existed:
    //   a. the platform user is STAFF with no Keycloak account: accepting CREATED one (verified email, chosen
    //      password), and the first login then linked it to the staff row with all its memberships and roles;
    //   b. a Keycloak account already existed: accepting ADOPTED it (enable + set the body's password).
    // So the identity is decided FIRST, before anything touches Keycloak:
    //   - STAFF (`holdsStaffIdentity`: any `company_memberships` row ever, deleted rows included, or any role
    //     beyond the client-contact roles): Keycloak is never created, enabled or given a password by an invite.
    //     Staff logins are IT's job. The contact is still activated (it gives the inviter nothing).
    //   - PORTAL-ONLY, no Keycloak user: created with the chosen password (the new client's own first login).
    //   - PORTAL-ONLY, Keycloak user exists: NEVER a password; re-enabled only when they hold no other ACTIVE
    //     contact (a revoke disables the login, and the inviter learns no credential from re-enabling it).
    // All reads run under `principal_lookup` (`company_memberships` is FORCE RLS: a bare `withGlobal` would see
    // zero rows and call every staff member portal-only, the same trap as revoke).
    //
    // `accountPath` records which branch ran (it goes into the activation event; NEVER a password):
    //   created                no Keycloak user existed: made one with the chosen password
    //   existing_kept          a Keycloak user existed: left exactly as it was
    //   existing_reenabled     a Keycloak user existed for a portal-only identity: re-enabled, nothing else
    //   staff_not_provisioned  a staff identity with no Keycloak user: none created
    const access = await withPrincipalLookup(cc.user_id, async (c) => ({
      staff: await holdsStaffIdentity(c, cc.user_id),
      // Another ACTIVE contact elsewhere means a Keycloak account of theirs is in live use: leave it alone too.
      otherActiveContact: !!(
        await c.query(
          `SELECT 1 FROM client_contacts WHERE user_id = $1 AND id <> $2 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
          [cc.user_id, cc.id],
        )
      ).rowCount,
    }));
    let accountPath: "created" | "existing_kept" | "existing_reenabled" | "staff_not_provisioned" = "created";
    if (access.staff) {
      accountPath = (await kcFindUserByEmail(invite.email)) ? "existing_kept" : "staff_not_provisioned";
    } else {
      try {
        await kcCreateUser({ email: invite.email, password });
      } catch (e) {
        if (!(e instanceof KeycloakUserExistsError)) throw e;
        const existing = await kcFindUserByEmail(invite.email);
        if (!existing) throw e;
        // NEVER `kcSetPassword` here: the body's password is ignored for every existing account (a person who
        // forgot theirs asks the project manager to reset it).
        if (access.otherActiveContact) {
          accountPath = "existing_kept";
        } else {
          accountPath = "existing_reenabled";
          await kcEnableUser(existing.id);
        }
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
        accountPath,
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
      // P2-04: routed through the ONE `user_roles` choke point as a TRUSTED_INTERNAL caller —
      // same statement, same untargeted conflict clause. No caller-choice validation runs, and
      // that is correct here: the role is looked up by the LITERAL name 'client' immediately
      // above (never a caller-supplied roleId) and the scope is hardcoded 'company'/this invite's
      // own tenant, so a client contact accepting their own portal invite cannot steer either.
      //
      // ⚠ This is ALSO precisely why it cannot take the `ui` origin: `client`'s bundle is the 7
      // `portal.*` keys, every one of them `ui_grantable = false`, and `client` sits on the
      // elevated fence — the allow-list and the fence exist to keep a STAFF role out of the
      // client portal, not to break the one legitimate path that puts a client contact in it.
      await insertGrantRow(c, {
        origin: "trusted_internal",
        targetUserId: cc.user_id,
        roleId: role.rows[0].id,
        scopeType: "company",
        scopeId: invite.tenantId,
        onConflict: "untargeted",
      });
    });

    // Tell the inviting side it landed. This works only because notify() was widened to accept client
    // contacts (W0-2) — before that every client-facing notification vanished silently.
    await notify(invite.tenantId, cc.user_id, null, "client_contact.activated", {
      title: "Your client portal access is active",
      href: "/portal",
    });

    // `existingAccount` tells the page NOT to talk about a new password: the person signs in with the account
    // they already have (their body password, if any, was ignored, and no password is ever set on an existing one).
    return { ok: true, email: invite.email, status: "active", portalPath: "/portal", existingAccount: accountPath !== "created" };
  }
}
