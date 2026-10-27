// PRV-02 — the `webdev` module's HTTP surface (design §04's "Contract — ERP side").
//
//   POST /api/:tenantId/modules/webdev/provision                        -> 201 | 200 | 409 | 422 | 502 | 503
//   GET  /api/:tenantId/modules/webdev/provisioned-sites[?runId=]       -> 200 [site]
//   GET  /api/:tenantId/modules/webdev/provisioned-sites/:id            -> 200 site (+ `completion`, M6-P4c; + `builds`, M6-P6h)
//   POST /api/:tenantId/modules/webdev/provisioned-sites/:id/reconcile  -> 200 site (+ `completion`, M6-P4c)
//   POST /api/:tenantId/modules/webdev/provisioned-sites/:id/scaffold-commit -> 200 commit | 404 | 409 | 422 | 429 | 502 | 503
//        (M6-P4b2: the first fill of the provisioned repo with the scaffolded tree; scaffold-commit.ts)
//   POST   /api/:tenantId/modules/webdev/provisioned-sites/:id/deploy-grant -> 200 grant | 404 | 409 | 429 | 502 | 503
//   DELETE /api/:tenantId/modules/webdev/provisioned-sites/:id/deploy-grant -> 200 revoke | 404 | 409 | 422 | 429 | 502 | 503
//        (M6-P4g: the deploy gate is the org secret grant; deploy-grant.ts)
//   POST /api/:tenantId/modules/webdev/sites/:id/domain                 -> 200 registry site + property | 400 | 404 | 409 (M6-P4c2; M6-P6i adds `property`)
//   POST /api/:tenantId/modules/webdev/sites/:id/delivery-binding       -> 200 registry site + deliveryState | 400 | 404 | 409 | 422 (M6-P6g)
//   POST /api/:tenantId/modules/webdev/sites/:id/production             -> 201 registry site + deliveryState + deployGrant | 400 | 404 | 409 (M6-P6g; deployGrant M6-P6h2)
//   GET  /api/:tenantId/modules/webdev/sites/:id/dns                    -> 200 DNS checklist + read-only check | 404 (M6-P6i)
//   GET  /api/:tenantId/modules/webdev/sites/:id/dns/task               -> 200 the site's DNS task link (state none|open|closed) | 404 (M6-P6p)
//   POST /api/:tenantId/modules/webdev/sites/:id/dns/recheck            -> 200 {task, check} | 404 (M6-P6p: re-run the read-only check now; closes the task when every record points)
//   PUT  /api/:tenantId/modules/webdev/deploy-credentials/:connectionId -> 200 masked record + sealedVersion | 400 | 403 | 404 | 422 | 503
//        (M6-P6o: seal a per-site deploy credential into its vault record; the value is accepted once and never echoed)
//   POST /api/:tenantId/modules/webdev/sites/:id/deploy-secret          -> 201 {approvalId,...} | 400 | 403 | 404 | 409 | 422 | 503
//        (M6-P6o: file ONE HIGH approval to write that row's org secret from its vault record; WSK-D88)
//   GET  /api/:tenantId/modules/webdev/sites/:id/deploy-secret          -> 200 where the row's org secret stands | 404 (M6-P6o)
//
// This controller is DELIBERATELY THIN. It validates route/body input, resolves the principal,
// authorizes, builds the driver, and maps a typed outcome onto a status code. Every decision that
// could double-create infrastructure or adopt another client's site lives in `provisioning.service.ts`
// under a lock and a re-check — because the D14 executor (PRV-03) re-drives the SAME service function
// without passing through this file, and any rule implemented only here would silently not apply on
// the automation path.
//
// ── AUTHZ NOTE / DEPENDENCY ─────────────────────────────────────────────────────────────────────
// `authorize()` is called with the NEW Cerbos resource kind `webdev_provisioned_site` (actions
// `read` · `provision` · `reconcile`), per design §06. The POLICY FILE ITSELF IS PRV-03's, not this
// ticket's. Until it lands, Cerbos has no matching resource kind and therefore DENIES — a silent
// deny that reads exactly like a logic bug (standing estate trap: an unlisted kind/action is a deny,
// and `gaiada-test-cerbos` must be RESTARTED after any policy edit for it to load). That is the
// correct fail-closed direction and is why this ticket's verification of the idempotency core runs
// against the SERVICE layer, with the HTTP layer covering only what does not depend on the missing
// policy (auth, module gate, fail-closed env).
//
// ── WSK-D33: `provision` (gda-s01) IS GONE, NOT DEPRECATED — ERP REPO CONTROL IS THE ONLY PROVIDER ──
// `https://provision.gaiada.online` measures 000 on every request (2026-09-01; the host it lived on
// was decommissioned) and the live `.env` carries no `PROVISION_*` vars at all. `resolveProvider`
// below therefore constructs ONLY `ErpRepoControlProvider` (`erp-repo-control-provider.ts`) —
// GH-12's D14-approved repo-creation path, per webdesk-design-v2.md §08 ("ERP repo control (new,
// replaces `provision`)"). `provision-http.ts` / `ProvisionHttpDriver` are KEPT (not deleted) but are
// no longer reachable from this controller, or from anywhere else in production: `main.ts` never
// calls `setProvisionProviderForTests`, and there is no config branch here that falls back to
// `createProvisionHttpDriver()`. See `provision-http.ts`'s own header for why the file itself stays.
//
// ── FAIL-CLOSED WITHOUT CONFIG ───────────────────────────────────────────────────────────────────
// `createErpRepoControlProvider()` throws `ErpRepoControlNotConfiguredError` when `GITHUB_ORG` is
// unset, and that becomes a 503 NAMING THE MISSING VAR — never a network attempt against
// `provision`'s dead host, and never a silent no-op. A per-KIND template gap (`ERP_REPO_TEMPLATE_*`)
// is a narrower, per-request failure surfaced by `provisionSite`'s own `provider_rejected` outcome
// (422 from the driver, mapped to 503 by the switch below, unchanged from how a `wp` request was
// always refused before this ticket) — it does not block construction of the driver itself.
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, NotFoundException,
  Param, Patch, Post, Put, Query, Req, Res, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withGlobal } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { ErpRepoControlNotConfiguredError, createErpRepoControlProvider } from "./erp-repo-control-provider";
