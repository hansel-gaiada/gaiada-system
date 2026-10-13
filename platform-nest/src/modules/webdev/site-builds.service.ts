// WSK-60 — publish → rebuild → staging: the build ledger, the dispatch, and the stamp poll.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §9 (Decision G) and §12 WSK-60.
// Runbook: infra/runbooks/webdesk-staging-rebuild.md.
//
// ── THE FLOW ─────────────────────────────────────────────────────────────────────────────────────
//   1. An approval executes: a WebDesk `content.publish` (WSK-66) or a `content.rebuild` (this ticket,
//      filed by the editor after an unpublish). The executor makes ONE call into `startSiteRebuild`.
//   2. `startSiteRebuild` claims a `webdev_site_builds` row (UNIQUE (tenant_id, approval_id): at most
//      one build per approval, so a duplicated hook call cannot dispatch twice), then sends ONE
//      `workflow_dispatch` through the GitHub chokepoint as `github_repo · deploy`, authorised by the
//      approval's id (WSK-D46 / R3). The workflow's own `concurrency` group coalesces bursts; the ERP
//      has no debounce and records EVERY dispatch.
//   3. A poller reads `<stagingUrl>/webdesk-build.json` every 30 s for up to 20 min. `live` only when
//      the stamp proves the content is there (site-build-stamp.ts); on timeout `unverified`. Never live.
//
// ── FAIL CLOSED, VISIBLE, AND NEVER THE PUBLISH'S PROBLEM ────────────────────────────────────────
// `startSiteRebuild` NEVER throws. A dispatch that could not happen (App not installed, no target
// configured, Cerbos refused, GitHub down) leaves the row `failed` with a typed `failure_reason`, and
// the publish that triggered it stands. The editor then reads `state: "failed"` from build-status; it is
// never shown as rebuilding or live. The reason is on the row and in the approval's execution result.
//
// ── TENANCY ──────────────────────────────────────────────────────────────────────────────────────
// Ledger rows are the WEBDEV company's (`tenant_id` = the approval's tenant), under the third wall, read
// and written only in the `webdev` module scope. The GitHub side is the ORG tenant's (the App credential
// and the `github.deploy` activities rows): `workflow-dispatch.ts` resolves it and authorises the decider
// against it. The two are the same company on today's estate and need not be.
//
// ── M6-P6h: THE TARGET COMES FROM THE REGISTRY; A PRODUCTION PROMOTE RIDES THE SAME LEDGER ──────────
// `WEBDESK_REBUILD_TARGETS` is no longer required. `resolveSiteBuildTarget` reads the env entry FIRST (an optional
// override, kept for the hand-built proof site, resolved without a database read and dispatched exactly as before) and
// otherwise derives repo, workflow (`site.yml`), ref, URL, kind and the per-kind stamp path from the provisioned site and
// its registry rows (site-build-targets.ts, which states the precedence once). Only static and fullstack rebuild on a
// publish; a wp theme reads /v1 live, so its publish writes no build row at all (`notApplicable`).
//
// `startSitePromote` is the production half: an approved `site.promote` (webdesk-approved-command.ts) dispatches the
// template's `site.yml` with `kind=promote`, `environment=production` and the approval id, through the same chokepoint, and
// records ONE `kind = 'promote'` row per approval (migration 202610132320). It is `live` only through a template stamp read
// from the PRODUCTION URL that names this approval (site-build-stamp.ts). A promote never appears on the editor's
// build-status (that wire is staging's and its `kind` stays publish | rebuild); the console reads both environments through
// `readSiteBuildsForProvisioned`.
//
// CONCURRENCY (the P6f finding: GitHub keeps ONE waiting run per concurrency group, so a third quick dispatch replaces the
// second). Production: a second promote for the same site is REFUSED while one is in flight (`promote_in_flight`, read from
// this ledger under an advisory lock, nothing dispatched): two promotes in quick succession are a mistake, never a need.
// Staging: NOT refused, because refusing would leave a publish's content off staging; a run GitHub dropped is settled by
// the run that replaced it (the "laterDispatch" proof), whose build began later and therefore carries the same content.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import type { Principal } from "../../rbac/principal";
import { isModuleEnabled } from "../registry";
import {
  WorkflowDispatchError,
  dispatchApprovedWorkflow,
  type ClientPublishAuthority,
  type WorkflowDispatchFailure,
} from "../../core/github/workflow-dispatch";
import { readStagingStamp, stampProves, type StampFetchOptions } from "./site-build-stamp";
import {
  deriveRegistryTarget,
  overrideTarget,
  siteUrlOf,
  type BuildEnvironment,
  type BuildTarget,
  type BuildTargetRefusal,
  type RebuildTargetEntry,
  type RegistryBuildFacts,
  type TargetDerivation,
} from "./site-build-targets";

const logger = new Logger("SiteBuilds");

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Shapes
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** A STAGING build's kind: the editor's wire (`BuildStatusBuild.kind`) and nothing else. */
export type BuildKind = "publish" | "rebuild";
/** Every kind the ledger holds: staging's two, and M6-P6h's production promote. */
export type LedgerKind = BuildKind | "promote";
export type BuildState = "rebuilding" | "live" | "unverified" | "failed";

