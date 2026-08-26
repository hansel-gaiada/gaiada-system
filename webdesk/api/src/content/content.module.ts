import { Module } from "@nestjs/common";
import { ContentService } from "./content.service";
import { ContentController } from "./content.controller";
import { AuthModule } from "../auth/auth.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenantsModule } from "../tenants/tenants.module";

// Importing ApiKeysModule/TenantsModule here too (not just AuthModule, which already imports
// both) is deliberate, not redundant: `@UseGuards(ApiKeyAuthGuard)` on ContentController passes
// a bare class reference, and Nest resolves that guard's OWN constructor dependencies
// (ApiKeysService, TenantLookupService) against providers visible to the CONTROLLER'S module —
// which is this module, not AuthModule. Nest modules dedupe safely, so importing the same module
// twice (once via AuthModule, once here) is not a bug; omitting it here is — it produced exactly
// this failure mode once (see the ticket's boot-failure notes): a clean-looking module graph that
// still throws "Nest can't resolve dependencies of ApiKeyAuthGuard ... in ContentModule context"
// at boot.
@Module({
  imports: [AuthModule, ApiKeysModule, TenantsModule],
  providers: [ContentService],
  controllers: [ContentController],
})
export class ContentModule {}