import type { ProvisionProvider } from "./provision-provider";
import {
  getProvisionedSite, listProvisionedSites, provisionSite, pollProvisioningSite, type SiteDto,
} from "./provisioning.service";
import {
  completeAfterPoll, readProvisionCompletion, reconcileAndComplete, type ProvisionCompletionDto,
} from "./provision-completion.service";
import {
  bindSiteDelivery, claimProvisionedSiteDomain, createProductionFromStaging, createWebdevSite, getWebdevSite,
  patchWebdevSiteVaultRef, type DeliverySiteDto, type WebdevSiteDto,
} from "./site-registry.service";
import { DeliveryRefusal, parseBindingBody } from "./delivery-binding";
import { readSiteDns, type SiteDnsDto } from "./domain-dns.service";
import { checkSiteDnsTask, readSiteDnsTask, type DnsTaskCheckResult, type SiteDnsTaskDto } from "./domain-dns-task.service";
import type { PropertyLinkResult } from "./site-property-link";
import { readDeliveryForProvisioned, type SiteDeliveryDto } from "./delivery-binding.service";
import { ScaffoldRefusal } from "./scaffold-commit";
import { commitScaffoldForSite, readScaffoldCommit, type ScaffoldCommitDto, type ScaffoldCommitResponse } from "./scaffold-commit.service";
import { DeployGrantRefusal, type DeployGrantResult, type DeployRevokeResult } from "./deploy-grant";
import { followProductionRow, grantDeployForSite, readDeployGrant, revokeDeployForSite, type DeployGrantDto, type DeployGrantSummary } from "./deploy-grant.service";
import { readSiteBuildsForProvisioned, type SiteBuildsDto } from "./site-builds.service";
import { DeploySecretRefusal } from "./deploy-secret-write";
import {
  fileDeploySecretWrite, readDeploySecretState, sealDeployCredential,
  type DeploySecretFilingDto, type DeploySecretStateDto, type SealedCredentialDto,
} from "./deploy-secret.service";

const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Test seam: suites drive a fake `ProvisionProvider` (or, for PRV-02's own historical idempotency
 *  suite, the real `provision-http` driver against the PRV-00 mock over real sockets). Nothing in
 *  production ever sets this — `main.ts` does not call it. Kept as an explicit override rather than
 *  a config branch so there is no "use the fake" mode reachable from env, which is the shape that
 *  eventually ships disabled-in-prod by accident. */
