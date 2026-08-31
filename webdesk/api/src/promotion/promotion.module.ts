// WSK-25 — registered directly in ../app.module.ts (this ticket's one permitted cross-file edit —
// same pattern WSK-32's schema-draft.module.ts documents for the same reason: this module needs
// the REAL control channel, and ../control/control.module.ts already exports `ControlAuthGuard`
// for exactly this kind of sibling consumption — no edit to that file was needed (its exports
// array already held `ControlAuthGuard` before this ticket started; see the final report).
//
// `IdempotencyStore` is registered as THIS module's own provider (a plain, dependency-free class —
// see ../control/idempotency/idempotency-store.ts) rather than imported from ControlModule, so
// this module gets its OWN in-memory idempotency scope, no ControlModule export needed for it.
import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module";
import { AuditModule } from "../audit/audit.module";
import { ControlModule } from "../control/control.module";
import { IdempotencyStore } from "../control/idempotency/idempotency-store";
import { ContentBundleService } from "./content-bundle.service";
import { PromotionSnapshotService } from "./promotion-snapshot.service";
import { PromotionAuditService } from "./promotion-audit.service";
import { PromotionCommandService } from "./promotion-command.service";
import { PromotionController } from "./promotion.controller";
import { FRONTEND_DEPLOY_DRIVER } from "./frontend-deploy-driver";
import { NotYetAvailableFrontendDeployDriver } from "./not-yet-available-frontend-deploy-driver";

@Module({
  // DbModule is @Global (../db/db.module.ts) so DbService needs no import here.
  imports: [TenantsModule, AuditModule, ControlModule],
  controllers: [PromotionController],
  providers: [
    IdempotencyStore,
    ContentBundleService,
    PromotionSnapshotService,
    PromotionAuditService,
    PromotionCommandService,
    { provide: FRONTEND_DEPLOY_DRIVER, useClass: NotYetAvailableFrontendDeployDriver },
  ],
})
export class PromotionModule {}
