// M5-W1d — the fenced `contributor` principal (owner ruling WSK-D84; docs/plans/2026-10-11-m5-writers-room-design.md §3.1,
// D10). PURE: no I/O, no dependency beyond types, because the authz substrate (`principal.ts`), the grant choke point
// (`admin/grant-write.service.ts`), the HTTP fence (`auth/contributor-route.ts`) and the contributors BFF must all agree on
// exactly which roles a contributor may hold and how long an engagement may run. The database keeps its own copy of the
// role list in `user_roles_contributor_guard` (migration 202610270900); `contributor-principal.db.test.ts` pins that the
// two agree.
import type { RoleGrant } from "./principal";

/** `users.kind` of a freelance contributor. */
export const CONTRIBUTOR_KIND = "contributor" as const;

/** The ONLY roles a contributor may hold (design §3.1 item 4). Never `webdesk_editor`: approval is a staff function. */
export const CONTRIBUTOR_ROLES = ["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer"] as const;
export type ContributorRole = (typeof CONTRIBUTOR_ROLES)[number];

export function isContributorRole(name: unknown): name is ContributorRole {
  return typeof name === "string" && (CONTRIBUTOR_ROLES as readonly string[]).includes(name);
}

/** An engagement (the anchor's `valid_until`) runs at most this long after the write that sets it. Mirrored by the
 *  CHECK `ck_editorial_contributors_window` (the guard trigger re-stamps `valid_from` on every write of `valid_until`). */
export const CONTRIBUTOR_MAX_ENGAGEMENT_DAYS = 180;

/** The refusal token of the HTTP fence (`AuthGuard`). */
export const CONTRIBUTOR_ROUTE_FORBIDDEN = "contributor_route_forbidden";

/**
 * The grants a contributor principal keeps, given the companies where it holds a LIVE anchor (active, unexpired).
 * PURE. A grant survives only when ALL of these hold:
 *   * its role is one of the three contributor roles (anything else, however it got into `user_roles`, is dropped);
 *   * it is at `company` scope;
 *   * that company is one where the contributor's anchor is live.
 * So an expired or ended anchor takes every grant in that company with it at the next request, even a grant whose own
 * `expires_at` has not passed yet (the DB guard already forbids that shape; this is the second fence).
 */
export function contributorGrants<G extends RoleGrant>(grants: ReadonlyArray<G>, liveAnchorTenants: ReadonlySet<string>): G[] {
  return grants.filter(
    (g) => isContributorRole(g.role) && g.scopeType === "company" && !!g.scopeId && liveAnchorTenants.has(g.scopeId),
  );
}
