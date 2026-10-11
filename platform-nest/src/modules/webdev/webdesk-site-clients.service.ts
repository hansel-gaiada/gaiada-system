// WSK-49c — the site -> client link (`webdesk_site_clients`, migration 202610111200): which client record a WebDesk site
// (tenant slug + site id) serves, in the serving company's tenant.
//
// Two audiences, one table:
//   * STAFF manage it (`GET|PUT|DELETE /api/:t/modules/webdev/content/sites/:slug/:siteId/client`, controller in
//     webdesk-site-clients.controller.ts, authorised as `webdev_provisioned_site` . `operate`).
//   * The client-mode portal BFF READS it, server-side, in the request's tenant, to decide which site a client editor
//     may touch (`clientGateContext` below). A client id from a URL or a body is never an authority: the URL's id only
//     reaches Cerbos (which matches it against the caller's OWN grants) and is then compared with the link row.
//
// A site that is not linked to the caller's client, an unknown site, another company's site and a malformed id all
// answer the SAME 404 `site-not-found` problem WebDesk's own wall uses: no existence oracle.
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { writeActivity } from "../../core/http";
import { resolvePortalScope } from "../../core/portal-scope";
import type { Principal } from "../../rbac/principal";
import { UUID_RE, WebdeskProblem, invalidRequest, type ClientGateContext, type SiteRef } from "./webdesk-content.service";

export interface SiteClientLink {
  tenantSlug: string;
  siteId: string;
  clientId: string;
  clientName: string | null;
  linkedBy: string | null;
  linkedAt: string;
}

interface LinkRow {
  tenant_slug: string;
  site_id: string;
  client_id: string;
  client_name: string | null;
  linked_by: string | null;
  created_at: Date | string;
}

const LINK_COLUMNS = `wsc.tenant_slug, wsc.site_id, wsc.client_id, cl.name AS client_name, wsc.linked_by, wsc.created_at`;

const toLink = (r: LinkRow): SiteClientLink => ({
  tenantSlug: r.tenant_slug,
  siteId: r.site_id,
  clientId: r.client_id,
  clientName: r.client_name,
  linkedBy: r.linked_by,
  linkedAt: new Date(r.created_at).toISOString(),
});

/** The uniform "not yours / not there" answer, in WebDesk's own problem type so the UI has one not-found shape. */
export function siteNotLinked(): WebdeskProblem {
  return new WebdeskProblem(404, {
    type: "https://webdesk.gaiada.online/errors/site-not-found",
    title: "Site not found",
    status: 404,
    detail: "No such site for this company.",
  });
}

function validSite(site: SiteRef): boolean {
  return UUID_RE.test(site.siteId) && /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/.test(site.tenantSlug);
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** The link of one site, or null. RLS (the tenant wall) plus the explicit tenant filter; a soft-deleted client is not a client. */
export async function getSiteClientLink(tenantId: string, site: SiteRef): Promise<SiteClientLink | null> {
  if (!validSite(site)) return null;
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<LinkRow>(
      `SELECT ${LINK_COLUMNS}
         FROM webdesk_site_clients wsc
         JOIN clients cl ON cl.id = wsc.client_id AND cl.tenant_id = wsc.tenant_id AND cl.deleted_at IS NULL
        WHERE wsc.tenant_id = $1 AND wsc.tenant_slug = $2 AND wsc.site_id = $3::uuid`,
      [tenantId, site.tenantSlug, site.siteId.toLowerCase()],
    ),
  );
  return rows[0] ? toLink(rows[0]) : null;
}

/** Every link of the tenant (staff list), or of one client (the portal's site list). Newest first. */
export async function listSiteClientLinks(tenantId: string, clientId?: string): Promise<SiteClientLink[]> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<LinkRow>(
      `SELECT ${LINK_COLUMNS}
         FROM webdesk_site_clients wsc
         JOIN clients cl ON cl.id = wsc.client_id AND cl.tenant_id = wsc.tenant_id AND cl.deleted_at IS NULL
        WHERE wsc.tenant_id = $1 ${clientId ? "AND wsc.client_id = $2::uuid" : ""}
        ORDER BY wsc.created_at DESC, wsc.site_id`,
      clientId ? [tenantId, clientId] : [tenantId],
    ),
  );
  return rows.map(toLink);
}

// ── staff writes ───────────────────────────────────────────────────────────────────────────────────────

