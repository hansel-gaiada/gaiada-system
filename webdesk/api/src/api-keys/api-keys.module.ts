import { Module } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";
import { ApiKeysController } from "./api-keys.controller";
import { AuditModule } from "../audit/audit.module";
import { TenantsModule } from "../tenants/tenants.module";

@Module({
  imports: [AuditModule, TenantsModule],
  providers: [ApiKeysService],
  controllers: [ApiKeysController],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
