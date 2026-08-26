// WSK-10 test bootstrap. Not matched by vitest's `test/**/*.spec.ts` include (vitest.config.ts) —
// a plain helper module, same shape and same reason as test/media-test-app.ts: `app.module.ts`
// does NOT import FormsModule yet (out of this ticket's owned scope — see forms.module.ts's own
// header for the exact import line the app.module.ts owner needs to add). Every forms-*.spec.ts
// file boots THIS app, not src/app.ts's buildApp(), so these tests do not depend on — and cannot
// be broken by — whether/when FormsModule lands in the shared AppModule.
//
// Env defaults set BELOW, before the imports that transitively read them (../src/config.ts's own
// header explains why: ESM import hoisting evaluates the whole transitive graph before this file's
// own top-level statements run, so a later assignment loses the race) — same pattern
// test/helpers/app.ts (WSK-05) and test/helpers/mail-app.ts (WSK-11) each already use. This
// ticket's own throwaway container ports (README.md's forms runbook) are a NEW block —
// 55460-55466 — deliberately not 55450-3 (WSK-11's own range) or 55432/55435/56380 (other
// concurrent sessions' spike/test containers), so this suite never collides with a stack another
// session might bring up at the same time.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55460/webdesk";
process.env.MIGRATE_DATABASE_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55460/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "wsk10-test-pepper-never-used-outside-this-suite";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55461";
process.env.MAIL_ENABLED = process.env.MAIL_ENABLED || "true";
process.env.MAIL_PROVIDER = process.env.MAIL_PROVIDER || "smtp";
process.env.MAIL_SMTP_HOST = process.env.MAIL_SMTP_HOST || "localhost";
process.env.MAIL_SMTP_PORT = process.env.MAIL_SMTP_PORT || "55462";
process.env.MAIL_FROM_ADDRESS = process.env.MAIL_FROM_ADDRESS || "no-reply@forms.gaiada.invalid";
process.env.MAIL_QUEUE_NAME = process.env.MAIL_QUEUE_NAME || "wsk10-forms-mail-test";
process.env.MAIL_QUEUE_MAX_ATTEMPTS = process.env.MAIL_QUEUE_MAX_ATTEMPTS || "2";
process.env.MAIL_QUEUE_BACKOFF_DELAY_MS = process.env.MAIL_QUEUE_BACKOFF_DELAY_MS || "200";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55464";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_minio";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_minio_password";
process.env.MINIO_BUCKET_UPLOADS = process.env.MINIO_BUCKET_UPLOADS || "uploads";
process.env.CLAMAV_HOST = process.env.CLAMAV_HOST || "localhost";
process.env.CLAMAV_PORT = process.env.CLAMAV_PORT || "55466";
// Deliberately generous defaults for the abuse-battery's own rate-limit specs to override per-file
// via a fresh Nest app (never a shared process-wide mutation) — see forms-abuse-battery.spec.ts.
process.env.WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW = process.env.WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW || "1000";
process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW = process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW || "1000";

import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DbModule } from "../src/db/db.module";
import { StorageModule } from "../src/storage/storage.module";
import { FormsModule } from "../src/forms/forms.module";

export async function buildFormsTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [DbModule, StorageModule, FormsModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: ["error"],
    abortOnError: false,
  });
  await app.init();
  return app;
}

export async function stopFormsTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}
