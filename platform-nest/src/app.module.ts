// Root module. Health + identity/admin/dev + core /api controllers. Subsequent stages add
// the write controllers (client-work, collab, files, custom-fields) and the module
// registry as DynamicModules — each gated green by porting the matching existing test file.
// HIER-3 (2026-08-11): TeamsController retired — `teams`/`team_memberships` are 0-row vestigial
// tables (docs/superpowers/plans/2026-08-11-hier-3-report.md); zero UI callers of `/api/:t/teams*`.
import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { IdentityController } from "./identity/identity.controller";
import { CoreController } from "./core/core.controller";
import { CustomFieldsController } from "./core/custom-fields.controller";
import { AuthzCheckController } from "./core/authz-check.controller";
import { AuthzPermissionsController } from "./core/authz-permissions.controller";
import { ClientWorkController } from "./core/client-work.controller";
import { BillingController } from "./modules/billing/billing.controller";
import { CollabController } from "./core/collab.controller";
import { AutomationApprovalsController } from "./core/automation-approvals.controller";
import { PipelineController } from "./core/pipeline.controller";
import { ApprovalsController } from "./core/approvals.controller";
import { ApprovalsDecideController } from "./core/approvals-decide.controller";
import { TasksMineController } from "./core/tasks-mine.controller";
import { MeetingRecordingsController } from "./core/meetings.controller";
import { ClientContactsController, ClientInviteAcceptController } from "./core/client-contacts.controller";
import { PortalController } from "./core/portal.controller";
// CP-2..CP-5: the client portal split across four further controller classes, all on the same `api`
// prefix as PortalController. Nest permits that as long as no individual route path collides, and none
// does (workspace = overview/projects/milestones/timeline/deliverables, commerce = invoices/contracts/
// files, profile = profile*, stream = stream). Split by subject rather than crammed into one file
// because each is independently reviewable and they have different risk profiles — commerce is the only
// one an external party WRITES through.
import { PortalWorkspaceController } from "./core/portal-workspace.controller";
import { PortalCommerceController } from "./core/portal-commerce.controller";
import { PortalProfileController } from "./core/portal-profile.controller";
import { PortalStreamController } from "./core/portal-stream.controller";
// MI-02 (webdev maintenance intake, D-7) — the portal's change-request surface. Own controller class
// per the CP-2..CP-5 split precedent above: a distinct subject, a distinct risk profile (the second
// external-party WRITE surface after commerce), same `api` prefix, no route collision.
import { WebdevChangeRequestsPortalController } from "./core/webdev-change-requests-portal.controller";
// CP-19: the STAFF half of the portal's commerce surface — contract authoring/send/countersign and
// payment confirmation. Without it the portal's contracts section is permanently empty and a
// client-recorded payment can never leave `pending`, so it ships in the same change.
import { ContractsController } from "./core/contracts.controller";
// MI-03 — the STAFF half of webdev maintenance intake (triage queue + mini-run spawner). Core, not a
// module: there is no `src/modules/webdev/`, and `webdev_change_requests` takes the plain tenant wall
// (D-2a) so no ModuleEnabledGuard belongs in front of triage. See the controller's own header.
import { WebdevChangeRequestsController } from "./core/webdev-change-requests.controller";
import { FilesController } from "./core/files.controller";
import { CreativeController } from "./core/creative.controller";
import { WorkActivityController } from "./core/work-activity.controller";
import { IntegrationsController } from "./core/integrations.controller";
import { ClaudeSeatsController } from "./core/claude-seats.controller";
import { AdminIdentityController } from "./admin/admin-identity.controller";
import { CompanyAdminController } from "./admin/company-admin.controller";
import { EmployeesController } from "./admin/employees.controller";
import { PositionsController } from "./admin/positions.controller";
import { RoleGrantsController } from "./admin/role-grants.controller";
import { ServiceAssignmentsController } from "./admin/service-assignments.controller";
import { CompanyCrudController } from "./admin/company-crud.controller";
import { AdminSystemsController } from "./admin/admin-systems.controller";
import { ObservabilityController } from "./admin/observability.controller";
import { BotAdminController } from "./admin/bot-admin.controller";
import { IntelligenceController } from "./admin/intelligence.controller";
import { AgencyController } from "./modules/agency/agency.controller";
import { PmController } from "./modules/pm/pm.controller";
import { ItController } from "./modules/it/it.controller";
import { ClientsController } from "./modules/clients/clients.controller";
import { HrController } from "./modules/hr/hr.controller";
import { SocialController } from "./modules/social/social.controller";
import { LoansController } from "./modules/hr/loans.controller";
import { AssistantController } from "./modules/assistant/assistant.controller";
import { SearchController } from "./modules/search/search.controller";
import { SearchGoogleOauthCallbackController } from "./modules/search/search-google-oauth.controller";
import { SearchGoogleAdsController } from "./modules/search/search-google-ads.controller";
import { SearchReportsController } from "./modules/search/search-reports.controller";
import { ReportsController } from "./modules/reports/reports.controller";
// PRV-02: the `webdev` module shell's HTTP surface (provision a site+repo, read/reconcile the mirror
// rows). Mounts at /api/:tenantId/modules/webdev/* behind ModuleEnabledGuard("webdev") — the FIRST
// webdev surface to be module-scoped rather than core, because `webdev_provisioned_sites` (0090)
// carries the third RLS wall and the client portal never touches it.
import { WebdevController } from "./modules/webdev/webdev.controller";
import { CheckinsController } from "./modules/reports/checkins.controller"; // TR-09
import { AppraisalsController } from "./modules/reports/appraisals.controller"; // TR-24
import { PrintPayloadController } from "./modules/reports/print-payload.controller"; // TR-21
import { McpToolsController } from "./modules/mcp-tools.controller";
import { ModuleCatalogController } from "./modules/module-catalog.controller";
// MAIL-04 — core mail infra (src/mail/, design A1: same class as src/events/, no ModuleContract
// registration / no per-tenant enable gate). AdminMailController is the elevated-only
// GET /api/admin/mail/log[/:id] read surface (§6.1/§8A); MailWebhookController is the
// unauthenticated-by-session, token-only delivery-event intake (§7.7) — deliberately NOT under
// AuthGuard, same shape as PrintPayloadController's root, session-less route.
import { AdminMailController } from "./mail/admin-mail.controller";
import { MailWebhookController } from "./mail/webhook.controller";
// MAIL-13 — inbound system-mail threads (design §7.6). MailInboundController is the second
// session-less, token-only provider door (the untrusted-input one); MailThreadController is the
// entity-authorized read surface (A10) plus the scan-gated quarantine download.
import { MailInboundController } from "./mail/inbound.controller";
import { MailThreadController } from "./mail/thread.controller";
// MAIL-10 (design §9) — low-risk convenience login via single-use magic links. Root-level,
// ServiceGuard-only (platform-ui's server-side code is the sole caller); MAIL_MAGIC_LINKS_ENABLED
// defaults 0 so this stays dark until the staging SLO gate (§15 R5) closes.
import { MagicLinkController } from "./mail/magic-link/controller";

