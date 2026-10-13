// VLT-2 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the `webdev_sites` portfolio
// registry's FIRST write path. Before this file, the only way a row entered this table was a direct
// test SQL INSERT (`github-repos-http.test.ts`, `db/github-repos-rls.test.ts`,
// `portfolio-reads.service.test.ts`) — there was no HTTP write surface at all, hosting or otherwise.
//
// ── SCOPE, STATED HONESTLY ──────────────────────────────────────────────────────────────────────
// This is a first cut: create a site row, and patch its `vault_ref` pointer. It does not attempt a
// general-purpose "edit any column" endpoint — that is a larger surface (host/access transitions,
// adoption-ladder moves) this ticket does not spec, and inventing one here would outrun the ticket.
//
// ── THE INVARIANT THIS FILE MUST NOT REGRESS (WSK-D30) ─────────────────────────────────────────────
// `202608300747_webdev_sites_portfolio_registry.sql`'s own header (lines 25-27): "IT REFERENCES
// CREDENTIALS AND NEVER STORES THEM... There is deliberately no column they could go in." `vault_ref`
// is a POINTER — an `integration_connections.id` in the SAME tenant — never a credential. There is no
// literal FK (the table's own design), so the pointer is validated in this service layer: it must be
// a syntactically well-formed id AND must resolve to a real, same-tenant `integration_connections`
// row, or the write is rejected. A random string that merely "looks like" a token can never pass this
// check, because it will never resolve to a real connection row — WSK-D30 holds structurally, not by
// convention (the ticket's own acceptance bar).
//
// ── BOTH RLS WALLS (the estate's most common data-op failure) ──────────────────────────────────────
// `webdev_sites` composes its tenant_isolation policy as
//   tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')
// Every `withTenants` call below passes `{ modules: ["webdev"] }`. Omitting it does not error — an
// INSERT's `WITH CHECK` clause raises (42501, loud), but an UPDATE's `USING` clause just matches zero
// rows (silent) — which is exactly why `patchWebdevSiteVaultRef`'s own regression test drives the SAME
// UPDATE with and without the module GUC and asserts the difference, rather than trusting the source
// read alone.
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { PROVISIONED_PLACEHOLDER_DOMAIN_SUFFIX } from "./provision-completion";
import { DeliveryRefusal, deliveryStateOf, vaultRecordRefusal, type BindingInput, type DeliveryState } from "./delivery-binding";

