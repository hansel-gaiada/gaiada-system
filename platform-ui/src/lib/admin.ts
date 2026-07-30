import "server-only";
// Admin/systems data layer — single source of truth for every admin-surface
// path/shape the UI consumes. The backend admin API does not exist yet; every
// reader here DEGRADES gracefully (null/[] on 404/403) so pages can ship ahead
// of the backend and show a "not connected yet" state instead of crashing.
//
// Contract (see docs/superpowers/plans/2026-07-05-erp-ui-plan-3-systems-consoles.md,
// "Admin-API contract"): the platform proxies each service's admin surface at
// /api/admin/:system/* for system in SystemKey. Some surfaces expose extra
// reads (egress audit, hub tools, agent goals, knowledge sources) — all
// optional and graceful.
import { platformFetch, PlatformError, type Me } from "./platform";
import { isElevated } from "./rbac";

export type SystemKey = "bot" | "gateway" | "hub" | "agents" | "knowledge" | "automation";

export interface SystemStatus {
  ok: boolean;
  version?: string;
  uptimeSec?: number;
  counters?: Record<string, number | string>;
  detail?: Record<string, unknown>;
}

export interface ConfigField {
  key: string;
  label: string;
  value: unknown;
  kind: "text" | "number" | "boolean" | "select" | "secretPresence";
  options?: string[];
  // Value/label pairs for a select whose raw value isn't fit for display (e.g. the bot's
  // management-group WhatsApp JID) — mirrors Field's own options/optionItems split, and takes
  // precedence over `options` when both are present. Purely additive: every existing select
  // field keeps using plain `options` untouched.
  optionItems?: Array<{ value: string; label: string }>;
  editable: boolean;
}

export interface AuditRow {
  time: string;
  provider?: string;
  decision?: string;
  detail?: string;
  // Structured fields (additive): the gateway's block taxonomy is the diagnostic value of this
  // trail, so it is carried as data rather than flattened into `detail`.
  capability?: string | null;
  ok?: boolean;
  blocked?: string | null;
  redactions?: number;
  latencyMs?: number | null;
}

export interface HubTool {
  name: string;
  description: string;
  minAssurance: string;
  // The hub's /tools endpoint also reports whether a tool mutates and its D14 impact tier.
  write?: boolean;
  impact?: "low" | "medium" | "high" | null;
  /** Registration group ("core", "platform-read", …) or "module" for contract-contributed tools. */
  source?: string;
}

// ---- Gateway detail (nest GET /api/admin/gateway/detail -> ai-gateway-go GET /admin/config) ----
// Every field is optional: this crosses two service boundaries, and an older gateway build must
// degrade a card rather than break the page.
export interface ProviderState {
  name: string;
  position: number;
  state: string; // ok | open | unconfigured
  available: boolean;
  consecutiveFails?: number;
  rateLimited?: boolean;
  openUntil?: string;
}

export interface ChainReport {
  order?: string[];
  providers?: ProviderState[];
}

export interface GatewayBudget {
  day?: string;
  used?: number;
  cap?: number;
  effectiveCap?: number;
  perTenantCap?: number;
  tenants?: Record<string, number>;
  drActive?: boolean;
  drBurstCap?: number;
  drUntil?: string;
}

export interface GatewayDetail {
  chains?: { llm?: ChainReport; media?: ChainReport; embed?: ChainReport };
  providers?: Array<{
    name: string;
    model?: string;
    endpoint?: string;
    keyRequired: boolean;
    keyConfigured: boolean;
    siteExcluded?: boolean;
  }>;
  budget?: GatewayBudget;
  reliability?: { breakerThreshold?: number; breakerCooldownMs?: number; providerTimeoutMs?: number };
  security?: {
    tlsMode?: string;
    egressAllowlist?: string[];
    dlpClassifierEnabled?: boolean;
    dlpClassifierModel?: string;
    classifierReachable?: boolean;
    auditFile?: string;
  };
  topology?: { mode?: string; centralConfigured?: boolean; drBurstCap?: number; drDurationMinutes?: number; mediaMaxBytes?: number };
  /** Keys the running gateway accepts on a config write. Absent/empty ⇒ writes aren't wired, and the
   *  console renders read-only rather than offering a save that can't land. */
  writableKeys?: string[];
  /** Which values are console overrides shadowing the env — shown so "my env change did nothing" is
   *  diagnosable from the page. */
  overriddenKeys?: Record<string, boolean>;
}