let providerOverride: ProvisionProvider | null = null;
export function setProvisionProviderForTests(p: ProvisionProvider | null): void {
  providerOverride = p;
}

function resolveProvider(tenantId: string, actorId: string | null): ProvisionProvider {
  if (providerOverride) return providerOverride;
  try {
    return createErpRepoControlProvider(tenantId, actorId);
  } catch (err) {
    if (err instanceof ErpRepoControlNotConfiguredError) {
      throw new ServiceUnavailableException(err.message);
    }
    throw err;
  }
}

/** provision's `devName` is attribution INSIDE PROVISION'S OWN UI — a display name and nothing more.
 *  Never an ERP user id, tenant id or run id: the design's containment statement is that provision
 *  stores zero ERP identifiers and correlation is Zone-A-side only (`provider_ref`). */
async function displayNameFor(userId: string | null): Promise<string> {
  if (!userId) return "Gaiada ERP";
  const r = await withGlobal((c) =>
    c.query<{ name: string | null }>(`SELECT name FROM users WHERE id = $1`, [userId]),
  );
  return r.rows[0]?.name?.trim() || "Gaiada ERP";
}

/** A deploy-grant refusal as its HTTP answer, `{error: <token>, reason}` (the P4b2 shape); anything else unchanged. */
function deployGrantHttpError(err: unknown): unknown {
  if (err instanceof DeployGrantRefusal) {
    if (err.code === "not_found") return new NotFoundException("provisioned site not found");
    return new HttpException({ message: err.code, reason: err.detail }, err.status);
  }
  return err;
}

/** A delivery refusal (M6-P6g) as its HTTP answer, `{error: <token>, reason}` (the P4b2/P4g shape); anything else unchanged. */
function deliveryHttpError(err: unknown): unknown {
  if (err instanceof DeliveryRefusal) {
    if (err.code === "not_found") return new NotFoundException("webdev site not found");
    return new HttpException({ message: err.code, reason: err.detail }, err.status);
  }
  return err;
}

/** A deploy-secret refusal (M6-P6o) as its HTTP answer, `{error: <token>, reason}`. The reason names fields and tokens,
 *  never a value (deploy-credential.ts). */
function deploySecretHttpError(err: unknown): unknown {
  if (err instanceof DeploySecretRefusal) {
    if (err.code === "not_found") return new NotFoundException(err.detail);
    return new HttpException({ message: err.code, reason: err.detail }, err.status);
  }
  return err;
}

