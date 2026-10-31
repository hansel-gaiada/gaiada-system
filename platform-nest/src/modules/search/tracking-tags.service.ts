// M5-P4 (WSK-D92, docs/blueprints/webdesk-design-v2.md section 14) — "Tracking tags": staff set a site's LinkedIn partner id from the ERP.
// M5-P4g adds the site's Google Ads tag ids and conversion actions (owner 2026-10-31: "Google ads should be setable in SEO department UI
// for each of the clients"): two more variables, `PUBLIC_GOOGLE_ADS_IDS` and `PUBLIC_GOOGLE_ADS_CONVERSIONS`, with the same guarantees.
// Routes in tracking-tags.controller.ts; contract docs/FRONTEND-BFF-CONTRACT.md section 28h.
//
// WHAT IT IS. The gaiada.com site (gaiadabali/gaiada-web-revamp) loads LinkedIn's Insight tag only when its build has a partner id (digits)
// in the repository variable `PUBLIC_LINKEDIN_PARTNER_ID`; its rebuild workflow reads `${{ vars.PUBLIC_LINKEDIN_PARTNER_ID }}`. This
// service reads and writes THAT variable on the site's STAGING build repository (the same target a rebuild dispatches to), through the
// ERP GitHub App. A change takes effect on the NEXT rebuild of the site; nothing here starts one.
//
// WHAT IS GUARANTEED HERE
//   * Allow-listed variables only. The names are constants in core/github/repo-variables.ts, never read from a request; no body names one.
//   * The write is `search_property . manage_tags` (search manager, company admin; NOT plain search staff) and the caller is also
//     authorized for `github_repo . push` on the GitHub ORG tenant (the same chokepoint step every ordinary repo write takes). The READ
//     is `search_property . read`, because the value is public: it ends up in the site's HTML.
//   * The binding. The WebDesk site (webdeskTenant, site) must be one this company can see (the cross-company wall every WebDesk read
//     goes through), and the property's domain must equal one of that site's environment domains, the rule the Analytics page uses to find
//     the property. Otherwise 409 `tracking_site_mismatch`: a property of company X can never write the repo of a site that is not its own.
//   * The repo comes from the build-target resolver (`resolveSiteBuildTarget`, staging), never from a request. No target: 409
//     `no_build_target` on a write, `state: "no_build_target"` on the read.
//   * Idempotent. The same value twice is one read and no write; the answer says `unchanged`.
//   * One audit row per ACTUAL write (who, property, repo, variable, old -> new). The value is public, so it is recorded. A Google Ads
//     save is up to two writes (ids, conversions), so up to two rows; if the second fails after the first landed, the first is audited.
//   * GitHub being unable to answer is words, never "Not set": a 404 on the variable is confirmed against the repo itself, so a repo the
//     App cannot see is `github_app_not_installed`, not an empty value (an empty value is a claim).
//
// GOOGLE ADS (M5-P4g). The variable contract is shared with the site: `PUBLIC_GOOGLE_ADS_IDS` is 1 to 5 `AW-<6-15 digits>` ids joined by
// `,`; `PUBLIC_GOOGLE_ADS_CONVERSIONS` is `key=AW-<digits>/<label>` entries (key lead, whatsapp, phone or email, in that order) joined
// by `,`, each AW id one of the ids. The ERP WRITES that canonical form and READS stored values with the site's own rule (invalid
// entries dropped, duplicates dropped, first wins), so the card shows what the site will actually use. No ids: both variables are
// deleted; no conversion: the conversions variable is deleted, never written empty. Write order: set = ids then conversions, clear =
// conversions then ids, so the site never reads a conversion whose id is gone.
//
// TENANCY. The property is read through withTenants([tenant], fn, {modules:['search']}); the GitHub call runs under the org tenant the
// GHT-1 resolver names for this company (never the URL tenant), as every GitHub write in this codebase does.
import { withTenants } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import type { Principal } from "../../rbac/principal";
import { resolveGithubOrgTenant, type GithubOrgTenantResolution } from "../../core/github-org-tenant";
import { erpGitCaller, githubStatusOf, type GitCaller, type RepoRef } from "../../core/github/git-data";
import { GithubApiError, GithubNotConfiguredError, GithubRateLimitedError, GithubTokenExchangeError } from "../../core/github/errors";
import { getRepoInfo } from "../../core/github/org-secrets";
import {
  GOOGLE_ADS_CONVERSIONS_VARIABLE, GOOGLE_ADS_IDS_VARIABLE, LINKEDIN_PARTNER_ID_VARIABLE, RepoVariableError,
  deleteRepoVariable, getRepoVariable, setRepoVariable,
} from "../../core/github/repo-variables";

