// NestJS bootstrap (P5c port). Keeps the FASTIFY adapter deliberately — it preserves the
// perf profile AND `app.inject(...)`, so the existing platform test suite can run against the
// Nest app unchanged as the contract-parity oracle. buildApp() is the buildServer() analogue.
import "reflect-metadata";
// WS9: start OpenTelemetry BEFORE any module that touches http/pg/ioredis, so auto-instrumentation
// patches them. No-op unless OTEL_ENABLED. Must stay above the AppModule import.
import { fastifyLoggerOption } from "./telemetry";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module";
import { config, n8nBridgeEnabled, graphBridgeEnabled, knowledgeIngestEnabled } from "./config";
import { startKnowledgeIngestLoop } from "./modules/knowledge/ingest/scheduler";
import { HttpErrorFilter } from "./http-error.filter";
import { ProviderDispatchErrorFilter } from "./modules/search/provider-dispatch-error.filter";
import { GatewayNotConfiguredErrorFilter } from "./modules/search/gateway-not-configured-error.filter";
// SM-25a: the Google-surface error family (modules/search/google/errors.ts). Registered here for
// exactly the reason SM-53/SM-57 had to be — an unmapped plain Error escapes as a body-less 500.
import { GoogleOAuthErrorFilter } from "./modules/search/google/google-oauth-error.filter";
// GH-02 — the GitHub-surface error family (core/github/errors.ts). Same reasoning as SM-25a/SM-53/
// SM-57 immediately above: a plain Error escapes as a body-less 500 without a mapping filter.
import { GithubErrorFilter } from "./core/github/github-error.filter";
// GH-06 — the org crawl + periodic reconcile sweep's background-loop starter (see the call site
// near the other dark-by-default sweeps below for why it is gated the way it is).
import { startGithubRepoSyncLoop } from "./core/github/repo-sync.service";
import { ClientAccessErrorFilter } from "./core/client-access-error.filter";
// SMM-05 — the social publisher's typed refusals. Registered for the same reason its search
// sibling above is: SocialPublisherError is a plain Error, so without a filter every refusal —
// including the cross-client publish defence REPORTING that it fired — escapes as a body-less 500.
import { SocialPublisherErrorFilter, SocialOAuthErrorFilter } from "./modules/social/publisher-error.filter";
import { LastResortExceptionFilter } from "./last-resort-exception.filter";
import { maxUploadBytes } from "./core/meetings.controller";
import { migrate } from "./db/migrate";
// VLT-4 precondition (OQ-2.6.b / WSK-D33) — the DO-NOT-ROTATE tripwire. See its own header for why
// this runs at boot rather than as a health signal or a docs-only register entry.
import { assertIntegrationTokenKeyMatchesCanary } from "./core/token-key-tripwire";
// Finding 04 — refuses to boot a NODE_ENV=production runtime configured for passwordless (`dev`)
// auth. Sits beside the token tripwire above because both are no-DB, refuse-before-anything guards.
import { assertAuthModeBootSafe } from "./auth/dev-mode-guard";
import { getPool } from "./db";
import { seedClockFromDb } from "./events/hlc";
import { registerModule, validateModulePermissions } from "./modules/registry";
import { COMPILED_IN_MODULES } from "./modules/compiled-in-modules";
import { FinanceErrorFilter } from "./modules/finance/finance-error.filter";
import { registerDriver } from "./modules/monitoring/drivers/registry";
import { httpDriver, keywordDriver } from "./modules/monitoring/drivers/http";
import { heartbeatDriver } from "./modules/monitoring/drivers/heartbeat";
import { startMonitoringRunnerLoop } from "./modules/monitoring/runner";
import { startClientTargetsLoop } from "./modules/monitoring/client-targets";
import { rebuildTargets, startSiteBuildsLoop } from "./modules/webdev/site-builds.service";
import { sweepScheduledRebuilds } from "./modules/webdev/scheduled-rebuilds.service";
import { provisionReconcileStartLine, startProvisionReconcileLoop } from "./modules/webdev/provision-reconcile-loop";
import { siteDnsTaskStartLine, startSiteDnsTaskLoop } from "./modules/webdev/domain-dns-task.service";
// WSK-40 — the WebDesk editorial assertion signer (Ed25519, file-mounted key). Registration only; see
// the call site below.
import { wireWebdeskEditorialSigner } from "./modules/webdev/webdesk-editorial-signer";
import { createDataForSeoProviderFromConfig } from "./modules/search/providers/dataforseo";
import { createSemrushProviderFromConfig } from "./modules/search/providers/semrush";
import { createAhrefsProviderFromConfig } from "./modules/search/providers/ahrefs";
import { registerLiveAdsExecutor } from "./modules/search/sem-apply";
import {
  assertAdsWriteModeBootSafe, googleAdsLiveExecutor, resolveSearchAdsWriteMode,
} from "./modules/search/sem-executor-google-ads";
import { wireSearchConversionsWriteMode } from "./modules/search/conversions-uploaders";
// SM-33's simulation tier (tracker §6), owned and landed by a concurrent agent this same wave —
// SM-34 owns registering it here, not building it. isSimulatedProvider is the structural provenance
// check (design addendum §A4.3) used below to make mode/driver mutual exclusion a BOOT ERROR.
import { createSimulationProviders, isSimulatedProvider } from "./modules/search/providers/simulation";
import { registerProvider } from "./modules/search/providers/registry";
// SMM-05/06 — the social publisher boot wiring. Opens NO socket: registration is a pure decision
// from config, so the platform boots normally with Postiz unreachable and the publisher-touching
// capabilities degrade to typed 503s. See that file's header.
import { wireSocialPublisher } from "./modules/social/publisher/boot";
// SMM-38/38b — token custody's own boot wiring: registers `purgeOAuthTokens` into SMM-36's
// `registerRetentionPurger('oauth_tokens', ...)` seam (inbox-retention-job.ts). Opens no socket and
// registers no TokenRefresher for any network — 38b ships zero refreshers by design (no OAuth client
// exists yet for LinkedIn/YouTube). See oauth-tokens.ts's header for what this call does and does not
// do, and why `direct` itself is deliberately NOT registered here (unlike this purger hook, that
// would change resolvePublisher's empty-registry heuristic — see boot.ts's own header).
import { wireOAuthTokenCustody } from "./modules/social/publisher/oauth-tokens";
// Security follow-up to SMM-38c/38d — registers `purgeSocialOAuthStates` into the SAME SMM-36 seam,
// key `'oauth_states'`, alongside `wireOAuthTokenCustody()` immediately below. Pure in-process
// registration, no network call, no new schedule.
import { wireSocialOAuthStateCustody } from "./modules/social/publisher/oauth-state";
// SM-49 AC 9 (tracker §6u; design addendum §A10.4) — the repointed-base-URL boot guard. Lives outside
// config.ts (SM-48 owns it this wave) and outside modules/search (it isn't itself an egress file — see
// its own header). registerProvider above already makes the simulate/live branches structurally
// exclusive; this predicate is the SEPARATE guard against a live branch pointed at a private endpoint.
import { assertLiveVendorBaseUrlsAreNotPrivate, SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV } from "./search-vendor-baseurl-guard";
// SM-51 (design addendum §A12.3) — the SAME guard extended to the Google endpoint seams. Separate
// function + separate override env var because the two risks differ: a private vendor base URL mints
// fabricated market data, a private Google issuer mints credential-vault rows that misrepresent a
// client's own account. Reuses the one lexical predicate (see that file's header).
import {
  assertLiveGoogleEndpointsAreNotPrivate,
  googleEndpointSeamsFromConfig,
  ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV,
} from "./modules/search/google/endpoint-guard";
import { registerCoreRollupProvider, coreTaskRollups, syncMetricDefinitions } from "./rollups/engine";
import { clientWorkRollups } from "./core/client-work";
import { startRelayLoop } from "./events/relay";
import { startConsumerLoop, registerCoreEventHandler } from "./events/consumer.service";
import { registerPositionEventHandlers, POSITION_STREAMS } from "./events/position-consumer";
// D14-03 — the core automation-approval EXECUTOR (replaces D14-02's stub handler below).
import { automationApprovalExecutorHandler } from "./core/approval-execute";
import { startReconcileLoop, startDriftSweepLoop } from "./events/reconcile-consumer";
import { startPositionMaintenanceLoop } from "./admin/grant-expiry-sweep";
import { startN8nBridgeLoop } from "./events/n8n-bridge";
import { startGraphBridgeLoop } from "./events/graph-bridge";
import { startWorkActivityConsumerLoop } from "./events/work-activity-consumer";
import { runWorkActivityBackfill } from "./core/work-activity-backfill";
import { startBurndownSnapshotLoop } from "./modules/pm/burndown-job";
import { startStaleReaperLoop } from "./modules/it/discovery.service";
import { startInboxRetentionPurgeLoop } from "./modules/social/inbox-retention-job";
// M5-G5: the agency-lead retention purge (addendum section 5). See the call site.
import { leadRetentionConfig, startLeadRetentionPurgeLoop } from "./core/agency-lead-retention";
// SMM-21 — the nightly metrics sweep. Registered here rather than by the authoring seat because
// three tickets were in flight over this file at once; the seat handed up the line instead of
// editing it, which is what kept the collision from happening.
import { startMetricsPullLoop } from "./modules/social/metrics-job";
// SMM-15 — the smm-inbox-pull sweep. Registered here rather than by the authoring seat: three
// tickets have now handed this line up instead of editing main.ts, which is exactly why none of
// them collided over it.
import { startInboxPullLoop } from "./modules/social/inbox-sync-job";
// SMM-16 — triage classification + the SLA guard. Fourth ticket to hand its registration up
// rather than edit this file, which is why none of them have collided here.
import { startInboxTriageLoop, startInboxSlaGuardLoop } from "./modules/social/inbox-triage-job";
// SMM-27 — the best-time-to-post stats sweep. FIFTH social ticket to hand its registration up
// rather than edit this file; not one of them has collided here.
import { startBestTimePullLoop } from "./modules/social/best-time-job";
import { startContentBriefSweepLoop } from "./modules/social/content-brief-job";
import { startCycleReadyByLoop } from "./modules/social/pipeline/cycle-ready-by-job";
// SMM-10 — the reconcile safety poll + D-22's creator-info verifier install. Registering the
// verifier is a pure in-memory decision (no network I/O — see publish-precondition.ts's own seam
// doc), so it runs unconditionally at boot, unlike the interval-driven loop below.
import { startPostStatusSyncLoop } from "./modules/social/post-status-sync-job";
import { installCreatorInfoVerifier } from "./modules/social/creator-info-verifier";
// SM-54 (tracker §6ad Ruling 1 / addendum §A13.2) — the search department's cadence loop lives in the
// platform, NOT in n8n: it executes configuration a verified human already set (each engagement's
// `tool_scope` toggle + cadence + budget cap, written under `search:scope:write`), and every automation
// principal is minted `assurance: "low"` by construction, so giving n8n a path to vendor spend would
// have meant weakening two controls on the money path. Dark by default — see the config comment.
import { startSearchPullSchedulerLoop } from "./modules/search/pull-scheduler";
import { startContentDecayLoop } from "./modules/search/content-decay-job";
import { startVisitorJobs } from "./modules/search/visitor-jobs";
import { startIndexNowRetryLoop } from "./modules/search/indexnow-service";
import { registerIndexNowEventHandlers } from "./modules/search/indexnow-webdesk";
import { registerAmendmentEventHandlers } from "./core/amendment-signed-handler";
import { registerDocumentJobHandlers, startDocumentJobSweep } from "./core/document-jobs";
// PV5-10: online payment (hosted checkout). Off unless MIDTRANS_SERVER_KEY is set; see src/payments/registry.ts.
import { configuredProviders, describePaymentsConfig } from "./payments/registry";
import { PROVIDER_EVENT_STREAM, registerPaymentEventHandlers, startPaymentEventSweep } from "./payments/process";
// PV5-11 / PV-D43: certified signing. Off unless SIGNATURE_SIMULATION_ENABLED is on (the simulated PSrE); see
// src/signatures/registry.ts.
import { certifiedSigningAccount, describeSignaturesConfig } from "./signatures/registry";
import { registerSignatureEventHandlers, startSignatureEventSweep } from "./signatures/process";
// MAIL-04 (design §7.7/§7.8) — the mail sender worker. Only started when MAIL_ENABLED=1 (the
// master gate): starting it unconditionally would still send nothing today (resolveAdapter falls
// back to dev-log when disabled, provider.ts), but not starting it at all is the honest "module is
// dark" state design §7.8 describes, and it means a disabled deployment runs no extra DB polling
// loop for a feature it isn't using. A plain Postgres sweep, no Redis dependency — same family as
// the burndown/drift/IT-reaper loops below, outside the redisUrl gate.
import { startMailSenderLoop } from "./mail/sender";
// MAIL-13 (design §7.6) — see the call in buildApp() for why the inbound door needs its own
// URL-scoped raw-body hook rather than a global parser change.
import type { FastifyInstance } from "fastify";
import { registerInboundRawBodyCapture } from "./mail/inbound/raw-body";
// GH-07 (docs/blueprints/github-integration-foundation.md §4.5) — the webhook receiver's own
// URL-scoped raw-body hook, same shape as MAIL-13's immediately above (HMAC needs the exact bytes
// GitHub signed, not a re-parsed/re-serialized object). See core/github-webhook-raw-body.ts.
import { registerGithubWebhookRawBodyCapture } from "./core/github-webhook-raw-body";
import { registerRequestContext } from "./core/request-context";
import { assertGmailBootSafe } from "./core/gmail/mode";
// 2026-08-24 — `:tenantId` shape validation. See src/core/tenant-param.ts for why this is a root
// hook rather than a pipe on 602 `@Param("tenantId")` call sites.
import { registerTenantParamValidation } from "./core/tenant-param";
// PV4-03b — per-route body limits for the inline-base64 upload routes (the 1 MiB global default stays).
import { installUploadBodyLimits, describeUploadRoutes, type UploadRoute } from "./core/upload-body-limits";

