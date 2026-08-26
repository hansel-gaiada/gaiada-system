// WSK-11 — wires the mail subsystem together. DbService comes from DbModule, which is @Global()
// (db/db.module.ts), so it needs no explicit import here — same reasoning ContentModule's own
// header comment documents for why it re-imports AuthModule/ApiKeysModule despite AuthModule
// already importing them (Nest resolves a guard/service's OWN constructor deps against providers
// visible to ITS OWN module, not transitively) does not apply to @Global() modules specifically.
//
// NOT registered in AppModule — app.module.ts is out of this ticket's owned paths. Required
// change, to be applied by whoever owns that file:
//
//   import { MailModule } from "./mail/mail.module";
//   @Module({ imports: [..., MailModule] })
//
// The BullMQ Worker (MailSenderProcessor) currently runs IN-PROCESS with whatever Nest app
// imports this module — today that is the single `api` service (docker-compose.yml's `worker`
// service is still a stub per WSK-01's own scope note: "queue consumers land at WSK-07/11").
// Splitting it into that dedicated container needs a new worker-only main.ts bootstrap entry
// point, which is a root-level file outside this ticket's owned paths (`src/mail/**`,
// `src/queue/**`) — flagged as a follow-up in the ticket report, not built here.
import { Module } from "@nestjs/common";
import { MailService } from "./mail.service";
import { MailTemplatesService } from "./mail-templates.service";
import { SuppressionService } from "./suppression.service";
import { MailLogRepository } from "./mail-log.repository";
import { MailSenderProcessor } from "./mail-sender.processor";

@Module({
  providers: [MailService, MailTemplatesService, SuppressionService, MailLogRepository, MailSenderProcessor],
  exports: [MailService, SuppressionService, MailTemplatesService, MailLogRepository],
})
export class MailModule {}