const SEARCH = { modules: ["search"] };
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The same rule as the site's `parseLinkedInPartnerId`: digits only, 1 to 15 of them, after trimming. */
export const PARTNER_ID_RE = /^[0-9]{1,15}$/;

export const TRACKING_ACTIVITY_ENTITY = "search_property";
export const TRACKING_VERB_SET = "tracking_tag_set";
export const TRACKING_VERB_CLEARED = "tracking_tag_cleared";

// ── errors ───────────────────────────────────────────────────────────────────────────────────────

export type TrackingRefusal =
  | "property_not_found"
  | "tracking_query_invalid"
  | "tracking_body_invalid"
  | "partner_id_invalid"
  | "ads_body_invalid"
  | "ads_id_invalid"
  | "ads_conversion_invalid"
  | "tracking_site_mismatch"
  | "no_build_target"
  | "github_org_unavailable"
  | "github_not_configured"
  | "github_app_not_installed"
  | "github_permission_missing"
  | "github_rate_limited"
  | "github_request_failed";

const STATUS: Record<TrackingRefusal, 400 | 404 | 409 | 503> = {
  property_not_found: 404,
  tracking_query_invalid: 400,
  tracking_body_invalid: 400,
  partner_id_invalid: 400,
  ads_body_invalid: 400,
  ads_id_invalid: 400,
  ads_conversion_invalid: 400,
  tracking_site_mismatch: 409,
  no_build_target: 409,
  github_org_unavailable: 503,
  github_not_configured: 503,
  github_app_not_installed: 503,
  github_permission_missing: 503,
  github_rate_limited: 503,
  github_request_failed: 503,
};

/** A typed refusal. The controller renders `{error: message, reason}` with `status`. */
export class TrackingTagsError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(readonly reason: TrackingRefusal, message: string, readonly permission?: string) {
    super(message);
    this.name = "TrackingTagsError";
    this.status = STATUS[reason];
  }
}

export const TRACKING_WORDS: Record<TrackingRefusal, string> = {
  property_not_found: "This property was not found for this company.",
  tracking_query_invalid: "The site is named by webdeskTenant (a slug) and site (an id).",
  tracking_body_invalid: "The request must be exactly { webdeskTenant, site, partnerId }.",
  partner_id_invalid: "The LinkedIn partner id must be digits only (up to 15). To remove it, send null.",
  ads_body_invalid: "The request must be exactly { webdeskTenant, site, ids, conversions }: ids a list (or null), conversions an object with only the keys lead, whatsapp, phone and email.",
  ads_id_invalid: "Each Google Ads tag id must look like AW-123456789 (AW- and 6 to 15 digits). Use at most 5 ids and no duplicates.",
  ads_conversion_invalid: "Each conversion must look like AW-123456789/label (letters, digits, - and _ in the label), and its AW id must be one of the tag ids. Conversions need at least one tag id.",
  tracking_site_mismatch: "This property is not the one for that website: the property's domain is not one of the website's environment domains.",
  no_build_target: "This website has no build repository the ERP can write to yet, so there is nowhere to store the tag. Provision or link the site first.",
  github_org_unavailable: "GitHub cannot be reached for this company: its GitHub organization is not configured or is not registered for this company's group.",
  github_not_configured: "GitHub is not set up on this server yet (the ERP GitHub App is not configured), so the tag cannot be read or saved.",
  github_app_not_installed: "The ERP GitHub App cannot see this website's repository. Install the App on that repository, then try again.",
  github_permission_missing: "actions_variables: the ERP GitHub App is not allowed to read or write repository variables. The GitHub organization owner must grant it Repository permissions > Variables (read and write) on the App.",
  github_rate_limited: "GitHub asked the ERP to slow down. Try again in a minute.",
  github_request_failed: "GitHub did not accept the request. Try again in a moment; if it keeps failing, tell IT.",
};

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** `Example.com`, `https://www.example.com/path` -> `example.com`: the Analytics page's matching rule (www. ignored). */
export function hostOf(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
}

