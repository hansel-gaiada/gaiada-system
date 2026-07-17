import "server-only";
// TEMP DEMO MODE — lets someone browse every page with realistic fake data
// and NO backend running at all. Active only when process.env.DEMO_MODE==="1".
// Not part of any plan task; safe to delete once the real backend is up.
// Single entry point: platformFetch() calls getDemoResponse() before ever
// touching the network when demo mode is on.

import { pmDemo, allTrackerNotifications } from "./demoPm";

export interface DemoResult {
  status: number;
  json: unknown;
}

const DEMO_USER_ID = "demo-hansel";

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
    { role: "group_executive", scopeType: "global", scopeId: null },
  ],
};

const MEMBERS: Record<string, { user_id: string; name: string; email: string; title: string | null }[]> = {
  "co-holding": [
    { user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" },
    { user_id: "u-finance", name: "Rina Wibawa", email: "rina@gaiada.com", title: "Finance Lead" },
  ],
  "co-agency": [
    { user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" },
    { user_id: "u-pm", name: "Dewi Santoso", email: "dewi@gaiada.com", title: "Account Manager" },
    { user_id: "u-dev", name: "Made Putra", email: "made@gaiada.com", title: "Web Developer" },
  ],
  "co-resort": [{ user_id: DEMO_USER_ID, name: "Clement Hansel", email: "hansel@gaiada.com", title: "AI Manager" }],
};

const PROJECTS: Record<string, unknown[]> = {
  "co-holding": [
    { id: "p-hr-1", name: "HR system rollout", status: "active", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, due_date: "2026-08-15", custom_fields: {} },
    { id: "p-fin-1", name: "FY26 budget review", status: "on_hold", client_id: null, is_internal: true, owner_id: "u-finance", due_date: "2026-07-30", custom_fields: {} },
  ],
  "co-agency": [
    { id: "p-web-1", name: "Client site redesign", status: "active", client_id: "cl-1", is_internal: false, owner_id: "u-pm", due_date: "2026-07-20", custom_fields: { phase: "build" } },
    { id: "p-seo-1", name: "SEO audit — Q3", status: "active", client_id: "cl-2", is_internal: false, owner_id: "u-pm", due_date: "2026-08-01", custom_fields: { phase: "discovery" } },
    { id: "p-int-1", name: "Internal brand refresh", status: "completed", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, due_date: "2026-06-01", custom_fields: {} },
  ],
  "co-resort": [],
};

const PROJECT_DETAIL_EXTRA: Record<string, { client_name: string | null; owner_name: string | null; start_date: string | null }> = {
  "p-hr-1": { client_name: null, owner_name: "Clement Hansel", start_date: "2026-05-01" },
  "p-fin-1": { client_name: null, owner_name: "Rina Wibawa", start_date: "2026-04-01" },
  "p-web-1": { client_name: "Northwind Traders", owner_name: "Dewi Santoso", start_date: "2026-06-01" },
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
  "p-int-1": [],
};
const ALL_TASKS = Object.values(TASKS).flat();

const CUSTOM_FIELDS: Record<string, unknown[]> = {
  project: [
    { key: "phase", label: "Phase", data_type: "text", options: [], required: false },
    { key: "tier", label: "Account tier", data_type: "select", options: ["a", "b", "c"], required: false },
  ],
  task: [{ key: "severity", label: "Severity", data_type: "select", options: ["low", "high"], required: false }],
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

const ACTIVITY = [
  { id: "a-1", actor_id: "u-pm", actor_name: "Dewi Santoso", verb: "created", target_entity_type: "agency_brief", target_entity_id: "b-2", occurred_at: "2026-07-05T09:00:00Z", metadata: {} },
  { id: "a-2", actor_id: "u-dev", actor_name: "Made Putra", verb: "updated", target_entity_type: "task", target_entity_id: "t-5", occurred_at: "2026-07-05T08:30:00Z", metadata: {} },
  { id: "a-3", actor_id: DEMO_USER_ID, actor_name: "Clement Hansel", verb: "approved", target_entity_type: "agency_approval", target_entity_id: "ap-0", occurred_at: "2026-07-04T16:00:00Z", metadata: {} },
  { id: "a-4", actor_id: "u-finance", actor_name: "Rina Wibawa", verb: "updated", target_entity_type: "project", target_entity_id: "p-fin-1", occurred_at: "2026-07-03T14:00:00Z", metadata: {} },
];

const NOTIFICATIONS = [
  { id: "n-1", type: "approval.requested", payload: { title: "Approval requested", message: "Ad spend increase — 20% on Q3 lead-gen push is waiting for your decision.", href: "/approvals" }, read_at: null, created_at: "2026-07-05T08:10:00Z" },
  { id: "n-2", type: "comment.mention", payload: { title: "Dewi mentioned you", message: "“@Hansel can you confirm the launch date on the client site redesign?”", href: "/tasks/t-4" }, read_at: null, created_at: "2026-07-04T15:40:00Z" },
  { id: "n-3", type: "task.assigned", payload: { title: "Task assigned to you", message: "Keyword gap analysis on SEO audit — Q3.", href: "/tasks/t-6" }, read_at: null, created_at: "2026-07-04T09:05:00Z" },
  { id: "n-4", type: "brief.approved", payload: { title: "Brief approved", message: "Landing page copy brief was approved.", href: "/agency" }, read_at: "2026-07-03T12:00:00Z", created_at: "2026-07-03T11:30:00Z" },
  { id: "n-5", type: "project.updated", payload: { title: "Project updated", message: "FY26 budget review moved to On hold.", href: "/projects/p-fin-1" }, read_at: "2026-07-03T10:00:00Z", created_at: "2026-07-03T09:50:00Z" },
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
  gateway: [
    { key: "providers", label: "Provider chain", value: "ollama,gemini,claude", kind: "text", editable: true },
    { key: "dailyCostCap", label: "Daily cost cap (USD)", value: 50, kind: "number", editable: true },
    { key: "dlpEnabled", label: "DLP scrubbing", value: true, kind: "boolean", editable: true },
    { key: "openaiApiKey", label: "OpenAI API key", value: false, kind: "secretPresence", editable: false },
    { key: "anthropicApiKey", label: "Anthropic API key", value: true, kind: "secretPresence", editable: false },
  ],
  hub: [{ key: "visibilityPolicy", label: "Tool visibility policy", value: "per-principal", kind: "text", editable: false }],
  agents: [],
  knowledge: [],
  automation: [],
};

const EGRESS_AUDIT = [
  { time: "2026-07-05T09:00:00Z", provider: "gemini", decision: "allowed", detail: "chat completion" },
  { time: "2026-07-05T08:50:00Z", provider: "claude", decision: "allowed", detail: "summarize" },
];
const HUB_TOOLS = [
  { name: "projects.list", description: "List the tenant's projects with status", minAssurance: "low" },
  { name: "agency.pendingApprovals", description: "Approvals waiting for a decision", minAssurance: "low" },
];
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

function tenantFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/([^/]+)\//);
  return m ? m[1] : null;
}

function ok(json: unknown): DemoResult {
  return { status: 200, json };
}

export function getDemoResponse(method: string, fullPath: string, body?: string): DemoResult {
  const url = new URL(fullPath, "http://demo");
  const p = url.pathname;
  const m = method.toUpperCase();

  // PM surface + task comments — stateful in-memory store (lib/demoPm.ts).
  const pm = pmDemo(method, p, url.searchParams, body);
  if (pm) return pm;

  // /api/me reflects the (mutable) company set so newly-created companies appear.
  if (p === "/api/me") return ok({ ...ME, companies: COMPANIES.map((c) => ({ id: c.id, name: c.name, type: c.type })) });
  if (p === "/api/companies") {
    if (m === "POST") {
      const b = JSON.parse(body || "{}");
      const co = { id: demoId("co"), name: String(b.name ?? "New company"), type: (b.type as string) ?? null, enabled_modules: Array.isArray(b.modules) ? b.modules : [], status: "active", parent_company_id: (b.parentCompanyId as string) ?? "co-holding" };
      COMPANIES.push(co);
      return { status: 201, json: { id: co.id } };
    }
    return ok(COMPANIES);
  }
  const companyPatch = p.match(/^\/api\/companies\/([^/]+)$/);
  if (companyPatch && m === "PATCH") {
    const co = COMPANIES.find((c) => c.id === companyPatch[1]);
    if (co) {
      const b = JSON.parse(body || "{}");
      if (b.name != null) co.name = b.name;
      if (b.type !== undefined) co.type = b.type;
      if (b.status != null) co.status = b.status;
      if (b.parentCompanyId !== undefined) co.parent_company_id = b.parentCompanyId;
      if (Array.isArray(b.modules)) co.enabled_modules = b.modules;
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
    return ok({ id, name: "New project", status: "active", client_id: null, is_internal: true, owner_id: DEMO_USER_ID, due_date: null, custom_fields: {}, ...extra });
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
  if (p === "/api/admin/gateway/egress-audit") return ok(EGRESS_AUDIT);
  if (p === "/api/admin/hub/tools") return ok(HUB_TOOLS);
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

  // Anything else (comments, files, notifications, clients, deliverables,
  // time-entries, dev-only routes): safe empty-list default for GET, generic
  // success for writes — these aren't the focus of a visual UI pass.
  if (m === "GET") return ok([]);
  if (m === "POST") return { status: 201, json: { id: `demo-${Date.now()}`, ok: true } };
  return ok({ ok: true });
}

export const DEMO_USER = { id: DEMO_USER_ID };
