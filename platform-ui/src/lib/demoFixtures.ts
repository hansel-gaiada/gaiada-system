import "server-only";
// TEMP DEMO MODE — lets someone browse every page with realistic fake data
// and NO backend running at all. Active only when process.env.DEMO_MODE==="1".
// Not part of any plan task; safe to delete once the real backend is up.
// Single entry point: platformFetch() calls getDemoResponse() before ever
// touching the network when demo mode is on.

import { pmDemo, allTrackerNotifications, pmTasksForUser } from "./demoPm";
import { meetingsDemo } from "./demoMeetings";
import { pipelineDemo, portalDemo } from "./demoPipeline";
import { socialDemo, socialClientReviewPortalDemo } from "./demoSocial";
import { webdevChangeRequestsDemo } from "./demoWebdevChangeRequests";
import { webdevProvisionedSitesDemo } from "./demoWebdevProvisionedSites";
import { monitoringDemo } from "./demoMonitoring";
import { portalDashboardDemo } from "./demoPortal";
import { reportsDemo } from "./demoReports";
import { checkinsDemo } from "./demoCheckins";
import { appraisalsDemo } from "./demoAppraisals";
import { loansDemo } from "./demoLoans";
import { assistantDemo } from "./demoAssistant";

export interface DemoResult {
  status: number;
  json: unknown;
}

const DEMO_USER_ID = "demo-hansel";
const DEMO_USER_IC_ID = "gede-ic";  // IC (Individual Contributor) tier — member role only
// SM-38 (QA-flagged gap, tracker §4j item 1): a `search_staff`-only demo identity scoped to
// `dept-3` (SEO). Before this, the only IC-tier demo identity (`gede-ic`, plain `member`) had NO
// search-module grant at all, so negative-permission rendering inside the SEO console
// (`search.manage=false` / `search.scope.write=false`) could not be driven in a browser under
// DEMO_MODE. `search_staff` grants `search.view`+`search.manage` but NOT `search.scope.write`
// (rbac.ts ROLE_CAPS) — so this identity exercises ScopeEditor's gated state (disabled inputs, no
// Save) live. It does NOT exercise AuditFindingsPanel/KeywordWorkbench's canManage=false gate
// (search_staff HAS search.manage) — that half is still only provable with the existing `member`
// identity, once it can reach dept-3 at all (see the login-mapping + org-structure note below).
const DEMO_USER_SEARCH_STAFF_ID = "seo-staff";
// External-client tier. `client` is the ONLY role: `isClientOnly` keys off "holds no staff role", so
// adding any second role here would silently turn this identity back into staff and stop exercising
// the portal-only nav + landing redirect this identity exists to cover.
const DEMO_USER_CLIENT_ID = "demo-client";

let demoSeq = 1000;
const demoId = (p: string) => `${p}-${++demoSeq}`;

const COMPANIES: Record<string, unknown>[] = [
  { id: "co-holding", name: "D & A Syrowatka", type: "holding", enabled_modules: [], status: "active" },
  {
    id: "co-agency",
    name: "Gaia Digital Agency",
    type: "agency",
    enabled_modules: ["agency"],
    status: "active",
    parent_company_id: "co-holding",
  },
  {
    id: "co-resort",
    name: "Viceroy",
    type: "resort",
    enabled_modules: [],
    status: "active",
    parent_company_id: "co-holding",
  },
];

const ME = {
  userId: DEMO_USER_ID,
  name: "Clement Hansel",
  email: "hansel@gaiada.com",
  title: "AI Manager",
  assurance: "high",
  companies: COMPANIES.map((c) => ({ id: c.id as string, name: c.name as string, type: c.type as string | null })),
  roles: [
    { role: "platform_admin", scopeType: "global", scopeId: null },
    // IAM-15: the demo identity's `group_executive` grant is gone with the role. It keeps
    // `platform_admin`, which already confers ALL, so every demo surface behaves as before.
  ],
};

// IC-tier identity: Frontend Developer with member-only role (no manager-tier roles).
// `isManagerTier` returns false, so the Queue+Agenda Home variant renders instead of Command Center.
const ME_CLIENT = {
  userId: "demo-client",
  // Northwind Traders is the demo client that OWNS run-demo-1 (demoPipeline's `client_id: "cl-1"`).
  // Naming this identity after a different client would make the portal show "your projects" for a
  // company this person has nothing to do with.
  name: "Dana Whitfield",
  email: "dana@northwind.example",
  title: "Marketing Lead, Northwind Traders",
  assurance: "high",
  // One company: a client belongs to the company that SERVES them and must never see a switcher.
  companies: [{ id: "co-agency", name: "Gaia Digital Agency", type: "agency" }],
  roles: [{ role: "client", scopeType: "company", scopeId: "co-agency" }],
};

const ME_IC = {
  userId: DEMO_USER_IC_ID,
  name: "Gede Kusuma",
  email: "gede@gaiada.com",
  title: "Frontend Developer",
  assurance: "high",
  companies: [{ id: "co-agency", name: "Gaia Digital Agency", type: "agency" }],
  roles: [
    { role: "member", scopeType: "company", scopeId: "co-agency" },
  ],
};

// search_staff-tier identity (SM-38), same company as dept-3 (SEO) so the department itself is
// reachable — `rbac.ts`'s `can()` has no department-level granularity (a company-scoped grant
// covers every department in it), so "scoped to dept-3" means "a member of dept-3's company,
// co-agency, with a search-module role and nothing else" — mirrors `hr_staff`'s existing pattern.
const ME_SEARCH_STAFF = {
  userId: DEMO_USER_SEARCH_STAFF_ID,
  name: "Nyoman Ari",
  email: "seo-staff@gaiada.com",
  title: "SEO Specialist",
  assurance: "high",
  companies: [{ id: "co-agency", name: "Gaia Digital Agency", type: "agency" }],
  roles: [
    { role: "search_staff", scopeType: "company", scopeId: "co-agency" },
  ],
};

