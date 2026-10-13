// M6-P6h — WHERE a site build goes: the staging rebuild and the production promote target, read from the registry instead of
// one line of env JSON. Plan: docs/plans/2026-10-11-webdesk-m6-plan.md §6.3 ("one deploy job, two triggers") and the M6-P6h row.
//
// Pure: no database, no clock, no network. `site-builds.service.ts` reads the facts (one query, both RLS walls) and this file
// decides; the unit suite (site-build-targets.unit.test.ts) drives every branch.
//
// ═══ THE PRECEDENCE (one rule, stated once) ═══════════════════════════════════════════════════════════
//   1. STAGING only: an entry in `WEBDESK_REBUILD_TARGETS` for exactly (tenantSlug, siteId) wins, unchanged from WSK-60. It is
//      now an OPTIONAL override, kept for the one hand-built site that is not template-built: the proof site (`gaiada`,
//      repo gaiada-web-revamp, workflow `webdesk-rebuild.yml`, ref `webdesk-rebuild-proof-site`, staging cms-proof). It is
//      resolved WITHOUT a database read, its dispatch inputs are byte-for-byte WSK-60's (no `environment` input: that
//      workflow does not declare one, and GitHub refuses an unknown input with 422), and its stamp is read at its origin.
//   2. Otherwise the REGISTRY: the ONE provisioned site of this company whose WebDesk tenant is `tenantSlug`
//      (`webdev_provisioned_sites.webdesk_tenant_slug`, set by M6-P4c, one WebDesk tenant per provisioned site), with
//        repo      its GH-12 repo (`repo_url`, an https://github.com/<owner>/<name> URL)
//        workflow  `site.yml`, the template's one deploy workflow (M6-P6f)
//        ref       the default branch the scaffold committed to (`scaffold_branch`; the template's plan.sh refuses a dispatch
//                  from any other ref)
//        URL       https://<domain> of the environment's REGISTRY row: the staging row M6-P4c registered, or the production
//                  row M6-P6g created from it (`promoted_from_site_id`). The `.provisioned.invalid` placeholder is no URL.
//        kind      the staging row's `kind` (else the framework's, the one FRAMEWORK_TO_KIND table)
//        stamp     static and fullstack: <URL>/webdesk-build.json; wp: <URL>/wp-content/themes/<theme>/webdesk-build.json
//   3. Production NEVER reads the env override: a promote is registry-only. The proof site has no promote.
//
// ═══ WHICH KIND BUILDS WHAT ═══════════════════════════════════════════════════════════════════════════
//   static     a publish (or an approved content.rebuild) rebuilds staging; a promote deploys production.
//   fullstack  its web half is a static export and behaves exactly like static (the API is M6-P6l, not a target here).
//   wp         the theme reads WebDesk's /v1 LIVE, so a publish changes nothing a build would carry: there is no staging
//              rebuild (`rebuild_not_applicable`, and no ledger row is written for it). It only PROMOTES (a theme release).
//
// ═══ A TARGET IS ONLY A TARGET WHEN THE DEPLOY COULD SUCCEED ══════════════════════════════════════════
// The template's deploy job reads its own per-site secret, `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>`, and fails without it. So a
// registry target also needs the M6-P4g grant: state `granted` AND the environment's per-site secret among the granted names
// (`siteDeploySecretName`, the ERP twin of the template's secret-name.sh, from the repo's name and the recorded GitHub
// repository id). Today P4g grants the STAGING per-site secret only, and its live grant is refused anyway while the App lacks
// `organization_secrets` (O-3), so a promote is refused `production_secret_not_granted` and dispatches nothing. That is the
// intended fail-closed state until P4g also grants the production name.
import { checkWebdeskEnvironmentDomain } from "./webdesk-domain";
import { siteDeploySecretName } from "./deploy-grant";
import { FRAMEWORK_TO_KIND, type CanonicalFramework, type SiteKind } from "./provision-provider";

export type BuildEnvironment = "staging" | "production";

/** The template's one deploy workflow (webdesk/templates/<kind>/.github/workflows/site.yml, M6-P6f). */
export const TEMPLATE_SITE_WORKFLOW = "site.yml";
/** The theme directory the wp template deploys and stamps (its workflow's `WEBDESK_WP_THEME`). */
export const WP_THEME_DIR = "gaiada-webdesk";

/** An env-JSON entry (`WEBDESK_REBUILD_TARGETS`), exactly WSK-60's shape. */
export interface RebuildTargetEntry {
  tenantSlug: string;
  siteId: string;
  repo: string;
  workflow: string;
  ref: string;
  stagingUrl: string;
}

