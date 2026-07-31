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
import { config, n8nBridgeEnabled, graphBridgeEnabled } from "./config";
import { HttpErrorFilter } from "./http-error.filter";
import { ProviderDispatchErrorFilter } from "./modules/search/provider-dispatch-error.filter";
import { GatewayNotConfiguredErrorFilter } from "./modules/search/gateway-not-configured-error.filter";
// SM-25a: the Google-surface error family (modules/search/google/errors.ts). Registered here for
// exactly the reason SM-53/SM-57 had to be — an unmapped plain Error escapes as a body-less 500.
import { GoogleOAuthErrorFilter } from "./modules/search/google/google-oauth-error.filter";
import { LastResortExceptionFilter } from "./last-resort-exception.filter";
import { migrate } from "./db/migrate";
import { getPool } from "./db";
import { seedClockFromDb } from "./events/hlc";
import { registerModule } from "./modules/registry";
import { agencyModule } from "./modules/agency";
import { pmModule } from "./modules/pm";
import { itModule } from "./modules/it";
import { billingModule } from "./modules/billing";
import { clientsModule } from "./modules/clients";
import { knowledgeModule } from "./modules/knowledge";
import { automationConsoleModule } from "./modules/automation-console";
import { hrModule } from "./modules/hr";
import { searchModule } from "./modules/search";
import { reportsModule } from "./modules/reports";
import { createDataForSeoProviderFromConfig } from "./modules/search/providers/dataforseo";
import { createSemrushProviderFromConfig } from "./modules/search/providers/semrush";
import { createAhrefsProviderFromConfig } from "./modules/search/providers/ahrefs";
import { registerLiveAdsExecutor } from "./modules/search/sem-apply";
import {
  assertAdsWriteModeBootSafe, googleAdsLiveExecutor, resolveSearchAdsWriteMode,
} from "./modules/search/sem-executor-google-ads";
// SM-33's simulation tier (tracker §6), owned and landed by a concurrent agent this same wave —
// SM-34 owns registering it here, not building it. isSimulatedProvider is the structural provenance
// check (design addendum §A4.3) used below to make mode/driver mutual exclusion a BOOT ERROR.
import { createSimulationProviders, isSimulatedProvider } from "./modules/search/providers/simulation";
import { registerProvider } from "./modules/search/providers/registry";
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
import { startConsumerLoop } from "./events/consumer.service";
import { startReconcileLoop, startDriftSweepLoop } from "./events/reconcile-consumer";
import { startN8nBridgeLoop } from "./events/n8n-bridge";
import { startGraphBridgeLoop } from "./events/graph-bridge";
import { startWorkActivityConsumerLoop } from "./events/work-activity-consumer";
import { runWorkActivityBackfill } from "./core/work-activity-backfill";
import { startBurndownSnapshotLoop } from "./modules/pm/burndown-job";
// SM-54 (tracker §6ad Ruling 1 / addendum §A13.2) — the search department's cadence loop lives in the
// platform, NOT in n8n: it executes configuration a verified human already set (each engagement's
// `tool_scope` toggle + cadence + budget cap, written under `search:scope:write`), and every automation
// principal is minted `assurance: "low"` by construction, so giving n8n a path to vendor spend would
// have meant weakening two controls on the money path. Dark by default — see the config comment.
import { startSearchPullSchedulerLoop } from "./modules/search/pull-scheduler";

export async function buildApp(): Promise<NestFastifyApplication> {
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
  );
  // WD-04: the one multipart consumer in the app (in-ERP meeting-audio upload). The size cap
  // is enforced HERE (busboy truncates + MeetingRecordingsController turns that into a clean 400)
  // as well as re-checked in the handler — belt and suspenders, matching files.controller.ts's
  // own explicit MAX_BYTES check on its base64 path.
  await app.register(multipart, { limits: { fileSize: config.meetingAudio.maxBytes, files: 1 } });
  await app.init();
  return app;
}