// ---- Hub detail (nest GET /api/admin/hub/detail -> mcp-hub GET /admin/info) ----
export interface HubResource {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface HubPrompt {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export interface HubDetail {
  policy?: {
    engine?: string;
    cerbosConfigured?: boolean;
    denyByDefault?: boolean;
    assuranceRanks?: string[];
    automationWriteGate?: string;
    revocationCheck?: boolean;
    revocationTtlMs?: number;
  };
  rateLimit?: {
    perPrincipalPerMin?: number;
    perPrincipalBurst?: number;
    perServiceTokenPerMin?: number;
    perServiceTokenBurst?: number;
  };
  transport?: { tlsMode?: string; peerAllowlist?: string[]; topology?: string; serviceAuthConfigured?: boolean };
  tools?: { total?: number; bySource?: Record<string, number> };
  resources?: HubResource[];
  prompts?: HubPrompt[];
  workflowScopes?: Array<{ workflow: string; tools: string[] }>;
  upstreams?: Record<string, boolean>;
}

/** One row of the hub's tool-call decision trail (mcp-hub ToolAudit, mirrored). */
export interface HubAuditRow {
  ts: number;
  tool: string;
  principal: { provider: string; externalId: string; assurance: string };
  decision: "allow" | "deny";
  ok?: boolean;
  reason?: string;
}

// ---- Automation ----
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  mode?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  durationMs?: number | null;
}

export interface BridgeStreamHealth {
  entityType: string;
  stream: string;
  backlog: number;
  deadLetter: number;
  oldestPendingMs: number | null;
  error?: string;
}

export interface BridgeHealth {
  enabled: boolean;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  events: string[];
  maxRetries: number;
  timeoutMs: number;
  streams: BridgeStreamHealth[];
  error?: string;
}

// Mirrors platform-nest's UI-facing AgentGoal reshape (doc §3.3: runner's
// GoalListItem -> budgetSpent = modelCalls+toolCalls, budgetTotal from the
// budget caps, fanOut = fanOut) plus the additive fields the doc adds
// alongside it. Kept as a local mirror per this repo's "separate standalone
// projects" convention (not a shared package) — see ai-agents/src/runner/store.ts
// (GoalListItem) and orchestrator.ts (BlackboardEntry) for the source shapes.
export interface AgentGoal {
  id: string;
  goal: string;
  status: string;
  budgetSpent?: number;
  budgetTotal?: number;
  fanOut?: number;
  // Additive (doc §3.3): which agent ran the goal, lifecycle timestamps, the
  // typed error kind on failure, and the WS4 approval id when suspended.
  agent?: string;
  createdAt?: string;
  endedAt?: string | null;
  errorKind?: string | null;
  approvalId?: string | null;
}

// A supervisor goal's blackboard row — one specialist sub-task's outcome
// (ai-agents/src/orchestrator.ts BlackboardEntry, mirrored exactly).
export interface BlackboardEntry {
  specialist: string;
  task: string;
  status: "ok" | "failed";
  summary: string;
}

// One direct-specialist run under a goal (ai-agents/src/runner/store.ts
// RunSummary — no step transcript, just enough to list + link to the full run).
export interface RunSummary {
  runId: string;
  agent: string;
  status: string;
  outcome?: string | null;
  modelCalls?: number;
  toolCalls?: number;
  provider?: string | null;
  startedAt?: number;
  endedAt?: number;
}

// Goal detail = the same reshaped AgentGoal fields + blackboard + run summaries
// (doc §3.4 "status/budget/fan-out header, blackboard entries ..., run summaries").
export interface AgentGoalDetail extends AgentGoal {
  blackboard: BlackboardEntry[];
  runs: RunSummary[];
}

// One transcript step. Mirrors ai-agents/src/agent.ts AgentStep EXACTLY
// ({kind: "model"|"tool", detail: string}) — this is untrusted model/tool
// output and must only ever be rendered as inert text (see TranscriptView).
export interface AgentStep {
  kind: "model" | "tool";
  detail: string;
}

// Full run incl. the step transcript (ai-agents/src/runner/store.ts RunRow).
// Elevated-only per doc §3.3 — a transcript can contain tool output fetched
// under the triggering user's authority.
export interface AgentRun {
  runId: string;
  goalId: string;
  agent: string;
  status: string;
  outcome?: string | null;
  steps: AgentStep[];
  modelCalls?: number;
  toolCalls?: number;
  toolsCalled?: string[];
  provider?: string | null;
  startedAt?: number;
  endedAt?: number;
}

export interface KnowledgeSource {
  id: string;
  source: string;
  provenance?: string;
  status: string;
}

// Absorbs both 404 (endpoint not found) and 403 (feature not enabled) so
// callers get a graceful fallback either way — mirrors lib/entities.ts.
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// ---- Status/config (per system) ----
export const getSystemStatus = (userId: string, system: SystemKey) =>
  skipUnavailable(platformFetch<SystemStatus>(`/api/admin/${system}/status`, userId), null as SystemStatus | null);

export async function getSystemConfig(userId: string, system: SystemKey): Promise<ConfigField[]> {
  const res = await skipUnavailable(
    platformFetch<{ fields: ConfigField[] }>(`/api/admin/${system}/config`, userId),
    null as { fields: ConfigField[] } | null,
  );
  return res?.fields ?? [];
}

// ---- Extra reads (optional, per surface) ----
export interface EgressAuditFilter {
  limit?: number;
  provider?: string;
  capability?: string;
  /** "allow" | "blocked" | a specific block reason ("dlp", "budget", "rate_limit", …). */
  decision?: string;
}

export const getEgressAudit = (userId: string, filter: EgressAuditFilter = {}) => {
  const qs = new URLSearchParams();
  qs.set("limit", String(filter.limit ?? 100));
  if (filter.provider) qs.set("provider", filter.provider);
  if (filter.capability) qs.set("capability", filter.capability);
  if (filter.decision) qs.set("decision", filter.decision);
  return skipUnavailable(
    platformFetch<AuditRow[]>(`/api/admin/gateway/egress-audit?${qs.toString()}`, userId),
    [] as AuditRow[],
  );
};

export const getGatewayDetail = (userId: string) =>
  skipUnavailable(platformFetch<GatewayDetail>(`/api/admin/gateway/detail`, userId), null as GatewayDetail | null);

export const getHubTools = (userId: string) =>
  skipUnavailable(platformFetch<HubTool[]>(`/api/admin/hub/tools`, userId), [] as HubTool[]);

export const getHubDetail = (userId: string) =>
  skipUnavailable(platformFetch<HubDetail>(`/api/admin/hub/detail`, userId), null as HubDetail | null);

export const getHubAudit = (userId: string, limit = 100) =>
  skipUnavailable(platformFetch<HubAuditRow[]>(`/api/admin/hub/audit?limit=${limit}`, userId), [] as HubAuditRow[]);

export const getWorkflowExecutions = (userId: string, limit = 50) =>
  skipUnavailable(
    platformFetch<WorkflowExecution[]>(`/api/admin/automation/executions?limit=${limit}`, userId),
    [] as WorkflowExecution[],
  );

export const getBridgeHealth = (userId: string) =>
  skipUnavailable(platformFetch<BridgeHealth>(`/api/admin/automation/bridge`, userId), null as BridgeHealth | null);

export interface WriteResult {
  ok: boolean;
  error?: string;
  applied?: unknown;
}

/** Shared shape for every console write below: elevated check first (cosmetic — the backend decides),
 *  then a single call whose 4xx message is surfaced VERBATIM. A rejected value carries the reason the
 *  service gave ("dailyCallCap must be between 1 and 10000000"), which is the entire point of having
 *  validation in the service rather than duplicated in the form. */
async function writeCall<T extends object>(
  userId: string,
  me: Me,
  path: string,
  init: RequestInit,
  unavailableMessage: string,
): Promise<WriteResult & Partial<T>> {
  // A failure carries no payload fields, hence the cast: Partial<T> is satisfied structurally but TS
  // can't prove that for an unresolved generic.
  const fail = (error: string) => ({ ok: false, error }) as WriteResult & Partial<T>;
  if (!isElevated(me)) return fail("You don't have permission to change this.");
  try {
    const res = await platformFetch<T>(path, userId, init);
    return { ok: true, ...(res ?? ({} as T)) };
  } catch (e) {
    if (e instanceof PlatformError) {
      // 404/405 = the running service has no such write route (older build) — a "not available yet"
      // message, not an error the operator should try to fix in the form.
      if (e.status === 404 || e.status === 405) return fail(unavailableMessage);
      return fail(e.message);
    }
    throw e;
  }
}

/** Write one gateway config key. Which keys are accepted is the GATEWAY's allowlist (surfaced as
 *  `detail.writableKeys` and as `editable` on each ConfigField) — never re-decided here. */
export const setGatewayConfig = (userId: string, me: Me, key: string, value: unknown) =>
  writeCall<{ applied: unknown }>(
    userId,
    me,
    `/api/admin/gateway/config`,
    { method: "PUT", body: JSON.stringify({ key, value }) },
    "Saving isn't available — this gateway build has no config-write route.",
  );

/** Drop an override so the key reverts to its env value (live, not restart-deferred). */
export const revertGatewayConfig = (userId: string, me: Me, key: string) =>
  writeCall(
    userId,
    me,
    `/api/admin/gateway/config?key=${encodeURIComponent(key)}`,
    { method: "DELETE" },
    "Reverting isn't available — this gateway build has no config-write route.",
  );

/** Activate/deactivate an n8n workflow. Deactivating silently stops business automation, so the
 *  backend gates this to platform-admin/owner (narrower than the read-only canvas). */
export const setWorkflowActive = (userId: string, me: Me, workflowId: string, active: boolean) =>
  writeCall<{ id: string; active: boolean }>(
    userId,
    me,
    `/api/admin/automation/workflows/${encodeURIComponent(workflowId)}/${active ? "activate" : "deactivate"}`,
    { method: "POST" },
    "Workflow control isn't available — n8n needs a Public-API key configured.",
  );

/** Re-deliver dead-lettered events for one bridge stream, re-running the workflows they trigger. */
export const replayBridgeStream = (userId: string, me: Me, entityType: string) =>
  writeCall<{ replayed: number; remaining: number }>(
    userId,
    me,
    `/api/admin/automation/bridge/${encodeURIComponent(entityType)}/replay`,
    { method: "POST" },
    "Replay isn't available — the event bridge isn't configured.",
  );

/** WS9 D15 failover lever: (un)lock the bounded DR-burst AI budget. Elevated-gated on the backend;
 *  `me` is checked here too so the button can refuse before a round-trip (cosmetic — nest decides). */
export async function setDrMode(
  userId: string,
  me: Me,
  input: { enable: boolean; durationMinutes?: number },
): Promise<{ ok: boolean; error?: string; drMode?: boolean }> {
  if (!isElevated(me)) return { ok: false, error: "You don't have permission to change DR mode." };
  try {
    const res = await platformFetch<{ drMode: boolean }>(`/api/admin/gateway/dr-mode`, userId, {
      method: "POST",
      body: JSON.stringify({ enable: input.enable, ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}) }),
    });
    return { ok: true, drMode: res?.drMode };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404) return { ok: false, error: "DR mode isn't available — the gateway isn't connected." };
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

