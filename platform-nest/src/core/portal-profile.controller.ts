// CP-4 — the client portal's PROFILE surface: who the client is, who their people are, and the one
// thing the caller may change (their own name/title).
//
// ── WHY A CLIENT CANNOT EDIT `clients.contact` ────────────────────────────────────────────────────
// The obvious reading of "clients can manage their profile" is a form over the `clients` row: name,
// billing address, tax id. It is refused, and the refusal is the design rather than a shortcut:
//   * `clients` is the agency's CRM record of the relationship. Its `name` appears on invoices already
//     issued and on signed contracts. A client editing it after the fact silently changes what those
//     frozen documents appear to say.
//   * `clients.contact` is read by staff-facing surfaces and by billing. An external party writing into
//     a field that staff treat as verified is a data-integrity hole with no audit story.
// So the portal offers a REQUEST instead: `POST /portal/profile/change-request` records the ask as a
// notification to the account owners, and a human applies it in the staff UI. Slower on purpose. What
// the caller CAN change unilaterally is their own `users` row — their name and job title — because that
// is their own identity, not the company's record of the account.
//
// The `users` UPDATE is deliberately narrow: two columns, by the caller's own id, and nothing else. It
// notably does NOT touch `email` (that is the IdP's identity and the invite's bound address — changing
// it here would desynchronise Keycloak and could hijack another account's invite) or `status` (a client
// disabling themselves would be unrecoverable without staff intervention).
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants, withGlobal } from "../db";
import { authorize, writeActivity } from "./http";
import { AuthGuard } from "../auth/guards";
import { scrubText } from "./scrub";
import { notifyBestEffort } from "./client-notify";
import { resolvePortalScope } from "./portal-scope";

