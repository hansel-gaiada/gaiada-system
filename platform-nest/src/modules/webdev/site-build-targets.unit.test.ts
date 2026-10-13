// M6-P6h (pure half) — where a site build goes, and what a TEMPLATE stamp proves. No database, no network.
//
//   1. target derivation: the registry rule for every kind and environment, every refusal, and the precedence (the env
//      override for the hand-built proof site resolves EXACTLY as WSK-60 did, without a database read);
//   2. the publish-proof rule for a template-built site (the stamp has pulledAt and approvalId, never maxUpdatedAt), the
//      "laterDispatch" settle for a run GitHub dropped, and the promote's own rule;
//   3. the promote preconditions as the derivation states them (production row, public domain, granted production secret).
// The DB/HTTP half (filing, deciding, the ledger, the CHECK) is site-builds-promote.test.ts, which needs the Linux gate.
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../config";
import { siteDeploySecretName } from "./deploy-grant";
import { stampProves, parseStamp, type BuildStamp } from "./site-build-stamp";
import {
  BUILD_TARGET_REFUSALS,
  TEMPLATE_SITE_WORKFLOW,
  WP_THEME_DIR,
  deriveRegistryTarget,
  overrideTarget,
  parseGithubRepoUrl,
  perSiteSecretGranted,
  siteUrlOf,
  stampBaseFor,
  type RegistryBuildFacts,
} from "./site-build-targets";
import { parseRebuildTargets, rebuildTargetFor, resolveSiteBuildTarget } from "./site-builds.service";

const ORG = "acme-org";
const REPO = "acme-site";
const REPO_ID = 123456789;
const secret = (env: "staging" | "production") => siteDeploySecretName({ slug: REPO, environment: env, repositoryId: REPO_ID });

/** A complete, granted, template-built static site with a staging row and a production row. Override per case. */
function facts(over: Partial<RegistryBuildFacts> = {}): RegistryBuildFacts {
  return {
    provisionedSiteId: "11111111-1111-4111-8111-111111111111",
    provider: "erp_repo",
    status: "live",
    framework: "astro",
    repoUrl: `https://github.com/${ORG}/${REPO}`,
    completionState: "complete",
    scaffoldState: "committed",
    scaffoldBranch: "main",
    grantState: "granted",
    grantSecretNames: ["WEBDESK_DEPLOY_GRANT", secret("staging"), secret("production")],
    grantRepositoryId: REPO_ID,
    staging: { siteId: "22222222-2222-4222-8222-222222222222", domain: "stg.acme.example", kind: "static", origin: "provisioned", deleted: false },
    production: null,
    ...over,
  };
}
/** The production registry row M6-P6g creates from the staging row (`POST sites/:id/production`). */
const prod = { siteId: "33333333-3333-4333-8333-333333333333", domain: "www.acme.example" };

