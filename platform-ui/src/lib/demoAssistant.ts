import "server-only";
// TEMP DEMO MODE — stateful in-memory store for the `/assistant` workspace (ASST-07), mirroring
// demoMeetings.ts/demoPm.ts. Module-level state persists per dev-server process, resets on restart.
// Active only via DEMO_MODE=1; routed from demoFixtures.getDemoResponse. Owner-only scoping is
// mirrored here too (filtered by `ownerUserId === userId` on every read) so the demo behaves like
// the real Cerbos policy even with no backend running. Safe to delete once a live backend is used.
//
// The one thing this file does that no other demoX.ts needs to: it also answers the SSE STREAM
// itself (`demoAssistantStreamBody`), not just the JSON CRUD routes — `getDemoResponse` only ever
// returns `{status, json}`, which has no way to represent a stream, so the stream proxy route
// (`app/api/assistant/threads/[id]/stream/route.ts`) calls this file directly instead of going
// through `platformFetch`'s DEMO_MODE branch. See that route's header for the split.
import type {
  AssistantMemoryScope, AssistantMessageRole, AssistantThreadStatus, HandoffStatus,
  AssistantToolAgent, ThreadToolCall, WriteIntentStatus,
} from "./assistant";

interface DemoThread {
  id: string;
  tenantId: string;
  ownerUserId: string;
  title: string | null;
  brainProvider: string | null;
  brainModel: string | null;
  hermesSessionId: string | null;
  status: AssistantThreadStatus;
  pinned: boolean;
  lastMessageAt: string | null;
  totalTokens: number;
  totalCostUsd: string;
  compactionSummary: string | null;
  compactionSummaryUptoSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DemoMessage {
  id: string;
  tenantId: string;
  threadId: string;
  seq: number;
  role: AssistantMessageRole;
  content: string | null;
  /** Text streamed so far for a still-pending assistant row — read by `stop` to finalize with
   *  whatever was actually shown to the client, mirroring the real backend's "partial reply is
   *  always visible, never silently discarded" rule (docs/FRONTEND-BFF-CONTRACT.md §18). */
  partial: string;
  parts: unknown;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  createdAt: string;
}

// ── T4 (ASST-23, §7.4) — the tool-turn / write-proposal demo stores. Mirrors platform-nest's
// `assistant_tool_calls` + `assistant_write_intents` + `automation_approvals` (redacted-args-at-
// persist, real-args-only-in-the-intent-row, one confirm-time claim) as closely as a demo fixture
// reasonably should — see each store's own comment for the one deliberate simplification each
// makes over the real backend. ─────────────────────────────────────────────────────────────────────
interface DemoToolCall {
  id: string;
  tenantId: string;
  messageId: string;
  toolName: string;
  mcpServer: string | null;
  /** Already redacted at creation (mirrors the real ledger's own invariant) — never a real value. */
  args: unknown;
  resultSummary: string | null;
  status: string; // 'succeeded' | 'failed' | 'denied' | 'pending'
  createdAt: string;
}

// FE-verification gap #2 (2026-08-06) — before this, EVERY demo confirm resolved straight to
// `approved`+`executed` (see `confirmWriteM`'s original comment, preserved below): `rejected`/
// `execution_failed`/`cancelled` were reachable in this codebase ONLY via `ProposalCard.test.tsx`'s
// constructed-props cases, never through a real propose->confirm click path. A live backend decides
// the outcome out of band (a human on `/approvals/[id]`, D14's executor) — demo mode has no such
// second actor, so the outcome is instead pre-baked into the DRAFT at propose time via a keyword in
// the sent message (the SAME "literal text in the message drives a deterministic demo branch"
// mechanism `ERROR_TEST`/`STALL_TEST` already establish below for the plain-chat path), and only
// REVEALED at confirm time — confirm still performs the one-and-only filing write, exactly like the
// default path. This does NOT touch the trap: `intent` is still read before `approval`, the approval
// row is still created (not mutated in place) only once, at confirm, and `deriveProposalCardState`
// never learns this field exists.
export type DemoWriteOutcome = "executed" | "rejected" | "cancelled" | "failed" | "not_executable";

/** Case-insensitive keyword scan over the message that drafted this write — mirrors
 *  `demoAssistantStreamBody`'s own `ERROR_TEST`/`STALL_TEST` convention. Absent any keyword, the
 *  outcome is the honest common case: `"executed"`. */
function pickDemoWriteOutcome(sourceText: string): DemoWriteOutcome {
  if (/REJECT_TEST/i.test(sourceText)) return "rejected";
  if (/CANCEL_TEST/i.test(sourceText)) return "cancelled";
  if (/FAIL_TEST/i.test(sourceText)) return "failed";
  if (/NOTEXEC_TEST/i.test(sourceText)) return "not_executable";
  return "executed";
}

/** The approval-row shape each `DemoWriteOutcome` produces at confirm time — the ONE place this
 *  mapping lives (both `confirmWriteM`'s fresh-file branch and its idempotent-replay branch read
 *  through here, never duplicate the literal shapes). `executionError` on `"failed"` is prose, not a
 *  wire-typed reason code — a demo fixture rendering a plausible human sentence, same register as
 *  the rest of this file's demo copy. */
function demoApprovalOutcomeFor(outcome: DemoWriteOutcome): Pick<DemoWriteApproval, "status" | "executionStatus" | "executionError"> {
  switch (outcome) {
    case "rejected": return { status: "rejected", executionStatus: "pending", executionError: null };
    case "cancelled": return { status: "cancelled", executionStatus: "pending", executionError: null };
    case "failed": return { status: "approved", executionStatus: "failed", executionError: "Execution failed (demo): the project was archived before this write could run." };
    case "not_executable": return { status: "approved", executionStatus: "not_applicable", executionError: null };
    case "executed": default: return { status: "approved", executionStatus: "executed", executionError: null };
  }
}

interface DemoWriteIntent {
  id: string;
  tenantId: string;
  threadId: string;
  toolCallId: string;
  ownerUserId: string;
  agent: string;
  toolName: string;
  /** The ONLY pre-filing home of the REAL (unredacted) args — NULL the instant status leaves
   *  'draft', exactly like the real `assistant_write_intents.tool_args` column. */
  toolArgs: Record<string, unknown> | null;
  impact: string;
  status: WriteIntentStatus;
  approvalId: string | null;
  expiresAt: string;
  /** Demo-only: which terminal shape THIS draft's eventual confirm will produce — decided once, at
   *  draft time, from the drafting message's own text (see `pickDemoWriteOutcome`). Never read by
   *  anything outside this file; not part of any wire/persisted shape. */
  demoOutcome: DemoWriteOutcome;
}

interface DemoWriteApproval {
  id: string;
  tenantId: string;
  toolName: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  executionStatus: "pending" | "executing" | "executed" | "failed" | "not_applicable";
  executionError: string | null;
}

// A small, fixed stand-in for `broker.ts`'s REAL `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS`
// maps — demo mode has no broker process to ask. `status-reporter` first, matching the real
// `DEFAULT_TOOL_AGENT`.
const DEMO_TOOL_AGENTS: AssistantToolAgent[] = [
  { name: "status-reporter", tools: ["projects.list", "tasks.list"], writeTools: [] },
  { name: "approvals-chaser", tools: ["agency.pendingApprovals"], writeTools: [] },
  { name: "task-filer", tools: ["projects.list", "tasks.list", "pm.createTask", "pm.createDoc"], writeTools: ["pm.createTask", "pm.createDoc"] },
];

const ASSISTANT_INTENT_TTL_MS = 60 * 60 * 1000; // mirrors the real default (config.assistantIntentTtlMs)

/** Shape-only redaction — the SAME contract the real `redactToolArgs` holds (key names survive,
 *  every value is destroyed), just without the depth-capping/array-collapsing a demo fixture never
 *  needs to exercise. */
function demoRedactArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = `[redacted:${Array.isArray(value) ? "array" : typeof value}]`;
  }
  return out;
}

