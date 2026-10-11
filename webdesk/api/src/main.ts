import { initTelemetry } from "./telemetry";

async function bootstrap() {
  // M4: OpenTelemetry must be running BEFORE the modules it instruments (node:http, fastify, pg, ioredis)
  // are first required, so nothing app-side is imported at the top of this file: tsc's commonjs output
  // would hoist those requires above this call. Telemetry is off unless OTEL_ENABLED and
  // WEBDESK_OTEL_ZONEA_PUSH_ENABLED are both true and an endpoint is set (src/telemetry/gate.ts); it never
  // throws, so a telemetry fault cannot stop the api booting.
  await initTelemetry();
  const { buildApp, enableGracefulShutdown } = await import("./app");
  const { config } = await import("./config");
  const app = await buildApp();
  // SIGTERM/SIGINT now drain (scheduler tick finishes its item, pool ends last) instead of killing the process.
  // The same hooks flush queued spans (TelemetryModule) once the server has closed.
  enableGracefulShutdown(app);
  await app.listen(config.port, "0.0.0.0");
  // eslint-disable-next-line no-console
  console.log(`[webdesk:api] listening on :${config.port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[webdesk:api] fatal boot error:", err);
  process.exit(1);
});
