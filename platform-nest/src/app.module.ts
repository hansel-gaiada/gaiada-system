// Root module. Health + identity/admin/dev + core /api controllers. Subsequent stages add
// the write controllers (client-work, collab, files, custom-fields) and the module
// registry as DynamicModules — each gated green by porting the matching existing test file.
// HIER-3 (2026-08-11): TeamsController retired — `teams`/`team_memberships` are 0-row vestigial
// tables (docs/superpowers/plans/2026-08-11-hier-3-report.md); zero UI callers of `/api/:t/teams*`.
import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { IdentityController } from "./identity/identity.controller";
// PV5-14 / PV-D40 — the simulated second factor (dev stage only; 404 while MFA_SIMULATION_ENABLED is off).
import { StepUpController } from "./auth/step-up.controller";
import { CoreController } from "./core/core.controller";
import { CustomFieldsController } from "./core/custom-fields.controller";
import { AuthzCheckController } from "./core/authz-check.controller";
import { AuthzPermissionsController } from "./core/authz-permissions.controller";
import { ClientWorkController } from "./core/client-work.controller";
import { InvoiceController } from "./modules/invoice/invoice.controller";
import { BillingProfileController } from "./modules/invoice/billing-profile.controller";
import { BillingProfileAgentController } from "./modules/invoice/billing-profile-agent.controller";
import { BillingNumberingController } from "./modules/invoice/billing-numbering.controller";
import { CollabController } from "./core/collab.controller";
import { AutomationApprovalsController } from "./core/automation-approvals.controller";
import { PipelineController } from "./core/pipeline.controller";
import { ApprovalsController } from "./core/approvals.controller";
import { ApprovalsDecideController } from "./core/approvals-decide.controller";
import { TasksMineController } from "./core/tasks-mine.controller";
import { MeetingRecordingsController } from "./core/meetings.controller";
import { ClientContactsController, ClientInviteAcceptController } from "./core/client-contacts.controller";
import { ClientWebsiteAccessController } from "./core/client-website-access.controller";
import { PortalController } from "./core/portal.controller";
// CP-2..CP-5: the client portal split across four further controller classes, all on the same `api`
// prefix as PortalController. Nest permits that as long as no individual route path collides, and none
// does (workspace = overview/projects/milestones/timeline/deliverables, commerce = invoices/contracts/
// files, profile = profile*, stream = stream). Split by subject rather than crammed into one file
// because each is independently reviewable and they have different risk profiles — commerce is the only
// one an external party WRITES through.
import { PortalWorkspaceController } from "./core/portal-workspace.controller";
import { PortalHealthController } from "./core/portal-health.controller";
import { PortalReportsController } from "./core/portal-reports.controller";
import { PortalCommerceController } from "./core/portal-commerce.controller";
import { PortalDocumentsController } from "./core/portal-documents.controller";
import { ClientDocumentsController } from "./core/client-documents.controller";
import { PortalProfileController } from "./core/portal-profile.controller";
import { PortalStreamController } from "./core/portal-stream.controller";
// MI-02 (webdev maintenance intake, D-7) — the portal's change-request surface. Own controller class
// per the CP-2..CP-5 split precedent above: a distinct subject, a distinct risk profile (the second
// external-party WRITE surface after commerce), same `api` prefix, no route collision.
import { WebdevChangeRequestsPortalController } from "./core/webdev-change-requests-portal.controller";
// SMM-31 (D-16) — the portal's client-review decide surface for social posts. Same CP-2..CP-5 split
// precedent: a distinct subject (social's client-review stage), same `api` prefix, no route collision.
import { SocialClientReviewPortalController } from "./core/social-client-review-portal.controller";
// PV4-03: client Conversation — the portal surface (portal read/converse) and the staff surface (`conversation` kind).
import { PortalConversationController } from "./core/portal-conversation.controller";
import { ConversationController } from "./core/conversation.controller";
import { WorkRequestsController } from "./core/work-requests.controller";
import { CalendarEventsController } from "./core/calendar-events.controller";
// CP-19: the STAFF half of the portal's commerce surface — contract authoring/send/countersign and
// payment confirmation. Without it the portal's contracts section is permanently empty and a
// client-recorded payment can never leave `pending`, so it ships in the same change.
import { ContractsController } from "./core/contracts.controller";
// MI-03 — the STAFF half of webdev maintenance intake (triage queue + mini-run spawner). Core, not a
// module: there is no `src/modules/webdev/`, and `webdev_change_requests` takes the plain tenant wall
// (D-2a) so no ModuleEnabledGuard belongs in front of triage. See the controller's own header.
import { WebdevChangeRequestsController } from "./core/webdev-change-requests.controller";
// AD-1 agency discovery intake. All three live in core/, NOT modules/agency/, for the reason the
// design records in §3.1: these tables take the plain tenant wall rather than
// app_module_allowed('agency'), so a ModuleEnabledGuard must never sit in front of them. Same
// placement, and the same reasoning, as the webdev change-request pair immediately above.
//
// AgencyIntakePortalController is the ONLY controller in this list that does not carry AuthGuard.
// It is guarded by IntakeTokenGuard instead — a prospect has no platform session and is not a
// principal (design §5.1). It is not unauthenticated; it is authenticated by a capability token.
import { AgencyIntakePortalController } from "./core/agency-intake-portal.controller";
import { AgencyLeadsController } from "./core/agency-leads.controller";
// Convert is split out of AgencyLeadsController the way ApprovalsDecideController is split out of
// ApprovalsController: it is a different Cerbos action (`convert`, not `triage`) guarding a write
// that mints a client, a project and a delivery run.
import { AgencyLeadConvertController } from "./core/agency-lead-convert.controller";
// M5-G5: privacy find/export/erase over the agency intake data (WS4-gated per call; see its header).
import { AgencyPrivacyController } from "./core/agency-privacy.controller";
// GH-08: BFF for the GitHub repo registry (list/detail/link/unlink). Deliberately its own
// controller file outside `core/github/` — see that file's own header for why.
import { GithubReposController } from "./core/github-repos.controller";
// GH-07: the webhook receiver (`POST /api/webhooks/github`) + reverse attribution. Own controller,
// same "outside core/github/" placement reasoning as GithubReposController immediately above.
import { GithubWebhookController } from "./core/github-webhook.controller";
// PV5-10: the payment provider webhook (`POST /api/webhooks/payments/:provider`). No AuthGuard: the provider signature is
// the authentication (see its header).
import { PaymentWebhookController } from "./payments/webhook.controller";
// PV5-10: Finance's list of payment notices needing a person, and the re-drive of a failed one.
import { PaymentEventsController } from "./payments/redrive.controller";
// PV-D41: the simulated Midtrans (review stage, flag-gated): its own API under /internal/, and the portal's simulated page.
import { MidtransSimulatorController } from "./payments/simulator.controller";
import { SimulatedPaymentPortalController } from "./payments/simulator-portal.controller";
// PV5-11 / PV-D43 — certified signing: the ERP's routes, the provider webhook, and the SIMULATED PSrE's pages (404 while
// SIGNATURE_SIMULATION_ENABLED is off).
import { CertifiedSigningController } from "./signatures/certified-signing.controller";
import { SignatureWebhookController } from "./signatures/webhook.controller";
import { SimulatedPsreController } from "./signatures/simulated-psre.controller";
import { FilesController } from "./core/files.controller";
import { CreativeController } from "./core/creative.controller";
import { WorkActivityController } from "./core/work-activity.controller";
import { ActivitySeriesController } from "./core/activity-series.controller";
import { IntegrationsController } from "./core/integrations.controller";
import { FigmaController } from "./core/figma/figma.controller";
import { GoogleDriveController, GoogleDriveOauthCallbackController } from "./core/google-drive/google-drive.controller";
import { GmailController, GmailOauthCallbackController } from "./core/gmail/gmail.controller";
import { ClaudeSeatsController } from "./core/claude-seats.controller";
import { AdminIdentityController } from "./admin/admin-identity.controller";
import { CompanyAdminController } from "./admin/company-admin.controller";
import { EmployeesController } from "./admin/employees.controller";
import { PositionsController } from "./admin/positions.controller";
import { RoleGrantsController } from "./admin/role-grants.controller";
import { ItAccountsController } from "./admin/it-accounts.controller";
import { ItSecurityController } from "./admin/it-security.controller";
import { ServiceAssignmentsController } from "./admin/service-assignments.controller";
import { CompanyCrudController } from "./admin/company-crud.controller";
import { AdminSystemsController } from "./admin/admin-systems.controller";
import { AutomationFailuresController } from "./admin/automation-failures.controller";
import { ObservabilityController } from "./admin/observability.controller";
import { AgentsController } from "./admin/agents.controller";
import { MonitoringController, MonitoringHeartbeatController } from "./modules/monitoring/monitoring.controller";
import { BotAdminController } from "./admin/bot-admin.controller";
import { IntelligenceController } from "./admin/intelligence.controller";
// DW-8i (§46): knowledge search for staff, filtered per hit by the caller's read right on the source record.
import { KnowledgeSearchController } from "./modules/knowledge/search.controller";
import { AgencyController } from "./modules/agency/agency.controller";
import { PmController } from "./modules/pm/pm.controller";
import { ItController } from "./modules/it/it.controller";
import { FinanceController } from "./modules/finance/finance.controller";
// DW-7j-5: the GM's monthly revenue plan, /api/:t/revenue-plan (BFF §40.6.4; finance module wall, dept_kpi_target authz).
import { RevenuePlanController } from "./modules/finance/revenue-plan.controller";
import { FinanceAccountsController } from "./modules/finance/finance-accounts.controller";
import { ClientsController } from "./modules/clients/clients.controller";
import { ClientReportsController } from "./modules/clients/client-reports.controller";
import { ClientsCentreController } from "./modules/clients/centre/clients-centre.controller";
import { CentreDiscoveryController } from "./modules/clients/centre/centre-discovery.controller";
import { PortalCentreController } from "./core/portal-centre.controller";
import { HrController } from "./modules/hr/hr.controller";
// PV6-02: Client Centre Services & results (staff route under `clients`, portal route in core).
import { CentreResultsController } from "./modules/clients/centre/centre-results.controller";
import { PortalCentreResultsController } from "./core/portal-centre-results.controller";
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
import { SearchAnalyticsController } from "./modules/search/search-analytics.controller";
import { SearchContentDecayController } from "./modules/search/content-decay.controller";
import { SearchConversionsController } from "./modules/search/conversions.controller";
import { SearchVisitorsController } from "./modules/search/visitors.controller";
import { SearchAiCrawlerController } from "./modules/search/ai-crawler.controller";
import { SearchExperimentsController } from "./modules/search/experiments.controller";
import { SearchIndexNowController } from "./modules/search/indexnow.controller";
import { SearchReplaysController } from "./modules/search/replays.controller";
import { ReportsController } from "./modules/reports/reports.controller";
import { GroupReportController } from "./modules/reports/group-report.controller"; // PV1-06a
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
// WSK-23: /api/:t/modules/webdev/console/* (site registry · releases · submissions · contract
// pin-vs-latest) — the ERP console's read model, NEW FILE under src/modules/webdev/ (the ticket's
// hard constraint forbids editing any EXISTING file there except index.ts; this is not that).
import { ConsoleReadsController } from "./modules/webdev/console-reads.controller";
// WSK-31: /api/:t/modules/webdev/control/* — the §07 WebDesk control-plane MCP tool set's Zone A
// HTTP surface. Every route is an honest 501 stub pending WSK-23's Zone B egress client (see that
// file's own header). NEW FILE under src/modules/webdev/ (this ticket's hard constraint permits new
// files there; it forbids editing an EXISTING one other than index.ts).
import { WebdeskControlController } from "./modules/webdev/webdesk-control.controller";
// WSK-59: /api/:t/modules/webdev/content/* — the content BFF (reads, drafts, publish-requests, unpublish/delete).
import { WebdeskContentController } from "./modules/webdev/webdesk-content.controller";
import { WebdeskSiteClientsController } from "./modules/webdev/webdesk-site-clients.controller";
import { WebdeskEditorialGrantsController } from "./modules/webdev/webdesk-editorial-grants.controller";
// M5-W4: /api/:t/modules/webdev/content/sites/:slug/:siteId/briefs — content briefs from search, linked to a WebDesk draft.
import { WebdeskBriefsController } from "./modules/webdev/webdesk-briefs.controller";
import { WebdeskClientWebsiteController } from "./modules/webdev/webdesk-client-website.controller";
// WSK-60: /api/:t/modules/webdev/content/sites/:slug/:siteId/{build-status,rebuild-requests} — the
// publish → rebuild → staging ledger's read and the editor's "request a rebuild".
import { SiteBuildsController } from "./modules/webdev/site-builds.controller";
import { CheckinsController } from "./modules/reports/checkins.controller"; // TR-09
import { AppraisalsController } from "./modules/reports/appraisals.controller"; // TR-24
import { DeptKpisController } from "./modules/reports/dept-kpis.controller"; // DW-4e-1
import { DeptAppraisalsController } from "./modules/reports/dept-appraisals.controller"; // DW-4e-3
import { DeptKpiWatchController } from "./modules/reports/dept-kpi-watch.controller"; // DW-4j-1
import { PrintPayloadController } from "./modules/reports/print-payload.controller"; // TR-21
import { DocumentPrintPayloadController } from "./core/document-print-payload.controller"; // PV5-07
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
    HealthController, IdentityController, StepUpController, CoreController, CustomFieldsController,
    AuthzCheckController, AuthzPermissionsController, ClientWorkController, InvoiceController, BillingProfileController, BillingProfileAgentController, BillingNumberingController, CollabController, AutomationApprovalsController, PipelineController, ApprovalsController, ApprovalsDecideController, TasksMineController, MeetingRecordingsController, PortalController, PortalWorkspaceController, PortalHealthController, PortalReportsController, PortalCommerceController, PortalDocumentsController, ClientDocumentsController, PortalProfileController, PortalCentreController, PortalStreamController, WebdevChangeRequestsPortalController, SocialClientReviewPortalController, PortalConversationController, ConversationController, WorkRequestsController, CalendarEventsController, WebdevChangeRequestsController, AgencyIntakePortalController, AgencyLeadsController, AgencyLeadConvertController, AgencyPrivacyController, GithubReposController, GithubWebhookController, PaymentWebhookController, PaymentEventsController, SignatureWebhookController, CertifiedSigningController, SimulatedPsreController, MidtransSimulatorController, SimulatedPaymentPortalController, ContractsController, ClientContactsController, ClientInviteAcceptController, ClientWebsiteAccessController, FilesController, CreativeController, WorkActivityController, ActivitySeriesController, IntegrationsController, ClaudeSeatsController, AdminIdentityController, FigmaController, GoogleDriveController, GoogleDriveOauthCallbackController, GmailController, GmailOauthCallbackController,
    CompanyAdminController, EmployeesController, PositionsController, RoleGrantsController, ItAccountsController, ItSecurityController, ServiceAssignmentsController, CompanyCrudController, AdminSystemsController, AutomationFailuresController, ObservabilityController, AgentsController, MonitoringController, MonitoringHeartbeatController, BotAdminController, IntelligenceController, KnowledgeSearchController,
    // Vertical modules (compiled-in; per-tenant enable gate at the controller).
    AgencyController, PmController, ItController, FinanceController, FinanceAccountsController, ClientsController, ClientReportsController, ClientsCentreController, CentreDiscoveryController, HrController, LoansController,
    HrPolicyController, RecruitmentController, PayrollController, HrLifecycleController,
    LmsCatalogueController, LmsLearnController,
    CentreResultsController, PortalCentreResultsController,
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
    // M5-A4: Umami website-analytics reads for a property (own controller class; same prefix).
    SearchAnalyticsController,
    SearchContentDecayController,
    SearchConversionsController,
    SearchVisitorsController,
    SearchAiCrawlerController,
    SearchExperimentsController,
    SearchIndexNowController,
    SearchReplaysController,
    // PRV-02: /api/:t/modules/webdev/* (provision · provisioned-sites · reconcile).
    WebdevController,
    ZoneBEventsController,
    // WSK-19: /api/:t/modules/webdev/contracts[/refresh] (the one-rail contract-snapshot mirror).
    ContractSnapshotsController,
    // WSK-23: /api/:t/modules/webdev/console/* (the ERP console's read model over WebDesk).
    ConsoleReadsController,
    // WSK-31: /api/:t/modules/webdev/control/* (the §07 MCP tool set's Zone A surface; honest 501s).
    WebdeskControlController,
    // WSK-59: the content BFF over the WebDesk control channel.
    WebdeskContentController,
    // WSK-49c: which client a WebDesk site serves (staff-managed link) and the CLIENT-MODE website BFF under the
    // portal's own prefix, /api/:t/portal/clients/:clientId/website/*.
    WebdeskSiteClientsController,
    WebdeskEditorialGrantsController,
    WebdeskBriefsController,
    WebdeskClientWebsiteController,
    // WSK-60: build-status + rebuild-requests (the staging rebuild ledger).
    SiteBuildsController,
    // TR-07: reports admin/ops surface (facts recompute). §6.2 routes it at /api/:t/reports/*,
    // not /api/:t/modules/reports/*, so it is listed with the verticals but mounts top-level.
    ReportsController,
    // PV1-06a: the group report, /api/:t/reports/group (root owner or platform_admin; no module guard
    // on the root — see the controller header).
    GroupReportController,
    // TR-09: check-in subsystem, /api/:t/checkins/* (own top-level prefix, own controller class).
    CheckinsController,
    // TR-24: appraisal engine, /api/:t/appraisals/* (own top-level prefix, own controller class —
    // deliberately NEVER registered in ModuleContract.mcpTools, §9.2/standing ruling: appraisal
    // read/write must never be reachable by an agent).
    AppraisalsController,
    // DW-4e-1: department KPIs, /api/:t/dept-kpis/* (targets, condition and standing; own top-level prefix, no MCP tool).
    DeptKpisController,
    DeptAppraisalsController,
    DeptKpiWatchController,
    // DW-7j-5: the GM's revenue plan, /api/:t/revenue-plan (finance module wall; no MCP tool).
    RevenuePlanController,
    // TR-21: the internal, token-only PDF payload fetch — root-level, no `/api` prefix, no
    // guards (identity.controller.ts's precedent). See print-payload.controller.ts's own header.
    PrintPayloadController,
    // PV5-07: the same token-only payload fetch for the invoice and sealed-contract print routes.
    DocumentPrintPayloadController,
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