/** Mirrors `broker.ts`'s `readTurnMode` — reads the fact off the placeholder ROW's own `parts`,
 *  never off anything client-controlled (a query string, a re-sent body). */
function readTurnModeDemo(parts: unknown): { agent: string } | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (p && typeof p === "object" && (p as { type?: unknown }).type === "turn_mode" && (p as { mode?: unknown }).mode === "tools") {
      const agent = typeof (p as { agent?: unknown }).agent === "string" ? (p as { agent: string }).agent : "status-reporter";
      return { agent };
    }
  }
  return null;
}

/** Lazy reap (mirrors `write-intents.ts`'s `reapExpiredIntents`) — flips any of THIS thread's
 *  past-expiry drafts to 'expired' and scrubs `toolArgs`, called before every GET-thread join. */
function reapExpiredIntentsDemo(threadId: string): void {
  const nowMs = Date.now();
  for (const intent of WRITE_INTENTS) {
    if (intent.threadId === threadId && intent.status === "draft" && Date.parse(intent.expiresAt) <= nowMs) {
      intent.status = "expired";
      intent.toolArgs = null;
    }
  }
}

/** Mirrors `assistant.controller.ts`'s `fetchToolCallsByMessage` — the SAME LEFT-JOIN-by-`tool_call_id`/
 *  `approval_id` precedence, over the demo stores instead of Postgres. Called AFTER
 *  `reapExpiredIntentsDemo` so a past-expiry draft never reads as a stale 'draft' here. */
function demoToolCallsForMessage(messageId: string): ThreadToolCall[] {
  return TOOL_CALLS.filter((tc) => tc.messageId === messageId).map((tc) => {
    const intent = WRITE_INTENTS.find((wi) => wi.toolCallId === tc.id) ?? null;
    const approvalId = intent?.approvalId ?? null;
    const approval = approvalId ? WRITE_APPROVALS.find((a) => a.id === approvalId) ?? null : null;
    return {
      id: tc.id, toolName: tc.toolName, mcpServer: tc.mcpServer, args: tc.args, resultSummary: tc.resultSummary,
      status: tc.status, approvalId, durationMs: null, createdAt: tc.createdAt,
      approval: approval ? { status: approval.status, executionStatus: approval.executionStatus, executionError: approval.executionError } : null,
      intent: intent && !approvalId ? { status: intent.status, expiresAt: intent.expiresAt } : null,
    };
  });
}

