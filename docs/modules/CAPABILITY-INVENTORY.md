# Capability inventory — every MCP-reachable capability in the estate

🤖 **GENERATED — do not edit by hand.** From `platform-nest/`:
`UPDATE_INVENTORY=1 npx vitest run src/modules/capability-inventory.test.ts`
(PowerShell: `$env:UPDATE_INVENTORY=1; npx vitest run src/modules/capability-inventory.test.ts`).
Drift fails that suite, so this file cannot quietly describe an estate that no longer exists.

Satisfies the agentic-native **exit-bar criterion 6**: one row per capability naming its
endpoint, its MCP tool and its D14 impact class. The criterion's own test is that the table
*can be generated* — a hand-kept one only ever describes the estate as someone last
remembered it.

**Not covered here, deliberately:** typed refusal vocabulary and `work_activity` coverage are
not derivable from a tool definition. `social-capability-inventory.md` (SMM-33) covers those
for one module by reading its controllers directly — the deeper treatment, of which this is
the estate-wide spine, not a replacement.

## Totals

- **224** capabilities across **16** owners
- **118** writes · 106 reads
- Writes by impact: **high 24** · medium 36 · low 58

`high`/`medium` writes suspend for a human decision when the caller is unattended (D14, and
see PERMISSION-CONTRACT §15 on why that is keyed on attendance rather than identity). `low`
writes run directly. A write with NO impact class cannot exist — `impact-registry.test.ts`
fails the build on one.

An endpoint of — means the tool is declared but not callable over the hub (no
`pathTemplate`), which the hub skips outright. Those are stubs awaiting their dispatch work.

## Golden cases — does a test drive the real endpoint?

Readiness-bar **criterion 7** / exit-bar criterion 5. Its failure signal is mechanical —
"No test drives the real endpoint" — so this is DERIVED (route family from each tool's own
`pathTemplate`, then a scan for suites that call `app.inject` against it), never asserted.
A hand-kept list of which departments have an eval is true the day it is written and
unfalsifiable after.

| Owner | Route families | Suites driving the real endpoint |
|---|---|---|
| agency | `agency` | 16 |
| assistant | `assistant` | 15 |
| automation-console | `admin/automation` | 3 |
| clients | `clients` | 14 |
| core | `agency` · `contracts` · `contracts?clientId=:clientId` · `invoice-payments` · `invoice-payments?clientId=:clientId` · `positions` · `role-grants` | 29 |
| finance | `finance` | 1 |
| hr | `hr` | 11 |
| invoice | `invoices` | 5 |
| it | `it` | 4 |
| knowledge | `knowledge` | 2 |
| monitoring | `monitoring` | 3 |
| pm | `pm` | 10 |
| reports | `checkins` · `reports` | 17 |
| search | `search` | 23 |
| social | `social` | 13 |
| webdev | `webdev` | 30 |

## Capabilities

