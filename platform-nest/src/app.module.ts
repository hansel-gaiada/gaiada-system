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
import { InvoiceController } from "./modules/invoice/invoice.controller";
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
// SMM-31 (D-16) — the portal's client-review decide surface for social posts. Same CP-2..CP-5 split
// precedent: a distinct subject (social's client-review stage), same `api` prefix, no route collision.
import { SocialClientReviewPortalController } from "./core/social-client-review-portal.controller";
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
import { ItAccountsController } from "./admin/it-accounts.controller";
import { ServiceAssignmentsController } from "./admin/service-assignments.controller";
import { CompanyCrudController } from "./admin/company-crud.controller";
import { AdminSystemsController } from "./admin/admin-systems.controller";
import { ObservabilityController } from "./admin/observability.controller";
import { AgentsController } from "./admin/agents.controller";
import { MonitoringController, MonitoringHeartbeatController } from "./modules/monitoring/monitoring.controller";
import { BotAdminController } from "./admin/bot-admin.controller";
import { IntelligenceController } from "./admin/intelligence.controller";
import { AgencyController } from "./modules/agency/agency.controller";
import { PmController } from "./modules/pm/pm.controller";
import { ItController } from "./modules/it/it.controller";
import { FinanceController } from "./modules/finance/finance.controller";
import { ClientsController } from "./modules/clients/clients.controller";
import { HrController } from "./modules/hr/hr.controller";
import { SocialController } from "./modules/social/social.controller";
// SMM-23: report snapshot -> AI narrative -> approve -> render -> deliver lifecycle, on its OWN
// controller class — same reason SearchReportsController gives below (three other seats hold
// social.controller.ts's edit surface this wave). Shares SocialController's exact route prefix; no
// individual route path collides (social-reports.controller.ts's own header).
import { SocialReportsController } from "./modules/social/social-reports.controller";
// SMM-38 phase 38c — LinkedIn's OAuth grant flow. `LinkedInOAuthController` shares SocialController's
// route prefix (same reasoning as SocialReportsController above); `LinkedInOAuthCallbackController`
// is tenant-agnostic at a FIXED path, mirroring SearchGoogleOauthCallbackController below for the
// identical reason (no wildcard redirect_uri at the issuer).
import { LinkedInOAuthController, LinkedInOAuthCallbackController } from "./modules/social/linkedin-oauth.controller";
// SMM-38 phase 38d — YouTube's OAuth grant flow, same shape and same reasoning as
// `LinkedInOAuthController`/`LinkedInOAuthCallbackController` immediately above (see that file's own
// header and `youtube-oauth.controller.ts`'s own header for why two controllers).
import { YouTubeOAuthController, YouTubeOAuthCallbackController } from "./modules/social/youtube-oauth.controller";
import { LoansController } from "./modules/hr/loans.controller";
// HR-FULL (waves A-D): the HR department's configuration, recruitment, payroll and lifecycle
// surfaces. All four mount under the SAME `api/:tenantId/modules/hr` prefix as HrController and
// carry the same AuthGuard + ModuleEnabledGuard("hr"); the split is by capability, not by route.
import { HrPolicyController } from "./modules/hr/hr-policy.controller";
import { RecruitmentController } from "./modules/hr/recruitment.controller";
import { PayrollController } from "./modules/hr/payroll.controller";
import { HrLifecycleController } from "./modules/hr/hr-lifecycle.controller";
// LMS L1 — its OWN module (not filed under hr): the learning catalogue and the learner surface.
import { LmsCatalogueController } from "./modules/lms/lms-catalogue.controller";
import { LmsLearnController } from "./modules/lms/lms-learn.controller";
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
// WSK-12 (coordinator, additive): the Zone B signed-fact consumer.
import { ZoneBEventsController } from "./modules/webdev/zoneb-events.controller";
// WSK-19: the rail's Zone A end (the contract-snapshot mirror). Lives in the SIBLING directory
// src/modules/webdev-contracts/, not src/modules/webdev/ — see
// contract-fetch-provider.ts's header for why (egress-inventory.test.ts's scope). Still gated by
// the SAME "webdev" module key (ModuleEnabledGuard("webdev")) and the same third-wall RLS.
import { ContractSnapshotsController } from "./modules/webdev-contracts/contract-snapshots.controller";
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
    AuthzCheckController, AuthzPermissionsController, ClientWorkController, InvoiceController, CollabController, AutomationApprovalsController, PipelineController, ApprovalsController, ApprovalsDecideController, TasksMineController, MeetingRecordingsController, PortalController, PortalWorkspaceController, PortalCommerceController, PortalProfileController, PortalStreamController, WebdevChangeRequestsPortalController, SocialClientReviewPortalController, WebdevChangeRequestsController, ContractsController, ClientContactsController, ClientInviteAcceptController, FilesController, CreativeController, WorkActivityController, IntegrationsController, ClaudeSeatsController, AdminIdentityController,
    CompanyAdminController, EmployeesController, PositionsController, RoleGrantsController, ItAccountsController, ServiceAssignmentsController, CompanyCrudController, AdminSystemsController, ObservabilityController, AgentsController, MonitoringController, MonitoringHeartbeatController, BotAdminController, IntelligenceController,
    // Vertical modules (compiled-in; per-tenant enable gate at the controller).
    AgencyController, PmController, ItController, FinanceController, ClientsController, HrController, LoansController,
    HrPolicyController, RecruitmentController, PayrollController, HrLifecycleController,
    LmsCatalogueController, LmsLearnController,
    AssistantController, SearchController,
    SocialController,
    // SMM-23: report review/approve/preview/deliver lifecycle, on its OWN controller class — same
    // reason as SearchReportsController below (three other seats hold social.controller.ts's edit
    // surface this wave). Shares SocialController's exact route prefix; no individual route path
    // collides (social-reports.controller.ts's own header).
    SocialReportsController,
    // SMM-38 phase 38c: LinkedIn's OAuth grant flow — `LinkedInOAuthController` shares
    // SocialController's route prefix (same reasoning as SocialReportsController above);
    // `LinkedInOAuthCallbackController` is tenant-agnostic at a fixed path, same reason as
    // SearchGoogleOauthCallbackController immediately below.
    LinkedInOAuthController, LinkedInOAuthCallbackController,
    // SMM-38 phase 38d: YouTube's OAuth grant flow — same reasoning as the LinkedIn pair immediately
    // above.
    YouTubeOAuthController, YouTubeOAuthCallbackController,
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
    ZoneBEventsController,
    // WSK-19: /api/:t/modules/webdev/contracts[/refresh] (the one-rail contract-snapshot mirror).
    ContractSnapshotsController,
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