const MEMBERS: Record<string, { user_id: string; name: string; email: string; title: string | null }[]> = {
  "co-holding": [
    { user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" },
    { user_id: "u-finance", name: "Rina Wibawa", email: "rina@gaiada.com", title: "Finance Lead" },
  ],
  "co-agency": [
    { user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" },
    { user_id: DEMO_USER_IC_ID, name: "Gede Kusuma", email: "gede@gaiada.com", title: "Frontend Developer" },
    { user_id: DEMO_USER_SEARCH_STAFF_ID, name: "Nyoman Ari", email: "seo-staff@gaiada.com", title: "SEO Specialist" },
    { user_id: "u-pm", name: "Dewi Santoso", email: "dewi@gaiada.com", title: "Account Manager" },
    { user_id: "u-dev", name: "Made Putra", email: "made@gaiada.com", title: "Web Developer" },
  ],
  "co-resort": [{ user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" }],
};

// WD-28: `shortCode` mirrors the real backend's per-tenant unique per-project code (same
// derivation the real store + `demoPm.ts` use — first 3-4 uppercase alnum chars of the name).
const PROJECTS: Record<string, unknown[]> = {
  "co-holding": [
    { id: "p-hr-1", name: "HR system rollout", status: "active", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, department_id: null, due_date: "2026-08-15", custom_fields: {}, shortCode: "HRSY" },
    { id: "p-fin-1", name: "FY26 budget review", status: "on_hold", client_id: null, is_internal: true, owner_id: "u-finance", department_id: null, due_date: "2026-07-30", custom_fields: {}, shortCode: "FY26" },
  ],
  "co-agency": [
    { id: "p-web-1", name: "Client site redesign", status: "active", client_id: "cl-1", is_internal: false, owner_id: "u-pm", department_id: "dept-1", due_date: "2026-07-20", custom_fields: { phase: "build" }, shortCode: "CLIE" },
    { id: "p-web-2", name: "Mobile app revamp", status: "active", client_id: "cl-3", is_internal: false, owner_id: "u-dev", department_id: "dept-1", due_date: "2026-08-10", custom_fields: { phase: "build" }, shortCode: "MOBI" },
    { id: "p-seo-1", name: "SEO audit — Q3", status: "active", client_id: "cl-2", is_internal: false, owner_id: "u-pm", department_id: "dept-3", due_date: "2026-08-01", custom_fields: { phase: "discovery" }, shortCode: "SEOA" },
    { id: "p-int-1", name: "Internal brand refresh", status: "completed", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, department_id: "dept-2", due_date: "2026-06-01", custom_fields: {}, shortCode: "INTE" },
  ],
  "co-resort": [],
};

const PROJECT_DETAIL_EXTRA: Record<string, { client_name: string | null; owner_name: string | null; start_date: string | null }> = {
  "p-hr-1": { client_name: null, owner_name: "Clement Hansel", start_date: "2026-05-01" },
  "p-fin-1": { client_name: null, owner_name: "Rina Wibawa", start_date: "2026-04-01" },
  "p-web-1": { client_name: "Northwind Traders", owner_name: "Dewi Santoso", start_date: "2026-06-01" },
  "p-web-2": { client_name: "Lumen Studio", owner_name: "Made Putra", start_date: "2026-07-01" },
  "p-seo-1": { client_name: "Cedar Group", owner_name: "Dewi Santoso", start_date: "2026-07-01" },
  "p-int-1": { client_name: null, owner_name: "Clement Hansel", start_date: "2026-03-01" },
};

const TASKS: Record<string, unknown[]> = {
  "p-hr-1": [
    { id: "t-1", title: "Draft onboarding flow", status: "in_progress", priority: "high", assignee_id: DEMO_USER_ID, due_date: "2026-07-10", project_id: "p-hr-1", project_name: "HR system rollout" },
    { id: "t-2", title: "Review vendor contract", status: "todo", priority: "normal", assignee_id: "u-finance", due_date: "2026-07-15", project_id: "p-hr-1", project_name: "HR system rollout" },
  ],
  "p-fin-1": [
    { id: "t-3", title: "Reconcile Q2 actuals", status: "done", priority: "normal", assignee_id: "u-finance", due_date: "2026-06-25", project_id: "p-fin-1", project_name: "FY26 budget review" },
  ],
  "p-web-1": [
    { id: "t-4", title: "Wire homepage hero", status: "in_progress", priority: "high", assignee_id: "u-dev", due_date: "2026-07-08", project_id: "p-web-1", project_name: "Client site redesign" },
    { id: "t-5", title: "QA checkout flow", status: "blocked", priority: "urgent", assignee_id: "u-dev", due_date: "2026-07-09", project_id: "p-web-1", project_name: "Client site redesign" },
  ],
  "p-seo-1": [
    { id: "t-6", title: "Keyword gap analysis", status: "todo", priority: "normal", assignee_id: DEMO_USER_ID, due_date: "2026-07-18", project_id: "p-seo-1", project_name: "SEO audit — Q3" },
  ],
  "p-web-2": [
    { id: "t-7", title: "Set up navigation shell", status: "done", priority: "normal", assignee_id: "u-dev", due_date: "2026-07-20", project_id: "p-web-2", project_name: "Mobile app revamp" },
    { id: "t-8", title: "Build offline sync", status: "in_progress", priority: "high", assignee_id: "u-dev", due_date: "2026-08-01", project_id: "p-web-2", project_name: "Mobile app revamp" },
    { id: "t-9", title: "Push notifications spike", status: "todo", priority: "normal", assignee_id: DEMO_USER_ID, due_date: "2026-08-05", project_id: "p-web-2", project_name: "Mobile app revamp" },
  ],
  "p-int-1": [],
};
const ALL_TASKS = Object.values(TASKS).flat();

// project id -> owning company id, derived from PROJECTS — backs the WSUX-8
// `/api/tasks/mine` demo leg (the base `tasks` model has no direct tenant
// column of its own, same as the real schema; the tenant comes from the row's
// RLS context, which in demo mode we recover via the project's company).
const PROJECT_COMPANY: Record<string, string> = Object.fromEntries(
  Object.entries(PROJECTS).flatMap(([companyId, ps]) => (ps as { id: string }[]).map((p) => [p.id, companyId])),
);

const CUSTOM_FIELDS: Record<string, unknown[]> = {
  project: [
    { key: "phase", label: "Phase", data_type: "text", options: [], required: false },
    { key: "tier", label: "Account tier", data_type: "select", options: ["a", "b", "c"], required: false },
  ],
  task: [{ key: "severity", label: "Severity", data_type: "select", options: ["low", "high"], required: false }],
  pm_task: [{ key: "channel", label: "Channel", data_type: "select", options: ["email", "phone", "in_person"], required: false }],
  agency_campaign: [{ key: "channel", label: "Channel", data_type: "text", options: [], required: false }],
};

const CAMPAIGNS = [
  { id: "cam-1", name: "Q3 lead-gen push", status: "active", project_id: "p-web-1", budget_minor: 1200000, currency: "USD" },
  { id: "cam-2", name: "Brand awareness — social", status: "draft", project_id: "p-int-1", budget_minor: 450000, currency: "USD" },
];

const BRIEFS: Record<string, unknown[]> = {
  "cam-1": [
    { id: "b-1", title: "Landing page copy brief", status: "approved", created_at: "2026-06-20T09:00:00Z" },
    { id: "b-2", title: "Ad creative brief — round 2", status: "draft", created_at: "2026-07-01T09:00:00Z" },
  ],
  "cam-2": [],
};

const APPROVALS_PENDING = [
  { id: "ap-1", subject: "Landing page copy brief", campaign: "Q3 lead-gen push", campaignId: "cam-1", created_at: "2026-07-04T10:00:00Z" },
  { id: "ap-2", subject: "Ad spend increase — 20%", campaign: "Q3 lead-gen push", campaignId: "cam-1", created_at: "2026-07-05T08:00:00Z" },
];
const APPROVALS_DECIDED = [
  { id: "ad-1", subject: "Homepage hero creative", campaign: "Q3 lead-gen push", decision: "approved", decided_at: "2026-07-04T16:00:00Z", decided_by: "Clement Hansel" },
  { id: "ad-2", subject: "Influencer budget — round 1", campaign: "Brand awareness — social", decision: "rejected", decided_at: "2026-07-02T11:00:00Z", decided_by: "Clement Hansel" },
];

// ---- WSUX-1/6 unified approvals inbox (lib/approvals.ts, `GET /api/approvals`
// + `POST /api/:t/approvals/:id/decide`) — a stateful mirror of
// approvals-urgency.ts's weighting so the demo's urgency/age sort behaves
// like the real endpoint. Deliberately spans every origin + more than one
// company so the origin chips and scope pill both have something to filter.
const UNIFIED_BASE_WEIGHT: Record<string, number> = { pipeline: 100, agency: 90, automation: 80, agent: 80, hr: 70 };
const UNIFIED_IMPACT_BONUS: Record<string, number> = { high: 15, medium: 5, unclassified: 0 };
function unifiedAgeBonus(ageMs: number): number {
  const hours = Math.max(0, ageMs) / 3_600_000;
  return Math.min(hours, 80) * (40 / 80);
}
function unifiedUrgency(origin: string, ageMs: number, impact?: string): number {
  return (UNIFIED_BASE_WEIGHT[origin] ?? 0) + (impact ? (UNIFIED_IMPACT_BONUS[impact] ?? 0) : 0) + unifiedAgeBonus(ageMs);
}
interface UnifiedDemoRow {
  id: string; origin: "agency" | "pipeline" | "hr" | "automation" | "agent"; tenantId: string;
  subject: string; subjectHref?: string; previewUrl?: string; createdAt: string; status: string; impact?: string;
}
const UNIFIED_APPROVALS: UnifiedDemoRow[] = [
  { id: "ap-1", origin: "agency", tenantId: "co-agency", subject: "Landing page copy brief", subjectHref: "/agency/cam-1", createdAt: "2026-07-04T10:00:00Z", status: "pending" },
  { id: "ap-2", origin: "agency", tenantId: "co-agency", subject: "Ad spend increase — 20%", subjectHref: "/agency/cam-1", createdAt: "2026-07-05T08:00:00Z", status: "pending" },
  { id: "ad-1", origin: "agency", tenantId: "co-agency", subject: "Homepage hero creative", subjectHref: "/agency/cam-1", createdAt: "2026-07-04T09:00:00Z", status: "approved" },
  { id: "ad-2", origin: "agency", tenantId: "co-agency", subject: "Influencer budget — round 1", subjectHref: "/agency/cam-2", createdAt: "2026-07-02T08:00:00Z", status: "rejected" },
  { id: "pg-1", origin: "pipeline", tenantId: "co-agency", subject: "Prototype sign-off — Client site redesign", subjectHref: "/pipeline", createdAt: "2026-07-21T09:00:00Z", status: "pending" },
  { id: "un-aa-1", origin: "automation", tenantId: "co-agency", subject: "Repeated auth failures on CCTV — Parking; auto-disable suspended for review.", createdAt: "2026-07-21T22:00:00Z", status: "pending", impact: "high" },
  { id: "un-aa-2", origin: "agent", tenantId: "co-agency", subject: "Bulk status update flagged unclassified by the write gate.", createdAt: "2026-07-22T07:30:00Z", status: "pending", impact: "medium" },
  { id: "hr-1", origin: "hr", tenantId: "co-resort", subject: "Leave request — Andi (3 days)", subjectHref: "/hr", createdAt: "2026-07-22T02:00:00Z", status: "pending" },
  // D14-08 — decided automation-family rows, paired 1:1 with AUTOMATION_APPROVALS's `aa-3`/`aa-4`
  // (same id) so `fetchExecutionStates`'s per-tenant merge finds them. `un-aa-1`/`un-aa-2` above stay
  // pending on purpose — the row this ticket adds is specifically the DECIDED one.
  { id: "aa-3", origin: "automation", tenantId: "co-agency", subject: "Repeated auth failures on CCTV — Lobby; auto-disable suspended for review.", createdAt: "2026-07-22T09:00:00Z", status: "approved", impact: "high" },
  { id: "aa-4", origin: "agent", tenantId: "co-agency", subject: "Bulk status update flagged unclassified by the write gate.", createdAt: "2026-07-22T09:15:00Z", status: "approved", impact: "medium" },
];

const ACTIVITY = [
  { id: "a-1", actor_id: "u-pm", actor_name: "Dewi Santoso", verb: "created", target_entity_type: "agency_brief", target_entity_id: "b-2", occurred_at: "2026-07-05T09:00:00Z", metadata: {} },
  { id: "a-2", actor_id: "u-dev", actor_name: "Made Putra", verb: "updated", target_entity_type: "task", target_entity_id: "t-5", occurred_at: "2026-07-05T08:30:00Z", metadata: {} },
  { id: "a-3", actor_id: DEMO_USER_ID, actor_name: "Clement Hansel", verb: "approved", target_entity_type: "agency_approval", target_entity_id: "ap-0", occurred_at: "2026-07-04T16:00:00Z", metadata: {} },
  { id: "a-4", actor_id: "u-finance", actor_name: "Rina Wibawa", verb: "updated", target_entity_type: "project", target_entity_id: "p-fin-1", occurred_at: "2026-07-03T14:00:00Z", metadata: {} },
];

// WSUX-9: typed payload shape ({title, href, body?, entityType?, entityId?,
// severity?} per WSUX-4 / platform-nest src/core/http.ts NotificationPayload).
// n-6 deliberately omits `severity` to exercise the page's graceful default
// (an "info" treatment) for pre-WSUX-4 rows that never get backfilled.
const NOTIFICATIONS = [
  { id: "n-1", type: "approval.requested", payload: { title: "Approval requested", body: "Ad spend increase — 20% on Q3 lead-gen push is waiting for your decision.", href: "/approvals", entityType: "approval", severity: "warning" }, read_at: null, created_at: "2026-07-05T08:10:00Z" },
  { id: "n-critical", type: "budget.overrun", payload: { title: "Budget overrun flagged", body: "FY26 marketing spend crossed 110% of the approved cap.", href: "/rollups", entityType: "rollup", severity: "critical" }, read_at: null, created_at: "2026-07-05T07:55:00Z" },
  { id: "n-2", type: "comment.mention", payload: { title: "Dewi mentioned you", body: "“@Hansel can you confirm the launch date on the client site redesign?”", href: "/tasks/t-4", entityType: "task", entityId: "t-4", severity: "info" }, read_at: null, created_at: "2026-07-04T15:40:00Z" },
  { id: "n-3", type: "task.assigned", payload: { title: "Task assigned to you", body: "Keyword gap analysis on SEO audit — Q3.", href: "/tasks/t-6", entityType: "task", entityId: "t-6", severity: "info" }, read_at: null, created_at: "2026-07-04T09:05:00Z" },
  { id: "n-4", type: "brief.approved", payload: { title: "Brief approved", body: "Landing page copy brief was approved.", href: "/agency", entityType: "brief", severity: "info" }, read_at: "2026-07-03T12:00:00Z", created_at: "2026-07-03T11:30:00Z" },
  { id: "n-5", type: "project.updated", payload: { title: "Project updated", body: "FY26 budget review moved to On hold.", href: "/projects/p-fin-1" }, read_at: "2026-07-03T10:00:00Z", created_at: "2026-07-03T09:50:00Z" },
];

const ROLLUPS = [
  { tenant_id: "co-agency", company: "Gaia Digital Agency", module: "agency", metric_key: "agency.campaigns.active", numerator: 1, denominator: null, currency: null, period: "2026-07-05" },
  { tenant_id: "co-agency", company: "Gaia Digital Agency", module: "agency", metric_key: "agency.approvals.pending", numerator: 2, denominator: null, currency: null, period: "2026-07-05" },
  { tenant_id: "co-resort", company: "Viceroy", module: "core", metric_key: "core.tasks.done_ratio", numerator: 4, denominator: 10, currency: null, period: "2026-07-05" },
];

const SYSTEM_STATUS: Record<string, unknown> = {
  bot: { ok: true, version: "1.4.0", uptimeSec: 3661, counters: { messagesToday: 128, digestsSent: 4 }, detail: { groups: 6, telegram: "connected" } },
  gateway: { ok: true, version: "0.9.2", uptimeSec: 90061, counters: { dailySpend: "$12.40", cap: "$50.00", breaker: "closed" }, detail: {} },
  hub: { ok: true, version: "0.6.1", uptimeSec: 3600, counters: { toolsRegistered: 9 }, detail: {} },
  agents: { ok: true, version: "0.3.0", uptimeSec: 61, counters: { activeGoals: 3 }, detail: {} },
  knowledge: { ok: true, version: "0.2.0", uptimeSec: 61, counters: { sources: 5 }, detail: {} },
  automation: { ok: true, version: "1.1.0", uptimeSec: 3661, counters: { workflows: 2 }, detail: { workflows: [{ name: "summarize-via-mcp", status: "active", lastRun: "2026-07-05T06:00:00Z" }], n8nUrl: "https://n8n.internal.gaiada.com" } },
};

const SYSTEM_CONFIG: Record<string, unknown[]> = {
  bot: [
    { key: "digestEnabled", label: "Send digests", value: true, kind: "boolean", editable: true },
    { key: "digestSchedule", label: "Digest schedule (cron)", value: "0 12,18 * * *", kind: "text", editable: true },
    { key: "waSessionKey", label: "WhatsApp session key", value: true, kind: "secretPresence", editable: false },
  ],
  // Gateway/hub/automation mirror the real projections nest builds from each service's own admin
  // surface (see platform-nest admin-systems.controller.ts gatewayConfigFields/hubConfigFields/
  // automationConfigFields) — not an invented shape.
  gateway: [
    { key: "providers", label: "LLM failover chain", value: ["ollama", "gemini", "claude"], kind: "text", editable: false },
    { key: "llmChain", label: "LLM failover chain (order)", value: "ollama, gemini, claude", kind: "text", editable: true },
    { key: "mediaChain", label: "Media failover chain", value: "whisper, gemini", kind: "text", editable: true },
    { key: "dailyCallCap", label: "Daily call cap (global)", value: 2000, kind: "number", editable: true },
    { key: "perTenantDailyCallCap", label: "Daily call cap (per tenant)", value: 1000, kind: "number", editable: true },
    { key: "breakerThreshold", label: "Circuit-breaker threshold", value: 3, kind: "number", editable: true },
    { key: "dlpClassifierEnabled", label: "Model-assisted DLP classifier", value: true, kind: "boolean", editable: true },
    // Security boundary + topology are env-only, so they stay read-only here too.
    { key: "tlsMode", label: "Internal TLS mode", value: "permissive", kind: "text", editable: false },
    { key: "topologyMode", label: "Topology", value: "central", kind: "text", editable: false },
    { key: "tokenConfigured", label: "Auth token configured", value: true, kind: "secretPresence", editable: false },
  ],
  hub: [
    { key: "policyEngine", label: "Authorization engine", value: "cerbos", kind: "text", editable: false },
    { key: "denyByDefault", label: "Deny by default", value: true, kind: "boolean", editable: false },
    { key: "rateLimitPerMin", label: "Rate limit — per principal (calls/min)", value: 120, kind: "number", editable: false },
    { key: "tlsMode", label: "mTLS mode", value: "permissive", kind: "text", editable: false },
    { key: "topology", label: "Topology", value: "central", kind: "text", editable: false },
    { key: "serviceAuthConfigured", label: "Service token configured", value: true, kind: "secretPresence", editable: false },
  ],
  agents: [],
  knowledge: [],
  automation: [
    { key: "n8nUrl", label: "n8n URL", value: "https://n8n.internal.gaiada.com", kind: "text", editable: false },
    { key: "apiKeyConfigured", label: "Public-API key configured", value: true, kind: "secretPresence", editable: false },
    { key: "bridgeEnabled", label: "Event bridge enabled", value: true, kind: "boolean", editable: false },
    { key: "bridgeEvents", label: "Bridged event types", value: "org_structure.updated, client.created", kind: "text", editable: false },
    { key: "bridgeMaxRetries", label: "Dead-letter after N retries", value: 5, kind: "number", editable: false },
  ],
};

const EGRESS_AUDIT = [
  { time: "2026-07-05T09:00:00Z", provider: "gemini", decision: "allow", detail: "llm 412ms", capability: "llm", ok: true, blocked: null, redactions: 0, latencyMs: 412 },
  { time: "2026-07-05T08:55:00Z", provider: null, decision: "blocked:dlp", detail: "llm redactions=2", capability: "llm", ok: false, blocked: "dlp", redactions: 2, latencyMs: 18 },
  { time: "2026-07-05T08:50:00Z", provider: "claude", decision: "allow", detail: "llm 980ms", capability: "llm", ok: true, blocked: null, redactions: 1, latencyMs: 980 },
  { time: "2026-07-05T08:41:00Z", provider: null, decision: "blocked:budget", detail: "media", capability: "media", ok: false, blocked: "budget", redactions: 0, latencyMs: 3 },
];

// Mirrors ai-gateway-go GET /admin/config (proxied by nest as /api/admin/gateway/detail).
const GATEWAY_DETAIL = {
  chains: {
    llm: {
      order: ["ollama", "gemini", "claude"],
      providers: [
        { name: "ollama", position: 1, state: "ok", available: true, consecutiveFails: 0, rateLimited: false },
        { name: "gemini", position: 2, state: "open", available: true, consecutiveFails: 0, rateLimited: true, openUntil: "2026-07-05T09:05:00Z" },
        { name: "claude", position: 3, state: "ok", available: true, consecutiveFails: 1, rateLimited: false },
        { name: "echo", position: 4, state: "ok", available: true },
      ],
    },
    media: {
      order: ["whisper", "gemini"],
      providers: [
        { name: "whisper", position: 1, state: "unconfigured", available: false },
        { name: "gemini", position: 2, state: "open", available: true, rateLimited: true },
        { name: "echo", position: 3, state: "ok", available: true },
      ],
    },
    embed: { order: ["ollama"], providers: [{ name: "ollama", position: 1, state: "ok", available: true }] },
  },
  providers: [
    { name: "ollama", model: "llama3.2", endpoint: "http://ollama:11434", keyRequired: false, keyConfigured: true },
    { name: "whisper", model: "Systran/faster-whisper-small", keyRequired: false, keyConfigured: false },
    { name: "gemini", model: "gemini-1.5-flash", keyRequired: true, keyConfigured: true },
    { name: "claude", model: "claude-haiku-4-5-20251001", keyRequired: true, keyConfigured: true },
    { name: "echo", keyRequired: false, keyConfigured: true },
  ],
  budget: {
    day: "2026-07-05",
    used: 318,
    cap: 2000,
    effectiveCap: 2000,
    perTenantCap: 1000,
    tenants: { "co-agency": 244, "co-resort": 74 },
    drActive: false,
    drBurstCap: 2000,
  },
  reliability: { breakerThreshold: 3, breakerCooldownMs: 60000, providerTimeoutMs: 60000 },
  security: {
    tlsMode: "permissive",
    egressAllowlist: ["generativelanguage.googleapis.com", "api.anthropic.com"],
    dlpClassifierEnabled: true,
    dlpClassifierModel: "llama3.2",
    classifierReachable: true,
    auditFile: "data/egress-audit.jsonl",
  },
  topology: { mode: "central", centralConfigured: false, drBurstCap: 2000, drDurationMinutes: 1440, mediaMaxBytes: 15728640 },
  // Mirrors the gateway's own allowlist: only these keys are runtime-writable (credentials, egress
  // allowlist, TLS mode and topology stay env+restart).
  writableKeys: [
    "dailyCallCap",
    "perTenantDailyCallCap",
    "breakerThreshold",
    "breakerCooldownMs",
    "providerTimeoutMs",
    "dlpClassifierEnabled",
    "llmChain",
    "mediaChain",
    "embedChain",
  ],
  // One key shown as a live override so the demo exercises the "override" badge + Revert control.
  overriddenKeys: { dailyCallCap: true },
};

const HUB_TOOLS = [
  { name: "whoami", description: "Report the calling principal", minAssurance: "anonymous", write: false, impact: null, source: "core" },
  { name: "projects.list", description: "List the tenant's projects with status", minAssurance: "low", write: false, impact: null, source: "platform-read" },
  { name: "agency.pendingApprovals", description: "Approvals waiting for a decision", minAssurance: "low", write: false, impact: null, source: "platform-read" },
  { name: "tasks.create", description: "Create a task in a project", minAssurance: "verified", write: true, impact: "low", source: "platform-write" },
  { name: "deploy.production", description: "Trigger a production deploy", minAssurance: "verified", write: true, impact: "high", source: "delivery" },
  { name: "automation.listWorkflows", description: "List n8n workflows", minAssurance: "verified", write: false, impact: null, source: "module" },
];

// Mirrors mcp-hub GET /admin/info (proxied by nest as /api/admin/hub/detail).
const HUB_DETAIL = {
  policy: {
    engine: "cerbos",
    cerbosConfigured: true,
    denyByDefault: true,
    assuranceRanks: ["anonymous", "low", "verified"],
    automationWriteGate:
      "unattended automation runs LOW-impact writes only; medium/high/unclassified writes suspend for human approval",
    revocationCheck: true,
    revocationTtlMs: 60000,
  },
  rateLimit: { perPrincipalPerMin: 120, perPrincipalBurst: 40, perServiceTokenPerMin: 1200, perServiceTokenBurst: 400 },
  transport: { tlsMode: "permissive", peerAllowlist: ["bot", "ai-agents", "n8n", "platform"], topology: "central", serviceAuthConfigured: true },
  tools: { total: 6, bySource: { core: 1, "platform-read": 2, "platform-write": 1, delivery: 1, module: 1 } },
  resources: [
    { uriTemplate: "gaiada://{tenantId}/projects", name: "Projects", description: "All projects in a company you belong to.", mimeType: "application/json" },
    { uriTemplate: "gaiada://{tenantId}/client/{clientId}", name: "Client", description: "One client's detail.", mimeType: "application/json" },
  ],
  prompts: [
    { name: "summarize-project-status", description: "Summarize a project's status for a management update.", arguments: [{ name: "projectName", description: "The project name", required: true }, { name: "details", description: "Recent notes", required: true }] },
    { name: "draft-client-update", description: "Draft a client-facing progress update.", arguments: [{ name: "clientName", description: "The client name", required: true }] },
  ],
  workflowScopes: [
    { workflow: "wf:summarize-via-mcp", tools: ["llm.summarize"] },
    { workflow: "wf:task-sla", tools: ["tasks.list", "tasks.update", "approvals.request"] },
    { workflow: "wf:new-client-seed", tools: ["projects.create", "tasks.create", "notify", "approvals.request"] },
  ],
  upstreams: { gatewayConfigured: true, platformConfigured: true, knowledgeConfigured: true },
};

const HUB_AUDIT = [
  { ts: 1_752_000_600_000, tool: "tasks.update", principal: { provider: "n8n", externalId: "wf:task-sla", assurance: "verified" }, decision: "allow", ok: true },
  { ts: 1_752_000_300_000, tool: "deploy.production", principal: { provider: "n8n", externalId: "wf:delivery", assurance: "verified" }, decision: "deny", reason: "suspend: deploy.production is a high-impact write; automation requires human approval" },
  { ts: 1_752_000_000_000, tool: "projects.list", principal: { provider: "telegram", externalId: "tg:8891", assurance: "low" }, decision: "allow", ok: true },
  { ts: 1_751_999_400_000, tool: "tasks.create", principal: { provider: "telegram", externalId: "tg:8891", assurance: "low" }, decision: "deny", reason: "denied: tasks.create requires verified assurance; caller has low (step up on a verified surface)" },
];

const WORKFLOW_EXECUTIONS = [
  { id: "ex-9", workflowId: "wf1", workflowName: "summarize-via-mcp", status: "success", mode: "trigger", startedAt: "2026-07-05T06:00:00Z", stoppedAt: "2026-07-05T06:00:04Z", durationMs: 4000 },
  { id: "ex-8", workflowId: "wf3", workflowName: "task-sla", status: "error", mode: "trigger", startedAt: "2026-07-05T05:30:00Z", stoppedAt: "2026-07-05T05:30:02Z", durationMs: 2100 },
  { id: "ex-7", workflowId: "wf1", workflowName: "summarize-via-mcp", status: "success", mode: "manual", startedAt: "2026-07-04T18:00:00Z", stoppedAt: "2026-07-04T18:00:03Z", durationMs: 3200 },
];

const BRIDGE_HEALTH = {
  enabled: true,
  webhookConfigured: true,
  secretConfigured: true,
  events: ["org_structure.updated", "client.created", "deliverable.status_changed"],
  maxRetries: 5,
  timeoutMs: 5000,
  streams: [
    { entityType: "client", stream: "events:client", backlog: 0, deadLetter: 0, oldestPendingMs: null },
    { entityType: "deliverable", stream: "events:deliverable", backlog: 3, deadLetter: 1, oldestPendingMs: 194000 },
    { entityType: "org_structure", stream: "events:org_structure", backlog: 0, deadLetter: 0, oldestPendingMs: null },
  ],
};
const AGENT_GOALS: Record<string, unknown[]> = {
  "co-agency": [
    { id: "g-1", goal: "Chase overdue approvals", status: "running", budgetSpent: 0.42, budgetTotal: 2, fanOut: 2 },
    { id: "g-2", goal: "Weekly status digest", status: "done", budgetSpent: 0.1, budgetTotal: 1, fanOut: 1 },
  ],
};
const KNOWLEDGE_SOURCES: Record<string, unknown[]> = {
  "co-agency": [
    { id: "k-1", source: "Brand guidelines.pdf", provenance: "Google Drive", status: "indexed" },
    { id: "k-2", source: "Client onboarding notes", provenance: "manual upload", status: "quarantined" },
  ],
};

const ROLES = [
  { id: "role-admin", name: "company_admin", company_id: null },
  { id: "role-manager", name: "manager", company_id: null },
  { id: "role-member", name: "member", company_id: null },
];

const USERS: Record<string, unknown>[] = [
  {
    id: DEMO_USER_ID,
    name: "Clement Hansel",
    email: "hansel@gaiada.com",
    title: "AI Manager",
    status: "active",
    roles: [{ grantId: "gr-1", role: "platform_admin", scopeType: "global", scopeId: null }],
  },
  {
    id: "u-pm",
    name: "Dewi Santoso",
    email: "dewi@gaiada.com",
    title: "Account Manager",
    status: "active",
    roles: [{ grantId: "gr-2", role: "manager", scopeType: "company", scopeId: "co-agency" }],
  },
  {
    id: "u-dev",
    name: "Made Putra",
    email: "made@gaiada.com",
    title: "Web Developer",
    status: "active",
    roles: [{ grantId: "gr-3", role: "member", scopeType: "company", scopeId: "co-agency" }],
  },
  {
    id: "u-finance",
    name: "Rina Wibawa",
    email: "rina@gaiada.com",
    title: "Finance Lead",
    status: "active",
    roles: [{ grantId: "gr-4", role: "manager", scopeType: "company", scopeId: "co-holding" }],
  },
];

// Time entries — keyed for the employee 360 (filtered by userId / mine).
const TIME_ENTRIES: Record<string, unknown>[] = [
  { id: "te-1", user_id: DEMO_USER_ID, project_id: "p-hr-1", task_id: "t-1", minutes: 150, billable: false, entry_date: "2026-07-05", notes: "Onboarding flow draft" },
  { id: "te-2", user_id: DEMO_USER_ID, project_id: "p-seo-1", task_id: "t-6", minutes: 90, billable: true, entry_date: "2026-07-04", notes: "Keyword research" },
  { id: "te-3", user_id: "u-dev", project_id: "p-web-1", task_id: "t-4", minutes: 240, billable: true, entry_date: "2026-07-05", notes: "Homepage hero" },
  { id: "te-4", user_id: "u-dev", project_id: "p-web-1", task_id: "t-5", minutes: 180, billable: true, entry_date: "2026-07-04", notes: "Checkout QA" },
  { id: "te-5", user_id: "u-finance", project_id: "p-fin-1", task_id: "t-3", minutes: 120, billable: false, entry_date: "2026-06-25", notes: "Q2 reconciliation" },
];

// ORG-13 service assignments — session-only in-memory store (matches every
// other demo store's "resets on restart" convention). Empty by default:
// nothing is pre-seeded as served/serving so the Connect-service /
// ServicedBlock / /admin/services surfaces show their real "not connected
// yet" empty states out of the box, same as production before any assignment
// is created.
const DEMO_ASSIGNMENTS: {
  id: string; providerTenantId: string; providerCompanyName?: string;
  targetTenantId: string; targetCompanyName?: string;
  unitId: string; unitName: string; unitKind: string; unitStatus: "active" | "orphaned";
  module: string; status: "proposed" | "active" | "suspended" | "revoked";
  leadUserId: string | null; createdAt: string;
}[] = [];

const CLIENTS: Record<string, unknown>[] = [
  { id: "cl-1", name: "Northwind Traders", contact: { email: "ops@northwind.example" }, status: "active", custom_fields: {} },
  { id: "cl-2", name: "Cedar Group", contact: { email: "hello@cedar.example" }, status: "active", custom_fields: {} },
  { id: "cl-3", name: "Lumen Studio", contact: {}, status: "prospect", custom_fields: {} },
];
const DELIVERABLES: Record<string, unknown>[] = [
  { id: "dl-1", project_id: "p-web-1", client_id: "cl-1", name: "Homepage redesign", status: "in_progress", due_date: "2026-07-20" },
  { id: "dl-2", project_id: "p-web-1", client_id: "cl-1", name: "Checkout rebuild", status: "todo", due_date: "2026-07-28" },
  { id: "dl-3", project_id: "p-seo-1", client_id: "cl-2", name: "Q3 SEO audit report", status: "todo", due_date: "2026-08-01" },
];
const INVOICES: Record<string, unknown>[] = [
  { id: "inv-1", clientId: "cl-1", clientName: "Northwind Traders", periodStart: "2026-06-01", periodEnd: "2026-06-30", status: "sent", currency: "USD", total: 6300, lines: [{ description: "Billable time 2026-06", hours: 42, rate: 150, amount: 6300 }], createdAt: "2026-07-01T09:00:00Z" },
];
const FILES: Record<string, unknown>[] = [
  { id: "f-1", entity_type: "project", entity_id: "p-web-1", filename: "Redesign SOW.pdf", content_type: "application/pdf", byte_size: 184320, scrubbed: true, uploader_id: "u-pm", created_at: "2026-06-20T09:00:00Z", url: null },
  { id: "f-2", entity_type: "task", entity_id: "t-4", filename: "hero-mock.fig", content_type: "application/octet-stream", byte_size: 51200, scrubbed: true, uploader_id: "u-dev", created_at: "2026-07-03T09:00:00Z", url: null },
];

// ---- F2 work-activity feed (P1-04 backend contract, P1-07 wires the UI) ----
// Session-only, dept-1 (Web Dev)-heavy so the department console's Home +
// Activity tab render real rows out of the box. `links` mirror what the real
// auto-link engine would derive (structured hints -> exact; task->project->
// department chain -> inferred) — see FRONTEND-BFF-CONTRACT.md §11.
const WORK_ACTIVITY: Record<string, unknown>[] = [
  {
    id: "wa-1", tenantId: "co-agency", source: "pm", sourceRef: "pm-t-4-1", actorUserId: "u-dev", actorExternal: null,
    verb: "updated", objectKind: "pm_task", objectRef: "t-4", title: "Wire homepage hero",
    payload: {}, occurredAt: "2026-07-22T09:10:00Z", originSite: "central", createdAt: "2026-07-22T09:10:00Z",
    links: [
      { targetKind: "pm_task", targetId: "t-4", confidence: "exact", rule: "structured" },
      { targetKind: "project", targetId: "p-web-1", confidence: "inferred", rule: "task_project_chain" },
      { targetKind: "department", targetId: "dept-1", confidence: "inferred", rule: "project_department_chain" },
      { targetKind: "person", targetId: "u-dev", confidence: "exact", rule: "structured" },
    ],
  },
  {
    id: "wa-2", tenantId: "co-agency", source: "pm", sourceRef: "pm-t-5-1", actorUserId: "u-dev", actorExternal: null,
    verb: "commented", objectKind: "pm_task", objectRef: "t-5", title: "QA checkout flow",
    payload: {}, occurredAt: "2026-07-22T08:05:00Z", originSite: "central", createdAt: "2026-07-22T08:05:00Z",
    links: [
      { targetKind: "pm_task", targetId: "t-5", confidence: "exact", rule: "structured" },
      { targetKind: "project", targetId: "p-web-1", confidence: "inferred", rule: "task_project_chain" },
      { targetKind: "department", targetId: "dept-1", confidence: "inferred", rule: "project_department_chain" },
      { targetKind: "person", targetId: "u-dev", confidence: "exact", rule: "structured" },
    ],
  },
  {
    id: "wa-3", tenantId: "co-agency", source: "manual", sourceRef: "manual-doc-1", actorUserId: "demo-hansel", actorExternal: null,
    verb: "created", objectKind: "doc", objectRef: "doc-1", title: "Homepage hero brief",
    payload: {}, occurredAt: "2026-07-21T15:30:00Z", originSite: "central", createdAt: "2026-07-21T15:30:00Z",
    links: [
      { targetKind: "project", targetId: "p-web-1", confidence: "inferred", rule: "structured" },
      { targetKind: "department", targetId: "dept-1", confidence: "inferred", rule: "project_department_chain" },
      { targetKind: "person", targetId: "demo-hansel", confidence: "exact", rule: "structured" },
    ],
  },
  {
    id: "wa-4", tenantId: "co-agency", source: "system", sourceRef: "tracker-run-t-4-1", actorUserId: null, actorExternal: "scheduler",
    verb: "ran", objectKind: "tracker_run", objectRef: "t-4", title: "AI Tracker analysis",
    payload: {}, occurredAt: "2026-07-21T06:00:00Z", originSite: "central", createdAt: "2026-07-21T06:00:00Z",
    links: [
      { targetKind: "pm_task", targetId: "t-4", confidence: "exact", rule: "structured" },
      { targetKind: "project", targetId: "p-web-1", confidence: "inferred", rule: "task_project_chain" },
      { targetKind: "department", targetId: "dept-1", confidence: "inferred", rule: "project_department_chain" },
    ],
  },
  {
    id: "wa-5", tenantId: "co-agency", source: "pm", sourceRef: "pm-t-6-1", actorUserId: "demo-hansel", actorExternal: null,
    verb: "updated", objectKind: "pm_task", objectRef: "t-6", title: "Keyword gap analysis",
    payload: {}, occurredAt: "2026-07-20T11:00:00Z", originSite: "central", createdAt: "2026-07-20T11:00:00Z",
    links: [
      { targetKind: "pm_task", targetId: "t-6", confidence: "exact", rule: "structured" },
      { targetKind: "project", targetId: "p-seo-1", confidence: "inferred", rule: "task_project_chain" },
      { targetKind: "department", targetId: "dept-3", confidence: "inferred", rule: "project_department_chain" },
      { targetKind: "person", targetId: "demo-hansel", confidence: "exact", rule: "structured" },
    ],
  },
  {
    id: "wa-6", tenantId: "co-agency", source: "pm", sourceRef: "pm-m-1-1", actorUserId: "u-dev", actorExternal: null,
    verb: "created", objectKind: "milestone", objectRef: "m-1", title: "Beta launch",
    payload: {}, occurredAt: "2026-07-19T09:00:00Z", originSite: "central", createdAt: "2026-07-19T09:00:00Z",
    links: [
      { targetKind: "project", targetId: "p-web-1", confidence: "inferred", rule: "structured" },
      { targetKind: "department", targetId: "dept-1", confidence: "inferred", rule: "project_department_chain" },
      { targetKind: "person", targetId: "u-dev", confidence: "exact", rule: "structured" },
    ],
  },
];

interface DemoWorkActivityLink { targetKind: string; targetId: string }
function activityLinks(row: Record<string, unknown>): DemoWorkActivityLink[] {
  return (row.links as DemoWorkActivityLink[] | undefined) ?? [];
}

// ---- WS4 automation-approvals inbox (§8) — feeds the dept console's
// "Waiting on me" rail. Tenant-wide (not department-scoped in the real
// schema), both pending so the demo rail always has something to show.
const AUTOMATION_APPROVALS: Record<string, unknown>[] = [
  {
    id: "aa-1", workflow_id: "wf-device-alert", tool_name: "it.devices.disable",
    tool_args: { deviceId: "dev-cam-park" }, impact: "high",
    reason: "Repeated auth failures on CCTV — Parking; auto-disable suspended for review.",
    status: "pending", origin: "automation", agent_name: null, requested_by: "system",
    decided_by: null, decided_at: null, created_at: "2026-07-21T22:00:00Z",
  },
  {
    id: "aa-2", workflow_id: "wf-summarize", tool_name: "pm.tasks.bulkUpdate",
    tool_args: { projectId: "p-web-1" }, impact: "medium",
    reason: "Bulk status update flagged unclassified by the write gate.",
    status: "pending", origin: "agent", agent_name: "status-reporter", requested_by: "agent:status-reporter",
    decided_by: null, decided_at: null, created_at: "2026-07-22T07:30:00Z",
  },
  // D14-08 — two DECIDED rows so the "Recently decided" section's execution chip has real cases to
  // walk in demo mode without a live backend: one clean run and one that actually needs the Retry
  // button (undecided rows above are always execution_status='not_applicable', per 0078's header —
  // never any of these).
  {
    id: "aa-3", workflow_id: "wf-device-alert", tool_name: "it.devices.disable",
    tool_args: { deviceId: "dev-cam-lobby" }, impact: "high",
    reason: "Repeated auth failures on CCTV — Lobby; auto-disable suspended for review.",
    status: "approved", origin: "automation", agent_name: null, requested_by: "system",
    decided_by: DEMO_USER_ID, decided_at: "2026-07-22T09:10:00Z", created_at: "2026-07-22T09:00:00Z",
    execution_status: "executed", executed_at: "2026-07-22T09:10:05Z", executed_by: DEMO_USER_ID,
    execution_error: null, execution_result: { text: "Device dev-cam-lobby disabled.", truncated: false },
    execution_attempts: 1,
  },
  {
    id: "aa-4", workflow_id: "wf-summarize", tool_name: "pm.tasks.bulkUpdate",
    tool_args: { projectId: "p-web-1" }, impact: "medium",
    reason: "Bulk status update flagged unclassified by the write gate.",
    status: "approved", origin: "agent", agent_name: "status-reporter", requested_by: "agent:status-reporter",
    decided_by: DEMO_USER_ID, decided_at: "2026-07-22T09:20:00Z", created_at: "2026-07-22T09:15:00Z",
    execution_status: "failed", executed_at: null, executed_by: null,
    execution_error: "hub_unreachable: timed out after 3 attempts", execution_result: null,
    execution_attempts: 1,
  },
];

// ---- F1 connections vault + C1 Claude seats (WSUX-14 vault, WSUX-16/17 UI) ----
// Session-only, matches every other demo store's "resets on restart"
// convention. A seat IS a `provider: 'claude'` row, same as the real backend
// (§12a — "no new table, no new secret path"). Seeded with a deliberate mix
// per the plan's WSUX-10 fixture note: demo-hansel is github-connected
// (pending — identity recorded, no token, Phase-1) + claude-seat-mapped
// (exercises "linked"/"opens as …"); Made Putra (u-dev) has a mapped seat +
// pending github too; Dewi Santoso (u-pm) has NOTHING connected (exercises
// every provider's empty "Map your seat"/"Connect" teach state) — so both the
// populated and empty states render out of the box with no setup.
interface DemoConnection {
  id: string; tenantId: string; ownerKind: "user" | "company"; ownerId: string;
  provider: "github" | "google_drive" | "claude";
  externalAccount: string | null; scopes: string[]; status: string;
  hasToken: boolean; hasRefreshToken: boolean; tokenExpiresAt: string | null; tokenKeyVersion: string | null;
  meta: Record<string, unknown>; createdBy: string | null; originSite: string; createdAt: string; updatedAt: string;
}
const CONNECTIONS: DemoConnection[] = [
  {
    id: "conn-1", tenantId: "co-agency", ownerKind: "user", ownerId: DEMO_USER_ID, provider: "github",
    externalAccount: "hansel-gh", scopes: [], status: "pending", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: {}, createdBy: DEMO_USER_ID, originSite: "central",
    createdAt: "2026-07-10T09:00:00Z", updatedAt: "2026-07-10T09:00:00Z",
  },
  {
    id: "conn-2", tenantId: "co-agency", ownerKind: "user", ownerId: DEMO_USER_ID, provider: "claude",
    externalAccount: "hansel@gaiada.com", scopes: [], status: "linked", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: { designLogin: "hansel@gaiada.com" }, createdBy: DEMO_USER_ID,
    originSite: "central", createdAt: "2026-07-10T09:05:00Z", updatedAt: "2026-07-10T09:05:00Z",
  },
  {
    id: "conn-3", tenantId: "co-agency", ownerKind: "user", ownerId: "u-dev", provider: "claude",
    externalAccount: "made@gaiada.com", scopes: [], status: "linked", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: {}, createdBy: "u-dev", originSite: "central",
    createdAt: "2026-07-11T09:00:00Z", updatedAt: "2026-07-11T09:00:00Z",
  },
  {
    id: "conn-4", tenantId: "co-agency", ownerKind: "user", ownerId: "u-dev", provider: "github",
    externalAccount: "made-putra", scopes: [], status: "pending", hasToken: false, hasRefreshToken: false,
    tokenExpiresAt: null, tokenKeyVersion: null, meta: {}, createdBy: "u-dev", originSite: "central",
    createdAt: "2026-07-11T09:10:00Z", updatedAt: "2026-07-11T09:10:00Z",
  },
];

function toSeatRow(c: DemoConnection) {
  return {
    id: c.id, tenantId: c.tenantId, personId: c.ownerId,
    codeSeatEmail: c.externalAccount, designLogin: (c.meta.designLogin as string | null) ?? null,
    status: c.status, scopes: c.scopes,
    mapped: !!c.externalAccount && c.status !== "revoked",
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

const IDENTITY_LINKS = [
  { id: "il-1", user_id: "u-pm", user_name: "Dewi Santoso", provider: "whatsapp", external_id: "628999@c.us", verified_at: "2026-06-01T00:00:00Z" },
  { id: "il-2", user_id: "u-dev", user_name: "Made Putra", provider: "telegram", external_id: "tg:5551", verified_at: null },
];

const COMPLIANCE_GATES = [
  { id: "G.1", key: "G.1", title: "Lawful basis + DPIA/LIA", description: "Lawful basis established and DPIA/LIA completed (not employee consent).", status: "passed", evidence_url: "https://drive.internal/dpia" },
  { id: "G.2", key: "G.2", title: "Monitoring notice + per-individual opt-out", description: "Monitoring notice issued and a working per-individual opt-out is in place.", status: "in_progress", evidence_url: null },
  { id: "G.3", key: "G.3", title: "Retention TTL + auto-purge", description: "Retention TTL configured with automatic purge enforced.", status: "open", evidence_url: null },
  { id: "G.4", key: "G.4", title: "Day-one gate (crypto-shred + scrubber) passed", description: "The technical day-one gate has passed.", status: "passed", evidence_url: "https://drive.internal/day-one-gate" },
  { id: "G.5", key: "G.5", title: "WA ToS risk acceptance recorded", description: "WhatsApp Terms of Service risk acceptance has been recorded.", status: "waived", evidence_url: null },
  { id: "G.6", key: "G.6", title: "Legal counsel engaged (jurisdiction/PCI)", description: "Legal counsel engaged on jurisdiction and PCI considerations.", status: "open", evidence_url: null },
];

// ---- IT: devices, events, n8n workflows ----
const DEVICES: Record<string, Record<string, unknown>[]> = {
  "co-agency": [
    { id: "dev-router", name: "Edge Router", kind: "network", status: "online", site: "Bali Office", network: "Core / VLAN1", ip: "10.0.0.1", mac: "9c:1c:12:aa:00:01", vendor: "MikroTik", model: "RB5009", firmware: "7.14", lastHeartbeatAt: "2026-07-16T01:40:00Z", registeredAt: "2026-03-01T00:00:00Z", uptimeSec: 3987000 },
    { id: "dev-switch", name: "Core Switch", kind: "network", status: "online", site: "Bali Office", network: "Core / VLAN1", ip: "10.0.0.2", mac: "9c:1c:12:aa:00:02", vendor: "UniFi", model: "USW-24-PoE", firmware: "6.6", lastHeartbeatAt: "2026-07-16T01:41:00Z", registeredAt: "2026-03-01T00:00:00Z", uptimeSec: 3980000 },
    { id: "dev-nas", name: "NAS / File Server", kind: "server", status: "online", site: "Bali Office", network: "Core / VLAN1", ip: "10.0.0.10", mac: "00:11:32:aa:10:10", vendor: "Synology", model: "DS1522+", firmware: "DSM 7.2", lastHeartbeatAt: "2026-07-16T01:41:30Z", registeredAt: "2026-03-02T00:00:00Z", uptimeSec: 1200000 },
    { id: "dev-cam-lobby", name: "CCTV — Lobby", kind: "cctv", status: "online", site: "Bali Office", network: "CCTV / VLAN20", ip: "10.0.20.11", mac: "bc:32:5f:aa:20:11", vendor: "Hikvision", model: "DS-2CD2143", firmware: "5.7", lastHeartbeatAt: "2026-07-16T01:41:50Z", registeredAt: "2026-03-05T00:00:00Z", uptimeSec: 900000 },
    { id: "dev-cam-park", name: "CCTV — Parking", kind: "cctv", status: "degraded", site: "Bali Office", network: "CCTV / VLAN20", ip: "10.0.20.12", mac: "bc:32:5f:aa:20:12", vendor: "Hikvision", model: "DS-2CD2143", firmware: "5.7", lastHeartbeatAt: "2026-07-16T01:20:00Z", registeredAt: "2026-03-05T00:00:00Z", uptimeSec: 40000 },
    { id: "dev-printer", name: "Office Printer", kind: "printer", status: "online", site: "Bali Office", network: "Workstations / VLAN10", ip: "10.0.10.30", mac: "3c:2a:f4:aa:10:30", vendor: "Brother", model: "MFC-L8900", firmware: "1.32", lastHeartbeatAt: "2026-07-16T01:35:00Z", registeredAt: "2026-03-08T00:00:00Z", uptimeSec: 600000 },
    { id: "dev-ws-dev", name: "WS — Dev 01", kind: "workstation", status: "online", site: "Bali Office", network: "Workstations / VLAN10", ip: "10.0.10.41", mac: "a4:83:e7:aa:10:41", vendor: "Apple", model: "Mac mini M2", firmware: "macOS 15", lastHeartbeatAt: "2026-07-16T01:39:00Z", registeredAt: "2026-04-01T00:00:00Z", uptimeSec: 210000 },
    { id: "dev-ws-design", name: "WS — Design 01", kind: "workstation", status: "offline", site: "Bali Office", network: "Workstations / VLAN10", ip: "10.0.10.42", mac: "a4:83:e7:aa:10:42", vendor: "Dell", model: "XPS 15", firmware: "Win 11", lastHeartbeatAt: "2026-07-15T11:00:00Z", registeredAt: "2026-04-01T00:00:00Z", uptimeSec: 0 },
    { id: "dev-phone-1", name: "Dewi — iPhone", kind: "iot", status: "online", site: "Bali Office", network: "Guest / WiFi", ip: "10.0.30.51", mac: "f0:18:98:aa:30:51", vendor: "Apple", model: "iPhone 15", firmware: "iOS 19", lastHeartbeatAt: "2026-07-16T01:42:00Z", registeredAt: "2026-06-01T00:00:00Z", uptimeSec: 88000 },
    { id: "dev-sensor-1", name: "Server Room Temp", kind: "sensor", status: "online", site: "Bali Office", network: "Core / VLAN1", ip: "10.0.0.60", mac: "24:6f:28:aa:00:60", vendor: "Shelly", model: "H&T", firmware: "1.4", lastHeartbeatAt: "2026-07-16T01:40:30Z", registeredAt: "2026-05-10T00:00:00Z", uptimeSec: 500000 },
  ],
  "co-holding": [
    { id: "dev-hold-fw", name: "HQ Firewall", kind: "network", status: "online", site: "Head Office", network: "Core", ip: "172.16.0.1", mac: "9c:1c:12:bb:00:01", vendor: "Fortinet", model: "FortiGate 40F", firmware: "7.4", lastHeartbeatAt: "2026-07-16T01:41:00Z", registeredAt: "2026-02-01T00:00:00Z", uptimeSec: 4200000 },
    { id: "dev-hold-nas", name: "Finance NAS", kind: "server", status: "online", site: "Head Office", network: "Core", ip: "172.16.0.10", mac: "00:11:32:bb:00:10", vendor: "Synology", model: "DS923+", firmware: "DSM 7.2", lastHeartbeatAt: "2026-07-16T01:40:00Z", registeredAt: "2026-02-02T00:00:00Z", uptimeSec: 4100000 },
  ],
};

const DEVICE_EVENTS: Record<string, Record<string, unknown>[]> = {
  "co-agency": [
    { id: "de-1", deviceId: "dev-cam-park", deviceName: "CCTV — Parking", type: "degraded", severity: "warn", message: "Frame rate dropped; packet loss on VLAN20.", occurred_at: "2026-07-16T01:20:00Z" },
    { id: "de-2", deviceId: "dev-ws-design", deviceName: "WS — Design 01", type: "offline", severity: "critical", message: "Missed 6 consecutive heartbeats — went offline.", occurred_at: "2026-07-15T11:05:00Z" },
    { id: "de-3", deviceId: "dev-sensor-1", deviceName: "Server Room Temp", type: "alert", severity: "warn", message: "Temperature 28.4°C exceeded 27°C threshold.", occurred_at: "2026-07-15T09:30:00Z" },
    { id: "de-4", deviceId: "dev-nas", deviceName: "NAS / File Server", type: "online", severity: "info", message: "Back online after scheduled reboot.", occurred_at: "2026-07-14T22:00:00Z" },
    { id: "de-5", deviceId: "dev-phone-1", deviceName: "Dewi — iPhone", type: "registered", severity: "info", message: "New connected device registered on Guest / WiFi.", occurred_at: "2026-06-01T03:00:00Z" },
  ],
};

// Recent reachability samples (1 = up, lower = degraded/latency) for the detail sparkline.
const HEARTBEATS: Record<string, number[]> = {
  "dev-cam-park": [1, 1, 1, 0.9, 0.7, 0.6, 0.8, 0.5, 0.6, 0.7],
  "dev-ws-design": [1, 1, 1, 1, 0.4, 0, 0, 0, 0, 0],
};
const HEARTBEAT_DEFAULT = [1, 1, 0.98, 1, 1, 0.99, 1, 1, 1, 1];

const N8N_WORKFLOWS_LIST = [
  { id: "wf-summarize", name: "summarize-via-mcp", active: true, updatedAt: "2026-07-15T06:00:00Z" },
  { id: "wf-digest", name: "daily-digest-scheduler", active: true, updatedAt: "2026-07-14T18:00:00Z" },
  { id: "wf-device-alert", name: "device-offline-notify", active: false, updatedAt: "2026-07-13T10:00:00Z" },
];

const N8N_WORKFLOWS: Record<string, Record<string, unknown>> = {
  "wf-summarize": {
    id: "wf-summarize", name: "summarize-via-mcp", active: true,
    nodes: [
      { id: "n1", name: "Webhook", type: "n8n-nodes-base.webhook", position: [240, 300] },
      { id: "n2", name: "MCP: fetch context", type: "n8n-nodes-base.httpRequest", position: [520, 300] },
      { id: "n3", name: "LLM Summarize", type: "n8n-nodes-base.openAi", position: [800, 300] },
      { id: "n4", name: "Respond", type: "n8n-nodes-base.respondToWebhook", position: [1080, 300] },
    ],
    connections: {
      Webhook: { main: [[{ node: "MCP: fetch context", type: "main", index: 0 }]] },
      "MCP: fetch context": { main: [[{ node: "LLM Summarize", type: "main", index: 0 }]] },
      "LLM Summarize": { main: [[{ node: "Respond", type: "main", index: 0 }]] },
    },
  },
  "wf-digest": {
    id: "wf-digest", name: "daily-digest-scheduler", active: true,
    nodes: [
      { id: "d1", name: "Cron 12:00/18:00", type: "n8n-nodes-base.scheduleTrigger", position: [240, 300] },
      { id: "d2", name: "MCP: list groups", type: "n8n-nodes-base.httpRequest", position: [520, 200] },
      { id: "d3", name: "MCP: fetch messages", type: "n8n-nodes-base.httpRequest", position: [520, 400] },
      { id: "d4", name: "LLM Summarize", type: "n8n-nodes-base.openAi", position: [820, 300] },
      { id: "d5", name: "WhatsApp Send", type: "n8n-nodes-base.httpRequest", position: [1100, 300] },
    ],
    connections: {
      "Cron 12:00/18:00": { main: [[{ node: "MCP: list groups", type: "main", index: 0 }, { node: "MCP: fetch messages", type: "main", index: 0 }]] },
      "MCP: list groups": { main: [[{ node: "LLM Summarize", type: "main", index: 0 }]] },
      "MCP: fetch messages": { main: [[{ node: "LLM Summarize", type: "main", index: 0 }]] },
      "LLM Summarize": { main: [[{ node: "WhatsApp Send", type: "main", index: 0 }]] },
    },
  },
  "wf-device-alert": {
    id: "wf-device-alert", name: "device-offline-notify", active: false,
    nodes: [
      { id: "a1", name: "Device Event", type: "n8n-nodes-base.webhook", position: [240, 300] },
      { id: "a2", name: "IF offline", type: "n8n-nodes-base.if", position: [520, 300] },
      { id: "a3", name: "MCP: notify", type: "n8n-nodes-base.httpRequest", position: [820, 300] },
    ],
    connections: {
      "Device Event": { main: [[{ node: "IF offline", type: "main", index: 0 }]] },
      "IF offline": { main: [[{ node: "MCP: notify", type: "main", index: 0 }]] },
    },
  },
};

// SM-29 — demo store for the engagement scope editor, so a PUT in a demo session actually
// persists. NOT a plain module-level object like the ENGAGEMENTS/CLIENTS consts above: Next.js
// compiles a Server Action's own route chunk separately from the page's RSC render chunk, and in
// this app's build (standalone output) the two can end up with SEPARATE instances of this module
// — a plain in-memory object mutated by the PUT (which runs inside the action chunk) was silently
// invisible to the very next page render's GET (running in the page chunk), so a save appeared to
// revert the instant `router.refresh()` re-rendered the page. Backing the store with a small JSON
// file in the OS temp dir sidesteps that: any chunk that reads/writes it goes through the
// filesystem, which is shared regardless of how many module instances exist. This is demo-only
// scaffolding — the real backend has exactly one Postgres row, so this constraint doesn't apply
// there. Seeded from the same two engagements as ENGAGEMENTS above: sm-eng-1 has a real starting
// scope + budget, sm-eng-2 starts with none (the "—" case is preserved by simply not seeding a
// cost-projection response for it below).
import { readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ScopeStoreEntry = { scopePreset: string | null; toolScope: Record<string, unknown>; providerBudgetUsd: number | null };
type ScopeStore = Record<string, ScopeStoreEntry>;

const SCOPE_STORE_PATH = join(tmpdir(), "gaiada-demo-search-scope.json");
const SCOPE_STORE_SEED: ScopeStore = {
  "sm-eng-1": {
    scopePreset: null,
    toolScope: { rank: { enabled: true, cadence: "weekly", maxKeywords: 50 }, volume: { enabled: true }, backlinks: { enabled: false } },
    providerBudgetUsd: 150,
  },
  "sm-eng-2": { scopePreset: null, toolScope: {}, providerBudgetUsd: null },
  // SM-19 (ticket's own instruction): "one seed exercises the awkward states together" — a
  // single-provider capability (rank/serp — SINGLE_PROVIDER_TOOLS), a provider with no key
  // (backlinks, enabled but keyless-disabled — see demoProjectMonthlyCost's DEMO_UNAVAILABLE_TOOLS
  // below), a simulated action (demoProviderMode returns 'simulate' for this id too), and an action
  // a budget tier would refuse (providerBudgetUsd set well below rank's own projected cost, so
  // `overBudget` is true from real arithmetic — never hardcoded independent of the projection).
  "sm-eng-3": {
    scopePreset: null,
    toolScope: {
      rank: { enabled: true, cadence: "weekly", maxKeywords: 50 },
      backlinks: { enabled: true, cadence: "monthly" },
    },
    providerBudgetUsd: 5,
  },
};

function loadScopeStore(): ScopeStore {
  try {
    return JSON.parse(readFileSync(SCOPE_STORE_PATH, "utf8")) as ScopeStore;
  } catch {
    writeFileSync(SCOPE_STORE_PATH, JSON.stringify(SCOPE_STORE_SEED));
    return JSON.parse(JSON.stringify(SCOPE_STORE_SEED)) as ScopeStore;
  }
}

function saveScopeStore(store: ScopeStore): void {
  writeFileSync(SCOPE_STORE_PATH, JSON.stringify(store));
}

// Mirrors platform-nest scope-presets.ts SEEDED_PRESETS — seeding data only, applied on a demo
// PUT that names a preset. Kept minimal (matches the same three presets, same shapes) rather than
// imported, since demoFixtures.ts cannot reach across into platform-nest.
//
// SM-61 (tracker §6au Ruling 1 clause 2, binding): `standard`/`heavy`'s `volume` gains
// `cadence: "monthly"` — mirrors platform-nest scope-presets.ts's own change verbatim (see that
// file's header note for the price-identity reasoning: `demoRunsPerMonth("monthly") === 1`, the
// SAME figure the pre-SM-61 cadence-less shape already priced).
const DEMO_SCOPE_PRESETS: Record<string, Record<string, unknown>> = {
  light: {
    rank: { enabled: false }, volume: { enabled: false }, backlinks: { enabled: false }, ai_visibility: { enabled: false },
    audit_technical: { enabled: true, cadence: "monthly" }, audit_cwv: { enabled: true, cadence: "monthly" }, sem_sync: { enabled: false, mode: "manual" },
  },
  standard: {
    rank: { enabled: true, cadence: "weekly", maxKeywords: 50 }, volume: { enabled: true, cadence: "monthly" }, backlinks: { enabled: false },
    ai_visibility: { enabled: true, cadence: "weekly" }, audit_technical: { enabled: true, cadence: "weekly" }, audit_cwv: { enabled: true },
    sem_sync: { enabled: false, mode: "manual" },
  },
  heavy: {
    rank: { enabled: true, cadence: "daily", maxKeywords: 200 }, volume: { enabled: true, cadence: "monthly" }, backlinks: { enabled: true, cadence: "monthly" },
    ai_visibility: { enabled: true, cadence: "weekly" }, audit_technical: { enabled: true, cadence: "weekly" }, audit_cwv: { enabled: true, cadence: "weekly" },
    sem_sync: { enabled: true, mode: "manual" },
  },
};

// SM-61 (§6au clause 4): mirrors search.controller.ts's `validateToolScopeCadence` — the demo PUT
// must 400 the same junk the real backend now refuses, so a demo-mode user editing the scope panel
// sees the same behaviour a real backend would give. Absent/null is always accepted (on-demand).
const DEMO_VALID_CADENCES = new Set(["daily", "weekly", "monthly"]);
function demoValidateToolScopeCadence(toolScope: Record<string, unknown>): string | null {
  for (const [tool, raw] of Object.entries(toolScope)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const cadence = (raw as Record<string, unknown>).cadence;
    if (cadence === undefined || cadence === null) continue;
    if (typeof cadence !== "string" || !DEMO_VALID_CADENCES.has(cadence)) {
      return `tool_scope.${tool}.cadence must be one of daily|weekly|monthly, or absent/null`;
    }
  }
  return null;
}

// Demo-only per-item unit cost table — NOT the real estimateCostUsd, purely so the scope editor
// has something to preview against with no backend running. $/item chosen so 'standard's rank
// toggle (50 items/weekly) lands on the same $10/mo the original SM-11 fixture used.
const DEMO_UNIT_COST_USD: Record<string, number> = { rank: 0.05, volume: 0.1, suggestions: 0.02, backlinks: 3, ai_visibility: 0.5 };
const DEMO_TOGGLE_OP: Record<string, string> = { rank: "serp", volume: "volume", suggestions: "suggestions", backlinks: "backlinks", ai_visibility: "ai_visibility" };
// SM-61 (§6au clause 3): mirrors pull-scheduler.ts's SCHEDULED_TOOLS — `suggestions` is deliberately
// absent (no scheduled flow was ever specced for it).
const DEMO_SCHEDULED_TOOLS = new Set(["rank", "volume", "backlinks", "ai_visibility"]);

function demoRunsPerMonth(cadence: unknown): number {
  if (cadence === "daily") return 30;
  if (cadence === "weekly") return 30 / 7;
  if (cadence === "monthly") return 1;
  return 1; // absent/junk => the on-demand usage estimate (ON_DEMAND_ESTIMATE_RUNS_PER_MONTH), never a schedule
}

// SM-38: mirror the real backend's per-dispatch mode stamp (`providers/simulation.ts` +
// `projectMonthlyCost` in `providers/dispatch.ts`) — in `simulate` mode EVERY row is stamped
// simulated, in `live` mode none are (pre-SM-36 there is exactly one platform-default provider per
// op kind, so one projection can never straddle both — see registry.ts's `resolveProvider`). The
// "realistic mix — some simulated rows, some not" this ticket's AC asks for is exercised ACROSS the
// two seeded engagements rather than fabricated within one, since making a single response straddle
// both modes would demo a shape the real backend cannot produce today (a divergent claim, not a
// realistic one): `sm-eng-1` demos SIMULATE (chip present on every enabled row + the header
// statement), `sm-eng-2` demos LIVE (chip absent) — so both states are reachable in one demo pass.
function demoProviderMode(engagementId: string): "live" | "simulate" {
  return engagementId === "sm-eng-1" || engagementId === "sm-eng-3" ? "simulate" : "live";
}

// SM-19 — "a provider with no key" exercised on `sm-eng-3` only, so `sm-eng-1`'s existing
// (previously-verified) shape is untouched. Mirrors the real `resolveProvider`/`projectMonthlyCost`
// behaviour on a resolution failure exactly: `provider: null`, `costPerRunUsd/projectedMonthlyUsd`
// STAY 0 (never invented), and `note` carries the same wording `NoCapableProviderError` would —
// PaidActionGate's own honesty rule #4 ("unavailable != free") is what a caller must render from
// this, not a special-cased demo-only field.
const DEMO_UNAVAILABLE_TOOLS: Record<string, ReadonlySet<string>> = {
  "sm-eng-3": new Set(["backlinks"]),
};

function demoProjectMonthlyCost(toolScope: Record<string, unknown>, engagementId: string) {
  const providerMode = demoProviderMode(engagementId);
  const unavailable = DEMO_UNAVAILABLE_TOOLS[engagementId] ?? new Set<string>();
  const perTool = Object.entries(DEMO_TOGGLE_OP).map(([tool, opKind]) => {
    const toggle = (toolScope[tool] ?? {}) as Record<string, unknown>;
    const enabled = toggle.enabled === true;
    // SM-61 (§6au clause 3): junk/absent both collapse to null here too — mirrors `parseCadence`'s
    // no-default parse, never echoing a typo back as though it were a real cadence.
    const rawCadence = typeof toggle.cadence === "string" ? toggle.cadence : null;
    const cadence = rawCadence !== null && DEMO_VALID_CADENCES.has(rawCadence) ? rawCadence : null;
    const items = tool === "backlinks" ? 1 : (typeof toggle.maxKeywords === "number" ? toggle.maxKeywords : (typeof toggle.maxQueries === "number" ? toggle.maxQueries : 50));
    const runs = demoRunsPerMonth(cadence);
    // Mirrors the real `ProjectedToolCost.scheduled` derivation exactly: enabled ∧ real cadence ∧
    // tool ∈ the scheduled set. `suggestions` can never be true (not in DEMO_SCHEDULED_TOOLS).
    const scheduled = enabled && cadence !== null && DEMO_SCHEDULED_TOOLS.has(tool);
    const isUnavailable = enabled && unavailable.has(tool);
    const costPerRun = isUnavailable ? 0 : DEMO_UNIT_COST_USD[tool] * items;
    const projected = enabled && !isUnavailable ? costPerRun * runs : 0;
    return {
      tool, opKind, enabled, cadence, scheduled, runsPerMonth: Number(runs.toFixed(4)), itemsPerRun: items,
      // Real numbers, not strings — the real controller's ProjectedToolCost wraps these in
      // Number(...toFixed(6)) (providers/dispatch.ts); an earlier revision of this fixture left
      // them as .toFixed() STRINGS, which formatUsd tolerates but which drifted from the real
      // contract's actual type (exactly the class of fixture-vs-backend gap this module warns about).
      costPerRunUsd: Number(costPerRun.toFixed(6)), projectedMonthlyUsd: Number(projected.toFixed(6)),
      provider: isUnavailable ? null : "dataforseo", simulated: providerMode === "simulate",
      note: isUnavailable ? "no provider available to estimate (NoCapableProviderError: no capable provider registered for backlinks)" : undefined,
    };
  });
  const total = perTool.reduce((s, t) => s + t.projectedMonthlyUsd, 0);
  return { engagementId, perTool, totalMonthlyUsd: Number(total.toFixed(6)), providerMode };
}

// SM-12 — file-backed demo stores for Site Audit + Keywords, same rationale as the SM-29 scope
// store just above (a plain module-level object mutated by a POST/PATCH running in the server-
// action chunk is invisible to a GET running in the page-render chunk in this app's build — see
// that store's header note). Field names mirror the REAL controller response shapes exactly
// (search.controller.ts's listAudits/listAuditFindings/listKeywordSets/listKeywords SELECT lists,
// verified against the same controller this ticket's fetchers were built against) — not the demo's
// own invented shape, per this ticket's own warning about how a fixture that agrees with a wrong
// assumption hides the bug instead of catching it.
const AUDIT_STORE_PATH = join(tmpdir(), "gaiada-demo-search-audits.json");
const KEYWORD_STORE_PATH = join(tmpdir(), "gaiada-demo-search-keywords.json");

interface DemoAuditFinding {
  id: string; auditId: string; code: string; severity: string; category: string; message: string;
  urlCount: number; sampleUrls: string[]; status: string; firstSeenAuditId: string | null;
  lastSeenAuditId: string | null; createdAt: string;
}
interface DemoAudit {
  id: string; propertyId: string; kind: string; source: string; status: string; score: string;
  summary: Record<string, number>; startedAt: string; completedAt: string; createdAt: string;
}
interface AuditStore { audits: DemoAudit[]; findings: DemoAuditFinding[] }

const AUDIT_STORE_SEED: AuditStore = {
  audits: [
    {
      id: "sm-audit-1", propertyId: "sm-prop-1", kind: "technical", source: "crawler", status: "completed",
      score: "72", summary: { critical: 1, high: 1, medium: 2, low: 0, info: 0 },
      startedAt: "2026-07-20T02:00:00Z", completedAt: "2026-07-20T02:04:00Z", createdAt: "2026-07-20T02:04:00Z",
    },
  ],
  findings: [
    {
      id: "sm-finding-1", auditId: "sm-audit-1", code: "server_error", severity: "critical", category: "availability",
      message: "Server error (500)", urlCount: 2, sampleUrls: ["https://cedargroup.example.com/checkout", "https://cedargroup.example.com/api/quote"],
      status: "open", firstSeenAuditId: "sm-audit-1", lastSeenAuditId: "sm-audit-1", createdAt: "2026-07-20T02:04:00Z",
    },
    {
      id: "sm-finding-2", auditId: "sm-audit-1", code: "client_error", severity: "high", category: "availability",
      message: "Client error (403)", urlCount: 1, sampleUrls: ["https://cedargroup.example.com/members"],
      status: "open", firstSeenAuditId: "sm-audit-1", lastSeenAuditId: "sm-audit-1", createdAt: "2026-07-20T02:04:00Z",
    },
    {
      id: "sm-finding-3", auditId: "sm-audit-1", code: "missing_title", severity: "medium", category: "content",
      message: "Page has no <title>", urlCount: 4, sampleUrls: ["https://cedargroup.example.com/blog/draft-1", "https://cedargroup.example.com/blog/draft-2"],
      status: "open", firstSeenAuditId: "sm-audit-1", lastSeenAuditId: "sm-audit-1", createdAt: "2026-07-20T02:04:00Z",
    },
    {
      id: "sm-finding-4", auditId: "sm-audit-1", code: "broken_link", severity: "medium", category: "availability",
      message: "Page not found (404)", urlCount: 3, sampleUrls: ["https://cedargroup.example.com/old-promo"],
      status: "fixed", firstSeenAuditId: "sm-audit-1", lastSeenAuditId: "sm-audit-1", createdAt: "2026-07-20T02:04:00Z",
    },
  ],
};

function loadAuditStore(): AuditStore {
  try {
    return JSON.parse(readFileSync(AUDIT_STORE_PATH, "utf8")) as AuditStore;
  } catch {
    writeFileSync(AUDIT_STORE_PATH, JSON.stringify(AUDIT_STORE_SEED));
    return JSON.parse(JSON.stringify(AUDIT_STORE_SEED)) as AuditStore;
  }
}

function saveAuditStore(store: AuditStore): void {
  writeFileSync(AUDIT_STORE_PATH, JSON.stringify(store));
}

interface DemoKeywordSet { id: string; engagementId: string; name: string; source: string; createdAt: string }
interface DemoKeyword {
  id: string; setId: string; keyword: string; locale: string; intent: string | null;
  clusterId: string | null; clusterLabel: string | null; volume: number | null;
  difficulty: string | null; cpcUsd: string | null;
  // SM-14 (tracker §6j AC4): mirrors search_keywords' 0048 columns — metricsProvider is nullable
  // (no pull yet = null, never a guessed vendor), metricsSimulated is a real boolean (0048's `NOT
  // NULL DEFAULT false`), never absent even for a never-pulled keyword.
  metricsProvider: string | null; metricsSimulated: boolean;
  isTracked: boolean; hasEmbedding: boolean; createdAt: string;
}
interface KeywordStore { sets: DemoKeywordSet[]; keywords: DemoKeyword[] }

// Deliberately covers all THREE volume states (`keywordVolumeState`'s header note in
// searchMarketingShared.ts): sm-eng-1's `volume` scope toggle is enabled in SCOPE_STORE_SEED above,
// so "seo audit tools" (a real pulled number) exercises 'value' and "technical seo checklist" (never
// pulled) exercises 'unpulled'; sm-eng-2's toggle is off, so "ai overview optimization" exercises
// 'disabled' regardless of the raw (null) volume underneath it. Provenance (metricsProvider/
// metricsSimulated) tracks the same split: a pulled volume carries 'semrush'/true (§A2's default
// vendor for volume/difficulty, matching SM-46c's real seed stamp), a never-pulled one carries
// null/false — never invented, per SM-14's own AC4.
const KEYWORD_STORE_SEED: KeywordStore = {
  sets: [
    { id: "sm-set-1", engagementId: "sm-eng-1", name: "Core service pages", source: "client", createdAt: "2026-07-18T00:00:00Z" },
    { id: "sm-set-2", engagementId: "sm-eng-2", name: "GEO pilot terms", source: "research", createdAt: "2026-07-19T00:00:00Z" },
  ],
  keywords: [
    {
      id: "sm-kw-1", setId: "sm-set-1", keyword: "seo audit tools", locale: "id-ID", intent: "commercial",
      clusterId: "sm-cluster-1", clusterLabel: "SEO tooling", volume: 210, difficulty: "42.50", cpcUsd: "3.750000",
      metricsProvider: "semrush", metricsSimulated: true,
      isTracked: true, hasEmbedding: true, createdAt: "2026-07-18T00:05:00Z",
    },
    {
      id: "sm-kw-2", setId: "sm-set-1", keyword: "seo audit checklist", locale: "id-ID", intent: "commercial",
      clusterId: "sm-cluster-1", clusterLabel: "SEO tooling", volume: 140, difficulty: "38.00", cpcUsd: "2.900000",
      metricsProvider: "semrush", metricsSimulated: true,
      isTracked: false, hasEmbedding: true, createdAt: "2026-07-18T00:05:00Z",
    },
    {
      id: "sm-kw-3", setId: "sm-set-1", keyword: "technical seo checklist", locale: "id-ID", intent: null,
      clusterId: null, clusterLabel: null, volume: null, difficulty: null, cpcUsd: null,
      metricsProvider: null, metricsSimulated: false,
      isTracked: false, hasEmbedding: false, createdAt: "2026-07-18T00:05:00Z",
    },
    {
      id: "sm-kw-4", setId: "sm-set-2", keyword: "ai overview optimization", locale: "id-ID", intent: null,
      clusterId: null, clusterLabel: null, volume: null, difficulty: null, cpcUsd: null,
      metricsProvider: null, metricsSimulated: false,
      isTracked: false, hasEmbedding: false, createdAt: "2026-07-19T00:05:00Z",
    },
  ],
};

function loadKeywordStore(): KeywordStore {
  try {
    return JSON.parse(readFileSync(KEYWORD_STORE_PATH, "utf8")) as KeywordStore;
  } catch {
    writeFileSync(KEYWORD_STORE_PATH, JSON.stringify(KEYWORD_STORE_SEED));
    return JSON.parse(JSON.stringify(KEYWORD_STORE_SEED)) as KeywordStore;
  }
}

function saveKeywordStore(store: KeywordStore): void {
  writeFileSync(KEYWORD_STORE_PATH, JSON.stringify(store));
}

// SM-47 — file-backed demo store for SEM (campaigns/ad groups/ads/negatives/change proposals). Same
// file-backed rationale as the audit/keyword stores just above (a POST running in the server-action
// chunk must be visible to a GET running in the page-render chunk — see the SM-29 scope store's
// header note earlier in this file for the fuller explanation). Field names mirror
// search.controller.ts's SEM SELECT lists exactly, INCLUDING `created_at`/`updated_at` staying
// unaliased (snake_case) — see searchMarketingShared.ts's header note on why that one detail matters
// here specifically.
const SEM_STORE_PATH = join(tmpdir(), "gaiada-demo-search-sem.json");

interface DemoCampaign {
  id: string; engagementId: string; platform: string; externalId: string | null; name: string;
  objective: string | null; status: string; budgetMinor: number | null; currency: string | null;
  bidStrategy: string | null; targetCpaMinor: number | null; targetRoas: number | null;
  customFields: Record<string, unknown>; created_at: string; updated_at: string;
}
interface DemoAdGroup {
  id: string; campaignId: string; name: string; clusterId: string | null; externalId: string | null;
  created_at: string; updated_at: string;
}
interface DemoAd {
  id: string; adGroupId: string; headlines: string[]; descriptions: string[]; finalUrl: string | null;
  status: string; aiGenerated: boolean; created_at: string; updated_at: string;
}
interface DemoNegative {
  id: string; campaignId: string; adGroupId: string | null; term: string; matchType: string;
  source: string; status: string; created_at: string; updated_at: string;
}
interface DemoChangeProposal {
  id: string; campaignId: string; kind: string; payload: Record<string, unknown>; status: string;
  mode: string; approvalId: string | null; exportFileId: string | null; proposedBy: string | null;
  approvedBy: string | null; appliedBy: string | null; appliedAt: string | null;
  created_at: string; updated_at: string;
}
interface SemStore {
  campaigns: DemoCampaign[]; adGroups: DemoAdGroup[]; ads: DemoAd[];
  negatives: DemoNegative[]; changeProposals: DemoChangeProposal[];
}

// sm-campaign-1 is the "already generated" campaign — pre-seeded WITHOUT provenance on its ad
// groups, deliberately: `GET campaigns/:id/ad-groups` on the real backend never carries provenance
// (only the generate-plan RESPONSE does — see `PlannedAdGroupResult`'s header note), so faking it
// onto the persisted read here would misrepresent what a real deployment can show. The mixed real/
// simulated/unpulled/two-provider breakdown is instead exercised live by actually calling
// "Generate plan" in the browser (see the generate-plan handler below), which is the one moment the
// real system can show it too. sm-campaign-2 is the genuine "nothing planned yet" empty case: draft
// status, zero ad groups/negatives/proposals.
const SEM_STORE_SEED: SemStore = {
  campaigns: [
    {
      id: "sm-campaign-1", engagementId: "sm-eng-1", platform: "google_ads", externalId: null,
      name: "Cedar Group — Core Services Search", objective: "leads", status: "proposed",
      budgetMinor: 500000, currency: "USD", bidStrategy: "maximize_conversions", targetCpaMinor: 8000,
      targetRoas: 4.5, customFields: {}, created_at: "2026-07-22T09:00:00Z", updated_at: "2026-07-24T11:00:00Z",
    },
    {
      id: "sm-campaign-2", engagementId: "sm-eng-1", platform: "google_ads", externalId: null,
      name: "Cedar Group — Brand (manual draft)", objective: null, status: "draft",
      budgetMinor: null, currency: null, bidStrategy: null, targetCpaMinor: null, targetRoas: null,
      customFields: {}, created_at: "2026-07-25T09:00:00Z", updated_at: "2026-07-25T09:00:00Z",
    },
  ],
  adGroups: [
    { id: "sm-ag-1", campaignId: "sm-campaign-1", name: "SEO tooling — core", clusterId: "sm-cluster-1", externalId: null, created_at: "2026-07-22T09:01:00Z", updated_at: "2026-07-22T09:01:00Z" },
    { id: "sm-ag-2", campaignId: "sm-campaign-1", name: "Consulting — mixed vendors", clusterId: "sm-cluster-2", externalId: null, created_at: "2026-07-22T09:02:00Z", updated_at: "2026-07-22T09:02:00Z" },
    { id: "sm-ag-3", campaignId: "sm-campaign-1", name: "Emerging terms", clusterId: "sm-cluster-3", externalId: null, created_at: "2026-07-22T09:03:00Z", updated_at: "2026-07-22T09:03:00Z" },
  ],
  // Covers all three AD_STATUSES_WRITABLE states + both aiGenerated values on one ad group.
  ads: [
    { id: "sm-ad-1", adGroupId: "sm-ag-1", headlines: ["SEO Audit Tools", "Free Site Crawl", "Fix Technical SEO Fast"], descriptions: ["Run a full technical audit in minutes.", "Trusted by 200+ agencies."], finalUrl: "https://cedargroup.example.com/tools", status: "approved", aiGenerated: true, created_at: "2026-07-22T09:10:00Z", updated_at: "2026-07-23T10:00:00Z" },
    { id: "sm-ad-2", adGroupId: "sm-ag-1", headlines: ["SEO Checklist 2026", "Step-by-Step Audit Guide"], descriptions: ["Download the checklist our team uses.", "No signup required."], finalUrl: null, status: "draft", aiGenerated: false, created_at: "2026-07-23T09:00:00Z", updated_at: "2026-07-23T09:00:00Z" },
    { id: "sm-ad-3", adGroupId: "sm-ag-1", headlines: ["Cheap SEO Tools", "SEO On A Budget"], descriptions: ["Off-brief draft — rejected."], finalUrl: null, status: "rejected", aiGenerated: true, created_at: "2026-07-23T09:05:00Z", updated_at: "2026-07-23T09:20:00Z" },
  ],
  // Covers all three NEGATIVE_STATUSES_WRITABLE states + both sources (manual/ai).
  negatives: [
    { id: "sm-neg-1", campaignId: "sm-campaign-1", adGroupId: null, term: "free", matchType: "broad", source: "manual", status: "approved", created_at: "2026-07-22T09:30:00Z", updated_at: "2026-07-23T09:00:00Z" },
    { id: "sm-neg-2", campaignId: "sm-campaign-1", adGroupId: null, term: "jobs", matchType: "phrase", source: "ai", status: "proposed", created_at: "2026-07-24T09:00:00Z", updated_at: "2026-07-24T09:00:00Z" },
    { id: "sm-neg-3", campaignId: "sm-campaign-1", adGroupId: null, term: "diy", matchType: "exact", source: "ai", status: "dismissed", created_at: "2026-07-24T09:01:00Z", updated_at: "2026-07-24T09:15:00Z" },
  ],
  // SM-19: 'applied' is NO LONGER absent — the manual mark-applied door (SM-30) is now wired in
  // demo mode too (see the export/mark-applied handlers below), so sm-cp-1 stays interactively
  // reachable (approved/manual — Export then Mark as applied) and sm-cp-4/sm-cp-5 seed the two
  // states that would otherwise need clicking through: an already-APPLIED manual proposal (re-
  // download + "Applied by/at" render without any action), and an approved API-MODE proposal (the
  // automated twin's honest "no executor yet" disclosure, SM-21 not built).
  changeProposals: [
    { id: "sm-cp-1", campaignId: "sm-campaign-1", kind: "budget", payload: { newBudgetMinor: 750000 }, status: "approved", mode: "manual", approvalId: null, exportFileId: null, proposedBy: DEMO_USER_ID, approvedBy: DEMO_USER_ID, appliedBy: null, appliedAt: null, created_at: "2026-07-23T12:00:00Z", updated_at: "2026-07-23T13:00:00Z" },
    { id: "sm-cp-2", campaignId: "sm-campaign-1", kind: "pause", payload: { reason: "budget review" }, status: "proposed", mode: "manual", approvalId: null, exportFileId: null, proposedBy: DEMO_USER_ID, approvedBy: null, appliedBy: null, appliedAt: null, created_at: "2026-07-25T09:00:00Z", updated_at: "2026-07-25T09:00:00Z" },
    { id: "sm-cp-3", campaignId: "sm-campaign-1", kind: "bid", payload: { bidStrategy: "target_roas" }, status: "dismissed", mode: "manual", approvalId: null, exportFileId: null, proposedBy: DEMO_USER_ID, approvedBy: null, appliedBy: null, appliedAt: null, created_at: "2026-07-22T14:00:00Z", updated_at: "2026-07-22T15:00:00Z" },
    { id: "sm-cp-4", campaignId: "sm-campaign-1", kind: "pause", payload: {}, status: "applied", mode: "manual", approvalId: null, exportFileId: "sm-file-cp4", proposedBy: DEMO_USER_ID, approvedBy: DEMO_USER_ID, appliedBy: DEMO_USER_ID, appliedAt: "2026-07-26T10:00:00Z", created_at: "2026-07-25T18:00:00Z", updated_at: "2026-07-26T10:00:00Z" },
    { id: "sm-cp-5", campaignId: "sm-campaign-1", kind: "budget", payload: { newBudgetMinor: 600000 }, status: "approved", mode: "api", approvalId: null, exportFileId: null, proposedBy: DEMO_USER_ID, approvedBy: DEMO_USER_ID, appliedBy: null, appliedAt: null, created_at: "2026-07-27T09:00:00Z", updated_at: "2026-07-27T09:30:00Z" },
  ],
};

function loadSemStore(): SemStore {
  try {
    return JSON.parse(readFileSync(SEM_STORE_PATH, "utf8")) as SemStore;
  } catch {
    writeFileSync(SEM_STORE_PATH, JSON.stringify(SEM_STORE_SEED));
    return JSON.parse(JSON.stringify(SEM_STORE_SEED)) as SemStore;
  }
}

function saveSemStore(store: SemStore): void {
  writeFileSync(SEM_STORE_PATH, JSON.stringify(store));
}

// SM-22 — client-facing reports demo store. Same file-backed rationale as the SEM store above.
const REPORTS_STORE_PATH = join(tmpdir(), "gaiada-demo-search-reports.json");

interface DemoKpiTarget { metric: string; target: number; direction: string }
interface DemoReport {
  id: string; engagementId: string; period: string | null; kind: string; status: string;
  metrics: { rankTop10: number; criticalFindingsOpen: number; kpiTargets: DemoKpiTarget[] };
  narrativeMd: string | null; fileId: string | null; deliverableId: string | null;
  approvedBy: string | null; approvedAt: string | null; deliveredAt: string | null;
  created_at: string; updated_at: string;
  /** Demo-only tag (not a real search_reports column) driving demoReportPreview's honesty banner —
   *  see that function's own header note on why the preview is deliberately NOT the real renderer. */
  demoSimulated?: "none" | "mixed" | "all";
}
interface ReportsStore { reports: DemoReport[] }

// sm-report-1 demos the FULL delivered lifecycle against REAL (non-simulated) data, with a linked
// deliverable (sm-eng-1 carries `projectId: "p-seo-1"`, so delivery would create one for real too —
// see the deliver handler below). sm-report-2 demos in_review with a MIXED real/simulated banner —
// sm-eng-1's own rank data is seeded under simulate mode (DEMO_ENGAGEMENT_PROVIDER_MODE), so a real
// deployment reading this same engagement would show the identical mixed disclosure honestly.
const REPORTS_STORE_SEED: ReportsStore = {
  reports: [
    {
      id: "sm-report-1", engagementId: "sm-eng-1", period: "2026-06", kind: "monthly", status: "delivered",
      metrics: { rankTop10: 4, criticalFindingsOpen: 1, kpiTargets: [{ metric: "organic_sessions", target: 5000, direction: "up" }] },
      narrativeMd: "## June 2026\nOrganic visibility improved steadily this month, with four tracked keywords now ranking top-10. One critical technical finding remains open and is prioritized for July.",
      fileId: "demo-file-report-1", deliverableId: "dl-3",
      approvedBy: DEMO_USER_ID, approvedAt: "2026-07-02T10:00:00Z", deliveredAt: "2026-07-02T10:05:00Z",
      created_at: "2026-07-01T09:00:00Z", updated_at: "2026-07-02T10:05:00Z", demoSimulated: "none",
    },
    {
      id: "sm-report-2", engagementId: "sm-eng-1", period: "2026-07", kind: "monthly", status: "in_review",
      metrics: { rankTop10: 6, criticalFindingsOpen: 0, kpiTargets: [{ metric: "organic_sessions", target: 5000, direction: "up" }] },
      narrativeMd: "## July 2026 (draft)\nRankings continue trending up — six keywords now sit in the top 10. No open critical findings remain. Some figures in this draft come from the platform's simulate-mode rank data and are marked accordingly below.",
      fileId: null, deliverableId: null, approvedBy: null, approvedAt: null, deliveredAt: null,
      created_at: "2026-07-29T09:00:00Z", updated_at: "2026-07-29T09:00:00Z", demoSimulated: "mixed",
    },
  ],
};

function loadReportsStore(): ReportsStore {
  try {
    return JSON.parse(readFileSync(REPORTS_STORE_PATH, "utf8")) as ReportsStore;
  } catch {
    writeFileSync(REPORTS_STORE_PATH, JSON.stringify(REPORTS_STORE_SEED));
    return JSON.parse(JSON.stringify(REPORTS_STORE_SEED)) as ReportsStore;
  }
}

function saveReportsStore(store: ReportsStore): void {
  writeFileSync(REPORTS_STORE_PATH, JSON.stringify(store));
}

/** A DELIBERATELY SIMPLIFIED stand-in for platform-nest's `renderReportMarkdown` (reports.ts) — this
 *  UI project cannot import a platform-nest module, so this exists only to prove the console's
 *  preview pane renders something structurally shaped like the real thing (banner placement, honesty
 *  language), same posture as every other demo fixture here (static/derived, never production logic).
 *  A newly-drafted (non-seeded) report has no `demoSimulated` tag and renders as fully real. */
function demoReportPreview(row: DemoReport): { markdown: string; anySimulated: boolean; allSimulated: boolean; filename: string } {
  const tag = row.demoSimulated ?? "none";
  const anySimulated = tag !== "none";
  const allSimulated = tag === "all";
  const lines: string[] = [`# Cedar Group — ${row.kind} report — ${row.period ?? "—"}`, ""];
  if (allSimulated) {
    lines.push("> ⚠️ **SIMULATED DATA.** Every figure in this report was produced by the platform's simulate/demo mode.", "");
  } else if (anySimulated) {
    lines.push("> ⚠️ **MIXED DATA.** Some figures below are marked **[SIMULATED]** — those are demo/test values, not real performance.", "");
  }
  lines.push("## Summary", row.narrativeMd?.trim() || "_No narrative drafted._", "");
  lines.push("## Search rankings", `- Keywords currently ranking top-10: **${row.metrics.rankTop10}**${anySimulated ? " **[SIMULATED]**" : ""}`, "");
  lines.push("## Technical audits", `- Open critical findings: **${row.metrics.criticalFindingsOpen}**`, "");
  lines.push("---", `_Report id ${row.id}. Rendered as Markdown — a formatted PDF layer is not yet built (platform gap, tracked separately)._`);
  const periodSlug = (row.period ?? "period").replace(/[^a-zA-Z0-9-]/g, "");
  return {
    markdown: lines.join("\n"), anySimulated, allSimulated,
    filename: `seo-report-${row.kind}-${periodSlug}-${row.id.slice(0, 8)}${anySimulated ? "-SIMULATED" : ""}.md`,
  };
}

// Demo cap mirrors config.search.maxKeywordsPerSet's default (SEARCH_MAX_KEYWORDS_PER_SET, SM-32) —
// kept a literal rather than imported since demoFixtures.ts cannot reach across into platform-nest.
const DEMO_MAX_KEYWORDS_PER_SET = 1000;

// Minimal CSV/paste parser for the demo path only — one keyword per line, optional ", locale"
// suffix, blank lines and duplicate (keyword,locale) pairs against the EXISTING set dropped. Not a
// full mirror of keyword-import.ts's quoted-field CSV handling (that parser's edge cases are the
// real backend's job to get right); this exists only so the demo import box has something to do.
/** Thrown when the demo import text ends inside an open quoted field — mirrors the backend's
 *  UnterminatedQuoteError, which the controller turns into a 400. */
class DemoUnterminatedQuoteError extends Error {
  constructor() {
    super('unterminated quoted field in keyword import CSV (a " was opened but never closed)');
    this.name = "DemoUnterminatedQuoteError";
  }
}

/** Quote-aware CSV tokenizer over the WHOLE input, so a quoted field may contain a comma or an
 *  embedded newline without being corrupted. Deliberately duplicated from platform-nest's
 *  `modules/search/keyword-import.ts` `parseCsvRows` — these are separate projects and cannot share
 *  code — so it MUST be kept in step with that file.
 *
 *  Why it exists: this shim previously did `text.split("\n")` then `line.split(",")`, i.e. the exact
 *  pre-SM-32 pipeline the backend already fixed. Importing `"comma, in quotes" widget` in DEMO_MODE
 *  silently mis-split into keyword `"comma` with the rest as a locale — no crash, no error, just a
 *  confident wrong answer. A fixture that is wrong in a way the product is not makes DEMO_MODE QA
 *  produce false negatives about the product, which is worse than having no fixture. */
function parseDemoCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r" && raw[i + 1] === "\n") {
      endRow();
      i += 2;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new DemoUnterminatedQuoteError();
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** Mirrors platform-nest `parseKeywordImport`: optional `keyword` header row, per-row locale
 *  fallback, and (keyword.toLowerCase(), locale) dedupe keeping first occurrence. The header and
 *  dedupe behaviours were also missing here before, not just the quoting. */
function parseDemoKeywordImport(text: string): { keyword: string; locale: string }[] {
  const rows = parseDemoCsvRows(text).filter((cols) => cols.some((c) => c.trim().length > 0));
  if (rows.length === 0) return [];

  let start = 0;
  if (rows[0].map((c) => c.trim().toLowerCase())[0] === "keyword") start = 1;

  const out: { keyword: string; locale: string }[] = [];
  const seen = new Set<string>();
  for (let i = start; i < rows.length; i++) {
    const cols = rows[i];
    const keyword = (cols[0] ?? "").trim();
    if (!keyword) continue;
    const locale = (cols[1] !== undefined ? cols[1].trim() : "") || "id-ID";
    const dedupeKey = `${keyword.toLowerCase()}|${locale}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ keyword, locale });
  }
  return out;
}

function genDemoId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

// SM-14 — file-backed demo store for rank snapshots (Rankings tab, unclaimed until this ticket).
// Same file-backed rationale as SCOPE_STORE/AUDIT_STORE/KEYWORD_STORE above. Field names mirror
// `search.controller.ts`'s `listRankSnapshots` SELECT exactly (§4i discipline). Seeded with the
// HARD cases the ticket calls out rather than a uniformly clean run: a real (non-simulated) capture,
// a simulated one, a `dropped` regression, and a genuine not-found (`position: null`) — a fixture
// where every row is clean proves nothing about the three-state provenance render or the "—" convention.
interface DemoRankSnapshot {
  id: string; propertyId: string; keywordId: string; keyword: string; engine: string; device: string;
  locationCode: number | null; capturedAt: string; position: number | null; rankedUrl: string | null;
  serpFeatures: Record<string, unknown>; provider: string | null; simulated: boolean;
}
interface RankStore { snapshots: DemoRankSnapshot[] }
const RANK_STORE_PATH = join(tmpdir(), "gaiada-demo-search-ranks.json");
// keywordId/keyword pairs match KEYWORD_STORE_SEED's sm-set-1 rows exactly (sm-kw-1/2/3, the same
// three the Keywords tab already seeds) — a mismatched keyword TEXT here would be the exact
// fixture-vs-fixture drift §4i warns about, just within this file instead of against the controller.
const RANK_STORE_SEED: RankStore = {
  snapshots: [
    {
      id: "sm-rank-1", propertyId: "sm-prop-1", keywordId: "sm-kw-1", keyword: "seo audit tools",
      engine: "google", device: "desktop", locationCode: 2360, capturedAt: "2026-07-22T03:00:00Z",
      position: 9, rankedUrl: "https://cedargroup.example.com/tools", serpFeatures: { peopleAlsoAsk: true },
      provider: "dataforseo", simulated: false,
    },
    // The regression this ticket's "dropped" state exists for — same keyword, later capture, worse
    // position (9 -> 14). The Rankings panel derives `dropped` client-side from the two most recent
    // captures per (keywordId, engine, device), mirroring rank.ts's own isRankDrop() logic, since the
    // list endpoint returns raw history rather than a pre-computed delta.
    {
      id: "sm-rank-2", propertyId: "sm-prop-1", keywordId: "sm-kw-1", keyword: "seo audit tools",
      engine: "google", device: "desktop", locationCode: 2360, capturedAt: "2026-07-29T03:00:00Z",
      position: 14, rankedUrl: "https://cedargroup.example.com/tools", serpFeatures: { peopleAlsoAsk: true },
      provider: "dataforseo", simulated: false,
    },
    // A SIMULATED capture for a different keyword — badge, not filter: this row must keep its own
    // chip regardless of the platform's current mode (design addendum §A4.4).
    {
      id: "sm-rank-3", propertyId: "sm-prop-1", keywordId: "sm-kw-2", keyword: "seo audit checklist",
      engine: "google", device: "desktop", locationCode: 2360, capturedAt: "2026-07-29T03:05:00Z",
      position: 3, rankedUrl: "https://cedargroup.example.com/checklist", serpFeatures: {},
      provider: "dataforseo", simulated: true,
    },
    // Genuinely NOT FOUND — `position: null` is an honest capture outcome, never an error and never
    // coerced to a number (rank.ts's own findPropertyPosition header note). Must render "—", not "0".
    {
      id: "sm-rank-4", propertyId: "sm-prop-1", keywordId: "sm-kw-3", keyword: "technical seo checklist",
      engine: "google", device: "mobile", locationCode: 2360, capturedAt: "2026-07-29T03:10:00Z",
      position: null, rankedUrl: null, serpFeatures: {}, provider: "dataforseo", simulated: false,
    },
  ],
};

function loadRankStore(): RankStore {
  try {
    return JSON.parse(readFileSync(RANK_STORE_PATH, "utf8")) as RankStore;
  } catch {
    writeFileSync(RANK_STORE_PATH, JSON.stringify(RANK_STORE_SEED));
    return JSON.parse(JSON.stringify(RANK_STORE_SEED)) as RankStore;
  }
}
function saveRankStore(store: RankStore): void {
  writeFileSync(RANK_STORE_PATH, JSON.stringify(store));
}

// SM-25a/SM-25b — file-backed demo store for Google connections + GSC/GA4 performance rows (the
// Connections tab's Google section, and the Search Console & GA4 tab). §A12.3's honesty rule is the
// reason TWO connections are seeded rather than one: `conn-google-1` is a REAL Google issuer
// (`issuerIsGoogle: true` — nothing extra to disclose) and `conn-google-2` is a NON-Google issuer
// (the local Keycloak `google-dev` sandbox realm this program actually tests against, per tracker
// §6ao) — `issuerIsGoogle: false`, so its `issuerHost` MUST render on the Connections tab. A fixture
// where every connection is real-Google would prove nothing about that rule.
interface DemoGoogleConnection {
  id: string; provider: "google_search_console" | "google_analytics" | "google_ads"; clientId: string;
  status: string; hasToken: boolean; hasRefreshToken: boolean; tokenExpiresAt: string | null;
  scopes: string[]; externalAccount: string | null; issuerHost: string | null; issuerIsGoogle: boolean;
}
interface GoogleStore {
  connections: DemoGoogleConnection[];
  // propertyId -> provider -> connectionId|null (mirrors search_properties.gsc_connection_id/
  // ga4_connection_id/ads_connection_id, 0034).
  bindings: Record<string, Record<string, string | null>>;
}
const GOOGLE_STORE_PATH = join(tmpdir(), "gaiada-demo-search-google.json");
const GOOGLE_STORE_SEED: GoogleStore = {
  connections: [
    {
      id: "conn-google-1", provider: "google_search_console", clientId: "cl-2", status: "linked",
      hasToken: true, hasRefreshToken: true, tokenExpiresAt: "2026-08-30T00:00:00Z",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      externalAccount: "seo@cedargroup.example.com", issuerHost: "accounts.google.com", issuerIsGoogle: true,
    },
    {
      id: "conn-google-2", provider: "google_analytics", clientId: "cl-2", status: "linked",
      hasToken: true, hasRefreshToken: true, tokenExpiresAt: "2026-08-30T00:00:00Z",
      scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      externalAccount: "dev-sandbox@cedargroup.example.com",
      // §A12.3's honesty rule, exercised: this connection was NOT issued by Google — a local
      // Keycloak `google-dev` realm client stood in for it (tracker §6ao's own live-test issuer).
      issuerHost: "keycloak.gaiada.local:8443", issuerIsGoogle: false,
    },
  ],
  bindings: { "sm-prop-1": { google_search_console: "conn-google-1", google_analytics: "conn-google-2", google_ads: null } },
};

function loadGoogleStore(): GoogleStore {
  try {
    return JSON.parse(readFileSync(GOOGLE_STORE_PATH, "utf8")) as GoogleStore;
  } catch {
    writeFileSync(GOOGLE_STORE_PATH, JSON.stringify(GOOGLE_STORE_SEED));
    return JSON.parse(JSON.stringify(GOOGLE_STORE_SEED)) as GoogleStore;
  }
}
function saveGoogleStore(store: GoogleStore): void {
  writeFileSync(GOOGLE_STORE_PATH, JSON.stringify(store));
}

// GSC/GA4 performance rows. Seeded ONLY under sm-eng-1's property/connections — sm-eng-2 stays
// genuinely empty (no connection bound, zero rows), the SAME two-engagement "has data / genuinely
// empty" split every other surface in this module uses (ledger, cost-projection) — because the
// live backend's own primary state today is exactly that: tables exist, nothing has been pulled yet.
// A fixture where everything is populated would prove nothing about the empty-state rendering the
// ticket requires ("no data pulled yet", never a flat chart of zeros).
interface DemoGscRow {
  id: string; propertyId: string; date: string; query: string; page: string; device: string;
  clicks: number; impressions: number; ctr: number; position: number; simulated: boolean; fetchedAt: string;
}
interface DemoGa4Row {
  id: string; propertyId: string; date: string; channelGroup: string; sessions: number;
  engagedSessions: number; conversions: number; totalRevenue: number | null; sampled: boolean;
  simulated: boolean; fetchedAt: string;
}
interface GooglePerfStore { gsc: DemoGscRow[]; ga4: DemoGa4Row[] }
const GOOGLE_PERF_STORE_PATH = join(tmpdir(), "gaiada-demo-search-google-perf.json");
const GOOGLE_PERF_STORE_SEED: GooglePerfStore = {
  gsc: [
    { id: "gsc-1", propertyId: "sm-prop-1", date: "2026-07-26", query: "seo tools", page: "https://cedargroup.example.com/tools", device: "DESKTOP", clicks: 42, impressions: 980, ctr: 0.0429, position: 8.3, simulated: false, fetchedAt: "2026-07-29T04:00:00Z" },
    { id: "gsc-2", propertyId: "sm-prop-1", date: "2026-07-26", query: "content marketing agency", page: "https://cedargroup.example.com/blog", device: "MOBILE", clicks: 11, impressions: 305, ctr: 0.0361, position: 15.7, simulated: false, fetchedAt: "2026-07-29T04:00:00Z" },
    // A SIMULATED row from a mode-flipped period — badge, not filter, kept forever.
    { id: "gsc-3", propertyId: "sm-prop-1", date: "2026-07-20", query: "cedar group reviews", page: "https://cedargroup.example.com/", device: "DESKTOP", clicks: 5, impressions: 60, ctr: 0.0833, position: 3.1, simulated: true, fetchedAt: "2026-07-21T04:00:00Z" },
  ],
  ga4: [
    { id: "ga4-1", propertyId: "sm-prop-1", date: "2026-07-26", channelGroup: "Organic Search", sessions: 340, engagedSessions: 210, conversions: 12, totalRevenue: 480.5, sampled: false, simulated: false, fetchedAt: "2026-07-29T04:05:00Z" },
    // The SAMPLED row this ticket's freshness/sampling AC exists for — must render distinguishably
    // from the unsampled row above, never averaged into one clean-looking figure.
    { id: "ga4-2", propertyId: "sm-prop-1", date: "2026-07-26", channelGroup: "Paid Search", sessions: 96, engagedSessions: 40, conversions: 3, totalRevenue: 150, sampled: true, simulated: false, fetchedAt: "2026-07-29T04:05:00Z" },
    { id: "ga4-3", propertyId: "sm-prop-1", date: "2026-07-26", channelGroup: "Direct", sessions: 58, engagedSessions: 30, conversions: 1, totalRevenue: null, sampled: false, simulated: false, fetchedAt: "2026-07-29T04:05:00Z" },
  ],
};

function loadGooglePerfStore(): GooglePerfStore {
  try {
    return JSON.parse(readFileSync(GOOGLE_PERF_STORE_PATH, "utf8")) as GooglePerfStore;
  } catch {
    writeFileSync(GOOGLE_PERF_STORE_PATH, JSON.stringify(GOOGLE_PERF_STORE_SEED));
    return JSON.parse(JSON.stringify(GOOGLE_PERF_STORE_SEED)) as GooglePerfStore;
  }
}
function saveGooglePerfStore(store: GooglePerfStore): void {
  writeFileSync(GOOGLE_PERF_STORE_PATH, JSON.stringify(store));
}

// engagementId -> propertyId, kept in exactly one place so the pull/read handlers below never
// disagree with the engagement fixtures further down this file about which property an engagement
// resolves to (0034: an engagement has exactly one property).
const DEMO_ENGAGEMENT_PROPERTY: Record<string, string> = { "sm-eng-1": "sm-prop-1", "sm-eng-2": "sm-prop-1", "sm-eng-3": "sm-prop-1" };
// Only sm-eng-1 demos a bound Google connection — sm-eng-2 stays the genuinely-empty case (see the
// GooglePerfStore seed comment above), so a gsc-pull/ga4-pull against it must refuse exactly the way
// the real backend refuses an unbound property (GooglePropertyNotBoundError, 400 google_property_not_bound).
const DEMO_ENGAGEMENT_HAS_GOOGLE_CONNECTION: Record<string, boolean> = { "sm-eng-1": true, "sm-eng-2": false };

function tenantFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/([^/]+)\//);
  return m ? m[1] : null;
}

function ok(json: unknown): DemoResult {
  return { status: 200, json };
}

// ---- MAIL-15 fixtures (design A12 — reserved-TLD addresses only, never a real production domain) ----
// Shapes mirror `platform-nest/src/mail/admin-mail.controller.ts`'s `MailLogRow` and
// `src/mail/thread.controller.ts`'s `ThreadMessageView` exactly, so DEMO_MODE and the live BFF are
// interchangeable from the UI's point of view.
const DEMO_MAIL_LOG = [
  {
    id: "demo-mail-1",
    stream: "notify",
    tenant_id: "co-agency",
    user_id: "demo-hansel",
    to_email: "admin@notify.gaiada.invalid",
    template_key: "approval.warning",
    subject: "Automation suspended: high-impact write in Acme Co",
    entity_type: "automation_approval",
    entity_id: "demo-approval-1",
    status: "sent",
    attempts: 1,
    next_attempt_at: "2026-08-01T09:05:00.000Z",
    last_error: null,
    provider: "smtp",
    provider_message_id: "demo-provider-msg-1",
    queued_at: "2026-08-01T09:04:40.000Z",
    provider_accepted_at: "2026-08-01T09:05:01.000Z",
    delivered_at: null,
    created_at: "2026-08-01T09:04:40.000Z",
    updated_at: "2026-08-01T09:05:01.000Z",
  },
  {
    id: "demo-mail-2",
    stream: "notify",
    tenant_id: "co-agency",
    user_id: "demo-client-1",
    to_email: "signer@client.gaiada.invalid",
    template_key: "approval.actionable",
    subject: "Your decision is needed: PRD sign-off for Q3 Launch",
    entity_type: "pipeline_run",
    entity_id: "run-demo-1",
    status: "sent",
    attempts: 1,
    next_attempt_at: "2026-08-02T14:00:00.000Z",
    last_error: null,
    provider: "smtp",
    provider_message_id: "demo-provider-msg-2",
    queued_at: "2026-08-02T13:59:40.000Z",
    provider_accepted_at: "2026-08-02T14:00:01.000Z",
    delivered_at: null,
    created_at: "2026-08-02T13:59:40.000Z",
    updated_at: "2026-08-02T14:00:01.000Z",
  },
  {
    id: "demo-mail-3",
    stream: "notify",
    tenant_id: "co-agency",
    user_id: null,
    to_email: "bounced@nowhere.gaiada.invalid",
    template_key: "approval.warning",
    subject: "Automation suspended: medium-impact write in Beta LLC",
    entity_type: "automation_approval",
    entity_id: "demo-approval-2",
    status: "bounced",
    attempts: 1,
    next_attempt_at: "2026-08-03T11:00:00.000Z",
    last_error: "NDR: mailbox unavailable",
    provider: "smtp",
    provider_message_id: "demo-provider-msg-3",
    queued_at: "2026-08-03T10:59:40.000Z",
    provider_accepted_at: "2026-08-03T11:00:01.000Z",
    delivered_at: null,
    created_at: "2026-08-03T10:59:40.000Z",
    updated_at: "2026-08-03T11:05:00.000Z",
  },
  {
    id: "demo-mail-4",
    stream: "auth",
    tenant_id: null,
    user_id: "demo-hansel",
    to_email: "hansel@staff.gaiada.invalid",
    template_key: "auth.magic_link",
    subject: "Your Gaiada sign-in link",
    entity_type: null,
    entity_id: null,
    status: "suppressed",
    attempts: 0,
    next_attempt_at: "2026-08-03T08:00:00.000Z",
    last_error: null,
    provider: null,
    provider_message_id: null,
    queued_at: "2026-08-03T08:00:00.000Z",
    provider_accepted_at: null,
    delivered_at: null,
    created_at: "2026-08-03T08:00:00.000Z",
    updated_at: "2026-08-03T08:00:00.000Z",
  },
];

// MAIL-20 (design A15.2) — a bottom-posted reply under a quoted thread, so DEMO_MODE exercises
// the render-side quote-collapse without a backend: the panel shows "Approved..." first and the
// quoted history collapses behind "Show quoted history" (`components/mail/QuotedMessageBody.tsx`).
// Shape mirrors the MAIL-19 corpus reference case `16-bottom-posted-oversize-quote` (a `>`-prefixed
// quote run followed by the human's actual reply) at demo scale, not the 128 KiB intake-cap scale.
const DEMO_QUOTED_REPLY_TEXT = [
  "> On Mon, 3 Aug 2026, Gaiada Platform wrote: PRD sign-off requested for Q3 Launch.",
  "> On Mon, 3 Aug 2026, Gaiada Platform wrote: scope covers phases 1-2 of the rollout.",
  "> On Mon, 3 Aug 2026, Gaiada Platform wrote: budget line attached for reference.",
  "",
  "Approved. Please proceed with the milestone payment so we can move forward.",
  "",
  "-- ",
  "Dita",
].join("\n");

function mailThreadForEntity(entityType: string, entityId: string) {
  if (entityType === "pipeline_run" && entityId === "run-demo-1") {
    return [
      {
        id: "demo-mail-msg-1",
        mailLogId: "demo-mail-2",
        fromEmail: "signer@client.gaiada.invalid",
        senderVerified: false as const,
        provenance: "inbound-email" as const,
        subject: "Re: Your decision is needed: PRD sign-off for Q3 Launch",
        bodyText: "Looks good — signing off shortly, just confirming scope with my team first.",
        bodyHtmlSanitized: "<p>Looks good — signing off shortly, just confirming scope with my team first.</p>",
        bodyTruncated: false,
        bodyTruncatedChars: 0,
        sizeBytes: 812,
        receivedAt: "2026-08-02T15:30:00.000Z",
        attachments: [],
      },
      {
        id: "demo-mail-msg-2",
        mailLogId: "demo-mail-2",
        fromEmail: "dita@client-one.invalid",
        senderVerified: false as const,
        provenance: "inbound-email" as const,
        subject: "Re: Your decision is needed: PRD sign-off for Q3 Launch",
        bodyText: DEMO_QUOTED_REPLY_TEXT,
        bodyHtmlSanitized: null,
        // MAIL-25 — demo scale stand-in for a real intake-cap truncation, so DEMO_MODE also drives
        // the structured truncation notice (never derived from `DEMO_QUOTED_REPLY_TEXT`'s content).
        bodyTruncated: true,
        bodyTruncatedChars: 42000,
        sizeBytes: DEMO_QUOTED_REPLY_TEXT.length,
        receivedAt: "2026-08-02T16:10:00.000Z",
        attachments: [],
      },
    ];
  }
  return [];
}

function mailThreadFor(mailLogId: string) {
  if (mailLogId === "demo-mail-2") return mailThreadForEntity("pipeline_run", "run-demo-1").map((m) => m);
  return [];
}

// Resolve the current demo identity based on the logged-in userId.
function getCurrentDemoIdentity(userId: string) {
  if (userId === DEMO_USER_SEARCH_STAFF_ID) return ME_SEARCH_STAFF;
  if (userId === DEMO_USER_IC_ID) return ME_IC;
  if (userId === DEMO_USER_CLIENT_ID) return ME_CLIENT;
  return ME;
}

export function getDemoResponse(method: string, fullPath: string, userId: string = DEMO_USER_ID, body?: string): DemoResult {
  const url = new URL(fullPath, "http://demo");
  const p = url.pathname;
  const m = method.toUpperCase();

  // PM surface + task comments — stateful in-memory store (lib/demoPm.ts).
  const pm = pmDemo(method, p, url.searchParams, body);
  if (pm) return pm;

  // Meeting-recordings registry (WS11 capture edge) — stateful store (lib/demoMeetings.ts).
  const meetings = meetingsDemo(method, p, url.searchParams, body);
  if (meetings) return meetings;

  // Delivery pipeline runs/stages/gates (WD-02 run workspace) — stateful store (lib/demoPipeline.ts).
  const pipeline = pipelineDemo(method, p, url.searchParams, body);
  if (pipeline) return pipeline;

  // Social Media department — calendar + composer (SMM-12), stateful store (lib/demoSocial.ts).
  // Before this, `/departments/dept-4/{calendar,composer}` had no fixture at all, so SMM-12 could
  // not be driven in a browser under DEMO_MODE — see that file's header for the full story (SMM-14).
  const social = socialDemo(method, p, url.searchParams, body);
  if (social) return social;

  // MI-05 — Web Dev maintenance-intake triage queue (staff console) — stateful store
  // (lib/demoWebdevChangeRequests.ts).
  const webdevCr = webdevChangeRequestsDemo(method, p, url.searchParams, body, userId);
  if (webdevCr) return webdevCr;

  // PRV-04 — Web Dev "Site & repo" card (run workspace) — stateful store (lib/demoWebdevProvisionedSites.ts).
  const webdevSites = webdevProvisionedSitesDemo(method, p, url.searchParams, body, userId);
  if (webdevSites) return webdevSites;

  // MON — monitoring board (Plane B: client properties + services). Read-only fixtures
  // (lib/demoMonitoring.ts); seeded with a down/degraded/stale/maintenance/unknown spread so every
  // branch of the board is drivable in a browser without the backend module existing.
  // MSO-06 — Plane A admin console (/systems/observability), estate shape (contract §20.1a).
  // Seeded with SEVEN hosts covering every non-negotiable branch this ticket exists to render —
  // a demo showing one calm box would prove none of them:
  //   - gda-aicenter (production, erp-core): fresh, but disk at 78.4% with a downward 24h
  //     projection and one scrape target + one Postgres instance down — under real pressure.
  //   - sumopod (ops, observability-hub): fresh and healthy, but its SERIES report env "staging"
  //     while the inventory says "ops" — the envDrift badge case.
  //   - staging-01 (staging, app-staging): STALE — still has readings (they are historical, not
  //     absent), which is the "looks calm on old data" trap note 1 warns about.
  //   - edge-02 (production, edge-worker): status active but freshness DARK — an expected,
  //     provisioned, active host that stopped reporting. RemoteWriteStalled is attributed to this
  //     host, which is also why the whole-board banner fires in this fixture.
  //   - newhost-04 (dev, onboarding-node): status onboarding, freshness NEVER — expected-pending,
  //     not an incident, and must not read like edge-02's alarm.
  //   - old-box (production, legacy): status decommissioned, freshness stale — muted, not alarming,
  //     still visible until its series age out.
  //   - mystery-host: NOT in the inventory at all (registered:false) — a series arrived with a host
  //     label nobody provisioned, the OTHER drift direction from edge-02/newhost-04.
  // alertsActive/alertsSuppressed are measured numbers (2 / 1), not null — the null case (Alertmanager
  // unreadable) is covered by observability.test.ts rather than the demo, since DEMO_MODE has no way
  // to also demonstrate "the backend could not reach Alertmanager" without a second scenario knob.
  if (p === "/api/admin/observability" && method.toUpperCase() === "GET") {
    const now = new Date();
    return { status: 200, json: {
      available: true,
      grafanaHint: "http://localhost:3001 (via SSH tunnel)",
      collectedAt: now.toISOString(),
      hosts: [
        {
          key: "gda-aicenter", displayName: "gda-aicenter", env: "production", role: "erp-core",
          registered: true, status: "active", envDrift: false,
          freshness: { state: "fresh", lastSampleAgeSeconds: 22 },
          host: {
            cpuBusyPct: { value: 24.6, note: null }, cores: { value: 4, note: null },
            memUsedPct: { value: 56.1, note: null }, diskUsedPct: { value: 78.4, note: null },
            diskFreeGb: { value: 11.0, note: null }, diskFreeGb24h: { value: 9.7, note: null },
            load1: { value: 1.02, note: null }, uptimeDays: { value: 19.3, note: null },
          },
          targets: { up: 13, down: 1, downJobs: ["blackbox-http"] },
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: {
            postgres: [{ instance: "postgres-exporter:9187", up: true }, { instance: "postgres-exporter-bot:9187", up: false }],
            redis: [{ instance: "redis-exporter:9121", up: true }, { instance: "redis-exporter-bot:9121", up: true }],
          },
        },
        {
          key: "sumopod", displayName: "sumopod", env: "ops", role: "observability-hub",
          registered: true, status: "active", envDrift: true,
          freshness: { state: "fresh", lastSampleAgeSeconds: 9 },
          host: {
            cpuBusyPct: { value: 7.8, note: null }, cores: { value: 8, note: null },
            memUsedPct: { value: 29.4, note: null }, diskUsedPct: { value: 21.9, note: null },
            diskFreeGb: { value: 340.0, note: null }, diskFreeGb24h: { value: 341.0, note: null },
            load1: { value: 0.14, note: null }, uptimeDays: { value: 41.7, note: null },
          },
          targets: { up: 5, down: 0, downJobs: [] },
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: null,
        },
        {
          key: "staging-01", displayName: "staging-01", env: "staging", role: "app-staging",
          registered: true, status: "active", envDrift: false,
          freshness: { state: "stale", lastSampleAgeSeconds: 340 },
          host: {
            cpuBusyPct: { value: 11.5, note: null }, cores: { value: 2, note: null },
            memUsedPct: { value: 18.2, note: null }, diskUsedPct: { value: 31.0, note: null },
            diskFreeGb: { value: 60.0, note: null }, diskFreeGb24h: { value: 59.5, note: null },
            load1: { value: 0.08, note: null }, uptimeDays: { value: 6.1, note: null },
          },
          targets: { up: 4, down: 0, downJobs: [] },
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: { postgres: [{ instance: "postgres-exporter:9187", up: true }], redis: [] },
        },
        {
          key: "edge-02", displayName: "edge-02", env: "production", role: "edge-worker",
          registered: true, status: "active", envDrift: false,
          freshness: { state: "dark", lastSampleAgeSeconds: 912 },
          host: null, targets: null,
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: null,
        },
        {
          key: "newhost-04", displayName: "newhost-04", env: "dev", role: "onboarding-node",
          registered: true, status: "onboarding", envDrift: false,
          freshness: { state: "never", lastSampleAgeSeconds: null },
          host: null, targets: null,
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: null,
        },
        {
          key: "old-box", displayName: "old-box", env: "production", role: "legacy",
          registered: true, status: "decommissioned", envDrift: false,
          freshness: { state: "stale", lastSampleAgeSeconds: 480 },
          host: {
            cpuBusyPct: { value: 2.1, note: null }, cores: { value: 2, note: null },
            memUsedPct: { value: 12.0, note: null }, diskUsedPct: { value: 44.0, note: null },
            // 80.2 -> 80.5, deliberately FLAT/growing (not the exact 0.2 GB/day boundary — that
            // landed on the wrong side of `diskProjectionNote`'s <=0.2 cutoff due to plain
            // floating-point subtraction, e.g. `80.0 - 79.8 === 0.20000000000000284` in JS, which
            // silently counted this muted/decommissioned host in the "trending down" KPI). A
            // decommissioned host should read as boring on this axis, not sneak into an attention tile.
            diskFreeGb: { value: 80.2, note: null }, diskFreeGb24h: { value: 80.5, note: null },
            load1: { value: 0.02, note: null }, uptimeDays: { value: 120.4, note: null },
          },
          targets: { up: 2, down: 0, downJobs: [] },
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: null,
        },
        {
          key: "mystery-host", displayName: "mystery-host", env: null, role: null,
          registered: false, status: null, envDrift: false,
          freshness: { state: "fresh", lastSampleAgeSeconds: 41 },
          host: {
            cpuBusyPct: { value: 63.0, note: null }, cores: { value: 2, note: null },
            memUsedPct: { value: 71.0, note: null }, diskUsedPct: { value: 55.0, note: null },
            diskFreeGb: { value: 30.0, note: null }, diskFreeGb24h: { value: 29.6, note: null },
            load1: { value: 1.9, note: null }, uptimeDays: { value: 0.3, note: null },
          },
          targets: { up: 1, down: 0, downJobs: [] },
          containersRunning: { value: null, note: "per-container discovery broken estate-wide (MON-09n): cAdvisor cannot enumerate containers under the containerd snapshotter" },
          datastores: null,
        },
      ],
      estate: {
        hosts: { total: 7, fresh: 3, stale: 2, dark: 1, never: 1 },
        alertsActive: 2,
        alertsSuppressed: 1,
      },
      alerts: [
        { name: "RemoteWriteStalled", severity: "page", state: "active", host: "edge-02" },
        { name: "DiskWillFillIn24h", severity: "page", state: "active", host: "gda-aicenter" },
        { name: "GatewayBudgetNearCap", severity: "ticket", state: "suppressed", host: null },
      ],
      alertsNote: null,
    } };
  }

  const monitoring = monitoringDemo(method, p, url.searchParams);
  if (monitoring) return monitoring;

  // Client portal DASHBOARD (CP-2..CP-5) — overview/projects/timeline/deliverables/invoices/contracts/
  // profile/change-requests (MI-04 maintenance intake). Runs FIRST so its routes win, and returns
  // null for anything it does not own so the runs/gates routes still reach `portalDemo` below. Both
  // are identity-aware (a staff user gets the real BFF's 403), which is what keeps the staff
  // teach-state on /portal reachable.
  // SMM-31/32 — client portal's social-post review (D-16), stateful store shared with
  // `demoSocial.ts`'s staff-side routes above (same `globalThis`-pinned `CLIENT_REVIEWS`, so a
  // staff "ask" and a client "decide" agree on the one row).
  const socialReviewPortal = socialClientReviewPortalDemo(method, p, userId, body);
  if (socialReviewPortal) return socialReviewPortal;

  const portalDash = portalDashboardDemo(method, p, userId, body);
  if (portalDash) return portalDash;

  // Client portal runs/gates (C5) — identity-aware, so a staff user still gets the 403 the real BFF returns.
  const portal = portalDemo(method, p, userId);
  if (portal) return portal;

  // Tracker/reporting grain documents (TR-17) — stateless per-request fixtures (lib/demoReports.ts).
  const reports = reportsDemo(method, p, url.searchParams, body, userId);
  if (reports) return reports;

  // Check-in subsystem (TR-10/TR-38) — stateful in-memory store (lib/demoCheckins.ts).
  const checkins = checkinsDemo(method, p, url.searchParams, body, userId);
  if (checkins) return checkins;

  // Appraisal subsystem (TR-26) — stateful in-memory store (lib/demoAppraisals.ts).
  const appraisals = appraisalsDemo(method, p, url.searchParams, body, userId);
  if (appraisals) return appraisals;

  // Employee loans (wave E) — stateless derived fixtures (lib/demoLoans.ts).
  const loans = loansDemo(method, p, url.searchParams, body, userId);
  if (loans) return loans;

  // Assistant workspace (ASST-07) — stateful in-memory store (lib/demoAssistant.ts). Owner-scoped
  // (filters by userId) so DEMO_MODE mirrors the real owner-only Cerbos policy. The SSE stream
  // itself is answered separately by `demoAssistantStreamBody` (this dispatcher only ever returns
  // JSON) — see that file's header.
  const assistant = assistantDemo(method, p, url.searchParams, body, userId);
  if (assistant) return assistant;

  const currentIdentity = getCurrentDemoIdentity(userId);

  // /api/me reflects the (mutable) company set so newly-created companies appear.
  if (p === "/api/me") return ok({ ...currentIdentity, companies: COMPANIES.map((c) => ({ id: c.id, name: c.name, type: c.type })) });
  if (p === "/api/companies") {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const co = { id: demoId("co"), name: String(b.name ?? "New company"), type: (b.type as string) ?? null, enabled_modules: Array.isArray(b.modules) ? b.modules : [], status: "active", parent_company_id: (b.parentCompanyId as string) ?? "co-holding" };
      COMPANIES.push(co);
      return { status: 201, json: { id: co.id } };
    }
    return ok(COMPANIES);
  }
  const companySingleMatch = p.match(/^\/api\/companies\/([^/]+)$/);
  if (companySingleMatch && m === "GET") {
    // D14-08 — the single-company detail read (`lib/entities.ts::getCompanyDetail`), the only
    // reader that needs `settings` (the "Approval retry" card's current `autoRetryCount`).
    const co = COMPANIES.find((c) => c.id === companySingleMatch[1]);
    if (!co) return { status: 404, json: { error: "company not found" } };
    return ok({ ...co, settings: co.settings ?? {} });
  }
  if (companySingleMatch && m === "PATCH") {
    const co = COMPANIES.find((c) => c.id === companySingleMatch[1]);
    if (co) {
      const b = JSON.parse(body || "{}");
      if (b.name != null) co.name = b.name;
      if (b.type !== undefined) co.type = b.type;
      if (b.status != null) co.status = b.status;
      if (b.parentCompanyId !== undefined) co.parent_company_id = b.parentCompanyId;
      if (Array.isArray(b.modules)) co.enabled_modules = b.modules;
      // D14-07's namespaced settings write — mirror the real merge (touch ONLY this one nested
      // path, never overwrite the rest of `settings`).
      const autoRetryCount = b.settings?.automation?.approvalRetry?.autoRetryCount;
      if (autoRetryCount !== undefined) {
        const settings = (co.settings as Record<string, unknown>) ?? {};
        const automation = (settings.automation as Record<string, unknown>) ?? {};
        co.settings = { ...settings, automation: { ...automation, approvalRetry: { autoRetryCount } } };
      }
    }
    return ok({ ok: true });
  }
  if (p === "/api/rollups") return ok(ROLLUPS);
  if (p.match(/^\/api\/[^/]+\/rollups\/recompute$/) && m === "POST") return ok({ period: "2026-07-05", written: ROLLUPS.length });

  if (p.match(/^\/api\/[^/]+\/members$/)) return ok(MEMBERS[tenantFromPath(p)!] ?? []);
  if (p.match(/^\/api\/[^/]+\/activity$/)) return ok(ACTIVITY);

  // Notifications (bell badge + /notifications page). Tenant-independent in demo.
  if (p.match(/^\/api\/[^/]+\/notifications$/)) {
    if (m === "POST") return ok({ ok: true }); // mark-all-read
    const unreadOnly = url.searchParams.get("unread") === "true";
    // Prepend any AI-Tracker notifications generated this session (newest first).
    const feed = [...allTrackerNotifications(), ...NOTIFICATIONS];
    return ok(unreadOnly ? feed.filter((n) => !n.read_at) : feed);
  }
  if (p.match(/^\/api\/[^/]+\/notifications\/[^/]+\/read$/) && m === "POST") return ok({ ok: true });

  const projMatch = p.match(/^\/api\/([^/]+)\/projects$/);
  if (projMatch) {
    if (m === "POST") return { status: 201, json: { id: `p-new-${Date.now()}` } };
    return ok(PROJECTS[projMatch[1]] ?? []);
  }
  const projDetailMatch = p.match(/^\/api\/[^/]+\/projects\/([^/]+)$/);
  if (projDetailMatch) {
    if (m === "PATCH") return ok({ id: projDetailMatch[1] });
    const id = projDetailMatch[1];
    const base = Object.values(PROJECTS).flat().find((pr) => (pr as { id: string }).id === id) as Record<string, unknown> | undefined;
    const extra = PROJECT_DETAIL_EXTRA[id] ?? { client_name: null, owner_name: "Clement Hansel", start_date: "2026-06-01" };
    if (base) return ok({ ...base, ...extra });
    // Freshly-created or unknown id: synthesize a plausible draft so create→view flows never dead-end.
    return ok({ id, name: "New project", status: "active", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, department_id: null, due_date: null, custom_fields: {}, ...extra });
  }
  const projTasksMatch = p.match(/^\/api\/([^/]+)\/projects\/([^/]+)\/tasks$/);
  if (projTasksMatch) {
    if (m === "POST") return { status: 201, json: { id: `t-new-${Date.now()}` } };
    return ok(TASKS[projTasksMatch[2]] ?? []);
  }

  const tasksMatch = p.match(/^\/api\/([^/]+)\/tasks$/);
  if (tasksMatch) {
    const rows = url.searchParams.get("assignee") === "me" ? ALL_TASKS.filter((t) => (t as { assignee_id: string | null }).assignee_id === DEMO_USER_ID) : ALL_TASKS;
    return ok(rows);
  }
  const taskDetailMatch = p.match(/^\/api\/[^/]+\/tasks\/([^/]+)$/);
  if (taskDetailMatch) {
    if (m === "PATCH") return ok({ id: taskDetailMatch[1] });
    const id = taskDetailMatch[1];
    const base = ALL_TASKS.find((t) => (t as { id: string }).id === id) as Record<string, unknown> | undefined;
    if (base) return ok({ ...base, assignee_name: base.assignee_id === DEMO_USER_ID ? "Clement Hansel" : "Team member", custom_fields: {} });
    return ok({ id, title: "New task", status: "todo", priority: "normal", assignee_id: null, assignee_name: null, due_date: null, project_id: "p-web-1", project_name: "Client site redesign", custom_fields: {} });
  }

  // Org structure: no demo backend — return 404 so lib/org.ts uses its
  // cookie/seeded-default path (edits persist to the per-company cookie and
  // survive reload, exercising the exact backend-ready flow).
  if (p.match(/^\/api\/[^/]+\/org-structure$/)) return { status: 404, json: { error: "org-structure endpoint not implemented" } };

  // Module enablement: DEMO_MODE exists to browse every surface with no backend, so report the full
  // compiled-in set — a demo company whose fixture has an empty enabled_modules would otherwise
  // dark HR/Clients/Billing/Reports and make the tour look broken. Real gating is a live-backend
  // concern (see lib/modules.ts).
  if (p.match(/^\/api\/[^/]+\/modules-enabled$/)) {
    return ok({
      enabled: ["agency", "pm", "it", "billing", "clients", "knowledge", "automation-console", "hr", "search", "reports"],
    });
  }
  if (p === "/api/module-catalog") {
    return ok(
      ["agency", "pm", "it", "billing", "clients", "knowledge", "automation-console", "hr", "search", "reports"].map(
        (key) => ({ key, label: key, paths: [] }),
      ),
    );
  }

  // ORG-13 service assignments. Real shapes (not the generic {id,ok:true}
  // catch-all further down) so the Connect-service dialog / /admin/services
  // page can be exercised end-to-end with DEMO_MODE=1 + SERVICE_ASSIGNMENTS_
  // ENABLED=1 without crashing on an unexpected undefined field. Session-only
  // in-memory list — resets on server restart, matches every other demo store.
  const assignUnitMatch = p.match(/^\/api\/[^/]+\/org-structure\/units\/([^/]+)\/assignments$/);
  if (assignUnitMatch && m === "POST") {
    const nodeId = assignUnitMatch[1];
    const b = JSON.parse(body || "{}") as { targets?: string[]; module?: string; leadUserId?: string };
    const targets = Array.isArray(b.targets) ? b.targets : [];
    const companies = targets.map((id) => {
      const co = COMPANIES.find((c) => c.id === id) as { id: string; name: string } | undefined;
      return { id, name: co?.name ?? id, included: true };
    });
    if (url.searchParams.get("dryRun") === "1") {
      return ok({
        dryRun: true,
        unit: { nodeId, name: "Demo unit", kind: "department" },
        items: [{ userId: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", role: "staff" }],
        companies,
      });
    }
    const assignments = targets.map((t) => ({ id: demoId("sa"), target: t, status: "proposed" as const }));
    DEMO_ASSIGNMENTS.push(...assignments.map((a, i) => ({
      id: a.id, providerTenantId: tenantFromPath(p) ?? "", providerCompanyName: undefined,
      targetTenantId: targets[i], targetCompanyName: companies[i]?.name,
      unitId: nodeId, unitName: "Demo unit", unitKind: "department", unitStatus: "active" as const,
      module: b.module ?? "hr", status: "proposed" as const, leadUserId: b.leadUserId ?? null, createdAt: new Date().toISOString(),
    })));
    return { status: 201, json: { assignments } };
  }
  const assignActionMatch = p.match(/^\/api\/[^/]+\/org-structure\/assignments\/([^/]+)\/(accept|suspend|resume|reconcile)$/);
  if (assignActionMatch) {
    const row = DEMO_ASSIGNMENTS.find((a) => a.id === assignActionMatch[1]);
    const action = assignActionMatch[2];
    if (row) {
      if (action === "accept") row.status = "active";
      else if (action === "suspend") row.status = "suspended";
      else if (action === "resume") row.status = "active";
    }
    if (action === "reconcile") return ok({ assignmentId: assignActionMatch[1], status: row?.status ?? "active", granted: 1, revoked: 0, orphaned: 0, skipped: 0, affectedUsers: 1 });
    return ok({ ok: true, status: row?.status ?? "active" });
  }
  const assignByIdMatch = p.match(/^\/api\/[^/]+\/org-structure\/assignments\/([^/]+)$/);
  if (assignByIdMatch && m === "DELETE") {
    const row = DEMO_ASSIGNMENTS.find((a) => a.id === assignByIdMatch[1]);
    if (row) row.status = "revoked";
    return ok({ ok: true, status: "revoked" });
  }
  if (assignByIdMatch && m === "PATCH") {
    const row = DEMO_ASSIGNMENTS.find((a) => a.id === assignByIdMatch[1]);
    const b = JSON.parse(body || "{}") as { nodeId?: string };
    if (row && b.nodeId) { row.unitId = b.nodeId; row.unitStatus = "active"; }
    return ok({ ok: true, status: row?.status ?? "active", reconsentRequired: false });
  }
  if (p.match(/^\/api\/[^/]+\/org-structure\/reconcile$/) && m === "POST") return ok({ results: [] });
  if (p.match(/^\/api\/[^/]+\/org-structure\/assignments$/) && m === "GET") {
    const direction = url.searchParams.get("direction");
    const t = tenantFromPath(p);
    const items = DEMO_ASSIGNMENTS.filter((a) => (direction === "served" ? a.targetTenantId === t : a.providerTenantId === t));
    return ok({ items, companies: [] });
  }
  if (p.match(/^\/api\/[^/]+\/org-structure\/service-units$/) && m === "GET") return ok({ items: [], companies: [] });

  const timeMatch = p.match(/^\/api\/[^/]+\/time-entries$/);
  if (timeMatch) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const te = { id: demoId("te"), user_id: DEMO_USER_ID, project_id: (b.projectId as string) ?? null, task_id: (b.taskId as string) ?? null, minutes: Number(b.minutes ?? 0), billable: Boolean(b.billable), entry_date: String(b.entryDate ?? "2026-07-16"), notes: String(b.notes ?? "") };
      TIME_ENTRIES.push(te);
      return { status: 201, json: { id: te.id } };
    }
    const uid = url.searchParams.get("userId");
    const mine = url.searchParams.get("mine") === "me";
    const rows = mine
      ? TIME_ENTRIES.filter((e) => e.user_id === DEMO_USER_ID)
      : uid
        ? TIME_ENTRIES.filter((e) => e.user_id === uid)
        : TIME_ENTRIES;
    return ok(rows);
  }

  // Files (attachments by reference).
  const fileOne = p.match(/^\/api\/[^/]+\/files\/([^/]+)$/);
  if (fileOne && m === "DELETE") { const i = FILES.findIndex((f) => f.id === fileOne[1]); if (i >= 0) FILES.splice(i, 1); return ok({ ok: true }); }
  const filesMatch = p.match(/^\/api\/[^/]+\/files$/);
  if (filesMatch) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const f = { id: demoId("f"), entity_type: String(b.entityType ?? ""), entity_id: String(b.entityId ?? ""), filename: String(b.filename ?? "file"), content_type: (b.content_type as string) ?? "application/octet-stream", byte_size: 0, scrubbed: true, uploader_id: DEMO_USER_ID, created_at: "2026-07-16T09:00:00Z", url: (b.url as string) || null };
      FILES.push(f);
      return { status: 201, json: { id: f.id } };
    }
    const et = url.searchParams.get("entityType"), eid = url.searchParams.get("entityId");
    return ok(FILES.filter((f) => (!et || f.entity_type === et) && (!eid || f.entity_id === eid)));
  }

  // Invoices (billing) — POST computes billable hours in the period.
  const invOne = p.match(/^\/api\/[^/]+\/invoices\/([^/]+)$/);
  if (invOne) {
    const inv = INVOICES.find((x) => x.id === invOne[1]);
    if (!inv) return { status: 404, json: { error: "invoice not found" } };
    if (m === "PATCH") { const b = JSON.parse(body || "{}"); if (b.status) inv.status = b.status; return ok({ ok: true }); }
    return ok(inv);
  }
  const invMatch = p.match(/^\/api\/[^/]+\/invoices$/);
  if (invMatch) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const rate = Number(b.rate ?? 0);
      const start = String(b.periodStart ?? ""), end = String(b.periodEnd ?? "");
      const inPeriod = TIME_ENTRIES.filter((e) => e.billable && (!start || String(e.entry_date) >= start) && (!end || String(e.entry_date) <= end));
      const minutes = inPeriod.reduce((n, e) => n + (Number(e.minutes) || 0), 0);
      const hours = Math.round((minutes / 60) * 10) / 10;
      const amount = Math.round(hours * rate * 100) / 100;
      const clientName = (CLIENTS.find((c) => c.id === b.clientId)?.name as string) ?? "Client";
      const inv = { id: demoId("inv"), clientId: (b.clientId as string) ?? null, clientName, periodStart: start || null, periodEnd: end || null, status: "draft", currency: String(b.currency ?? "USD"), total: amount, lines: [{ description: `Billable time${start ? ` ${start} – ${end}` : ""}`, hours, rate, amount }], createdAt: "2026-07-16T09:00:00Z" };
      INVOICES.push(inv);
      return { status: 201, json: { id: inv.id } };
    }
    return ok(INVOICES);
  }

  // Clients
  const clientOne = p.match(/^\/api\/[^/]+\/clients\/([^/]+)$/);
  if (clientOne && m === "DELETE") { const i = CLIENTS.findIndex((c) => c.id === clientOne[1]); if (i >= 0) CLIENTS.splice(i, 1); return ok({ ok: true }); }
  const clientsMatch = p.match(/^\/api\/[^/]+\/clients$/);
  if (clientsMatch) {
    if (m === "POST") { const b = JSON.parse(body || "{}"); const c = { id: demoId("cl"), name: String(b.name ?? "New client"), contact: b.contact ?? {}, status: (b.status as string) ?? "active", custom_fields: {} }; CLIENTS.push(c); return { status: 201, json: { id: c.id } }; }
    return ok(CLIENTS);
  }
  // Deliverables
  const delivMatch = p.match(/^\/api\/[^/]+\/deliverables$/);
  if (delivMatch) {
    if (m === "POST") { const b = JSON.parse(body || "{}"); const d = { id: demoId("dl"), project_id: (b.projectId as string) ?? null, client_id: (b.clientId as string) ?? null, name: String(b.name ?? "New deliverable"), status: (b.status as string) ?? "todo", due_date: (b.dueDate as string) ?? null }; DELIVERABLES.push(d); return { status: 201, json: { id: d.id } }; }
    const pid = url.searchParams.get("projectId");
    return ok(pid ? DELIVERABLES.filter((d) => d.project_id === pid) : DELIVERABLES);
  }

  const fieldsMatch = p.match(/^\/api\/[^/]+\/custom-fields$/);
  if (fieldsMatch) {
    if (m === "POST") return { status: 201, json: { id: `field-new-${Date.now()}` } };
    return ok(CUSTOM_FIELDS[url.searchParams.get("entityType") ?? ""] ?? []);
  }
  if (p.match(/^\/api\/[^/]+\/custom-fields\/[^/]+$/)) return ok({ ok: true });

  const campaignsMatch = p.match(/^\/api\/([^/]+)\/modules\/agency\/campaigns$/);
  if (campaignsMatch) {
    if (m === "POST") return { status: 201, json: { id: `cam-new-${Date.now()}` } };
    if (campaignsMatch[1] !== "co-agency") return { status: 404, json: { error: "module agency not enabled" } };
    return ok(CAMPAIGNS);
  }
  const briefsMatch = p.match(/^\/api\/([^/]+)\/modules\/agency\/campaigns\/([^/]+)\/briefs$/);
  if (briefsMatch) {
    if (m === "POST") return { status: 201, json: { id: `brief-new-${Date.now()}` } };
    if (briefsMatch[1] !== "co-agency") return { status: 404, json: { error: "module agency not enabled" } };
    return ok(BRIEFS[briefsMatch[2]] ?? []);
  }
  const approvalsMatch = p.match(/^\/api\/([^/]+)\/modules\/agency\/approvals\/pending$/);
  if (approvalsMatch) {
    if (approvalsMatch[1] !== "co-agency") return { status: 404, json: { error: "module agency not enabled" } };
    return ok(APPROVALS_PENDING);
  }
  const decidedMatch = p.match(/^\/api\/([^/]+)\/modules\/agency\/approvals\/decided$/);
  if (decidedMatch) {
    if (decidedMatch[1] !== "co-agency") return { status: 404, json: { error: "module agency not enabled" } };
    return ok(APPROVALS_DECIDED);
  }
  const decideMatch = p.match(/^\/api\/[^/]+\/modules\/agency\/approvals\/([^/]+)\/decide$/);
  if (decideMatch && m === "POST") return ok({ id: decideMatch[1], status: "approved" });

  // APPR-01 — single-approval read backing `/approvals/[id]` (agency origin). Placed AFTER the
  // pending/decided/decide matches above so their literal path segments are consumed first; by the
  // time this generic `:approvalId` matcher runs, "pending"/"decided"/".../decide" have already
  // returned. Sourced from the SAME `APPROVALS_PENDING`/`APPROVALS_DECIDED`/`CAMPAIGNS` arrays the
  // list endpoints use, mapped onto the real backend's camelCase detail shape
  // (`agency.controller.ts`'s new `approvalDetail()`).
  const agencyApprovalDetailMatch = p.match(/^\/api\/([^/]+)\/modules\/agency\/approvals\/([^/]+)$/);
  if (agencyApprovalDetailMatch && m === "GET") {
    if (agencyApprovalDetailMatch[1] !== "co-agency") return { status: 404, json: { error: "module agency not enabled" } };
    const id = agencyApprovalDetailMatch[2];
    const pending = APPROVALS_PENDING.find((a) => a.id === id);
    if (pending) {
      return ok({
        id: pending.id, subject: pending.subject, campaignId: pending.campaignId, campaign: pending.campaign,
        assetId: null, status: "pending", requestedBy: "u-pm", requestedByName: "Dewi Santoso",
        decidedBy: null, decidedByName: null, decidedAt: null, createdAt: pending.created_at,
      });
    }
    const decided = APPROVALS_DECIDED.find((a) => a.id === id);
    if (decided) {
      const camp = CAMPAIGNS.find((c) => c.name === decided.campaign);
      return ok({
        id: decided.id, subject: decided.subject, campaignId: camp?.id ?? "cam-1", campaign: decided.campaign,
        assetId: null, status: decided.decision, requestedBy: "u-pm", requestedByName: "Dewi Santoso",
        decidedBy: DEMO_USER_ID, decidedByName: decided.decided_by, decidedAt: decided.decided_at, createdAt: decided.decided_at,
      });
    }
    return { status: 404, json: { error: "approval not found" } };
  }

  // ---- WSUX-3 cross-company My-Work tasks (lib/agenda.ts, `GET /api/tasks/mine`) ----
  // Union shim demo leg: base ALL_TASKS (assignee_id) + PM poly-assignee tasks,
  // tagged with their owning company, mirroring tasks-mine.controller.ts's
  // real disjoint-union shape (`source`, `href`, `company`/`tenantId`).
  if (p === "/api/tasks/mine") {
    const scopeParam = url.searchParams.get("scope") ?? "all";
    const statusParam = url.searchParams.get("status");
    const dueBeforeParam = url.searchParams.get("dueBefore");
    const scopeIds = scopeParam === "all" ? COMPANIES.map((c) => c.id as string) : [scopeParam];
    const nameFor = (id: string) => (COMPANIES.find((c) => c.id === id)?.name as string) ?? "";

    const baseRows = ALL_TASKS
      .filter((t) => (t as { assignee_id: string | null }).assignee_id === DEMO_USER_ID)
      .map((t) => {
        const tr = t as { id: string; title: string; status: string; due_date: string | null; project_id: string };
        return { id: tr.id, title: tr.title, status: tr.status, dueDate: tr.due_date, tenantId: PROJECT_COMPANY[tr.project_id] ?? "", source: "task" as const };
      });
    const pmRows = pmTasksForUser(DEMO_USER_ID).map((t) => ({
      id: t.id, title: t.title, status: t.status, dueDate: t.dueDate, tenantId: "co-agency", source: "pm_task" as const,
    }));

    const items = [...baseRows, ...pmRows]
      .filter((r) => scopeIds.includes(r.tenantId))
      .filter((r) => (statusParam ? r.status === statusParam : true))
      .filter((r) => (dueBeforeParam ? (r.dueDate !== null && r.dueDate <= dueBeforeParam) : true))
      .map((r) => ({ ...r, company: nameFor(r.tenantId), href: `/tasks/${r.id}` }));
    items.sort((a, b) => {
      if (a.dueDate === b.dueDate) return 0;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    });
    const companies = scopeIds.map((id) => ({ id, name: nameFor(id), included: true }));
    return ok({ items, companies });
  }

  // ---- WSUX-1 unified read (lib/approvals.ts) ----
  if (p === "/api/approvals") {
    const scopeParam = url.searchParams.get("scope") ?? "all";
    const statusParam = url.searchParams.get("status") ?? "pending";
    const sortParam = url.searchParams.get("sort") ?? "urgency";
    const originParam = url.searchParams.get("origin");
    const originFilter = originParam ? new Set(originParam.split(",")) : null;
    const scopeIds = scopeParam === "all" ? COMPANIES.map((c) => c.id as string) : [scopeParam];
    const now = Date.now();
    const items = UNIFIED_APPROVALS
      .filter((r) => scopeIds.includes(r.tenantId))
      .filter((r) => (originFilter ? originFilter.has(r.origin) : true))
      .filter((r) => (statusParam === "pending" ? r.status === "pending" : r.status !== "pending"))
      .map((r) => {
        const ageMs = now - new Date(r.createdAt).getTime();
        return {
          id: r.id, origin: r.origin, tenantId: r.tenantId,
          company: (COMPANIES.find((c) => c.id === r.tenantId)?.name as string) ?? "",
          subject: r.subject, subjectHref: r.subjectHref, previewUrl: r.previewUrl,
          createdAt: r.createdAt, ageMs, urgencyScore: unifiedUrgency(r.origin, ageMs, r.impact),
          decidable: true, status: r.status,
        };
      });
    items.sort((a, b) => (sortParam === "age" ? b.ageMs - a.ageMs : b.urgencyScore - a.urgencyScore));
    const companies = scopeIds.map((id) => ({ id, name: (COMPANIES.find((c) => c.id === id)?.name as string) ?? "", included: true }));
    return ok({ items, companies });
  }
  // ---- WSUX-2 decide façade (app/(app)/actions.ts's decideApprovalItem) ----
  const unifiedDecideMatch = p.match(/^\/api\/([^/]+)\/approvals\/([^/]+)\/decide$/);
  if (unifiedDecideMatch && m === "POST") {
    const row = UNIFIED_APPROVALS.find((r) => r.id === unifiedDecideMatch[2]);
    const b = JSON.parse(body || "{}") as { decision?: string };
    if (row && b.decision) row.status = b.decision === "approved" ? "approved" : "rejected";
    return ok({ ok: true });
  }

  // ---- IT: devices / events / topology (lib/it.ts) ----
  const devDetailMatch = p.match(/^\/api\/([^/]+)\/it\/devices\/([^/]+)$/);
  if (devDetailMatch) {
    const list = DEVICES[devDetailMatch[1]] ?? [];
    const dev = list.find((d) => (d as { id: string }).id === devDetailMatch[2]);
    if (!dev) return { status: 404, json: { error: "device not found" } };
    const events = (DEVICE_EVENTS[devDetailMatch[1]] ?? []).filter((e) => (e as { deviceId: string }).deviceId === devDetailMatch[2]);
    const heartbeats = HEARTBEATS[devDetailMatch[2]] ?? HEARTBEAT_DEFAULT;
    return ok({ ...dev, events, heartbeats });
  }
  const devListMatch = p.match(/^\/api\/([^/]+)\/it\/devices$/);
  if (devListMatch) {
    if (m === "POST") return { status: 201, json: { id: `dev-new-${Date.now()}` } };
    return ok(DEVICES[devListMatch[1]] ?? []);
  }
  const devEventsMatch = p.match(/^\/api\/([^/]+)\/it\/events$/);
  if (devEventsMatch) {
    const rows = DEVICE_EVENTS[devEventsMatch[1]] ?? [];
    const dId = url.searchParams.get("deviceId");
    const limit = Number(url.searchParams.get("limit") ?? 0);
    let out = dId ? rows.filter((e) => (e as { deviceId: string }).deviceId === dId) : rows;
    if (limit > 0) out = out.slice(0, limit);
    return ok(out);
  }
  if (p === "/api/admin/automation/workflows") return ok(N8N_WORKFLOWS_LIST);
  const wfDetailMatch = p.match(/^\/api\/admin\/automation\/workflows\/([^/]+)$/);
  if (wfDetailMatch) return ok(N8N_WORKFLOWS[wfDetailMatch[1]] ?? null);

  // ---- Systems console (lib/admin.ts) ----
  const statusMatch = p.match(/^\/api\/admin\/([^/]+)\/status$/);
  if (statusMatch) return ok(SYSTEM_STATUS[statusMatch[1]] ?? { ok: false });
  const configMatch = p.match(/^\/api\/admin\/([^/]+)\/config$/);
  if (configMatch) {
    if (m === "PUT") return ok({ ok: true });
    return ok({ fields: SYSTEM_CONFIG[configMatch[1]] ?? [] });
  }
  if (p === "/api/admin/gateway/egress-audit") {
    // Mirror the backend's filtering so the demo's filter chips behave like the real console.
    const decision = url.searchParams.get("decision");
    const capability = url.searchParams.get("capability");
    let rows = EGRESS_AUDIT as Array<{ ok: boolean; blocked: string | null; capability: string }>;
    if (capability) rows = rows.filter((r) => r.capability === capability);
    if (decision === "allow") rows = rows.filter((r) => r.ok);
    else if (decision === "blocked") rows = rows.filter((r) => !r.ok);
    else if (decision) rows = rows.filter((r) => r.blocked === decision);
    return ok(rows);
  }
  if (p === "/api/admin/gateway/detail") return ok(GATEWAY_DETAIL);
  if (p === "/api/admin/gateway/config" && (m === "PUT" || m === "DELETE")) {
    return ok({ ok: true, key: "demo", applied: "demo", revertedToEnv: m === "DELETE" });
  }
  const wfToggle = p.match(/^\/api\/admin\/automation\/workflows\/([^/]+)\/(activate|deactivate)$/);
  if (wfToggle && m === "POST") return ok({ id: wfToggle[1], active: wfToggle[2] === "activate" });
  const replay = p.match(/^\/api\/admin\/automation\/bridge\/([^/]+)\/replay$/);
  if (replay && m === "POST") {
    const stream = BRIDGE_HEALTH.streams.find((x) => x.entityType === replay[1]);
    return ok({ entityType: replay[1], replayed: stream?.deadLetter ?? 0, remaining: 0 });
  }
  if (p === "/api/admin/gateway/dr-mode" && m === "POST") return ok({ drMode: true, budget: GATEWAY_DETAIL.budget });
  if (p === "/api/admin/hub/tools") return ok(HUB_TOOLS);
  if (p === "/api/admin/hub/detail") return ok(HUB_DETAIL);
  if (p === "/api/admin/hub/audit") return ok(HUB_AUDIT);
  if (p === "/api/admin/automation/executions") return ok(WORKFLOW_EXECUTIONS);
  if (p === "/api/admin/automation/bridge") return ok(BRIDGE_HEALTH);
  const goalsMatch = p.match(/^\/api\/([^/]+)\/agents\/goals$/);
  if (goalsMatch) return ok(AGENT_GOALS[goalsMatch[1]] ?? []);
  const sourcesMatch = p.match(/^\/api\/([^/]+)\/knowledge\/sources$/);
  if (sourcesMatch) return ok(KNOWLEDGE_SOURCES[sourcesMatch[1]] ?? []);
  if (p.match(/^\/api\/[^/]+\/knowledge\/sources\/[^/]+\/review$/) && m === "POST") return ok({ ok: true });

  // ---- Admin section (lib/adminData.ts) ----
  const usersList = p.match(/^\/api\/([^/]+)\/users$/);
  if (usersList) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const id = demoId("u");
      const roleName = ROLES.find((r) => r.id === b.roleId)?.name;
      const user = { id, name: String(b.name ?? "New person"), email: String(b.email ?? ""), title: (b.title as string) ?? null, status: "invited", roles: roleName ? [{ grantId: demoId("gr"), role: roleName, scopeType: "company", scopeId: usersList[1] }] : [] };
      USERS.push(user);
      (MEMBERS[usersList[1]] ??= []).push({ user_id: id, name: user.name, email: user.email, title: user.title });
      return { status: 201, json: { id } };
    }
    return ok(USERS);
  }
  const userPatch = p.match(/^\/api\/[^/]+\/users\/([^/]+)$/);
  if (userPatch && m === "PATCH") {
    const user = USERS.find((x) => x.id === userPatch[1]);
    if (user) { const b = JSON.parse(body || "{}"); if (b.title !== undefined) user.title = b.title; if (b.status != null) user.status = b.status; if (b.name != null) user.name = b.name; }
    return ok({ ok: true });
  }
  if (p === "/api/roles") return ok(ROLES);
  const roleAssign = p.match(/^\/api\/([^/]+)\/users\/([^/]+)\/roles$/);
  if (roleAssign && m === "POST") {
    const user = USERS.find((x) => x.id === roleAssign[2]) as { roles: unknown[] } | undefined;
    if (user) { const b = JSON.parse(body || "{}"); const roleName = ROLES.find((r) => r.id === b.roleId)?.name ?? b.roleId; user.roles.push({ grantId: demoId("gr"), role: roleName, scopeType: b.scopeType ?? "company", scopeId: b.scopeId ?? roleAssign[1] }); }
    return ok({ ok: true });
  }
  const roleRevoke = p.match(/^\/api\/[^/]+\/users\/([^/]+)\/roles\/([^/]+)$/);
  if (roleRevoke && m === "DELETE") {
    const user = USERS.find((x) => x.id === roleRevoke[1]) as { roles: { grantId: string }[] } | undefined;
    if (user) user.roles = user.roles.filter((r) => r.grantId !== roleRevoke[2]);
    return ok({ ok: true });
  }
  if (p.match(/^\/admin\/users\/[^/]+\/revoke$/)) return ok({ ok: true });
  if (p.match(/^\/api\/[^/]+\/identity-links$/)) return ok(IDENTITY_LINKS);
  if (p.match(/^\/api\/[^/]+\/identity-links\/[^/]+\/verify$/) || p.match(/^\/api\/[^/]+\/identity-links\/[^/]+$/)) return ok({ ok: true });
  if (p.match(/^\/api\/[^/]+\/company\/modules$/)) return ok({ ok: true });
  if (p.match(/^\/api\/[^/]+\/compliance-gates$/)) return ok(COMPLIANCE_GATES);
  if (p.match(/^\/api\/[^/]+\/compliance-gates\/[^/]+$/)) return ok({ ok: true });
  if (p.match(/^\/api\/[^/]+\/audit$/)) return ok(ACTIVITY);

  // ---- MAIL-15 — mail log + entity threads (lib/mail.ts) ----
  // A12: fixture addresses use the reserved TLD `*.gaiada.invalid`, same as the compiled backend
  // defaults — never a real domain, even in demo data.
  const mailThreadMatch = p.match(/^\/api\/admin\/mail\/log\/([^/]+)\/thread$/);
  if (mailThreadMatch) return ok({ mailLogId: mailThreadMatch[1], messages: mailThreadFor(mailThreadMatch[1]) });
  const mailDetailMatch = p.match(/^\/api\/admin\/mail\/log\/([^/]+)$/);
  if (mailDetailMatch) {
    const row = DEMO_MAIL_LOG.find((r) => r.id === mailDetailMatch[1]);
    if (!row) return { status: 404, json: { error: "mail log entry not found" } };
    return ok(row);
  }
  if (p === "/api/admin/mail/log") {
    return ok({ rows: DEMO_MAIL_LOG, limit: 100, offset: 0 });
  }
  const portalMailThreadMatch = p.match(/^\/api\/[^/]+\/portal\/mail\/threads$/);
  if (portalMailThreadMatch) {
    const runId = url.searchParams.get("runId") ?? "";
    return ok({ entityType: "pipeline_run", entityId: runId, messages: mailThreadForEntity("pipeline_run", runId) });
  }
  const mailThreadsMatch = p.match(/^\/api\/[^/]+\/mail\/threads$/);
  if (mailThreadsMatch) {
    const entityType = url.searchParams.get("entityType") ?? "";
    const entityId = url.searchParams.get("entityId") ?? "";
    return ok({ entityType, entityId, messages: mailThreadForEntity(entityType, entityId) });
  }

  // ---- F2 work-activity feed (lib/activity.ts) ----
  const workActivityMatch = p.match(/^\/api\/[^/]+\/work-activity$/);
  if (workActivityMatch) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      return { status: 201, json: { id: demoId("wa"), deduped: false, ...b } };
    }
    const deptId = url.searchParams.get("deptId");
    const projectId = url.searchParams.get("projectId");
    const personId = url.searchParams.get("personId");
    const since = url.searchParams.get("since");
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
    let rows = WORK_ACTIVITY;
    if (deptId) rows = rows.filter((r) => activityLinks(r).some((l) => l.targetKind === "department" && l.targetId === deptId));
    if (projectId) {
      rows = rows.filter(
        (r) =>
          activityLinks(r).some((l) => l.targetKind === "project" && l.targetId === projectId) ||
          (r.objectKind === "project" && r.objectRef === projectId),
      );
    }
    if (personId) {
      rows = rows.filter(
        (r) => r.actorUserId === personId || activityLinks(r).some((l) => l.targetKind === "person" && l.targetId === personId),
      );
    }
    if (since) rows = rows.filter((r) => String(r.occurredAt) >= since);
    const sorted = [...rows].sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    return ok(sorted.slice(0, limit));
  }

  // ---- WS4 automation-approvals inbox (lib/automationApprovals.ts) ----
  const autoApprovalDecide = p.match(/^\/api\/[^/]+\/automation-approvals\/([^/]+)\/decide$/);
  if (autoApprovalDecide && m === "POST") {
    const row = AUTOMATION_APPROVALS.find((a) => a.id === autoApprovalDecide[1]);
    const b = JSON.parse(body || "{}") as { decision?: "approved" | "rejected" };
    if (row && b.decision) { row.status = b.decision; row.decided_by = DEMO_USER_ID; row.decided_at = "2026-07-22T09:00:00Z"; }
    return ok({ id: autoApprovalDecide[1], status: row?.status ?? "approved" });
  }
  // D14-08 (D14-07's retry façade) — flips a failed row back to an in-flight state, mirroring the
  // real endpoint's contract closely enough for the demo build gate to exercise the Retry button.
  const autoApprovalRetry = p.match(/^\/api\/[^/]+\/automation-approvals\/([^/]+)\/retry$/);
  if (autoApprovalRetry && m === "POST") {
    const row = AUTOMATION_APPROVALS.find((a) => a.id === autoApprovalRetry[1]) as Record<string, unknown> | undefined;
    if (row) { row.execution_status = "pending"; row.execution_error = null; }
    return ok({ id: autoApprovalRetry[1], status: "pending" });
  }
  // APPR-01 — single-approval read backing `/approvals/[id]` (automation/agent/hr origin). Must be
  // an explicit fixture, not left to the file's final GET catch-all (`ok([])`, an empty ARRAY —
  // truthy in JS, which is exactly the bug `lib/approvals.ts`'s `isRowShaped()` guard exists for):
  // an id with no fixture here needs a real 404 so the dual-fetch fallback in `getApprovalDetail`
  // correctly falls through to the agency lookup instead of misreporting "found".
  const autoApprovalDetailMatch = p.match(/^\/api\/[^/]+\/automation-approvals\/([^/]+)$/);
  if (autoApprovalDetailMatch && m === "GET") {
    const row = AUTOMATION_APPROVALS.find((a) => (a as { id: string }).id === autoApprovalDetailMatch[1]);
    if (!row) return { status: 404, json: { error: "approval not found" } };
    const r = row as Record<string, unknown>;
    return ok({
      id: r.id, workflowId: r.workflow_id, toolName: r.tool_name, toolArgs: r.tool_args,
      impact: r.impact, reason: r.reason, status: r.status, origin: r.origin, agentName: r.agent_name,
      requestedBy: r.requested_by, requestedByName: r.requested_by === "system" ? "System" : "Clement Hansel",
      decidedBy: r.decided_by, decidedByName: r.decided_by ? "Clement Hansel" : null,
      decidedAt: r.decided_at, createdAt: r.created_at,
      executionStatus: r.execution_status ?? null, executedAt: r.executed_at ?? null, executedBy: r.executed_by ?? null,
      executionError: r.execution_error ?? null, executionResult: r.execution_result ?? null, executionAttempts: r.execution_attempts ?? null,
    });
  }

  const autoApprovalsMatch = p.match(/^\/api\/([^/]+)\/automation-approvals$/);
  if (autoApprovalsMatch) {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      return { status: 201, json: { id: demoId("aa"), status: "pending", ...b } };
    }
    // Both demo rows reference co-agency records (a CCTV device + a co-agency
    // project); scope the GET to that tenant so a cross-company fan-out
    // (WSUX-5's getMyWorkQueue) doesn't show the same two rows tripled across
    // every demo company.
    if (autoApprovalsMatch[1] !== "co-agency") return ok([]);
    const status = url.searchParams.get("status") ?? "pending";
    const origin = url.searchParams.get("origin");
    let rows = AUTOMATION_APPROVALS;
    if (status) rows = rows.filter((r) => r.status === status);
    if (origin) rows = rows.filter((r) => r.origin === origin);
    return ok(rows);
  }

  // ---- F1 connections vault (lib/connections.ts) ----
  const connOneMatch = p.match(/^\/api\/[^/]+\/integrations\/connections\/([^/]+)$/);
  if (connOneMatch) {
    const row = CONNECTIONS.find((c) => c.id === connOneMatch[1]);
    if (!row) return { status: 404, json: { error: "connection not found" } };
    if (m === "PATCH") {
      const b = JSON.parse(body || "{}") as { externalAccount?: string; meta?: Record<string, unknown>; status?: string; scopes?: string[] };
      if (b.externalAccount !== undefined) row.externalAccount = b.externalAccount;
      if (b.meta) row.meta = { ...row.meta, ...b.meta };
      if (b.status) row.status = b.status;
      if (b.scopes) row.scopes = b.scopes;
      row.updatedAt = new Date().toISOString();
      return ok(row);
    }
    if (m === "DELETE") {
      row.status = "revoked"; row.hasToken = false; row.hasRefreshToken = false; row.updatedAt = new Date().toISOString();
      return ok(row);
    }
    return ok(row);
  }
  const connListMatch = p.match(/^\/api\/([^/]+)\/integrations\/connections$/);
  if (connListMatch) {
    const t = connListMatch[1];
    if (m === "POST") {
      const b = JSON.parse(body || "{}") as { provider: string; ownerKind?: string; ownerId?: string; externalAccount?: string; scopes?: string[]; meta?: Record<string, unknown> };
      const ownerKind = (b.ownerKind as "user" | "company") ?? "user";
      const ownerId = ownerKind === "company" ? t : (b.ownerId ?? DEMO_USER_ID);
      const existing = CONNECTIONS.find((c) => c.tenantId === t && c.ownerKind === ownerKind && c.ownerId === ownerId && c.provider === b.provider);
      if (existing) {
        if (b.externalAccount !== undefined) existing.externalAccount = b.externalAccount;
        if (b.scopes) existing.scopes = b.scopes;
        if (b.meta) existing.meta = { ...existing.meta, ...b.meta };
        existing.status = "unconfigured";
        existing.updatedAt = new Date().toISOString();
        return { status: 201, json: existing };
      }
      const row: DemoConnection = {
        id: demoId("conn"), tenantId: t, ownerKind, ownerId, provider: b.provider as DemoConnection["provider"],
        externalAccount: b.externalAccount ?? null, scopes: b.scopes ?? [], status: "unconfigured",
        hasToken: false, hasRefreshToken: false, tokenExpiresAt: null, tokenKeyVersion: null,
        meta: b.meta ?? {}, createdBy: DEMO_USER_ID, originSite: "central",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      CONNECTIONS.push(row);
      return { status: 201, json: row };
    }
    const owner = url.searchParams.get("owner") ?? "me";
    const provider = url.searchParams.get("provider");
    let rows = CONNECTIONS.filter((c) => c.tenantId === t && c.status !== "revoked");
    if (owner === "me") rows = rows.filter((c) => c.ownerKind === "user" && c.ownerId === DEMO_USER_ID);
    else if (owner === "company") rows = rows.filter((c) => c.ownerKind === "company");
    else if (owner.startsWith("user:")) { const uid = owner.slice(5); rows = rows.filter((c) => c.ownerKind === "user" && c.ownerId === uid); }
    if (provider) rows = rows.filter((c) => c.provider === provider);
    return ok(rows);
  }

  // ---- C1 Claude seat registry (lib/claudeSeats.ts) — a projection over
  // CONNECTIONS rows with provider='claude', same as the real backend. ----
  const seatOneMatch = p.match(/^\/api\/[^/]+\/integrations\/claude-seats\/([^/]+)$/);
  if (seatOneMatch) {
    const row = CONNECTIONS.find((c) => c.id === seatOneMatch[1] && c.provider === "claude");
    if (!row) return { status: 404, json: { error: "seat not found" } };
    if (m === "PATCH") {
      const b = JSON.parse(body || "{}") as { codeSeatEmail?: string; designLogin?: string; status?: string };
      if (b.codeSeatEmail !== undefined) row.externalAccount = b.codeSeatEmail;
      if (b.designLogin !== undefined) row.meta = { ...row.meta, designLogin: b.designLogin };
      if (b.status) row.status = b.status;
      row.updatedAt = new Date().toISOString();
      return ok(toSeatRow(row));
    }
    if (m === "DELETE") {
      row.status = "revoked"; row.hasToken = false; row.hasRefreshToken = false; row.updatedAt = new Date().toISOString();
      return ok(toSeatRow(row));
    }
    return ok(toSeatRow(row));
  }
  const seatListMatch = p.match(/^\/api\/([^/]+)\/integrations\/claude-seats$/);
  if (seatListMatch) {
    const t = seatListMatch[1];
    if (m === "POST") {
      const b = JSON.parse(body || "{}") as { userId?: string; codeSeatEmail: string; designLogin?: string };
      const ownerId = b.userId ?? DEMO_USER_ID;
      const existing = CONNECTIONS.find((c) => c.tenantId === t && c.ownerKind === "user" && c.ownerId === ownerId && c.provider === "claude");
      if (existing) {
        existing.externalAccount = b.codeSeatEmail;
        if (b.designLogin !== undefined) existing.meta = { ...existing.meta, designLogin: b.designLogin };
        existing.updatedAt = new Date().toISOString();
        return { status: 201, json: toSeatRow(existing) };
      }
      const row: DemoConnection = {
        id: demoId("seat"), tenantId: t, ownerKind: "user", ownerId, provider: "claude",
        externalAccount: b.codeSeatEmail, scopes: [], status: "unconfigured", hasToken: false, hasRefreshToken: false,
        tokenExpiresAt: null, tokenKeyVersion: null, meta: b.designLogin ? { designLogin: b.designLogin } : {},
        createdBy: DEMO_USER_ID, originSite: "central", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      CONNECTIONS.push(row);
      return { status: 201, json: toSeatRow(row) };
    }
    const owner = url.searchParams.get("owner") ?? "me";
    let rows = CONNECTIONS.filter((c) => c.tenantId === t && c.provider === "claude" && c.status !== "revoked");
    if (owner === "me") rows = rows.filter((c) => c.ownerId === DEMO_USER_ID);
    else if (owner.startsWith("user:")) { const uid = owner.slice(5); rows = rows.filter((c) => c.ownerId === uid); }
    // owner === "team": every claude row in the tenant, no further filter.
    return ok(rows.map(toSeatRow));
  }

  // SM-25a — the tenant-agnostic Google OAuth callback (search-google-oauth.controller.ts's real
  // mount: `GET api/search/google/oauth/callback`, deliberately WITHOUT `:tenantId` or
  // `/modules/search/` — real Google permits no wildcard redirect_uri, so the tenant travels inside
  // the signed `state` instead of the path). It therefore cannot be matched by the `smBase` regex
  // below and is checked first, on the raw pathname. The front-end route handler
  // (`app/api/search/google/callback/route.ts`) calls this with `code`/`state`/`provider` (and
  // `error`/`error_description` on a declined consent) exactly as it would call the real backend —
  // this demo handler plays the role of "the issuer said yes" so the SAME redirect-then-callback
  // code path is exercised in both DEMO_MODE and against a live backend.
  if (p === "/api/search/google/oauth/callback" && m === "GET") {
    const error = url.searchParams.get("error");
    if (error) return ok({ status: "denied", error, errorDescription: url.searchParams.get("error_description") });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const provider = url.searchParams.get("provider");
    if (!code || !state) return { status: 400, json: { error: "code and state are required (or error, if declined)" } };
    if (!provider || !["google_search_console", "google_analytics", "google_ads"].includes(provider)) {
      return { status: 400, json: { error: "provider must be one of google_search_console|google_analytics|google_ads" } };
    }
    // Demo `state` shape (see the authorize handler below): "demo-state.<clientId>.<propertyId|_>".
    const parts = state.split(".");
    const clientId = parts[1] ?? "cl-2";
    const propertyId = parts[2] && parts[2] !== "_" ? parts[2] : null;
    const store = loadGoogleStore();
    const conn: DemoGoogleConnection = {
      id: genDemoId("conn-google"), provider: provider as DemoGoogleConnection["provider"], clientId,
      status: "linked", hasToken: true, hasRefreshToken: true,
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      externalAccount: "demo-connect@cedargroup.example.com",
      // A freshly-started demo flow always completes through OUR OWN sandboxed callback, never
      // Google's real one — issuerIsGoogle: false is the honest answer, exactly like the seeded
      // conn-google-2 above. A "Connect" click in DEMO_MODE therefore always demonstrates §A12.3's
      // disclosure rule, never accidentally the real-Google (nothing-to-disclose) branch.
      issuerHost: "demo.gaiada.local", issuerIsGoogle: false,
    };
    store.connections.push(conn);
    if (propertyId) {
      store.bindings[propertyId] = { ...(store.bindings[propertyId] ?? {}), [provider]: conn.id };
    }
    saveGoogleStore(store);
    return ok(conn);
  }

  // Search-marketing (SEO console, SM-11 + SM-29) — properties/engagements/scope/cost-projection
  // are BUILT endpoints (SM-01/02/04); everything else on this base path (audits, keywords,
  // rankings, briefs, ai-visibility, sem/*) is intentionally left unmatched so those tabs render
  // their real BackendPending state, per lib/searchMarketing.ts's own comment. Added because the
  // generic GET fallback below returns `ok([])` for EVERY unmatched path — correct for a list
  // endpoint, but wrong for a singular-resource GET (engagements/:id, engagements/:id/scope,
  // engagements/:id/cost-projection): an array is truthy, so the `if (!engagement) notFound()`
  // guard in the engagement detail page never fires and the page crashes trying to render
  // `engagement.status` (undefined) through StatusBadge. Two engagements are seeded to exercise
  // both KPI states the page must distinguish: sm-eng-1 has a real persisted cost-projection
  // (money fields as STRINGS, matching Postgres `numeric` — formatUsd must coerce them, not
  // crash); sm-eng-2 deliberately has NONE (404s), so its projected-cost KPI must render "—",
  // never "$0.00" — SM-29's scope editor must still be usable on it (toggle it on, preview a
  // what-if price), it just never gets a PERSISTED projection in this fixture. Scope/budget reads
  // for both engagements come from the file-backed scope store (loadScopeStore/saveScopeStore
  // above) the PUT actually writes.
  const smBase = /^\/api\/([^/]+)\/modules\/search\//;
  if (smBase.test(p)) {
    if (p.match(/\/modules\/search\/properties$/) && m === "GET") {
      return ok([
        {
          id: "sm-prop-1", clientId: "cl-2", domain: "cedargroup.example.com",
          siteUrl: "https://cedargroup.example.com", targets: {}, umamiSiteId: null,
          verifiedAt: "2026-07-01T00:00:00Z", status: "verified", createdAt: "2026-06-01T00:00:00Z",
        },
      ]);
    }
    if (p.match(/\/modules\/search\/engagements$/) && m === "GET") {
      const scopeStore = loadScopeStore();
      return ok([
        {
          id: "sm-eng-1", clientId: "cl-2", propertyId: "sm-prop-1", projectId: "p-seo-1",
          name: "Cedar Group — Q3 SEO", scopePreset: scopeStore["sm-eng-1"].scopePreset, status: "active",
          providerBudgetUsd: scopeStore["sm-eng-1"].providerBudgetUsd,
          toolScope: scopeStore["sm-eng-1"].toolScope,
          startsOn: "2026-07-01", endsOn: null, createdAt: "2026-07-01T00:00:00Z",
        },
        {
          id: "sm-eng-2", clientId: "cl-2", propertyId: "sm-prop-1", projectId: null,
          name: "Cedar Group — GEO pilot", scopePreset: scopeStore["sm-eng-2"].scopePreset, status: "draft",
          providerBudgetUsd: scopeStore["sm-eng-2"].providerBudgetUsd, toolScope: scopeStore["sm-eng-2"].toolScope,
          startsOn: null, endsOn: null, createdAt: "2026-07-10T00:00:00Z",
        },
        {
          id: "sm-eng-3", clientId: "cl-2", propertyId: "sm-prop-1", projectId: null,
          name: "Cedar Group — Budget stress test", scopePreset: scopeStore["sm-eng-3"].scopePreset, status: "active",
          providerBudgetUsd: scopeStore["sm-eng-3"].providerBudgetUsd, toolScope: scopeStore["sm-eng-3"].toolScope,
          startsOn: "2026-07-20", endsOn: null, createdAt: "2026-07-20T00:00:00Z",
        },
      ]);
    }
    const engDetail = p.match(/\/modules\/search\/engagements\/([^/]+)$/);
    if (engDetail && m === "GET") {
      const store = loadScopeStore()[engDetail[1]];
      if (engDetail[1] === "sm-eng-1" && store) {
        return ok({
          id: "sm-eng-1", clientId: "cl-2", propertyId: "sm-prop-1", projectId: "p-seo-1",
          name: "Cedar Group — Q3 SEO", scopePreset: store.scopePreset, status: "active",
          providerBudgetUsd: store.providerBudgetUsd, toolScope: store.toolScope,
          startsOn: "2026-07-01", endsOn: null, createdAt: "2026-07-01T00:00:00Z",
        });
      }
      if (engDetail[1] === "sm-eng-2" && store) {
        return ok({
          id: "sm-eng-2", clientId: "cl-2", propertyId: "sm-prop-1", projectId: null,
          name: "Cedar Group — GEO pilot", scopePreset: store.scopePreset, status: "draft",
          providerBudgetUsd: store.providerBudgetUsd, toolScope: store.toolScope,
          startsOn: null, endsOn: null, createdAt: "2026-07-10T00:00:00Z",
        });
      }
      if (engDetail[1] === "sm-eng-3" && store) {
        return ok({
          id: "sm-eng-3", clientId: "cl-2", propertyId: "sm-prop-1", projectId: null,
          name: "Cedar Group — Budget stress test", scopePreset: store.scopePreset, status: "active",
          providerBudgetUsd: store.providerBudgetUsd, toolScope: store.toolScope,
          startsOn: "2026-07-20", endsOn: null, createdAt: "2026-07-20T00:00:00Z",
        });
      }
      return { status: 404, json: { error: "engagement not found" } };
    }
    const scopeMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/scope$/);
    if (scopeMatch && m === "GET") {
      const store = loadScopeStore()[scopeMatch[1]];
      if (!store) return { status: 404, json: { error: "engagement not found" } };
      // The real contract's envelope (search.controller.ts's getEngagementScope) — a bare toggle
      // map would silently break the scope editor's `scope.toolScope` read (see EngagementScope's
      // header note in lib/searchMarketing.ts).
      return ok({ scopePreset: store.scopePreset, toolScope: store.toolScope, providerBudgetUsd: store.providerBudgetUsd });
    }
    if (scopeMatch && m === "PUT") {
      const scopeStore = loadScopeStore();
      const store = scopeStore[scopeMatch[1]];
      if (!store) return { status: 404, json: { error: "engagement not found" } };
      const b = JSON.parse(body || "{}") as { scopePreset?: string; toolScope?: Record<string, unknown>; providerBudgetUsd?: number };
      const seeded = b.scopePreset && b.scopePreset !== "custom" ? DEMO_SCOPE_PRESETS[b.scopePreset] : undefined;
      const nextToolScope = seeded ?? b.toolScope;
      if (nextToolScope === undefined && b.scopePreset === undefined) {
        return { status: 400, json: { error: "scopePreset and/or toolScope required" } };
      }
      // SM-61 (§6au clause 4): mirrors search.controller.ts's cadence enum validation — see
      // demoValidateToolScopeCadence's header note.
      if (nextToolScope !== undefined) {
        const cadenceError = demoValidateToolScopeCadence(nextToolScope);
        if (cadenceError) return { status: 400, json: { error: cadenceError } };
      }
      if (b.scopePreset !== undefined) store.scopePreset = b.scopePreset;
      if (nextToolScope !== undefined) store.toolScope = JSON.parse(JSON.stringify(nextToolScope));
      if (b.providerBudgetUsd !== undefined) store.providerBudgetUsd = b.providerBudgetUsd;
      saveScopeStore(scopeStore);
      return ok({ id: scopeMatch[1], scopePreset: b.scopePreset ?? null, toolScope: nextToolScope ?? null });
    }
    const projMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/cost-projection$/);
    if (projMatch && m === "GET") {
      const id = projMatch[1];
      const store = loadScopeStore()[id];
      if (!store) return { status: 404, json: { error: "engagement not found" } };
      const toolScopeParam = url.searchParams.get("toolScope");
      if (toolScopeParam !== null) {
        // What-if: price a CANDIDATE scope without touching the store — exercises the scope
        // editor's live preview, including on sm-eng-2 (which never gets a PERSISTED projection).
        let candidate: Record<string, unknown>;
        try {
          candidate = JSON.parse(toolScopeParam);
        } catch {
          return { status: 400, json: { error: "toolScope must be a JSON object" } };
        }
        const budget = store.providerBudgetUsd ?? 10;
        const projection = demoProjectMonthlyCost(candidate, id);
        return ok({ ...projection, whatIf: true, providerBudgetUsd: budget, overBudget: Number(projection.totalMonthlyUsd) > budget });
      }
      // Persisted: sm-eng-2 is the deliberate "no projection yet" test case (SM-29 ticket) — kept
      // 404ing regardless of any scope the editor has saved to it, so the KPI's "—" state stays
      // exercisable.
      if (id === "sm-eng-2") return { status: 404, json: { error: "no cost projection yet" } };
      const budget = store.providerBudgetUsd ?? 10;
      const projection = demoProjectMonthlyCost(store.toolScope, id);
      return ok({ ...projection, whatIf: false, providerBudgetUsd: budget, overBudget: Number(projection.totalMonthlyUsd) > budget });
    }
    // ── Ledger / cost surface (SM-17) ───────────────────────────────────────────────────────────
    // Static (read-only, no PUT/POST on this route) — deliberately a MIX of real + simulated rows
    // on sm-eng-1, per the ticket's own instruction: a fixture where every row is one mode proves
    // nothing about the per-row chip's PRESENCE and ABSENCE both being exercisable. sm-eng-2 is kept
    // a genuine, honest EMPTY state (zero rows) — the primary live state today, since
    // `search_provider_calls` stays empty in every real env until SM-14/15/16 land a dispatch caller
    // (tracker note). The two engagements together exercise both states a real deploy can show.
    const ledgerMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/ledger$/);
    if (ledgerMatch && m === "GET") {
      const id = ledgerMatch[1];
      if (id === "sm-eng-1") {
        return ok({
          engagementId: id,
          providerMode: "live",
          costToServeUsd: 0.006,
          currentModeRowCount: 2,
          simulatedHistoryExcludedUsd: 0.42,
          rows: [
            {
              id: "ledger-1", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
              items: 10, costUsd: 0.006, cacheHit: false, status: "completed", simulated: false,
              createdAt: "2026-07-28T09:12:00Z",
            },
            {
              id: "ledger-2", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
              items: 10, costUsd: 0, cacheHit: true, status: "completed", simulated: false,
              createdAt: "2026-07-27T14:03:00Z",
            },
            // A historical row from a period the platform ran in `simulate` mode — kept, badged
            // forever (design addendum §A4.4), and it must still carry ITS OWN chip even though
            // `providerMode` above is `live` right now.
            {
              id: "ledger-3", provider: "semrush", endpoint: "keywords.volume",
              items: 50, costUsd: 0.42, cacheHit: false, status: "completed", simulated: true,
              createdAt: "2026-07-10T08:00:00Z",
            },
            {
              id: "ledger-4", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
              items: 1, costUsd: 0, cacheHit: false, status: "failed", simulated: false,
              createdAt: "2026-07-26T11:47:00Z",
            },
          ],
        });
      }
      if (id === "sm-eng-2") {
        return ok({
          engagementId: id, providerMode: "live", costToServeUsd: 0,
          currentModeRowCount: 0, simulatedHistoryExcludedUsd: null, rows: [],
        });
      }
      return { status: 404, json: { error: "engagement not found" } };
    }

    if (p.match(/\/modules\/search\/kpi-targets$/) && m === "GET") return ok([]);

    // ── Site Audit (SM-08, wired up per SM-12) ──────────────────────────────────────────────────
    if (p.match(/\/modules\/search\/audits$/) && m === "GET") {
      const propertyId = url.searchParams.get("propertyId");
      const { audits } = loadAuditStore();
      const rows = propertyId ? audits.filter((a) => a.propertyId === propertyId) : audits;
      return ok(rows.map(({ id, propertyId: pid, kind, source, status, score, summary, startedAt, completedAt, createdAt }) => (
        { id, propertyId: pid, kind, source, status, score, summary, startedAt, completedAt, createdAt }
      )));
    }
    const findingsMatch = p.match(/\/modules\/search\/audits\/([^/]+)\/findings$/);
    if (findingsMatch && m === "GET") {
      const { findings } = loadAuditStore();
      return ok(findings.filter((f) => f.auditId === findingsMatch[1]));
    }
    const triageMatch = p.match(/\/modules\/search\/findings\/([^/]+)$/);
    if (triageMatch && m === "PATCH") {
      const store = loadAuditStore();
      const finding = store.findings.find((f) => f.id === triageMatch[1]);
      if (!finding) return { status: 404, json: { error: "finding not found" } };
      const b = JSON.parse(body || "{}") as { status?: string };
      if (!b.status || !["open", "fixed", "ignored"].includes(b.status)) {
        return { status: 400, json: { error: "status must be open|fixed|ignored" } };
      }
      finding.status = b.status;
      saveAuditStore(store);
      return ok({ id: finding.id, status: finding.status });
    }

    // ── Keywords (SM-09, wired up per SM-12) ────────────────────────────────────────────────────
    if (p.match(/\/modules\/search\/keyword-sets$/) && m === "GET") {
      const engagementId = url.searchParams.get("engagementId");
      const { sets } = loadKeywordStore();
      return ok(engagementId ? sets.filter((s) => s.engagementId === engagementId) : sets);
    }
    if (p.match(/\/modules\/search\/keyword-sets$/) && m === "POST") {
      const b = JSON.parse(body || "{}") as { engagementId?: string; name?: string; source?: string };
      if (!b.engagementId || !b.name) return { status: 400, json: { error: "engagementId and name required" } };
      const store = loadKeywordStore();
      const id = genDemoId("sm-set");
      store.sets.push({ id, engagementId: b.engagementId, name: b.name, source: b.source ?? "client", createdAt: new Date().toISOString() });
      saveKeywordStore(store);
      return { status: 201, json: { id } };
    }
    const kwListMatch = p.match(/\/modules\/search\/keyword-sets\/([^/]+)\/keywords$/);
    if (kwListMatch && m === "GET") {
      const { keywords } = loadKeywordStore();
      return ok(
        keywords.filter((k) => k.setId === kwListMatch[1]).map(({ id, keyword, locale, intent, clusterId, clusterLabel, volume, difficulty, cpcUsd, metricsProvider, metricsSimulated, isTracked, hasEmbedding, createdAt }) => (
          { id, keyword, locale, intent, clusterId, clusterLabel, volume, difficulty, cpcUsd, metricsProvider, metricsSimulated, isTracked, hasEmbedding, createdAt }
        )),
      );
    }
    const importMatch = p.match(/\/modules\/search\/keyword-sets\/([^/]+)\/import$/);
    if (importMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { text?: string; locale?: string };
      if (!b.text || !b.text.trim()) return { status: 400, json: { error: "text required (CSV or one keyword per line)" } };
      let rows: { keyword: string; locale: string }[];
      try {
        rows = parseDemoKeywordImport(b.text);
      } catch (e) {
        // An unterminated quote is a 400 on the real controller too — reject rather than mangle.
        return { status: 400, json: { error: e instanceof Error ? e.message : "malformed keyword import text" } };
      }
      if (rows.length === 0) return { status: 400, json: { error: "no importable keyword rows found in text" } };
      const store = loadKeywordStore();
      const setId = importMatch[1];
      if (!store.sets.some((s) => s.id === setId)) return { status: 404, json: { error: "keyword set not found" } };
      const existing = store.keywords.filter((k) => k.setId === setId);
      // SM-32: reject an over-cap import outright — never silently truncate. Real message shape
      // mirrors search.controller.ts's importKeywords 400 text exactly, so a caller reading this
      // error in demo mode sees the same words the live backend would show.
      if (existing.length + rows.length > DEMO_MAX_KEYWORDS_PER_SET) {
        return {
          status: 400,
          json: {
            error: `import would bring this set to ${existing.length + rows.length} keywords, exceeding the ` +
              `${DEMO_MAX_KEYWORDS_PER_SET}-keyword cap (currently ${existing.length}, submitting ${rows.length})`,
          },
        };
      }
      let imported = 0;
      for (const row of rows) {
        if (existing.some((k) => k.keyword === row.keyword && k.locale === row.locale)) continue;
        store.keywords.push({
          id: genDemoId("sm-kw"), setId, keyword: row.keyword, locale: row.locale, intent: null,
          clusterId: null, clusterLabel: null, volume: null, difficulty: null, cpcUsd: null,
          // mode-inherent (tracker §6j's reader inventory): keyword import writes keyword/locale
          // only — metrics stay NULL/false, the same honest "not pulled" state as the real backend's
          // import INSERT (search.controller.ts's importKeywords never touches metric columns).
          metricsProvider: null, metricsSimulated: false,
          isTracked: false, hasEmbedding: false, createdAt: new Date().toISOString(),
        });
        imported++;
      }
      saveKeywordStore(store);
      return ok({ imported, submitted: rows.length, duplicates: rows.length - imported });
    }
    const embedMatch = p.match(/\/modules\/search\/keyword-sets\/([^/]+)\/embed$/);
    if (embedMatch && m === "POST") {
      const store = loadKeywordStore();
      const setId = embedMatch[1];
      if (!store.sets.some((s) => s.id === setId)) return { status: 404, json: { error: "keyword set not found" } };
      let embedded = 0;
      for (const k of store.keywords) {
        if (k.setId === setId && !k.hasEmbedding) { k.hasEmbedding = true; embedded++; }
      }
      saveKeywordStore(store);
      return ok({ mode: "array", embedded });
    }
    const clusterMatch = p.match(/\/modules\/search\/keyword-sets\/([^/]+)\/cluster$/);
    if (clusterMatch && m === "POST") {
      const store = loadKeywordStore();
      const setId = clusterMatch[1];
      if (!store.sets.some((s) => s.id === setId)) return { status: 404, json: { error: "keyword set not found" } };
      const members = store.keywords.filter((k) => k.setId === setId);
      const embedded = members.filter((k) => k.hasEmbedding);
      const skipped = members.length - embedded.length;
      // Demo-only "clustering": one cluster per DISTINCT leading word among embedded keywords — not
      // a stand-in for the real cosine/greedy partition (clustering.ts), just enough structure to
      // exercise the "clusters + intent labels" view with more than one cluster when the seed data
      // supports it.
      const byFirstWord = new Map<string, DemoKeyword[]>();
      for (const k of embedded) {
        const key = k.keyword.split(" ")[0];
        const list = byFirstWord.get(key) ?? [];
        list.push(k);
        byFirstWord.set(key, list);
      }
      const clusters = [...byFirstWord.entries()].map(([key, list]) => {
        const clusterId = list[0].clusterId ?? genDemoId("sm-cluster");
        const label = list[0].clusterLabel ?? `${key} — keywords`;
        const intent = list[0].intent ?? "commercial";
        for (const k of list) { k.clusterId = clusterId; k.clusterLabel = label; k.intent = k.intent ?? intent; }
        return { clusterId, label, intent, size: list.length, keywordIds: list.map((k) => k.id) };
      });
      saveKeywordStore(store);
      return ok({ mode: "array", clusters, skipped });
    }

    // ── SEM: campaigns / ad groups / ads / negatives / change proposals (SM-18 backend; SM-47
    // console). Route shapes mirror search.controller.ts's SEM section exactly (§4i discipline).
    const genPlanMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/campaigns\/generate-plan$/);
    if (genPlanMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { keywordSetId?: string; name?: string; platform?: string };
      if (!b.keywordSetId || !b.name) return { status: 400, json: { error: "keywordSetId and name required" } };
      const store = loadSemStore();
      const campaignId = genDemoId("sm-campaign");
      const now = new Date().toISOString();
      store.campaigns.push({
        id: campaignId, engagementId: genPlanMatch[1], platform: b.platform ?? "google_ads", externalId: null,
        name: b.name, objective: null, status: "draft", budgetMinor: null, currency: null, bidStrategy: null,
        targetCpaMinor: null, targetRoas: null, customFields: {}, created_at: now, updated_at: now,
      });
      // Fixed, deliberately MIXED provenance — the real backend computes this from
      // search_keywords.metrics_provider/metrics_simulated per keyword (SM-18's `buildCampaignPlan`);
      // the demo fabricates the SAME three-state shape directly on the response rather than deriving
      // it from KEYWORD_STORE (which SM-14 owns and does not carry those columns yet — see
      // KeywordWorkbench's own note on why no chip renders on keyword volume today). Two DISTINCT
      // providers (dataforseo, ahrefs) are present so "listed distinctly, never blended" is visibly
      // true, and one ad group is entirely unpulled so all three states are reachable in one plan.
      const planAdGroups = [
        {
          name: "Core services — real data", intent: "commercial", keywordCount: 6,
          keywordSample: ["seo audit tools", "seo audit checklist", "technical seo checklist"],
          provenance: { providers: ["dataforseo"], simulatedCount: 0, realCount: 6, unpulledCount: 0 },
        },
        {
          name: "Consulting — mixed vendors", intent: "commercial", keywordCount: 5,
          keywordSample: ["local seo services", "seo consultant", "enterprise seo platform"],
          provenance: { providers: ["ahrefs", "dataforseo"], simulatedCount: 2, realCount: 2, unpulledCount: 1 },
        },
        {
          name: "Emerging — not yet pulled", intent: "informational", keywordCount: 3,
          keywordSample: ["ai overview optimization", "geo for local business"],
          provenance: { providers: [], simulatedCount: 0, realCount: 0, unpulledCount: 3 },
        },
      ];
      const adGroups = planAdGroups.map((g) => {
        const adGroupId = genDemoId("sm-ag");
        const clusterId = genDemoId("sm-cluster");
        store.adGroups.push({ id: adGroupId, campaignId, name: g.name, clusterId, externalId: null, created_at: now, updated_at: now });
        return {
          id: adGroupId, clusterId, name: g.name, intent: g.intent,
          keywordCount: g.keywordCount, keywordSample: g.keywordSample, provenance: g.provenance,
        };
      });
      saveSemStore(store);
      return {
        status: 201,
        json: { id: campaignId, keywordSetId: b.keywordSetId, adGroups, totalClusteredKeywords: 14, unclusteredSkipped: 0 },
      };
    }

    const campaignsMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/campaigns$/);
    if (campaignsMatch && m === "GET") {
      const store = loadSemStore();
      const status = url.searchParams.get("status");
      let rows = store.campaigns.filter((c) => c.engagementId === campaignsMatch[1]);
      if (status) rows = rows.filter((c) => c.status === status);
      return ok(rows);
    }
    if (campaignsMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { name?: string; platform?: string; objective?: string; budgetMinor?: number; currency?: string };
      if (!b.name) return { status: 400, json: { error: "name required" } };
      const store = loadSemStore();
      const id = genDemoId("sm-campaign");
      const now = new Date().toISOString();
      store.campaigns.push({
        id, engagementId: campaignsMatch[1], platform: b.platform ?? "google_ads", externalId: null,
        name: b.name, objective: b.objective ?? null, status: "draft", budgetMinor: b.budgetMinor ?? null,
        currency: b.currency ?? null, bidStrategy: null, targetCpaMinor: null, targetRoas: null,
        customFields: {}, created_at: now, updated_at: now,
      });
      saveSemStore(store);
      return { status: 201, json: { id } };
    }

    const campaignMatch = p.match(/\/modules\/search\/campaigns\/([^/]+)$/);
    if (campaignMatch && m === "GET") {
      const store = loadSemStore();
      const c = store.campaigns.find((x) => x.id === campaignMatch[1]);
      if (!c) return { status: 404, json: { error: "campaign not found" } };
      return ok(c);
    }
    if (campaignMatch && m === "PATCH") {
      const b = JSON.parse(body || "{}") as Record<string, unknown>;
      if (b.status && !["draft", "proposed"].includes(b.status as string)) {
        return { status: 400, json: { error: "status can only be set to draft|proposed here — live states require a live-ads sync (SM-20/25/26)" } };
      }
      const store = loadSemStore();
      const c = store.campaigns.find((x) => x.id === campaignMatch[1]);
      if (!c) return { status: 404, json: { error: "campaign not found" } };
      Object.assign(c, b, { updated_at: new Date().toISOString() });
      saveSemStore(store);
      return ok({ id: c.id });
    }
    if (campaignMatch && m === "DELETE") {
      const store = loadSemStore();
      const before = store.campaigns.length;
      store.campaigns = store.campaigns.filter((x) => x.id !== campaignMatch[1]);
      if (store.campaigns.length === before) return { status: 404, json: { error: "campaign not found" } };
      saveSemStore(store);
      return ok({ ok: true });
    }

    const adGroupsMatch = p.match(/\/modules\/search\/campaigns\/([^/]+)\/ad-groups$/);
    if (adGroupsMatch && m === "GET") {
      const store = loadSemStore();
      return ok(store.adGroups.filter((g) => g.campaignId === adGroupsMatch[1]));
    }
    if (adGroupsMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { name?: string; clusterId?: string };
      if (!b.name) return { status: 400, json: { error: "name required" } };
      const store = loadSemStore();
      const id = genDemoId("sm-ag");
      const now = new Date().toISOString();
      store.adGroups.push({ id, campaignId: adGroupsMatch[1], name: b.name, clusterId: b.clusterId ?? null, externalId: null, created_at: now, updated_at: now });
      saveSemStore(store);
      return { status: 201, json: { id } };
    }

    const adGroupMatch = p.match(/\/modules\/search\/ad-groups\/([^/]+)$/);
    if (adGroupMatch && m === "GET") {
      const store = loadSemStore();
      const g = store.adGroups.find((x) => x.id === adGroupMatch[1]);
      if (!g) return { status: 404, json: { error: "ad group not found" } };
      return ok(g);
    }
    if (adGroupMatch && m === "DELETE") {
      const store = loadSemStore();
      const before = store.adGroups.length;
      store.adGroups = store.adGroups.filter((x) => x.id !== adGroupMatch[1]);
      if (store.adGroups.length === before) return { status: 404, json: { error: "ad group not found" } };
      saveSemStore(store);
      return ok({ ok: true });
    }

    const adsMatch = p.match(/\/modules\/search\/ad-groups\/([^/]+)\/ads$/);
    if (adsMatch && m === "GET") {
      const store = loadSemStore();
      return ok(store.ads.filter((a) => a.adGroupId === adsMatch[1]));
    }
    if (adsMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { headlines?: unknown[]; descriptions?: unknown[]; finalUrl?: string };
      const headlines = Array.isArray(b.headlines) ? b.headlines.filter((h): h is string => typeof h === "string" && h.trim().length > 0) : [];
      const descriptions = Array.isArray(b.descriptions) ? b.descriptions.filter((d): d is string => typeof d === "string" && d.trim().length > 0) : [];
      if (headlines.length === 0 || descriptions.length === 0) return { status: 400, json: { error: "at least one headline and one description required" } };
      const store = loadSemStore();
      const id = genDemoId("sm-ad");
      const now = new Date().toISOString();
      store.ads.push({ id, adGroupId: adsMatch[1], headlines, descriptions, finalUrl: b.finalUrl ?? null, status: "draft", aiGenerated: false, created_at: now, updated_at: now });
      saveSemStore(store);
      return { status: 201, json: { id } };
    }
    const draftAdMatch = p.match(/\/modules\/search\/ad-groups\/([^/]+)\/ads\/draft$/);
    if (draftAdMatch && m === "POST") {
      const store = loadSemStore();
      const adGroup = store.adGroups.find((g) => g.id === draftAdMatch[1]);
      if (!adGroup) return { status: 404, json: { error: "ad group not found" } };
      const id = genDemoId("sm-ad");
      const now = new Date().toISOString();
      const headlines = [`${adGroup.name} — Explore Options`, "Trusted By Growing Teams", "Get Started Today"];
      const descriptions = ["AI-drafted from this ad group's clustered keywords.", "Review before approving — nothing publishes automatically."];
      store.ads.push({ id, adGroupId: draftAdMatch[1], headlines, descriptions, finalUrl: null, status: "draft", aiGenerated: true, created_at: now, updated_at: now });
      saveSemStore(store);
      return { status: 201, json: { id, headlines, descriptions, draftedVia: "ai", model: "demo-mode" } };
    }

    const adMatch = p.match(/\/modules\/search\/ads\/([^/]+)$/);
    if (adMatch && m === "PATCH") {
      const b = JSON.parse(body || "{}") as { status?: string };
      if (b.status && !["draft", "approved", "rejected"].includes(b.status)) {
        return { status: 400, json: { error: "status must be draft|approved|rejected here — 'live' is set only by a live-ads sync" } };
      }
      const store = loadSemStore();
      const a = store.ads.find((x) => x.id === adMatch[1]);
      if (!a) return { status: 404, json: { error: "ad not found" } };
      if (b.status) a.status = b.status;
      a.updated_at = new Date().toISOString();
      saveSemStore(store);
      return ok({ id: a.id });
    }
    if (adMatch && m === "DELETE") {
      const store = loadSemStore();
      const before = store.ads.length;
      store.ads = store.ads.filter((x) => x.id !== adMatch[1]);
      if (store.ads.length === before) return { status: 404, json: { error: "ad not found" } };
      saveSemStore(store);
      return ok({ ok: true });
    }

    const negativesMatch = p.match(/\/modules\/search\/campaigns\/([^/]+)\/negatives$/);
    if (negativesMatch && m === "GET") {
      const store = loadSemStore();
      const status = url.searchParams.get("status");
      let rows = store.negatives.filter((n) => n.campaignId === negativesMatch[1]);
      if (status) rows = rows.filter((n) => n.status === status);
      return ok(rows);
    }
    if (negativesMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { term?: string; matchType?: string; adGroupId?: string };
      const term = b.term?.trim();
      if (!term) return { status: 400, json: { error: "term required" } };
      const store = loadSemStore();
      const id = genDemoId("sm-neg");
      const now = new Date().toISOString();
      store.negatives.push({ id, campaignId: negativesMatch[1], adGroupId: b.adGroupId ?? null, term, matchType: b.matchType ?? "exact", source: "manual", status: "proposed", created_at: now, updated_at: now });
      saveSemStore(store);
      return { status: 201, json: { id } };
    }
    const proposeMatch = p.match(/\/modules\/search\/campaigns\/([^/]+)\/negatives\/propose$/);
    if (proposeMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { text?: string };
      const terms = [...new Set((b.text ?? "").split("\n").map((t) => t.trim()).filter(Boolean))];
      if (terms.length === 0) return { status: 400, json: { error: "terms or text required (one search term per line, or a terms array)" } };
      const store = loadSemStore();
      const now = new Date().toISOString();
      const ids: string[] = [];
      for (const term of terms) {
        const id = genDemoId("sm-neg");
        store.negatives.push({ id, campaignId: proposeMatch[1], adGroupId: null, term, matchType: "broad", source: "ai", status: "proposed", created_at: now, updated_at: now });
        ids.push(id);
      }
      saveSemStore(store);
      return ok({
        proposed: ids.length, submitted: terms.length,
        candidates: terms.map((term) => ({ term, matchType: "broad", reason: "demo classification — not a real AI call" })),
        draftedVia: "ai", model: "demo-mode",
      });
    }

    const negativeMatch = p.match(/\/modules\/search\/negatives\/([^/]+)$/);
    if (negativeMatch && m === "PATCH") {
      const b = JSON.parse(body || "{}") as { status?: string; matchType?: string };
      if (b.status && !["proposed", "approved", "dismissed"].includes(b.status)) {
        return { status: 400, json: { error: "status can only be set to proposed|approved|dismissed here — 'applied' is stamped only by the manual/api execution flow (SM-30/21)" } };
      }
      const store = loadSemStore();
      const n = store.negatives.find((x) => x.id === negativeMatch[1]);
      if (!n) return { status: 404, json: { error: "negative not found" } };
      if (b.status) n.status = b.status;
      if (b.matchType) n.matchType = b.matchType;
      n.updated_at = new Date().toISOString();
      saveSemStore(store);
      return ok({ id: n.id });
    }
    if (negativeMatch && m === "DELETE") {
      const store = loadSemStore();
      const before = store.negatives.length;
      store.negatives = store.negatives.filter((x) => x.id !== negativeMatch[1]);
      if (store.negatives.length === before) return { status: 404, json: { error: "negative not found" } };
      saveSemStore(store);
      return ok({ ok: true });
    }

    const changeProposalsMatch = p.match(/\/modules\/search\/campaigns\/([^/]+)\/change-proposals$/);
    if (changeProposalsMatch && m === "GET") {
      const store = loadSemStore();
      const status = url.searchParams.get("status");
      let rows = store.changeProposals.filter((cp) => cp.campaignId === changeProposalsMatch[1]);
      if (status) rows = rows.filter((cp) => cp.status === status);
      return ok(rows);
    }
    if (changeProposalsMatch && m === "POST") {
      const b = JSON.parse(body || "{}") as { kind?: string; payload?: Record<string, unknown>; mode?: string };
      if (!b.kind) return { status: 400, json: { error: "kind must be one of launch|pause|budget|bid|negatives_batch|ads_batch" } };
      if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload)) return { status: 400, json: { error: "payload required (the exact intended change, as an object)" } };
      const store = loadSemStore();
      const id = genDemoId("sm-cp");
      const now = new Date().toISOString();
      store.changeProposals.push({
        id, campaignId: changeProposalsMatch[1], kind: b.kind, payload: b.payload, status: "proposed",
        mode: b.mode ?? "manual", approvalId: null, exportFileId: null, proposedBy: DEMO_USER_ID,
        approvedBy: null, appliedBy: null, appliedAt: null, created_at: now, updated_at: now,
      });
      saveSemStore(store);
      return { status: 201, json: { id } };
    }

    const changeProposalMatch = p.match(/\/modules\/search\/change-proposals\/([^/]+)$/);
    if (changeProposalMatch && m === "GET") {
      const store = loadSemStore();
      const cp = store.changeProposals.find((x) => x.id === changeProposalMatch[1]);
      if (!cp) return { status: 404, json: { error: "change proposal not found" } };
      return ok(cp);
    }
    if (changeProposalMatch && m === "PATCH") {
      const b = JSON.parse(body || "{}") as { status?: string };
      if (b.status === "applied") {
        return { status: 400, json: { error: "'applied' cannot be set here — it is stamped only by the manual mark-applied flow (SM-30) or api-mode execution (SM-21)" } };
      }
      const store = loadSemStore();
      const cp = store.changeProposals.find((x) => x.id === changeProposalMatch[1]);
      if (!cp) return { status: 404, json: { error: "change proposal not found" } };
      const transitions: Record<string, string[]> = { proposed: ["approved", "dismissed"], approved: ["dismissed"], dismissed: [], applied: [] };
      if (b.status && !(transitions[cp.status] ?? []).includes(b.status)) {
        return { status: 400, json: { error: `cannot move a '${cp.status}' proposal to '${b.status}'` } };
      }
      if (b.status) {
        cp.status = b.status;
        if (b.status === "approved") cp.approvedBy = DEMO_USER_ID;
      }
      cp.updated_at = new Date().toISOString();
      saveSemStore(store);
      return ok({ id: cp.id });
    }

    // ── SM-19: the manual-mode dual-mode twin (SM-30's backend routes) ─────────────────────────────
    // Mirrors search.controller.ts's own preconditions and error text (§4i discipline extended to
    // the demo dispatcher) so a demo session sees the SAME refusals a live backend would give.
    const exportMatch = p.match(/\/modules\/search\/change-proposals\/([^/]+)\/export$/);
    if (exportMatch && m === "POST") {
      const store = loadSemStore();
      const cp = store.changeProposals.find((x) => x.id === exportMatch[1]);
      if (!cp) return { status: 404, json: { error: "change proposal not found" } };
      if (cp.status !== "approved" && cp.status !== "applied") {
        return { status: 400, json: { error: `cannot export a '${cp.status}' proposal — export requires status='approved' (or 'applied', for a re-download)` } };
      }
      if (cp.mode !== "manual") {
        return { status: 400, json: { error: "this proposal is mode='api' — manual export is not available for it; it executes via the one-shot approval path (SM-21)" } };
      }
      // Only a 'launch' proposal is built from keyword metrics (sem-export.ts's own rule) — every
      // other kind carries no provenance, `null`, matching the real backend exactly. This demo
      // fixture does not attempt to derive a real per-cluster breakdown (SEM_STORE_SEED's ad groups
      // aren't linked to KEYWORD_STORE's clusters) — a fixed, clearly-mixed shape is used instead,
      // same "demo-only... not a stand-in for the real" convention as `demoProjectMonthlyCost`.
      const provenance = cp.kind === "launch"
        ? { providers: ["dataforseo", "ahrefs"], simulatedCount: 2, realCount: 3, unpulledCount: 1 }
        : null;
      const fileId = cp.exportFileId ?? genDemoId("sm-file");
      cp.exportFileId = fileId;
      cp.updated_at = new Date().toISOString();
      saveSemStore(store);
      const simulated = (provenance?.simulatedCount ?? 0) > 0;
      return {
        status: 201,
        json: {
          fileId, filename: `sem-${cp.kind}-${cp.id}${simulated ? "-SIMULATED" : ""}.csv`,
          contentType: "text/csv", byteSize: 256, provenance,
        },
      };
    }
    const markAppliedMatch = p.match(/\/modules\/search\/change-proposals\/([^/]+)\/mark-applied$/);
    if (markAppliedMatch && m === "POST") {
      const store = loadSemStore();
      const cp = store.changeProposals.find((x) => x.id === markAppliedMatch[1]);
      if (!cp) return { status: 404, json: { error: "change proposal not found" } };
      if (cp.mode !== "manual") {
        return { status: 400, json: { error: "this proposal is mode='api' — mark-applied is not available for it; it executes via the one-shot approval path (SM-21)" } };
      }
      if (cp.status !== "approved") {
        return { status: 400, json: { error: `cannot mark a '${cp.status}' proposal applied — it must be 'approved' first` } };
      }
      cp.status = "applied";
      cp.appliedBy = DEMO_USER_ID;
      cp.appliedAt = new Date().toISOString();
      cp.updated_at = cp.appliedAt;
      // Cascade, same as the real backend: negatives_batch/ads_batch stamp the referenced rows.
      const ids = Array.isArray(cp.payload.ids) ? (cp.payload.ids as unknown[]).filter((v): v is string => typeof v === "string") : [];
      if (cp.kind === "negatives_batch" && ids.length > 0) {
        for (const n of store.negatives) if (ids.includes(n.id) && n.status !== "dismissed") n.status = "applied";
      } else if (cp.kind === "ads_batch" && ids.length > 0) {
        for (const a of store.ads) if (ids.includes(a.id) && a.status === "approved") a.status = "live";
      }
      saveSemStore(store);
      return ok({ id: cp.id, status: "applied" as const });
    }

    // ── Rank tracking (SM-14) — the Rankings tab ──────────────────────────────────────────────────
    const rankPullMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/rank-pull$/);
    if (rankPullMatch && m === "POST") {
      const engagementId = rankPullMatch[1];
      const propertyId = DEMO_ENGAGEMENT_PROPERTY[engagementId];
      if (!propertyId) return { status: 404, json: { error: "engagement not found" } };
      const b = JSON.parse(body || "{}") as { keywordIds?: string[] };
      const { keywords } = loadKeywordStore();
      const engagementSetIds = new Set(loadKeywordStore().sets.filter((s) => s.engagementId === engagementId).map((s) => s.id));
      let tracked = keywords.filter((k) => engagementSetIds.has(k.setId) && k.isTracked);
      if (b.keywordIds?.length) tracked = tracked.filter((k) => b.keywordIds!.includes(k.id));
      const rankStore = loadRankStore();
      const results = tracked.map((k) => {
        const prior = rankStore.snapshots
          .filter((s) => s.keywordId === k.id && s.propertyId === propertyId)
          .sort((a, b2) => (a.capturedAt < b2.capturedAt ? 1 : -1))[0];
        // Deterministic demo "capture": nudge the prior position by 1 (or start at 6) — enough to
        // demonstrate a live re-pull without a real vendor call, never a random number (this module's
        // own standing rule: a demo figure must be reproducible, not merely plausible-looking).
        const position = prior?.position != null ? Math.max(1, prior.position - 1) : 6;
        const snap: DemoRankSnapshot = {
          id: genDemoId("sm-rank"), propertyId, keywordId: k.id, keyword: k.keyword,
          engine: "google", device: "desktop", locationCode: 2360, capturedAt: new Date().toISOString(),
          position, rankedUrl: "https://cedargroup.example.com/tools", serpFeatures: {},
          provider: "dataforseo", simulated: demoProviderMode(engagementId) === "simulate",
        };
        rankStore.snapshots.push(snap);
        const dropped = prior ? (prior.position !== null && (position === null || position > prior.position)) : false;
        return { keywordId: k.id, keyword: k.keyword, status: "pulled" as const, position, rankedUrl: snap.rankedUrl, provider: snap.provider, simulated: snap.simulated, dropped, previousPosition: prior?.position ?? null };
      });
      saveRankStore(rankStore);
      return ok({ engagementId, propertyId, attempted: tracked.length, pulled: results.length, skipped: 0, failed: 0, results });
    }
    const metricsPullMatch = p.match(/\/modules\/search\/keyword-sets\/([^/]+)\/metrics-pull$/);
    if (metricsPullMatch && m === "POST") {
      const setId = metricsPullMatch[1];
      const store = loadKeywordStore();
      if (!store.sets.some((s) => s.id === setId)) return { status: 404, json: { error: "keyword set not found" } };
      const b = JSON.parse(body || "{}") as { keywordIds?: string[] };
      let members = store.keywords.filter((k) => k.setId === setId);
      if (b.keywordIds?.length) members = members.filter((k) => b.keywordIds!.includes(k.id));
      const engagementId = store.sets.find((s) => s.id === setId)!.engagementId;
      const simulated = demoProviderMode(engagementId) === "simulate";
      const results = members.map((k) => {
        // Absent stays absent (AC3): a keyword with no volume ever pulled deterministically returns
        // "absent" here rather than fabricating a first value — matches rank.ts's own AC3 disposition
        // for a provider response with nothing for that query.
        if (k.volume === null && k.hasEmbedding === false && k.difficulty === null) {
          return { keywordId: k.id, keyword: k.keyword, status: "absent" as const };
        }
        const volume = (k.volume ?? 100) + 10;
        k.volume = volume; k.difficulty = String((Number(k.difficulty ?? "30") + 1).toFixed(2)); k.cpcUsd = k.cpcUsd ?? "2.500000";
        k.metricsProvider = "semrush"; k.metricsSimulated = simulated;
        return { keywordId: k.id, keyword: k.keyword, status: "updated" as const, volume, difficulty: Number(k.difficulty), cpcUsd: Number(k.cpcUsd), provider: "semrush", simulated };
      });
      saveKeywordStore(store);
      const updated = results.filter((r) => r.status === "updated").length;
      const absent = results.filter((r) => r.status === "absent").length;
      return ok({ attempted: members.length, updated, absent, skipped: 0, failed: 0, results });
    }
    const rankSnapshotsMatch = p.match(/\/modules\/search\/properties\/([^/]+)\/rank-snapshots$/);
    if (rankSnapshotsMatch && m === "GET") {
      const propertyId = rankSnapshotsMatch[1];
      const keywordId = url.searchParams.get("keywordId");
      const engine = url.searchParams.get("engine");
      const device = url.searchParams.get("device");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
      let rows = loadRankStore().snapshots.filter((s) => s.propertyId === propertyId);
      if (keywordId) rows = rows.filter((s) => s.keywordId === keywordId);
      if (engine) rows = rows.filter((s) => s.engine === engine);
      if (device) rows = rows.filter((s) => s.device === device);
      rows = rows.slice().sort((a, b2) => (a.capturedAt < b2.capturedAt ? 1 : -1)).slice(0, limit);
      return ok(rows);
    }

    // ── Google OAuth connections (SM-25a) — the Connections tab's Google section ──────────────────
    const googleAuthorizeMatch = p.match(/\/modules\/search\/google\/connections\/([^/]+)\/authorize$/);
    if (googleAuthorizeMatch && m === "POST") {
      const provider = googleAuthorizeMatch[1];
      if (!["google_search_console", "google_analytics", "google_ads"].includes(provider)) {
        return { status: 400, json: { error: "provider must be one of google_search_console|google_analytics|google_ads" } };
      }
      const b = JSON.parse(body || "{}") as { clientId?: string; propertyId?: string };
      if (!b.clientId) return { status: 400, json: { error: "clientId required" } };
      // Demo state is a PLAIN token, not signed — DEMO_MODE has no vault/HMAC key and this is not the
      // security surface under test here (search-google-oauth.controller.test.ts covers the real
      // signed-state attack surface against the live backend). The shape carries just enough for the
      // demo callback above to know which client/property to attach the new connection to.
      const state = `demo-state.${b.clientId}.${b.propertyId ?? "_"}`;
      return ok({
        authorizeUrl: `/api/search/google/callback?code=demo-code&state=${encodeURIComponent(state)}&provider=${provider}`,
        state, expiresAt: new Date(Date.now() + 600_000).toISOString(),
        issuerHost: "demo.gaiada.local", simulated: true,
        scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      });
    }
    if (p.match(/\/modules\/search\/google\/connections$/) && m === "GET") {
      const clientId = url.searchParams.get("clientId");
      // A revoked connection is NOT filtered out — `status` renders verbatim (matches the ledger's
      // own convention), so an operator can still see the dead link and re-connect rather than have
      // it vanish as though it never existed.
      const rows = loadGoogleStore().connections;
      return ok(clientId ? rows.filter((c) => c.clientId === clientId) : rows);
    }
    // `$`-anchored, so this never matches the `/authorize`, `/refresh` or `/revoke` sub-paths above.
    const googleConnGetMatch = p.match(/\/modules\/search\/google\/connections\/([^/]+)$/);
    if (googleConnGetMatch && m === "GET") {
      const conn = loadGoogleStore().connections.find((c) => c.id === googleConnGetMatch[1]);
      if (!conn) return { status: 404, json: { error: "connection not found" } };
      return ok(conn);
    }
    const googleRefreshMatch = p.match(/\/modules\/search\/google\/connections\/([^/]+)\/refresh$/);
    if (googleRefreshMatch && m === "POST") {
      const store = loadGoogleStore();
      const conn = store.connections.find((c) => c.id === googleRefreshMatch[1]);
      if (!conn) return { status: 404, json: { error: "connection not found" } };
      if (conn.status === "revoked" || !conn.hasRefreshToken) {
        return { status: 409, json: { error: "the Google connection is not usable (revoked) — re-link it to continue", code: "google_connection_not_linked" } };
      }
      conn.tokenExpiresAt = new Date(Date.now() + 3600_000).toISOString();
      saveGoogleStore(store);
      return ok(conn);
    }
    const googleRevokeMatch = p.match(/\/modules\/search\/google\/connections\/([^/]+)\/revoke$/);
    if (googleRevokeMatch && m === "POST") {
      const store = loadGoogleStore();
      const conn = store.connections.find((c) => c.id === googleRevokeMatch[1]);
      if (!conn) return { status: 404, json: { error: "connection not found" } };
      conn.status = "revoked"; conn.hasToken = false; conn.hasRefreshToken = false; conn.tokenExpiresAt = null;
      saveGoogleStore(store);
      return ok({ connection: conn, issuerRevoked: conn.issuerIsGoogle, issuerStatus: 200 });
    }
    const googleBindMatch = p.match(/\/modules\/search\/properties\/([^/]+)\/google-connection\/([^/]+)$/);
    if (googleBindMatch && m === "PUT") {
      const [, propertyId, provider] = googleBindMatch;
      const b = JSON.parse(body || "{}") as { connectionId?: string | null };
      const store = loadGoogleStore();
      if (b.connectionId && !store.connections.some((c) => c.id === b.connectionId)) {
        return { status: 404, json: { error: "connectionId not found in this tenant" } };
      }
      store.bindings[propertyId] = { ...(store.bindings[propertyId] ?? {}), [provider]: b.connectionId ?? null };
      saveGoogleStore(store);
      return ok({ propertyId, provider, connectionId: b.connectionId ?? null });
    }

    // ── GSC + GA4 read ingestion (SM-25b) — the Search Console & GA4 tab ─────────────────────────
    const gscPullMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/gsc-pull$/);
    if (gscPullMatch && m === "POST") {
      const engagementId = gscPullMatch[1];
      const propertyId = DEMO_ENGAGEMENT_PROPERTY[engagementId];
      if (!propertyId) return { status: 404, json: { error: "engagement not found" } };
      if (!DEMO_ENGAGEMENT_HAS_GOOGLE_CONNECTION[engagementId]) {
        return { status: 400, json: { error: "property has no Search Console connection bound — link one first", code: "google_property_not_bound" } };
      }
      const b = JSON.parse(body || "{}") as { startDate?: string; endDate?: string; rowLimit?: number; maxPages?: number };
      // Same clamp semantics as gsc-client.ts: an end date inside the 3-day freshness lag is pulled
      // back, disclosed rather than silently substituted. Demo "today" fixed at the fixture's own
      // seed date rather than the real clock, so the disclosure is reproducible across a session.
      const today = new Date("2026-07-30T00:00:00Z");
      const lagBoundary = new Date(today.getTime() - 3 * 86400_000).toISOString().slice(0, 10);
      const requestedEndDate = b.endDate ?? today.toISOString().slice(0, 10);
      const clamped = requestedEndDate > lagBoundary;
      const effectiveEndDate = clamped ? lagBoundary : requestedEndDate;
      const startDate = b.startDate ?? new Date(today.getTime() - 10 * 86400_000).toISOString().slice(0, 10);
      const store = loadGooglePerfStore();
      const gStore = loadGoogleStore();
      const conn = gStore.connections.find((c) => c.id === gStore.bindings[propertyId]?.google_search_console);
      const simulated = conn ? !conn.issuerIsGoogle : true;
      const row: DemoGscRow = {
        id: genDemoId("gsc"), propertyId, date: effectiveEndDate, query: "seo tools",
        page: "https://cedargroup.example.com/tools", device: "DESKTOP", clicks: 7, impressions: 150,
        ctr: 0.0467, position: 9.1, simulated, fetchedAt: new Date().toISOString(),
      };
      store.gsc.push(row);
      saveGooglePerfStore(store);
      return ok({
        propertyId, status: "pulled", startDate, requestedEndDate, effectiveEndDate,
        clampedForFreshness: clamped, freshnessLagDays: 3, rowsUpserted: 1, malformedRowsSkipped: 0,
        // Demo also demonstrates the truncation disclosure: a maxPages:1 request against >1 "page" of
        // demo data reports truncated:true, exactly like hitting GSC_DEFAULT_MAX_PAGES for real.
        pagesFetched: b.maxPages ?? 1, truncated: (b.maxPages ?? 4) === 1,
        provider: "google_search_console", connectionId: conn?.id ?? "conn-google-1", simulated,
      });
    }
    const ga4PullMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/ga4-pull$/);
    if (ga4PullMatch && m === "POST") {
      const engagementId = ga4PullMatch[1];
      const propertyId = DEMO_ENGAGEMENT_PROPERTY[engagementId];
      if (!propertyId) return { status: 404, json: { error: "engagement not found" } };
      if (!DEMO_ENGAGEMENT_HAS_GOOGLE_CONNECTION[engagementId]) {
        return { status: 400, json: { error: "property has no GA4 connection bound — link one first", code: "google_property_not_bound" } };
      }
      const b = JSON.parse(body || "{}") as { ga4PropertyId?: string; startDate?: string; endDate?: string };
      if (!b.ga4PropertyId) return { status: 400, json: { error: "ga4PropertyId required" } };
      const today = new Date("2026-07-30T00:00:00Z");
      const lagBoundary = new Date(today.getTime() - 2 * 86400_000).toISOString().slice(0, 10);
      const requestedEndDate = b.endDate ?? today.toISOString().slice(0, 10);
      const clamped = requestedEndDate > lagBoundary;
      const effectiveEndDate = clamped ? lagBoundary : requestedEndDate;
      const startDate = b.startDate ?? new Date(today.getTime() - 9 * 86400_000).toISOString().slice(0, 10);
      const gStore = loadGoogleStore();
      const conn = gStore.connections.find((c) => c.id === gStore.bindings[propertyId]?.google_analytics);
      const simulated = conn ? !conn.issuerIsGoogle : true;
      // Every pull's ENTIRE response is sampled or not together (a report-level GA4 fact) — this demo
      // pull deterministically reports sampled:true so the tab's per-row sampling disclosure is always
      // reachable from a fresh pull, not only from the pre-seeded ga4-2 row.
      const store = loadGooglePerfStore();
      const row: DemoGa4Row = {
        id: genDemoId("ga4"), propertyId, date: effectiveEndDate, channelGroup: "Organic Search",
        sessions: 120, engagedSessions: 80, conversions: 4, totalRevenue: 90, sampled: true,
        simulated, fetchedAt: new Date().toISOString(),
      };
      store.ga4.push(row);
      saveGooglePerfStore(store);
      return ok({
        propertyId, status: "pulled", startDate, requestedEndDate, effectiveEndDate,
        clampedForFreshness: clamped, freshnessLagDays: 2, rowsUpserted: 1, malformedRowsSkipped: 0,
        sampled: true, provider: "google_analytics", connectionId: conn?.id ?? "conn-google-2", simulated,
      });
    }
    const gscListMatch = p.match(/\/modules\/search\/properties\/([^/]+)\/gsc-performance$/);
    if (gscListMatch && m === "GET") {
      const propertyId = gscListMatch[1];
      const startDate = url.searchParams.get("startDate");
      const endDate = url.searchParams.get("endDate");
      const queryFilter = url.searchParams.get("query");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 5000);
      let rows = loadGooglePerfStore().gsc.filter((r) => r.propertyId === propertyId);
      if (startDate) rows = rows.filter((r) => r.date >= startDate);
      if (endDate) rows = rows.filter((r) => r.date <= endDate);
      if (queryFilter) rows = rows.filter((r) => r.query === queryFilter);
      rows = rows.slice().sort((a, b2) => (a.date < b2.date ? 1 : a.date > b2.date ? -1 : b2.clicks - a.clicks)).slice(0, limit);
      return ok(rows);
    }
    const gscTopQueriesMatch = p.match(/\/modules\/search\/properties\/([^/]+)\/gsc-performance\/top-queries$/);
    if (gscTopQueriesMatch && m === "GET") {
      const propertyId = gscTopQueriesMatch[1];
      const startDate = url.searchParams.get("startDate");
      const endDate = url.searchParams.get("endDate");
      if (!startDate || !endDate) return { status: 400, json: { error: "startDate and endDate required" } };
      const includeSimulated = url.searchParams.get("includeSimulated") === "1" || url.searchParams.get("includeSimulated") === "true";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 1000);
      const rows = loadGooglePerfStore().gsc.filter((r) => r.propertyId === propertyId && r.date >= startDate && r.date <= endDate && (includeSimulated || !r.simulated));
      const byQuery = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
      for (const r of rows) {
        const agg = byQuery.get(r.query) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
        agg.clicks += r.clicks; agg.impressions += r.impressions; agg.posWeighted += r.position * r.impressions;
        byQuery.set(r.query, agg);
      }
      const out = [...byQuery.entries()]
        .map(([query, a]) => ({ query, clicks: a.clicks, impressions: a.impressions, ctr: a.impressions > 0 ? a.clicks / a.impressions : null, position: a.impressions > 0 ? a.posWeighted / a.impressions : null }))
        .sort((a, b2) => b2.clicks - a.clicks)
        .slice(0, limit);
      return ok(out);
    }
    const gscKeywordImportMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/gsc-keyword-import$/);
    if (gscKeywordImportMatch && m === "POST") {
      const engagementId = gscKeywordImportMatch[1];
      const propertyId = DEMO_ENGAGEMENT_PROPERTY[engagementId];
      if (!propertyId) return { status: 404, json: { error: "engagement not found" } };
      const b = JSON.parse(body || "{}") as { setId?: string; name?: string; startDate?: string; endDate?: string; minClicks?: number; limit?: number; locale?: string };
      if (!b.startDate || !b.endDate) return { status: 400, json: { error: "startDate and endDate required" } };
      const rows = loadGooglePerfStore().gsc.filter((r) => r.propertyId === propertyId && r.date >= b.startDate! && r.date <= b.endDate! && !r.simulated);
      const minClicks = b.minClicks ?? 0;
      const candidates = [...new Set(rows.filter((r) => r.clicks >= minClicks).map((r) => r.query))];
      const kwStore = loadKeywordStore();
      let setId = b.setId ?? null;
      if (setId && !kwStore.sets.some((s) => s.id === setId && s.engagementId === engagementId)) {
        return { status: 400, json: { error: "setId does not belong to engagementId" } };
      }
      if (!setId) {
        setId = genDemoId("sm-set");
        kwStore.sets.push({ id: setId, engagementId, name: b.name || `GSC import ${b.startDate}..${b.endDate}`, source: "gsc", createdAt: new Date().toISOString() });
      }
      const existing = kwStore.keywords.filter((k) => k.setId === setId);
      const locale = b.locale || "id-ID";
      let imported = 0;
      for (const query of candidates) {
        if (existing.some((k) => k.keyword.toLowerCase() === query.toLowerCase() && k.locale === locale)) continue;
        kwStore.keywords.push({
          id: genDemoId("sm-kw"), setId, keyword: query, locale, intent: null, clusterId: null, clusterLabel: null,
          volume: null, difficulty: null, cpcUsd: null, metricsProvider: null, metricsSimulated: false,
          isTracked: false, hasEmbedding: false, createdAt: new Date().toISOString(),
        });
        imported++;
      }
      saveKeywordStore(kwStore);
      return ok({ setId, imported, submitted: candidates.length, considered: rows.length, duplicates: candidates.length - imported });
    }
    const ga4ListMatch = p.match(/\/modules\/search\/properties\/([^/]+)\/ga4-metrics$/);
    if (ga4ListMatch && m === "GET") {
      const propertyId = ga4ListMatch[1];
      const startDate = url.searchParams.get("startDate");
      const endDate = url.searchParams.get("endDate");
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 5000);
      let rows = loadGooglePerfStore().ga4.filter((r) => r.propertyId === propertyId);
      if (startDate) rows = rows.filter((r) => r.date >= startDate);
      if (endDate) rows = rows.filter((r) => r.date <= endDate);
      rows = rows.slice().sort((a, b2) => (a.date < b2.date ? 1 : -1)).slice(0, limit);
      return ok(rows);
    }

    // SM-22 — client-facing reports. File-backed store (same rationale as the SEM/keyword stores
    // above: a POST/PATCH in a server-action chunk must be visible to a GET in the page-render
    // chunk). sm-report-1 demos the FULL delivered lifecycle (real data, a linked deliverable via
    // sm-eng-1's own p-seo-1 project — see ENGAGEMENTS above); sm-report-2 demos the in_review state
    // with a MIXED real/simulated banner, so the honesty disclosure is reachable without a live
    // backend. Preview markdown here is a SEPARATE, deliberately simplified rendering (not a call
    // into reports.ts's renderReportMarkdown, which is a platform-nest-only module this UI project
    // cannot import) — it exists only to prove the console's preview pane renders SOMETHING
    // structurally shaped like the real markdown, same posture as every other demo fixture in this
    // file (static/derived data, never the production code path).
    const reportsListMatch = p.match(/\/modules\/search\/engagements\/([^/]+)\/reports$/);
    if (reportsListMatch && m === "GET") {
      const engagementId = reportsListMatch[1];
      const rows = loadReportsStore().reports.filter((r) => r.engagementId === engagementId)
        .slice().sort((a, b2) => (a.created_at < b2.created_at ? 1 : -1));
      return ok(rows);
    }
    if (reportsListMatch && m === "POST") {
      const engagementId = reportsListMatch[1];
      if (!DEMO_ENGAGEMENT_PROPERTY[engagementId]) return { status: 404, json: { error: "engagement not found" } };
      const b = JSON.parse(body || "{}") as { period?: string; kind?: string };
      if (!b.period) return { status: 400, json: { error: "period required" } };
      const kind = b.kind ?? "monthly";
      const store = loadReportsStore();
      const existing = store.reports.find((r) => r.engagementId === engagementId && r.period === b.period && r.kind === kind);
      if (existing && existing.status !== "draft") {
        return { status: 400, json: { error: `report ${existing.id} is already '${existing.status}' — cannot re-draft past 'draft'` } };
      }
      const now = new Date().toISOString();
      const narrativeMd = `## ${b.period} summary (demo draft)\n- Keywords ranking top-10: 5\n- Open critical audit findings: 0`;
      if (existing) {
        existing.narrativeMd = narrativeMd; existing.updated_at = now;
      } else {
        store.reports.push({
          id: genDemoId("sm-report"), engagementId, period: b.period, kind, status: "draft",
          metrics: { rankTop10: 5, criticalFindingsOpen: 0, kpiTargets: [] },
          narrativeMd, fileId: null, deliverableId: null, approvedBy: null, approvedAt: null, deliveredAt: null,
          created_at: now, updated_at: now,
        });
      }
      saveReportsStore(store);
      const row = store.reports.find((r) => r.engagementId === engagementId && r.period === b.period && r.kind === kind)!;
      return { status: 201, json: { id: row.id, engagementId, period: b.period, kind, status: "draft", metrics: row.metrics, narrativeMd, draftedVia: "fallback", model: null } };
    }
    const reportDetailMatch = p.match(/\/modules\/search\/reports\/([^/]+)$/);
    if (reportDetailMatch && m === "GET") {
      const row = loadReportsStore().reports.find((r) => r.id === reportDetailMatch[1]);
      if (!row) return { status: 404, json: { error: "report not found" } };
      return ok(row);
    }
    if (reportDetailMatch && m === "PATCH") {
      const store = loadReportsStore();
      const row = store.reports.find((r) => r.id === reportDetailMatch[1]);
      if (!row) return { status: 404, json: { error: "report not found" } };
      const b = JSON.parse(body || "{}") as { narrativeMd?: string; status?: string };
      if (b.status !== undefined) {
        if (b.status === "in_review") {
          if (row.status !== "draft") return { status: 400, json: { error: `cannot submit for review from '${row.status}'` } };
          row.status = "in_review";
        } else if (b.status === "draft") {
          if (row.status !== "in_review") return { status: 400, json: { error: `cannot send back to draft from '${row.status}'` } };
          row.status = "draft";
        } else {
          return { status: 400, json: { error: "status must be 'in_review' or 'draft'" } };
        }
      }
      if (b.narrativeMd !== undefined) row.narrativeMd = b.narrativeMd;
      row.updated_at = new Date().toISOString();
      saveReportsStore(store);
      return ok({ id: row.id, status: row.status });
    }
    const reportApproveMatch = p.match(/\/modules\/search\/reports\/([^/]+)\/approve$/);
    if (reportApproveMatch && m === "POST") {
      const store = loadReportsStore();
      const row = store.reports.find((r) => r.id === reportApproveMatch[1]);
      if (!row) return { status: 404, json: { error: "report not found" } };
      if (row.status !== "in_review") return { status: 400, json: { error: `cannot approve a '${row.status}' report — approval requires status='in_review'` } };
      row.status = "approved"; row.approvedBy = DEMO_USER_ID; row.approvedAt = new Date().toISOString(); row.updated_at = row.approvedAt;
      saveReportsStore(store);
      return ok({ id: row.id, status: "approved" });
    }
    const reportPreviewMatch = p.match(/\/modules\/search\/reports\/([^/]+)\/preview$/);
    if (reportPreviewMatch && m === "GET") {
      const row = loadReportsStore().reports.find((r) => r.id === reportPreviewMatch[1]);
      if (!row) return { status: 404, json: { error: "report not found" } };
      return ok(demoReportPreview(row));
    }
    const reportDeliverMatch = p.match(/\/modules\/search\/reports\/([^/]+)\/deliver$/);
    if (reportDeliverMatch && m === "POST") {
      const store = loadReportsStore();
      const row = store.reports.find((r) => r.id === reportDeliverMatch[1]);
      if (!row) return { status: 404, json: { error: "report not found" } };
      if (row.status !== "approved") return { status: 400, json: { error: `cannot deliver a '${row.status}' report — delivery requires status='approved'` } };
      const preview = demoReportPreview(row);
      row.status = "delivered"; row.fileId = genDemoId("demo-file"); row.deliverableId = genDemoId("dl");
      row.deliveredAt = new Date().toISOString(); row.updated_at = row.deliveredAt;
      saveReportsStore(store);
      return ok({
        id: row.id, status: "delivered", fileId: row.fileId, filename: preview.filename,
        deliverableId: row.deliverableId, anySimulated: preview.anySimulated, allSimulated: preview.allSimulated,
      });
    }

    // Anything else under /modules/search/* (briefs, ai-visibility, pacing/metrics-daily) is
    // deliberately left unhandled so it falls through to the 404 default just below — those tabs
    // are NOT BUILT and must show BackendPending, not a demo-faked "empty" list. Rankings (SM-14)
    // and the Google connections/GSC/GA4 routes (SM-25a/SM-25b) are handled above, now that both are
    // real, wired tabs.
    if (m === "GET") return { status: 404, json: { error: "not implemented in demo fixtures" } };
  }

  // Anything else (comments, files, notifications, clients, deliverables,
  // time-entries, dev-only routes): safe empty-list default for GET, generic
  // success for writes — these aren't the focus of a visual UI pass.
  if (m === "GET") return ok([]);
  if (m === "POST") return { status: 201, json: { id: `demo-${Date.now()}`, ok: true } };
  return ok({ ok: true });
}

export const DEMO_USER = { id: DEMO_USER_ID };
