// WSK-37 — wires the tenant-webhooks subsystem together.
//
// NOT registered in AppModule — app.module.ts is out of this ticket's owned scope (same posture
// WSK-10/11/12 each already documented for their own modules). Required change, to be applied by
// whoever owns that file:
//
//   import { TenantWebhooksModule } from "./tenant-webhooks/tenant-webhooks.module";
//   @Module({ imports: [..., TenantWebhooksModule] })
//
// The consuming change forms.service.ts actually needs (call
// `tenantWebhookDispatcher.dispatchFormReceived(...)` after step 9's existing
// `zoneBEvents.emitFormReceived(...)` call, same best-effort `.catch()` discipline) is likewise
// NOT made here — forms.service.ts is not this ticket's owned path. The exact hook is documented
// in this ticket's report. Because that future FormsModule edit will need
// TenantWebhookDispatcherService injectable there, this module imports TenantsModule/AuditModule
// itself (not relying on transitive visibility — forms.module.ts's own header explains why that
// matters: injection resolves against providers visible to the INJECTING module).
import { Module } from "@nestjs/common";
import { TenantWebhooksController } from "./tenant-webhooks.controller";
import { TenantWebhooksService } from "./tenant-webhooks.service";
import { TenantWebhooksRepository } from "./tenant-webhooks.repository";
import { TenantWebhookDispatcherService } from "./tenant-webhook-dispatcher.service";
import { TenantWebhookSenderProcessor } from "./tenant-webhook-sender.processor";
import { TenantsModule } from "../tenants/tenants.module";
import { AuditModule } from "../audit/audit.module";

@Module({
  imports: [TenantsModule, AuditModule],
  controllers: [TenantWebhooksController],
  providers: [TenantWebhooksService, TenantWebhooksRepository, TenantWebhookDispatcherService, TenantWebhookSenderProcessor],
  exports: [TenantWebhooksService, TenantWebhookDispatcherService],
})
export class TenantWebhooksModule {}
