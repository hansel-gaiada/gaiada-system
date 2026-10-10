// WSK-48a — the public /v1 content-read path, rehomed from the Payload Next.js app into the api
// (owner ruling WSK-D37: Payload is removed; design OQ-3.5's default). Serves
//   GET /v1/t/:tenantSlug/{:collection | :collection/:slug | search | sitemap.xml}
// with the frozen envelope (design §05) — see delivery.gateway.ts for the adapter, router.ts for the
// handler, and README.md's "Delivery (WSK-48a)" section for how it is verified.
//
// DbModule and RateLimitModule are @Global (DbService, TenantQuotaService); ApiKeysModule exports
// ApiKeysService (the one key-resolution implementation).
import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { DeliveryAuthService } from "./delivery-auth.service";
import { DeliveryGateway } from "./delivery.gateway";

@Module({
  imports: [ApiKeysModule],
  providers: [DeliveryAuthService, DeliveryGateway],
})
export class DeliveryModule {}
