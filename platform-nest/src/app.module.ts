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
import { BillingController } from "./modules/billing/billing.controller";
import { CollabController } from "./core/collab.controller";
import { AutomationApprovalsController } from "./core/automation-approvals.controller";
import { PipelineController } from "./core/pipeline.controller";
import { ApprovalsController } from "./core/approvals.controller";
import { ApprovalsDecideController } from "./core/approvals-decide.controller";
import { TasksMineController } from "./core/tasks-mine.controller";
import { MeetingRecordingsController } from "./core/meetings.controller";
import { PortalController } from "./core/portal.controller";
import { FilesController } from "./core/files.controller";
import { CreativeController } from "./core/creative.controller";
import { WorkActivityController } from "./core/work-activity.controller";
import { IntegrationsController } from "./core/integrations.controller";
import { ClaudeSeatsController } from "./core/claude-seats.controller";
import { AdminIdentityController } from "./admin/admin-identity.controller";
import { CompanyAdminController } from "./admin/company-admin.controller";
import { ServiceAssignmentsController } from "./admin/service-assignments.controller";
import { CompanyCrudController } from "./admin/company-crud.controller";
import { AdminSystemsController } from "./admin/admin-systems.controller";
import { BotAdminController } from "./admin/bot-admin.controller";
import { IntelligenceController } from "./admin/intelligence.controller";
import { AgencyController } from "./modules/agency/agency.controller";
import { PmController } from "./modules/pm/pm.controller";
import { ItController } from "./modules/it/it.controller";
import { ClientsController } from "./modules/clients/clients.controller";
import { HrController } from "./modules/hr/hr.controller";
import { SearchController } from "./modules/search/search.controller";
import { SearchGoogleOauthCallbackController } from "./modules/search/search-google-oauth.controller";
import { ReportsController } from "./modules/reports/reports.controller";
import { McpToolsController } from "./modules/mcp-tools.controller";

@Module({
  controllers: [
    HealthController, IdentityController, CoreController, TeamsController, CustomFieldsController,
    AuthzCheckController, ClientWorkController, BillingController, CollabController, AutomationApprovalsController, PipelineController, ApprovalsController, ApprovalsDecideController, TasksMineController, MeetingRecordingsController, PortalController, FilesController, CreativeController, WorkActivityController, IntegrationsController, ClaudeSeatsController, AdminIdentityController,
    CompanyAdminController, ServiceAssignmentsController, CompanyCrudController, AdminSystemsController, BotAdminController, IntelligenceController,
    // Vertical modules (compiled-in; per-tenant enable gate at the controller).
    AgencyController, PmController, ItController, ClientsController, HrController, SearchController,
    // SM-25a: the Google OAuth callback is tenant-agnostic on purpose (Google permits no wildcard
    // redirect URIs — see the file header) and so cannot mount under SearchController's
    // `api/:tenantId/modules/search` prefix. Registered as its own controller, mounted at the fixed
    // path `api/search/google/oauth/callback`.
    SearchGoogleOauthCallbackController,
    // TR-07: reports admin/ops surface (facts recompute). §6.2 routes it at /api/:t/reports/*,
    // not /api/:t/modules/reports/*, so it is listed with the verticals but mounts top-level.
    ReportsController,
    // MCP tool-def aggregation for the hub (WS2 §6).
    McpToolsController,
  ],
})
export class AppModule {}