export const getAgentGoals = (userId: string, tenantId: string) =>
  skipUnavailable(platformFetch<AgentGoal[]>(`/api/${tenantId}/agents/goals`, userId), [] as AgentGoal[]);

// Goal detail (blackboard + run summaries) — tenant-pinned server-side by nest/
// runner; a wrong tenant or unknown id degrades to null exactly like a 404
// (doc §3.2 "no cross-tenant id probing"), not a thrown error.
export const getAgentGoal = (userId: string, tenantId: string, goalId: string) =>
  skipUnavailable(
    platformFetch<AgentGoalDetail>(`/api/${tenantId}/agents/goals/${goalId}`, userId),
    null as AgentGoalDetail | null,
  );

// Full run incl. step transcript. Elevated-only on the backend (doc §3.3) — a
// non-elevated caller gets a 403, which skipUnavailable already degrades to
// null so the page can render its "not available" state instead of throwing.
export const getAgentRun = (userId: string, tenantId: string, runId: string) =>
  skipUnavailable(platformFetch<AgentRun>(`/api/${tenantId}/agents/runs/${runId}`, userId), null as AgentRun | null);

// True while any goal in the list is still in flight — drives the /agents
// page's and the goal-detail page's 4s poll (doc §3.4 "poll every 4s while a
// goal is queued|running, stop otherwise").
export function hasActiveGoal(goals: Pick<AgentGoal, "status">[]): boolean {
  return goals.some((g) => g.status === "queued" || g.status === "running");
}

