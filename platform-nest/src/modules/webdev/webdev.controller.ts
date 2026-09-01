// PRV-02 — the `webdev` module's HTTP surface (design §04's "Contract — ERP side").
//
//   POST /api/:tenantId/modules/webdev/provision                        -> 201 | 200 | 409 | 422 | 502 | 503
//   GET  /api/:tenantId/modules/webdev/provisioned-sites[?runId=]       -> 200 [site]
//   GET  /api/:tenantId/modules/webdev/provisioned-sites/:id            -> 200 site
//   POST /api/:tenantId/modules/webdev/provisioned-sites/:id/reconcile  -> 200 site
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
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException,
  Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { withGlobal } from "../../db";
import { authorize, writeActivity } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { ErpRepoControlNotConfiguredError, createErpRepoControlProvider } from "./erp-repo-control-provider";
import type { ProvisionProvider } from "./provision-provider";
import {
  getProvisionedSite, listProvisionedSites, provisionSite, pollProvisioningSite,
  reconcileProvisionedSite, type SiteDto,
} from "./provisioning.service";

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
  ): Promise<SiteDto> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "read");
    const site = await getProvisionedSite(tenantId, id);
    if (!site) throw new NotFoundException("provisioned site not found");
    return site;
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
        void pollProvisioningSite(tenantId, outcome.site.id, provider).catch(() => {});
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

  /** Re-poll now (staff + the scheduled `wd-provision-reconcile` flow). Also the RESUME path for a
   *  row whose egress never happened — which is why it is Cerbos-gated with its own action rather
   *  than folded into `read`: reconcile can cause an egress. */
  @Post("provisioned-sites/:id/reconcile")
  @HttpCode(200)
  async reconcile(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
  ): Promise<SiteDto> {
    await authorize(req.principal, { kind: "webdev_provisioned_site", tenantId, id, module: "webdev" }, "reconcile");
    const provider = resolveProvider(tenantId, req.principal.userId);
    const outcome = await reconcileProvisionedSite({
      tenantId, siteId: id, provider,
      requestedByName: await displayNameFor(req.principal.userId),
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
    return outcome.site;
  }
}
