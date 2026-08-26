import { Global, Module } from "@nestjs/common";
import { TenantQuotaService } from "./tenant-quota.service";
import { TenantQuotaGuard } from "./tenant-quota.guard";

@Global()
@Module({
  providers: [TenantQuotaService, TenantQuotaGuard],
  exports: [TenantQuotaService, TenantQuotaGuard],
})
export class RateLimitModule {}
