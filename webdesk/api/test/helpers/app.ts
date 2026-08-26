// WSK-05 test bootstrap. Points the app at the throwaway Postgres the ticket's verification
// runbook stands up (see webdesk/api/README.md) — port 55450 by default, overridable via
// WSK05_TEST_DATABASE_URL so this suite is not hardwired to one port forever.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK05_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";
process.env.API_KEY_PEPPER = "wsk05-test-pepper-never-used-outside-this-suite";
// Deliberately generous default so ordinary functional tests never trip the quota by accident;
// tenant-quota.spec.ts overrides it per-test via `app.get(TenantQuotaService).withLimits(...)`
// instead of an env var, so it cannot race with any other spec file's expectations.
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { buildApp } from "../../src/app";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

export async function startTestApp(): Promise<NestFastifyApplication> {
  return buildApp();
}

export async function stopTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}
