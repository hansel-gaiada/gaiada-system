import { Module } from "@nestjs/common";
import { MediaService } from "./media.service";
import { MediaController } from "./media.controller";
import { ClamAvService } from "./clamav.service";
import { QuotaService } from "./quota.service";
import { ImgproxyService } from "./imgproxy.service";
import { PublicTenantGuard } from "./public-tenant.guard";
import { AuthModule } from "../auth/auth.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";

// Same "import it here too, not just via AuthModule" reasoning as content.module.ts (WSK-05):
// @UseGuards on MediaController resolves each guard's OWN constructor deps against providers
// visible to the CONTROLLER'S module. StorageModule is @Global() (storage.module.ts) so it does
// not strictly need re-importing, but is listed anyway for readability.
@Module({
  imports: [AuthModule, ApiKeysModule, TenantsModule, AuditModule, StorageModule],
  providers: [MediaService, ClamAvService, QuotaService, ImgproxyService, PublicTenantGuard],
  controllers: [MediaController],
  exports: [MediaService],
})
export class MediaModule {}
