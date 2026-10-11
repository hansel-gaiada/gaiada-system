// Shared code-level gates for the platform-wide admin surfaces. These surfaces are not tenant
// resources, so the check happens in code rather than through Cerbos's per-tenant resource model.
// Do not duplicate either predicate elsewhere: import it.
//
// TWO PREDICATES, AND WHICH ONE A SURFACE USES IS THE DECISION:
//
//   isElevated(req)          — `platform_admin` at GLOBAL scope. Unchanged. Still the gate for every
//                              NON-system admin surface: company listing, IAM, view-all-companies,
//                              the intelligence/assistant transcripts, the mail admin console.
//   isPlatformOperator(req)  — isElevated, OR the owner of a ROOT company (PV-D18 + PV-D20). The gate
//                              for the SYSTEM surfaces only: admin-systems.controller.ts (status,
//                              config, gateway, hub, github, automation, about), every route of
//                              bot-admin.controller.ts, and observability.controller.ts.
//
// ⚠ IAM-15 (D-7) REMOVED isElevated's SECOND ARM. It used to accept `group_executive` at global
// scope too; that role no longer exists. The predicate is therefore STRICTLY NARROWER than it was,
// and that is the intended consequence — D-7's whole point is that a cross-company BUSINESS role
// should not reach platform surfaces through a global grant. isPlatformOperator does not undo that:
// its owner arm is a per-company grant on one specific root, not a global business role.
//
// ⚠ `owner` IS STILL NOT IN isElevated, and adding it there would undo IAM-14 for every surface
// listed above. What changed (PV-D18, owner ruling 2026-10-11, decision log at the end of
// docs/plans/2026-10-10-three-perspectives.md) is narrower: owners of the root get FULL platform and
// system controls — bots, AI gateway, MCP hub, automation, observability — the same as
// platform_admin. That supersedes D-8's "owner: NO platform/system controls" for THOSE SURFACES ONLY.
// Owner's business scope is unchanged, and the owner permission bundle is unchanged (this gate is
// code, not Cerbos; no bundle key moved).
//
// THE CONSEQUENCE FOR D-9, RECORDED: owner and platform_admin are NO LONGER DISJOINT for system
// surfaces. D-9's "one platform_admin + one owner" appointment pair leaned on the two tiers being
// different in kind. It still holds as a two-person rule: `owner` is in ELEVATED_TIER
// (grant-write.service.ts), so an owner grant itself needs the two-person appointment, and system
// power therefore still has no single-step path. What D-9 no longer buys is "the owner seat holds no
// system power" — anyone reasoning about the pair as business-vs-platform should read this first.
//
// ⚠ SaaS NOTE ("internal now, SaaS later", owner ruling 2026-10-10). The owner arm admits the owner
// of ANY root, and the system surfaces it opens are deployment-wide (our bot, our AI gateway, our
// estate's Prometheus), not scoped to that owner's root. Today there is one root and it is ours, so
// that is exactly PV-D18. The day a second, customer root exists, its owner passes this gate too.
// That needs a ruling (e.g. an operator-root marker) BEFORE a customer root is created; it is
// deliberately not invented here.
import type { FastifyRequest } from "fastify";
import { withGlobal } from "../db";

export function isElevated(req: FastifyRequest): boolean {
  return req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
}

/**
 * PV-D18 — the system-surface gate: `platform_admin` at global scope, OR the owner of a ROOT company.
 *
 * "Owner of the root" (PV-D20) = a `user_roles` grant of `owner` scoped to a company whose id equals
 * its own `root_company_id`. Not the Finance ownership register.
 *
 * ⚠ `principal.rootCompanies` IS NOT "THE ROOTS". Despite the name it is every company in the
 * principal's root TREE — the root AND all its descendants (assemblePrincipal's final SELECT returns
 * `co.id` for every company whose `root_company_id` is an anchor root). So "owner grant whose scopeId
 * is in rootCompanies" would admit the owner of a CHILD company, which PV-D20 excludes. Root-ness is
 * therefore checked against `companies` itself: `id = root_company_id`, which the MON-00a trigger
 * maintains (a root points at itself; nothing writes the column by hand).
 *
 * The rootCompanies test is kept as a SECOND, narrowing conjunct: the owned root must also be one the
 * principal is anchored in (home company or an active membership). A real root owner always is — the
 * owner seed sets both — so this only refuses an owner grant on a root the person has no other tie to,
 * consistent with the cross-root boundary (MON-00c) failing closed.
 *
 * ASYNC because of that one lookup. It costs nothing on the common paths: platform_admin returns
 * before the query, and a principal with no anchored company-scope owner grant returns false before
 * it too. Only a would-be root owner pays one indexed primary-key read.
 */
export async function isPlatformOperator(req: FastifyRequest): Promise<boolean> {
  if (isElevated(req)) return true;
  const anchored = new Set(req.principal.rootCompanies ?? []);
  const ownedInTree = req.principal.roles
    .filter((r) => r.role === "owner" && r.scopeType === "company" && r.scopeId !== null && anchored.has(r.scopeId))
    .map((r) => r.scopeId as string);
  if (ownedInTree.length === 0) return false;
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM companies
        WHERE id = ANY($1::uuid[]) AND id = root_company_id AND deleted_at IS NULL
        LIMIT 1`,
      [ownedInTree],
    ),
  );
  return rows.length > 0;
}