/** The environments' domains (strings only; an environment with no domain yet contributes none). */
export function environmentDomains(environments: unknown): string[] {
  if (!Array.isArray(environments)) return [];
  const out: string[] = [];
  for (const e of environments) {
    if (e && typeof e === "object" && typeof (e as { domain?: unknown }).domain === "string") {
      const d = (e as { domain: string }).domain.trim();
      if (d) out.push(d);
    }
  }
  return out;
}

/** Is the property's domain one of the site's environment domains? */
export function propertyMatchesSite(propertyDomain: string, siteDomains: readonly string[]): boolean {
  const want = hostOf(propertyDomain);
  return want !== "" && siteDomains.some((d) => hostOf(d) === want);
}

export interface SiteRefQuery { webdeskTenant: string; site: string }

/** `?webdeskTenant=<slug>&site=<siteId>`: both required, shaped like a slug and an id. */
export function parseSiteQuery(q: { webdeskTenant?: unknown; site?: unknown }): SiteRefQuery {
  const t = q.webdeskTenant;
  const s = q.site;
  if (typeof t !== "string" || !SLUG_RE.test(t) || typeof s !== "string" || !UUID_RE.test(s)) {
    throw new TrackingTagsError("tracking_query_invalid", TRACKING_WORDS.tracking_query_invalid);
  }
  return { webdeskTenant: t, site: s.toLowerCase() };
}

export interface PutBody extends SiteRefQuery { partnerId: string | null }

/** The PUT body, EXACTLY `{ webdeskTenant, site, partnerId }`. `partnerId` is digits after trimming, or null to clear. */
export function parsePutBody(raw: unknown): PutBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TrackingTagsError("tracking_body_invalid", TRACKING_WORDS.tracking_body_invalid);
  const b = raw as Record<string, unknown>;
  const keys = Object.keys(b).sort();
  if (keys.length !== 3 || keys[0] !== "partnerId" || keys[1] !== "site" || keys[2] !== "webdeskTenant") {
    throw new TrackingTagsError("tracking_body_invalid", TRACKING_WORDS.tracking_body_invalid);
  }
  const { webdeskTenant, site } = parseSiteQuery(b);
  const p = b.partnerId;
  if (p === null) return { webdeskTenant, site, partnerId: null };
  if (typeof p !== "string") throw new TrackingTagsError("partner_id_invalid", TRACKING_WORDS.partner_id_invalid);
  const trimmed = p.trim();
  if (!PARTNER_ID_RE.test(trimmed)) throw new TrackingTagsError("partner_id_invalid", TRACKING_WORDS.partner_id_invalid);
  return { webdeskTenant, site, partnerId: trimmed };
}

// ── Google Ads: the variable contract (shared with the site) ─────────────────────────────────────

export const ADS_ID_RE = /^AW-[0-9]{6,15}$/;
/** `AW-<digits>/<label>`: the AW id is group 1, the label group 2. */
export const ADS_CONVERSION_RE = /^(AW-[0-9]{6,15})\/([A-Za-z0-9_-]{1,64})$/;
export const ADS_MAX_IDS = 5;
/** The four conversion keys, in the order the ERP writes them. */
export const ADS_CONVERSION_KEYS = ["lead", "whatsapp", "phone", "email"] as const;
export type AdsConversionKey = (typeof ADS_CONVERSION_KEYS)[number];
export type AdsConversions = { [K in AdsConversionKey]?: string };
export interface GoogleAds { ids: string[]; conversions: AdsConversions }

const isConversionKey = (k: string): k is AdsConversionKey => (ADS_CONVERSION_KEYS as readonly string[]).includes(k);

/** READ rule for `PUBLIC_GOOGLE_ADS_IDS`, as the site reads it: split on `,`, trim, keep valid ids, drop duplicates (first wins), first 5. */
export function parseAdsIdsValue(value: string | null): string[] {
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (ADS_ID_RE.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, ADS_MAX_IDS);
}

/**
 * READ rule for `PUBLIC_GOOGLE_ADS_CONVERSIONS`: split on `,`, split each at the FIRST `=`, trim; keep a known key with a valid value whose
 * AW id is one of `ids`; the first kept occurrence of a key wins.
 */
