// Root module. Health + identity/admin/dev + core /api controllers. Subsequent stages add
// the write controllers (client-work, collab, files, teams, custom-fields) and the module
// registry as DynamicModules — each gated green by porting the matching existing test file.
import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { IdentityController } from "./identity/identity.controller";
import { CoreController } from "./core/core.controller";
import { TeamsController } from "./core/teams.controller";
import { CustomFieldsController } from "./core/custom-fields.controller";
import { AuthzCheckController } from "./core/authz-check.controller";
import { ClientWorkController } from "./core/client-work.controller";
import { CollabController } from "./core/collab.controller";
import { AutomationApprovalsController } from "./core/automation-approvals.controller";
import { FilesController } from "./core/files.controller";
import { AdminIdentityController } from "./admin/admin-identity.controller";
import { CompanyAdminController } from "./admin/company-admin.controller";
import { AdminSystemsController } from "./admin/admin-systems.controller";
import { IntelligenceController } from "./admin/intelligence.controller";
import { AgencyController } from "./modules/agency/agency.controller";

@Module({
  controllers: [
    HealthController, IdentityController, CoreController, TeamsController, CustomFieldsController,
    AuthzCheckController, ClientWorkController, CollabController, AutomationApprovalsController, FilesController, AdminIdentityController,
    CompanyAdminController, AdminSystemsController, IntelligenceController,
    // Vertical modules (compiled-in; per-tenant enable gate at the controller).
    AgencyController,
  ],
})
export class AppModule {}
