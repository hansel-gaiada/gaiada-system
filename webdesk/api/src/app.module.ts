import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module";
import { RateLimitModule } from "./rate-limit/rate-limit.module";
import { TenantsModule } from "./tenants/tenants.module";
import { AuditModule } from "./audit/audit.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuthModule } from "./auth/auth.module";
// WSK-48a — the public /v1 content-read path (envelope router), rehomed from the Payload app.
// Replaces WSK-05's demonstration ContentModule (retired: it owned GET/POST /v1/t/:tenantSlug/content,
// which would have shadowed a collection keyed `content`).
import { DeliveryModule } from "./delivery/delivery.module";
// WSK-07 (wired by coordinator; the ticket reported this rather than editing a shared file).
// MediaModule pulls StorageModule in with it.
import { MediaModule } from "./media/media.module";
// WSK-11 (wired by coordinator; the ticket reported this rather than editing a shared file).
import { MailModule } from "./mail/mail.module";
// WSK-10 (wired by coordinator; the ticket reported this rather than editing a shared file).
import { FormsModule } from "./forms/forms.module";
// WSK-21 (wired by coordinator). NOT public-proxy-reachable until WSK-22 lands the real
// mTLS + Keycloak + WS4 channel; webdesk/proxy/Caddyfile 404s /control/* on the public vhost.
import { ControlModule } from "./control/control.module";
// WSK-37 (wired by coordinator).
import { TenantWebhooksModule } from "./tenant-webhooks/tenant-webhooks.module";
// WSK-12 (wired by coordinator). Fail-soft by construction: a bridge outage must never
// break a form submission, so every emit failure is caught and logged, never thrown.
import { EventsModule } from "./events/events.module";
// WSK-32 — AI schema drafting (PRD -> validated composition proposal + diff summary; never
// applies). Deliberately a SIBLING of ControlModule, not nested inside it — see
// src/schema-draft/schema-draft-auth.guard.ts's header for why. This import + registration is
// the one cross-file edit WSK-32's ticket brief explicitly permits ("registering your module in
// the api's root module"); every other file this ticket touches lives under src/schema-draft/.
import { SchemaDraftModule } from "./schema-draft/schema-draft.module";
// WSK-25 — promotion engine (content half): snapshot-first -> migrate -> content export/import,
// rollback = content restore. Sibling of ControlModule (imports it for ControlAuthGuard only —
// same pattern as SchemaDraftModule above), not nested inside it. This import + registration is
// the one cross-file edit this ticket's brief explicitly permits.
import { PromotionModule } from "./promotion/promotion.module";
// WSK-61 — the scheduler: due publishes/takedowns, live-item version swaps, forms purge, idempotency sweep.
import { SchedulerModule } from "./scheduler/scheduler.module";
// M4 — flushes OpenTelemetry spans at shutdown; a no-op unless telemetry was started (src/telemetry).
import { TelemetryModule } from "./telemetry/telemetry.module";

@Module({
  imports: [
    DbModule,
    RateLimitModule,
    TenantsModule,
    AuditModule,
    ApiKeysModule,
    AuthModule,
    DeliveryModule,
    MediaModule,
    MailModule,
    FormsModule,
    ControlModule,
    EventsModule,
    TenantWebhooksModule,
    SchemaDraftModule,
    PromotionModule,
    SchedulerModule,
    TelemetryModule,
  ],
})
export class AppModule {}