/** A resolved target: everything one dispatch and its stamp poll need. */
export interface BuildTarget {
  /** `override` = the env entry (the proof site); `registry` = derived from the provisioned site and its registry rows. */
  source: "override" | "registry";
  environment: BuildEnvironment;
  /** `owner/name`. */
  repo: string;
  workflow: string;
  ref: string;
  /** The site's origin, e.g. `https://stg.acme.example`. */
  siteUrl: string;
  /** The base the stamp is read under (`<stampBase>/webdesk-build.json`). The origin, or the wp theme directory under it. */
  stampBase: string;
  /** null for the override (it does not say; the proof site is a static Astro build). */
  siteKind: SiteKind | null;
  /** Whether the dispatch carries the `environment` input. The template's site.yml declares it; the proof site's workflow does
   *  not, and GitHub answers an undeclared input with 422 (`workflow_not_dispatchable`). */
  sendsEnvironment: boolean;
}

/** Every typed reason a target cannot be resolved. Stored as `webdev_site_builds.failure_reason` (`^[a-z0-9_]{1,64}$`). */
export const BUILD_TARGET_REFUSALS = [
  /** No env entry and no provisioned site of this company is linked to this WebDesk tenant. WSK-60's original token. */
  "rebuild_not_configured",
  /** Two live provisioned sites claim the same WebDesk tenant: the ERP will not guess which repo to deploy. */
  "rebuild_target_ambiguous",
  /** The provisioned site is not template-built and scaffolded yet (no complete §08 completion, no committed scaffold, no
   *  default branch, no live provisioned registry row, or a repo_url that is not a GitHub repo). */
  "rebuild_target_incomplete",
  /** A wp site on a publish or rebuild: the theme reads /v1 live; only a promote deploys it. No ledger row is written. */
  "rebuild_not_applicable",
  /** The environment's registry row has no real domain yet (still the `.provisioned.invalid` placeholder). */
  "site_url_unknown",
  /** Staging: the repo is not granted its staging per-site deploy secret (M6-P4g), so the deploy job could only fail. */
  "deploy_not_granted",
  /** Promote: the site has no production registry row (M6-P6g's `POST sites/:id/production` has not been run). */
  "production_not_registered",
  /** Promote: the repo is not granted its PRODUCTION per-site deploy secret (M6-P4g), so the deploy job could only fail. */
  "production_secret_not_granted",
] as const;
export type BuildTargetRefusal = (typeof BUILD_TARGET_REFUSALS)[number];

export type TargetDerivation =
  | { ok: true; target: BuildTarget }
  | { ok: false; reason: BuildTargetRefusal; detail: string };

/** One provisioned site and its registry rows, as the derivation needs them (read under both RLS walls). */
export interface RegistryBuildFacts {
  provisionedSiteId: string;
  provider: string;
  status: string;
  framework: string;
  /** `webdev_provisioned_sites.repo_url`: the GH-12 repo. */
  repoUrl: string | null;
  completionState: string | null;
  scaffoldState: string | null;
  /** The default branch the scaffold committed to. */
  scaffoldBranch: string | null;
  grantState: string | null;
  grantSecretNames: string[];
  grantRepositoryId: number | null;
  /** The staging row M6-P4c registered (`webdev_site_id`); null when the link is missing. */
  staging: { siteId: string; domain: string; kind: string | null; origin: string; deleted: boolean } | null;
  /** The live production row M6-P6g created from it (`promoted_from_site_id`); null when there is none. */
  production: { siteId: string; domain: string } | null;
}

const SITE_KINDS: readonly string[] = ["static", "fullstack", "wp"];

/** `https://github.com/<owner>/<name>[.git][/]` → `{owner, name}`; anything else → null. */
export function parseGithubRepoUrl(url: string | null): { owner: string; name: string } | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== "github.com" || u.search || u.hash) return null;
  const parts = u.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return null;
  return { owner, name };
}

/** `https://<domain>` for a registry domain that is a real public host name, else null (the `.provisioned.invalid`
 *  placeholder, an IP literal, a port, a path). The same canonical-host rule WebDesk's CORS uses (webdesk-domain.ts). */
export function siteUrlOf(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const v = checkWebdeskEnvironmentDomain(domain);
  return v.ok ? `https://${v.domain}` : null;
}

/** Where the template writes its stamp: the site root (static, fullstack's static export) or the theme directory (wp). */
export function stampBaseFor(siteUrl: string, kind: SiteKind | null): string {
  return kind === "wp" ? `${siteUrl}/wp-content/themes/${WP_THEME_DIR}` : siteUrl;
}