@Module({
  controllers: [
    HealthController, IdentityController, CoreController, CustomFieldsController,
    AuthzCheckController, AuthzPermissionsController, ClientWorkController, BillingController, CollabController, AutomationApprovalsController, PipelineController, ApprovalsController, ApprovalsDecideController, TasksMineController, MeetingRecordingsController, PortalController, PortalWorkspaceController, PortalCommerceController, PortalProfileController, PortalStreamController, WebdevChangeRequestsPortalController, WebdevChangeRequestsController, ContractsController, ClientContactsController, ClientInviteAcceptController, FilesController, CreativeController, WorkActivityController, IntegrationsController, ClaudeSeatsController, AdminIdentityController,
    CompanyAdminController, EmployeesController, PositionsController, RoleGrantsController, ServiceAssignmentsController, CompanyCrudController, AdminSystemsController, ObservabilityController, BotAdminController, IntelligenceController,
    // Vertical modules (compiled-in; per-tenant enable gate at the controller).
    AgencyController, PmController, ItController, ClientsController, HrController, LoansController, AssistantController, SearchController,
    SocialController,
    // SM-25a: the Google OAuth callback is tenant-agnostic on purpose (Google permits no wildcard
    // redirect URIs — see the file header) and so cannot mount under SearchController's
    // `api/:tenantId/modules/search` prefix. Registered as its own controller, mounted at the fixed
    // path `api/search/google/oauth/callback`.
    SearchGoogleOauthCallbackController,
    // SM-25c: Ads read-binding routes (account link + pull + history reader), on its OWN controller
    // class rather than SearchController's — SM-21 owns that file's edit surface concurrently this
    // wave (approve-execute-replay routes). Shares SearchController's exact route prefix; Nest allows
    // multiple controller classes on one prefix as long as no individual route path collides (it
    // doesn't — see search-google-ads.controller.ts's own header).
    SearchGoogleAdsController,
    // SM-22: report review/approve/preview/deliver lifecycle, on its OWN controller class — same
    // reason as SearchGoogleAdsController above (SM-21 owns search.controller.ts's edit surface this
    // wave; SM-10 already added its own reports GET/POST section there). Shares SearchController's
    // exact route prefix; no individual route path collides (search-reports.controller.ts's own header).
    SearchReportsController,
    // PRV-02: /api/:t/modules/webdev/* (provision · provisioned-sites · reconcile).
    WebdevController,
    // TR-07: reports admin/ops surface (facts recompute). §6.2 routes it at /api/:t/reports/*,
    // not /api/:t/modules/reports/*, so it is listed with the verticals but mounts top-level.
    ReportsController,
    // TR-09: check-in subsystem, /api/:t/checkins/* (own top-level prefix, own controller class).
    CheckinsController,
    // TR-24: appraisal engine, /api/:t/appraisals/* (own top-level prefix, own controller class —
    // deliberately NEVER registered in ModuleContract.mcpTools, §9.2/standing ruling: appraisal
    // read/write must never be reachable by an agent).
    AppraisalsController,
    // TR-21: the internal, token-only PDF payload fetch — root-level, no `/api` prefix, no
    // guards (identity.controller.ts's precedent). See print-payload.controller.ts's own header.
    PrintPayloadController,
    // MCP tool-def aggregation for the hub (WS2 §6).
    McpToolsController,
    // Compiled-in module list for the settings UI (see the controller header for why it is
    // NOT gated on per-tenant enablement).
    ModuleCatalogController,
    // MAIL-04 (design §6.1/§7.7/§8A) — core mail infra's two controllers.
    AdminMailController,
    MailWebhookController,
    // MAIL-13 (design §7.6/§8A/A10) — inbound intake + entity-authorized thread reads.
    MailInboundController,
    MailThreadController,
    // MAIL-10 (design §9).
    MagicLinkController,
  ],
})
export class AppModule {}
