// GHT-1 (docs/blueprints/github-tenant-scope-ruling.md §3) — the effective org-tenant resolver.
//
// One GitHub org (`gaiadabali`) serves the whole company tree, but every org-wide GitHub row stays
// stamped to the SINGLE operating company that owns it (`config.githubOrgTenantId`, aliasing the
// long-standing `GITHUB_REPO_SYNC_TENANT_ID` knob — see config.ts's own comment). A request landing
// on any OTHER company in the SAME root must still see the org's registry; a request from a
// DIFFERENT root must never see it, no matter what the URL says. This module is the ONE place that
// substitution happens, and every `:tenantId/github/*` route (plus GHT-2's org-status) must run it
// before doing anything tenant-scoped.
//
// ── ORDER IS THE WHOLE TICKET ────────────────────────────────────────────────────────────────────
// resolve (this file) -> authorize AGAINST THE RESOLVED ORG TENANT, never the URL tenant, and never
// both -> only then `withTenants([org])`. Getting the order wrong, authorizing against the URL
// tenant, or authorizing against both, is a cross-root data leak dressed as a bug fix. See
// `github-repos.controller.ts`'s call sites for the enforced order.
//
// ── NOT A NEW HIERARCHY ROLLUP ───────────────────────────────────────────────────────────────────
// This is NOT `app_current_tenants()` growing descendant awareness (rejected, disqualifying — the
// ruling's §4(b): 231 policies across 229 tables would silently widen). It is a SINGLE explicit
// substitution at ONE BFF surface, gated by a same-root check run here, in application code, against
// a table (`companies`) that carries NO RLS at all (verified live, ruling §1) — never a change to
// what "tenant" means for any other table, and RLS itself is never touched.
//
// ── WHY `withGlobal`, NOT `withTenants` ──────────────────────────────────────────────────────────
// The same-root check reads `companies` before any tenant context can legitimately be said to exist
// for this request (we do not yet know which tenant, if any, the caller may act as) — and `companies`
// has no RLS to satisfy anyway. Using the caller's own connection pool via `withGlobal` avoids
// pretending a tenant scope is already established.
import { ServiceUnavailableException } from "@nestjs/common";
import { withGlobal } from "../db";
import { config } from "../config";

export type GithubOrgUnavailableReason = "unconfigured" | "not_in_root";

export type GithubOrgTenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; reason: GithubOrgUnavailableReason };

/**
 * `requestTenantId` is the URL `:tenantId` — already validated as UUID-shaped by the
 * `tenant-param.ts` guard, which 400s a malformed id BEFORE this ever runs (the estate's own
 * documented validation-preempts-authz trap: a non-UUID "denial" test would stop short of
 * exercising this resolver at all, which is why GHT-4's adversarial probes are required to use
 * uuid-shaped ids). This resolver never has to defend against a non-UUID string.
 */
export async function resolveGithubOrgTenant(requestTenantId: string): Promise<GithubOrgTenantResolution> {
  const org = config.githubOrgTenantId;
  if (!org) return { ok: false, reason: "unconfigured" };
  if (org === requestTenantId) return { ok: true, tenantId: org }; // fast path, no query
  const { rows } = await withGlobal((c) =>
    c.query<{ same_root: boolean }>(
      `SELECT (c1.root_company_id IS NOT NULL AND c1.root_company_id = c2.root_company_id) AS same_root
         FROM companies c1, companies c2
        WHERE c1.id = $1 AND c2.id = $2
          AND c1.deleted_at IS NULL AND c2.deleted_at IS NULL`,
      [requestTenantId, org],
    ),
  );
  if (rows[0]?.same_root) return { ok: true, tenantId: org };
  // A missing row (either id does not resolve to a live company) and a genuinely different root
  // both land here, deliberately: an unresolvable company id must refuse exactly like a foreign
  // root, never fall through to "same root, unproven".
  return { ok: false, reason: "not_in_root" };
}

/**
 * Throws the ONE refusal shape for a resolution failure — 503-family, never a 200 (empty-list or
 * otherwise) and never a 403. 403 is Cerbos's answer to "you may not read the org" — a DIFFERENT
 * question from "there is no reachable org to ask about", which is what this function answers.
 * Same family the webhook receiver already uses for its own "verified, but nowhere to file"
 * refusal (`github-webhook.controller.ts`) — an unset/unreachable org tenant is a deployment/
 * tenancy misconfiguration, not a client error and not a lying success.
 */
export function throwGithubOrgUnavailable(reason: GithubOrgUnavailableReason): never {
  const message =
    reason === "unconfigured"
      ? "github org tenant misconfigured: GITHUB_REPO_SYNC_TENANT_ID is unset"
      : "no GitHub org registered for this company's root";
  throw new ServiceUnavailableException(message);
}

/**
 * Response meta for list/detail (ruling §3): names the org so the UI can say "GitHub org
 * `gaiadabali` — registered to Gaia Digital Agency" instead of implying the registry belongs to the
 * active company. `companies` carries no RLS (verified live), so this is a plain global read.
 */
export async function githubOrgMeta(
  orgTenantId: string,
): Promise<{ login: string; tenantId: string; tenantName: string | null }> {
  const { rows } = await withGlobal((c) =>
    c.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1 AND deleted_at IS NULL`, [orgTenantId]),
  );
  return { login: config.githubOrg, tenantId: orgTenantId, tenantName: rows[0]?.name ?? null };
}