/** Links (or re-points) a site to a client of THIS tenant. Idempotent: the same client again is `changed: false`, no audit row. */
export async function setSiteClientLink(
  principal: Principal,
  tenantId: string,
  site: SiteRef,
  clientId: string,
): Promise<{ link: SiteClientLink; changed: boolean; previousClientId: string | null }> {
  if (!UUID_RE.test(clientId)) throw invalidRequest("clientId must be a uuid");
  if (!validSite(site)) throw siteNotLinked();
  const siteId = site.siteId.toLowerCase();
  const result = await withTenants([tenantId], async (c) => {
    const client = await c.query(`SELECT 1 FROM clients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [clientId, tenantId]);
    if (!client.rowCount) throw new NotFoundException({ message: "client_not_found", reason: "client_not_found" });
    const existing = await c.query<{ client_id: string }>(
      `SELECT client_id FROM webdesk_site_clients WHERE tenant_id = $1 AND tenant_slug = $2 AND site_id = $3::uuid FOR UPDATE`,
      [tenantId, site.tenantSlug, siteId],
    );
    const previous = existing.rows[0]?.client_id ?? null;
    if (previous === clientId) return { changed: false, previousClientId: previous };
    if (previous === null) {
      await c.query(
        `INSERT INTO webdesk_site_clients (id, tenant_id, tenant_slug, site_id, client_id, linked_by, origin_site)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7)`,
        [newId(), tenantId, site.tenantSlug, siteId, clientId, principal.userId, config.originSite],
      );
    } else {
      await c.query(
        `UPDATE webdesk_site_clients SET client_id = $4, linked_by = $5, updated_at = now()
          WHERE tenant_id = $1 AND tenant_slug = $2 AND site_id = $3::uuid`,
        [tenantId, site.tenantSlug, siteId, clientId, principal.userId],
      );
    }
    return { changed: true, previousClientId: previous };
  }).catch((err: { code?: string }) => {
    // Two racing first links of the same site: the UNIQUE (tenant_id, tenant_slug, site_id) arbitrates.
    if (err?.code === "23505") throw new ConflictException({ message: "site_link_conflict: the site was linked a moment ago; retry", reason: "site_link_conflict" });
    throw err;
  });
  if (result.changed) {
    await writeActivity(tenantId, principal.userId, result.previousClientId ? "webdesk.site_client.relinked" : "webdesk.site_client.linked", "webdesk_site", siteId, {
      tenantSlug: site.tenantSlug, siteId, clientId, previousClientId: result.previousClientId,
    });
  }
  const link = await getSiteClientLink(tenantId, site);
  if (!link) throw siteNotLinked();
  return { link, changed: result.changed, previousClientId: result.previousClientId };
}

/** Removes a site's link (the client loses access at once: every portal route reads this row per request). Idempotent. */
export async function clearSiteClientLink(
  principal: Principal,
  tenantId: string,
  site: SiteRef,
): Promise<{ changed: boolean; previousClientId: string | null }> {
  if (!validSite(site)) return { changed: false, previousClientId: null };
  const siteId = site.siteId.toLowerCase();
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ client_id: string }>(
      `DELETE FROM webdesk_site_clients WHERE tenant_id = $1 AND tenant_slug = $2 AND site_id = $3::uuid RETURNING client_id`,
      [tenantId, site.tenantSlug, siteId],
    ),
  );
  const previousClientId = rows[0]?.client_id ?? null;
  if (previousClientId) {
    await writeActivity(tenantId, principal.userId, "webdesk.site_client.unlinked", "webdesk_site", siteId, {
      tenantSlug: site.tenantSlug, siteId, clientId: previousClientId,
    });
  }
  return { changed: previousClientId !== null, previousClientId };
}

// ── the portal's read: the gate context ────────────────────────────────────────────────────────────────

/**
 * The client half of a `ContentGate` (see `ClientGateContext`): `clientId` is the URL's client, `assertOwnsSite` proves,
 * in the request's tenant and on every call,
 *   1. the caller's portal scope contains that client (`resolvePortalScope`: 403 `not a portal client` for anyone who is
 *      not an active contact of it), and
 *   2. the site is LINKED to that client (`webdesk_site_clients`), else the uniform 404.
 * The portal scope predicate is therefore on every portal website read and write, as the PV guard list requires.
 */
export function clientGateContext(principal: Principal, tenantId: string, clientId: string, opts: { notifyDeciders?: boolean } = {}): ClientGateContext {
  return {
    clientId,
    ...(opts.notifyDeciders === false ? { notifyDeciders: false } : {}),
    async assertOwnsSite(site: SiteRef): Promise<void> {
      await assertPortalClient(principal, tenantId, clientId);
      const link = await getSiteClientLink(tenantId, site);
      if (!link || link.clientId !== clientId) throw siteNotLinked();
    },
  };
}

/** The portal-scope half alone (the routes that name no site: the client's site list, its publish requests). */
export async function assertPortalClient(principal: Principal, tenantId: string, clientId: string): Promise<void> {
  await withTenants([tenantId], async (c) => {
    const scope = await resolvePortalScope(c, principal);
    if (!scope.clientIds.includes(clientId)) throw new ForbiddenException("not a contact of this client");
  });
}
