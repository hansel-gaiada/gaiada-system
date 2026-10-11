// M5-G6 test bootstrap: the consent endpoint plus the forms submit route (a submission carries the consent id),
// on the same infrastructure as every forms-*.spec.ts (Postgres, Redis, Mailpit, RustFS, ClamAV; see
// forms-test-app.ts, whose env defaults this file inherits by importing it first). Not matched by vitest's
// `test/**/*.spec.ts` include.
import "./forms-test-app"; // env bootstrap (database, redis, mail, storage) before any module loads
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { DbModule } from "../src/db/db.module";
import { StorageModule } from "../src/storage/storage.module";
import { FormsModule } from "../src/forms/forms.module";
import { ConsentModule } from "../src/consent/consent.module";

export async function buildConsentTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [DbModule, StorageModule, FormsModule, ConsentModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"], abortOnError: false });
  await app.init();
  return app;
}

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55460/webdesk";
const APP_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55460/webdesk";

async function inTenant<T>(url: string, tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/** Runs as webdesk_migrator (the table owner) under the tenant's context: for seeding / backdating / reading back. */
export const asMigrator = <T>(tenantId: string, fn: (c: Client) => Promise<T>) => inTenant(MIGRATOR_URL, tenantId, fn);
/** Runs as webdesk_app, the RUNTIME role, under the tenant's context: for the claims about what the app may do. */
export const asApp = <T>(tenantId: string, fn: (c: Client) => Promise<T>) => inTenant(APP_URL, tenantId, fn);

export type ConsentRow = {
  id: string;
  consent_id: string;
  site_id: string;
  analytics: boolean;
  marketing: boolean;
  notice_version: string;
  action: string;
  recorded_at: string;
  user_agent_class: string;
};

export const readConsent = (tenantId: string, consentId: string) =>
  asMigrator(tenantId, async (c) =>
    (await c.query<ConsentRow>(`SELECT * FROM consent_records WHERE consent_id = $1::uuid ORDER BY recorded_at, id`, [consentId])).rows,
  );
