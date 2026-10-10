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
