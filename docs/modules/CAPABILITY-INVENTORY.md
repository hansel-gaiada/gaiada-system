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

- **100** capabilities across **15** owners
- **56** writes · 44 reads
- Writes by impact: **high 11** · medium 16 · low 29

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
| agency | `agency` | 7 |
| assistant | `assistant` | 14 |
| automation-console | `admin/automation` | 2 |
| billing | `invoices` | 2 |
| clients | `clients` | 4 |
| core | `positions` · `role-grants` | 3 |
| hr | `hr` | 10 |
| it | `it` | 4 |
| knowledge | `knowledge` | 2 |
| monitoring | `monitoring` | 2 |
| pm | `pm` | 9 |
| reports | `checkins` · `reports` | 15 |
| search | `search` | 16 |
| social | `social` | 12 |
| webdev | `webdev` | 4 |

## Capabilities

| Owner | Tool | Method | Endpoint | Kind | Impact |
|---|---|---|---|---|---|
| agency | `agency.listCampaigns` | `GET` | `/api/:tenantId/modules/agency/campaigns` | read | — |
| agency | `agency.pendingApprovals` | `GET` | `/api/:tenantId/modules/agency/approvals/pending` | read | — |
| assistant | `orchestrator.ask` | `POST` | `/api/:tenantId/assistant/ask` | write | `low` |
| automation-console | `automation.listWorkflows` | `GET` | `/api/admin/automation/workflows` | read | — |
| billing | `billing.listInvoices` | `GET` | `/api/:tenantId/invoices` | read | — |
| clients | `clients.listClients` | `GET` | `/api/:tenantId/clients` | read | — |
| core | `iam.assignPosition` | `POST` | `/api/:tenantId/positions/:positionId/assign` | write | `medium` |
| core | `iam.grantRole` | `POST` | `/api/:tenantId/role-grants` | write | `high` |
| core | `iam.listAttachableRoles` | `GET` | `/api/:tenantId/positions/attachable-roles` | read | — |
| core | `iam.listPositions` | `GET` | `/api/:tenantId/positions` | read | — |
| core | `iam.listRoleGrants` | `GET` | `/api/:tenantId/role-grants` | read | — |
| core | `iam.requestAssignment` | `POST` | `/api/:tenantId/positions/:positionId/assignment-requests` | write | `low` |
| core | `iam.requestOverride` | `POST` | `/api/:tenantId/role-grants/overrides` | write | `low` |
| core | `iam.revokeRoleGrant` | `DELETE` | `/api/:tenantId/role-grants/:grantId` | write | `medium` |
| core | `iam.unassignPosition` | `POST` | `/api/:tenantId/positions/:positionId/unassign` | write | `medium` |
| hr | `hr.fileLeave` | `POST` | `/api/:tenantId/modules/hr/leave` | write | `medium` |
| hr | `hr.getEmployee` | `GET` | `/api/:tenantId/hr/employees/:employeeId` | read | — |
| hr | `hr.hireEmployee` | `POST` | `/api/:tenantId/hr/employees` | write | `medium` |
| hr | `hr.listCases` | `GET` | `/api/:tenantId/modules/hr/cases` | read | — |
| hr | `hr.listEmployees` | `GET` | `/api/:tenantId/hr/employees` | read | — |
| hr | `hr.listLeave` | `GET` | `/api/:tenantId/modules/hr/leave` | read | — |
| hr | `hr.listLoans` | `GET` | `/api/:tenantId/modules/hr/loans` | read | — |
| hr | `hr.requestLoan` | `POST` | `/api/:tenantId/modules/hr/loans` | write | `high` |
| hr | `hr.terminateEmployee` | `POST` | `/api/:tenantId/hr/employees/:employeeId/terminate` | write | `high` |
| hr | `hr.transferEmployee` | `POST` | `/api/:tenantId/hr/employees/:employeeId/transfer` | write | `medium` |
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
| search | `search.applyNegatives` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
| search | `search.approveReport` | `POST` | `/api/:tenantId/modules/search/reports/:id/approve` | write | `low` |
| search | `search.auditSummary` | — | — | read | — |
| search | `search.clusterKeywords` | `POST` | `/api/:tenantId/modules/search/keyword-sets/:setId/cluster` | write | `low` |
| search | `search.deliverReport` | `POST` | `/api/:tenantId/modules/search/reports/:id/deliver` | write | `medium` |
| search | `search.draftBrief` | `POST` | `/api/:tenantId/modules/search/properties/:propertyId/briefs` | write | `low` |
| search | `search.draftReport` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/reports` | write | `low` |
| search | `search.editReport` | `PATCH` | `/api/:tenantId/modules/search/reports/:id` | write | `low` |
| search | `search.exportProposal` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/export` | write | `low` |
| search | `search.keywordResearch` | — | — | write | `medium` |
| search | `search.launchCampaign` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
| search | `search.ledgerSummary` | — | — | read | — |
| search | `search.listEngagements` | `GET` | `/api/:tenantId/modules/search/engagements` | read | — |
| search | `search.previewReport` | `GET` | `/api/:tenantId/modules/search/reports/:id/preview` | read | — |
| search | `search.proposeNegatives` | `POST` | `/api/:tenantId/modules/search/campaigns/:campaignId/negatives/propose` | write | `low` |
| search | `search.publishContent` | — | — | write | `high` |
| search | `search.pullAiVisibility` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/ai-visibility-pull` | write | `medium` |
| search | `search.pullBacklinks` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/backlinks-pull` | write | `medium` |
| search | `search.pullRanks` | `POST` | `/api/:tenantId/modules/search/engagements/:engagementId/rank-pull` | write | `medium` |
| search | `search.rankSummary` | `GET` | `/api/:tenantId/modules/search/properties/:propertyId/rank-snapshots` | read | — |
| search | `search.runAudit` | — | — | write | `low` |
| search | `search.setBudget` | `POST` | `/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api` | write | `high` |
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
| webdev | `webdev.provisionSite` | `POST` | `/api/:tenantId/modules/webdev/provision` | write | `medium` |
