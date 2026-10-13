// M6-P6g — the console's READ of a provisioned site's delivery state (the Postgres half of `delivery-binding.ts`).
//
// A provisioned site (`webdev_provisioned_sites`) is linked to its registry rows: the staging row M6-P4c registered
// (`webdev_site_id`) and, once created, the production row made from it (`webdev_sites.promoted_from_site_id`). Each row
// carries its own delivery binding, so each environment has its own state; this reads them for the console.
//
// ⚠ NOT THE DEPLOY GRANT. `deployGrant` (deploy-grant.service.ts, M6-P4g) is GitHub-side: the repo may read the org's deploy
// secrets. This is host-side: where the build goes and which vault record holds the key. They are answered by different
// queries and shown side by side; nothing here reads `deploy_grant_*` and no combined "ready" is invented.
import { withTenants } from "../../db";
import { deliveryStateOf, type DeliveryState } from "./delivery-binding";

export interface DeliveryEnvDto {
  /** The `webdev_sites` row id (what `POST sites/:id/delivery-binding` takes). */
  siteId: string;
  environment: string;
  hostKind: string;
  /** The opaque label, never a host name. */
  hostRef: string | null;
  access: string;
  state: DeliveryState;
}

/** What the console shows for one provisioned site's host side. `environments` is empty until the site has a registry row. */
export interface SiteDeliveryDto {
  environments: DeliveryEnvDto[];
}

interface Row {
  provisioned_id: string; site_id: string; environment: string; origin: string; host_kind: string;
  host_ref: string | null; access: string; vault_ref: string | null;
  vault_provider: string | null; vault_status: string | null;
}

/** The delivery view of each given provisioned site, keyed by `webdev_provisioned_sites.id`. A site with no registry row yet
 *  maps to `{environments: []}`. One query for the whole list; both RLS walls are set (`modules`). */
export async function readDeliveryForProvisioned(
  tenantId: string,
  provisionedIds: string[],
): Promise<Map<string, SiteDeliveryDto>> {
  const out = new Map<string, SiteDeliveryDto>(provisionedIds.map((id) => [id, { environments: [] }]));
  if (provisionedIds.length === 0) return out;
  const res = await withTenants(
    [tenantId],
    (c) =>
      c.query<Row>(
        // The vault record is joined to prove the pointer still resolves to a record of THIS tenant: a revoked or deleted
        // record turns a once-ready site back into awaiting. lower() because the pointer is stored as text.
        `SELECT p.id AS provisioned_id, s.id AS site_id, s.environment, s.origin, s.host_kind, s.host_ref, s.access, s.vault_ref,
                ic.provider AS vault_provider, ic.status AS vault_status
           FROM webdev_provisioned_sites p
           JOIN webdev_sites s
             ON s.tenant_id = p.tenant_id AND s.deleted_at IS NULL
            AND (s.id = p.webdev_site_id OR s.promoted_from_site_id = p.webdev_site_id)
           LEFT JOIN integration_connections ic
             ON ic.tenant_id = s.tenant_id AND ic.deleted_at IS NULL AND ic.id::text = lower(s.vault_ref)
          WHERE p.id = ANY($1::uuid[]) AND p.webdev_site_id IS NOT NULL
          ORDER BY p.id, CASE s.environment WHEN 'staging' THEN 0 ELSE 1 END, s.created_at`,
        [provisionedIds],
      ),
    { modules: ["webdev"] },
  );
  for (const r of res.rows) {
    const state = deliveryStateOf({
      origin: r.origin, hostKind: r.host_kind, hostRef: r.host_ref, access: r.access, vaultRef: r.vault_ref,
      vaultRecord: r.vault_provider !== null && r.vault_status !== null ? { provider: r.vault_provider, status: r.vault_status } : null,
    });
    // The join is on provisioned rows only, but a row whose origin was changed by hand reads null: leave it out rather than guess.
    if (state === null) continue;
    out.get(r.provisioned_id)?.environments.push({
      siteId: r.site_id, environment: r.environment, hostKind: r.host_kind, hostRef: r.host_ref, access: r.access, state,
    });
  }
  return out;
}