/** The ledger's own reasons, beside the dispatch's (workflow-dispatch.ts). */
export type BuildFailureReason =
  | WorkflowDispatchFailure
  /** M6-P6h: the target could not be resolved (site-build-targets.ts). Includes WSK-60's `rebuild_not_configured`: no env
   *  entry names this site AND no provisioned site of this company is linked to its WebDesk tenant. */
  | BuildTargetRefusal
  /** M6-P6h: a promote for this site is still in flight (a `promote` row is `rebuilding`). Nothing was dispatched. */
  | "promote_in_flight"
  /** The dispatch outlived its deadline, or the process died before GitHub's answer was recorded. It MAY
   *  have started a run; the ledger cannot tell, so it says so rather than guessing either way. */
  | "dispatch_unconfirmed"
  /** The ledger row itself could not be written. */
  | "build_ledger_unavailable"
  /** WSK-61: a scheduled publish went live, but the approval's decider is no longer an active user, so
   *  nobody can authorise the dispatch. Nothing was sent; the editor files a `content.rebuild`. */
  | "decider_inactive";

/** EXACTLY the editor's wire shape (platform-ui `parseBuildStatus`, WSK-44). No extra key. */
export interface BuildStatusBuild {
  approvalId: string | null;
  kind: BuildKind;
  requestedAt: string;
  publishedAt: string | null;
  state: BuildState;
  stagingUrl: string | null;
  verifiedAt: string | null;
}
export interface BuildStatusBody {
  build: BuildStatusBuild | null;
  stagingStale: boolean;
}

/** The fixed key set of the two objects above. The wire test asserts `Object.keys` equals these. */
export const BUILD_STATUS_KEYS = ["build", "stagingStale"] as const;
export const BUILD_KEYS = ["approvalId", "kind", "requestedAt", "publishedAt", "state", "stagingUrl", "verifiedAt"] as const;

/** One `WEBDESK_REBUILD_TARGETS` entry: `{tenantSlug, siteId, repo (owner/name), workflow (e.g. webdesk-rebuild.yml), ref,
 *  stagingUrl (the staging origin)}`. Since M6-P6h an OPTIONAL override (site-build-targets.ts states the precedence). */
export type RebuildTarget = RebuildTargetEntry;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Targets (the env override, then the registry)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

/** Parse `WEBDESK_REBUILD_TARGETS`. A malformed document or entry is dropped and logged, so a typo can
 *  only ever REMOVE a target (every rebuild for it then fails `rebuild_not_configured`, visibly). */
export function parseRebuildTargets(json: string, warn: (m: string) => void = (m) => logger.warn(m)): RebuildTarget[] {
  if (!json.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    warn("WEBDESK_REBUILD_TARGETS is not valid JSON; no rebuild target is configured");
    return [];
  }
  if (!Array.isArray(raw)) {
    warn("WEBDESK_REBUILD_TARGETS must be a JSON array; no rebuild target is configured");
    return [];
  }
  const out: RebuildTarget[] = [];
  raw.forEach((e, i) => {
    const o = e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
    const bad = (why: string) => warn(`WEBDESK_REBUILD_TARGETS[${i}] dropped: ${why}`);
    if (!o) return bad("not an object");
    const { tenantSlug, siteId, repo, workflow, ref, stagingUrl } = o;
    if (typeof tenantSlug !== "string" || !SLUG_RE.test(tenantSlug)) return bad("tenantSlug");
    if (typeof siteId !== "string" || !UUID_RE.test(siteId)) return bad("siteId");
    if (typeof repo !== "string" || !REPO_RE.test(repo)) return bad("repo");
    if (typeof workflow !== "string" || !WORKFLOW_RE.test(workflow)) return bad("workflow");
    if (typeof ref !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) return bad("ref");
    let origin: string;
    try {
      const u = new URL(String(stagingUrl));
      if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) return bad("stagingUrl must be https");
      origin = u.origin;
    } catch {
      return bad("stagingUrl");
    }
    out.push({ tenantSlug, siteId: siteId.toLowerCase(), repo, workflow, ref, stagingUrl: origin });
  });
  return out;
}

let targetsCache: { json: string; targets: RebuildTarget[] } | null = null;
export function rebuildTargets(): RebuildTarget[] {
  const json = config.webdeskRebuild.targetsJson;
  if (!targetsCache || targetsCache.json !== json) targetsCache = { json, targets: parseRebuildTargets(json) };
  return targetsCache.targets;
}

/** The env OVERRIDE entry for exactly this site, or null. Synchronous and database-free (WSK-60's lookup, unchanged). */
export function rebuildTargetFor(tenantSlug: string, siteId: string): RebuildTarget | null {
  const id = siteId.toLowerCase();
  return rebuildTargets().find((t) => t.siteId === id && t.tenantSlug === tenantSlug) ?? null;
}

interface RegistryFactsRow {
  provisioned_site_id: string; webdesk_tenant_slug: string | null; provider: string; status: string; framework: string; repo_url: string | null;
  completion_state: string | null; scaffold_state: string | null; scaffold_branch: string | null;
  deploy_grant_state: string | null; deploy_grant_secret_names: string[] | null; deploy_grant_repository_id: string | number | null;
  staging_id: string | null; staging_domain: string | null; staging_kind: string | null; staging_origin: string | null; staging_deleted: boolean | null;
  production_id: string | null; production_domain: string | null;
}

