// WSK-10 — wires the forms subsystem together.
//
// NOT registered in AppModule — app.module.ts is out of this ticket's owned paths (WSK-05/07/11's
// own precedent: report the exact line, do not add it). Required change, to be applied by whoever
// owns that file:
//
//   import { FormsModule } from "./forms/forms.module";
//   @Module({ imports: [..., FormsModule] })
//
// Re-importing TenantsModule/AuditModule/MediaModule/MailModule here (not just relying on them
// being providers elsewhere) is deliberate, not redundant — same reasoning content.module.ts's own
// header comment gives: `@UseGuards`/constructor injection resolves a class's OWN dependencies
// against providers visible to THIS module, not transitively through some other module that
// happens to import the same thing.
import { Module } from "@nestjs/common";
import { FormsController } from "./forms.controller";
import { FormsService } from "./forms.service";
import { FormContextGuard } from "./form-context.guard";
import { FormRateLimitGuard } from "./form-rate-limit.guard";
import { FormRateLimitService } from "./form-rate-limit.service";
import { FormLookupService } from "./form-lookup.service";
import { FormSchemaService } from "./form-schema.service";
import { SubmissionsRepository } from "./submissions.repository";
import { SubmissionsPurgeService } from "./submissions-purge.service";
import { TenantsModule } from "../tenants/tenants.module";
import { AuditModule } from "../audit/audit.module";
import { MediaModule } from "../media/media.module";
import { MailModule } from "../mail/mail.module";
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from "./turnstile/turnstile-verifier";
import { StubTurnstileVerifier } from "./turnstile/stub-turnstile-verifier";
import { CloudflareTurnstileVerifier } from "./turnstile/cloudflare-turnstile-verifier";
import { turnstileConfig } from "./forms.config";

@Module({
  imports: [TenantsModule, AuditModule, MediaModule, MailModule],
  controllers: [FormsController],
  providers: [
    FormsService,
    FormContextGuard,
    FormRateLimitGuard,
    FormRateLimitService,
    FormLookupService,
    FormSchemaService,
    SubmissionsRepository,
    SubmissionsPurgeService,
    StubTurnstileVerifier,
    CloudflareTurnstileVerifier,
    {
      provide: TURNSTILE_VERIFIER,
      // Chosen once, per process boot, from turnstileConfig.mode — NOT per-request, so a test that
      // needs both modes boots two separate Nest applications (see
      // test/forms-abuse-battery.spec.ts) rather than toggling env mid-process, matching this
      // codebase's existing "config read at construction" convention elsewhere (mail.config.ts's
      // provider selection is the same shape).
      useFactory: (stub: StubTurnstileVerifier, live: CloudflareTurnstileVerifier): TurnstileVerifier =>
        turnstileConfig.mode === "live" ? live : stub,
      inject: [StubTurnstileVerifier, CloudflareTurnstileVerifier],
    },
  ],
  exports: [FormsService, SubmissionsPurgeService, FormLookupService],
})
export class FormsModule {}