// ASST-19 — durable memory (blueprint §4.1, memory #2 of 4). Owner-scoped the same way threads
// are (`ownerUserId === userId` on every read/write), and the SAME quarantine shape as the real
// backend: `confirmedAt: null` is a proposal, inert until a separate "confirm" call.
interface DemoMemory {
  id: string;
  tenantId: string;
  ownerUserId: string;
  scope: AssistantMemoryScope;
  content: string;
  provenance: "user" | "assistant";
  trust: "trusted" | "untrusted";
  pinned: boolean;
  confirmedAt: string | null;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ASST-21 — a handoff created via the roster panel's "hand off" form. Owner-scoped the same way
// threads/memory are; demo mode resolves instantly to `ok` (no real runner to poll) so the
// run-watch view has something terminal to show without a fake async loop.
interface DemoHandoff {
  id: string;
  tenantId: string;
  threadId: string;
  ownerUserId: string;
  agent: string;
  goalText: string;
  goalId: string;
  runId: string | null;
  status: HandoffStatus;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

// A small, fixed stand-in for the runner's REAL registry (see `handoffs.ts`'s `fetchRoster` for
// why the live backend never hardcodes this) — demo mode has no runner process to ask.
const DEMO_ROSTER_AGENTS = [
  { name: "status-reporter", tools: ["projects.list", "tasks.list"], maxSteps: 8, maxToolCalls: 6, writeCapable: false, evaledProviders: [] as string[] },
  { name: "approvals-chaser", tools: ["agency.pendingApprovals"], maxSteps: 4, maxToolCalls: 2, writeCapable: false, evaledProviders: [] as string[] },
  { name: "task-triager", tools: ["tasks.list", "tasks.update"], maxSteps: 10, maxToolCalls: 6, writeCapable: true, evaledProviders: ["openai"] },
];

const now = () => new Date().toISOString();
const DEMO_OWNER = "demo-hansel";

function seedThreads(): DemoThread[] {
  return [
    {
      id: "asst-thread-1", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Draft the Q3 client update", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: true, lastMessageAt: "2026-08-04T09:10:00Z",
      totalTokens: 340, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-08-04T09:00:00Z", updatedAt: "2026-08-04T09:10:00Z",
    },
    {
      id: "asst-thread-2", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Explain the D14 execution gate", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: false, lastMessageAt: "2026-08-03T14:22:00Z",
      totalTokens: 180, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-08-03T14:20:00Z", updatedAt: "2026-08-03T14:22:00Z",
    },
    {
      id: "asst-thread-3", tenantId: "co-agency", ownerUserId: DEMO_OWNER,
      title: "Older scratch thread", brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: false, lastMessageAt: "2026-07-10T08:00:00Z",
      totalTokens: 60, totalCostUsd: "0.00", compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: "2026-07-10T07:55:00Z", updatedAt: "2026-07-10T08:00:00Z",
    },
  ];
}

function seedMessages(): DemoMessage[] {
  return [
    {
      id: "asst-msg-1", tenantId: "co-agency", threadId: "asst-thread-1", seq: 1, role: "user",
      content: "Draft a short client update for Northwind on the site redesign.", partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null,
      createdAt: "2026-08-04T09:00:00Z",
    },
    {
      id: "asst-msg-2", tenantId: "co-agency", threadId: "asst-thread-1", seq: 2, role: "assistant",
      content: "Here's a draft:\n\n**Northwind — Site Redesign Update**\n\nWe're on track for the Q3 milestone. The homepage hero is wired and checkout QA is in progress. No blockers.",
      partial: "", parts: null, provider: null, model: null, tokens: 96, latencyMs: 1400, errorKind: null,
      createdAt: "2026-08-04T09:00:04Z",
    },
    {
      id: "asst-msg-3", tenantId: "co-agency", threadId: "asst-thread-2", seq: 1, role: "user",
      content: "What does the D14 execution gate actually do?", partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null,
      createdAt: "2026-08-03T14:20:00Z",
    },
    {
      id: "asst-msg-4", tenantId: "co-agency", threadId: "asst-thread-2", seq: 2, role: "assistant",
      content: "It separates DECIDING an automation write (approved/rejected) from EXECUTING it. Approving used to execute nothing — D14 adds a registry-scoped executor that re-drives the call as the original requester, with a single-use grant.",
      partial: "", parts: null, provider: null, model: null, tokens: 84, latencyMs: 1100, errorKind: null,
      createdAt: "2026-08-03T14:20:03Z",
    },
  ];
}

function seedMemory(): DemoMemory[] {
  return [
    {
      id: "asst-mem-1", tenantId: "co-agency", ownerUserId: DEMO_OWNER, scope: "user",
      content: "Prefers short, direct replies — no filler preamble.", provenance: "user",
      trust: "trusted", pinned: true, confirmedAt: "2026-08-02T10:00:00Z", sourceThreadId: null,
      createdAt: "2026-08-02T09:59:00Z", updatedAt: "2026-08-02T10:00:00Z",
    },
    {
      id: "asst-mem-2", tenantId: "co-agency", ownerUserId: DEMO_OWNER, scope: "company",
      content: "The company's fiscal year starts in April.", provenance: "user",
      trust: "trusted", pinned: false, confirmedAt: "2026-08-01T08:00:00Z", sourceThreadId: null,
      createdAt: "2026-08-01T07:55:00Z", updatedAt: "2026-08-01T08:00:00Z",
    },
    {
      id: "asst-mem-3", tenantId: "co-agency", ownerUserId: DEMO_OWNER, scope: "user",
      // Deliberately UNCONFIRMED — proves the panel's "pending" section (and, on the backend side,
      // context.ts's quarantine gate) with no extra clicks needed to see the state exists.
      content: "Might be based in the Jakarta office (unconfirmed guess).", provenance: "assistant",
      trust: "untrusted", pinned: false, confirmedAt: null, sourceThreadId: "asst-thread-1",
      createdAt: "2026-08-04T09:05:00Z", updatedAt: "2026-08-04T09:05:00Z",
    },
  ];
}

// ── WHY THIS SITS ON `globalThis` INSTEAD OF A PLAIN MODULE-LEVEL `const` (found empirically —
// this bit the very first live drive of ASST-07 under DEMO_MODE) ────────────────────────────────
// Next.js compiles Server Actions and Route Handlers as SEPARATE module graphs ("layers"), even
// when both run in the same Node.js process. A thread created via `createThreadAction` (the
// "action" layer, calling `assistantDemo` below) landed in one instance of this module's `THREADS`
// array; the SSE stream proxy route (`app/api/assistant/threads/[id]/stream/route.ts`, the "route"
// layer, calling `demoAssistantStreamBody`) read a SECOND, independently-initialized instance that
// never saw it — every send 404'd with "no pending generation for this messageId". Every OTHER
// `demoX.ts` store in this codebase is read only from Server Actions/Server Components (one layer),
// so this cross-layer sharing requirement is unique to this file (it is also why the portal's own
// SSE proxy, `lib/portal-stream-server.ts`, never attempted synthetic DEMO_MODE data — it sidesteps
// this exact problem by falling back to polling instead). `globalThis` is the one thing every layer
// in the same process actually shares — the identical pattern Next.js apps use to keep a Prisma
// client a true singleton across repeated module instantiation.
declare global {
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantThreads: DemoThread[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantMessages: DemoMessage[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantSeq: { n: number } | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantMemory: DemoMemory[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantHandoffs: DemoHandoff[] | undefined;
  // T4 — same cross-layer singleton requirement as THREADS/MESSAGES above (this session's own
  // header explains why): the tool-turn simulation runs from the "route" layer
  // (`demoAssistantStreamBody`), while confirm/dismiss run from the "action" layer
  // (`assistantDemo`, called via `platformFetch`'s DEMO_MODE branch) — both must see the SAME rows.
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantToolCalls: DemoToolCall[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantIntents: DemoWriteIntent[] | undefined;
  // eslint-disable-next-line no-var
  var __gaiadaDemoAssistantApprovals: DemoWriteApproval[] | undefined;
}

const THREADS: DemoThread[] = globalThis.__gaiadaDemoAssistantThreads ?? (globalThis.__gaiadaDemoAssistantThreads = seedThreads());
const MESSAGES: DemoMessage[] = globalThis.__gaiadaDemoAssistantMessages ?? (globalThis.__gaiadaDemoAssistantMessages = seedMessages());
const seqBox = globalThis.__gaiadaDemoAssistantSeq ?? (globalThis.__gaiadaDemoAssistantSeq = { n: 1 });
const nid = (p: string) => `${p}-demo-${seqBox.n++}`;
// ASST-19 — same globalThis-singleton requirement as THREADS/MESSAGES above (this store is read
// from the "action" layer via proposeMemoryAction/confirmMemoryAction and would otherwise be a
// SECOND, independently-initialized array under the route layer — see the header comment above).
const MEMORY: DemoMemory[] = globalThis.__gaiadaDemoAssistantMemory ?? (globalThis.__gaiadaDemoAssistantMemory = seedMemory());
// ASST-21 — same singleton requirement; read from the "action" layer via createHandoffAction/
// refreshHandoffsAction.
const HANDOFFS: DemoHandoff[] = globalThis.__gaiadaDemoAssistantHandoffs ?? (globalThis.__gaiadaDemoAssistantHandoffs = []);
// T4 — see the singleton declaration's own comment above.
const TOOL_CALLS: DemoToolCall[] = globalThis.__gaiadaDemoAssistantToolCalls ?? (globalThis.__gaiadaDemoAssistantToolCalls = []);
const WRITE_INTENTS: DemoWriteIntent[] = globalThis.__gaiadaDemoAssistantIntents ?? (globalThis.__gaiadaDemoAssistantIntents = []);
const WRITE_APPROVALS: DemoWriteApproval[] = globalThis.__gaiadaDemoAssistantApprovals ?? (globalThis.__gaiadaDemoAssistantApprovals = []);

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

function pinnedThenRecent(a: DemoThread, b: DemoThread): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const av = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -Infinity;
  const bv = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -Infinity;
  if (av !== bv) return bv - av;
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function memoryPinnedThenRecent(a: DemoMemory, b: DemoMemory): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const av = a.confirmedAt ? Date.parse(a.confirmedAt) : Date.parse(a.createdAt);
  const bv = b.confirmedAt ? Date.parse(b.confirmedAt) : Date.parse(b.createdAt);
  return bv - av;
}

function pubThread(t: DemoThread) {
  const { tenantId, ...rest } = t;
  void tenantId;
  return rest;
}
function pubMessage(m: DemoMessage) {
  const { tenantId, threadId, partial, ...rest } = m;
  void tenantId; void threadId; void partial;
  return rest;
}
function pubMemory(m: DemoMemory) {
  const { tenantId, ...rest } = m;
  void tenantId;
  return rest;
}
function pubHandoff(h: DemoHandoff) {
  const { tenantId, ...rest } = h;
  void tenantId;
  return rest;
}

/** Returns a DemoResult for any `/api/:t/assistant/*` CRUD route, or null if it doesn't match. */
export function assistantDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const m = method.toUpperCase();

  const messagesM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/messages$/);
  if (messagesM && m === "POST") {
    const [, tenantId, threadId] = messagesM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const pending = MESSAGES.some((msg) => msg.threadId === threadId && msg.role === "assistant" && msg.content === null && msg.errorKind === null);
    if (pending) return { status: 409, json: { error: "a response is already streaming for this thread — stop it or wait for it to finish" } };
    const b = JSON.parse(body || "{}") as { content?: string; mode?: string; agent?: string };
    const content = (b.content ?? "").trim();
    if (!content) return { status: 400, json: { error: "content is required" } };
    // T4 (ASST-23) — mirrors `assistant.controller.ts`'s `sendMessage`: an unknown `mode` value or
    // an agent that isn't a real (demo) tool agent 400s at SEND time, never mid-stream.
    if (b.mode !== undefined && b.mode !== "chat" && b.mode !== "tools") {
      return { status: 400, json: { error: "mode must be 'chat' or 'tools'" } };
    }
    const toolMode = b.mode === "tools";
    const agent = typeof b.agent === "string" && b.agent ? b.agent : "status-reporter";
    if (toolMode && !DEMO_TOOL_AGENTS.some((a) => a.name === agent)) {
      return { status: 400, json: { error: `agent must be one of ${DEMO_TOOL_AGENTS.map((a) => a.name).join(",")}` } };
    }
    const threadMsgs = MESSAGES.filter((msg) => msg.threadId === threadId);
    const nextSeq = (threadMsgs.length ? Math.max(...threadMsgs.map((msg) => msg.seq)) : 0) + 1;
    MESSAGES.push({
      id: nid("asst-msg"), tenantId, threadId, seq: nextSeq, role: "user", content, partial: "",
      parts: null, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: now(),
    });
    const assistantId = nid("asst-msg");
    // ASST-17 — the placeholder row records the turn mode in `parts` (mirrors the real
    // `turnModePart`), which is what `demoAssistantStreamBody` reads back to decide whether to
    // simulate a tool turn at all — never trusting a client-controlled query string either.
    const placeholderParts = toolMode ? [{ type: "turn_mode", mode: "tools", agent }] : null;
    MESSAGES.push({
      id: assistantId, tenantId, threadId, seq: nextSeq + 1, role: "assistant", content: null, partial: "",
      parts: placeholderParts, provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: now(),
    });
    return {
      status: 201,
      json: {
        messageId: assistantId,
        streamUrl: `/api/${tenantId}/assistant/threads/${threadId}/stream?messageId=${assistantId}${toolMode ? "&mode=tools" : ""}`,
      },
    };
  }

  const stopM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/stop$/);
  if (stopM && m === "POST") {
    const [, tenantId, threadId] = stopM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const row = MESSAGES.find((msg) => msg.threadId === threadId && msg.role === "assistant" && msg.content === null && msg.errorKind === null);
    if (!row) return ok({ ok: true, stopped: false });
    row.content = row.partial;
    row.errorKind = "stopped";
    return ok({ ok: true, stopped: true });
  }

  const detailM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)$/);
  if (detailM) {
    const [, tenantId, threadId] = detailM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (m === "PATCH") {
      if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
      const b = JSON.parse(body || "{}") as { title?: string | null; pinned?: boolean; status?: string; brainProvider?: string | null; brainModel?: string | null };
      if (Object.prototype.hasOwnProperty.call(b, "title")) thread.title = typeof b.title === "string" ? b.title.trim().slice(0, 500) || null : null;
      if (typeof b.pinned === "boolean") thread.pinned = b.pinned;
      if (b.status === "active" || b.status === "archived") thread.status = b.status;
      if (Object.prototype.hasOwnProperty.call(b, "brainProvider")) {
        const next = b.brainProvider ?? null;
        // ASST-16 — mirrors assistant.controller.ts's patchThread: switching to a DIFFERENT brain
        // clears the stale Hermes session id server-side (a fresh provider session starts on the
        // next turn), so the demo fixture must not leave a stale one behind either.
        if (next !== thread.brainProvider) thread.hermesSessionId = null;
        thread.brainProvider = next;
      }
      if (Object.prototype.hasOwnProperty.call(b, "brainModel")) thread.brainModel = b.brainModel ?? null;
      thread.updatedAt = now();
      return ok({ id: thread.id });
    }
    if (m === "DELETE") {
      if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
      const idx = THREADS.indexOf(thread);
      THREADS.splice(idx, 1);
      for (let i = MESSAGES.length - 1; i >= 0; i--) if (MESSAGES[i].threadId === threadId) MESSAGES.splice(i, 1);
      // ASST-19 — mirrors the real composite FK's `ON DELETE SET NULL (source_thread_id)`
      // (migration 0079): a memory row that cited this thread SURVIVES the delete, with its
      // provenance link cleared, not removed.
      for (const mem of MEMORY) if (mem.sourceThreadId === threadId) mem.sourceThreadId = null;
      return ok({ ok: true });
    }
    // GET
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    // T4 (ASST-23, §7.2.3) — the SAME "lazy reap, same request" idiom the real `getThread` uses,
    // BEFORE the join below reads `WRITE_INTENTS` — a past-expiry draft must never read as a stale
    // 'draft' on this response.
    reapExpiredIntentsDemo(threadId);
    const messageLimit = Math.max(1, Math.min(500, Number(params.get("messageLimit")) || 200));
    const beforeSeqRaw = params.get("beforeSeq");
    const beforeSeq = beforeSeqRaw ? Number(beforeSeqRaw) : null;
    let msgs = MESSAGES.filter((msg) => msg.threadId === threadId).sort((a, b) => a.seq - b.seq);
    if (beforeSeq != null) msgs = msgs.filter((msg) => msg.seq < beforeSeq);
    const page = msgs.slice(-messageLimit);
    // T4 — additive `toolCalls[]` per message, mirroring `fetchToolCallsByMessage`'s shape exactly
    // (docs/FRONTEND-BFF-CONTRACT.md §18's T3a/T3b addenda) — every OTHER message field is
    // untouched (`pubMessage` unchanged).
    const messages = page.map((msg) => ({ ...pubMessage(msg), toolCalls: demoToolCallsForMessage(msg.id) }));
    return ok({ thread: pubThread(thread), messages, hasMoreMessages: page.length === messageLimit });
  }

