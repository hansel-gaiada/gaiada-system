import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { TenantsModule } from "./tenants/tenants.module";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuthModule } from "./auth/auth.module";
import { ContentModule } from "./content/content.module";
// WSK-07 (wired by coordinator; the ticket reported this rather than editing a shared file).
// MediaModule pulls StorageModule in with it.
import { MediaModule } from "./media/media.module";
// WSK-11 (wired by coordinator; the ticket reported this rather than editing a shared file).
import { MailModule } from "./mail/mail.module";
// WSK-10 (wired by coordinator; the ticket reported this rather than editing a shared file).
import { FormsModule } from "./forms/forms.module";

@Module({
  imports: [DbModule, RateLimitModule, TenantsModule, AuditModule, ApiKeysModule, AuthModule, ContentModule, MediaModule, MailModule, FormsModule],
})
export class AppModule {}