@Controller("api")
@UseGuards(AuthGuard)
export class PortalProfileController {
  /** The caller's own account, the client organisations they represent, and their fellow contacts.
   *
   *  Fellow contacts are included because a client stakeholder legitimately needs to know who else on
   *  their side has access — that is a governance question they own, not ours. Only name/email/
   *  capability/status is exposed, and only for contacts of THEIR clients. */
  @Get(":tenantId/portal/profile")
  async profile(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const [me, clients, contacts, access] = await Promise.all([
        // `users` is a GLOBAL table (no tenant column, no RLS) — but this transaction is already open
        // and reading it here keeps the profile a single round trip. Filtered to the caller's own id.
        c.query(
          `SELECT id, name, email, title, created_at AS "memberSince" FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [req.principal.userId],
        ),
        c.query(
          `SELECT cl.id, cl.name, cl.status, cl.contact,
                  (SELECT count(*) FROM projects p WHERE p.client_id = cl.id AND p.deleted_at IS NULL) AS "projectCount"
             FROM clients cl WHERE cl.id = ANY($1::uuid[]) AND cl.deleted_at IS NULL ORDER BY cl.name`,
          [scope.clientIds],
        ),
        c.query(
          `SELECT DISTINCT u.id, u.name, u.email, cc.capability, cc.status, cc.client_id AS "clientId",
                  cc.project_id AS "projectId"
             FROM client_contacts cc JOIN users u ON u.id = cc.user_id
            WHERE cc.client_id = ANY($1::uuid[]) AND cc.deleted_at IS NULL AND cc.status <> 'revoked'
            ORDER BY u.name`,
          [scope.clientIds],
        ),
        // The caller's own grants, spelled out. A contact who cannot sign should be able to SEE that
        // this is why the button is disabled, rather than concluding the portal is broken.
        c.query(
          `SELECT cc.capability, cc.client_id AS "clientId", cc.project_id AS "projectId",
                  p.name AS "projectName", cl.name AS "clientName"
             FROM client_contacts cc
             LEFT JOIN projects p ON p.id = cc.project_id
             LEFT JOIN clients cl ON cl.id = cc.client_id
            WHERE cc.user_id = $1 AND cc.client_id = ANY($2::uuid[])
              AND cc.status = 'active' AND cc.deleted_at IS NULL`,
          [req.principal.userId, scope.clientIds],
        ),
      ]);
      return {
        me: me.rows[0] ?? null,
        clients: clients.rows.map((r: Record<string, unknown>) => ({ ...r, projectCount: Number(r.projectCount) })),
        contacts: contacts.rows,
        access: { canSign: scope.canSign, wholeClient: scope.projectIds === null, grants: access.rows },
      };
    });
  }

  /** Update the caller's OWN name/title. Nothing else — see the file header. */
  @Patch(":tenantId/portal/profile")
  @HttpCode(200)
  async updateProfile(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { name?: string; title?: string },
  ) {
    // `update_profile` and not a generic `update`: a Cerbos action name that says what it covers cannot
    // later be widened by accident into "update anything on the portal".
    await authorize(req.principal, { kind: "portal", tenantId }, "update_profile");
    // Resolve the scope even though the write does not use it: it is what proves the caller is a portal
    // client at all. Without this, any authenticated user holding the `client` role in some OTHER tenant
    // could PATCH here — authorize() checks the role, not the relationship.
    await withTenants([tenantId], (c) => resolvePortalScope(c, req.principal));

    const name = body?.name === undefined ? undefined : scrubText(String(body.name)).text.trim().slice(0, 200);
    const title = body?.title === undefined ? undefined : scrubText(String(body.title)).text.trim().slice(0, 200);
    if (name !== undefined && name.length < 2) throw new BadRequestException("name must be at least 2 characters");
    if (name === undefined && title === undefined) throw new BadRequestException("nothing to update");

    // withGlobal, not withTenants: `users` has no tenant column. The `id = $1` predicate against the
    // caller's own principal is the entire authorization for this statement, which is why it is written
    // as one narrow UPDATE rather than assembled from a partial-update helper.
    await withGlobal((c) =>
      c.query(
        `UPDATE users SET name = COALESCE($2, name), title = COALESCE($3, title), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [req.principal.userId, name ?? null, title ?? null],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "user", req.principal.userId as string, { via: "portal" });
    return { ok: true };
  }

  /** Ask the agency to change the client's own record (billing details, company name, a new contact).
   *
   *  Recorded as an activity + a notification to the account owners rather than a mutation. Deliberately
   *  not a new table: a request with no state machine, no assignee and no SLA does not need one, and
   *  inventing `client_change_requests` would create a queue nobody is accountable for draining. The
   *  notification lands in a bell someone already watches. */
  @Post(":tenantId/portal/profile/change-request")
  @HttpCode(202)
  async changeRequest(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { clientId?: string; message?: string },
  ) {
    const message = scrubText(String(body?.message ?? "")).text.trim().slice(0, 2000);
    if (message.length < 5) throw new BadRequestException("message required");
    await authorize(req.principal, { kind: "portal", tenantId }, "update_profile");

    const { clientId, owners, clientName } = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      // A body-supplied clientId is CHECKED against the caller's set, never trusted; omitted means
      // their first client, which is the only sensible default for the single-client common case.
      const target = body?.clientId && scope.clientIds.includes(body.clientId) ? body.clientId : scope.clientIds[0];
      const r = await c.query<{ owner_id: string | null; name: string }>(
        `SELECT DISTINCT p.owner_id, cl.name
           FROM clients cl LEFT JOIN projects p ON p.client_id = cl.id AND p.deleted_at IS NULL
          WHERE cl.id = $1`,
        [target],
      );
      return {
        clientId: target,
        clientName: r.rows[0]?.name ?? "your account",
        owners: [...new Set(r.rows.map((x) => x.owner_id).filter((x): x is string => !!x))],
      };
    });

    await writeActivity(tenantId, req.principal.userId, "requested_change", "client", clientId, { message, via: "portal" });
    await notifyBestEffort(tenantId, req.principal.userId, owners, "client.change_requested", {
      title: `${clientName} requested a profile change`,
      body: message.slice(0, 280),
      href: `/clients/${clientId}`,
      entityType: "client",
      entityId: clientId,
      severity: "info",
    });
    // 202, not 200: nothing has changed yet, and the status code should not imply that it has. If no
    // owner could be resolved the request is still RECORDED as an activity — so it is auditable even
    // when there was no bell to ring, which is the honest outcome rather than a silent success.
    return { accepted: true, notified: owners.length };
  }
}
