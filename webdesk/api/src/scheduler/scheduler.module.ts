// WSK-61 — wires the scheduler: the content tick, the two maintenance jobs, and the BullMQ service that
// runs them. Registered in app.module.ts. Imports (not relies on transitive visibility, the estate's
// rule for Nest injection): AuditModule (the tick's audit rows), TenantWebhooksModule (the post-commit
// webhook fan-out; exports the dispatcher), FormsModule (exports SubmissionsPurgeService).
//
// PgIdempotencyStore is provided here as well as in ControlModule rather than exported from it: it is a
// stateless wrapper over DbService (no cache, no timers), so a second instance behaves identically and
// control.module.ts stays untouched.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { TenantWebhooksModule } from "../tenant-webhooks/tenant-webhooks.module";
import { FormsModule } from "../forms/forms.module";
import { PgIdempotencyStore } from "../control/idempotency/pg-idempotency-store";
import { ContentTickService } from "./content-tick.service";
import { MaintenanceJobsService } from "./maintenance-jobs.service";
import { SchedulerService } from "./scheduler.service";

@Module({
  imports: [AuditModule, TenantWebhooksModule, FormsModule],
  providers: [ContentTickService, MaintenanceJobsService, SchedulerService, PgIdempotencyStore],
  exports: [ContentTickService, MaintenanceJobsService, SchedulerService],
})
export class SchedulerModule {}