const REGISTRY_FACTS_SQL = `
  SELECT p.id AS provisioned_site_id, p.webdesk_tenant_slug, p.provider, p.status, p.framework, p.repo_url,
         p.completion_state, p.scaffold_state, p.scaffold_branch,
         p.deploy_grant_state, p.deploy_grant_secret_names, p.deploy_grant_repository_id,
         s.id AS staging_id, s.domain AS staging_domain, s.kind AS staging_kind, s.origin AS staging_origin,
         (s.deleted_at IS NOT NULL) AS staging_deleted,
         pr.id AS production_id, pr.domain AS production_domain
    FROM webdev_provisioned_sites p
    LEFT JOIN webdev_sites s ON s.tenant_id = p.tenant_id AND s.id = p.webdev_site_id
    LEFT JOIN LATERAL (
      SELECT x.id, x.domain FROM webdev_sites x
       WHERE x.tenant_id = p.tenant_id AND x.promoted_from_site_id = p.webdev_site_id AND x.deleted_at IS NULL
       ORDER BY x.created_at, x.id LIMIT 1
    ) pr ON true`;

function factsOf(r: RegistryFactsRow): RegistryBuildFacts {
  const repoId = r.deploy_grant_repository_id === null ? null : Number(r.deploy_grant_repository_id);
  return {
    provisionedSiteId: r.provisioned_site_id,
    provider: r.provider,
    status: r.status,
    framework: r.framework,
    repoUrl: r.repo_url,
    completionState: r.completion_state,
    scaffoldState: r.scaffold_state,
    scaffoldBranch: r.scaffold_branch,
    grantState: r.deploy_grant_state,
    grantSecretNames: r.deploy_grant_secret_names ?? [],
    grantRepositoryId: repoId !== null && Number.isSafeInteger(repoId) ? repoId : null,
    staging: r.staging_id
      ? { siteId: r.staging_id, domain: r.staging_domain ?? "", kind: r.staging_kind, origin: r.staging_origin ?? "", deleted: r.staging_deleted === true }
      : null,
    production: r.production_id ? { siteId: r.production_id, domain: r.production_domain ?? "" } : null,
  };
}

/** The live (not `failed`) provisioned sites of this company linked to a WebDesk tenant, with their registry rows. Both RLS
 *  walls are set: another company's provisioned site is invisible here, so it can never be a target. */
export async function readRegistryBuildFacts(tenantId: string, tenantSlug: string): Promise<RegistryBuildFacts[]> {
  const r = await inWebdev(tenantId, (c) =>
    c.query<RegistryFactsRow>(
      `${REGISTRY_FACTS_SQL}
        WHERE p.tenant_id = $1 AND p.webdesk_tenant_slug = $2 AND p.status <> 'failed'
        ORDER BY p.created_at, p.id`,
      [tenantId, tenantSlug],
    ),
  );
  return r.rows.map(factsOf);
}

/**
 * M6-P6h: the target for ONE environment of a WebDesk site. Staging: the env override for exactly (tenantSlug, siteId) when
 * one exists (no database read: the proof site resolves exactly as before), else the registry. Production: the registry only.
 * Throws only when the registry cannot be read (the caller treats that as "the ledger is unavailable").
 */
