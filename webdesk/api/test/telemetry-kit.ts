// M4 telemetry — shared helpers for test/telemetry-*.spec.ts (a plain module: vitest only collects *.spec.ts).
//
// THE APP. A real Nest-on-Fastify app built with the api's own `createFastifyAdapter()`, carrying:
//   - the REAL DeliveryGateway (the raw `/v1/*` route that serves `/v1/t/<slug>/preview/<token>` through the
//     real createV1Handler). Its three collaborators are stubs that know no tenant, so the preview route
//     answers its normal single 404 with no database (which is also what a guessed token gets in production);
//   - a stub controller at the real media route shapes (`POST|OPTIONS /v1/t/:tenantSlug/media/upload/:token`),
//     answering the same bare 404 an invalid upload token gets. The real MediaController needs Postgres and
//     RustFS; the span content depends on the URL and the HTTP/Fastify layers, which are real here.
//   - the control-plane routes are not needed: their path segments are ids, not credentials.
//
// ORDER MATTERS. The instrumentations patch node:http and fastify when those are first REQUIRED, so a spec
// must start the SDK first and import this kit (and therefore Nest/Fastify) afterwards, via `await import()`.
import "reflect-metadata";
import { Controller, HttpCode, NotFoundException, Options, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createFastifyAdapter } from "../src/app";
import { DeliveryAuthService } from "../src/delivery/delivery-auth.service";
import { DeliveryGateway } from "../src/delivery/delivery.gateway";
import { DbService } from "../src/db/db.service";
import { TenantQuotaService } from "../src/rate-limit/tenant-quota.service";

@Controller("v1/t/:tenantSlug/media")
class StubMediaUploadController {
  @Options("upload/:token")
  @HttpCode(204)
  preflight(): void {
    throw new NotFoundException();
  }

  @Post("upload/:token")
  upload(): never {
    throw new NotFoundException();
  }
}

export async function buildTelemetryApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [StubMediaUploadController],
    providers: [
      DeliveryGateway,
      { provide: DbService, useValue: {} },
      { provide: DeliveryAuthService, useValue: { resolveTenantBySlug: async () => null, resolveApiKey: async () => null } },
      { provide: TenantQuotaService, useValue: { consume: async () => ({ allowed: true, limit: 1, remaining: 1, resetAt: Date.now() + 1000 }) } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false, abortOnError: false });
  await app.init();
  await app.listen(0, "127.0.0.1");
  return app;
}