export function parseAdsConversionsValue(value: string | null, ids: readonly string[]): AdsConversions {
  const out: AdsConversions = {};
  if (value === null) return out;
  for (const part of value.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (!isConversionKey(key) || out[key] !== undefined) continue;
    const m = ADS_CONVERSION_RE.exec(val);
    if (m && ids.includes(m[1]!)) out[key] = val;
  }
  return out;
}

/** The canonical `PUBLIC_GOOGLE_ADS_IDS` value (joined by `,`, no spaces), or null when there are no ids (the variable is deleted). */
export function formatAdsIds(ids: readonly string[]): string | null {
  return ids.length === 0 ? null : ids.join(",");
}

/** The canonical `PUBLIC_GOOGLE_ADS_CONVERSIONS` value (keys in the order lead, whatsapp, phone, email; only those set), or null when none. */
export function formatAdsConversions(conversions: AdsConversions): string | null {
  const parts: string[] = [];
  for (const k of ADS_CONVERSION_KEYS) {
    const v = conversions[k];
    if (v !== undefined) parts.push(`${k}=${v}`);
  }
  return parts.length === 0 ? null : parts.join(",");
}

export interface AdsPutBody extends SiteRefQuery { ids: string[]; conversions: AdsConversions }

const adsRefusal = (r: "ads_body_invalid" | "ads_id_invalid" | "ads_conversion_invalid") => new TrackingTagsError(r, TRACKING_WORDS[r]);

/**
 * The Google Ads PUT body, EXACTLY `{ webdeskTenant, site, ids, conversions }`. `ids` is a list or null (null or [] clears); `conversions` is
 * an object with keys among the four, each a string or null (null or "" is not set). Everything is trimmed first.
 */
export function parseAdsPutBody(raw: unknown): AdsPutBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw adsRefusal("ads_body_invalid");
  const b = raw as Record<string, unknown>;
  const keys = Object.keys(b).sort();
  if (keys.length !== 4 || keys[0] !== "conversions" || keys[1] !== "ids" || keys[2] !== "site" || keys[3] !== "webdeskTenant") throw adsRefusal("ads_body_invalid");
  const rawIds = b.ids;
  const rawConv = b.conversions;
  if (rawIds !== null && !Array.isArray(rawIds)) throw adsRefusal("ads_body_invalid");
  if (!rawConv || typeof rawConv !== "object" || Array.isArray(rawConv)) throw adsRefusal("ads_body_invalid");
  const conv = rawConv as Record<string, unknown>;
  for (const k of Object.keys(conv)) {
    if (!isConversionKey(k)) throw adsRefusal("ads_body_invalid");
    const v = conv[k];
    if (v !== null && typeof v !== "string") throw adsRefusal("ads_body_invalid");
  }
  const { webdeskTenant, site } = parseSiteQuery(b);

  const ids: string[] = [];
  for (const item of (rawIds as unknown[] | null) ?? []) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!ADS_ID_RE.test(id) || ids.includes(id)) throw adsRefusal("ads_id_invalid");
    ids.push(id);
  }
  if (ids.length > ADS_MAX_IDS) throw adsRefusal("ads_id_invalid");

  const conversions: AdsConversions = {};
  for (const k of ADS_CONVERSION_KEYS) {
    const v = conv[k];
    const t = typeof v === "string" ? v.trim() : "";
    if (t === "") continue;
    const m = ADS_CONVERSION_RE.exec(t);
    if (!m || !ids.includes(m[1]!)) throw adsRefusal("ads_conversion_invalid");
    conversions[k] = t;
  }
  return { webdeskTenant, site, ids, conversions };
}

/** `https://github.com/o/r` style repos as `owner/name`. */
const repoLabel = (r: RepoRef): string => `${r.owner}/${r.name}`;

/** The value as the variable holds it, read the way the site reads it (trimmed; anything that is not digits is "no id"). */
export function partnerIdOfValue(value: string | null): string | null {
  if (value === null) return null;
  const t = value.trim();
  return PARTNER_ID_RE.test(t) ? t : null;
}

// ── seams ────────────────────────────────────────────────────────────────────────────────────────

export type TargetAnswer = { ok: true; repo: string } | { ok: false; detail: string };