@Controller("api/:tenantId/modules/webdev")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class WebdevController {
  @Get("provisioned-sites")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("runId") runId?: string,
  ): Promise<SiteDto[]> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "read");
    return listProvisionedSites(tenantId, runId);
  }

  @Get("provisioned-sites/:id")
  async getOne(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<SiteDto & {
    completion: ProvisionCompletionDto | null; scaffold: ScaffoldCommitDto | null; deployGrant: DeployGrantDto | null;
    delivery: SiteDeliveryDto; builds: SiteBuildsDto;
  }> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "read");
    const site = await getProvisionedSite(tenantId, id);
    if (!site) throw new NotFoundException("provisioned site not found");
    // M6-P4c: where §08's completion stands (registry row, WebDesk tenant, pinned contract). Additive.
    // M6-P4b2: where the scaffold's first fill stands (state, commit, last error). Additive.
    // M6-P4g: where the deploy grant stands (state, the secret NAMES, last error). Additive.
    // M6-P6g: where the HOST side stands per registry row (awaiting_deploy_credential | ready). Additive, and a different
    // fact from `deployGrant` (GitHub-side): the two are read separately and never merged.
    return {
      ...site,
      completion: await readProvisionCompletion(tenantId, id),
      scaffold: await readScaffoldCommit(tenantId, id),
      deployGrant: await readDeployGrant(tenantId, id),
      delivery: (await readDeliveryForProvisioned(tenantId, [id])).get(id) ?? { environments: [] },
      // M6-P6h: per environment, whether a build could start now (and the typed reason if not) and the newest build: staging
      // (publish | rebuild) and production (promote). Additive; read from the registry and the WSK-60 ledger.
      builds: (await readSiteBuildsForProvisioned(tenantId, id)) ?? { environments: [] },
    };
  }

  /**
   * M6-P4b2 — commit the tree `code.scaffold` v2 composed as the FIRST FILL of this site's provisioned repo, with the
   * ERP App (hub tool `webdev.provisionedSites.commitScaffold`, called by the scaffold job). Body:
   * `{runId, goalId?, contractSnapshotId?, files: [{path, base64, sha256, bytes}]}`. Everything is decided in
   * `scaffold-commit.ts` (integrity, first-fill-only, crash-resume) and `scaffold-commit.service.ts` (the repo, the
   * `github_repo · push` check on the org tenant). This route gates `webdev_provisioned_site · provision`: the first
   * fill is the last leg of §08's provisioning. Refusals are `{error: <token>, reason}` with the token's status.
   * M6-P4g: the answer also carries `deployGrant` (the grant that followed the commit; never an error by itself).
   */
  @Post("provisioned-sites/:id/scaffold-commit")
  @HttpCode(200)
  async commitScaffold(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ScaffoldCommitResponse> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "provision");
    if (!SITE_ID_RE.test(id)) throw new NotFoundException("provisioned site not found");
    try {
      return await commitScaffoldForSite(req.principal, tenantId, id, body);
    } catch (err) {
      if (err instanceof ScaffoldRefusal) {
        if (err.code === "not_found") throw new NotFoundException("provisioned site not found");
        throw new HttpException({ message: err.code, reason: err.detail }, err.status);
      }
      throw err;
    }
  }

  /**
   * M6-P4g — the deploy gate. Re-checks every condition (a live registry row, the scaffold committed, the GH-12 repo, a
   * CONTRACT.lock at the default branch's head naming the pinned snapshot) and grants the repo READ access to each
   * configured org deploy secret (`WEBDESK_DEPLOY_SECRET_NAMES`). Idempotent; completes a partial grant; also undoes an
   * operator's revoke (the automatic path after the scaffold commit never does). The ERP never holds a secret value.
   * Gates (inside the service, shared with the automatic path): `webdev_provisioned_site · provision` on the request
   * tenant, then `github_repo · push` on the GitHub org tenant. No body.
   */
  @Post("provisioned-sites/:id/deploy-grant")
  @HttpCode(200)
  async grantDeploy(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<DeployGrantResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "provision");
    if (!SITE_ID_RE.test(id)) throw new NotFoundException("provisioned site not found");
    try {
      return await grantDeployForSite(req.principal, tenantId, id, "operator");
    } catch (err) {
      throw deployGrantHttpError(err);
    }
  }

  /**
   * M6-P4g — revoke the deploy grant: the repo is removed from every deploy secret it may hold (configured and recorded).
   * Body `{reason}` (8 to 500 characters), validated only after both gates. A human operator action: no hub tool reaches
   * it. Same two gates as the grant; both refuse low assurance.
   */
  @Delete("provisioned-sites/:id/deploy-grant")
  @HttpCode(200)
  async revokeDeploy(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DeployRevokeResult> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "provision");
    if (!SITE_ID_RE.test(id)) throw new NotFoundException("provisioned site not found");
    try {
      return await revokeDeployForSite(req.principal, tenantId, id, body);
    } catch (err) {
      throw deployGrantHttpError(err);
    }
  }

  /**
   * The create. Returns 201 for a fresh provision and **200 for an idempotent re-call** — the loser
   * of a race, or a client that retried, gets the EXISTING row rather than a second repo. That
   * status split is the externally-visible face of the idempotency contract, so it is asserted in
   * the suite rather than left to chance.
   */
  @Post("provision")
  async provision(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Body() body: { runId?: string; framework?: string; slug?: string; stack?: string; clientId?: string; projectId?: string },
  ): Promise<SiteDto> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, module: "webdev" }, "provision");
    const runId = body?.runId?.trim() || null;
    if (!runId && !body?.slug) throw new BadRequestException("runId (or an explicit slug) is required");

    const actorId = req.principal.userId;
    const provider = resolveProvider(tenantId, actorId);
    const outcome = await provisionSite({
      tenantId,
      provider,
      runId,
      framework: body?.framework,
      slug: body?.slug,
      stack: body?.stack,
      clientId: body?.clientId?.trim() || null,
      projectId: body?.projectId?.trim() || null,
      requestedBy: actorId,
      requestedByName: await displayNameFor(actorId),
      // A human acting through this endpoint IS the approval (design §04's secondary trigger, gated
      // by Cerbos above). The automation path does not come through here — D14 calls the service
      // with `requireSignedPrdGate: true` after a human approves the suspended tool call.
      requireSignedPrdGate: false,
    });

    switch (outcome.outcome) {
      case "created":
      case "adopted": {
        // Poll DETACHED. The contract returns as soon as the mirror row exists and egress has begun
        // (§04: "201 { site } — mirror row created, egress begun"); certbot can take minutes and must
        // not hold an HTTP request open. Errors are swallowed on purpose: the poller's ONLY job is to
        // advance a row it re-reads under a lock, and the hourly reconcile flow is the backstop for
        // anything it misses (including this process dying mid-poll).
        // M6-P4c: when the poll ends, finish §08 for whatever it reached (registry row, WebDesk tenant,
        // contract). `completeAfterPoll` never throws and does nothing for a row still awaiting its repo.
        const principal = req.principal;
        void pollProvisioningSite(tenantId, outcome.site.id, provider)
          .then((polled) => (polled ? completeAfterPoll(tenantId, polled.id, principal) : undefined))
          .catch(() => {});
        await writeActivity(tenantId, actorId, "provisioned", "webdev_provisioned_site", outcome.site.id, {
          slug: outcome.site.slug, runId, adopted: outcome.outcome === "adopted",
        });
        reply.status(201);
        return outcome.site;
      }
      case "existing":
        reply.status(200);
        return outcome.site;
      case "conflict_foreign":
        // The name is held by a site that is not ours. The mirror row is COMMITTED as
        // `failed/slug_conflict_foreign` before this throw — the refusal is a recorded fact with a
        // notification behind it, not just a status code.
        throw new ConflictException({ message: "slug_conflict_foreign", site: outcome.site });
      case "slug_taken":
        throw new ConflictException({ message: "slug_taken" });
      case "invalid":
        throw new BadRequestException({ message: outcome.reason });
      case "precondition_failed":
        throw new BadRequestException({ message: outcome.reason });
      case "provider_rejected":
        throw new ServiceUnavailableException({ message: "provider_rejected", site: outcome.site });
      case "egress_error":
        throw new ServiceUnavailableException({ message: "egress_error", site: outcome.site });
      default: {
        const never: never = outcome;
        throw new Error(`unhandled provisioning outcome: ${JSON.stringify(never)}`);
      }
    }
  }

  /** Re-poll now (staff; the in-process scheduled loop, provision-reconcile-loop.ts, calls the same functions). Also the RESUME path for a
   *  row whose egress never happened — which is why it is Cerbos-gated with its own action rather
   *  than folded into `read`: reconcile can cause an egress. */
  @Post("provisioned-sites/:id/reconcile")
  @HttpCode(200)
  async reconcile(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<SiteDto & { completion: ProvisionCompletionDto | null }> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "reconcile");
    const provider = resolveProvider(tenantId, req.principal.userId);
    // M6-P4c: the repo step's reconcile (unchanged), then §08's completion steps. This route is THE resume
    // path: a crash between any two steps is picked up here, and no step ever runs twice.
    const { outcome } = await reconcileAndComplete({
      tenantId, siteId: id, provider,
      requestedByName: await displayNameFor(req.principal.userId),
      principal: req.principal,
    });
    if (outcome.outcome === "not_found") throw new NotFoundException("provisioned site not found");
    if (outcome.outcome === "conflict_foreign") {
      throw new ConflictException({ message: "slug_conflict_foreign", site: outcome.site });
    }
    if (outcome.outcome === "slug_taken") throw new ConflictException({ message: "slug_taken" });
    if (outcome.outcome === "invalid" || outcome.outcome === "precondition_failed") {
      throw new BadRequestException({ message: outcome.reason });
    }
    if (outcome.outcome === "egress_error" || outcome.outcome === "provider_rejected") {
      throw new ServiceUnavailableException({ message: outcome.site.failureReason ?? "failed", site: outcome.site });
    }
    return { ...outcome.site, completion: await readProvisionCompletion(tenantId, outcome.site.id) };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // VLT-2 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the `webdev_sites` PORTFOLIO
  // registry's first write path. DISTINCT table from `webdev_provisioned_sites` above: this is the
  // "what exists" registry (portfolio-reads.service.ts), not the "how it was born" mirror.
  //
  // ── AUTHZ: THE REGISTRY'S OWN KIND, `webdev_site` (M6-P3c) ──────────────────────────────────────
  // `resource_webdev_site.yaml` carries four actions: `create` (POST sites), `read` (GET sites/:id),
  // `update` (PATCH sites/:id, the vault_ref pointer write) and `request_probe_consent`
  // (console-reads.controller.ts). Until M6-P3c these routes borrowed `webdev_provisioned_site`'s
  // `provision`/`read`/`operate`; the new kind is BEHAVIOUR-PRESERVING, each action carrying the exact
  // reach of the one it replaced (the policy's header holds the table), so no principal gained or lost
  // access. `webdev_provisioned_site` is untouched and still serves the provisioning routes above.
  // `id` passed for GET/PATCH is a `webdev_sites` row id, which is what `webdev_site` means.
  // M6-P4c2 adds POST sites/:id/domain (below) under the SAME `update` action: it is the registry's
  // other narrow write on an existing row, and it carries exactly `update`'s reach (manager tier, no
  // permission-mirror arm). No new Cerbos action: a separate action would be six artifacts for no new reach.
  @Post("sites")
  @HttpCode(201)
  async createSite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<WebdevSiteDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, module: "webdev" }, "create");
    // vaultRef is deliberately not accepted here — see site-registry.service.ts's own header. A
    // caller sending it gets a clear, named rejection rather than a silently-ignored field.
    if ("vaultRef" in body) {
      throw new BadRequestException("vaultRef is not accepted on create — PATCH sites/:id after creating the row");
    }
    const site = await createWebdevSite(
      tenantId,
      {
        domain: body.domain as string,
        environment: body.environment as string | undefined,
        projectId: (body.projectId as string | null | undefined) ?? null,
        clientId: (body.clientId as string | null | undefined) ?? null,
        hostKind: body.hostKind as string | undefined,
        hostRef: (body.hostRef as string | null | undefined) ?? null,
        access: body.access as string | undefined,
        kind: (body.kind as string | null | undefined) ?? null,
        repoUrl: (body.repoUrl as string | null | undefined) ?? null,
        repoBranch: (body.repoBranch as string | null | undefined) ?? null,
        adoption: body.adoption as string | undefined,
        contractVersion: (body.contractVersion as string | null | undefined) ?? null,
        origin: body.origin as string | undefined,
        notes: (body.notes as string | null | undefined) ?? null,
      },
      req.principal.userId,
    );
    await writeActivity(tenantId, req.principal.userId, "created", "webdev_site", site.id, { domain: site.domain });
    return site;
  }

  @Get("sites/:id")
  async getSite(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<WebdevSiteDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "read");
    const site = await getWebdevSite(tenantId, id);
    if (!site) throw new NotFoundException("webdev site not found");
    return site;
  }

  /** M6-P6i — the DNS checklist the console shows for one registry row: the records to create (type, name, target), derived from
   *  where the site is delivered, and a READ-ONLY resolver check that says `pending` or `pointing`. Writes nothing, calls no DNS
   *  API, holds no DNS credential (O-12): the owner changes the records for our domains and the client for theirs. With no documented
   *  target for the row's host the answer is `target_unknown` and tells the person to ask the operator. Authorization is the registry's
   *  `webdev_site · read`, like the row itself. */
  @Get("sites/:id/dns")
  async getSiteDns(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<SiteDnsDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "read");
    return readSiteDns(tenantId, id);
  }

  /** M6-P6p — the Web Dev task that asks a person to create this domain's DNS records (WSK-D89 (4)): the newest link row for the
   *  site, `state: "none"` when it never had one. A READ, authorized like the row itself (`webdev_site · read`). */
  @Get("sites/:id/dns/task")
  async getSiteDnsTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<SiteDnsTaskDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "read");
    const site = await getWebdevSite(tenantId, id);
    if (!site) throw new NotFoundException("webdev site not found");
    return readSiteDnsTask(tenantId, id);
  }

  /** M6-P6p — run the P6i read-only DNS check for this site NOW and let it close the DNS task: every record `pointing` completes
   *  the PM task with the note that the ERP's DNS check closed it. No body. It can write (close the task), so it is authorized as the
   *  registry's `update`, not `read`; the closing itself depends only on what public DNS answers, never on the caller. */
  @Post("sites/:id/dns/recheck")
  @HttpCode(200)
  async recheckSiteDns(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<DnsTaskCheckResult> {
    // A malformed id can match no row, and `update`'s resource lookup would die at the uuid cast as a 500: it is a 404, decided on the
    // id's SHAPE alone, so it reveals nothing authorization should hide.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException("webdev site not found");
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
    const site = await getWebdevSite(tenantId, id);
    if (!site) throw new NotFoundException("webdev site not found");
    return checkSiteDnsTask(tenantId, id, req.principal.userId);
  }

  /** THE `vault_ref` pointer write. Accepts EXACTLY `{ vaultRef }` — any other top-level key in the
   *  body is a 400, which is what proves this endpoint cannot become a backdoor write path for any
   *  other column, present or future (including a future accidental credential column — the
   *  regression this whole ticket exists to keep impossible). `vaultRef` itself may be a string (an
   *  `integration_connections.id` in this tenant) or `null` to clear the pointer. */
  @Patch("sites/:id")
  async patchSiteVaultRef(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<WebdevSiteDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
    const keys = Object.keys(body ?? {});
    if (keys.length !== 1 || keys[0] !== "vaultRef") {
      throw new BadRequestException(
        `this endpoint accepts exactly {"vaultRef": string|null} — got field(s): ${keys.join(",") || "(none)"}`,
      );
    }
    const raw = body.vaultRef;
    if (raw !== null && typeof raw !== "string") {
      throw new BadRequestException("vaultRef must be a string (an integration_connections id) or null");
    }
    const site = await patchWebdevSiteVaultRef(tenantId, id, raw as string | null);
    await writeActivity(tenantId, req.principal.userId, "updated", "webdev_site", site.id, {
      vaultRefSet: site.vaultRef !== null,
    });
    return site;
  }

  /** M6-P4c2 — a provisioned site CLAIMS its real domain, once. The row M6-P4c registered carries the
   *  placeholder `<slug>.provisioned.invalid`; this replaces it. Accepts EXACTLY `{ domain }` (same
   *  closed-body discipline as the vaultRef PATCH). Only a `provisioned`-origin row still on its
   *  placeholder can be claimed — anything else is 409 `domain_already_set` — so this is not a general
   *  domain editor. Authorization comes first and is independent of the body: a caller who may not
   *  update gets 403 whatever they send. */
  @Post("sites/:id/domain")
  @HttpCode(200)
  async claimSiteDomain(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<WebdevSiteDto & { property: PropertyLinkResult }> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
    const keys = Object.keys(body ?? {});
    if (keys.length !== 1 || keys[0] !== "domain") {
      throw new BadRequestException(
        `this endpoint accepts exactly {"domain": string} — got field(s): ${keys.join(",") || "(none)"}`,
      );
    }
    if (typeof body.domain !== "string") throw new BadRequestException("domain must be a string");
    const site = await claimProvisionedSiteDomain(tenantId, id, body.domain, req.principal.userId);
    await writeActivity(tenantId, req.principal.userId, "updated", "webdev_site", site.id, {
      domainClaimed: true, domain: site.domain, propertyState: site.property.state, propertyVerified: site.property.verified,
    });
    return site;
  }

  /** M6-P6g — bind a registry row to its delivery target. Body EXACTLY `{hostKind, hostRef, access, vaultRef}` (any other key
   *  is a 400: a host, user, path or secret has no column and is refused, not ignored). `hostKind` is `shared-hosting` or
   *  `our-box`; `hostRef` an opaque label; `access` `ssh` (SFTP) or `ftp` (FTPS); `vaultRef` a VLT-1 record of THIS tenant,
   *  linked, of the provider that access needs, owned by the company or this site's own client. Another tenant's record and
   *  an id that does not exist are both `422 vault_ref_unknown`. Authorization comes first and is independent of the body
   *  (`webdev_site · update`, no new action). Refusals are `{error: <token>, reason}` with the token's status. */
  @Post("sites/:id/delivery-binding")
  @HttpCode(200)
  async bindDelivery(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DeliverySiteDto> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "update");
    try {
      const input = parseBindingBody(body);
      const site = await bindSiteDelivery(tenantId, id, input, req.principal.userId);
      await writeActivity(tenantId, req.principal.userId, "updated", "webdev_site", site.id, {
        deliveryBound: true, hostKind: site.hostKind, hostRef: site.hostRef, access: site.access, deliveryState: site.deliveryState,
      });
      return site;
    } catch (err) {
      throw deliveryHttpError(err);
    }
  }

  /** M6-P6g — create a provisioned site's PRODUCTION row from its STAGING row (`:id` is the staging row). Body EXACTLY
   *  `{domain}`. Once only: a second call, or a project that already has a production row, is `409 production_row_exists`;
   *  a domain another live row holds is `409 domain_taken`. The new row copies project, client, kind, repo and adoption and
   *  starts unbound (`awaiting_deploy_credential`). Authorization is the registry's `webdev_site · create` (a new row).
   *  M6-P6h2: the answer carries an additive `deployGrant` (the deploy grant re-run for the new row's production per-site secret,
   *  or null when the staging row is not a provisioned site's); it never fails the request. */
  @Post("sites/:id/production")
  @HttpCode(201)
  async createProduction(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DeliverySiteDto & { property: PropertyLinkResult; deployGrant: DeployGrantSummary | null }> {
    await authorize(req.principal, { kind: "webdev_site", tenantId, id, module: "webdev" }, "create");
    try {
      const rec = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      const keys = rec ? Object.keys(rec) : [];
      if (!rec || keys.length !== 1 || keys[0] !== "domain" || typeof rec.domain !== "string") {
        throw new DeliveryRefusal("production_body_invalid", `this command accepts exactly {"domain": string} — got field(s): ${keys.join(",") || "(none)"}`);
      }
      const site = await createProductionFromStaging(tenantId, id, rec.domain, req.principal.userId);
      await writeActivity(tenantId, req.principal.userId, "created", "webdev_site", site.id, {
        domain: site.domain, environment: site.environment, promotedFromSiteId: id, propertyState: site.property.state, propertyVerified: site.property.verified,
      });
      // M6-P6h2: the production row exists, so the repo's deploy grant also covers its PRODUCTION per-site secret. Best effort
      // and never throwing (a refusal is data in `deployGrant.error`, recorded on the provisioned row), and the automatic path:
      // it never re-grants a revoked site. null: the staging row belongs to no provisioned site, so there is no grant to extend.
      return { ...site, deployGrant: await followProductionRow(req.principal, tenantId, id) };
    } catch (err) {
      throw deliveryHttpError(err);
    }
  }

  // ═══ M6-P6o (WSK-D88): the ERP writes each delivered site's deploy secret from its vault record ═══════════════════

  /** Seal a per-site deploy credential into its vault record (runbook step 2b; replaces the local VLT-4 script for this use).
   *  Body EXACTLY `{credential: {...}}`, the deploy secret's documented shape. `integration_connection · manage` on the record,
   *  checked before the body is read. The answer is the masked record and a ciphertext hash: the value is never echoed. */
  @Put("deploy-credentials/:connectionId")
  @HttpCode(200)
  async sealDeployCredential(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
  ): Promise<SealedCredentialDto> {
    try {
      return await sealDeployCredential(req.principal, tenantId, connectionId, body);
    } catch (err) {
      throw deploySecretHttpError(err);
    }
  }

  /** File ONE HIGH approval to write this row's org secret from its vault record. A second person (never the requester) who
   *  holds `provision`, `integration_connection · manage` and `github_repo · secret_write` approves it in the Approvals inbox,
   *  and the write runs then (automation-approvals.controller.ts). Body: nothing, or `{reason}`. */
  @Post("sites/:id/deploy-secret")
  @HttpCode(201)
  async fileDeploySecret(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DeploySecretFilingDto> {
    try {
      return await fileDeploySecretWrite(req.principal, tenantId, id, body);
    } catch (err) {
      throw deploySecretHttpError(err);
    }
  }

  /** Where this row's org secret stands against its vault record (written, stale, pending with its typed reason, ...). */
  @Get("sites/:id/deploy-secret")
  async readDeploySecret(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<DeploySecretStateDto> {
    try {
      return await readDeploySecretState(req.principal, tenantId, id);
    } catch (err) {
      throw deploySecretHttpError(err);
    }
  }
}
