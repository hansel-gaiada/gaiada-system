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

/** Create a `webdev_sites` row — the registry's first write path (VLT-2). `vaultRef` is deliberately
 *  NOT accepted here: attaching a hosting credential's pointer goes through
 *  `patchWebdevSiteVaultRef`'s own, narrower, more heavily validated path, so there is exactly one
 *  place in the codebase that resolves a vault pointer against `integration_connections`. */
export async function createWebdevSite(tenantId: string, input: CreateSiteInput, actorId: string | null): Promise<WebdevSiteDto> {
  const domain = input.domain?.trim().toLowerCase();
  if (!domain || /\s/.test(domain) || domain.length < 3 || domain.length > 253) {
    throw new BadRequestException("domain is required, lowercase, no whitespace, 3-253 chars");
  }
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