// Pure — extracts the trigger card's agent choices from the real /health probe
// (doc §3.4 "agent select populated from the status probe's agents list").
// "supervisor" always leads (it's the default agent, not itself a specialist
// name reported by the probe) and is never duplicated if the probe reports it.
export function agentOptions(status: SystemStatus | null): string[] {
  const raw = status?.detail?.agents;
  const names = Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
  return ["supervisor", ...names.filter((a) => a !== "supervisor")];
}

export interface AgentActionState {
  ok: boolean;
  error?: string;
  id?: string;
}

// Triggers a new agent goal (doc §3.3 POST /api/:t/agents/goals). Elevated-
// gated: the caller MUST pass `me` and this refuses (cosmetically — the real
// gate is nest's `isElevated`) when the session isn't platform_admin/
// group_executive. A plain async function (not a "use server" directive) so
// it's directly unit-testable; the callable Server Action wrapper that pulls
// session/tenant context lives in app/(app)/agents/actions.ts.
export async function triggerAgentGoal(
  userId: string,
  tenantId: string,
  me: Me,
  input: { goal: string; agent?: string },
): Promise<AgentActionState> {
  if (!isElevated(me)) return { ok: false, error: "You don't have permission to trigger agents." };
  const goal = input.goal.trim();
  if (!goal) return { ok: false, error: "Enter a goal." };
  if (goal.length > 4000) return { ok: false, error: "Goal is too long (4000 characters max)." };

  try {
    const res = await platformFetch<{ id: string }>(`/api/${tenantId}/agents/goals`, userId, {
      method: "POST",
      body: JSON.stringify({ goal, ...(input.agent ? { agent: input.agent } : {}) }),
    });
    return { ok: true, id: res?.id };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404 || e.status === 503) {
        return { ok: false, error: "Agent triggering isn't available yet — the runner isn't connected." };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

export const getKnowledgeSources = (userId: string, tenantId: string) =>
  skipUnavailable(platformFetch<KnowledgeSource[]>(`/api/${tenantId}/knowledge/sources`, userId), [] as KnowledgeSource[]);

// ---- Bot chat viewer + logs (frozen nest contract, all GET/isElevated-gated) ----
// One row in the /chats list — a WhatsApp/Telegram conversation summary,
// newest-activity-first per the contract. Read-only: this is a viewer, not an
// inbox (no send/reply/delete anywhere in this surface).
export interface BotChatSummary {
  chatId: string;
  kind: "group" | "dm";
  surface: "whatsapp" | "telegram";
  name: string;
  messageCount: number;
  lastActivityTs: number;
  lastPreview: string;
}

export interface BotChatsSnapshot {
  chats: BotChatSummary[];
}

// One message in a thread (oldest->newest per the contract). `text`/
// `mediaText` are UNTRUSTED chat content — callers must render them as inert
// text children only (see ChatsTab), never HTML/markdown.
export interface BotChatMessage {
  ts: number;
  senderId: string;
  senderName: string;
  text: string;
  fromBot: boolean;
  mediaMime?: string;
  mediaStatus?: string;
  mediaText?: string;
}

export interface BotChatMessagesSnapshot {
  chatId: string;
  messages: BotChatMessage[];
  // Set once the paging endpoint ships (Agent 1's `beforeTs` support) — an older bot build simply
  // omits it, which the UI treats as "no further paging" rather than crashing.
  hasMore?: boolean;
}

// One hit from the cross-chat message search (`GET /admin/search`). Mirrored locally in
// ChatsTab.tsx too (that component is "use client" and can't import this server-only module) —
// same duplication convention as BotChatSummary/BotChatMessage above.
export interface BotSearchResult {
  chatId: string;
  chatName: string;
  kind: "group" | "dm";
  surface: "whatsapp" | "telegram";
  ts: number;
  senderName: string;
  text: string;
}

export interface BotSearchSnapshot {
  results: BotSearchResult[];
}

export interface BotSessionEvent {
  status: string;
  ts: number;
}

export interface BotSessionEventsSnapshot {
  events: BotSessionEvent[];
}

// Audit rows are rendered generically by the UI (doc: "render generically") —
// the shape is intentionally loose here, just enough to iterate keys.
export type BotActionAuditEntry = Record<string, unknown>;

export interface BotActionAuditSnapshot {
  enabled: boolean;
  entries: BotActionAuditEntry[];
}

// `q`/`kind` are additive (Chats-tab search + group/DM filter) — omitted entirely when unset so
// the outbound URL is byte-identical to before on the common no-filter path.
export interface BotChatsFilter {
  q?: string;
  kind?: "group" | "dm";
}

export const getBotChats = (userId: string, filter: BotChatsFilter = {}) => {
  const qs = new URLSearchParams({ limit: "100" });
  if (filter.q) qs.set("q", filter.q);
  if (filter.kind) qs.set("kind", filter.kind);
  return skipUnavailable(
    platformFetch<BotChatsSnapshot>(`/api/admin/bot/chats?${qs.toString()}`, userId),
    null as BotChatsSnapshot | null,
  );
};

// chatId contains "@" (WA) / ":" (tg:) per the contract note — always
// URL-encoded here before it goes into the outbound path, regardless of what
// shape the caller passed it in as. `beforeTs` is additive ("Load older" paging).
export const getBotChatMessages = (userId: string, chatId: string, beforeTs?: number) => {
  const qs = new URLSearchParams({ limit: "100" });
  if (beforeTs != null) qs.set("beforeTs", String(beforeTs));
  return skipUnavailable(
    platformFetch<BotChatMessagesSnapshot>(
      `/api/admin/bot/chats/${encodeURIComponent(chatId)}/messages?${qs.toString()}`,
      userId,
    ),
    null as BotChatMessagesSnapshot | null,
  );
};

// Cross-chat message search (contract §1e `GET /admin/search`). `q` is required by the bot
// (empty/whitespace -> `[]`) but this reader still degrades to `{results: []}` on an
// unreachable/older-build backend, same convention as every other bot read here.
export const getBotSearch = (userId: string, q: string, limit = 25) =>
  skipUnavailable(
    platformFetch<BotSearchSnapshot>(
      `/api/admin/bot/search?q=${encodeURIComponent(q)}&limit=${limit}`,
      userId,
    ),
    { results: [] } as BotSearchSnapshot,
  );

export const getBotSessionEvents = (userId: string) =>
  skipUnavailable(
    platformFetch<BotSessionEventsSnapshot>(`/api/admin/bot/session/events`, userId),
    { events: [] } as BotSessionEventsSnapshot,
  );

export const getBotActionAudit = (userId: string) =>
  skipUnavailable(
    platformFetch<BotActionAuditSnapshot>(`/api/admin/bot/actions/audit?limit=100`, userId),
    null as BotActionAuditSnapshot | null,
  );

// ---- Bot controls tab (kill switch, digest history, media queue, skills) ----
// Added for the Controls tab (2026-07-28 console-depth build) — same
// fail-soft convention as the chat/logs surfaces above: 404/403 (bot admin
// API not deployed yet / not configured) degrade to a null snapshot rather
// than throwing, so the panel can show its EmptyNote instead of an error.
export interface BotDigestRecord {
  ts: number;
  slot: "noon" | "evening";
  trigger: "scheduled" | "manual";
  groupsCovered: number;
  delivered: number;
  failed: number;
  managementDelivered: number;
  error?: string;
}

export interface BotDigestsSnapshot {
  history: BotDigestRecord[];
  nextRun: { noon: number | null; evening: number | null };
  timezone: string;
}

export interface BotSkill {
  name: string;
  description: string;
}

export interface BotSkillsSnapshot {
  commandPrefix: string;
  botMention: string;
  skills: BotSkill[];
}

export interface BotMediaStatusSnapshot {
  queueEnabled: boolean;
  pending: number;
  oldestPendingTs: number | null;
}

export const getBotDigests = (userId: string, limit = 50) =>
  skipUnavailable(
    platformFetch<BotDigestsSnapshot>(`/api/admin/bot/digests?limit=${limit}`, userId),
    null as BotDigestsSnapshot | null,
  );

export const getBotSkills = (userId: string) =>
  skipUnavailable(
    platformFetch<BotSkillsSnapshot>(`/api/admin/bot/skills`, userId),
    null as BotSkillsSnapshot | null,
  );

export const getBotMediaStatus = (userId: string) =>
  skipUnavailable(
    platformFetch<BotMediaStatusSnapshot>(`/api/admin/bot/media/status`, userId),
    null as BotMediaStatusSnapshot | null,
  );

// Pure. 0 -> "0m"; 61 -> "1m"; 3661 -> "1h 1m"; 90061 -> "1d 1h 1m".
// Drops zero leading units (days/hours); always shows minutes if nothing else.
export function formatUptime(sec: number): string {
  const totalMinutes = Math.floor(sec / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}