  const listCreateM = p.match(/^\/api\/([^/]+)\/assistant\/threads$/);
  if (listCreateM) {
    const [, tenantId] = listCreateM;
    if (m === "POST") {
      const b = JSON.parse(body || "{}") as { title?: string; brainProvider?: string; brainModel?: string };
      const t: DemoThread = {
        id: nid("asst-thread"), tenantId, ownerUserId: userId,
        title: (b.title ?? "").trim().slice(0, 500) || null,
        brainProvider: b.brainProvider ?? null, brainModel: b.brainModel ?? null, hermesSessionId: null,
        status: "active", pinned: false, lastMessageAt: null, totalTokens: 0, totalCostUsd: "0.00",
        compactionSummary: null, compactionSummaryUptoSeq: null, createdAt: now(), updatedAt: now(),
      };
      THREADS.push(t);
      return { status: 201, json: { id: t.id } };
    }
    // GET — owner-only list, mirrors the real `WHERE owner_user_id = $1`.
    const q = (params.get("q") ?? "").trim().toLowerCase();
    const status = params.get("status");
    const limit = Math.max(1, Math.min(200, Number(params.get("limit")) || 50));
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    let rows = THREADS.filter((t) => t.tenantId === tenantId && t.ownerUserId === userId);
    if (status) rows = rows.filter((t) => t.status === status);
    if (q) rows = rows.filter((t) => (t.title ?? "").toLowerCase().includes(q));
    rows = [...rows].sort(pinnedThenRecent);
    const total = rows.length;
    return ok({ items: rows.slice(offset, offset + limit).map(pubThread), total });
  }