export interface BuildAppOptions {
  /** TEST SEAM ONLY: replaces the upload-route table so a test can prove the boot-time drift guard
   *  throws on an entry that matches no registered route. Production passes nothing. */
  uploadRoutes?: readonly UploadRoute[];
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<NestFastifyApplication> {
  // Fastify logs are pino JSON with trace_id/span_id when OTEL is on, else stay off (unchanged
  // default preserved for the test oracle).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: fastifyLoggerOption() as never }),
    { logger: false },
  );
  // No global prefix: the core controller is @Controller("api"); health/principal/enroll/admin/
  // dev controllers sit at the root, matching the Fastify server's paths exactly.
  // { error: msg } error bodies, matching the Fastify server (UI/bot read `.error`).
  // SM-53: the search module's typed dispatch refusals are plain Errors, so HttpErrorFilter
  // (@Catch(HttpException)) never saw them and they surfaced as a message-less 500 — discarding the
  // human-actionable part these refusals exist for (which toggle to enable, which switch is off).
  // Registered alongside, not instead: the filters catch disjoint types.
  // SM-57: same class of bug, one more instance — GatewayNotConfiguredError (providers/gateway-
  // client.ts) escaped keyword-sets/:id/embed and /cluster as a message-less 500 too.
  // SM-58: the structural floor under both — ANY other uncaught plain Error anywhere in the app
  // still fell through to Nest's default handler (a body-less 500). LastResortExceptionFilter is the
  // app-wide `@Catch()` backstop for every future instance of that class.
  //
  // ORDER IS NOT COSMETIC. Nest's ExceptionsHandler picks the first filter (of the list it holds)
  // whose @Catch type matches, but `RouterExceptionFilters` REVERSES the array passed to this call
  // before storing it — so the LAST argument below is checked FIRST, not last (proven empirically in
  // last-resort-exception.filter.test.ts, which also demonstrates what happens if this is ever
  // "tidied" to the end of the list: it silently shadows every other filter).
  // LastResortExceptionFilter's @Catch() matches EVERY thrown value unconditionally, so it MUST be
  // the FIRST argument — the reversal then puts it LAST in the checked order, genuinely last-resort.
  // The three type-scoped filters below only ever match their own exception type, so their relative
  // order among themselves does not matter.
  // SM-25a: GoogleOAuthErrorFilter is the third type-scoped member of the same family of fixes. It
  // catches the whole `GoogleSurfaceError` hierarchy and uses each error's OWN status/code, so a new
  // Google refusal added later is mapped by construction rather than by remembering to edit a filter.
  app.useGlobalFilters(
    new LastResortExceptionFilter(),
    new HttpErrorFilter(),
    new ProviderDispatchErrorFilter(),
    new GatewayNotConfiguredErrorFilter(),
    new GoogleOAuthErrorFilter(),
    // GH-02: same family-of-fixes shape as GoogleOAuthErrorFilter immediately above — one filter for
    // the whole GithubSurfaceError hierarchy, each subclass carrying its own status/code.
    new GithubErrorFilter(),
    // FINANCE-APP: the FINANCE_* refusal family arrives as pg DatabaseError (a plain Error), so
    // HttpErrorFilter never saw it and every accounting refusal surfaced as a body-less 500.
    // Same class of bug as the four this file already carries. See the filter's own header.
    new FinanceErrorFilter(),
    new ClientAccessErrorFilter(),
    new SocialPublisherErrorFilter(),
    // SMM-38 phase 38c — `linkedin-oauth.controller.ts` is the first caller to surface
    // `OAuthTokenError`/`SocialOAuthStateError` over HTTP (38b shipped the former with no filter
    // at all, since no controller existed yet to need one). `SocialOAuthStateError` is the security
    // follow-up's consolidation of what used to be two per-network classes — see
    // `publisher-error.filter.ts`'s own header for the YouTube-500 gap that consolidation closed.
    new SocialOAuthErrorFilter(),
  );
  // WD-04: the one multipart consumer in the app (in-ERP meeting audio/video upload). The size cap
  // is enforced HERE (busboy truncates + MeetingRecordingsController turns that into a clean 400)
  // as well as re-checked in the handler — belt and suspenders, matching files.controller.ts's
  // own explicit MAX_BYTES check on its base64 path.
  //
  // The registered number is `maxUploadBytes()` — the LARGER of the audio and video caps — because a
  // plugin-level limit is one number for the whole app and cannot know a part's kind. The real,
  // per-kind cap is applied in the handler once the mimetype/extension has been classified. Taking
  // the audio cap here instead would silently truncate every video above it.
  await app.register(multipart, { limits: { fileSize: maxUploadBytes(), files: 1 } });
  // MAIL-13 (design §7.6) — raw-body capture for `POST /api/mail/inbound/*` ONLY. Needed because
  // HMAC verification must run over the exact received bytes (a JSON re-serialization is a different
  // string) and because Fastify's 1 MiB default body limit would otherwise 413 a legitimate inbound
  // mail well below the documented `MAIL_INBOUND_MAX_BYTES` cap. URL-scoped, so no other route's
  // parsing behaviour changes — see src/mail/inbound/raw-body.ts for the full rationale.
  registerInboundRawBodyCapture(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
  // GH-07 — same URL-scoped-hook shape as the mail inbound one immediately above, for
  // `POST /api/webhooks/github` only. Must be registered before `app.init()` for the same reason
  // every other root Fastify hook in this function is — see registerTenantParamValidation's own
  // comment below for why that ordering is load-bearing, not stylistic.
  registerGithubWebhookRawBodyCapture(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
  // [agent-attribution-gate] interim — wrap every request in an AsyncLocalStorage box so
  // `writeActivity` can record WHICH CHANNEL (and which agent) drove a write without threading a
  // parameter through 263 call sites. See src/core/request-context.ts for why ambient beats explicit
  // here: an opt-in audit field is forgotten exactly where it mattered, and nothing fails when it is.
  registerRequestContext(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
  // 2026-08-24 — reject a malformed `:tenantId` with 400 before it reaches a uuid cast in RLS.
  // Same placement rule as the two hooks above and for the same hard reason: Fastify snapshots the
  // root hook list into each route's context when the route is REGISTERED, which `app.init()` below
  // is what triggers. A hook added after it would apply to no Nest route at all — and would fail
  // silently, since "nothing rejected" is indistinguishable from "nothing malformed arrived".
  registerTenantParamValidation(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
  // PV4-03b — raise `bodyLimit` on the inline-upload routes ONLY (payment proof + conversation
  // attachments). Same placement rule as every hook above: this is an `onRoute` hook, so it must be
  // installed before `app.init()` registers the routes. Fastify's 1 MiB default is untouched for every
  // other route. See src/core/upload-body-limits.ts for the derivation of each limit.
  const uploadLimits = installUploadBodyLimits(app.getHttpAdapter().getInstance() as unknown as FastifyInstance, opts.uploadRoutes);
  try {
    await app.init();
    // Fail closed: a table entry that matched no (or two) registered routes means a renamed route has
    // silently fallen back to 1 MiB. Refuse to boot rather than ship that.
    uploadLimits.assertAllMatched();
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
  return app;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// SM-75 (tracker §6bv/§6bv.1) — this whole function is bootstrap()'s search provider-mode +
// ads-write-mode wiring, extracted VERBATIM (not re-implemented) out of its call site so a boot-
// wiring smoke test can invoke the exact function bootstrap() calls, instead of a copy of its
// ordering. The SM-24 gate's finding was that `registerLiveAdsExecutor` + `assertAdsWriteModeBootSafe`
// had been nested inside the `SEARCH_PROVIDER_MODE === "live"` branch below while a comment claimed
// the registration was unconditional — this function's SHAPE (the two SM-26 lines sitting at this
// function's top level, after the if/else, never inside either branch) is the fix; a test that
// re-nests them and goes red is what makes that fix durable.
//
// `providerMode`/`adsWriteMode` default to the real config/env reads bootstrap() used inline before
// this extraction, so calling this with no argument reproduces that exact behaviour — the parameters
// exist ONLY so a test can drive every mode cross-product directly, without reloading config.ts (a
// module-scope object computed once at import time) per case.
export function wireSearchProviderModeAndAdsWriteMode(
  modes: { providerMode?: "simulate" | "live"; adsWriteMode?: "simulate" | "live" } = {},
): void {
  const providerMode = modes.providerMode ?? config.search.providerMode;
  const adsWriteMode = modes.adsWriteMode ?? resolveSearchAdsWriteMode();

  // SM-06/SM-34/SM-35 — provider bootstrap registration (tracker §6, design addendum §A3/§A4.3).
  //
  // `providerMode: "simulate"` registers SM-33's synthetic drivers INSTEAD of any live vendor
  // driver, so dev/staging can demo the department at $0 real spend without empty tables (owner
  // directive: "no live vendor API until staging"). Default is "live" so an existing deployment's
  // behaviour is byte-for-byte unchanged unless SEARCH_PROVIDER_MODE is explicitly set.
  //
  // In "live" mode, each vendor driver registers ONLY when its own credentials AND a positive
  // amortized unit rate are configured (design addendum §A3.3/B1 — Semrush/Ahrefs never default to a
  // $0 rate), and that check is fully INDEPENDENT per vendor — DataForSEO/Semrush/Ahrefs each log
  // plainly and fail closed at the provider registry on their own, so (for example) Semrush creds
  // present + Ahrefs absent registers Semrush only, leaving every Ahrefs-routed capability refused
  // (NoCapableProviderError/unknown_provider) without affecting DataForSEO or the $0 pillars.
  //
  // MODE/DRIVER MUTUAL EXCLUSION IS A BOOT ERROR, NOT A WARNING (addendum §A4.3, binding): this is
  // the structural guarantee that no simulated row can ever be created in live mode, stronger than
  // any per-dispatch check, so a violation must abort startup rather than merely log. The `if`/`else`
  // below already makes cross-registration structurally impossible (the live branch never calls
  // createSimulationProviders(), and the simulate branch never calls any create*ProviderFromConfig()),
  // but the assertProvenance() throw below re-verifies it at the object level via the SAME structural
  // `simulated` marker isSimulatedProvider() reads — so a future refactor that accidentally blurred
  // the branches would fail loudly at boot instead of silently registering a mismatched driver.
  const assertProvenance = (p: { key: string }, expectSimulated: boolean): void => {
    if (isSimulatedProvider(p as never) !== expectSimulated) {
      throw new Error(
        `[search] BOOT ERROR: provider '${p.key}' has simulated=${isSimulatedProvider(p as never)} while ` +
          `SEARCH_PROVIDER_MODE=${providerMode} — mode/driver mutual exclusion violated ` +
          "(design addendum §A4.3: this must abort startup, not degrade to a warning)",
      );
    }
  };

  if (providerMode === "simulate") {
    for (const sim of createSimulationProviders()) {
      assertProvenance(sim, true);
      registerProvider(sim);
    }
    // eslint-disable-next-line no-console
    console.log(
      "[search] provider mode = simulate — registering synthetic dataforseo/semrush/ahrefs drivers " +
        "(SEARCH_PROVIDER_MODE=simulate); no live vendor credentials are read or used",
    );
  } else {
    // SM-49 AC 9 (design addendum §A10.4) — runs BEFORE any vendor factory call, unconditionally
    // across all three vendors (not gated on whether that vendor's credentials are even configured):
    // the hazard is `SEARCH_PROVIDER_MODE=live` plus a vendor `*_BASE_URL` repointed at a private/
    // loopback/internal host, which would otherwise mint `simulated = false` rows from whatever
    // answers there — indistinguishable from real vendor data to every downstream reader. Read
    // directly from process.env, NOT config.ts (SM-48 owns config.ts this wave) —
    // TODO(follow-up): fold this into config.ts alongside the rest of config.search once that
    // ownership frees up, and document it in .env.example as proxy/tunnel-only (also owed to that
    // follow-up). The override exists for exactly two legitimate cases named in §A10.4: SM-49's own
    // vendor-envelope sandbox harness, and local experimentation against a private endpoint on
    // purpose — both set this explicitly, so this guard staying strict by default costs them nothing.
    assertLiveVendorBaseUrlsAreNotPrivate(
      {
        dataforseo: config.search.dataforseo.baseUrl,
        semrush: config.search.semrush.baseUrl,
        ahrefs: config.search.ahrefs.baseUrl,
      },
      process.env[SEARCH_ALLOW_PRIVATE_VENDOR_BASEURL_ENV] === "1",
    );

    // SM-51 (§A12.3) — the same refusal for the Google OAuth issuer + the three API base hosts. Runs
    // in the live branch next to its vendor sibling, and for the analogous reason: a "live" stack
    // pointed at Keycloak (or at SM-51's in-process sandbox) would seal tokens into
    // integration_connections and stamp `linked` on rows that assert a client's real Google account.
    assertLiveGoogleEndpointsAreNotPrivate(
      googleEndpointSeamsFromConfig(),
      process.env[ALLOW_PRIVATE_GOOGLE_ENDPOINT_ENV] === "1",
    );

    const dfs = createDataForSeoProviderFromConfig();
    if (dfs) {
      assertProvenance(dfs, false);
      registerProvider(dfs);
    } else {
      // eslint-disable-next-line no-console
      console.log("[search] DataForSEO credentials not configured — paid search-data capabilities are disabled");
    }

    const semrush = createSemrushProviderFromConfig();
    if (semrush) {
      assertProvenance(semrush, false);
      registerProvider(semrush);
    } else if (config.search.semrush.apiKey) {
      // eslint-disable-next-line no-console
      console.log(
        "[search] Semrush API key present but no positive amortized unit rate is configured " +
          "(SEMRUSH_MONTHLY_PLAN_PRICE_USD/SEMRUSH_MONTHLY_UNIT_ALLOWANCE) — Semrush capabilities are " +
          "disabled (design addendum §A3.3: an unset rate must never default to $0)",
      );
    } else {
      // eslint-disable-next-line no-console
      console.log("[search] Semrush credentials not configured — Semrush search-data capabilities are disabled");
    }

    const ahrefs = createAhrefsProviderFromConfig();
    if (ahrefs) {
      assertProvenance(ahrefs, false);
      registerProvider(ahrefs);
    } else if (config.search.ahrefs.apiKey) {
      // eslint-disable-next-line no-console
      console.log(
        "[search] Ahrefs API key present but no positive amortized unit rate is configured " +
          "(AHREFS_MONTHLY_API_TIER_PRICE_USD/AHREFS_MONTHLY_UNIT_ALLOWANCE) — Ahrefs capabilities are " +
          "disabled (design addendum §A3.3: an unset rate must never default to $0)",
      );
    } else {
      // eslint-disable-next-line no-console
      console.log("[search] Ahrefs credentials not configured — Ahrefs search-data capabilities are disabled");
    }
  }

  // ── SM-26 / addendum §A12.6: the Ads WRITE mode, deliberately separate from the DATA vendor mode ──
  // ⚠️ DELIBERATELY OUTSIDE the SEARCH_PROVIDER_MODE if/else above. The SM-24 gate found this block
  // originally nested in the `live` branch, where my own comment claimed it ran "unconditionally"
  // while the placement meant `SEARCH_PROVIDER_MODE=simulate` skipped BOTH the registration and the
  // boot assertion. That is the department's signature defect verbatim — a guard that reads as
  // enforced and enforces nothing — and the escaping combination is one the addendum itself calls
  // legitimate: simulated DATA with live AD WRITES. It booted silently and failed at request time
  // with `NoLiveExecutorError`, i.e. after the one-shot approval had already been spent, which is
  // precisely the outcome Ruling 3.1 exists to forbid. Keep these two lines at function scope; do
  // not move them back inside a mode branch.
  //
  // Registration only makes a live executor AVAILABLE, never reachable:
  // `resolveAdsExecutor(resolveSearchAdsWriteMode())` decides per request, and in `simulate` it
  // always returns the simulator even when a live executor exists (SM-21: a control that cannot do
  // the thing must not report that it did). The boot assertion is the counterpart —
  // `SEARCH_ADS_WRITE_MODE=live` with no live executor is an unfinished deployment, and boot is the
  // only place that can be refused honestly (§A4.3/§A10.4: a boot error, not a warning).
  registerLiveAdsExecutor(googleAdsLiveExecutor);
  assertAdsWriteModeBootSafe(adsWriteMode, true);
  // eslint-disable-next-line no-console
  console.log(`[search] Ads write mode: ${adsWriteMode} (SEARCH_ADS_WRITE_MODE)`);

  // M5-P2 (design §8.7): the conversion-upload write mode, a SEPARATE switch from the campaign one above. Same placement rule:
  // function scope, unconditional, outside any mode branch. Registers the Google uploader (making live AVAILABLE, never reachable)
  // and REFUSES to boot when SEARCH_CONVERSIONS_LIVE_PLATFORMS lists a platform with no uploader or an unknown token. Default empty:
  // every platform simulates.
  wireSearchConversionsWriteMode();
}

// D14-03 replaced D14-02's inert stub here. The real executor lives in `core/approval-execute.ts`
// (`automationApprovalExecutorHandler`) and is registered below exactly where the stub was — the
// registration site, the event type and the watched stream are all unchanged. See that file's header
// for the four invariants (authority / single-use / TOCTOU / loudness) and the crash-wedge rule.
async function bootstrap(): Promise<void> {
  // DO-NOT-ROTATE TRIPWIRE — runs FIRST, before migrate() or anything else: it needs no DB, and a
  // wrong INTEGRATION_TOKEN_KEY should refuse this boot before it does anything else, not after a
  // migration or module registration has already run. Throws (crashes boot) iff a canary IS
  // configured and this key cannot reproduce it; see token-key-tripwire.ts.
  assertIntegrationTokenKeyMatchesCanary();
  // PASSWORDLESS-AUTH REFUSAL — placed immediately after the token tripwire and for the same
  // reason: it needs no DB, and a runtime that would serve credential-free logins must die here
  // rather than after migrate() has already moved the schema. `AUTH_MODE=dev` accepts an email
  // address and no password (finding 04); refusing is the only useful response, because the
  // symptom of that misconfiguration is that everything appears to work perfectly.
  assertAuthModeBootSafe();
  // Same startup sequence the Fastify server ran: migrate, register compiled-in modules +
  // core rollup providers, sync the governed metric registry, then serve.
  await migrate();
  // Seed the HLC from the greatest clock this origin_site has already committed, so a restart
  // never mints an HLC that regresses (sync-engine-revision §2, D3 #4).
  await seedClockFromDb(getPool());
  // The compiled-in module list lives in ONE file (modules/compiled-in-modules.ts) that the impact and
  // inventory tests also read, so a module cannot be registered here yet skipped by those audits.
  // PRV-02/SMM-02 notes: registering a module contributes its permissions, rollup metrics and McpToolDefs
  // to `GET /mcp/tool-defs`; it does NOT make a tool reachable by automation (hub allowlist + Cerbos
  // `mcp_tool` row) nor a module reachable for a tenant (enabled_modules or an ACTIVE service_assignment).
  for (const m of COMPILED_IN_MODULES) registerModule(m);
  // Registering the MODULE does not register DRIVERS. Kept explicit rather than folded into the
  // module contract: a kind with no driver reports available:false and refuses at dispatch, so the
  // failure is visible either way - but this line is what makes http/keyword/heartbeat runnable,
  // and it should be obvious in the boot sequence which kinds this deployment can actually check.
  registerDriver(httpDriver);
  registerDriver(keywordDriver);
  registerDriver(heartbeatDriver);
  // PRV-02: contributes the `webdev.provisionSite` McpToolDef to `GET /mcp/tool-defs` (nothing is
  // hardcoded hub-side). Registering the module does NOT make the tool reachable by automation —
  // that needs the hub's AUTOMATION_ALLOWLIST entry and its Cerbos `mcp_tool` row, both PRV-03's.
  // WSK-40: bind the real editorial-assertion signer into WSK-66's seam when its key file is mounted.
  // Absent or invalid key → WSK-66's refusing default stays (every WebDesk content command answers 503
  // unsent) and one boot log line says why. Reads one local file; no network; never throws, so a
  // missing WebDesk key cannot take the ERP down.
  wireWebdeskEditorialSigner();
  // SMM-02: the social-media department. Registering it contributes its permissions (validated
  // against the 0106 catalog rows immediately below), its rollup metrics, and its McpToolDefs to
  // `GET /mcp/tool-defs` — nothing is hardcoded hub-side. It does NOT make the module reachable for
  // any tenant: that still needs 'social' in enabled_modules or an ACTIVE service_assignment.
  // IAM-01d: fail-closed drift guard — every module's declared ModuleContract.permissions must
  // resolve to a class='grantable' row in the DB catalog (IAM-01c, migration 0093), or boot is
  // refused outright. Runs AFTER every registerModule() call above (needs the full registered set)
  // and AFTER migrate() (already ran at the top of bootstrap(), so 0093's seed is in place).
  await validateModulePermissions();
  // SM-75: the search provider-mode + ads-write-mode boot wiring — see wireSearchProviderModeAndAdsWriteMode's
  // own header above `bootstrap()` for why this is a single unconditional call rather than inline code.
  wireSearchProviderModeAndAdsWriteMode();
  // DW-8j (FRONTEND-BFF-CONTRACT §48.1): GMAIL_MODE is `simulated` (the default) or `live`. A boot ERROR, not a warning, for any other
  // word, and for `live` without the Gmail OAuth client: a request-time failure would surface only after a person had written their message.
  // Unconditional and at function scope (the SM-26 lesson above: a refusal nested inside a branch reads as enforced and enforces nothing).
  // eslint-disable-next-line no-console
  console.log(`[gmail] mode: ${assertGmailBootSafe()} (GMAIL_MODE)`);
  // SMM-05/06: register the social publisher driver (Postiz, or deliberately register nothing).
  // Also the home of the one social BOOT REFUSAL — a publisher base URL pointing at a PUBLIC
  // address, which means the containment perimeter moved (addendum §A4l §2/§3). No network call is
  // made here. SMM-38 phase 38c: ALSO registers the `direct` driver (LinkedIn's real capabilities)
  // and LinkedIn's token refresher, unconditionally and regardless of Postiz's own configuration —
  // see boot.ts's own header for why this stays behaviourally inert on every live path today.
  wireSocialPublisher();
  // SMM-38/38b — token custody's purger registration, alongside the publisher-driver wiring above
  // (its own ticket asked for exactly this placement — "at module boot, alongside wherever 38b
  // registers its publisher driver"). Pure in-process registration, no network call, no schedule of
  // its own: it rides SMM-36's existing inbox-retention sweep and cadence.
  wireOAuthTokenCustody();
  // Security follow-up to SMM-38c/38d — the state-replay closure's own purge registration, same
  // placement reasoning as the line above.
  wireSocialOAuthStateCustody();
  // SMM-10/D-22 — install the dispatch-side creator-info verifier. Unconditional: it is a pure,
  // in-process registration (`setCreatorInfoVerifier`), never a network call, so there is no boot
  // condition to gate it on. Its own doc states the steady state THIS makes correct: with no
  // verifier installed, a TikTok publish fails closed as `creator_info_unverified` forever — this
  // call is what lets the "creator's live settings still permit it" branch ever pass instead.
  installCreatorInfoVerifier();
  registerCoreRollupProvider(coreTaskRollups);
  registerCoreRollupProvider(clientWorkRollups);
  await syncMetricDefinitions();
  // PV5-10: one line says whether online payment is on. A half-configured money path (a key with no merchant company, an
  // unknown environment, a company id that is not in this database) REFUSES BOOT: failing at request time would happen
  // after a client was already sent to pay.
  {
    const paymentsLine = describePaymentsConfig();
    for (const gw of configuredProviders()) {
      const co = await getPool().query(`SELECT 1 FROM companies WHERE id = $1 AND deleted_at IS NULL`, [gw.tenantId]);
      if (!co.rows[0]) {
        throw new Error(`MIDTRANS_TENANT_ID ${gw.tenantId} is not a live company in this database; online payment cannot file its notices`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[payments] ${paymentsLine}`);
  }
  // PV5-11: one line says whether certified signing is set up. With the SIMULATED PSrE on (PV-D43, review stage) the line
  // is a warning that starts `[signatures:simulation-enabled]`, so a server that still has it on says so on every start.
  {
    const signaturesLine = describeSignaturesConfig();
    // eslint-disable-next-line no-console
    if (certifiedSigningAccount()?.simulated) console.warn(signaturesLine);
    // eslint-disable-next-line no-console
    else console.log(signaturesLine);
  }
  if (config.redisUrl) {
    startRelayLoop();
    // Entity types with at least one registered handler; extend as modules add eventHandlers.
    // WSD-4 adds "user" (hr's user.invited -> onboarding auto-instantiation) and
    // "automation_approval" (hr's automation_approval.decided -> leave decision + balance + notify).
    // SM-13 adds "search_engagement" (search.provider.budget_threshold), "search_audit"
    // (search.audit.completed/regression), and "search_property" — the entity-type streams the
    // search module's REAL emitEvent producers use today (providers/dispatch.ts,
    // search.controller.ts's ingestAudit). The other search.* eventHandlers registered in
    // modules/search/index.ts are forward-looking (no producer yet, see notifications.ts's file
    // header) — their entity-type stream names aren't known until those producers land, so they're
    // not added here to avoid guessing a stream name that turns out wrong.
    // SM-26 wiring note: `search_change_proposal` is added because SM-21 is now a REAL producer on
    // that entity type (`search.campaign.applied`, emitted for every terminal outcome) and SM-73
    // registered its notification handler. Without the stream listed here the handler is registered
    // but never invoked — the event would be written to the outbox, relayed, and read by nobody, so
    // `partial`/`indeterminate` outcomes would silently notify no one. That is precisely the failure
    // this list's own comment above warns about, now that the producer exists.
    // D14-02/D14-03: register the core (non-module) executor handler BEFORE the consumer loop starts
    // reading — see core/approval-execute.ts's header for what it does, and
    // registerCoreEventHandler's header (consumer.service.ts) for why this runs with no
    // isModuleEnabled gate. The stream is already in the watched list below ("automation_approval").
    registerCoreEventHandler("automation_approval.decided", automationApprovalExecutorHandler);
    // M5-P5a: an approved WebDesk `content.publish` pings IndexNow. A CORE handler on purpose (the search module registers NO
    // automation_approval.decided handler: search-sem-apply.test.ts). Flag-gated inside (SEARCH_INDEXNOW_ENABLED === "1"): off, it reads nothing.
    registerIndexNowEventHandlers();
    // PV4-04: a signed amendment tells the triager their change request can start (core/amendment-signed-handler.ts).
    // The `contract` stream is added to the consumer list below in the same change, or this handler would be
    // registered and never invoked.
    registerAmendmentEventHandlers();
    // PV5-07: an issued invoice gets its PDF, a signed contract its sealed copy (core/document-jobs.ts). Core handlers on
    // `invoice.issued` and `contract.signed`; the `invoice` stream is added to the consumer list below in the same change.
    registerDocumentJobHandlers();
    // PV5-10: a claimed payment notice is processed (status re-fetch, then the posting) off `payment.notice.received`
    // (src/payments/process.ts). A core handler; the `provider_event` stream is added to the consumer list below.
    registerPaymentEventHandlers();
    // PV5-11: a claimed signature notice is processed (envelope re-fetch, then the signatures and the certified copy) off
    // `signature.notice.received` (src/signatures/process.ts), on the same `provider_event` stream as payments.
    registerSignatureEventHandlers();
    // P2-05: the position reconciler's outbox triggers. The HANDLERS are flag-gated (they also
    // re-check `positionSyncEnabled` internally, and every reconciler entry point returns null when
    // it is off) but the STREAMS below are listed unconditionally — an always-drained stream can
    // never build a backlog that a later flag flip suddenly replays, and it makes the
    // registered-handler-with-no-stream trap structurally impossible for this pair.
    if (config.positionSyncEnabled) {
      registerPositionEventHandlers();
      // eslint-disable-next-line no-console
      console.log(`position reconciler on: streams [${POSITION_STREAMS.join(", ")}]`);
    }
    if (config.social.bestTime.enabled) {
      startBestTimePullLoop(config.social.bestTime.intervalMs);
      // eslint-disable-next-line no-console
      console.log(`social best-time-to-post (smm-best-time) on: every ${config.social.bestTime.intervalMs}ms`);
    }
    // SMM-26 follow-up: the weekly per-opted-in-engagement content-brief sweep. Dark by default and
    // a HARD gate (it spends ai-gateway-go calls per opted-in engagement) — see config.ts's own
    // comment on config.social.contentBrief.weeklySweep.
    if (config.social.contentBrief.weeklySweep.enabled) {
      startContentBriefSweepLoop(config.social.contentBrief.weeklySweep.intervalMs);
      // eslint-disable-next-line no-console
      console.log(`social content-brief sweep (smm-content-brief-sweep) on: every ${config.social.contentBrief.weeklySweep.intervalMs}ms`);
    }
    // SCP-1c: the nightly recompute of every open cycle's ready_by (holiday changes). Dark by default; spends nothing.
    if (config.social.cycleReadyBy.enabled) {
      startCycleReadyByLoop(config.social.cycleReadyBy.intervalMs);
      // eslint-disable-next-line no-console
      console.log(`social cycle ready-by (social-cycle-ready-by) on: every ${config.social.cycleReadyBy.intervalMs}ms`);
    }
    if (config.social.triage.classifyEnabled) {
      startInboxTriageLoop(config.social.triage.classifyIntervalMs);
      // eslint-disable-next-line no-console
      console.log(`social inbox triage (smm-inbox-triage) on: every ${config.social.triage.classifyIntervalMs}ms`);
    }
    if (config.social.triage.slaGuard.guardEnabled) {
      startInboxSlaGuardLoop(config.social.triage.slaGuard.guardIntervalMs);
      // eslint-disable-next-line no-console
      console.log(`social inbox SLA guard (smm-inbox-sla-guard) on: every ${config.social.triage.slaGuard.guardIntervalMs}ms`);
    }
    if (config.social.inboxPull.pullEnabled) {
      startInboxPullLoop(config.social.inboxPull.pullIntervalMs);
      // eslint-disable-next-line no-console
      console.log(`social inbox pull (smm-inbox-pull) on: every ${config.social.inboxPull.pullIntervalMs}ms`);
    }
    if (config.social.metricsPull.enabled) {
      startMetricsPullLoop(config.social.metricsPull.intervalMs);
      // eslint-disable-next-line no-console
      console.log(`social metrics pull on: every ${config.social.metricsPull.intervalMs}ms`);
    }
    startConsumerLoop([
      "deliverable",
      "user",
      "automation_approval",
      "search_engagement",
      "search_audit",
      "search_property",
      "search_change_proposal",
      // SMM-14 — the stream SMM-13's handlers hang off. Without it they were registered against
      // socialModule.eventHandlers and NEVER INVOKED: dispatch.ts and post-status-sync-job.ts emit
      // with entity type "social_post_variant", and this list is the only thing that decides whether
      // a Redis stream is ever drained. event-handlers.test.ts stayed green throughout because it
      // calls the handlers directly -- the handlers were always fine; nothing reached them.
      "social_post_variant",
      // M5-P2 -- the stream `agency.lead.stage_changed` is emitted on (core/agency-lead-pipeline.service.ts, entity type
      // "agency_lead"). searchModule.eventHandlers["agency.lead.stage_changed"] plans ad-platform conversion uploads from it.
      // Without this entry that handler is registered and NEVER invoked (the SMM-14 trap above); conversions.test.ts pins it.
      "agency_lead",
      // PV4-04 — the stream `contract.signed` is emitted on (core/contracts.controller.ts countersign, portal-commerce.controller.ts sign).
      // registerAmendmentEventHandlers() hangs the "amendment signed: the request can start" notice off it.
      "contract",
      // PV5-07 — the stream `invoice.issued` is emitted on (modules/invoice/issue.ts). registerDocumentJobHandlers()
      // renders the invoice of record's PDF off it. Without this entry the handler would be registered and never invoked.
      "invoice",
      // PV5-10 — the stream the payment webhook's claim emits `payment.notice.received` on. Without this entry the
      // handler would be registered and never invoked (the retry sweep below would still process, a minute later).
      PROVIDER_EVENT_STREAM,
      // P2-05 — see registerPositionEventHandlers' header for why these are unconditional.
      ...POSITION_STREAMS,
    ]);
    // PV5-07: retries every document still owed (issued invoice without its PDF, signed contract without its sealed
    // copy) on the backoff clock in document_jobs. Always on: with no renderer or no key it only records why, once.
    startDocumentJobSweep(config.documents.sweepIntervalMs);
    // ORG-6 service-assignment reconciler (A7): outbox-driven, own consumer group. Only when the
    // release-train flag is on — dark by default so assignments stay dormant metadata.
    if (config.serviceAssignmentsEnabled) {
      startReconcileLoop();
      // eslint-disable-next-line no-console
      console.log("service-assignment reconciler on: streams [service_assignment, org_structure]");
    }
    // Event → n8n bridge (WS4 §4): only when fully configured (URL + secret + allow-lists).
    if (n8nBridgeEnabled()) {
      startN8nBridgeLoop(config.n8nBridge.entityTypes);
      // eslint-disable-next-line no-console
      console.log(`n8n bridge on: events [${config.n8nBridge.events.join(", ")}] over streams [${config.n8nBridge.entityTypes.join(", ")}]`);
    }
    // Event → knowledge-graph bridge (WS8 Step E): forward business events to the knowledge service.
    if (graphBridgeEnabled()) {
      startGraphBridgeLoop(config.graphBridge.entityTypes);
      // eslint-disable-next-line no-console
      console.log(`graph bridge on: streams [${config.graphBridge.entityTypes.join(", ")}] -> knowledge /graph/ingest`);
    }
    // WSUX-15 (ex-P1-05): work-activity outbox consumer, own dedicated group (own retry/dead-letter
    // accounting, independent of the module-dispatch and reconciler groups above) — makes the P1-04
    // department ActivityFeed LIVE off pm/meeting/pipeline events. One-shot backfill runs first (and
    // is itself idempotent, so it's safe to run on every boot) so restarts never re-skip history.
    //
    // ── NOT AWAITED, DELIBERATELY: THIS IS OFF THE BOOT CRITICAL PATH ──────────────────────────
    // This used to be `await`ed before app.listen(). On the live box the backfill took ~117s of a
    // ~129s boot, the container healthcheck allowed 110s, so compose declared platform unhealthy
    // 19s BEFORE it was ready and aborted `up -d` — leaving platform-ui, mcp-hub, knowledge,
    // report-renderer and agent-runner in the CREATED state and the site serving 502 (2026-08-24).
    // The healthcheck budget was raised too, but the real defect is that NOTHING answering a
    // request needs this: it replays history into the department ActivityFeed. /health now answers
    // immediately and the feed fills in behind it.
    //
    // Ordering is still backfill -> consumer, and that is load-bearing: the consumer advances the
    // stream position, so starting it first could carry it past history the backfill exists to
    // replay. On failure we retry with backoff instead of starting the consumer. That preserves
    // the old fail-closed intent — an unhandled throw here used to kill the process and let the
    // restart policy try again — WITHOUT taking the whole API down to retry a background job.
    void (async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await runWorkActivityBackfill();
          break;
        } catch (err) {
          // Capped backoff, retried indefinitely: this is exactly the old crash-restart loop, minus
          // the outage. Giving up instead would leave the feed permanently missing history with
          // nothing but one stale log line to say so.
          const waitMs = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
          // eslint-disable-next-line no-console
          console.error(`work-activity backfill failed (attempt ${attempt}), retrying in ${waitMs}ms`, err);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      startWorkActivityConsumerLoop();
      // eslint-disable-next-line no-console
      console.log("work-activity consumer on: streams [pm_task, pm_project, meeting_recording, pipeline_run]");
    })();
  }
  // PV5-10: the payment-notice retry sweep. OUTSIDE the redisUrl gate on purpose: it is a plain Postgres loop, and a
  // payment must still be recorded when Redis is off (the notice then waits for this sweep instead of the consumer).
  // Only while a provider is switched on.
  if (configuredProviders().length > 0) {
    startPaymentEventSweep(config.payments.sweepIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`[payments] notice retry sweep on: every ${config.payments.sweepIntervalMs}ms`);
  }
  // PV5-11: the signature-notice retry sweep and the envelope reconciliation. OUTSIDE the redisUrl gate (plain Postgres
  // plus the provider), so a signature is still recorded when Redis is off or a notice never arrives. Only while a
  // certified provider is set up.
  if (certifiedSigningAccount()) {
    startSignatureEventSweep(60_000);
    // eslint-disable-next-line no-console
    console.log("[signatures] notice retry sweep on: every 60000ms (open envelopes re-fetched every 5 minutes)");
  }
  // Knowledge (D9 RAG) corpus refresh: mirrors gaiada.com into the PUBLIC tier and every company's
  // ERP records into the INTERNAL tier, on an interval. Without this the vector store stays empty and
  // every knowledge.search returns nothing. OUTSIDE the redisUrl gate — it is a plain Postgres read
  // plus HTTP to the knowledge service, with no stream dependency.
  if (knowledgeIngestEnabled()) {
    startKnowledgeIngestLoop();
    // eslint-disable-next-line no-console
    console.log(
      `knowledge ingest on: every ${Math.round(config.knowledgeIngest.intervalMs / 60000)}m; public sites [${config.knowledgeIngest.publicSites.join(", ")}]`,
    );
  }
  // ORG-7 §3: nightly drift/orphan sweep. Deliberately OUTSIDE the redisUrl gate above — it's a
  // plain Postgres sweep (sweepDriftAndOrphans), not stream-driven — but still dark unless the
  // whole release-train flag is on.
  if (config.serviceAssignmentsEnabled) {
    startDriftSweepLoop(config.serviceDriftSweepIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`service-assignment drift sweep on: every ${config.serviceDriftSweepIntervalMs}ms`);
  }
  // P2-09 (IAM Phase 2): the position maintenance loop — the grant EXPIRY sweep plus P2-05's drift
  // sweep, which P2-05 built and deliberately left unstarted. Started unconditionally, unlike the
  // sweeps around it, because the expiry half is NOT position-scoped: P2-08's grant surface writes
  // `user_roles.expires_at` regardless of POSITION_SYNC_ENABLED, and `assemblePrincipal()` does not
  // filter on it — so gating this loop on the position flag would leave expired grants fully live in
  // exactly the configuration able to create them. The drift half self-gates (`sweepPositionDrift()`
  // returns zeroes when the flag is off), so nothing position-related runs early because of this.
  startPositionMaintenanceLoop(config.positionDriftSweepIntervalMs);
  // eslint-disable-next-line no-console
  console.log(
    `IAM grant-expiry + position-drift sweep on: every ${config.positionDriftSweepIntervalMs}ms ` +
      `(expiry always; drift only while POSITION_SYNC_ENABLED)`,
  );
  // P2-07: nightly burndown-snapshot pre-warmer — a plain Postgres sweep (no Redis dependency),
  // same as the drift sweep above. Dark unless PM_BURNDOWN_SNAPSHOT_ENABLED; the lazy
  // upsert-on-read in pm.controller.ts's getBurndown() is the correctness backstop regardless.
  if (config.pmBurndownSnapshotEnabled) {
    startBurndownSnapshotLoop(config.pmBurndownSnapshotIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`burndown snapshot job on: every ${config.pmBurndownSnapshotIntervalMs}ms`);
  }
  // IT-03: the device stale reaper. A plain Postgres sweep (no Redis dependency), same dark-by-default
  // pattern as the two above. It recomputes `status` from `last_seen_at` freshness, which is what makes
  // "offline" mean anything at all: before this, a device that silently vanished kept displaying
  // whatever status was last written, and a device registered through the UI sat at 'unknown' forever
  // because nothing ever called the heartbeat endpoint. Only touches discovery_source='unifi' rows —
  // hand-registered devices have no freshness signal to reason from and are left alone.
  if (config.itDiscovery.reaperEnabled) {
    startStaleReaperLoop(config.itDiscovery.reaperIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`IT device stale reaper on: every ${config.itDiscovery.reaperIntervalMs}ms`);
  }
  // SMM-36: the LinkedIn-driven engagement-inbox retention purge. A plain Postgres sweep (no Redis
  // dependency), same dark-by-default pattern as the sweeps above — but unlike the burndown/drift
  // sweeps this one is NOT a pure optimization: until it runs, LinkedIn comment text and commenter
  // profile fields accumulate past the 24h/48h ceiling LinkedIn's own Data Storage Requirements
  // impose (addendum §A4e), which is checked at their Standard Tier review. Off by default because
  // no LinkedIn client is connected yet (OQ-1/OQ-3 still gate that) — turning this on is a
  // deploy-time decision paired with turning LinkedIn on for real.
  // M5-G5: the agency-lead retention purge. A plain Postgres sweep (no Redis), dark by default like the
  // sweeps above (AGENCY_LEAD_RETENTION_PURGE_ENABLED=1). It HARD-DELETES unconverted leads, their AD-1
  // submissions, intake tokens and stage history N months (default 24) after the lead's last status change,
  // so turning it on goes with the addendum's sign-off (G2). Its env is read through its own parser, where
  // an empty value can never become a zero retention.
  {
    const leadRetention = leadRetentionConfig();
    if (leadRetention.enabled) {
      startLeadRetentionPurgeLoop(leadRetention);
      // eslint-disable-next-line no-console
      console.log(`agency lead retention purge on: ${leadRetention.months} months, every ${leadRetention.intervalMs}ms`);
    }
  }
  if (config.social.inboxRetention.purgeEnabled) {
    startInboxRetentionPurgeLoop(config.social.inboxRetention.purgeIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`social inbox retention purge on: every ${config.social.inboxRetention.purgeIntervalMs}ms`);
  }
  // SMM-10: `smm-post-status-sync`, the publish gate's safety poll. Same dark-by-default pattern as
  // the sweeps above — a fresh deployment with no publisher org provisioned has nothing in flight to
  // reconcile, so this is a deploy-time decision paired with provisioning the first org, not a
  // boot-time default. Cadence default 15 minutes (config.ts's own doc on why that is not tuned
  // tighter).
  if (config.social.reconcileEnabled) {
    startPostStatusSyncLoop(config.social.reconcileIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`social post-status reconcile (smm-post-status-sync) on: every ${config.social.reconcileIntervalMs}ms`);
  }
  // SM-54: the search pull scheduler. A plain Postgres sweep (no Redis dependency), so it sits outside
  // the redisUrl gate above alongside the drift sweep and the burndown job — but unlike those two this
  // one SPENDS VENDOR MONEY, so its flag is the hard gate rather than a performance opt-in. The
  // interval only controls how often due-ness is re-asked; the cadence that decides whether anything is
  // pulled is derived per engagement from `tool_scope`, never from this value.
  // MON-12c: the monitor runner. A plain Postgres sweep (no Redis), so it sits outside the redisUrl
  // gate like the search scheduler -- but unlike that one it does not spend money, it DIALS CLIENT
  // WEBSITES. That is why the flag is a hard gate rather than a perf opt-in: probing a third party
  // must be a decision someone made, never a consequence of booting. Nothing is probed until this is
  // switched on -- heartbeat monitors are the exception, because those are push and update on ingest.
  if (config.monitoring.runnerEnabled) {
    startMonitoringRunnerLoop(config.monitoring.runnerIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`monitoring runner on: re-asking due-ness every ${config.monitoring.runnerIntervalMs}ms`);
  }
  // M6-P3d: render the MON-01 probe-target file. Fail-soft and OFF until CLIENT_PROPERTY_TARGETS_PATH is set.
  if (config.clientTargets.path) {
    startClientTargetsLoop(config.clientTargets.path, config.clientTargets.intervalMs);
    // eslint-disable-next-line no-console
    console.log(`MON-01 probe-target file on: ${config.clientTargets.path} every ${config.clientTargets.intervalMs}ms`);
  } else {
    // eslint-disable-next-line no-console
    console.log("MON-01 probe-target file off: CLIENT_PROPERTY_TARGETS_PATH is unset");
  }
  // M6-P4c2: the provisioned-site reconcile. Nothing else advanced a site whose WebDesk codegen outlasted the
  // 5-minute poll, so its contract was never pinned and the delivery code stage never resumed. It finishes
  // work a company_admin already approved, through the manual route's own functions, so it has no off switch:
  // PROVISION_RECONCILE_INTERVAL_MS is the whole control (see provision-reconcile-loop.ts).
  startProvisionReconcileLoop(config.provision.reconcileIntervalMs);
  // eslint-disable-next-line no-console
  console.log(provisionReconcileStartLine());
  // M6-P6p: the ERP's own read-only DNS check closes a delivered domain's DNS task once its records point (domain-dns-task.service.ts).
  // It looks up only the domains of OPEN tasks, over the P6i resolver path; no DNS API, no credential.
  startSiteDnsTaskLoop(config.webdevDns.sweepIntervalMs);
  // eslint-disable-next-line no-console
  console.log(siteDnsTaskStartLine());
  // WSK-60: the build stamp poller. It reads only ledger rows that exist and GETs only the stamp URL each row recorded. M6-P6h:
  // targets now come from the registry too (and a production promote rides the same ledger), so the env JSON can no longer
  // be its gate. A build can only be dispatched by an approved WebDesk publish, rebuild or promote, every one of which needs
  // the WebDesk control channel, so "the env override names a target OR the control channel is configured" is the gate.
  // WSK-61 rides the same tick: a scheduled publish that went live is settled into a build first (scheduled-rebuilds.service.ts).
  if (rebuildTargets().length > 0 || config.webdeskControl.baseUrl !== "") {
    startSiteBuildsLoop(config.webdeskRebuild.pollIntervalMs, { beforeSweep: () => sweepScheduledRebuilds() });
    // eslint-disable-next-line no-console
    console.log(
      `webdesk build poller on: every ${config.webdeskRebuild.pollIntervalMs}ms; ${rebuildTargets().length} env override target(s), ` +
        "registry targets resolved per build",
    );
  }
  if (config.search.schedulerEnabled) {
    startSearchPullSchedulerLoop(config.search.schedulerIntervalMs);
    // eslint-disable-next-line no-console
    console.log(
      `search pull scheduler on: re-deriving due-ness every ${config.search.schedulerIntervalMs}ms ` +
        "(cadence, tool toggles and budget caps all come from each engagement's tool_scope; " +
        "ledger attribution requested_by=NULL correlationId=sched:<tool>)",
    );
  }
  // M5-V4: the daily content-decay job. Dark by default: ON only when SEARCH_DECAY_ENABLED is exactly "1"
  // (an empty compose default is OFF); startContentDecayLoop returns null without a timer or any call otherwise.
  if (startContentDecayLoop()) {
    // eslint-disable-next-line no-console
    console.log("search content-decay job on (SEARCH_DECAY_ENABLED=1): detects falling pages daily; Umami reads only.");
  }
  // M5-V3-e: consented visitor profiles (ingest from the collector, the withdrawal sweep, the 14-month purge). Dark by default:
  // ON only when SEARCH_VISITORS_ENABLED is exactly "1"; startVisitorJobs returns null without a timer, a query or a request otherwise.
  if (startVisitorJobs()) {
    // eslint-disable-next-line no-console
    console.log("search visitor jobs on (SEARCH_VISITORS_ENABLED=1): consent-gated ingest, the withdrawal sweep and the purge.");
  }
  // M5-P5a: the IndexNow / Bing URL-submission retry sweep. Dark by default: ON only when SEARCH_INDEXNOW_ENABLED is exactly "1"
  // (an empty compose default is OFF); startIndexNowRetryLoop returns null without a timer, a query or a request otherwise.
  if (startIndexNowRetryLoop()) {
    // eslint-disable-next-line no-console
    console.log("search IndexNow retry sweep on (SEARCH_INDEXNOW_ENABLED=1): re-sends failed or deferred URL submissions with backoff.");
  }
  // MAIL-04: dark by default (config.mail.enabled reads MAIL_ENABLED). When on, the loop still
  // resolves to the dev-log adapter per stream until real per-stream host/creds are configured
  // (provider.ts's resolveAdapter) — the flag alone never causes a network send.
  if (config.mail.enabled) {
    startMailSenderLoop(config.mail.senderIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`mail sender on: every ${config.mail.senderIntervalMs}ms (MAIL_ENABLED=1)`);
  }
  // GH-06 (docs/blueprints/github-integration-foundation.md §5.3): the org crawl + periodic
  // reconcile sweep that populates `github_repos`. A plain call through the existing GH-01/GH-02
  // GitHub chokepoint (core/github/github-app.service.ts) — no Redis dependency, same
  // dark-by-default pattern as the sweeps above. Gated on BOTH the flag AND a configured tenant id
  // (config.githubRepoSync): unlike the sweeps above there is no sensible "on but misconfigured"
  // state here — starting it without a tenant id would mean guessing which company owns the org,
  // which §5.2's GAP-CLOSED ruling explicitly forbids this layer from doing.
  if (config.githubRepoSync.enabled && config.githubRepoSync.tenantId) {
    startGithubRepoSyncLoop(config.githubRepoSync.tenantId, config.githubRepoSync.intervalMs);
    // eslint-disable-next-line no-console
    console.log(
      `github repo sync (GH-06) on: every ${config.githubRepoSync.intervalMs}ms, tenant=${config.githubRepoSync.tenantId}`,
    );
  } else if (config.githubRepoSync.enabled) {
    // eslint-disable-next-line no-console
    console.warn("GITHUB_REPO_SYNC_ENABLED=true but GITHUB_REPO_SYNC_TENANT_ID is unset — sweep NOT started");
  }
  const app = await buildApp();
  // eslint-disable-next-line no-console
  for (const line of describeUploadRoutes()) console.log(`[upload-body-limits] ${line}`);
  const port = Number(process.env.PLATFORM_PORT ?? 3004);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`Gaiada Platform (NestJS) on ${host}:${port}`);
}

if (require.main === module) void bootstrap();
