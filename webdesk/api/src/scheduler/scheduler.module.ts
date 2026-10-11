// WSK-61 — wires the scheduler: the content tick, the two maintenance jobs, WSK-43a's media purge, and the
// BullMQ service that runs them. Registered in app.module.ts. Imports (not relies on transitive visibility, the estate's
// rule for Nest injection): AuditModule (the tick's audit rows), EventsModule (the schedule.fired Zone B emitter) and TenantWebhooksModule (the
// post-commit webhook fan-out; exports the dispatcher).
//
// SubmissionsPurgeService and PgIdempotencyStore are provided HERE as well as in their own modules
// (FormsModule, ControlModule) instead of being imported from them. Both are stateless wrappers over
// DbService (no cache, no timers, no connections), so a second instance behaves identically; and
// importing FormsModule would push it (and everything it imports) one level deeper in Nest's module
// graph. Nest runs onModuleInit/onModuleDestroy deepest-first, so that would silently reorder the
// shutdown of unrelated modules (the editorial jti store, the webhook worker) and surface a latent
// "Connection is closed" race in specs that boot and close the app at once. control.module.ts and
// forms.module.ts stay untouched. MediaPurgeService (WSK-43a) needs only DbService, AuditService (AuditModule,
// imported above) and the storage adapter (StorageModule is @Global), so it is provided here and MediaModule
// is NOT imported, for the same shutdown-ordering reason.
import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module";
import { AuditModule } from "../audit/audit.module";
import { TenantWebhooksModule } from "../tenant-webhooks/tenant-webhooks.module";
import { SubmissionsPurgeService } from "../forms/submissions-purge.service";
import { PgIdempotencyStore } from "../control/idempotency/pg-idempotency-store";
import { ContentTickService } from "./content-tick.service";
import { MaintenanceJobsService } from "./maintenance-jobs.service";
import { MediaPurgeService } from "./media-purge.service";
import { SchedulerService } from "./scheduler.service";

@Module({
  imports: [AuditModule, EventsModule, TenantWebhooksModule],
  providers: [ContentTickService, MaintenanceJobsService, MediaPurgeService, SchedulerService, PgIdempotencyStore, SubmissionsPurgeService],
  exports: [ContentTickService, MaintenanceJobsService, MediaPurgeService, SchedulerService],
})
export class SchedulerModule {}