  // ── ASST-19: memory panel ────────────────────────────────────────────────────────────────────
  const confirmM = p.match(/^\/api\/([^/]+)\/assistant\/memory\/([^/]+)\/confirm$/);
  if (confirmM && m === "POST") {
    const [, tenantId, memoryId] = confirmM;
    const mem = MEMORY.find((x) => x.id === memoryId && x.tenantId === tenantId);
    if (!mem || mem.ownerUserId !== userId) return { status: 404, json: { error: "memory not found" } };
    const b = JSON.parse(body || "{}") as { content?: string; pinned?: boolean };
    if (typeof b.content === "string") {
      const trimmed = b.content.trim();
      if (!trimmed) return { status: 400, json: { error: "content cannot be empty" } };
      mem.content = trimmed;
    }
    if (typeof b.pinned === "boolean") mem.pinned = b.pinned;
    // Idempotent on the ORIGINAL confirmation timestamp — mirrors the real
    // `confirmed_at = COALESCE(confirmed_at, now())`.
    if (!mem.confirmedAt) mem.confirmedAt = now();
    mem.trust = "trusted";
    mem.updatedAt = now();
    return ok({ id: mem.id });
  }

  const memoryDetailM = p.match(/^\/api\/([^/]+)\/assistant\/memory\/([^/]+)$/);
  if (memoryDetailM && m === "DELETE") {
    const [, tenantId, memoryId] = memoryDetailM;
    const mem = MEMORY.find((x) => x.id === memoryId && x.tenantId === tenantId);
    if (!mem || mem.ownerUserId !== userId) return { status: 404, json: { error: "memory not found" } };
    MEMORY.splice(MEMORY.indexOf(mem), 1);
    return ok({ ok: true });
  }

  const memoryListCreateM = p.match(/^\/api\/([^/]+)\/assistant\/memory$/);
  if (memoryListCreateM) {
    const [, tenantId] = memoryListCreateM;
    if (m === "POST") {
      const b = JSON.parse(body || "{}") as { content?: string; scope?: string; sourceThreadId?: string };
      const content = (b.content ?? "").trim();
      if (!content) return { status: 400, json: { error: "content is required" } };
      const scope: AssistantMemoryScope = b.scope === "company" ? "company" : "user";
      const mem: DemoMemory = {
        id: nid("asst-mem"), tenantId, ownerUserId: userId, scope, content, provenance: "user",
        trust: "untrusted", pinned: false, confirmedAt: null,
        sourceThreadId: b.sourceThreadId || null, createdAt: now(), updatedAt: now(),
      };
      MEMORY.push(mem);
      return { status: 201, json: { id: mem.id } };
    }
    // GET — owner-only list, mirrors the real `WHERE owner_user_id = $1`, with the same
    // scope/pinned/confirmed filters the backend accepts.
    const scopeFilter = params.get("scope");
    const pinnedFilter = params.get("pinned");
    const confirmedFilter = params.get("confirmed");
    const limit = Math.max(1, Math.min(500, Number(params.get("limit")) || 100));
    const offset = Math.max(0, Number(params.get("offset")) || 0);
    let rows = MEMORY.filter((x) => x.tenantId === tenantId && x.ownerUserId === userId);
    if (scopeFilter) rows = rows.filter((x) => x.scope === scopeFilter);
    if (pinnedFilter !== null) rows = rows.filter((x) => x.pinned === (pinnedFilter === "true"));
    if (confirmedFilter !== null) {
      const wantConfirmed = confirmedFilter === "true";
      rows = rows.filter((x) => (wantConfirmed ? x.confirmedAt !== null : x.confirmedAt === null));
    }
    rows = [...rows].sort(memoryPinnedThenRecent);
    const total = rows.length;
    return ok({ items: rows.slice(offset, offset + limit).map(pubMemory), total });
  }

