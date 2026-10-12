// M5-G6 — the consent log. Registered in app.module.ts. FormRateLimitService is provided here too (a stateless
// Redis counter with its own connection) instead of importing FormsModule, for the same shutdown-ordering reason
// scheduler.module.ts documents for its own copies of forms services. Imports TenantsModule explicitly (Nest
// resolves a class's dependencies against providers visible to THIS module).
import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module";
import { FormRateLimitService } from "../forms/form-rate-limit.service";
import { ConsentController } from "./consent.controller";
import { ConsentContextGuard } from "./consent-context.guard";
import { ConsentRateLimitGuard } from "./consent-rate-limit.guard";
import { ConsentRepository } from "./consent.repository";
import { ConsentPurgeService } from "./consent-purge.service";

@Module({
  imports: [TenantsModule],
  controllers: [ConsentController],
  providers: [ConsentContextGuard, ConsentRateLimitGuard, ConsentRepository, ConsentPurgeService, FormRateLimitService],
  exports: [ConsentPurgeService],
})
export class ConsentModule {}
