import { Module } from "@nestjs/common";
import { TenantLookupService } from "./tenant-lookup.service";

@Module({
  providers: [TenantLookupService],
  exports: [TenantLookupService],
})
export class TenantsModule {}
