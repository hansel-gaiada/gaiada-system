// WSK-37 test bootstrap — a SEPARATE, minimal Nest application, importing only DbModule (Global)
// + TenantWebhooksModule + TenantsModule. Same reasoning as test/helpers/mail-app.ts's own header:
// TenantWebhooksModule is NOT registered in the real AppModule (app.module.ts is out of this
// ticket's owned paths), so every tenant-webhooks-*.spec.ts file boots THIS app, not
// src/app.ts's buildApp(), and cannot be broken by whether/when TenantWebhooksModule lands in the
// shared AppModule.
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.APP_DATABASE_URL =
  process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55510/webdesk";
process.env.TENANT_WEBHOOK_SECRET_PEPPER =
  process.env.TENANT_WEBHOOK_SECRET_PEPPER || "wsk37-test-pepper-never-used-outside-this-suite";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:55511";

import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DbModule } from "../src/db/db.module";
import { TenantWebhooksModule } from "../src/tenant-webhooks/tenant-webhooks.module";

@Module({ imports: [DbModule, TenantWebhooksModule] })
class TenantWebhooksTestAppModule {}

export async function startTenantWebhooksTestApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(TenantWebhooksTestAppModule, new FastifyAdapter(), {
    logger: ["error"],
    abortOnError: false,
  });
  await app.init();
  return app;
}

export async function stopTenantWebhooksTestApp(app: NestFastifyApplication): Promise<void> {
  await app.close();
}
