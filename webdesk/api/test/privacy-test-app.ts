// WSK-38 test bootstrap. Same shape and reason as test/forms-test-app.ts / test/media-test-app.ts:
// `app.module.ts` does not import PrivacyModule (out of this ticket's owned scope — see
// ../README.md's "WSK-38" section for the exact required import line). Standalone Nest testing
// module so this suite exercises the real PrivacyModule end-to-end without touching the shared
// root module.
//
// Env defaults set BELOW the same reason every prior ticket's own test-app file gives (ESM import
// hoisting — see ../src/config.ts's header). Port block 55530-55531 — checked free via `docker ps`
// first (2026-08-27): not 55432/55433/55435, not the 55450 WSK-05 / 55460-55466 WSK-10 /
// 55480-55481 WSK-11 / 55490 WSK-21/22 / 55500-55502 WSK-15 / 55510-55511 WSK-37 blocks, and NOT
// 55520 (wsk17-postgres, a concurrent session's own throwaway container observed still running).
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55530/webdesk";
process.env.MIGRATE_DATABASE_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55530/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "wsk38-test-pepper-never-used-outside-this-suite";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55531";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_minio";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_minio_password";
process.env.MINIO_BUCKET_UPLOADS = process.env.MINIO_BUCKET_UPLOADS || "uploads";

import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DbModule } from "../src/db/db.module";
import { StorageModule } from "../src/storage/storage.module";
import { PrivacyModule } from "../src/privacy/privacy.module";

export async function buildPrivacyTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DbModule, StorageModule, PrivacyModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: ["error"],
    abortOnError: false,
  });
  await app.init();
  return app;
}

export async function stopPrivacyTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}

export function privacyHeaders(opts: { scopes: string[]; ws4?: string; idempotencyKey?: string; subject?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": opts.subject ?? "wsk38-privacy-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  if (opts.idempotencyKey) h["idempotency-key"] = opts.idempotencyKey;
  return h;
}
