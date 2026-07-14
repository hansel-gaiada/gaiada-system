import "server-only";
// TEMP DEMO MODE — lets someone browse every page with realistic fake data
// and NO backend running at all. Active only when process.env.DEMO_MODE==="1".
// Not part of any plan task; safe to delete once the real backend is up.
// Single entry point: platformFetch() calls getDemoResponse() before ever
// touching the network when demo mode is on.

export interface DemoResult {
  status: number;
  json: unknown;
}

const DEMO_USER_ID = "demo-hansel";

const COMPANIES = [
  { id: "co-holding", name: "Gaiada Holding", type: "holding", enabled_modules: [], status: "active" },
  {
    id: "co-agency",
    name: "Gaiada Agency",
    type: "agency",
    enabled_modules: ["agency"],
    status: "active",
    parent_company_id: "co-holding",
  },
  {
    id: "co-resort",
    name: "Gaiada Resort",
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
  companies: COMPANIES.map((c) => ({ id: c.id, name: c.name, type: c.type })),
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
  { id: "ap-1", subject: "Landing page copy brief", campaign: "Q3 lead-gen push", created_at: "2026-07-04T10:00:00Z" },
  { id: "ap-2", subject: "Ad spend increase — 20%", campaign: "Q3 lead-gen push", created_at: "2026-07-05T08:00:00Z" },
];

const ACTIVITY = [
  { id: "a-1", actor_id: "u-pm", actor_name: "Dewi Santoso", verb: "created", target_entity_type: "agency_brief", target_entity_id: "b-2", occurred_at: "2026-07-05T09:00:00Z", metadata: {} },
  { id: "a-2", actor_id: "u-dev", actor_name: "Made Putra", verb: "updated", target_entity_type: "task", target_entity_id: "t-5", occurred_at: "2026-07-05T08:30:00Z", metadata: {} },
  { id: "a-3", actor_id: DEMO_USER_ID, actor_name: "Clement Hansel", verb: "approved", target_entity_type: "agency_approval", target_entity_id: "ap-0", occurred_at: "2026-07-04T16:00:00Z", metadata: {} },
  { id: "a-4", actor_id: "u-finance", actor_name: "Rina Wibawa", verb: "updated", target_entity_type: "project", target_entity_id: "p-fin-1", occurred_at: "2026-07-03T14:00:00Z", metadata: {} },
];

const NOTIFICATIONS = [
  { id: "n-1", type: "approval.requested", payload: { title: "Approval requested", message: "Ad spend increase — 20% on Q3 lead-gen push is waiting for your decision." }, read_at: null, created_at: "2026-07-05T08:10:00Z" },
  { id: "n-2", type: "comment.mention", payload: { title: "Dewi mentioned you", message: "“@Hansel can you confirm the launch date on the client site redesign?”" }, read_at: null, created_at: "2026-07-04T15:40:00Z" },
  { id: "n-3", type: "task.assigned", payload: { title: "Task assigned to you", message: "Keyword gap analysis on SEO audit — Q3." }, read_at: null, created_at: "2026-07-04T09:05:00Z" },
  { id: "n-4", type: "brief.approved", payload: { title: "Brief approved", message: "Landing page copy brief was approved." }, read_at: "2026-07-03T12:00:00Z", created_at: "2026-07-03T11:30:00Z" },
  { id: "n-5", type: "project.updated", payload: { title: "Project updated", message: "FY26 budget review moved to On hold." }, read_at: "2026-07-03T10:00:00Z", created_at: "2026-07-03T09:50:00Z" },
];

const ROLLUPS = [
  { tenant_id: "co-agency", company: "Gaiada Agency", module: "agency", metric_key: "agency.campaigns.active", numerator: 1, denominator: null, currency: null, period: "2026-07-05" },
  { tenant_id: "co-agency", company: "Gaiada Agency", module: "agency", metric_key: "agency.approvals.pending", numerator: 2, denominator: null, currency: null, period: "2026-07-05" },
  { tenant_id: "co-resort", company: "Gaiada Resort", module: "core", metric_key: "core.tasks.done_ratio", numerator: 4, denominator: 10, currency: null, period: "2026-07-05" },
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

const USERS = [
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
const TIME_ENTRIES = [
  { id: "te-1", user_id: DEMO_USER_ID, project_id: "p-hr-1", task_id: "t-1", minutes: 150, billable: false, entry_date: "2026-07-05", notes: "Onboarding flow draft" },
  { id: "te-2", user_id: DEMO_USER_ID, project_id: "p-seo-1", task_id: "t-6", minutes: 90, billable: true, entry_date: "2026-07-04", notes: "Keyword research" },
  { id: "te-3", user_id: "u-dev", project_id: "p-web-1", task_id: "t-4", minutes: 240, billable: true, entry_date: "2026-07-05", notes: "Homepage hero" },
  { id: "te-4", user_id: "u-dev", project_id: "p-web-1", task_id: "t-5", minutes: 180, billable: true, entry_date: "2026-07-04", notes: "Checkout QA" },
  { id: "te-5", user_id: "u-finance", project_id: "p-fin-1", task_id: "t-3", minutes: 120, billable: false, entry_date: "2026-06-25", notes: "Q2 reconciliation" },
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

function tenantFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/api\/([^/]+)\//);
  return m ? m[1] : null;
}

function ok(json: unknown): DemoResult {
  return { status: 200, json };
}

export function getDemoResponse(method: string, fullPath: string): DemoResult {
  const url = new URL(fullPath, "http://demo");
  const p = url.pathname;
  const m = method.toUpperCase();

  if (p === "/api/me") return ok(ME);
  if (p === "/api/companies") return ok(COMPANIES);
  if (p === "/api/rollups") return ok(ROLLUPS);
  if (p.match(/^\/api\/[^/]+\/rollups\/recompute$/) && m === "POST") return ok({ period: "2026-07-05", written: ROLLUPS.length });

  if (p.match(/^\/api\/[^/]+\/members$/)) return ok(MEMBERS[tenantFromPath(p)!] ?? []);
  if (p.match(/^\/api\/[^/]+\/activity$/)) return ok(ACTIVITY);

  // Notifications (bell badge + /notifications page). Tenant-independent in demo.
  if (p.match(/^\/api\/[^/]+\/notifications$/)) {
    if (m === "POST") return ok({ ok: true }); // mark-all-read
    const unreadOnly = url.searchParams.get("unread") === "true";
    return ok(unreadOnly ? NOTIFICATIONS.filter((n) => !n.read_at) : NOTIFICATIONS);
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
    const uid = url.searchParams.get("userId");
    const mine = url.searchParams.get("mine") === "me";
    const rows = mine
      ? TIME_ENTRIES.filter((e) => e.user_id === DEMO_USER_ID)
      : uid
        ? TIME_ENTRIES.filter((e) => e.user_id === uid)
        : TIME_ENTRIES;
    return ok(rows);
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
  const decideMatch = p.match(/^\/api\/[^/]+\/modules\/agency\/approvals\/([^/]+)\/decide$/);
  if (decideMatch && m === "POST") return ok({ id: decideMatch[1], status: "approved" });

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
  if (p.match(/^\/api\/[^/]+\/users$/)) return ok(USERS);
  if (p === "/api/roles") return ok(ROLES);
  if (p.match(/^\/api\/[^/]+\/users\/[^/]+\/roles$/) || p.match(/^\/api\/[^/]+\/users\/[^/]+\/roles\/[^/]+$/)) return ok({ ok: true });
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
