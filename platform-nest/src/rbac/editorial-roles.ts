// M5-W1b — the writers' room roles, as one list, and the two PURE pieces of their scope handling
// (docs/plans/2026-10-11-m5-writers-room-design.md §2.2, §2.6).
//
// This file has no I/O and no dependency beyond types, on purpose: it is read by the authz substrate
// (`principal.ts`), the grant-write choke point (`admin/grant-write.service.ts`), the positions composer and the
// WebDesk BFF, and each of those must agree on exactly which four names are "editorial". The database has its own
// copy of the list in three triggers (migration 202610111816); `editorial-roles.test.ts` pins that the two agree.
import type { EditorialScope, RoleGrant } from "./principal";

/** The four roles whose grants carry per-site scope rows. NO bundle and NO perm_* mirror, permanently (W1a). */
export const EDITORIAL_ROLES = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer", "webdesk_editor"] as const;
export type EditorialRole = (typeof EDITORIAL_ROLES)[number];

export function isEditorialRole(name: unknown): name is EditorialRole {
  return typeof name === "string" && (EDITORIAL_ROLES as readonly string[]).includes(name);
}

/** The refusal token every generic grant surface answers for one of the four roles (design §2.5). */
export const EDITORIAL_ROLE_DEDICATED_PATH = "editorial_role_dedicated_path";

/** Upper bounds, mirrored by the scope table's CHECKs (`editorial_scope_list_ok`). */
export const EDITORIAL_SCOPE_MAX_ENTRIES = 100;
export const EDITORIAL_COLLECTION_KEY_MAX = 100;
/** WebDesk's own locale bound (`webdesk/api/src/control/dto.ts`: an opaque string of at most 35 characters). */
export const EDITORIAL_LOCALE_MAX = 35;

/** One scope row as `assemblePrincipal()` reads it under the `principal_lookup` policy. */
export interface EditorialScopeRow {
  userRoleId: string;
  tenantId: string;
  siteId: string;
  allCollections: boolean;
  collections: string[] | null;
  allLocales: boolean;
  locales: string[] | null;
}

/**
 * Attach each writers' room grant's scope rows to it, as `editorialScopes`. PURE.
 *
 * A row is attached only when ALL of these hold, so a row that somehow does not belong to the grant is dropped
 * rather than widening it (the DB guard already refuses such rows; this is the second fence):
 *   * the grant's role is one of the four and its scope is `company`;
 *   * the row's `userRoleId` is that grant's id;
 *   * the row's tenant is the grant's company (`scopeId`).
 * A writers' room grant with NO surviving row gets NO `editorialScopes` member at all: the derived roles guard it with
 * `has(g.editorialScopes)`, so such a grant matches nothing (fail closed). Every other grant passes through with its
 * exact shape (the HIER-1 round-trip tests pin it). The internal `grantId` is stripped from every grant.
 */
export function attachEditorialScopes(
  grants: ReadonlyArray<RoleGrant & { grantId?: string }>,
  rows: ReadonlyArray<EditorialScopeRow>,
): RoleGrant[] {
  return grants.map(({ grantId, ...g }) => {
    if (!isEditorialRole(g.role) || g.scopeType !== "company" || !grantId || !g.scopeId) return g;
    const scopes: EditorialScope[] = rows
      .filter((r) => r.userRoleId === grantId && r.tenantId === g.scopeId)
      .map((r) => ({
        siteId: r.siteId,
        allCollections: r.allCollections === true,
        collections: r.allCollections === true ? [] : [...(r.collections ?? [])],
        allLocales: r.allLocales === true,
        locales: r.allLocales === true ? [] : [...(r.locales ?? [])],
      }));
    return scopes.length > 0 ? { ...g, editorialScopes: scopes } : g;
  });
}

/** A validated, normalised scope (lists de-duplicated and sorted; "all" => an empty list). */
export interface NormalisedEditorialScope {
  allCollections: boolean;
  collections: string[];
  allLocales: boolean;
  locales: string[];
}

export class EditorialScopeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "EditorialScopeError";
  }
}

function normaliseList(field: string, all: unknown, list: unknown, max: number): { all: boolean; list: string[] } {
  if (all !== undefined && typeof all !== "boolean") throw new EditorialScopeError(`all${field} must be a boolean`);
  const allFlag = all === true;
  if (allFlag) {
    if (list !== undefined && !(Array.isArray(list) && list.length === 0)) {
      throw new EditorialScopeError(`give either all${field}: true or a ${field.toLowerCase()} list, not both`);
    }
    return { all: true, list: [] };
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new EditorialScopeError(
      `${field.toLowerCase()} must be a non-empty array (or set all${field}: true); an empty list never means "all"`,
    );
  }
  const out = new Set<string>();
  for (const [i, v] of list.entries()) {
    if (typeof v !== "string" || v.length === 0 || v.length > max || v !== v.trim() || /[\u0000-\u001f\u007f]/.test(v)) {
      throw new EditorialScopeError(
        `${field.toLowerCase()}[${i}] must be a non-empty string of at most ${max} characters with no surrounding whitespace`,
      );
    }
    out.add(v);
  }
  if (out.size > EDITORIAL_SCOPE_MAX_ENTRIES) {
    throw new EditorialScopeError(`${field.toLowerCase()} may name at most ${EDITORIAL_SCOPE_MAX_ENTRIES} entries`);
  }
  return { all: false, list: [...out].sort() };
}

/** Validate a caller's scope (`{allCollections?, collections?, allLocales?, locales?}`). PURE; throws EditorialScopeError. */
export function normaliseEditorialScope(raw: {
  allCollections?: unknown;
  collections?: unknown;
  allLocales?: unknown;
  locales?: unknown;
}): NormalisedEditorialScope {
  const c = normaliseList("Collections", raw.allCollections, raw.collections, EDITORIAL_COLLECTION_KEY_MAX);
  const l = normaliseList("Locales", raw.allLocales, raw.locales, EDITORIAL_LOCALE_MAX);
  return { allCollections: c.all, collections: c.list, allLocales: l.all, locales: l.list };
}