describe("deriveRegistryTarget — staging (a publish's or a content.rebuild's target)", () => {
  it("a static site: repo from repo_url, workflow site.yml, ref = the scaffold's default branch, the staging origin, stamp at the root", () => {
    const r = deriveRegistryTarget([facts({ production: prod })], "staging");
    expect(r).toEqual({
      ok: true,
      target: {
        source: "registry", environment: "staging", repo: `${ORG}/${REPO}`, workflow: TEMPLATE_SITE_WORKFLOW, ref: "main",
        siteUrl: "https://stg.acme.example", stampBase: "https://stg.acme.example", siteKind: "static", sendsEnvironment: true,
      },
    });
  });
  it("fullstack's web half behaves like static (stamp at the export's root)", () => {
    const r = deriveRegistryTarget([facts({ framework: "nextjs", staging: { ...facts().staging!, kind: "fullstack" } })], "staging");
    expect(r).toMatchObject({ ok: true, target: { siteKind: "fullstack", stampBase: "https://stg.acme.example", workflow: "site.yml" } });
  });
  it("a wp site has NO staging rebuild (its theme reads /v1 live): rebuild_not_applicable, even when everything else is missing", () => {
    expect(deriveRegistryTarget([facts({ framework: "wp", staging: { ...facts().staging!, kind: "wp" } })], "staging")).toMatchObject({ ok: false, reason: "rebuild_not_applicable" });
    expect(deriveRegistryTarget([facts({ framework: "wp", staging: null, completionState: null })], "staging")).toMatchObject({ ok: false, reason: "rebuild_not_applicable" });
  });
  it("the kind comes from the staging row first, then the framework", () => {
    expect(deriveRegistryTarget([facts({ framework: "wp" })], "staging")).toMatchObject({ ok: true, target: { siteKind: "static" } }); // the row says static
    expect(deriveRegistryTarget([facts({ staging: { ...facts().staging!, kind: null }, framework: "vite" })], "staging")).toMatchObject({ ok: true, target: { siteKind: "static" } });
  });

  type Case = [string, Partial<RegistryBuildFacts>, string];
  const refusals: Case[] = [
    ["a provision-host mirror row is not a template-built site", { provider: "provision" }, "rebuild_not_configured"],
    ["provisioning not complete", { completionState: "tenant_ready" }, "rebuild_target_incomplete"],
    ["scaffold not committed", { scaffoldState: "pending" }, "rebuild_target_incomplete"],
    ["no default branch recorded", { scaffoldBranch: null }, "rebuild_target_incomplete"],
    ["no staging registry row", { staging: null }, "rebuild_target_incomplete"],
    ["a deleted staging row", { staging: { ...facts().staging!, deleted: true } }, "rebuild_target_incomplete"],
    ["a staging row that is not provisioned", { staging: { ...facts().staging!, origin: "manual" } }, "rebuild_target_incomplete"],
    ["a repo_url that is not a GitHub repo", { repoUrl: "https://gitlab.com/acme/site" }, "rebuild_target_incomplete"],
    ["the .provisioned.invalid placeholder is no URL", { staging: { ...facts().staging!, domain: "acme-site.provisioned.invalid" } }, "site_url_unknown"],
    ["an IP literal is no URL", { staging: { ...facts().staging!, domain: "10.0.0.5" } }, "site_url_unknown"],
    ["the grant is only pending", { grantState: "pending" }, "deploy_not_granted"],
    ["the grant was revoked", { grantState: "revoked" }, "deploy_not_granted"],
    ["granted, but not the staging per-site secret", { grantSecretNames: ["WEBDESK_DEPLOY_GRANT"] }, "deploy_not_granted"],
    ["granted, but no repository id recorded", { grantRepositoryId: null }, "deploy_not_granted"],
    ["another repo's per-site secret does not count", { grantSecretNames: [siteDeploySecretName({ slug: REPO, environment: "staging", repositoryId: 42 })] }, "deploy_not_granted"],
  ];
  it.each(refusals)("%s → %s", (_label, over, reason) => {
    expect(deriveRegistryTarget([facts(over)], "staging")).toMatchObject({ ok: false, reason });
  });
  it("no linked provisioned site → rebuild_not_configured (WSK-60's own token); two → rebuild_target_ambiguous (never a guess)", () => {
    expect(deriveRegistryTarget([], "staging")).toMatchObject({ ok: false, reason: "rebuild_not_configured" });
    expect(deriveRegistryTarget([facts(), facts()], "staging")).toMatchObject({ ok: false, reason: "rebuild_target_ambiguous" });
  });
  it("every refusal is a token the ledger's failure_reason CHECK accepts", () => {
    for (const t of BUILD_TARGET_REFUSALS) expect(t).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

describe("deriveRegistryTarget — production (a promote's target): the promote preconditions", () => {
  it("a static site with a production row and a granted production secret: the production origin, the same repo, branch and workflow", () => {
    expect(deriveRegistryTarget([facts({ production: prod })], "production")).toEqual({
      ok: true,
      target: {
        source: "registry", environment: "production", repo: `${ORG}/${REPO}`, workflow: "site.yml", ref: "main",
        siteUrl: "https://www.acme.example", stampBase: "https://www.acme.example", siteKind: "static", sendsEnvironment: true,
      },
    });
  });
  it("a wp site PROMOTES (only promotes): its stamp is read from the theme directory on the production URL", () => {
    const r = deriveRegistryTarget([facts({ framework: "wp", staging: { ...facts().staging!, kind: "wp" }, production: prod })], "production");
    expect(r).toMatchObject({ ok: true, target: { siteKind: "wp", stampBase: `https://www.acme.example/wp-content/themes/${WP_THEME_DIR}` } });
  });
  it("no production row → production_not_registered", () => {
    expect(deriveRegistryTarget([facts({ production: null })], "production")).toMatchObject({ ok: false, reason: "production_not_registered" });
  });
  it("a production row without a public domain → site_url_unknown", () => {
    expect(deriveRegistryTarget([facts({ production: { ...prod, domain: "acme.provisioned.invalid" } })], "production")).toMatchObject({ ok: false, reason: "site_url_unknown" });
  });
  it("🔴 the production per-site secret not granted → production_secret_not_granted (today's live state: P4g grants staging only, and O-3 refuses the grant)", () => {
    expect(deriveRegistryTarget([facts({ production: prod, grantSecretNames: ["WEBDESK_DEPLOY_GRANT", secret("staging")] })], "production"))
      .toMatchObject({ ok: false, reason: "production_secret_not_granted" });
    expect(deriveRegistryTarget([facts({ production: prod, grantState: "pending" })], "production")).toMatchObject({ ok: false, reason: "production_secret_not_granted" });
    // ✅ control: the same facts with the production name granted resolve.
    expect(deriveRegistryTarget([facts({ production: prod })], "production")).toMatchObject({ ok: true });
  });
  it("M6-P6h2: a site granted at staging whose production secret is still being created (state granted, the production name not recorded) rebuilds staging and refuses the promote", () => {
    const waiting = facts({ production: prod, grantSecretNames: ["WEBDESK_DEPLOY_GRANT", secret("staging")] });
    expect(deriveRegistryTarget([waiting], "staging")).toMatchObject({ ok: true, target: { environment: "staging" } });
    expect(deriveRegistryTarget([waiting], "production")).toMatchObject({ ok: false, reason: "production_secret_not_granted" });
    // once the grant records the production name, the same site promotes
    expect(deriveRegistryTarget([facts({ production: prod })], "production")).toMatchObject({ ok: true, target: { environment: "production" } });
  });
  it("the staging secret does not stand in for the production one, nor the reverse", () => {
    expect(perSiteSecretGranted(facts({ grantSecretNames: [secret("staging")] }), "production", REPO)).toBe(false);
    expect(perSiteSecretGranted(facts({ grantSecretNames: [secret("production")] }), "staging", REPO)).toBe(false);
    expect(perSiteSecretGranted(facts({ grantSecretNames: [secret("production")] }), "production", REPO)).toBe(true);
  });
});

describe("helpers", () => {
  it("parseGithubRepoUrl accepts only https://github.com/<owner>/<name>", () => {
    expect(parseGithubRepoUrl("https://github.com/acme-org/acme-site")).toEqual({ owner: "acme-org", name: "acme-site" });
    expect(parseGithubRepoUrl("https://github.com/acme-org/acme-site.git/")).toEqual({ owner: "acme-org", name: "acme-site" });
    for (const bad of [null, "", "http://github.com/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://evil.test/a/b", "https://github.com/a/b?x=1", "not a url"]) {
      expect(parseGithubRepoUrl(bad), String(bad)).toBeNull();
    }
  });
  it("siteUrlOf: a canonical public host only", () => {
    expect(siteUrlOf("www.acme.example")).toBe("https://www.acme.example");
    for (const bad of [null, "", "acme.provisioned.invalid", "127.0.0.1", "acme.example:8443", "acme.example/x", "ACME.example", "localhost"]) {
      expect(siteUrlOf(bad), String(bad)).toBeNull();
    }
  });
  it("stampBaseFor: the root for static/fullstack/unknown, the theme directory for wp", () => {
    expect(stampBaseFor("https://a.example", "static")).toBe("https://a.example");
    expect(stampBaseFor("https://a.example", "fullstack")).toBe("https://a.example");
    expect(stampBaseFor("https://a.example", null)).toBe("https://a.example");
    expect(stampBaseFor("https://a.example", "wp")).toBe("https://a.example/wp-content/themes/gaiada-webdesk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The proof site keeps working across the switch: its env entry is the OVERRIDE, resolved first and without a database read.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("the proof-site override (WEBDESK_REBUILD_TARGETS) resolves exactly as before", () => {
  const saved = config.webdeskRebuild.targetsJson;
  afterEach(() => {
    config.webdeskRebuild.targetsJson = saved;
  });
  const PROOF = {
    tenantSlug: "gaiada",
    siteId: "fc19fb0c-0000-4000-8000-000000000001",
    repo: "gaiadabali/gaiada-web-revamp",
    workflow: "webdesk-rebuild.yml",
    ref: "webdesk-rebuild-proof-site",
    stagingUrl: "https://cms-proof.gaiada.com",
  };

  it("the entry parses unchanged, and the resolved staging target is that entry: same repo, workflow, ref and URL, no `environment` input", async () => {
    config.webdeskRebuild.targetsJson = JSON.stringify([PROOF]);
    expect(parseRebuildTargets(JSON.stringify([PROOF]), () => undefined)).toEqual([PROOF]);
    expect(rebuildTargetFor("gaiada", PROOF.siteId)).toEqual(PROOF);
    // No tenant id is needed and no database is read: a tenant that does not exist cannot change the answer.
    const r = await resolveSiteBuildTarget("00000000-0000-4000-8000-000000000000", "gaiada", PROOF.siteId.toUpperCase(), "staging");
    expect(r).toEqual({
      ok: true,
      target: {
        source: "override", environment: "staging", repo: PROOF.repo, workflow: PROOF.workflow, ref: PROOF.ref,
        siteUrl: PROOF.stagingUrl, stampBase: PROOF.stagingUrl, siteKind: null, sendsEnvironment: false,
      },
    });
    expect(overrideTarget(PROOF)).toEqual((r as { ok: true; target: unknown }).target);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// What a TEMPLATE stamp proves (webdesk/templates/_deploy/write-stamp.sh: buildId, pulledAt = build start, maxUpdatedAt null).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const T0 = new Date("2026-10-13T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const APPROVAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const tpl = (over: Partial<BuildStamp> = {}): BuildStamp => ({
  source: "webdesk", pulledAt: at(10_000), maxUpdatedAt: null, itemCount: null,
  buildId: "123456-1-abcdef012345", approvalId: APPROVAL, environment: "staging", ...over,
});

describe("stampProves — a template-built PUBLISH (pulledAt >= publishedAt AND the stamp names this dispatch's approval)", () => {
  const publish = { kind: "publish" as const, publishedAt: at(500), dispatchedAt: at(2_000), approvalId: APPROVAL };
  it("this approval's run, begun after the publish → proved by approvalId", () => {
    expect(stampProves(tpl(), publish)).toEqual({ proved: true, by: "approvalId" });
  });
  it("the boundary: pulledAt is second-granular, so a pull in the publish's own second still proves it", () => {
    // published 10:00:00.500, the build began in that same second and the stamp says 10:00:00Z.
    expect(stampProves(tpl({ pulledAt: at(0) }), publish)).toEqual({ proved: true, by: "approvalId" });
    // one whole second earlier is NOT proof.
    expect(stampProves(tpl({ pulledAt: at(-1_000) }), publish).proved).toBe(false);
  });
  it("the approval id is compared case-insensitively", () => {
    expect(stampProves(tpl({ approvalId: APPROVAL.toUpperCase() }), publish).proved).toBe(true);
  });
  it("a template stamp is never proved by maxUpdatedAt (it has none; a forged one is ignored without the approval)", () => {
    expect(stampProves(tpl({ approvalId: null, maxUpdatedAt: at(9e9) }), publish).proved).toBe(false);
  });
  it("🔴 a push-triggered build (no approvalId) proves nothing for a dispatch, however late it pulled", () => {
    expect(stampProves(tpl({ approvalId: null, pulledAt: at(9e6) }), publish)).toMatchObject({ proved: false });
  });
  it("🔴 another approval's run proves nothing without a covering dispatch; the production build proves nothing for staging", () => {
    expect(stampProves(tpl({ approvalId: OTHER }), publish).proved).toBe(false);
    expect(stampProves(tpl({ environment: "production" }), publish).proved).toBe(false);
  });
  it("no pulledAt, or a git stamp, proves nothing", () => {
    expect(stampProves(tpl({ pulledAt: null }), publish).proved).toBe(false);
    expect(stampProves(tpl({ source: "git" }), publish).proved).toBe(false);
  });
  it("a publish whose publishedAt was lost (reconciled) is proved by the approval alone", () => {
    expect(stampProves(tpl(), { ...publish, publishedAt: null })).toEqual({ proved: true, by: "approvalId" });
  });
  it("a rebuild (no publishedAt) is proved by its own approval", () => {
    expect(stampProves(tpl(), { kind: "rebuild", publishedAt: null, dispatchedAt: at(2_000), approvalId: APPROVAL })).toEqual({ proved: true, by: "approvalId" });
  });
});

describe("stampProves — a run GitHub dropped from the concurrency group is settled by the later dispatch that replaced it", () => {
  const dropped = { kind: "publish" as const, publishedAt: at(500), dispatchedAt: at(2_000), approvalId: APPROVAL };
  it("the served build is a LATER ERP dispatch's (covering dispatchedAt >= ours) → proved by laterDispatch", () => {
    expect(stampProves(tpl({ approvalId: OTHER, pulledAt: at(30_000) }), { ...dropped, coveringDispatchedAt: at(20_000) }))
      .toEqual({ proved: true, by: "laterDispatch" });
  });
  it("🔴 an EARLIER dispatch's build does not cover this one", () => {
    expect(stampProves(tpl({ approvalId: OTHER, pulledAt: at(30_000) }), { ...dropped, coveringDispatchedAt: at(1_000) }).proved).toBe(false);
  });
  it("🔴 a covering build that pulled before this dispatch does not cover it", () => {
    expect(stampProves(tpl({ approvalId: OTHER, pulledAt: at(1_000) }), { ...dropped, coveringDispatchedAt: at(20_000) }).proved).toBe(false);
  });
  it("🔴 a promote is never settled by another run", () => {
    const promote = { kind: "promote" as const, publishedAt: null, dispatchedAt: at(2_000), approvalId: APPROVAL };
    expect(stampProves(tpl({ approvalId: OTHER, environment: "production", pulledAt: at(30_000) }), { ...promote, coveringDispatchedAt: at(20_000) }).proved).toBe(false);
  });
});

describe("stampProves — a PROMOTE is live only through the production build that names its approval", () => {
  const promote = { kind: "promote" as const, publishedAt: null, dispatchedAt: at(2_000), approvalId: APPROVAL };
  it("the production stamp naming this approval → proved", () => {
    expect(stampProves(tpl({ environment: "production" }), promote)).toEqual({ proved: true, by: "approvalId" });
  });
  it("🔴 a STAGING build's stamp (served where production should be) proves nothing", () => {
    expect(stampProves(tpl({ environment: "staging" }), promote).proved).toBe(false);
  });
  it("🔴 the proof site's WSK-55 stamp (no buildId) never proves a promote, whatever its dates", () => {
    const wsk55: BuildStamp = { source: "webdesk", pulledAt: at(9e6), maxUpdatedAt: at(9e6), itemCount: 330 };
    expect(stampProves(wsk55, promote).proved).toBe(false);
  });
});

describe("the WSK-55 stamp keeps WSK-60's rules unchanged (no buildId)", () => {
  const wsk55: BuildStamp = { source: "webdesk", pulledAt: at(60_000), maxUpdatedAt: at(0), itemCount: 330 };
  it("publish: maxUpdatedAt >= publishedAt; rebuild: pulledAt >= dispatchedAt", () => {
    expect(stampProves(wsk55, { kind: "publish", publishedAt: at(0), dispatchedAt: at(1_000), approvalId: APPROVAL })).toEqual({ proved: true, by: "maxUpdatedAt" });
    expect(stampProves(wsk55, { kind: "rebuild", publishedAt: null, dispatchedAt: at(1_000) })).toEqual({ proved: true, by: "pulledAt" });
  });
});

describe("parseStamp reads the template fields and refuses ill-shaped ones (never coerced)", () => {
  it("a write-stamp.sh body", () => {
    const r = parseStamp({
      source: "webdesk", buildId: "987-1-0123456789ab", pulledAt: "2026-10-13T10:00:05Z", maxUpdatedAt: null, itemCount: null,
      sourceSha256: null, environment: "production", approvalId: APPROVAL, kind: "static", runId: 987, runAttempt: 1,
    });
    expect(r).toMatchObject({ ok: true, stamp: { buildId: "987-1-0123456789ab", approvalId: APPROVAL, environment: "production", maxUpdatedAt: null } });
  });
  it("an approval id or build id of the wrong shape is null, not a string that might compare equal", () => {
    const r = parseStamp({ source: "webdesk", buildId: "x".repeat(65), approvalId: "<script>", environment: "PRODUCTION" });
    expect(r).toMatchObject({ ok: true, stamp: { buildId: null, approvalId: null, environment: null } });
  });
});