| Owner | Tool | Method | Endpoint | Kind | Impact |
|---|---|---|---|---|---|
| agency | `agency.listCampaigns` | `GET` | `/api/:tenantId/modules/agency/campaigns` | read | — |
| agency | `agency.pendingApprovals` | `GET` | `/api/:tenantId/modules/agency/approvals/pending` | read | — |
| assistant | `orchestrator.ask` | `POST` | `/api/:tenantId/assistant/ask` | write | `low` |
| automation-console | `automation.listWorkflows` | `GET` | `/api/admin/automation/workflows` | read | — |
| clients | `clients.listClients` | `GET` | `/api/:tenantId/clients` | read | — |
| core | `agency_intake.convert` | `POST` | `/api/:tenantId/agency/leads/:leadId/convert` | write | `medium` |
| core | `agency_intake.createFromWebSubmission` | `POST` | `/api/:tenantId/agency/leads/from-web-submission` | write | `medium` |
| core | `agency_intake.decline` | `POST` | `/api/:tenantId/agency/leads/:leadId/decline` | write | `low` |
| core | `agency_intake.getLead` | `GET` | `/api/:tenantId/agency/leads/:leadId` | read | — |
| core | `agency_intake.invite` | `POST` | `/api/:tenantId/agency/leads/:leadId/invite` | write | `low` |
| core | `agency_intake.listLeads` | `GET` | `/api/:tenantId/agency/leads` | read | — |
| core | `agency_intake.listSubmissions` | `GET` | `/api/:tenantId/agency/leads/:leadId/submissions` | read | — |
| core | `agency_intake.listWebLeads` | `GET` | `/api/:tenantId/agency/web-leads/:siteSlug` | read | — |
| core | `agency_intake.nurture` | `POST` | `/api/:tenantId/agency/leads/:leadId/nurture` | write | `low` |
| core | `agency_intake.open` | `POST` | `/api/:tenantId/agency/leads/:leadId/open` | write | `low` |
| core | `agency_pipeline.moveStage` | `POST` | `/api/:tenantId/agency/leads/:leadId/stage` | write | `low` |
| core | `agency_pipeline.reference` | `GET` | `/api/:tenantId/agency/pipeline/reference` | read | — |
| core | `agency_pipeline.setDealValue` | `POST` | `/api/:tenantId/agency/leads/:leadId/deal` | write | `low` |
| core | `agency_pipeline.stageHistory` | `GET` | `/api/:tenantId/agency/leads/:leadId/stage-history` | read | — |
| core | `agency_privacy.erase` | `POST` | `/api/:tenantId/agency/privacy/erase` | write | `high` |
| core | `agency_privacy.export` | `POST` | `/api/:tenantId/agency/privacy/export` | write | `high` |
| core | `agency_privacy.find` | `POST` | `/api/:tenantId/agency/privacy/find` | write | `high` |
| core | `contracts.countersign` | `POST` | `/api/:tenantId/contracts/:contractId/countersign` | write | `high` |
| core | `contracts.createDraft` | `POST` | `/api/:tenantId/contracts` | write | `low` |
| core | `contracts.get` | `GET` | `/api/:tenantId/contracts/:contractId` | read | — |
| core | `contracts.list` | `GET` | `/api/:tenantId/contracts?clientId=:clientId` | read | — |
| core | `contracts.send` | `POST` | `/api/:tenantId/contracts/:contractId/send` | write | `medium` |
| core | `contracts.updateDraft` | `PATCH` | `/api/:tenantId/contracts/:contractId` | write | `low` |
| core | `iam.assignPosition` | `POST` | `/api/:tenantId/positions/:positionId/assign` | write | `medium` |
| core | `iam.grantRole` | `POST` | `/api/:tenantId/role-grants` | write | `high` |
| core | `iam.listAttachableRoles` | `GET` | `/api/:tenantId/positions/attachable-roles` | read | — |
| core | `iam.listPositions` | `GET` | `/api/:tenantId/positions` | read | — |
| core | `iam.listRoleGrants` | `GET` | `/api/:tenantId/role-grants` | read | — |
| core | `iam.requestAssignment` | `POST` | `/api/:tenantId/positions/:positionId/assignment-requests` | write | `low` |
| core | `iam.requestOverride` | `POST` | `/api/:tenantId/role-grants/overrides` | write | `low` |
| core | `iam.revokeRoleGrant` | `DELETE` | `/api/:tenantId/role-grants/:grantId` | write | `medium` |
| core | `iam.unassignPosition` | `POST` | `/api/:tenantId/positions/:positionId/unassign` | write | `medium` |
| core | `invoicePayments.decide` | `POST` | `/api/:tenantId/invoice-payments/:paymentId/decide` | write | `high` |
| core | `invoicePayments.list` | `GET` | `/api/:tenantId/invoice-payments?clientId=:clientId` | read | — |
| finance | `finance.apAging` | `GET` | `/api/:tenantId/finance/ap/aging` | read | — |
| finance | `finance.arAging` | `GET` | `/api/:tenantId/finance/ar/aging` | read | — |
| finance | `finance.balanceSheet` | `GET` | `/api/:tenantId/finance/balance-sheet` | read | — |
| finance | `finance.closeReadiness` | `GET` | `/api/:tenantId/finance/periods/:periodId/close-readiness` | read | — |
| finance | `finance.profitAndLoss` | `GET` | `/api/:tenantId/finance/profit-and-loss` | read | — |
| finance | `finance.trialBalance` | `GET` | `/api/:tenantId/finance/trial-balance` | read | — |
| hr | `hr.fileLeave` | `POST` | `/api/:tenantId/modules/hr/leave` | write | `medium` |
| hr | `hr.getAnalytics` | `GET` | `/api/:tenantId/modules/hr/analytics` | read | — |
| hr | `hr.getEmployee` | `GET` | `/api/:tenantId/hr/employees/:employeeId` | read | — |
| hr | `hr.getLeaveLedger` | `GET` | `/api/:tenantId/modules/hr/leave/ledger` | read | — |
| hr | `hr.getRecruitmentFunnel` | `GET` | `/api/:tenantId/modules/hr/recruitment/funnel` | read | — |
| hr | `hr.getWorkingDays` | `GET` | `/api/:tenantId/modules/hr/working-days` | read | — |
| hr | `hr.hireEmployee` | `POST` | `/api/:tenantId/hr/employees` | write | `medium` |
| hr | `hr.listCases` | `GET` | `/api/:tenantId/modules/hr/cases` | read | — |
| hr | `hr.listEmployees` | `GET` | `/api/:tenantId/hr/employees` | read | — |
| hr | `hr.listExpiringDocuments` | `GET` | `/api/:tenantId/modules/hr/compliance/expiring` | read | — |
| hr | `hr.listLeave` | `GET` | `/api/:tenantId/modules/hr/leave` | read | — |
| hr | `hr.listLoans` | `GET` | `/api/:tenantId/modules/hr/loans` | read | — |
| hr | `hr.listPayslips` | `GET` | `/api/:tenantId/modules/hr/payslips` | read | — |
| hr | `hr.listRequisitions` | `GET` | `/api/:tenantId/modules/hr/requisitions` | read | — |
| hr | `hr.previewSeverance` | `GET` | `/api/:tenantId/modules/hr/separations/preview` | read | — |
| hr | `hr.requestLoan` | `POST` | `/api/:tenantId/modules/hr/loans` | write | `high` |
| hr | `hr.terminateEmployee` | `POST` | `/api/:tenantId/hr/employees/:employeeId/terminate` | write | `high` |
| hr | `hr.transferEmployee` | `POST` | `/api/:tenantId/hr/employees/:employeeId/transfer` | write | `medium` |
| invoice | `invoice.listInvoices` | `GET` | `/api/:tenantId/invoices` | read | — |
| it | `it.listDevices` | `GET` | `/api/:tenantId/it/devices` | read | — |
| knowledge | `knowledge.listSources` | `GET` | `/api/:tenantId/knowledge/sources` | read | — |
| monitoring | `monitoring.listMonitors` | `GET` | `/api/:tenantId/monitoring/monitors` | read | — |
| monitoring | `monitoring.monitorDetail` | `GET` | `/api/:tenantId/monitoring/monitors/:id` | read | — |
| monitoring | `monitoring.openIncidents` | `GET` | `/api/:tenantId/monitoring/incidents` | read | — |
| pm | `pm.listTasks` | `GET` | `/api/:tenantId/pm/tasks` | read | — |
| pm | `pm.runTracker` | `POST` | `/api/:tenantId/pm/tasks/:taskId/tracker/run` | write | `low` |
| reports | `checkin.getToday` | `GET` | `/api/:tenantId/checkins/today` | read | — |
| reports | `checkin.submit` | `POST` | `/api/:tenantId/checkins` | write | `low` |
| reports | `reports.getCompliance` | `GET` | `/api/:tenantId/checkins/compliance?unit=:unit&periodKind=:periodKind&start=:start&end=:end` | read | — |
| reports | `reports.getDocument` | `GET` | `/api/:tenantId/reports/document?grain=:grain&scopeRef=:scopeRef&periodKind=:periodKind&start=:start&end=:end` | read | — |
| reports | `reports.getMetrics` | `GET` | `/api/:tenantId/reports/metrics?metricKey=:metricKey&grain=:grain&from=:from&to=:to` | read | — |
| reports | `reports.listPeriods` | `GET` | `/api/:tenantId/reports/periods?kind=:kind&from=:from&to=:to` | read | — |
| search | `search.acknowledgeDecayFinding` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/acknowledge` | write | `low` |
| search | `search.aiCrawlers.ingest` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/ai-crawlers/ingest` | write | `medium` |
| search | `search.aiCrawlers.summary` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/ai-crawlers/summary/range/:from/:to` | read | — |
| search | `search.aiVisibility.summary` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/ai-visibility-summary` | read | — |
| search | `search.analyticsCtas` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/ctas/range/:from/:to` | read | — |
| search | `search.analyticsForms` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/forms/range/:from/:to` | read | — |
| search | `search.analyticsPages` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/pages/range/:from/:to` | read | — |
| search | `search.analyticsSections` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/sections/range/:from/:to` | read | — |
| search | `search.analyticsSources` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/sources/range/:from/:to` | read | — |
| search | `search.analyticsSummary` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/summary/range/:from/:to` | read | — |
| search | `search.analyticsVitals` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/analytics/vitals/range/:from/:to` | read | — |
| search | `search.applyNegatives` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
| search | `search.approveReport` | `POST` | `/api/:tenantId/modules/search/reports/:id/approve` | write | `low` |
| search | `search.auditSummary` | — | — | read | — |
| search | `search.clusterKeywords` | `POST` | `/api/:tenantId/modules/search/keyword-sets/:setId/cluster` | write | `low` |
| search | `search.deliverReport` | `POST` | `/api/:tenantId/modules/search/reports/:id/deliver` | write | `medium` |
| search | `search.draftBrief` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/briefs` | write | `low` |
| search | `search.draftReport` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/reports` | write | `low` |
| search | `search.editReport` | `PATCH` | `/api/:tenantId/modules/search/reports/:id` | write | `low` |
| search | `search.exportProposal` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/export` | write | `low` |
| search | `search.fileRefreshBrief` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/refresh-brief` | write | `low` |
| search | `search.keywordResearch` | — | — | write | `medium` |
| search | `search.launchCampaign` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
| search | `search.ledgerSummary` | — | — | read | — |
| search | `search.listConversionTargets` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/conversion-targets` | read | — |
| search | `search.listConversionUploads` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/conversion-uploads` | read | — |
| search | `search.listDecayFindings` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/decay` | read | — |
| search | `search.listEngagements` | `GET` | `/api/:tenantId/modules/search/engagements` | read | — |
| search | `search.listLeadConversionUploads` | `GET` | `/api/:tenantId/modules/search/leads/:leadId/conversion-uploads` | read | — |
| search | `search.previewReport` | `GET` | `/api/:tenantId/modules/search/reports/:id/preview` | read | — |
| search | `search.proposeNegatives` | `POST` | `/api/:tenantId/modules/search/campaigns/:campaignId/negatives/propose` | write | `low` |
| search | `search.publishContent` | — | — | write | `high` |
| search | `search.pullAiVisibility` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/ai-visibility-pull` | write | `medium` |
| search | `search.pullBacklinks` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/backlinks-pull` | write | `medium` |
| search | `search.pullRanks` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/rank-pull` | write | `medium` |
| search | `search.rankSummary` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/rank-snapshots` | read | — |
| search | `search.runAudit` | — | — | write | `low` |
| search | `search.setBudget` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
| search | `search.setConversionTarget` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/conversion-targets` | write | `low` |
| social | `social.addPostVariant` | `POST` | `/api/:tenantId/modules/social/posts/:postId/variants` | write | `low` |
| social | `social.approvePostVariant` | `POST` | `/api/:tenantId/modules/social/variants/:variantId/approve` | write | `high` |
| social | `social.approveReplyDraft` | `POST` | `/api/:tenantId/modules/social/threads/:threadId/messages/:messageId/approve` | write | `low` |
| social | `social.approveReport` | `POST` | `/api/:tenantId/modules/social/reports/:id/approve` | write | `low` |
| social | `social.checkPublishPreconditions` | `GET` | `/api/:tenantId/modules/social/variants/:variantId/publish-preconditions` | read | — |
| social | `social.checkReplySendPreconditions` | `GET` | `/api/:tenantId/modules/social/threads/:threadId/messages/:messageId/send-preconditions` | read | — |
| social | `social.createEngagement` | `POST` | `/api/:tenantId/modules/social/engagements` | write | `low` |
| social | `social.createPost` | `POST` | `/api/:tenantId/modules/social/posts` | write | `low` |
| social | `social.createReplyDraft` | `POST` | `/api/:tenantId/modules/social/threads/:threadId/messages` | write | `low` |
| social | `social.deliverReport` | `POST` | `/api/:tenantId/modules/social/reports/:id/deliver` | write | `medium` |
| social | `social.draftContentBrief` | `POST` | `/api/:tenantId/modules/social/engagements/:engagementId/agent-content-brief` | write | `low` |
| social | `social.draftPostIdeas` | `POST` | `/api/:tenantId/modules/social/posts/draft-ideas` | write | `low` |
| social | `social.draftPostVariant` | `POST` | `/api/:tenantId/modules/social/posts/:postId/variants/:variantId/draft-caption` | write | `low` |
| social | `social.draftReport` | `POST` | `/api/:tenantId/modules/social/engagements/:engagementId/reports` | write | `low` |
| social | `social.editReport` | `PATCH` | `/api/:tenantId/modules/social/reports/:id` | write | `low` |
| social | `social.getBestTimeToPost` | `GET` | `/api/:tenantId/modules/social/accounts/:accountId/best-time` | read | — |
| social | `social.getClientReview` | `GET` | `/api/:tenantId/modules/social/variants/:variantId/client-review` | read | — |
| social | `social.getEngagementScope` | `GET` | `/api/:tenantId/modules/social/engagements/:engagementId/scope` | read | — |
| social | `social.getEngagementSummary` | `GET` | `/api/:tenantId/modules/social/engagements/:engagementId/assistant-summary` | read | — |
| social | `social.getPublisherStatus` | `GET` | `/api/:tenantId/modules/social/publisher/status` | read | — |
| social | `social.getReport` | `GET` | `/api/:tenantId/modules/social/reports/:id` | read | — |
| social | `social.getUsage` | `GET` | `/api/:tenantId/modules/social/engagements/:engagementId/usage` | read | — |
| social | `social.importNativePost` | `POST` | `/api/:tenantId/modules/social/posts/import-native` | write | `low` |
| social | `social.ingestBrandCorpus` | `POST` | `/api/:tenantId/modules/social/engagements/:engagementId/brand-corpus/ingest` | write | `low` |
| social | `social.listAccounts` | `GET` | `/api/:tenantId/modules/social/accounts` | read | — |
| social | `social.listEngagements` | `GET` | `/api/:tenantId/modules/social/engagements` | read | — |
| social | `social.listPosts` | `GET` | `/api/:tenantId/modules/social/posts` | read | — |
| social | `social.listReports` | `GET` | `/api/:tenantId/modules/social/reports` | read | — |
| social | `social.listThreadMessages` | `GET` | `/api/:tenantId/modules/social/threads/:threadId/messages` | read | — |
| social | `social.provisionPublisherOrg` | `POST` | `/api/:tenantId/modules/social/publisher-orgs` | write | `medium` |
| social | `social.publishPost` | `POST` | `/api/:tenantId/modules/social/variants/:variantId/publish` | write | `high` |
| social | `social.publishPostMetered` | `POST` | `/api/:tenantId/modules/social/variants/:variantId/publish-metered` | write | `high` |
| social | `social.requestClientReview` | `POST` | `/api/:tenantId/modules/social/variants/:variantId/client-review` | write | `medium` |
| social | `social.sendReply` | `POST` | `/api/:tenantId/modules/social/threads/:threadId/messages/:messageId/send` | write | `high` |
| social | `social.setEngagementScope` | `PATCH` | `/api/:tenantId/modules/social/engagements/:engagementId/scope` | write | `medium` |
| social | `social.syncConnectorRegistry` | `POST` | `/api/:tenantId/modules/social/publisher-orgs/:clientId/sync` | write | `low` |
| social | `social.updateReplyDraft` | `PATCH` | `/api/:tenantId/modules/social/threads/:threadId/messages/:messageId` | write | `low` |
| social | `social.validateVariant` | `GET` | `/api/:tenantId/modules/social/variants/:variantId/validation` | read | — |
| social | `social.withdrawClientReview` | `POST` | `/api/:tenantId/modules/social/variants/:variantId/client-review/withdraw` | write | `low` |
| webdev | `webdesk.briefs.assign` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs/:briefId/assign` | write | `low` |
| webdev | `webdesk.briefs.create` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs` | write | `low` |
| webdev | `webdesk.briefs.createDraft` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs/:briefId/create-draft` | write | `low` |
| webdev | `webdesk.briefs.forItem` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/brief` | read | — |
| webdev | `webdesk.briefs.get` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs/:briefId` | read | — |
| webdev | `webdesk.briefs.list` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs` | read | — |
| webdev | `webdesk.briefs.update` | `PATCH` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs/:briefId` | write | `low` |
| webdev | `webdesk.content.assist` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/assist` | write | `low` |
| webdev | `webdesk.content.create` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items` | write | `low` |
| webdev | `webdesk.content.delete` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/delete` | write | `medium` |
| webdev | `webdesk.content.getItem` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId` | read | — |
| webdev | `webdesk.content.getVersion` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions/:n` | read | — |
| webdev | `webdesk.content.listCollections` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections` | read | — |
| webdev | `webdesk.content.listItems` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items` | read | — |
| webdev | `webdesk.content.listMedia` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media` | read | — |
| webdev | `webdesk.content.listSites` | `GET` | `/api/:tenantId/modules/webdev/content/sites` | read | — |
| webdev | `webdesk.content.listVersions` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions` | read | — |
| webdev | `webdesk.content.preview` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/preview` | write | `medium` |
| webdev | `webdesk.content.requestPublish` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/publish-requests` | write | `low` |
| webdev | `webdesk.content.restoreVersion` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/restore` | write | `low` |
| webdev | `webdesk.content.unpublish` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/unpublish` | write | `medium` |
| webdev | `webdesk.content.update` | `PATCH` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId` | write | `low` |
| webdev | `webdesk.contract.regenerate` | `POST` | `/api/:tenantId/modules/webdev/control/contract/regenerate` | write | `medium` |
| webdev | `webdesk.deploy.staging` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/deploy/staging` | write | `medium` |
| webdev | `webdesk.editorial.approve` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/approve` | write | `medium` |
| webdev | `webdesk.editorial.assign` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/assign` | write | `low` |
| webdev | `webdesk.editorial.board` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/board` | read | — |
| webdev | `webdesk.editorial.calendar` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/calendar` | read | — |
| webdev | `webdesk.editorial.comment` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/comments` | write | `low` |
| webdev | `webdesk.editorial.grantRole` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants` | write | `high` |
| webdev | `webdesk.editorial.history` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial` | read | — |
| webdev | `webdesk.editorial.listGrants` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants` | read | — |
| webdev | `webdesk.editorial.requestChanges` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/request-changes` | write | `low` |
| webdev | `webdesk.editorial.resolveComment` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/comments/:commentId/resolve` | write | `low` |
| webdev | `webdesk.editorial.revokeRole` | `DELETE` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants/:userId/:role` | write | `medium` |
| webdev | `webdesk.editorial.seoSignoff` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/seo-signoff` | write | `medium` |
| webdev | `webdesk.editorial.setPolicy` | `PATCH` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/editorial-policy` | write | `medium` |
| webdev | `webdesk.editorial.submit` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/submit` | write | `low` |
| webdev | `webdesk.editorial.withdraw` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/withdraw` | write | `low` |
| webdev | `webdesk.forms.define` | `PATCH` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey` | write | `medium` |
| webdev | `webdesk.forms.get` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms/:formKey` | read | — |
| webdev | `webdesk.forms.list` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/forms` | read | — |
| webdev | `webdesk.key.mint` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/keys` | write | `high` |
| webdev | `webdesk.key.revoke` | `POST` | `/api/:tenantId/modules/webdev/control/keys/:keyId/revoke` | write | `high` |
| webdev | `webdesk.key.rotate` | `POST` | `/api/:tenantId/modules/webdev/control/keys/:keyId/rotate` | write | `high` |
| webdev | `webdesk.listSites` | `GET` | `/api/:tenantId/modules/webdev/control/sites` | read | — |
| webdev | `webdesk.listSubmissions` | `GET` | `/api/:tenantId/modules/webdev/control/sites/:siteId/submissions` | read | — |
| webdev | `webdesk.media.delete` | `DELETE` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId` | write | `medium` |
| webdev | `webdesk.media.list` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media` | read | — |
| webdev | `webdesk.media.update` | `PATCH` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId` | write | `medium` |
| webdev | `webdesk.media.uploadToken` | `POST` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/upload-token` | write | `medium` |
| webdev | `webdesk.media.usage` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId/usage` | read | — |
| webdev | `webdesk.schema.apply` | `POST` | `/api/:tenantId/modules/webdev/control/schema/apply` | write | `medium` |
| webdev | `webdesk.schema.propose` | `POST` | `/api/:tenantId/modules/webdev/control/schema/propose` | write | `low` |
| webdev | `webdesk.site.archive` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/archive` | write | `high` |
| webdev | `webdesk.site.promote` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/promote` | write | `high` |
| webdev | `webdesk.site.provision` | `POST` | `/api/:tenantId/modules/webdev/control/sites` | write | `medium` |
| webdev | `webdesk.site.rollback` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/rollback` | write | `high` |
| webdev | `webdesk.site.setDomain` | `POST` | `/api/:tenantId/modules/webdev/control/sites/:siteId/domain` | write | `high` |
| webdev | `webdesk.siteStatus` | `GET` | `/api/:tenantId/modules/webdev/control/sites/:siteId/status` | read | — |
| webdev | `webdesk.writers.dashboard` | `GET` | `/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/writers/dashboard` | read | — |
| webdev | `webdev.contracts.artifact` | `GET` | `/api/:tenantId/modules/webdev/contracts/:snapshotId/artifacts/:artifact` | read | — |
| webdev | `webdev.contracts.get` | `GET` | `/api/:tenantId/modules/webdev/contracts/:snapshotId` | read | — |
| webdev | `webdev.provisionedSites.commitScaffold` | `POST` | `/api/:tenantId/modules/webdev/provisioned-sites/:siteId/scaffold-commit` | write | `low` |
| webdev | `webdev.provisionedSites.get` | `GET` | `/api/:tenantId/modules/webdev/provisioned-sites/:siteId` | read | — |
| webdev | `webdev.provisionedSites.list` | `GET` | `/api/:tenantId/modules/webdev/provisioned-sites?runId=:runId` | read | — |
| webdev | `webdev.provisionSite` | `POST` | `/api/:tenantId/modules/webdev/provision` | write | `medium` |
| webdev | `webdev.recordZoneBEvent` | `POST` | `/api/:tenantId/modules/webdev/zoneb-events` | write | `low` |
| webdev | `webdev.refreshContract` | `POST` | `/api/:tenantId/modules/webdev/contracts/refresh` | write | `medium` |