async function bootstrap(): Promise<void> {
  // Same startup sequence the Fastify server ran: migrate, register compiled-in modules +
  // core rollup providers, sync the governed metric registry, then serve.
  await migrate();
  // Seed the HLC from the greatest clock this origin_site has already committed, so a restart
  // never mints an HLC that regresses (sync-engine-revision §2, D3 #4).
  await seedClockFromDb(getPool());
  registerModule(agencyModule);
  registerModule(pmModule);
  registerModule(itModule);
  registerModule(billingModule);
  registerModule(clientsModule);
  registerModule(knowledgeModule);
  registerModule(automationConsoleModule);
  registerModule(hrModule);
  registerModule(searchModule);
  registerModule(reportsModule);
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
          `SEARCH_PROVIDER_MODE=${config.search.providerMode} — mode/driver mutual exclusion violated ` +
          "(design addendum §A4.3: this must abort startup, not degrade to a warning)",
      );
    }
  };

  if (config.search.providerMode === "simulate") {
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

    // ── SM-26 / addendum §A12.6: the Ads WRITE mode, deliberately separate from the DATA vendor mode ──
    // Registered unconditionally: registration only makes a live executor AVAILABLE, it does not make
    // it reachable. `resolveAdsExecutor(resolveSearchAdsWriteMode())` decides that per request, and in
    // `simulate` it always returns the simulator even when a live executor exists (SM-21's rule: a
    // control that cannot do the thing must not report that it did).
    //
    // The boot assertion is the counterpart: `SEARCH_ADS_WRITE_MODE=live` with no live executor is an
    // unfinished deployment, and refusing at boot is the only place it can be refused honestly — a
    // runtime refusal would surface as a failed client ad change after an approval had already been
    // spent (§A4.3/§A10.4: mode/driver mutual exclusion is a boot error, not a warning).
    registerLiveAdsExecutor(googleAdsLiveExecutor);
    assertAdsWriteModeBootSafe(resolveSearchAdsWriteMode(), true);
    // eslint-disable-next-line no-console
    console.log(`[search] Ads write mode: ${resolveSearchAdsWriteMode()} (SEARCH_ADS_WRITE_MODE)`);
  }
  registerCoreRollupProvider(coreTaskRollups);
  registerCoreRollupProvider(clientWorkRollups);
  await syncMetricDefinitions();
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
    startConsumerLoop(["deliverable", "user", "automation_approval", "search_engagement", "search_audit", "search_property", "search_change_proposal"]);
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
    await runWorkActivityBackfill();
    startWorkActivityConsumerLoop();
    // eslint-disable-next-line no-console
    console.log("work-activity consumer on: streams [pm_task, pm_project, meeting_recording, pipeline_run]");
  }
  // ORG-7 §3: nightly drift/orphan sweep. Deliberately OUTSIDE the redisUrl gate above — it's a
  // plain Postgres sweep (sweepDriftAndOrphans), not stream-driven — but still dark unless the
  // whole release-train flag is on.
  if (config.serviceAssignmentsEnabled) {
    startDriftSweepLoop(config.serviceDriftSweepIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`service-assignment drift sweep on: every ${config.serviceDriftSweepIntervalMs}ms`);
  }
  // P2-07: nightly burndown-snapshot pre-warmer — a plain Postgres sweep (no Redis dependency),
  // same as the drift sweep above. Dark unless PM_BURNDOWN_SNAPSHOT_ENABLED; the lazy
  // upsert-on-read in pm.controller.ts's getBurndown() is the correctness backstop regardless.
  if (config.pmBurndownSnapshotEnabled) {
    startBurndownSnapshotLoop(config.pmBurndownSnapshotIntervalMs);
    // eslint-disable-next-line no-console
    console.log(`burndown snapshot job on: every ${config.pmBurndownSnapshotIntervalMs}ms`);
  }
  // SM-54: the search pull scheduler. A plain Postgres sweep (no Redis dependency), so it sits outside
  // the redisUrl gate above alongside the drift sweep and the burndown job — but unlike those two this
  // one SPENDS VENDOR MONEY, so its flag is the hard gate rather than a performance opt-in. The
  // interval only controls how often due-ness is re-asked; the cadence that decides whether anything is
  // pulled is derived per engagement from `tool_scope`, never from this value.
  if (config.search.schedulerEnabled) {
    startSearchPullSchedulerLoop(config.search.schedulerIntervalMs);
    // eslint-disable-next-line no-console
    console.log(
      `search pull scheduler on: re-deriving due-ness every ${config.search.schedulerIntervalMs}ms ` +
        "(cadence, tool toggles and budget caps all come from each engagement's tool_scope; " +
        "ledger attribution requested_by=NULL correlationId=sched:<tool>)",
    );
  }
  const app = await buildApp();
  const port = Number(process.env.PLATFORM_PORT ?? 3004);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`Gaiada Platform (NestJS) on ${host}:${port}`);
}

if (require.main === module) void bootstrap();