/** The kind a provisioned site builds as: its staging row's `kind`, else its framework's. null when neither says. */
export function siteKindOf(f: Pick<RegistryBuildFacts, "staging" | "framework">): SiteKind | null {
  const fromRow = f.staging?.kind;
  if (fromRow && SITE_KINDS.includes(fromRow)) return fromRow as SiteKind;
  const fromFramework = (FRAMEWORK_TO_KIND as Readonly<Record<string, SiteKind>>)[f.framework as CanonicalFramework];
  return fromFramework ?? null;
}

/** Is this environment's per-site deploy secret among the names the M6-P4g grant holds, with the grant `granted`? */
export function perSiteSecretGranted(f: RegistryBuildFacts, environment: BuildEnvironment, repoName: string): boolean {
  if (f.grantState !== "granted" || f.grantRepositoryId === null) return false;
  let name: string;
  try {
    name = siteDeploySecretName({ slug: repoName, environment, repositoryId: f.grantRepositoryId });
  } catch {
    return false;
  }
  return f.grantSecretNames.some((n) => n.toUpperCase() === name);
}

/** The env entry as a resolved target: exactly WSK-60's dispatch (no `environment` input), its stamp at the origin. */
export function overrideTarget(e: RebuildTargetEntry): BuildTarget {
  return {
    source: "override",
    environment: "staging",
    repo: e.repo,
    workflow: e.workflow,
    ref: e.ref,
    siteUrl: e.stagingUrl,
    stampBase: e.stagingUrl,
    siteKind: null,
    sendsEnvironment: false,
  };
}

const refuse = (reason: BuildTargetRefusal, detail: string): TargetDerivation => ({ ok: false, reason, detail });

/**
 * Derive the target for one environment from the provisioned sites linked to a WebDesk tenant (normally exactly one).
 * `staging` is a publish's or a content.rebuild's target; `production` is a promote's.
 */
export function deriveRegistryTarget(rows: readonly RegistryBuildFacts[], environment: BuildEnvironment): TargetDerivation {
  if (rows.length === 0) {
    return refuse("rebuild_not_configured", "no provisioned site of this company is linked to this WebDesk tenant, and no WEBDESK_REBUILD_TARGETS entry names it");
  }
  if (rows.length > 1) {
    return refuse("rebuild_target_ambiguous", `${rows.length} provisioned sites claim this WebDesk tenant; the ERP will not guess which repo to deploy`);
  }
  const f = rows[0];
  if (f.provider !== "erp_repo") {
    return refuse("rebuild_not_configured", `the provisioned site is a ${f.provider} mirror, not a template-built ERP repo`);
  }
  const kind = siteKindOf(f);
  if (environment === "staging" && kind === "wp") {
    return refuse("rebuild_not_applicable", "a wp theme reads WebDesk's /v1 live: a publish needs no rebuild, and only a promote deploys the theme");
  }
  if (!kind) return refuse("rebuild_target_incomplete", "the site's kind is unknown");
  if (f.completionState !== "complete") {
    return refuse("rebuild_target_incomplete", `provisioning is not complete (state: ${f.completionState ?? "none"})`);
  }
  if (f.scaffoldState !== "committed" || !f.scaffoldBranch) {
    return refuse("rebuild_target_incomplete", `the scaffold's first fill is not committed (state: ${f.scaffoldState ?? "none"})`);
  }
  if (!f.staging || f.staging.deleted || f.staging.origin !== "provisioned") {
    return refuse("rebuild_target_incomplete", "the site has no live provisioned staging row in the registry");
  }
  const repo = parseGithubRepoUrl(f.repoUrl);
  if (!repo) return refuse("rebuild_target_incomplete", "the provisioned site's repo_url is not a https://github.com/<owner>/<name> URL");

  let domain: string;
  if (environment === "production") {
    if (!f.production) {
      return refuse("production_not_registered", "the site has no production row in the registry (create it from the staging row: POST sites/:id/production)");
    }
    domain = f.production.domain;
  } else {
    domain = f.staging.domain;
  }
  const siteUrl = siteUrlOf(domain);
  if (!siteUrl) {
    return refuse("site_url_unknown", `the ${environment} registry row has no public domain yet (claim one first: POST sites/:id/domain)`);
  }
  if (!perSiteSecretGranted(f, environment, repo.name)) {
    return environment === "production"
      ? refuse("production_secret_not_granted", "the repo is not granted its production per-site deploy secret (M6-P4g); nothing would deploy")
      : refuse("deploy_not_granted", "the repo is not granted its staging per-site deploy secret (M6-P4g); nothing would deploy");
  }
  return {
    ok: true,
    target: {
      source: "registry",
      environment,
      repo: `${repo.owner}/${repo.name}`,
      workflow: TEMPLATE_SITE_WORKFLOW,
      ref: f.scaffoldBranch,
      siteUrl,
      stampBase: stampBaseFor(siteUrl, kind),
      siteKind: kind,
      sendsEnvironment: true,
    },
  };
}
