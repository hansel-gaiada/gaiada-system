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
  editable: boolean;
}

export interface AuditRow {
  time: string;
  provider?: string;
  decision?: string;
  detail?: string;
}

export interface HubTool {
  name: string;
  description: string;
  minAssurance: string;
  // The hub's /tools endpoint also reports whether a tool mutates and its D14 impact tier.
  write?: boolean;
  impact?: "low" | "medium" | "high" | null;
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
export const getEgressAudit = (userId: string) =>
  skipUnavailable(platformFetch<AuditRow[]>(`/api/admin/gateway/egress-audit`, userId), [] as AuditRow[]);

export const getHubTools = (userId: string) =>
  skipUnavailable(platformFetch<HubTool[]>(`/api/admin/hub/tools`, userId), [] as HubTool[]);

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

export const getBotChats = (userId: string) =>
  skipUnavailable(
    platformFetch<BotChatsSnapshot>(`/api/admin/bot/chats?limit=100`, userId),
    null as BotChatsSnapshot | null,
  );

// chatId contains "@" (WA) / ":" (tg:) per the contract note — always
// URL-encoded here before it goes into the outbound path, regardless of what
// shape the caller passed it in as.
export const getBotChatMessages = (userId: string, chatId: string) =>
  skipUnavailable(
    platformFetch<BotChatMessagesSnapshot>(
      `/api/admin/bot/chats/${encodeURIComponent(chatId)}/messages?limit=100`,
      userId,
    ),
    null as BotChatMessagesSnapshot | null,
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