  // ── ASST-21: agent roster + handoff ──────────────────────────────────────────────────────────────
  // No real runner in demo mode: a handoff resolves to `ok` IMMEDIATELY (no async poll loop to fake)
  // so the run-watch view has a terminal state to render on the very next read. `runId` is synthetic
  // and does NOT resolve through the (unfaked) `/agents/runs/:runId` route — `getHandoffTranscriptAction`
  // degrades that to "Transcript not available" via the SAME `skipUnavailable` the Intelligence
  // console already relies on, which is the honest outcome in a backend-free environment.
  const rosterM = p.match(/^\/api\/([^/]+)\/assistant\/agents$/);
  if (rosterM && m === "GET") {
    const episodicHistory = HANDOFFS.filter((h) => h.ownerUserId === userId && h.runId).map((h) => ({
      runId: h.runId as string, agent: h.agent, goal: h.goalText, status: h.status, outcome: h.outcome,
      toolsCalled: [], failedTools: [], createdAt: Date.parse(h.updatedAt),
    }));
    return ok({
      agents: DEMO_ROSTER_AGENTS,
      supervisor: { name: "supervisor" },
      runnerConfigured: true,
      episodicHistory,
    });
  }

  const handoffM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/handoff$/);
  if (handoffM && m === "POST") {
    const [, tenantId, threadId] = handoffM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const b = JSON.parse(body || "{}") as { agent?: string; goal?: string };
    const agent = (b.agent ?? "").trim();
    if (!agent) return { status: 400, json: { error: "agent is required" } };
    if (!DEMO_ROSTER_AGENTS.some((a) => a.name === agent)) {
      return { status: 400, json: { error: `agent must be one of ${DEMO_ROSTER_AGENTS.map((a) => a.name).join(", ")}` } };
    }
    const goal = (b.goal ?? "").trim();
    if (!goal) return { status: 400, json: { error: "goal is required" } };
    const id = nid("asst-handoff");
    const goalId = nid("demo-goal");
    const runId = nid("demo-run");
    const ts = now();
    HANDOFFS.push({
      id, tenantId, threadId, ownerUserId: userId, agent, goalText: goal, goalId, runId,
      status: "ok", outcome: `(demo) ${agent} handled: ${goal}`, errorKind: null, approvalId: null,
      createdAt: ts, updatedAt: ts,
    });
    return { status: 201, json: { id, goalId, status: "ok" } };
  }

  const handoffListM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/handoffs$/);
  if (handoffListM && m === "GET") {
    const [, tenantId, threadId] = handoffListM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    const rows = HANDOFFS.filter((h) => h.threadId === threadId && h.tenantId === tenantId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return ok(rows.map(pubHandoff));
  }

  // ── T4 (ASST-23, §7.2) — confirm/dismiss: the owner's confirm chip ─────────────────────────────────
  // Mirrors `write-intents.ts`'s single-winner claim (single-threaded here, so "claim" is just "find
  // the still-draft row and flip it") and its idempotent-replay/typed-conflict shape. **ONE
  // deliberate demo-only simplification, stated so it reads as a choice, not an accident**: the real
  // backend's `confirmWriteIntent` files a `pending` approval and a HUMAN elsewhere decides it later
  // (D14); demo mode has no second "decide" surface to fake for THIS specific approval shape without
  // duplicating the whole automation-approvals demo store (`demoFixtures.ts`'s own
  // `AUTOMATION_APPROVALS`, a much larger, unrelated fixture this ticket deliberately does not
  // touch). So confirming a demo write resolves IMMEDIATELY to a terminal approval shape — the SAME
  // "resolves instantly, no fake async loop" convention `DemoHandoff` already uses for handoffs,
  // applied here for the identical reason — rather than faking the out-of-band decision itself.
  //
  // WHICH terminal shape is decided by `intent.demoOutcome` (pinned at draft time from the drafting
  // message's own text — see this file's header above `DemoWriteOutcome`), not hardcoded to
  // `executed` as it was before: this is what makes `rejected`/`execution_failed`/`cancelled`
  // reachable by an actual propose->confirm click in a real browser (FE-verification gap #2,
  // 2026-08-06), not merely by `ProposalCard.test.tsx`'s constructed-props cases. This is enough to
  // drive the full card lifecycle (`awaiting_confirmation -> sent_for_approval` (visible for one tick
  // in the response below, in case a caller inspects it) `-> <terminal>`) end to end in
  // DEMO_MODE/e2e; the "a HUMAN decides out of band" half of the story (a DIFFERENT actor making the
  // decision after filing, rather than it being pre-baked into the draft) is proven against the LIVE
  // stack (T5), not here.
  const confirmWriteM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/tool-calls\/([^/]+)\/confirm$/);
  if (confirmWriteM && m === "POST") {
    const [, tenantId, threadId, callId] = confirmWriteM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    reapExpiredIntentsDemo(threadId);
    const intent = WRITE_INTENTS.find((wi) => wi.toolCallId === callId && wi.threadId === threadId);
    if (!intent) return { status: 404, json: { error: "no write proposal found for this tool call" } };
    if (intent.status !== "draft") {
      if (intent.status === "filed") {
        // Idempotent replay/double-click — the row already reached THIS action's target state.
        const approval = intent.approvalId ? WRITE_APPROVALS.find((a) => a.id === intent.approvalId) ?? null : null;
        return ok({
          intentId: intent.id, status: "filed", approvalId: intent.approvalId,
          approval: approval ? { status: approval.status, executionStatus: approval.executionStatus, executionError: approval.executionError } : null,
        });
      }
      return { status: 409, json: { error: `cannot confirm: this write proposal is '${intent.status}'`, status: intent.status } };
    }
    const approvalId = nid("demo-approval");
    const outcome = demoApprovalOutcomeFor(intent.demoOutcome);
    WRITE_APPROVALS.push({ id: approvalId, tenantId, toolName: intent.toolName, ...outcome });
    intent.status = "filed";
    intent.approvalId = approvalId;
    intent.toolArgs = null; // scrubbed the instant the row leaves 'draft', in every direction
    return ok({ intentId: intent.id, status: "filed", approvalId, approval: outcome });
  }

  const dismissWriteM = p.match(/^\/api\/([^/]+)\/assistant\/threads\/([^/]+)\/tool-calls\/([^/]+)\/dismiss$/);
  if (dismissWriteM && m === "POST") {
    const [, tenantId, threadId, callId] = dismissWriteM;
    const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
    if (!thread || thread.ownerUserId !== userId) return { status: 404, json: { error: "thread not found" } };
    reapExpiredIntentsDemo(threadId);
    const intent = WRITE_INTENTS.find((wi) => wi.toolCallId === callId && wi.threadId === threadId);
    if (!intent) return { status: 404, json: { error: "no write proposal found for this tool call" } };
    if (intent.status !== "draft") {
      if (intent.status === "dismissed") return ok({ intentId: intent.id, status: "dismissed", approvalId: null, approval: null });
      return { status: 409, json: { error: `cannot dismiss: this write proposal is '${intent.status}'`, status: intent.status } };
    }
    intent.status = "dismissed";
    intent.toolArgs = null;
    return ok({ intentId: intent.id, status: "dismissed", approvalId: null, approval: null });
  }

  // ── ASST-18: capabilities panel + empty-state cards ─────────────────────────────────────────────
  // A small, fixed set standing in for `visibleToolsFor(user) ∩ module gates` — no per-user Cerbos
  // decision to fake here (this is demo mode, not a backend), so every demo identity sees the same
  // list. `hubConfigured: true` — the demo fixture is itself the "configured and answering" case;
  // the "not configured"/"unreachable" states are exercised by the live-backend tests instead.
  const capabilitiesM = p.match(/^\/api\/([^/]+)\/assistant\/capabilities$/);
  if (capabilitiesM && m === "GET") {
    return ok({
      tools: [
        { name: "projects.list", description: "List projects", module: null },
        { name: "tasks.list", description: "List tasks", module: null },
        { name: "clients.list", description: "List clients", module: null },
        { name: "agency.pendingApprovals", description: "Approvals waiting for a decision", module: "agency" },
      ],
      hubConfigured: true,
      // T4 (ASST-23, §7.4) — the composer's tools-mode agent picker source. Real endpoint sources
      // this from `broker.ts`'s own `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS`; demo mode
      // has no broker, so `DEMO_TOOL_AGENTS` stands in (defined near this file's other demo-roster
      // constants).
      toolAgents: DEMO_TOOL_AGENTS,
    });
  }

  // ── ASST-18: citation resolution ─────────────────────────────────────────────────────────────────
  // Mirrors citations.ts's own narrow, honest contract: resolves the handful of demo refs a demo
  // knowledge-grounded reply might cite, 404s everything else — a demo build must not fabricate a
  // link for a ref it cannot really resolve either.
  const citationM = p.match(/^\/api\/([^/]+)\/assistant\/citations\/([^/]+)$/);
  if (citationM && m === "GET") {
    const ref = decodeURIComponent(citationM[2]);
    // ASST-22 — extended with real `demoFixtures.ts`/`demoMeetings.ts` ids (not the illustrative
    // `demo-project-1`/`demo-client-1` placeholders below, kept for back-compat) so the `@drawer`
    // mount's page-context pin — built from the ACTUAL demo page you're standing on
    // (`lib/assistantContext.ts::derivePageContextRef`) — resolves to something real under
    // DEMO_MODE, not a 404, on `/projects/p-web-1`, `/tasks/t-4`, `/clients/cl-1`, and
    // `/people/u-pm`. Tenant id `co-agency` matches every seeded demo identity's active company.
    const known: Record<string, { kind: string; label: string; href: string }> = {
      "erp:project:demo-project-1": { kind: "project", label: "Demo Project", href: "/projects/demo-project-1" },
      "erp:client:demo-client-1": { kind: "client", label: "Demo Client", href: "/clients/demo-client-1" },
      "erp:project:p-web-1": { kind: "project", label: "Client site redesign", href: "/projects/p-web-1" },
      "erp:task:t-4": { kind: "task", label: "Wire homepage hero", href: "/tasks/t-4" },
      "erp:client:cl-1": { kind: "client", label: "Northwind Traders", href: "/clients/cl-1" },
      "erp:person:co-agency:u-pm": { kind: "person", label: "Dewi Santoso", href: "/people/u-pm" },
    };
    const resolved = known[ref];
    if (!resolved) return { status: 404, json: { error: "this citation has no resolvable destination" } };
    return ok(resolved);
  }

  return null;
}

