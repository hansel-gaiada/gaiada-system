import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { TenantsModule } from "./tenants/tenants.module";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuthModule } from "./auth/auth.module";
import { ContentModule } from "./content/content.module";

@Module({
  imports: [DbModule, RateLimitModule, TenantsModule, AuditModule, ApiKeysModule, AuthModule, ContentModule],
})
export class AppModule {}
