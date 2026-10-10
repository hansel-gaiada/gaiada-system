// WSK-05 — testable seam (platform-nest's own `buildApp()`/`bootstrap()` split, mirrored here on
// purpose): building the Nest+Fastify app is separate from making it listen, so tests can use
// Fastify's `app.inject(...)` against a fully wired app with no open socket.
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { frameworkErrorsHandler } from "./delivery/framework-errors";

/**
 * The api's one FastifyAdapter. `frameworkErrors` makes Fastify's pre-routing failures (an
 * undecodable `%` in the path) answer in the /v1 problem+json shape (M3 T1). Anything that builds
 * the full app uses this, so no bootstrap can silently fall back to Fastify's default 400 body.
 */
export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({ frameworkErrors: frameworkErrorsHandler });
}

/**
 * Graceful shutdown (M3 T8). Without shutdown hooks a SIGTERM (what `docker stop` and a deploy send) kills
 * the process on the spot, mid-item if the scheduler is running a tick. With them, Nest runs the same
 * sequence as `app.close()`: every module's onModuleDestroy, deepest module first. DbService sits at the
 * bottom and ends the pool, so anything that still queries must be finished BEFORE that; the scheduler
 * registers its worker's close with `DbService.onBeforeEnd`, which DbService runs, awaited, ahead of
 * `pool.end()` whatever the order of the modules above it. Only the signals a supervisor sends are
 * handled; the process then re-raises the signal and exits as it would have. (Nest 10 closes the HTTP
 * server AFTER the destroy hooks, so a request that arrives during the drain meets a closing app.) main.ts calls this; tests
 * that build the app with buildApp() do not (they close it themselves), which keeps signal handlers
 * from piling up across specs.
 */
export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export function enableGracefulShutdown<T extends Pick<NestFastifyApplication, "enableShutdownHooks">>(app: T): T {
  app.enableShutdownHooks([...SHUTDOWN_SIGNALS]);
  return app;
}

export async function buildApp(adapter: FastifyAdapter = createFastifyAdapter()): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // "error" stays on even in test mode — a fully silenced logger is what let a bootstrap
    // failure exit the process with zero output while chasing this ticket's own test setup
    // (see abortOnError below); a real runtime 500 deserves the same visibility.
    logger: process.env.NODE_ENV === "test" ? ["error"] : ["error", "warn", "log"],
    // Without this, a DI/bootstrap error calls process.exit(1) directly inside Nest's own
    // handler — with `logger: false` in test mode that means a silent kill with NO error message
    // printed anywhere, which is exactly the trap that cost real time diagnosing this ticket's
    // own test setup. Throwing instead lets every caller (tests included) see and report the
    // real underlying error.
    abortOnError: false,
  });
  await app.init();
  return app;
}
