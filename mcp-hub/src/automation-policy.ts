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
  // WSK-12 (coordinator): the Zone B signed-fact bridge. Records the dedup row and may notify.
  "wf:webdesk-zoneb-intake": ["webdev.recordZoneBEvent", "notify"],
  // WS11 meeting-to-delivery pipeline. n8n opens gates + advances stages (all LOW writes) and
  // extracts artifacts; it NEVER decides a gate or records a signature (those are human/UI actions).
  // meeting.recordingContext (F-1): reads the meeting_recordings row's client/project context by
  // meetingId so pipeline.createRun can populate clientId — the frozen webhook contract cannot
  // carry it directly.
  // pipeline.runBySourceMeeting (E1 fix): the dedupe branch's read-only run lookup, so a re-posted
  // meetingId whose first attempt never actually created a run resolves to null instead of the
  // dedupe branch calling createRun itself and minting a phantom run.
  "wf:mtg-dispatcher": ["media.transcribe", "llm.summarize", "llm.extract", "meeting.recordingContext", "pipeline.runBySourceMeeting", "pipeline.createRun", "pipeline.updateStage", "notify"],
  // pipeline.updateRun (WD-05): parks a run 'blocked' once the bounded revise loop escalates.
  // webdev.provisionSite (PRV-03, provision<->ERP seam design §04/§06): proposed on prd_sign
  // decided approved/signed. write:true/impact:"medium" — the D14 gate SUSPENDS this call into WS4
  // exactly like deploy.*, and resource_mcp_tool.yaml's executable list is the only thing that lets
  // an approved re-drive land (see that policy's PRV-03 note). Do not widen this entry to cover any
  // other webdev tool without its own gate — same house rule deploy.* already established.
  "wf:delivery": ["pipeline.getRun", "pipeline.artifacts.get", "pipeline.createStage", "pipeline.updateStage", "pipeline.updateRun", "pipeline.openGate", "design.prototype", "code.scaffold", "github.repoStatus", "deploy.staging", "deploy.production", "webdev.provisionSite", "notify", "approvals.request"],
  "wf:scope": ["pipeline.getRun", "pipeline.openGate", "notify"],
  // pm.createDoc / pm.createTask (WD-06, D-4): the report-track sink — a PM doc + review task
  // under the run's project, scoped to wf:report ONLY (invisible to wf:scope/wf:delivery/etc).
  "wf:report": ["pipeline.getRun", "pipeline.updateStage", "pm.createDoc", "pm.createTask", "notify"],
  // SM-15's search-marketing scheduled-pull entries (wf:sm-rank-pull / wf:sm-keyword-refresh /
  // wf:sm-rank-collect) are RETIRED (SM-55, architect ruling §6ad/A13): no allow-list entry may
  // ever give n8n a path to a money-spending tool, full stop. The recurring cadence loop is a
  // platform-side scheduler job instead (SM-54) — the engagement's own `tool_scope` (toggle +
  // cadence + budget cap), written by a verified human under `search:scope:write`, is the
  // standing authorization; enforcement stays at the unchanged dispatch choke-point. Do not
  // re-add a search.* write tool here for any n8n workflow.
  // WD-26: per-person/project activity digests (daily 17:00 + weekly Fri) over work_activity.
  // projects.get resolves a project's owner (poly-assignee) as the project-digest notify target.
  // workActivity.relink is the LD-16 deterministic relink sweep, called once weekly from this flow.
  "wf:wd-digests": ["workActivity.feed", "projects.get", "llm.summarize", "notify", "workActivity.relink"],
  // WD-26: stale-task nag (no work_activity in N=5 days -> assignee; >=2N -> also project owner).
  "wf:wd-stale-nag": ["workActivity.staleTasks", "notify"],
  // WSK-29 — wd-contract-watch (automation/workflows/wd-contract-watch.json): surfaces a "site
  // pinned older contract" console notice per site whenever a WebDesk (Zone B) tenant publishes a
  // new /v1 contract snapshot (webdev D-5: never auto-upgrades). Pre-registered BEFORE
  // `webdev.listPendingContractNotices` exists — same precedent WSK-12 set for
  // `wf:webdesk-zoneb-intake` -> `webdev.recordZoneBEvent` (added here before WSK-19/31 built the
  // tool). Deny-by-default already protects this: the workflow's own gate + this allow-list
  // together mean a call to a tool that doesn't exist yet 404s, never silently succeeds. The read
  // tool itself is a platform-nest (webdev module) registration this ticket flagged, not built —
  // see the workflow file's own "MCP webdev.listPendingContractNotices" node `notes` for the
  // contract it must satisfy.
  "wf:wd-contract-watch": ["webdev.listPendingContractNotices", "notify"],
  // TR-11: the three reports/check-in flows. All three call platform-nest's checkin service reads
  // (pending-reminders / missed-yesterday) and `facts/recompute` DIRECTLY with the platform's own
  // service token (never through the hub — recompute is deliberately not an MCP tool, §9.2), so
  // the ONLY hub tool call any of them makes is `notify` — in-app fallback for a non-WA user
  // (eod-reminder), per-lead escalation (morning-escalation), or a dead-letter alert after 3
  // exhausted retries (nightly-facts; no ntfy egress from n8n's own docker network in this
  // deployment, see automation/README.md).
  "wf:reports-nightly-facts": ["notify"],
  "wf:reports-eod-reminder": ["notify"],
  "wf:reports-morning-escalation": ["notify"],
  // TR-22: the two P4 seal/generate/deliver flows (Blueprint §10 flows 4/5). Both call
  // platform-nest DIRECTLY for everything that actually does work — `GET/POST .../periods`,
  // `POST .../periods/:id/seal`, `GET .../reports/overview`, `POST .../reports/export` are all
  // either service/ops-tier reads or exec-only writes gated by Cerbos' `report_period`/
  // `report_document` policies, none of them MCP tools (§9.2 explicitly excludes seal/amend and
  // recompute from the tool surface — the SAME reasoning TR-11 already applied to
  // facts/recompute). The ONLY hub tool call either flow makes is `notify` — one in-app
  // notification per configured reports stakeholder (`REPORTS_NOTIFY_USER_IDS`) once a period's
  // documents+PDFs are generated, or a dead-letter alert if sealing/rendering genuinely failed
  // (never for an idempotent 409-already-sealed, which both flows treat as success — see
  // automation/README.md).
  "wf:reports-weekly-seal": ["notify"],
  "wf:reports-monthly-seal": ["notify"],
};

/** An automation (n8n workflow) principal? Its scope comes from AUTOMATION_ALLOWLIST, not assurance. */
export function isAutomation(provider: string): boolean {
  return provider === "n8n";
}

/** Tools this workflow is scoped to (empty if the workflow id is unknown — deny-by-default). */
export function workflowScope(externalId: string): readonly string[] {
  return AUTOMATION_ALLOWLIST[externalId] ?? [];
}