export async function resolveSiteBuildTarget(
  tenantId: string,
  tenantSlug: string,
  siteId: string,
  environment: BuildEnvironment,
): Promise<TargetDerivation> {
  if (environment === "staging") {
    const entry = rebuildTargetFor(tenantSlug, siteId);
    if (entry) return { ok: true, target: overrideTarget(entry) };
  }
  return deriveRegistryTarget(await readRegistryBuildFacts(tenantId, tenantSlug), environment);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The ledger (all access: tenant + the `webdev` module scope — the third wall)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const inWebdev = <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  withTenants([tenantId], fn, { modules: ["webdev"] });

interface BuildRow {
  id: string;
  approval_id: string | null;
  kind: LedgerKind;
  state: BuildState;
  requested_at: Date;
  dispatched_at: Date | null;
  published_at: Date | null;
  staging_url: string | null;
  verified_at: Date | null;
  failure_reason: string | null;
  site_id: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What the editor reads. The newest STAGING build for the site (a production promote is not on this wire: M6-P6h), and
 *  whether staging still shows taken-down content. */
export async function getBuildStatus(tenantId: string, tenantSlug: string, siteId: string): Promise<BuildStatusBody> {
  const { build, stale } = await inWebdev(tenantId, async (c) => {
    const b = await c.query<BuildRow>(
      `SELECT id, approval_id, kind, state, requested_at, dispatched_at, published_at, staging_url, verified_at, failure_reason, site_id
         FROM webdev_site_builds
        WHERE tenant_id = $1 AND site_id = $2 AND tenant_slug = $3 AND kind IN ('publish', 'rebuild')
        ORDER BY requested_at DESC, id DESC
        LIMIT 1`,
      [tenantId, siteId, tenantSlug],
    );
    const m = await c.query<{ stale_since: Date | null }>(
      `SELECT stale_since FROM webdev_site_staging_marks WHERE tenant_id = $1 AND site_id = $2`,
      [tenantId, siteId],
    );
    return { build: b.rows[0] ?? null, stale: m.rows[0]?.stale_since != null };
  });
  return {
    build: build
      ? {
          approvalId: build.approval_id,
          kind: build.kind as BuildKind, // the query admits publish | rebuild only
          requestedAt: build.requested_at.toISOString(),
          publishedAt: iso(build.published_at),
          state: build.state,
          stagingUrl: build.staging_url,
          verifiedAt: iso(build.verified_at),
        }
      : null,
    stagingStale: stale,
  };
}

/** The typed reason of a site's newest failed build, for operator surfaces (the approval's execution
 *  result carries the same token). Not part of the editor's wire shape. */
export async function getLatestFailureReason(tenantId: string, siteId: string): Promise<string | null> {
  return inWebdev(tenantId, async (c) => {
    const r = await c.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM webdev_site_builds
        WHERE tenant_id = $1 AND site_id = $2 AND kind IN ('publish', 'rebuild') ORDER BY requested_at DESC, id DESC LIMIT 1`,
      [tenantId, siteId],
    );
    return r.rows[0]?.failure_reason ?? null;
  });
}

/** Content was taken down (unpublish/delete): staging keeps showing it until the next rebuild. Idempotent;
 *  keeps the EARLIEST instant while the marker is set. Called by the unpublish/delete handler (WSK-59). */
export async function noteStagingStale(tenantId: string, siteId: string): Promise<void> {
  await inWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_site_staging_marks (tenant_id, site_id, stale_since) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id, site_id)
       DO UPDATE SET stale_since = COALESCE(webdev_site_staging_marks.stale_since, now()), updated_at = now()`,
      [tenantId, siteId],
    ),
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The console's read: each environment's target readiness and newest build (M6-P6h)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** One ledger row as the console reads it. Unlike the editor's wire, it carries the typed failure reason. */
export interface SiteEnvBuildDto {
  approvalId: string | null;
  kind: LedgerKind;
  state: BuildState;
  requestedAt: string;
  dispatchedAt: string | null;
  verifiedAt: string | null;
  failureReason: string | null;
}

export interface SiteBuildEnvironmentDto {
  environment: BuildEnvironment;
  /** `https://<domain>` of the environment's registry row; null while it has no row or only the `.invalid` placeholder. */
  siteUrl: string | null;
  /** Whether a dispatch to this environment could start now (a staging rebuild; a production promote), and if not, why:
   *  the same typed token the ledger would record (site-build-targets.ts). Re-derived at every dispatch, never cached. */
  target: { ready: true; reason: null } | { ready: false; reason: BuildTargetRefusal };
  /** The newest build of this environment (staging: publish | rebuild; production: promote), or null when there is none. */
  latest: SiteEnvBuildDto | null;
}

export interface SiteBuildsDto {
  /** Always `[staging, production]` for a provisioned site. */
  environments: SiteBuildEnvironmentDto[];
}

/** M6-P6h: is a production promote of this site (WebDesk tenant) still in flight, i.e. a `promote` row still `rebuilding`?
 *  The filing route's early refusal; `startSitePromote` re-reads it under a lock before it dispatches. */
export async function promoteInFlight(tenantId: string, tenantSlug: string): Promise<boolean> {
  const r = await inWebdev(tenantId, (c) =>
    c.query(
      `SELECT 1 FROM webdev_site_builds
        WHERE tenant_id = $1 AND tenant_slug = $2 AND kind = 'promote' AND state = 'rebuilding'
        LIMIT 1`,
      [tenantId, tenantSlug],
    ),
  );
  return r.rows.length > 0;
}

const STAGING_KINDS: readonly LedgerKind[] = ["publish", "rebuild"];
const PRODUCTION_KINDS: readonly LedgerKind[] = ["promote"];

/** The build/promote state per environment of ONE provisioned site, for the console (`GET provisioned-sites/:id` →
 *  `builds`). null when the provisioned site is not this company's (RLS) or does not exist. */
export async function readSiteBuildsForProvisioned(tenantId: string, provisionedSiteId: string): Promise<SiteBuildsDto | null> {
  return inWebdev(tenantId, async (c) => {
    const r = await c.query<RegistryFactsRow>(`${REGISTRY_FACTS_SQL} WHERE p.tenant_id = $1 AND p.id = $2`, [tenantId, provisionedSiteId]);
    const row = r.rows[0];
    if (!row) return null;
    const facts = factsOf(row);
    const environments: SiteBuildEnvironmentDto[] = [];
    for (const environment of ["staging", "production"] as const) {
      const derived = deriveRegistryTarget([facts], environment);
      const domain = environment === "staging" ? facts.staging?.domain : facts.production?.domain;
      let latest: SiteEnvBuildDto | null = null;
      if (row.webdesk_tenant_slug) {
        const b = await c.query<{
          approval_id: string | null; kind: LedgerKind; state: BuildState; requested_at: Date; dispatched_at: Date | null;
          verified_at: Date | null; failure_reason: string | null;
        }>(
          `SELECT approval_id, kind, state, requested_at, dispatched_at, verified_at, failure_reason
             FROM webdev_site_builds
            WHERE tenant_id = $1 AND tenant_slug = $2 AND kind = ANY($3::text[])
            ORDER BY requested_at DESC, id DESC
            LIMIT 1`,
          [tenantId, row.webdesk_tenant_slug, environment === "staging" ? STAGING_KINDS : PRODUCTION_KINDS],
        );
        const x = b.rows[0];
        latest = x
          ? {
              approvalId: x.approval_id, kind: x.kind, state: x.state, requestedAt: x.requested_at.toISOString(),
              dispatchedAt: iso(x.dispatched_at), verifiedAt: iso(x.verified_at), failureReason: x.failure_reason,
            }
          : null;
      }
      environments.push({
        environment,
        siteUrl: siteUrlOf(domain),
        target: derived.ok ? { ready: true, reason: null } : { ready: false, reason: derived.reason },
        latest,
      });
    }
    return { environments };
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Dispatch
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface StartRebuildInput {
  /** The company the approval was filed under (the ledger's tenant). */
  tenantId: string;
  tenantSlug: string;
  siteId: string;
  /** The approval whose decision authorises this dispatch (WSK-D46 / R3). */
  approvalId: string;
  kind: BuildKind;
  /** The newest `publishedAt` Zone B reported (publish only); null when unknown. */
  publishedAt: string | null;
  /** The human who decided the approval. Authorised against `github_repo · deploy`. null (WSK-61's
   *  scheduled publish only) = the decider can no longer be assembled: the row is recorded `failed`,
   *  reason `decider_inactive`, and nothing is dispatched. */
  decider: Principal | null;
  /** Recorded as `decided_by` when `decider` is null. */
  decidedBy?: string | null;
  /** WSK-D65: set ONLY by the approved-command executor when the decider of an executed publish is a CLIENT editor. The dispatch
   *  then re-verifies it server-side instead of running `authorizeDeploy` (see `ClientPublishAuthority`). Never passed for a staff
   *  decider, for a `rebuild`, or for a scheduled publish. */
  authority?: ClientPublishAuthority;
}

export interface StartRebuildResult {
  buildId: string | null;
  state: BuildState;
  failureReason: BuildFailureReason | null;
  /** true when this approval already had a build and NOTHING was dispatched. */
  deduplicated: boolean;
  /** M6-P6h: true when the site is a wp site, whose theme reads /v1 live: there is nothing to rebuild, NO ledger row was
   *  written and nothing was dispatched (`state` is then `failed`, `failureReason` `rebuild_not_applicable`, `buildId` null).
   *  A caller shows "no rebuild needed", never a failed build. */
  notApplicable?: true;
}

function parsedInstant(v: string | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function markFailed(tenantId: string, buildId: string, reason: BuildFailureReason): Promise<void> {
  await inWebdev(tenantId, (c) =>
    c.query(
      `UPDATE webdev_site_builds SET state = 'failed', failure_reason = $3, updated_at = now()
        WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'`,
      [tenantId, buildId, reason],
    ),
  );
}

const ledgerUnavailable = (): StartRebuildResult => ({ buildId: null, state: "failed", failureReason: "build_ledger_unavailable", deduplicated: false });

/**
 * Claim a build row for the approval and dispatch ONE workflow run. Never throws.
 *
 * Idempotent per approval: a second call finds the first's row and returns it untouched (the dispatch is
 * not repeated), whatever state it is in.
 *
 * M6-P6h: the target is `resolveSiteBuildTarget(…, "staging")` (the env override, then the registry). A wp site returns
 * `notApplicable` and writes nothing.
 */
export async function startSiteRebuild(input: StartRebuildInput): Promise<StartRebuildResult> {
  let resolved: TargetDerivation;
  try {
    resolved = await resolveSiteBuildTarget(input.tenantId, input.tenantSlug, input.siteId, "staging");
  } catch (err) {
    logger.error(`approval ${input.approvalId}: the build target could not be read: ${(err as Error).message}`);
    return ledgerUnavailable();
  }
  if (!resolved.ok && resolved.reason === "rebuild_not_applicable") {
    logger.log(`approval ${input.approvalId}: ${resolved.detail}; nothing recorded, nothing dispatched`);
    return { buildId: null, state: "failed", failureReason: "rebuild_not_applicable", deduplicated: false, notApplicable: true };
  }
  const target = resolved.ok ? resolved.target : null;
  // WSK-D65: a client-publish authority must name exactly the tenant, approval and site this call rebuilds. The dispatcher
  // re-verifies the authority against its OWN site, while the target dispatched is this call's: without this check a valid
  // authority for site X could start site Y's configured rebuild. The only issuer passes the same values; this makes it structural.
  const a = input.authority;
  const authorityMismatch =
    !!a && (a.tenantId !== input.tenantId || a.approvalId !== input.approvalId || a.tenantSlug !== input.tenantSlug || a.siteId !== input.siteId);
  const refusal: BuildFailureReason | null = !resolved.ok
    ? resolved.reason
    : input.decider === null
      ? "decider_inactive"
      : authorityMismatch
        ? "client_publish_unverified"
        : null;

  const claimed = await claimBuildRow({
    tenantId: input.tenantId, tenantSlug: input.tenantSlug, siteId: input.siteId, approvalId: input.approvalId,
    kind: input.kind, publishedAt: parsedInstant(input.publishedAt), target, refusal,
    decidedBy: input.decider ? (input.decider.userId ?? null) : (input.decidedBy ?? null),
  });
  if (!claimed.won) return claimed.result;
  const buildId = claimed.buildId;

  if (claimed.refusal || !target || input.decider === null) {
    logger.warn(
      !resolved.ok
        ? `approval ${input.approvalId}: no staging target for site ${input.siteId} (${resolved.reason}: ${resolved.detail})`
        : input.decider === null
          ? `approval ${input.approvalId}: the decider is no longer active; nothing dispatched`
          : `approval ${input.approvalId}: the client-publish authority does not name this site; nothing dispatched`,
    );
    return { buildId, state: "failed", failureReason: claimed.refusal, deduplicated: false };
  }

  return dispatchAndRecord({
    tenantId: input.tenantId,
    approvalId: input.approvalId,
    buildId,
    decider: input.decider,
    target,
    authority: input.authority,
    // WSK-60's inputs, byte-for-byte, for the override (the proof site's workflow declares no `environment`); the template's
    // site.yml also takes `environment` and is told `staging` explicitly rather than relying on its default.
    inputs: {
      approval_id: input.approvalId,
      kind: input.kind,
      ...(input.publishedAt ? { published_at: input.publishedAt } : {}),
      ...(target.sendsEnvironment ? { environment: "staging" } : {}),
    },
  });
}

export interface StartPromoteInput {
  /** The company the approval was filed under (the ledger's tenant). */
  tenantId: string;
  tenantSlug: string;
  /** The WebDesk site the promote was filed for (the ledger's `site_id`, as for a staging build). */
  siteId: string;
  /** The approved `site.promote` (HIGH, maker ≠ checker) that authorises this production dispatch. */
  approvalId: string;
  /** The decider. Authorised against `github_repo · deploy` at decide() AND again by the chokepoint at the send. */
  decider: Principal;
}

/**
 * M6-P6h — a production PROMOTE: claim ONE `kind = 'promote'` row for the approval and dispatch the template's `site.yml`
 * with `kind=promote`, `environment=production` and the approval id. Never throws.
 *
 * Refused, with a `failed` row naming why and NOTHING dispatched, when: the production target cannot be resolved from the
 * registry (`production_not_registered`, `site_url_unknown`, `production_secret_not_granted`, …: site-build-targets.ts), or
 * another promote for the same site (WebDesk tenant) is still `rebuilding` (`promote_in_flight`). The in-flight read and the
 * claim run in ONE transaction under an advisory lock on (company, site), so two promotes executed at the same moment cannot
 * both pass it. Idempotent per approval exactly like a staging build (UNIQUE (tenant_id, approval_id)).
 */
export async function startSitePromote(input: StartPromoteInput): Promise<StartRebuildResult> {
  let resolved: TargetDerivation;
  try {
    resolved = await resolveSiteBuildTarget(input.tenantId, input.tenantSlug, input.siteId, "production");
  } catch (err) {
    logger.error(`promote ${input.approvalId}: the production target could not be read: ${(err as Error).message}`);
    return ledgerUnavailable();
  }
  const target = resolved.ok ? resolved.target : null;
  const claimed = await claimBuildRow({
    tenantId: input.tenantId, tenantSlug: input.tenantSlug, siteId: input.siteId, approvalId: input.approvalId,
    kind: "promote", publishedAt: null, target, refusal: resolved.ok ? null : resolved.reason,
    decidedBy: input.decider.userId ?? null,
    promoteLock: true,
  });
  if (!claimed.won) return claimed.result;
  if (claimed.refusal || !target) {
    logger.warn(`promote ${input.approvalId}: nothing dispatched (${claimed.refusal}${resolved.ok ? "" : `: ${resolved.detail}`})`);
    return { buildId: claimed.buildId, state: "failed", failureReason: claimed.refusal, deduplicated: false };
  }
  return dispatchAndRecord({
    tenantId: input.tenantId,
    approvalId: input.approvalId,
    buildId: claimed.buildId,
    decider: input.decider,
    target,
    inputs: { approval_id: input.approvalId, kind: "promote", environment: "production" },
  });
}

type Claim =
  | { won: true; buildId: string; refusal: BuildFailureReason | null }
  | { won: false; result: StartRebuildResult };

/** INSERT the approval's ONE ledger row (`failed` with the refusal, or `rebuilding`), or find the row it already has. For a
 *  promote, also refuse while another promote of the same site is in flight, under an advisory lock in the same transaction. */
async function claimBuildRow(p: {
  tenantId: string; tenantSlug: string; siteId: string; approvalId: string; kind: LedgerKind; publishedAt: Date | null;
  target: BuildTarget | null; refusal: BuildFailureReason | null; decidedBy: string | null; promoteLock?: boolean;
}): Promise<Claim> {
  try {
    const id = newId();
    return await inWebdev(p.tenantId, async (c) => {
      let refusal = p.refusal;
      if (p.promoteLock) {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`webdev_site_builds:promote:${p.tenantId}:${p.tenantSlug}`]);
        if (!refusal) {
          const busy = await c.query(
            `SELECT 1 FROM webdev_site_builds
              WHERE tenant_id = $1 AND tenant_slug = $2 AND kind = 'promote' AND state = 'rebuilding' AND approval_id IS DISTINCT FROM $3
              LIMIT 1`,
            [p.tenantId, p.tenantSlug, p.approvalId],
          );
          if (busy.rows[0]) refusal = "promote_in_flight";
        }
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO webdev_site_builds
           (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, published_at, repo, ref, staging_url, decided_by, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, approval_id) DO NOTHING
         RETURNING id`,
        [
          id, p.tenantId, p.tenantSlug, p.siteId, p.approvalId, p.kind,
          refusal ? "failed" : "rebuilding",
          p.publishedAt,
          p.target?.repo ?? null, p.target?.ref ?? null, p.target?.stampBase ?? null,
          p.decidedBy,
          refusal,
        ],
      );
      if (r.rows[0]) return { won: true as const, buildId: id, refusal };
      const existing = await c.query<{ id: string; state: BuildState; failure_reason: BuildFailureReason | null }>(
        `SELECT id, state, failure_reason FROM webdev_site_builds WHERE tenant_id = $1 AND approval_id = $2`,
        [p.tenantId, p.approvalId],
      );
      const e = existing.rows[0];
      return {
        won: false as const,
        result: { buildId: e?.id ?? null, state: e?.state ?? "failed", failureReason: e?.failure_reason ?? null, deduplicated: true },
      };
    });
  } catch (err) {
    logger.error(`build ledger write failed for approval ${p.approvalId}: ${(err as Error).message}`);
    return { won: false, result: ledgerUnavailable() };
  }
}

/** Send the ONE dispatch for a claimed row, bounded by the dispatch deadline, and record its outcome on the row. */
async function dispatchAndRecord(p: {
  tenantId: string; approvalId: string; buildId: string; decider: Principal; target: BuildTarget;
  authority?: ClientPublishAuthority; inputs: Record<string, string>;
}): Promise<StartRebuildResult> {
  const { tenantId, approvalId, buildId, target } = p;
  // The dispatch, bounded: decide() must not hang on a GitHub that is slow or rate-limiting us.
  let deadline: NodeJS.Timeout | undefined;
  const raced = await Promise.race([
    dispatchApprovedWorkflow({
      decider: p.decider,
      requestTenantId: tenantId,
      approvalId,
      repo: target.repo,
      workflow: target.workflow,
      ref: target.ref,
      ...(p.authority ? { authority: p.authority } : {}),
      inputs: p.inputs,
    }).then(
      (ok) => ({ tag: "ok" as const, ok }),
      (error: unknown) => ({ tag: "err" as const, error }),
    ),
    new Promise<{ tag: "deadline" }>((resolve) => {
      deadline = setTimeout(() => resolve({ tag: "deadline" }), config.webdeskRebuild.dispatchDeadlineMs);
    }),
  ]);
  if (deadline) clearTimeout(deadline);

  try {
    if (raced.tag === "ok") {
      await inWebdev(tenantId, (c) =>
        c.query(
          `UPDATE webdev_site_builds
              SET dispatched_at = now(), github_correlation_id = $3, updated_at = now()
            WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'`,
          [tenantId, buildId, raced.ok.correlationId],
        ),
      );
      return { buildId, state: "rebuilding", failureReason: null, deduplicated: false };
    }
    const reason: BuildFailureReason =
      raced.tag === "deadline"
        ? "dispatch_unconfirmed"
        : raced.error instanceof WorkflowDispatchError
          ? raced.error.reason
          : "github_dispatch_failed";
    if (raced.tag === "err" && !(raced.error instanceof WorkflowDispatchError)) {
      logger.error(`approval ${approvalId}: unexpected dispatch error: ${(raced.error as Error)?.name ?? "error"}`);
    } else {
      logger.warn(`approval ${approvalId}: ${target.environment} build not dispatched (${reason})`);
    }
    await markFailed(tenantId, buildId, reason);
    return { buildId, state: "failed", failureReason: reason, deduplicated: false };
  } catch (err) {
    // The dispatch happened (or not) but the row could not be updated. The sweeper fails a row that
    // never got a dispatch time, so the ledger converges on "failed: dispatch_unconfirmed", never "live".
    logger.error(`approval ${approvalId}: could not record the dispatch outcome: ${(err as Error).message}`);
    return { buildId, state: "rebuilding", failureReason: null, deduplicated: false };
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The stamp poll
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type PollOutcome = "live" | "unverified" | "rebuilding" | "skipped";

export interface PollOptions extends StampFetchOptions {
  /** Injected clock for the window check. Defaults to now. */
  now?: Date;
  windowMs?: number;
}

/** Poll ONE build's stamp once and settle it if the stamp (or the window) decides it. M6-P6h: a promote row is polled the
 *  same way; its `staging_url` holds the PRODUCTION stamp base, so a promote is `live` only through the production URL. */
export async function pollSiteBuild(tenantId: string, buildId: string, opts: PollOptions = {}): Promise<PollOutcome> {
  const row = await inWebdev(tenantId, async (c) => {
    const r = await c.query<BuildRow & { poll_count: number }>(
      `SELECT id, approval_id, kind, state, requested_at, dispatched_at, published_at, staging_url, verified_at, failure_reason, site_id, poll_count
         FROM webdev_site_builds WHERE id = $2 AND tenant_id = $1`,
      [tenantId, buildId],
    );
    return r.rows[0] ?? null;
  });
  if (!row || row.state !== "rebuilding" || !row.dispatched_at || !row.staging_url) return "skipped";

  const read = await readStagingStamp(row.staging_url, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    nonce: `${buildId}-${row.poll_count + 1}`,
  });
  // M6-P6h: a TEMPLATE stamp that names ANOTHER approval may still settle a staging build, when that approval is a later
  // staging dispatch of the same site (the "laterDispatch" proof, site-build-stamp.ts). Look that row up here; the stamp's
  // approval id is untrusted text from the site, so it is shape-checked before it touches a uuid column.
  let coveringDispatchedAt: Date | null = null;
  const served = read.ok ? read.stamp : null;
  const servedApproval = served?.buildId && served.approvalId ? served.approvalId.toLowerCase() : null;
  if (servedApproval && row.kind !== "promote" && UUID_RE.test(servedApproval) && servedApproval !== (row.approval_id ?? "").toLowerCase()) {
    const cover = await inWebdev(tenantId, (c) =>
      c.query<{ dispatched_at: Date }>(
        `SELECT dispatched_at FROM webdev_site_builds
          WHERE tenant_id = $1 AND approval_id = $2::uuid AND site_id = $3 AND kind IN ('publish', 'rebuild') AND dispatched_at IS NOT NULL`,
        [tenantId, servedApproval, row.site_id],
      ),
    );
    coveringDispatchedAt = cover.rows[0]?.dispatched_at ?? null;
  }
  const proof = read.ok
    ? stampProves(read.stamp, {
        kind: row.kind,
        publishedAt: row.published_at,
        dispatchedAt: row.dispatched_at,
        approvalId: row.approval_id,
        environment: row.kind === "promote" ? "production" : "staging",
        coveringDispatchedAt,
      })
    : ({ proved: false, why: `stamp unreadable (${read.reason})` } as const);

  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? config.webdeskRebuild.pollWindowMs;
  const expired = now.getTime() >= row.dispatched_at.getTime() + windowMs;
  const next: "live" | "unverified" | null = proof.proved ? "live" : expired ? "unverified" : null;

  return inWebdev(tenantId, async (c) => {
    // The state guard makes a settle single-winner: a concurrent poll (or a second process) cannot flip
    // a settled row, and `live` can only be written by the branch that holds a proof.
    const stamp = read.ok ? read.stamp : null;
    const upd = await c.query<{ dispatched_at: Date }>(
      `UPDATE webdev_site_builds
          SET last_polled_at = now(), poll_count = poll_count + 1,
              last_stamp_pulled_at = COALESCE($3, last_stamp_pulled_at),
              last_stamp_max_updated_at = COALESCE($4, last_stamp_max_updated_at),
              state = COALESCE($5, state),
              verified_at = CASE WHEN $5 = 'live' THEN now() ELSE verified_at END,
              updated_at = now()
        WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'
        RETURNING dispatched_at`,
      [tenantId, buildId, stamp?.pulledAt ?? null, stamp?.maxUpdatedAt ?? null, next],
    );
    if (!upd.rows[0]) return "skipped" as const;
    // The "staging is stale" mark is staging's: a production promote going live clears nothing.
    if (next === "live" && row.kind !== "promote") {
      await c.query(
        `UPDATE webdev_site_staging_marks SET stale_since = NULL, updated_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND stale_since IS NOT NULL AND stale_since <= $3`,
        [tenantId, row.site_id, upd.rows[0].dispatched_at],
      );
    }
    return next ?? ("rebuilding" as const);
  });
}

/** How long a row may sit `rebuilding` with no dispatch time before it is failed as unconfirmed. */
const ORPHAN_AFTER_MS = 5 * 60_000;

export interface SweepResult {
  considered: number;
  polled: number;
  live: number;
  unverified: number;
  orphansFailed: number;
}

/** One pass over every webdev-enabled company: fail orphaned rows, poll due ones. */
export async function sweepSiteBuilds(opts: PollOptions = {}): Promise<SweepResult> {
  const out: SweepResult = { considered: 0, polled: 0, live: 0, unverified: 0, orphansFailed: 0 };
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`));
  for (const co of companies.rows) {
    // The same question the monitoring runner asks: declaring the module scope is not the same as the
    // tenant having the module, so a background job must ask isModuleEnabled itself.
    if (!(await isModuleEnabled(co.id, "webdev"))) continue;
    const due = await inWebdev(co.id, async (c) => {
      const orphans = await c.query(
        `UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed', updated_at = now()
          WHERE tenant_id = $1 AND state = 'rebuilding' AND dispatched_at IS NULL AND requested_at < now() - ($2::int * interval '1 millisecond')`,
        [co.id, ORPHAN_AFTER_MS],
      );
      out.orphansFailed += orphans.rowCount ?? 0;
      const r = await c.query<{ id: string }>(
        `SELECT id FROM webdev_site_builds
          WHERE tenant_id = $1 AND state = 'rebuilding' AND dispatched_at IS NOT NULL
            AND (last_polled_at IS NULL OR last_polled_at <= now() - ($2::int * interval '1 millisecond'))
          ORDER BY requested_at`,
        [co.id, Math.max(1, Math.floor(config.webdeskRebuild.pollIntervalMs * 0.9))],
      );
      return r.rows;
    });
    out.considered += due.length;
    for (const b of due) {
      try {
        const o = await pollSiteBuild(co.id, b.id, opts);
        if (o !== "skipped") out.polled++;
        if (o === "live") out.live++;
        if (o === "unverified") out.unverified++;
      } catch (err) {
        logger.error(`poll of build ${b.id} failed: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

/** The poll loop. Chained setTimeout (a slow sweep cannot overlap itself), the monitoring runner's shape.
 *  Started by main.ts when an env override target exists or the WebDesk control channel is configured (M6-P6h: registry
 *  targets cannot be counted at boot); it polls only rows that exist.
 *  `beforeSweep` (WSK-61: the scheduled-publish settle) runs first in each tick, so a build it starts is
 *  polled from the next tick on; its failure is logged and never stops the poll. */
export function startSiteBuildsLoop(intervalMs: number, opts: { beforeSweep?: () => Promise<unknown> } = {}): { stop: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.error(`refusing to start the site-builds poller: intervalMs=${intervalMs} is not positive`);
    return { stop: () => undefined };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    if (opts.beforeSweep) {
      try {
        await opts.beforeSweep();
      } catch (err) {
        logger.error(`pre-sweep step failed: ${(err as Error).message}`);
      }
    }
    try {
      const r = await sweepSiteBuilds();
      if (r.polled > 0 || r.orphansFailed > 0) logger.log(`sweep: ${JSON.stringify(r)}`);
    } catch (err) {
      logger.error(`sweep failed: ${(err as Error).message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