/** What the service needs from the rest of the ERP. The default is the real thing; the unit suite passes fakes. */
export interface TrackingDeps {
  loadProperty(tenantId: string, propertyId: string): Promise<{ id: string; domain: string } | null>;
  /** The environment domains of the site, or null when `(webdeskTenant, site)` is not this company's (the cross-company wall). */
  siteDomains(tenantId: string, a: SiteRefQuery): Promise<string[] | null>;
  /** The STAGING build target's repo, or why there is none. */
  stagingRepo(tenantId: string, a: SiteRefQuery): Promise<TargetAnswer>;
  resolveOrg(tenantId: string): Promise<GithubOrgTenantResolution>;
  git(orgTenantId: string, actorId: string): GitCaller;
  /** Does Cerbos allow `manage_tags` on this property for the caller (and, delegated, the human)? No audit row. */
  canManage(principal: Principal, tenantId: string, propertyId: string): Promise<boolean>;
  authorizePush(principal: Principal, orgTenantId: string): Promise<void>;
  audit(tenantId: string, actorId: string | null, verb: string, propertyId: string, meta: Record<string, unknown>): Promise<void>;
}

const realDeps: TrackingDeps = {
  async loadProperty(tenantId, propertyId) {
    const r = await withTenants(
      [tenantId],
      (c) => c.query<{ id: string; domain: string }>(`SELECT id, domain FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]),
      SEARCH,
    );
    return r.rows[0] ?? null;
  },
  // The webdev module is loaded lazily so the search module has no static dependency on it (webdev already imports search): the same
  // seam indexnow-webdesk.ts uses for the cross-company wall.
  async siteDomains(tenantId, a) {
    const { webdeskZoneB, WebdeskProblem } = await import("../webdev/webdesk-content.service");
    try {
      const editable = await webdeskZoneB.resolveEditableSite(tenantId, a.webdeskTenant, a.site);
      return environmentDomains(editable.site.environments);
    } catch (e) {
      if (e instanceof WebdeskProblem && e.getStatus() === 404) return null;
      throw e;
    }
  },
  async stagingRepo(tenantId, a) {
    const { resolveSiteBuildTarget } = await import("../webdev/site-builds.service");
    const t = await resolveSiteBuildTarget(tenantId, a.webdeskTenant, a.site, "staging");
    return t.ok ? { ok: true, repo: t.target.repo } : { ok: false, detail: t.detail };
  },
  resolveOrg: (tenantId) => resolveGithubOrgTenant(tenantId),
  git: (orgTenantId, actorId) => erpGitCaller(orgTenantId, actorId),
  async canManage(principal, tenantId, propertyId) {
    const { probeAllowed } = await import("../webdev/webdesk-content.service");
    return probeAllowed(principal, { kind: "resource_search_property", id: propertyId, tenantId, module: "search" }, "manage_tags");
  },
  // `search`: the module the feature belongs to. The org tenant is the GHT-1 substitution, never the URL tenant.
  authorizePush: (principal, orgTenantId) => authorize(principal, { kind: "github_repo", tenantId: orgTenantId, module: "search" }, "push"),
  async audit(tenantId, actorId, verb, propertyId, meta) {
    await writeActivity(tenantId, actorId, verb, TRACKING_ACTIVITY_ENTITY, propertyId, meta);
  },
};

let deps: TrackingDeps = realDeps;
/** Tests only: replace some or all seams; `null` restores the real ones. */
export function setTrackingTagsDeps(over: Partial<TrackingDeps> | null): void {
  deps = over ? { ...realDeps, ...over } : realDeps;
}

// ── response shapes ──────────────────────────────────────────────────────────────────────────────

export type TrackingState = "ok" | "no_build_target" | "github_unavailable";

export interface TrackingTagsView {
  linkedin: { partnerId: string | null };
  /** M5-P4g: what the site will use, read with the site's own rule. Empty for every state that is not `ok`. */
  googleAds: GoogleAds;
  target: { repo: string; variable: string } | null;
  canManage: boolean;
  state: TrackingState;
  reason?: string;
}

export type PutResult = "set" | "cleared" | "unchanged";

const noAds = (): GoogleAds => ({ ids: [], conversions: {} });

export interface TrackingTagsPutResponse {
  linkedin: { partnerId: string | null };
  target: { repo: string; variable: string };
  result: PutResult;
  /** Always "next_rebuild": the site reads the variable when it is built; nothing here starts a build. */
  takesEffect: "next_rebuild";
}

// ── the binding check (both routes) ──────────────────────────────────────────────────────────────

interface Bound { property: { id: string; domain: string } }

async function bind(tenantId: string, propertyId: string, site: SiteRefQuery): Promise<Bound> {
  const property = await deps.loadProperty(tenantId, propertyId);
  if (!property) throw new TrackingTagsError("property_not_found", TRACKING_WORDS.property_not_found);
  const domains = await deps.siteDomains(tenantId, site);
  if (!domains || !propertyMatchesSite(property.domain, domains)) {
    throw new TrackingTagsError("tracking_site_mismatch", TRACKING_WORDS.tracking_site_mismatch);
  }
  return { property };
}

function parseRepo(repo: string): RepoRef {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

/** A GitHub-side failure as one typed refusal. Anything unknown is rethrown (a bug must stay loud). */
export function classifyGithubFailure(err: unknown): TrackingTagsError | null {
  if (err instanceof TrackingTagsError) return err;
  if (err instanceof RepoVariableError) {
    if (err.reason === "github_permission_missing") return new TrackingTagsError("github_permission_missing", TRACKING_WORDS.github_permission_missing, err.permission);
    return new TrackingTagsError("github_request_failed", TRACKING_WORDS.github_request_failed);
  }
  if (err instanceof GithubNotConfiguredError) return new TrackingTagsError("github_not_configured", TRACKING_WORDS.github_not_configured);
  if (err instanceof GithubRateLimitedError) return new TrackingTagsError("github_rate_limited", TRACKING_WORDS.github_rate_limited);
  if (err instanceof GithubTokenExchangeError) {
    // 403/404 on the installation-token exchange: the installation is gone or suspended. Anything else: the App credential is wrong.
    const s = (err.detail as { httpStatus?: unknown } | undefined)?.httpStatus;
    return s === 403 || s === 404
      ? new TrackingTagsError("github_app_not_installed", TRACKING_WORDS.github_app_not_installed)
      : new TrackingTagsError("github_not_configured", TRACKING_WORDS.github_not_configured);
  }
  if (err instanceof GithubApiError) return new TrackingTagsError("github_request_failed", TRACKING_WORDS.github_request_failed);
  return null;
}

/** A variable read that came back null, confirmed: is the repo visible (then "not set") or not (then the App is not installed)? */
async function confirmedUnset(call: GitCaller, repo: RepoRef): Promise<void> {
  try {
    await getRepoInfo(call, repo);
  } catch (err) {
    if (githubStatusOf(err) === 404) throw new TrackingTagsError("github_app_not_installed", TRACKING_WORDS.github_app_not_installed);
    const c = classifyGithubFailure(err);
    if (c) throw c;
    throw err;
  }
}

// ── use cases ────────────────────────────────────────────────────────────────────────────────────

/**
 * GET: the stored partner id and Google Ads settings, and where they live. The caller was authorized for `read` on the property by the controller. A GitHub
 * problem is `state: "github_unavailable"` with words (the page still draws); a mismatched binding or a missing property is an error.
 */
export async function readTrackingTags(principal: Principal, tenantId: string, propertyId: string, site: SiteRefQuery): Promise<TrackingTagsView> {
  await bind(tenantId, propertyId, site);
  const canManage = await deps.canManage(principal, tenantId, propertyId);
  const target = await deps.stagingRepo(tenantId, site);
  if (!target.ok) {
    return { linkedin: { partnerId: null }, googleAds: noAds(), target: null, canManage: false, state: "no_build_target", reason: TRACKING_WORDS.no_build_target };
  }
  const repo = parseRepo(target.repo);
  const shown = { repo: target.repo, variable: LINKEDIN_PARTNER_ID_VARIABLE };
  try {
    const org = await deps.resolveOrg(tenantId);
    if (!org.ok) throw new TrackingTagsError("github_org_unavailable", TRACKING_WORDS.github_org_unavailable);
    const call = deps.git(org.tenantId, principal.userId ?? "system");
    const v = await getRepoVariable(call, repo, LINKEDIN_PARTNER_ID_VARIABLE);
    const adsIds = await getRepoVariable(call, repo, GOOGLE_ADS_IDS_VARIABLE);
    const adsConv = await getRepoVariable(call, repo, GOOGLE_ADS_CONVERSIONS_VARIABLE);
    // A null read is "not set" only for a repo the App can see: confirmed once, however many of the three came back null.
    if (!v || !adsIds || !adsConv) await confirmedUnset(call, repo);
    const ids = parseAdsIdsValue(adsIds?.value ?? null);
    const googleAds: GoogleAds = { ids, conversions: parseAdsConversionsValue(adsConv?.value ?? null, ids) };
    return { linkedin: { partnerId: partnerIdOfValue(v?.value ?? null) }, googleAds, target: shown, canManage, state: "ok" };
  } catch (err) {
    const c = classifyGithubFailure(err);
    if (!c) throw err;
    return { linkedin: { partnerId: null }, googleAds: noAds(), target: shown, canManage, state: "github_unavailable", reason: c.message };
  }
}

/**
 * PUT: set or clear the partner id. The caller was authorized for `manage_tags` on the property by the controller BEFORE the body was
 * read. Order here: validate the body, bind the site, resolve the repo, authorize the GitHub write at the org tenant, read the current
 * value, write only if it differs, audit the write.
 */
export async function putLinkedinPartnerId(principal: Principal, tenantId: string, propertyId: string, rawBody: unknown): Promise<TrackingTagsPutResponse> {
  const body = parsePutBody(rawBody);
  const { property } = await bind(tenantId, propertyId, body);
  const target = await deps.stagingRepo(tenantId, body);
  if (!target.ok) throw new TrackingTagsError("no_build_target", TRACKING_WORDS.no_build_target);
  const repo = parseRepo(target.repo);
  const shown = { repo: target.repo, variable: LINKEDIN_PARTNER_ID_VARIABLE };

  const org = await deps.resolveOrg(tenantId);
  if (!org.ok) throw new TrackingTagsError("github_org_unavailable", TRACKING_WORDS.github_org_unavailable);
  await deps.authorizePush(principal, org.tenantId);

  const actorId = principal.userId;
  const call = deps.git(org.tenantId, actorId ?? "system");
  let before: string | null;
  let result: PutResult;
  try {
    const current = await getRepoVariable(call, repo, LINKEDIN_PARTNER_ID_VARIABLE);
    if (!current) await confirmedUnset(call, repo);
    before = current?.value ?? null;
    // Unchanged = the stored value already reads as the wanted one (or both are "no id"). A stored value that is junk (not digits) is
    // not "unchanged" for a set: it is replaced, which is the point of the call.
    if (body.partnerId === null) {
      if (!current) result = "unchanged";
      else {
        await deleteRepoVariable(call, repo, LINKEDIN_PARTNER_ID_VARIABLE);
        result = "cleared";
      }
    } else if (current && current.value === body.partnerId) {
      result = "unchanged";
    } else {
      await setRepoVariable(call, repo, LINKEDIN_PARTNER_ID_VARIABLE, body.partnerId);
      result = "set";
    }
  } catch (err) {
    const c = classifyGithubFailure(err);
    if (c) throw c;
    throw err;
  }

  if (result !== "unchanged") {
    await deps.audit(tenantId, actorId, result === "cleared" ? TRACKING_VERB_CLEARED : TRACKING_VERB_SET, property.id, {
      repo: repoLabel(repo),
      variable: LINKEDIN_PARTNER_ID_VARIABLE,
      from: before,
      to: body.partnerId,
      webdeskTenant: body.webdeskTenant,
      site: body.site,
    });
  }
  return { linkedin: { partnerId: body.partnerId }, target: shown, result, takesEffect: "next_rebuild" };
}

export interface GoogleAdsPutResponse {
  googleAds: GoogleAds;
  target: { repo: string; variables: [typeof GOOGLE_ADS_IDS_VARIABLE, typeof GOOGLE_ADS_CONVERSIONS_VARIABLE] };
  result: PutResult;
  /** Always "next_rebuild": the site reads the variables when it is built; nothing here starts a build. */
  takesEffect: "next_rebuild";
}

/**
 * PUT (M5-P4g): set or clear a site's Google Ads ids and conversions. Same order as the LinkedIn PUT: validate the body, bind the site,
 * resolve the repo, authorize the GitHub write at the org tenant, read the current values, write only what differs, audit each write.
 * Set writes ids then conversions; clear writes conversions then ids. "Unchanged" compares canonical forms: a stored value that reads as
 * the wanted one is left alone, and a clear deletes any stored variable, even one that reads as nothing (an empty answer is a claim).
 */
export async function putGoogleAds(principal: Principal, tenantId: string, propertyId: string, rawBody: unknown): Promise<GoogleAdsPutResponse> {
  const body = parseAdsPutBody(rawBody);
  const { property } = await bind(tenantId, propertyId, body);
  const target = await deps.stagingRepo(tenantId, body);
  if (!target.ok) throw new TrackingTagsError("no_build_target", TRACKING_WORDS.no_build_target);
  const repo = parseRepo(target.repo);
  const shown: GoogleAdsPutResponse["target"] = { repo: target.repo, variables: [GOOGLE_ADS_IDS_VARIABLE, GOOGLE_ADS_CONVERSIONS_VARIABLE] };

  const org = await deps.resolveOrg(tenantId);
  if (!org.ok) throw new TrackingTagsError("github_org_unavailable", TRACKING_WORDS.github_org_unavailable);
  await deps.authorizePush(principal, org.tenantId);

  const actorId = principal.userId;
  const call = deps.git(org.tenantId, actorId ?? "system");
  const wantIds = formatAdsIds(body.ids);
  const wantConv = formatAdsConversions(body.conversions);
  const writes: Array<{ variable: string; from: string | null; to: string | null }> = [];
  const auditWrites = async (): Promise<void> => {
    for (const w of writes) {
      await deps.audit(tenantId, actorId, w.to === null ? TRACKING_VERB_CLEARED : TRACKING_VERB_SET, property.id, {
        tag: "google_ads",
        repo: repoLabel(repo),
        variable: w.variable,
        from: w.from,
        to: w.to,
        webdeskTenant: body.webdeskTenant,
        site: body.site,
      });
    }
  };

  try {
    const curIds = await getRepoVariable(call, repo, GOOGLE_ADS_IDS_VARIABLE);
    const curConv = await getRepoVariable(call, repo, GOOGLE_ADS_CONVERSIONS_VARIABLE);
    if (!curIds || !curConv) await confirmedUnset(call, repo);
    const readIds = parseAdsIdsValue(curIds?.value ?? null);
    // Nothing wanted: unchanged only when the variable is absent. Something wanted: unchanged when the stored value reads as it.
    const idsSame = wantIds === null ? curIds === null : formatAdsIds(readIds) === wantIds;
    const convSame = wantConv === null ? curConv === null : formatAdsConversions(parseAdsConversionsValue(curConv?.value ?? null, readIds)) === wantConv;

    const writeIds = async (): Promise<void> => {
      if (idsSame) return;
      if (wantIds === null) await deleteRepoVariable(call, repo, GOOGLE_ADS_IDS_VARIABLE);
      else await setRepoVariable(call, repo, GOOGLE_ADS_IDS_VARIABLE, wantIds);
      writes.push({ variable: GOOGLE_ADS_IDS_VARIABLE, from: curIds?.value ?? null, to: wantIds });
    };
    const writeConv = async (): Promise<void> => {
      if (convSame) return;
      if (wantConv === null) await deleteRepoVariable(call, repo, GOOGLE_ADS_CONVERSIONS_VARIABLE);
      else await setRepoVariable(call, repo, GOOGLE_ADS_CONVERSIONS_VARIABLE, wantConv);
      writes.push({ variable: GOOGLE_ADS_CONVERSIONS_VARIABLE, from: curConv?.value ?? null, to: wantConv });
    };
    if (wantIds === null) {
      await writeConv();
      await writeIds();
    } else {
      await writeIds();
      await writeConv();
    }
  } catch (err) {
    // A write that landed before the failure is still a write: audit it, then report the failure.
    await auditWrites();
    const c = classifyGithubFailure(err);
    if (c) throw c;
    throw err;
  }

  await auditWrites();
  const result: PutResult = writes.length === 0 ? "unchanged" : wantIds === null ? "cleared" : "set";
  return { googleAds: { ids: body.ids, conversions: body.conversions }, target: shown, result, takesEffect: "next_rebuild" };
}
