// NestJS bootstrap (P5c port). Keeps the FASTIFY adapter deliberately — it preserves the
// perf profile AND `app.inject(...)`, so the existing platform test suite can run against the
// Nest app unchanged as the contract-parity oracle. buildApp() is the buildServer() analogue.
import "reflect-metadata";
// WS9: start OpenTelemetry BEFORE any module that touches http/pg/ioredis, so auto-instrumentation
// patches them. No-op unless OTEL_ENABLED. Must stay above the AppModule import.
import { fastifyLoggerOption } from "./telemetry";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { config, n8nBridgeEnabled, graphBridgeEnabled } from "./config";
import { HttpErrorFilter } from "./http-error.filter";
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
  app.useGlobalFilters(new HttpErrorFilter());
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
  registerCoreRollupProvider(coreTaskRollups);
  registerCoreRollupProvider(clientWorkRollups);
  await syncMetricDefinitions();
  if (config.redisUrl) {
    startRelayLoop();
    // Entity types with at least one registered handler; extend as modules add eventHandlers.
    // WSD-4 adds "user" (hr's user.invited -> onboarding auto-instantiation) and
    // "automation_approval" (hr's automation_approval.decided -> leave decision + balance + notify).
    startConsumerLoop(["deliverable", "user", "automation_approval"]);
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
  const app = await buildApp();
  const port = Number(process.env.PLATFORM_PORT ?? 3004);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`Gaiada Platform (NestJS) on ${host}:${port}`);
}

if (require.main === module) void bootstrap();
