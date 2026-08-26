import { Module } from "@nestjs/common";
import { ApiKeyAuthGuard } from "./api-key-auth.guard";
import { ScopeGuard } from "./scope.guard";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenantsModule } from "../tenants/tenants.module";

@Module({
  imports: [ApiKeysModule, TenantsModule],
  providers: [ApiKeyAuthGuard, ScopeGuard],
  exports: [ApiKeyAuthGuard, ScopeGuard],
})
export class AuthModule {}