// ============================================================== The SSE stream (demo mode only) ====
// `demoAssistantStreamBody` is called directly by the Next.js proxy route
// (`app/api/assistant/threads/[id]/stream/route.ts`) when DEMO_MODE=1 — NOT through
// `getDemoResponse`, which only knows how to answer JSON. It echoes the preceding user message back
// word-by-word as `token` events, in the exact wire format `sseLine()` produces on the real backend
// (`event: <name>\ndata: <json>\n\n`), so the client-side parser in `lib/assistant.ts` exercises the
// real framing even with no backend running.
//
// TWO DELIBERATE TEST HOOKS, both triggered by literal text in the SENT message (so they're drivable
// from the Composer with no dev-tools):
//   - a message containing "STALL_TEST" never emits `done`/`error` and never closes the stream on its
//     own — this is what proves the client's 120s idle-timeout+AbortController path (ASST-07's own
//     acceptance criterion: "a stalled stream shows a visible error after the idle timeout, not a
//     forever-spinner") without needing a real hung upstream to reproduce it.
//   - a message containing "ERROR_TEST" ends the stream with `event: error` immediately, to prove the
//     UI renders a stream failure as an error bubble rather than a silently-completed one.
//
// STOP support: rather than a separate cancellation registry, each loop iteration re-reads the
// message row from the store. `assistantDemo`'s `stop` handler finalizes that row (content set,
// errorKind='stopped') — the generator notices on its NEXT tick and closes without emitting `done`,
// which is exactly the real backend's behavior (a stop mid-generation never reaches the `done` path).
function findPendingRow(threadId: string, messageId: string): DemoMessage | undefined {
  return MESSAGES.find((m) => m.id === messageId && m.threadId === threadId && m.role === "assistant" && m.content === null && m.errorKind === null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function demoAssistantStreamBody(tenantId: string, threadId: string, messageId: string): ReadableStream<Uint8Array> | null {
  const thread = THREADS.find((t) => t.id === threadId && t.tenantId === tenantId);
  if (!thread) return null;
  const placeholder = findPendingRow(threadId, messageId);
  if (!placeholder) return null;
  const userMsg = MESSAGES.find((msg) => msg.threadId === threadId && msg.seq === placeholder.seq - 1 && msg.role === "user");
  const sourceText = (userMsg?.content ?? "").trim();
  const encoder = new TextEncoder();
  // ASST-17/T4 — read the turn mode off the ROW, exactly like the real relay/broker does (see
  // `readTurnModeDemo`'s own header) — never off anything client-supplied at stream-open time.
  const turnMode = readTurnModeDemo(placeholder.parts);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (line: string) => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          // controller already closed (client aborted) — nothing left to do.
        }
      };

      // ── T4 (ASST-23, §7.4) — THE TOOL-TURN SIMULATION. Deliberately its own branch, checked
      // first: a tools-mode turn never falls through to the plain-chat echo below (and the
      // ERROR_TEST/STALL_TEST hooks are plain-chat-only test affordances, not meaningful here). ────
      if (turnMode) {
        const agentDef = DEMO_TOOL_AGENTS.find((a) => a.name === turnMode.agent);
        const readTool = agentDef?.tools[0] ?? "projects.list";
        const readCallId = nid("asst-toolcall");
        TOOL_CALLS.push({
          id: readCallId, tenantId, messageId, toolName: readTool, mcpServer: "mcp-hub",
          args: {}, resultSummary: null, status: "succeeded", createdAt: now(),
        });
        enqueue(`event: tool_call\ndata: ${JSON.stringify({ callId: readCallId, toolName: readTool, args: {} })}\n\n`);
        await sleep(120);
        enqueue(`event: tool_result\ndata: ${JSON.stringify({ callId: readCallId, toolName: readTool, status: "succeeded", summary: null })}\n\n`);

        let finalText: string;
        let errorKind: string | null = null;
        const writeTool = agentDef?.writeTools[0];
        if (writeTool) {
          // A write-capable agent (`task-filer`) drafts a write EVERY turn — deterministic and
          // drivable with no need to parse the user's message for intent (a demo fixture, not an
          // LLM). Real args live ONLY in the intent row (§7.2.4's custody chain); the ledger row
          // and the wire both ever see the REDACTED copy.
          const realArgs: Record<string, unknown> = writeTool === "pm.createTask"
            ? { projectId: "demo-project-1", title: sourceText || "Untitled task", assigneeId: "demo-hansel" }
            : { projectId: "demo-project-1", title: sourceText || "Untitled doc" };
          const redactedArgs = demoRedactArgs(realArgs);
          const writeCallId = nid("asst-toolcall");
          const intentId = nid("asst-intent");
          const expiresAt = new Date(Date.now() + ASSISTANT_INTENT_TTL_MS).toISOString();
          TOOL_CALLS.push({
            id: writeCallId, tenantId, messageId, toolName: writeTool, mcpServer: "mcp-hub",
            args: redactedArgs, resultSummary: "awaiting your confirmation before this is sent for approval",
            status: "pending", createdAt: now(),
          });
          WRITE_INTENTS.push({
            id: intentId, tenantId, threadId, toolCallId: writeCallId, ownerUserId: thread.ownerUserId,
            agent: turnMode.agent, toolName: writeTool, toolArgs: realArgs, impact: "high",
            status: "draft", approvalId: null, expiresAt, demoOutcome: pickDemoWriteOutcome(sourceText),
          });
          enqueue(`event: confirm_required\ndata: ${JSON.stringify({ callId: writeCallId, toolName: writeTool, intentId, args: redactedArgs, impact: "high", expiresAt })}\n\n`);
          finalText = `I've drafted a ${writeTool} write. Confirm it to send it for approval, or dismiss it — nothing has been changed or sent yet.`;
          errorKind = "confirm_required";
        } else {
          finalText = `(demo) Using ${readTool}, here's what I found: 3 open projects, 12 open tasks assigned to you.`;
        }

        enqueue(`event: meta\ndata: ${JSON.stringify({ provider: "agent-runner", model: "" })}\n\n`);
        enqueue(`event: token\ndata: ${JSON.stringify({ text: finalText })}\n\n`);
        const toolTokens = Math.max(1, Math.ceil(finalText.length / 4));
        enqueue(`event: usage\ndata: ${JSON.stringify({ tokens: toolTokens, latencyMs: 0, source: "estimate" })}\n\n`);
        if (errorKind) {
          enqueue(`event: error\ndata: ${JSON.stringify({ error: finalText, errorKind })}\n\n`);
        } else {
          enqueue(`event: done\ndata: {}\n\n`);
        }
        placeholder.content = finalText;
        placeholder.tokens = toolTokens;
        placeholder.errorKind = errorKind;
        // The turn_mode part this row was created with (see `sendMessage`'s POST handler) is
        // preserved — only the fields a REAL turn would also update are touched here.
        thread.totalTokens += toolTokens;
        thread.lastMessageAt = now();
        thread.updatedAt = now();
        controller.close();
        return;
      }

      if (/ERROR_TEST/i.test(sourceText)) {
        await sleep(250);
        enqueue(`event: error\ndata: ${JSON.stringify({ error: "Demo-forced failure (message contained ERROR_TEST).", errorKind: "upstream_error" })}\n\n`);
        placeholder.content = "";
        placeholder.errorKind = "upstream_error";
        controller.close();
        return;
      }
      if (/STALL_TEST/i.test(sourceText)) {
        // Deliberately never emits done/error and never closes — see header. The client's own
        // 120s idle timer (or the user hitting Stop) is what ends this, exercised by ASST-07's
        // idle-timeout acceptance test.
        return;
      }

      const reply =
        `You said: "${sourceText || "(nothing)"}"\n\n` +
        "This is a demo-mode reply, streamed word by word so the composer, stop button, and " +
        "incremental rendering are all exercisable with no backend running. It includes a fenced " +
        "code block to prove multi-paragraph + code-fence markdown renders correctly:\n\n" +
        "```ts\nfunction hello(name: string): string {\n  return `Hello, ${name}!`;\n}\n```\n\n" +
        "Refreshing the page replays this exact transcript from the demo store.";
      const parts = reply.split(/(\s+)/).filter((s) => s.length > 0);

      for (const part of parts) {
        const row = findPendingRow(threadId, messageId);
        if (!row) {
          // Stopped externally (POST .../stop already finalized the row: content=partial,
          // errorKind='stopped') — emit the SAME terminal `error` event the real backend's
          // `relayGeneration` sends on an explicit stop (docs/FRONTEND-BFF-CONTRACT.md §18), rather
          // than just closing the socket. Closing with no event at all is indistinguishable, on the
          // wire, from `abnormal_drop` — a bug this fix caught: the FIRST live drive of the Stop
          // button showed "connection ended before the reply finished" instead of "Stopped."
          enqueue(`event: error\ndata: ${JSON.stringify({ error: "Stopped.", errorKind: "stopped" })}\n\n`);
          controller.close();
          return;
        }
        row.partial += part;
        enqueue(`event: token\ndata: ${JSON.stringify({ text: part })}\n\n`);
        await sleep(30);
      }

      const row = findPendingRow(threadId, messageId);
      if (!row) {
        enqueue(`event: error\ndata: ${JSON.stringify({ error: "Stopped.", errorKind: "stopped" })}\n\n`);
        controller.close();
        return;
      }
      const finalText = row.partial;
      const tokensEstimate = Math.max(1, Math.ceil(finalText.length / 4));
      const latencyMs = parts.length * 30;
      row.content = finalText;
      row.tokens = tokensEstimate;
      row.latencyMs = latencyMs;
      thread.totalTokens += tokensEstimate;
      thread.lastMessageAt = now();
      thread.updatedAt = now();
      enqueue(`event: usage\ndata: ${JSON.stringify({ tokens: tokensEstimate, latencyMs })}\n\n`);
      enqueue(`event: done\ndata: {}\n\n`);
      controller.close();
    },
  });
}