export const SITE_ENVIRONMENTS = new Set(["production", "staging", "preview", "development"]);
export const SITE_HOST_KINDS = new Set(["our-box", "client-cpanel", "shared-hosting", "external", "unknown"]);
export const SITE_ACCESS_LEVELS = new Set(["none", "ftp", "cpanel", "ssh", "full"]);
export const SITE_KINDS = new Set(["static", "wp", "fullstack"]);
export const SITE_ADOPTIONS = new Set(["tracked", "linked", "adopted", "mandated"]);
export const SITE_ORIGINS = new Set(["nexus-import", "provisioned", "manual"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A regression guard's twin, expressed as input validation: reject a `vaultRef` that could not
 *  possibly be a pointer before even asking the database. This is belt-and-braces — the resolve
 *  check below is what actually enforces WSK-D30 — but a clean 400 on "that is obviously not an id"
 *  is a better error than a DB round trip that was always going to fail. */
function looksLikeUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export interface WebdevSiteDto {
  id: string;
  tenantId: string;
  domain: string;
  environment: string;
  projectId: string | null;
  clientId: string | null;
  hostKind: string;
  hostRef: string | null;
  access: string;
  kind: string | null;
  repoUrl: string | null;
  repoBranch: string | null;
  adoption: string;
  contractVersion: string | null;
  origin: string;
  vaultRef: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SiteRow {
  id: string; tenant_id: string; domain: string; environment: string;
  project_id: string | null; client_id: string | null;
  host_kind: string; host_ref: string | null; access: string; kind: string | null;
  repo_url: string | null; repo_branch: string | null; adoption: string; contract_version: string | null;
  origin: string; vault_ref: string | null; notes: string | null;
  created_at: Date; updated_at: Date;
}

function toDto(r: SiteRow): WebdevSiteDto {
  return {
    id: r.id, tenantId: r.tenant_id, domain: r.domain, environment: r.environment,
    projectId: r.project_id, clientId: r.client_id,
    hostKind: r.host_kind, hostRef: r.host_ref, access: r.access, kind: r.kind,
    repoUrl: r.repo_url, repoBranch: r.repo_branch, adoption: r.adoption, contractVersion: r.contract_version,
    origin: r.origin, vaultRef: r.vault_ref, notes: r.notes,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS =
  `id, tenant_id, domain, environment, project_id, client_id, host_kind, host_ref, access, kind,
   repo_url, repo_branch, adoption, contract_version, origin, vault_ref, notes, created_at, updated_at`;

export interface CreateSiteInput {
  domain: string;
  environment?: string;
  projectId?: string | null;
  /** WSK-D35 — deliberately nullable, no default. An internal site with no client behind it is a
   *  legitimate delivery fact, not a gap to be filled in. Never coerce a missing value to anything
   *  but null here. */
  clientId?: string | null;
  hostKind?: string;
  hostRef?: string | null;
  access?: string;
  kind?: string | null;
  repoUrl?: string | null;
  repoBranch?: string | null;
  adoption?: string;
  contractVersion?: string | null;
  origin?: string;
  notes?: string | null;
}

/** Resolve + validate a `vaultRef` candidate against the SAME tenant's `integration_connections`.
 *  `null` clears the pointer and always passes. Anything else must be a well-formed id AND must
 *  resolve to a live (non-deleted), same-tenant connection row — this is the FK-equivalent enforcement
 *  the table's own design deliberately has no literal constraint for. Exported so the HTTP tests can
 *  drive it directly as well as through the endpoint. */
export async function validateVaultRef(tenantId: string, vaultRef: string | null | undefined): Promise<string | null> {
  if (vaultRef === null || vaultRef === undefined) return null;
  const trimmed = vaultRef.trim();
  if (!trimmed) return null;
  if (!looksLikeUuid(trimmed)) {
    throw new BadRequestException("vaultRef must be an integration_connections id (uuid), or null to clear it");
  }
  // integration_connections is a CORE table (tenant-only RLS, no module wall — 0033's own header),
  // so no `modules` option is needed or correct here.
  const found = await withTenants([tenantId], (c) =>
    c.query(`SELECT 1 FROM integration_connections WHERE id = $1 AND deleted_at IS NULL`, [trimmed]),
  );
  if (!found.rows[0]) {
    throw new BadRequestException(
      "vaultRef must reference an existing integration_connections row in this tenant — a value that " +
        "does not resolve is rejected, which is what keeps this column a pointer and never a credential (WSK-D30)",
    );
  }
  return trimmed;
}

function validateEnum(value: string | undefined, allowed: Set<string>, field: string, fallback: string): string {
  const v = value ?? fallback;
  if (!allowed.has(v)) throw new BadRequestException(`${field} must be one of ${[...allowed].join(",")}`);
  return v;
}

/** Postgres error shape narrow enough for the two constraint violations this write path can hit. */
function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? (err as { code?: string }).code : undefined;
}

/** THE one place a registry domain is normalised and shape-checked (trim, lowercase, no whitespace,
 *  3-253 chars). `createWebdevSite` and `claimProvisionedSiteDomain` both call it, so the two write
 *  paths that can put a domain into `webdev_sites` can never disagree about what a valid one is. */
export function normalizeSiteDomain(raw: string | null | undefined): string {
  const domain = raw?.trim().toLowerCase();
  if (!domain || /\s/.test(domain) || domain.length < 3 || domain.length > 253) {
    throw new BadRequestException("domain is required, lowercase, no whitespace, 3-253 chars");
  }
  return domain;
}

/** Create a `webdev_sites` row — the registry's first write path (VLT-2). `vaultRef` is deliberately
 *  NOT accepted here: attaching a hosting credential's pointer goes through
 *  `patchWebdevSiteVaultRef`'s own, narrower, more heavily validated path, so there is exactly one
 *  place in the codebase that resolves a vault pointer against `integration_connections`. */
export async function createWebdevSite(tenantId: string, input: CreateSiteInput, actorId: string | null): Promise<WebdevSiteDto> {
  const domain = normalizeSiteDomain(input.domain);
  const environment = validateEnum(input.environment, SITE_ENVIRONMENTS, "environment", "production");
  const hostKind = validateEnum(input.hostKind, SITE_HOST_KINDS, "hostKind", "unknown");
  const access = validateEnum(input.access, SITE_ACCESS_LEVELS, "access", "none");
  const adoption = validateEnum(input.adoption, SITE_ADOPTIONS, "adoption", "tracked");
  const origin = validateEnum(input.origin, SITE_ORIGINS, "origin", "manual");
  if (input.kind !== undefined && input.kind !== null && !SITE_KINDS.has(input.kind)) {
    throw new BadRequestException(`kind must be one of ${[...SITE_KINDS].join(",")}, or null`);
  }
  const id = newId();
  try {
    const row = await withTenants(
      [tenantId],
      async (c) => {
        const res = await c.query<SiteRow>(
          `INSERT INTO webdev_sites
             (id, tenant_id, domain, environment, project_id, client_id, host_kind, host_ref, access,
              kind, repo_url, repo_branch, adoption, contract_version, origin, notes, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING ${SELECT_COLS}`,
          [
            id, tenantId, domain, environment, input.projectId ?? null, input.clientId ?? null,
            hostKind, input.hostRef ?? null, access, input.kind ?? null, input.repoUrl ?? null,
            input.repoBranch ?? null, adoption, input.contractVersion ?? null, origin,
            input.notes ?? null, config.originSite,
          ],
        );
        const created = res.rows[0];
        await emitEvent(c, tenantId, "webdev_site", created.id, "webdev.site.created", {
          domain: created.domain, environment: created.environment,
        });
        return created;
      },
      { modules: ["webdev"] },
    );
    return toDto(row);
  } catch (err) {
    const code = pgCode(err);
    // ux_webdev_sites_tenant_domain (this domain already tracked) OR
    // ux_webdev_sites_one_production_per_project (a second production row for the same project).
    if (code === "23505") throw new ConflictException("a site with this domain (or production slot) already exists");
    if (code === "23514" || code === "23502") throw new BadRequestException("site payload failed a database constraint");
    throw err;
  }
}

export async function getWebdevSite(tenantId: string, id: string): Promise<WebdevSiteDto | null> {
  const res = await withTenants(
    [tenantId],
    (c) => c.query<SiteRow>(`SELECT ${SELECT_COLS} FROM webdev_sites WHERE id = $1 AND deleted_at IS NULL`, [id]),
    { modules: ["webdev"] },
  );
  const row = res.rows[0];
  return row ? toDto(row) : null;
}

/** THE narrowly-scoped vault-pointer write (VLT-2). Accepts `vaultRef` and NOTHING else — the
 *  controller enforces that no other field is present in the request body before this is ever
 *  called, and this function's own signature (one field) is the second half of that guarantee: there
 *  is no parameter here a future caller could widen into a general site editor by accident. */
export async function patchWebdevSiteVaultRef(
  tenantId: string,
  id: string,
  vaultRef: string | null,
): Promise<WebdevSiteDto> {
  const resolved = await validateVaultRef(tenantId, vaultRef);
  const res = await withTenants(
    [tenantId],
    async (c) => {
      const upd = await c.query<SiteRow>(
        `UPDATE webdev_sites SET vault_ref = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL
         RETURNING ${SELECT_COLS}`,
        [id, resolved],
      );
      const row = upd.rows[0];
      if (row) {
        await emitEvent(c, tenantId, "webdev_site", row.id, "webdev.site.vault_ref_set", {
          // The connection ID itself is not a secret (it is an opaque pointer already validated
          // above) — never log/emit the resolved credential, only the pointer's own identity.
          vaultRefSet: resolved !== null,
        });
      }
      return row;
    },
    { modules: ["webdev"] },
  );
  if (!res) throw new NotFoundException("webdev site not found");
  return toDto(res);
}

/** M6-P4c2 — the ONE narrow domain write: a site that provisioning registered under its placeholder
 *  domain (`<slug>.provisioned.invalid`, provision-completion.ts) gets its real domain, once.
 *
 *  NOT a general domain editor: changing the domain of a tracked or already-claimed site is out of scope
 *  (it would re-key the WSK-D35 join to `search_properties` and the MON-01 probe targets, which a claim of
 *  a never-measured placeholder does not touch). A row is claimable only when it is `origin = 'provisioned'`
 *  AND its current domain still ends in `.` + the placeholder suffix; anything else is 409
 *  `domain_already_set`.
 *
 *  Race safety: the row is locked (`FOR UPDATE`) and then claimed by an UPDATE that repeats the claimable
 *  predicate in its WHERE, so two concurrent claims cannot both win — the loser blocks on the lock, re-reads
 *  the winner's real domain and answers 409. The `ux_webdev_sites_tenant_domain` unique index is the backstop
 *  for the real domain already belonging to another live row (409). Both RLS walls are set (`modules`). */
export async function claimProvisionedSiteDomain(
  tenantId: string,
  siteId: string,
  rawDomain: string,
  actorId: string | null,
): Promise<WebdevSiteDto> {
  const domain = normalizeSiteDomain(rawDomain);
  if (domain === "invalid" || domain.endsWith(".invalid")) {
    // RFC 2606: `.invalid` never resolves. It is the placeholder's own namespace, so accepting it would
    // swap one placeholder for another and spend the one-time claim on nothing.
    throw new BadRequestException("domain must be a real domain, not a .invalid placeholder");
  }
  // A malformed id would die at the uuid cast as a 500; it can match no row, so it is a 404.
  if (!looksLikeUuid(siteId)) throw new NotFoundException("webdev site not found");
  const placeholderSuffix = `.${PROVISIONED_PLACEHOLDER_DOMAIN_SUFFIX}`;
  try {
    const row = await withTenants(
      [tenantId],
      async (c) => {
        const cur = await c.query<{ domain: string }>(
          `SELECT domain FROM webdev_sites WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [siteId],
        );
        if (!cur.rows[0]) throw new NotFoundException("webdev site not found");
        const upd = await c.query<SiteRow>(
          `UPDATE webdev_sites SET domain = $2, updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL AND origin = 'provisioned'
              AND right(domain, length($3::text)) = $3::text
           RETURNING ${SELECT_COLS}`,
          [siteId, domain, placeholderSuffix],
        );
        const claimed = upd.rows[0];
        if (!claimed) throw new ConflictException("domain_already_set");
        await emitEvent(c, tenantId, "webdev_site", claimed.id, "webdev.site.domain_claimed", {
          domain: claimed.domain, previousDomain: cur.rows[0].domain, actorId,
        });
        return claimed;
      },
      { modules: ["webdev"] },
    );
    return toDto(row);
  } catch (err) {
    // ux_webdev_sites_tenant_domain: another live row in this tenant already holds this domain.
    if (pgCode(err) === "23505") throw new ConflictException("a site with this domain already exists");
    if (pgCode(err) === "23514" || pgCode(err) === "23502") throw new BadRequestException("site payload failed a database constraint");
    throw err;
  }
}

// ═══ M6-P6g — the delivery binding, and a production row made from its staging row ═══════════════════════════════
// Both are narrow writes on the registry, in the same closed-body spirit as the vaultRef PATCH and the domain claim above:
// the binding sets exactly host_kind, host_ref, access and vault_ref; the production command inserts exactly one row.
// Rules, refusals and the console word live in `delivery-binding.ts` (pure); this is their Postgres half.

/** A registry row plus its delivery state (null for a row that is not a provisioned site). */
export type DeliverySiteDto = WebdevSiteDto & { deliveryState: DeliveryState | null };

function pgConstraint(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "constraint" in err
    ? (err as { constraint?: string }).constraint
    : undefined;
}

/** Bind a site row to a delivery target: `host_kind`, an opaque `host_ref`, an `access` and a `vault_ref`.
 *
 *  One transaction, row locked `FOR UPDATE` (a re-bind and a clear never interleave). The vault record is read INSIDE the
 *  transaction under the request tenant's RLS and with an explicit `tenant_id = $tenant`, so another tenant's record is
 *  invisible: it is refused as `vault_ref_unknown`, the same answer as an id that does not exist (no existence oracle).
 *  Nothing host-like, user-like or path-like has a column here; `parseBindingBody` already refused any such key. Both RLS
 *  walls are set (`modules`). Re-binding an already bound row replaces the four facts. */
export async function bindSiteDelivery(
  tenantId: string,
  siteId: string,
  input: BindingInput,
  actorId: string | null,
): Promise<DeliverySiteDto> {
  if (!looksLikeUuid(siteId)) throw new DeliveryRefusal("not_found", "webdev site not found");
  return withTenants(
    [tenantId],
    async (c) => {
      const cur = await c.query<SiteRow>(
        `SELECT ${SELECT_COLS} FROM webdev_sites WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [siteId],
      );
      const site = cur.rows[0];
      if (!site) throw new DeliveryRefusal("not_found", "webdev site not found");
      // A preview or development row is never delivered to a host by the site CI.
      if (site.environment !== "staging" && site.environment !== "production") {
        throw new DeliveryRefusal("site_environment_not_deliverable", `only a staging or production row has a delivery target (this is ${site.environment})`);
      }
      const rec = await c.query<{ provider: string; status: string; owner_kind: string; owner_id: string }>(
        `SELECT provider, status, owner_kind, owner_id FROM integration_connections
          WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [input.vaultRef, tenantId],
      );
      const found = rec.rows[0];
      if (!found) {
        throw new DeliveryRefusal("vault_ref_unknown", "vaultRef must name an existing vault record of this tenant");
      }
      const refusal = vaultRecordRefusal(
        { provider: found.provider, status: found.status, ownerKind: found.owner_kind, ownerId: found.owner_id },
        input.access,
        site.client_id,
      );
      if (refusal) throw new DeliveryRefusal(refusal.code, refusal.detail);

      const upd = await c.query<SiteRow>(
        `UPDATE webdev_sites SET host_kind = $2, host_ref = $3, access = $4, vault_ref = $5, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${SELECT_COLS}`,
        [siteId, input.hostKind, input.hostRef, input.access, input.vaultRef],
      );
      const row = upd.rows[0];
      await emitEvent(c, tenantId, "webdev_site", row.id, "webdev.site.delivery_bound", {
        // The label and the transport, never the credential: vaultRef is an opaque pointer already resolved above.
        hostKind: row.host_kind, hostRef: row.host_ref, access: row.access, actorId,
      });
      return {
        ...toDto(row),
        deliveryState: deliveryStateOf({
          origin: row.origin, hostKind: row.host_kind, hostRef: row.host_ref, access: row.access, vaultRef: row.vault_ref,
          vaultRecord: { provider: found.provider, status: found.status },
        }),
      };
    },
    { modules: ["webdev"] },
  );
}

/** Create a provisioned site's PRODUCTION row from its STAGING row.
 *
 *  M6-P4c registers a provisioned site as one `staging` row (origin `provisioned`). This adds its `production` sibling under
 *  a real domain the caller supplies. The sibling copies what the two environments share (project, client, kind, repo, branch,
 *  adoption, contract version) and nothing host-side: its binding starts empty (`host_kind unknown`, `access none`), because
 *  production is usually a different host than staging and is bound on its own (`bindSiteDelivery`).
 *
 *  Refusals, each with a named reason: the row is not a live provisioned staging row (409); a live production row already
 *  exists for this staging row or for this project (409 `production_row_exists`); the domain is already held by another live
 *  row of the tenant, the staging row's own domain included (409 `domain_taken`). The staging row is locked `FOR UPDATE`, so
 *  two concurrent calls cannot both win; the unique indexes (`ux_webdev_sites_one_production_per_staging`,
 *  `ux_webdev_sites_one_production_per_project`, `ux_webdev_sites_tenant_domain`) are the backstop and map to the same reasons. */
export async function createProductionFromStaging(
  tenantId: string,
  stagingId: string,
  rawDomain: string,
  actorId: string | null,
): Promise<DeliverySiteDto> {
  let domain: string;
  try {
    domain = normalizeSiteDomain(rawDomain);
  } catch {
    throw new DeliveryRefusal("production_domain_invalid", "domain is required, lowercase, no whitespace, 3-253 chars");
  }
  if (domain === "invalid" || domain.endsWith(".invalid")) {
    throw new DeliveryRefusal("production_domain_invalid", "domain must be a real domain, not a .invalid placeholder");
  }
  if (!looksLikeUuid(stagingId)) throw new DeliveryRefusal("not_found", "webdev site not found");
  try {
    return await withTenants(
      [tenantId],
      async (c) => {
        const cur = await c.query<SiteRow>(
          `SELECT ${SELECT_COLS} FROM webdev_sites WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [stagingId],
        );
        const staging = cur.rows[0];
        if (!staging) throw new DeliveryRefusal("not_found", "webdev site not found");
        if (staging.environment !== "staging" || staging.origin !== "provisioned") {
          throw new DeliveryRefusal("not_a_provisioned_staging_row", "only a provisioned site's staging row can be promoted to a production row");
        }
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM webdev_sites
            WHERE tenant_id = $1 AND deleted_at IS NULL AND environment = 'production'
              AND (promoted_from_site_id = $2 OR ($3::uuid IS NOT NULL AND project_id = $3::uuid))
            LIMIT 1`,
          [tenantId, stagingId, staging.project_id],
        );
        if (existing.rows[0]) {
          throw new DeliveryRefusal("production_row_exists", "this site already has a production row");
        }
        const held = await c.query<{ id: string }>(
          `SELECT id FROM webdev_sites WHERE tenant_id = $1 AND domain = $2 AND deleted_at IS NULL LIMIT 1`,
          [tenantId, domain],
        );
        if (held.rows[0]) {
          throw new DeliveryRefusal("domain_taken", `the domain ${domain} is already held by another live registry row of this tenant`);
        }
        const id = newId();
        const ins = await c.query<SiteRow>(
          `INSERT INTO webdev_sites
             (id, tenant_id, domain, environment, project_id, client_id, kind, repo_url, repo_branch, adoption,
              contract_version, origin, notes, promoted_from_site_id, origin_site)
           VALUES ($1, $2, $3, 'production', $4, $5, $6, $7, $8, $9, $10, 'provisioned', $11, $12, $13)
           RETURNING ${SELECT_COLS}`,
          [
            id, tenantId, domain, staging.project_id, staging.client_id, staging.kind, staging.repo_url, staging.repo_branch,
            staging.adoption, staging.contract_version,
            `Production row created from the staging row ${staging.id}. Not yet bound to a host.`,
            staging.id, config.originSite,
          ],
        );
        const row = ins.rows[0];
        await emitEvent(c, tenantId, "webdev_site", row.id, "webdev.site.created", {
          domain: row.domain, environment: "production", origin: "provisioned", promotedFromSiteId: staging.id, actorId,
        });
        return {
          ...toDto(row),
          deliveryState: deliveryStateOf({
            origin: row.origin, hostKind: row.host_kind, hostRef: row.host_ref, access: row.access, vaultRef: row.vault_ref,
            vaultRecord: null,
          }),
        };
      },
      { modules: ["webdev"] },
    );
  } catch (err) {
    if (pgCode(err) === "23505") {
      // The indexes are the backstop for a race the FOR UPDATE could not see (a different staging row, a concurrent domain claim).
      if (pgConstraint(err) === "ux_webdev_sites_tenant_domain") {
        throw new DeliveryRefusal("domain_taken", `the domain ${domain} is already held by another live registry row of this tenant`);
      }
      throw new DeliveryRefusal("production_row_exists", "this site already has a production row");
    }
    if (pgCode(err) === "23514" || pgCode(err) === "23502") throw new BadRequestException("site payload failed a database constraint");
    throw err;
  }
}
