// Per-workflow scoped service accounts (WS4 §3). An automation principal arrives as
// { provider: "n8n", externalId: "wf:<name>" } (set by the n8n workflow's OBO headers).
// Deny-by-default: a workflow may call ONLY the tools listed for its id here, and — via the
// write gate in policy.ts — only LOW-impact writes run unattended (medium+/unclassified
// suspend for human approval, per the locked decision + spec §D14).
//
// This replaces the single shared hub token: instead of one broad principal, each workflow
// is least-privilege. The map is static in v1; RBAC-minted short-lived creds are target-state.

// Note: `wf:digest-fanout` is NOT here — its digest is triggered directly on the bot's admin
// endpoint (a service-job trigger, no MCP data access), so it needs no hub scope.

/** externalId (e.g. "wf:summarize-via-mcp") -> the exact tool names that workflow may call. */
export const AUTOMATION_ALLOWLIST: Record<string, readonly string[]> = {
  // Template / read-only glue
  "wf:summarize-via-mcp": ["llm.summarize"],
  // CRON read/notify flows (§2). `notify` raises an in-app notification for the ops lead
  // (LOW write; Cerbos gates create to company_admin/manager — the service-account roles below).
  "wf:stale-approval-chaser": ["agency.pendingApprovals", "notify"],
  "wf:compliance-gate-nag": ["compliance.gates", "llm.summarize", "notify"],
  // Event notify flow (§2): org_structure.updated -> in-app notification (no external channel).
  "wf:org-updated-notify": ["notify"],
  // Event-triggered LOW-impact write flows (§2) — writes still pass the impact gate.
  // `approvals.request` lets a write workflow file a human-approval suspension (§3/D14) when the
  // gate refuses a medium+/unclassified tool; it is itself a LOW write (records an intent only).
  "wf:new-client-seed": ["projects.create", "tasks.create", "notify", "approvals.request"],
  "wf:task-sla": ["tasks.list", "tasks.update", "approvals.request"],
  // Webhook ingest (§ step 4) — inbound lead/form -> a task in the intake project. LOW write.
  // Kept inert by the workflow's INGEST_ENABLED gate until legal Gate 1 + the day-one gate pass.
  "wf:inbound-lead-intake": ["tasks.create"],
  // WS11 meeting-to-delivery pipeline. n8n opens gates + advances stages (all LOW writes) and
  // extracts artifacts; it NEVER decides a gate or records a signature (those are human/UI actions).
  // meeting.recordingContext (F-1): reads the meeting_recordings row's client/project context by
  // meetingId so pipeline.createRun can populate clientId — the frozen webhook contract cannot
  // carry it directly.
  "wf:mtg-dispatcher": ["media.transcribe", "llm.summarize", "llm.extract", "meeting.recordingContext", "pipeline.createRun", "pipeline.updateStage", "notify"],
  // pipeline.updateRun (WD-05): parks a run 'blocked' once the bounded revise loop escalates.
  "wf:delivery": ["pipeline.getRun", "pipeline.createStage", "pipeline.updateStage", "pipeline.updateRun", "pipeline.openGate", "design.prototype", "code.scaffold", "github.repoStatus", "deploy.staging", "deploy.production", "notify", "approvals.request"],
  "wf:scope": ["pipeline.getRun", "pipeline.openGate", "notify"],
  // pm.createDoc / pm.createTask (WD-06, D-4): the report-track sink — a PM doc + review task
  // under the run's project, scoped to wf:report ONLY (invisible to wf:scope/wf:delivery/etc).
  "wf:report": ["pipeline.getRun", "pipeline.updateStage", "pm.createDoc", "pm.createTask", "notify"],
  // SM-15 n8n flows batch 1 (search-marketing scheduled pulls). search.pullRanks is write:true +
  // impact:'medium' (design §07/D-5: spending money is a mutation) but is a genuinely REAL,
  // hub-callable binding (unlike keywordResearch/runAudit/ingestRankResults below, which are
  // scaffolded for a platform-side gap this workflow set does not fix -- see
  // automation/workflows/sm-keyword-refresh.json and sm-rank-collect.json's own meta.description).
  // Listed here anyway so the allow-list entry is ready the moment index.ts wires them, without a
  // second hub deploy.
  // approvals.request is required: search.pullRanks is write:true+impact:'medium' (spending
  // money is a mutation, D14), so every unattended call the D14 gate does not refuse outright
  // (see minAssurance note above -- it currently refuses ALL of them) would otherwise need to
  // suspend into a human approval rather than fail outright.
  "wf:sm-rank-pull": ["search.listEngagements", "search.rankSummary", "search.pullRanks", "approvals.request"],
  "wf:sm-keyword-refresh": ["search.listEngagements", "search.keywordResearch"],
  "wf:sm-rank-collect": ["search.ingestRankResults"],
  // WD-26: per-person/project activity digests (daily 17:00 + weekly Fri) over work_activity.
  // projects.get resolves a project's owner (poly-assignee) as the project-digest notify target.
  // workActivity.relink is the LD-16 deterministic relink sweep, called once weekly from this flow.
  "wf:wd-digests": ["workActivity.feed", "projects.get", "llm.summarize", "notify", "workActivity.relink"],
  // WD-26: stale-task nag (no work_activity in N=5 days -> assignee; >=2N -> also project owner).
  "wf:wd-stale-nag": ["workActivity.staleTasks", "notify"],
};

/** An automation (n8n workflow) principal? Its scope comes from AUTOMATION_ALLOWLIST, not assurance. */
export function isAutomation(provider: string): boolean {
  return provider === "n8n";
}

/** Tools this workflow is scoped to (empty if the workflow id is unknown — deny-by-default). */
export function workflowScope(externalId: string): readonly string[] {
  return AUTOMATION_ALLOWLIST[externalId] ?? [];
}
