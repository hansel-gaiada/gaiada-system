// ASST-07 — pure, client-safe core of the `/assistant` workspace. No I/O, no "server-only": this
// file is imported by BOTH server code (lib/assistant-data.ts, lib/assistantActions.ts) and client
// components (components/assistant/*), so it must stay importable from the browser bundle.
//
// Field names mirror platform-nest's `modules/assistant/assistant.controller.ts` response shapes
// byte-for-byte (camelCase) — see docs/FRONTEND-BFF-CONTRACT.md §18. Do not rename without checking
// that controller first; a renamed field here is exactly the "frontend-first drift" bug class
// CLAUDE.md warns about (reads a field the backend never sends).
//
// ── WHY THE REDUCER STAYS PURE AND THE SMOOTHER LIVES IN THE RENDER LAYER ──────────────────────────
// The ticket asks for both a pure reducer (aivory's `agenticReducer` shape: guards for malformed/
// duplicate/orphaned events, immutable transitions) AND a typewriter smoother over real deltas
// (aivory's `typewriterStream`). Those two want different things from time: the reducer must be a
// deterministic fold with no timers so it stays testable and replayable; the smoother wants to hold
// per-frame animation state (a `requestAnimationFrame` id, a "how far have we revealed" cursor) that
// has no business inside a reducer. Resolution: `streamReducer` below only ever accumulates the TRUE
// text (the reducer's `text` field always equals every token concatenated, instantly) — smoothing is
// a presentation-only interpolation from `text` down to a slower-revealed `displayText`, owned by
// `useTypewriter` (components/assistant/useAssistantStream.ts), which never mutates or reads back
// into the reducer. The reducer is the source of truth; the smoother is a lag applied on top of it.

// ============================================================== Thread/message shapes ==============

export type AssistantThreadStatus = "active" | "archived";

export interface AssistantThread {
  id: string;
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

export type AssistantMessageRole = "user" | "assistant" | "tool" | "system";

export interface AssistantMessage {
  id: string;
  seq: number;
  role: AssistantMessageRole;
  // NULL + errorKind===null is the backend's "pending placeholder" signal (no separate status
  // column, see assistant.controller.ts's file header) — a generation for this row is either still
  // running somewhere, or was abandoned (e.g. the tab closed mid-stream on a stale row that never
  // got a stop). Never render null content as an empty reply.
  content: string | null;
  parts: unknown;
  provider: string | null;
  model: string | null;
  tokens: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  createdAt: string;
  // T4 (ASST-23, §7.4/T3a+T3b) — additive, GET-thread-only field (never present on an optimistic
  // local/placeholder message this UI constructs itself — see AssistantWorkspace's `handleSend`).
  // `undefined` and `[]` mean the same thing ("nothing to render") everywhere this is read; kept
  // optional rather than defaulted at every construction site so the existing optimistic-message
  // literals don't all need editing for a field they can never actually populate themselves.
  toolCalls?: ThreadToolCall[];
}

// ============================================================== ASST-23/T3a+T3b: tool-call ledger ===
// Mirrors platform-nest's `ThreadToolCall` (assistant.controller.ts) byte-for-byte — see
// docs/FRONTEND-BFF-CONTRACT.md §18's "T3a"/"T3b" addenda. THE TRAP (stated once, load-bearing):
// `approvalId` reads `null` for TWO different reasons — a plain read/refusal that was never a write
// proposal at all, AND a drafted write that hasn't been confirmed (filed) yet. Never branch card
// state on `approvalId` alone; `deriveProposalCardState` below reads `intent` first, `approval`
// second, and only falls back to "not a proposal" when BOTH are null — that ordering IS the fix for
// the trap, not a style choice.
export interface ToolCallApprovalJoin {
  status: string; // 'pending' | 'approved' | 'rejected' | 'cancelled'
  executionStatus: string; // 'pending' | 'executing' | 'executed' | 'failed' | 'not_applicable'
  executionError: string | null;
}

export type WriteIntentStatus = "draft" | "filed" | "dismissed" | "expired";

export interface ToolCallIntentJoin {
  status: WriteIntentStatus;
  expiresAt: string;
}

/** The shape both `ThreadToolCall` (persisted, GET thread) and `LiveToolCall` (in-flight, SSE)
 *  satisfy — the common input `deriveProposalCardState` reads, so one function works for a card
 *  rendered mid-stream and the SAME card re-rendered from the reload-joined state after. */
export interface ProposalJoinable {
  approval: ToolCallApprovalJoin | null;
  intent: { status: WriteIntentStatus } | null;
}

export interface ThreadToolCall extends ProposalJoinable {
  id: string;
  toolName: string;
  mcpServer: string | null;
  /** Always the REDACTED shape (`redactToolArgs` on the backend) — shape-only, never a real value.
   *  See `formatRedactedArgs` for how this renders. */
  args: unknown;
  resultSummary: string | null;
  status: string; // 'succeeded' | 'failed' | 'denied' | 'pending'
  approvalId: string | null;
  durationMs: number | null;
  createdAt: string;
  intent: ToolCallIntentJoin | null;
}

export interface ThreadListResult { items: AssistantThread[]; total: number }
export interface ThreadDetailResult { thread: AssistantThread; messages: AssistantMessage[]; hasMoreMessages: boolean }

// ── ASST-16 — the right-rail brain picker's option list ────────────────────────────────────────────
// `brainProvider` (stored, PATCHable via the existing thread PATCH endpoint) is sent to
// ai-gateway-go's `/complete/stream` as an optional `provider` HINT (ASST-15) — never a hard
// requirement (OQ-6: a down/unavailable hinted provider silently falls through to the gateway's
// normal failover chain; the "served by" badge on `Message` always shows the ACTUAL server, which
// may legitimately differ from what's picked here). `null`/"Auto" means "no hint — let the chain
// pick", the pre-ASST-16 default behaviour, byte-identical to before this ticket.
export interface BrainOption { value: string | null; label: string }
export const BRAIN_OPTIONS: BrainOption[] = [
  { value: null, label: "Auto (failover chain)" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "hermes", label: "Hermes" },
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude" },
];

export function brainOptionLabel(value: string | null): string {
  return BRAIN_OPTIONS.find((o) => o.value === value)?.label ?? (value ?? "Auto (failover chain)");
}
export interface SendMessageResult { messageId: string; streamUrl: string }
export interface StopResult { ok: boolean; stopped: boolean }

export function threadTitle(t: Pick<AssistantThread, "title">): string {
  return t.title?.trim() || "New chat";
}

// ── Auto-titling (owner complaint: every row in the rail reads "New chat") ─────────────────────────
// FE-derived from the thread's first user message, chosen over a backend-generated summary title:
// a summary would read better, but it costs an LLM call per thread AND a platform-nest change
// (a new field/endpoint), whereas this is a pure client-side reshape of text the UI already has the
// instant the first message is sent — see AssistantWorkspace's `handleSend` for where this is
// called (only when the thread's `title` is still null; the rename pencil in ThreadRail always
// wins once a title — derived or explicit — exists, this function never re-fires after that).
const THREAD_TITLE_MAX = 60;

/** Collapses whitespace (a pasted multi-line brief must not become a garbled title) and truncates
 *  on a word boundary rather than mid-word. Returns `null` for empty/whitespace-only input so a
 *  thread whose first "message" was blank stays untitled — `threadTitle` above already renders
 *  that as "New chat", the correct fallback; this function must never hand back an empty string
 *  masquerading as a real title. */
export function deriveThreadTitle(rawText: string): string | null {
  const collapsed = rawText.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= THREAD_TITLE_MAX) return collapsed;
  const cut = collapsed.slice(0, THREAD_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  // Only break on a word boundary if that leaves a reasonable amount of text — a single very long
  // first "word" (a pasted URL/token) should still be truncated at the character limit rather than
  // left uncut or chopped down to almost nothing.
  const boundary = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${boundary.trimEnd()}…`;
}

/** A message row that is still generating (no content yet, no terminal error yet). */
export function isPendingMessage(m: Pick<AssistantMessage, "content" | "errorKind">): boolean {
  return m.content === null && m.errorKind === null;
}

// ============================================================== ASST-12: provider badge + cost meter
// `provider`/`model` come straight off the message row (platform-nest fills them from ASST-11's
// `meta` frame — see assistant.controller.ts; null means the gateway never announced a serving
// provider for this reply, the honest common-path state, never an error). `usageSource` is NOT a
// message column — it is read out of the EXISTING `parts` jsonb (see stream.ts's `usageMetaParts`,
// the single source of truth for this shape) rather than re-derived here, per the ticket's own
// "usageSource ... drives the label (not re-derived in the UI)" requirement.

/** Mirrors platform-nest's `UsageMetaPart` (stream.ts) byte-for-byte. */
export interface UsageMetaPart {
  type: "usage_meta";
  usageSource: "provider" | "estimate";
  promptTokens?: number;
  completionTokens?: number;
}

function isUsageMetaPart(v: unknown): v is UsageMetaPart {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "usage_meta"
    && ((v as { usageSource?: unknown }).usageSource === "provider" || (v as { usageSource?: unknown }).usageSource === "estimate");
}

/** Reads the persisted usage-source annotation out of a message's `parts` column. Returns `null`
 *  for a message that predates ASST-12 (or never got a terminal outcome yet) — callers must treat
 *  that the same as "estimate, no breakdown", never as an error. */
export function parseUsageMeta(parts: unknown): UsageMetaPart | null {
  if (!Array.isArray(parts)) return null;
  return parts.find(isUsageMetaPart) ?? null;
}

// ASST-18 — reads the persisted citation list back out of a message's `parts` column, mirroring
// platform-nest's `CitationsPart` (stream.ts) byte-for-byte, the same "read, never re-derive"
// discipline `parseUsageMeta` below already established for usage metadata.
interface CitationsPart {
  type: "citations";
  items: AssistantCitation[];
}

function isCitationsPart(v: unknown): v is CitationsPart {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "citations" && Array.isArray((v as { items?: unknown }).items);
}

/** Returns `[]` (never `null`) for a message with no citations — a plain chat turn and a
 *  knowledge-grounded turn with zero relevant hits render identically (no chips), which is the
 *  correct behaviour (see context.ts's own header on why those two cases are not distinguished). */
export function parseCitations(parts: unknown): AssistantCitation[] {
  if (!Array.isArray(parts)) return [];
  const found = parts.find(isCitationsPart);
  return found?.items ?? [];
}

// ASST-24 — reads the persisted "Hermes couldn't resume the previous conversation and started a
// new one" fact back out of a message's `parts` column, mirroring platform-nest's
// `SessionResumeMismatchPart` (stream.ts) byte-for-byte — the same "read, never re-derive"
// discipline `parseUsageMeta`/`parseCitations` above already established. There is NO live-stream
// counterpart (unlike `meta`/`citations`): the backend's own `session` event is deliberately not
// relayed onto the browser-facing SSE wire (assistant.controller.ts's `session: () => {}`), so
// this part — read after the transcript reload that follows every terminal stream state — is the
// ONLY way this fact ever reaches the UI. That is fine: it is an informational note about what
// already happened, not something that needs to appear mid-generation.
export interface SessionResumeMismatchPart {
  type: "session_resume_mismatch";
  requestedSession: string;
}

function isSessionResumeMismatchPart(v: unknown): v is SessionResumeMismatchPart {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "session_resume_mismatch";
}

/** Returns `null` for every message that ISN'T a known, real resume mismatch — that covers a
 *  genuine resume, turn 1 (nothing requested), an older gateway that never reported the fields at
 *  all, and any message that predates ASST-24. All four cases render identically (nothing), by
 *  design (see docs/FRONTEND-BFF-CONTRACT.md §18's "ASST-24" addendum: absent must be treated as
 *  "unknown/assume fine", never as a failure). */
export function parseSessionResumeMismatch(parts: unknown): SessionResumeMismatchPart | null {
  if (!Array.isArray(parts)) return null;
  return parts.find(isSessionResumeMismatchPart) ?? null;
}

/** The "served by" brain badge label. `provider === null` (no `meta` ever arrived — an older
 *  gateway, or a provider that died before committing bytes) renders as "Unknown provider", never
 *  as blank or an error. `model === ""` (a provider with no fixed-model concept, e.g. `echo`)
 *  renders as "unknown model" — a truthful absence, not a broken value. */
export function brainBadgeLabel(provider: string | null, model: string | null): string {
  if (!provider) return "Unknown provider";
  const modelLabel = model && model.trim() ? model : "unknown model";
  return `${provider} · ${modelLabel}`;
}

/** The cost-meter label: a token count plus which KIND of number it is. `usageSource` distinguishes
 *  a real provider-reported measurement from the ~4-chars/token estimate — this is the whole point
 *  of the ticket (never present an estimate as if it were a measurement). Returns `null` when there
 *  is nothing to show yet (no tokens recorded). */
export function usageMeterLabel(tokens: number | null, usageSource: "provider" | "estimate" | null): string | null {
  if (tokens === null) return null;
  const measured = usageSource === "provider";
  return `${tokens} token${tokens === 1 ? "" : "s"} (${measured ? "measured" : "estimated"})`;
}

// ============================================================== Left-rail: search + date grouping ==
// Lifted from aivory's useConversationHistory/ConversationHistory (Today/Yesterday/Last 7 Days/
// Older, pinned split into its own bucket) — see docs/blueprints/assistant-foundation.md §8's
// reference-implementation table. Client-side only (the rail's initial + refresh loads already fetch
// the owner's full thread set in one page; see ThreadRail's header comment for why no per-keystroke
// server round trip is worth it here).

export type ThreadDateGroup = "Today" | "Yesterday" | "Last 7 Days" | "Older";
export const THREAD_DATE_GROUPS: ThreadDateGroup[] = ["Today", "Yesterday", "Last 7 Days", "Older"];

export interface GroupedThreads {
  pinned: AssistantThread[];
  groups: { label: ThreadDateGroup; threads: AssistantThread[] }[];
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export function groupThreads(threads: AssistantThread[], now: Date = new Date()): GroupedThreads {
  const pinned = threads.filter((t) => t.pinned);
  const rest = threads.filter((t) => !t.pinned);

  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const buckets: Record<ThreadDateGroup, AssistantThread[]> = { Today: [], Yesterday: [], "Last 7 Days": [], Older: [] };
  for (const t of rest) {
    const raw = t.lastMessageAt ?? t.createdAt;
    const parsed = new Date(raw);
    const day = Number.isNaN(parsed.getTime()) ? today : startOfDay(parsed);
    if (day.getTime() === today.getTime()) buckets.Today.push(t);
    else if (day.getTime() === yesterday.getTime()) buckets.Yesterday.push(t);
    else if (day.getTime() > sevenDaysAgo.getTime()) buckets["Last 7 Days"].push(t);
    else buckets.Older.push(t);
  }
  return { pinned, groups: THREAD_DATE_GROUPS.map((label) => ({ label, threads: buckets[label] })) };
}

/** Client-side substring filter over an already-loaded thread list (title only — the same field the
 *  backend's own `q` search matches on). */
export function filterThreads(threads: AssistantThread[], query: string): AssistantThread[] {
  const q = query.trim().toLowerCase();
  if (!q) return threads;
  return threads.filter((t) => threadTitle(t).toLowerCase().includes(q));
}

// ============================================================== SSE wire parsing (pure) ============
// The wire format is pinned by platform-nest's `sseLine()` (modules/assistant/stream.ts): every block
// is `event: <name>\ndata: <one-line JSON>\n\n`. This parses raw bytes-as-text into blocks; decoding
// each block's JSON into our typed client event is a separate, equally pure step below — kept apart
// so a wire-framing bug and a payload-shape bug fail two different unit tests, not one.

export interface RawSSEBlock { event: string; data: string }

/** Splits a growing text buffer on the blank-line block terminator. Returns every COMPLETE block
 *  found plus whatever partial text remains (to be prepended to the next chunk). Never throws — an
 *  unparseable block (no `data:` line) is simply omitted, since a comment-only block (`: ping`) is
 *  valid SSE and carries nothing for us to act on. */
export function parseSSEBuffer(buffer: string): { blocks: RawSSEBlock[]; rest: string } {
  const blocks: RawSSEBlock[] = [];
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx !== -1) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // everything else (":" comments, blank continuation) carries no payload for this wire.
    }
    if (dataLines.length > 0) blocks.push({ event, data: dataLines.join("\n") });
    idx = rest.indexOf("\n\n");
  }
  return { blocks, rest };
}

// ASST-18 — one knowledge-grounding hit. `text` is the chunk snippet that grounded the answer;
// no `score` on the wire/persisted shape (see stream.ts's `citationParts` header — a ranking
// signal for that ONE turn's retrieval, not something a rendered chip needs to carry forward).
export interface AssistantCitation {
  sourceRef: string;
  text: string;
}

export type ClientStreamEvent =
  | { type: "token"; text: string }
  // ASST-12 — relays ASST-11's `meta` the instant it arrives (before any token), so a
  // live-streaming reply can show "served by <provider>" without waiting for the reply to
  // finish — this is the "silent failover is invisible" gap the ticket exists to close.
  // `model` may legitimately be `""` (a provider with no fixed-model concept, e.g. `echo`) —
  // that is a truthful absence carried through as-is, never coerced.
  | { type: "meta"; provider: string; model: string }
  // `source` says whether `tokens` is a REAL provider-reported count (`"provider"`, only when
  // ASST-11's real `usage` frame arrived — today: `ollama` only) or the ~4-chars/token estimate
  // (`"estimate"`, the common case: absent on every other provider and on every error path).
  // `promptTokens`/`completionTokens` are only ever set alongside `source === "provider"`.
  | { type: "usage"; tokens: number; latencyMs: number; source: "provider" | "estimate"; promptTokens?: number; completionTokens?: number }
  // ASST-18 — arrives once, before the first token (context assembly, including retrieval, has
  // already finished by the time the stream opens at all). Absent entirely on a turn that used no
  // RAG grounding — never an empty-items frame (mirrors platform-nest's `citationParts`).
  | { type: "citations"; items: AssistantCitation[] }
  // ── T4 (ASST-23, §7.4) — the tool-turn frames. Until this ticket these all decoded to `null`
  // (pinned by lib/assistant.test.ts's old ":105" case) — ASST-17/T3a/T3b made them real, on the
  // tool-turn path only; a plain chat turn's wire never emits any of these four. ──────────────────
  // `{callId, toolName, args}` — `args` is ALWAYS the redacted shape (never a real value; see
  // `formatRedactedArgs`).
  | { type: "tool_call"; callId: string; toolName: string; args: unknown }
  | { type: "tool_result"; callId: string; toolName: string; status: "succeeded" | "failed" | "denied"; summary: string | null }
  // The LEGACY/defensive shape (broker.ts: a write that got filed at turn time — never this
  // ticket's normal chat-path outcome, see `confirm_required` below — but still real: a handoff-
  // origin suspension, or a future `fileOnSuspend:true` caller). `impact` is `null`-tolerant (the
  // approval row's own `impact` column can, in principle, be absent).
  | { type: "approval_required"; callId: string; toolName: string; approvalId: string; impact: string | null }
  // T3b (§7.2.7) — the owner's confirm-chip draft. `args` is REDACTED (the real args live only in
  // `assistant_write_intents.tool_args`, server-side, keyed by `intentId` — never sent to the
  // browser). This is the NORMAL suspended-write outcome on the chat path today.
  | { type: "confirm_required"; callId: string; toolName: string; intentId: string; args: unknown; impact: string; expiresAt: string }
  | { type: "done" }
  | { type: "error"; error: string; errorKind: string };

/** Decodes one raw SSE block into our typed event, or `null` on anything malformed/unrecognised —
 *  the guard clause aivory's `agenticReducer` uses for "skip malformed events", applied one layer
 *  earlier (at decode time rather than inside the reducer) so the reducer itself never has to
 *  distrust its input shape. */
export function decodeAssistantEvent(block: RawSSEBlock): ClientStreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(block.data);
  } catch {
    return null;
  }
  const obj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  switch (block.event) {
    case "token":
      return typeof obj.text === "string" ? { type: "token", text: obj.text } : null;
    case "meta":
      // Absent-tolerant by construction: a malformed/partial meta block simply decodes to `null`
      // and is dropped by the caller's guard (same as any other unrecognised block) — the badge
      // stays "unknown provider" rather than throwing.
      return typeof obj.provider === "string" && typeof obj.model === "string"
        ? { type: "meta", provider: obj.provider, model: obj.model }
        : null;
    case "usage": {
      const tokens = Number(obj.tokens);
      const latencyMs = Number(obj.latencyMs);
      if (!Number.isFinite(tokens) || !Number.isFinite(latencyMs)) return null;
      // `source` defaults to "estimate" for an older platform-nest relay that never sends it
      // (pre-ASST-12) — absent-tolerant, never assumed "provider".
      const source: "provider" | "estimate" = obj.source === "provider" ? "provider" : "estimate";
      const promptTokens = typeof obj.promptTokens === "number" ? obj.promptTokens : undefined;
      const completionTokens = typeof obj.completionTokens === "number" ? obj.completionTokens : undefined;
      return { type: "usage", tokens, latencyMs, source, promptTokens, completionTokens };
    }
    case "citations": {
      const raw = Array.isArray(obj.items) ? obj.items : [];
      const items = raw
        .filter((it): it is { sourceRef: string; text: string } =>
          !!it && typeof it === "object" && typeof (it as { sourceRef?: unknown }).sourceRef === "string" && typeof (it as { text?: unknown }).text === "string")
        .map((it) => ({ sourceRef: it.sourceRef, text: it.text }));
      return { type: "citations", items };
    }
    // ── T4: the four tool-turn frames — each requires only the fields it renders; a block missing
    // a required field decodes to `null` (same "drop, don't throw" guard as every case above). ────
    case "tool_call": {
      const callId = str(obj.callId);
      const toolName = str(obj.toolName);
      if (!callId || !toolName) return null;
      return { type: "tool_call", callId, toolName, args: obj.args ?? {} };
    }
    case "tool_result": {
      const callId = str(obj.callId);
      const toolName = str(obj.toolName);
      const status = obj.status;
      if (!callId || !toolName || (status !== "succeeded" && status !== "failed" && status !== "denied")) return null;
      return { type: "tool_result", callId, toolName, status, summary: str(obj.summary) };
    }
    case "approval_required": {
      const callId = str(obj.callId);
      const toolName = str(obj.toolName);
      const approvalId = str(obj.approvalId);
      if (!callId || !toolName || !approvalId) return null;
      return { type: "approval_required", callId, toolName, approvalId, impact: str(obj.impact) };
    }
    case "confirm_required": {
      const callId = str(obj.callId);
      const toolName = str(obj.toolName);
      const intentId = str(obj.intentId);
      const impact = str(obj.impact);
      const expiresAt = str(obj.expiresAt);
      if (!callId || !toolName || !intentId || !impact || !expiresAt) return null;
      return { type: "confirm_required", callId, toolName, intentId, args: obj.args ?? {}, impact, expiresAt };
    }
    case "done":
      return { type: "done" };
    case "error":
      return {
        type: "error",
        error: typeof obj.error === "string" ? obj.error : "The assistant stream failed.",
        errorKind: typeof obj.errorKind === "string" ? obj.errorKind : "unknown",
      };
    default:
      // Unrecognised event name (future server addition, or a stray "message" default-event block).
      return null;
  }
}

// ============================================================== The pure stream reducer =============
// Lifted from aivory's lib/agenticReducer.ts: immutable transitions, guards for malformed/duplicate/
// orphaned events, auto-complete when the terminal event never arrives. "Auto-complete" here is one
// layer OUTSIDE this reducer on purpose — see useAssistantStream's header — because it needs to know
// the transport ENDED without a terminal event, which is a fact the reducer (which only sees events
// that were successfully decoded) cannot observe on its own; the consumer synthesizes a terminal
// `error` event for exactly that case and feeds it through this same reducer, so there is still only
// ONE place that decides what a terminal state looks like.

export type StreamStatus = "idle" | "streaming" | "done" | "error" | "stopped";

// T4 (ASST-23) — the live, in-flight view of one tool call, accumulated across the `tool_call` /
// `tool_result` / `approval_required` / `confirm_required` frames by callId. Satisfies
// `ProposalJoinable` (same as the persisted `ThreadToolCall`) so `deriveProposalCardState` renders
// a card identically whether it is reading the live SSE-accumulated state or the reload-joined one
// — see that function's own header.
export interface LiveToolCall extends ProposalJoinable {
  callId: string;
  toolName: string;
  /** Always the redacted shape off the wire — see `ThreadToolCall.args`. `undefined` only for the
   *  legacy `approval_required` frame, which carries no args at all (the row it names was already
   *  filed elsewhere; there is nothing fresh to preview). */
  args?: unknown;
  /** The plain-read/refusal outcome — `"running"` until a `tool_result` (or a suspension frame)
   *  arrives; `"pending"` for a suspended write (mirrors `ThreadToolCall.status`'s own vocabulary —
   *  the CARD state, when this is a write proposal, still comes from `intent`/`approval`, never
   *  from this field; this only drives the plain-chip rendering path). */
  status: "running" | "succeeded" | "failed" | "denied" | "pending";
  resultSummary: string | null;
  approvalId: string | null;
  impact: string | null;
  intentId: string | null;
  expiresAt: string | null;
}

export interface StreamState {
  status: StreamStatus;
  /** The TRUE accumulated text — every token concatenated, updated instantly. The typewriter
   *  smoother (render layer) lags behind this on purpose; never read this expecting animation. */
  text: string;
  /** ASST-12 — set the instant a `meta` frame arrives (before any token, per ASST-11's own
   *  ordering invariant). Null for the entire stream when the serving provider never announced
   *  itself — the honest "unknown provider" state, never an error. */
  meta: { provider: string; model: string } | null;
  usage: { tokens: number; latencyMs: number; source: "provider" | "estimate"; promptTokens?: number; completionTokens?: number } | null;
  // ASST-18 — set the instant a `citations` frame arrives (before any token, same ordering
  // guarantee as `meta`). `[]` for the entire stream when this turn used no RAG grounding — the
  // honest "nothing to cite" state, identical in rendering to "not answered yet".
  citations: AssistantCitation[];
  // T4 — accumulated in wire order, one entry per distinct `callId` seen so far (see
  // `upsertLiveToolCall`). `[]` for every plain chat turn — a tool turn's frames are the only thing
  // that ever populates this.
  toolCalls: LiveToolCall[];
  error: { message: string; kind: string } | null;
}

export function initialStreamState(): StreamState {
  return { status: "idle", text: "", meta: null, usage: null, citations: [], toolCalls: [], error: null };
}

const TERMINAL_STATUSES = new Set<StreamStatus>(["done", "error", "stopped"]);

/** Insert-or-update by `callId`, preserving arrival order for a new id and never reordering an
 *  existing one — a `tool_result` following its own `tool_call` updates the SAME card in place
 *  rather than appending a second one. */
function upsertLiveToolCall(list: LiveToolCall[], callId: string, patch: Partial<LiveToolCall>): LiveToolCall[] {
  const idx = list.findIndex((c) => c.callId === callId);
  if (idx === -1) {
    const base: LiveToolCall = {
      callId, toolName: "", args: undefined, status: "running", resultSummary: null,
      approvalId: null, impact: null, intentId: null, expiresAt: null, approval: null, intent: null,
    };
    return [...list, { ...base, ...patch }];
  }
  const next = [...list];
  next[idx] = { ...next[idx], ...patch };
  return next;
}

export function streamReducer(state: StreamState, event: ClientStreamEvent): StreamState {
  // Guard: once a stream has resolved, every later event is either a duplicate delivery or an
  // orphan from a generation this component no longer cares about (e.g. a stale abort racing a
  // fresh send) — drop it rather than resurrecting a finished bubble.
  if (TERMINAL_STATUSES.has(state.status)) return state;
  switch (event.type) {
    case "token":
      return { ...state, status: "streaming", text: state.text + event.text };
    case "meta":
      return { ...state, meta: { provider: event.provider, model: event.model } };
    case "usage":
      return { ...state, usage: { tokens: event.tokens, latencyMs: event.latencyMs, source: event.source, promptTokens: event.promptTokens, completionTokens: event.completionTokens } };
    case "citations":
      return { ...state, citations: event.items };
    case "tool_call":
      return { ...state, toolCalls: upsertLiveToolCall(state.toolCalls, event.callId, { toolName: event.toolName, args: event.args, status: "running" }) };
    case "tool_result":
      return { ...state, toolCalls: upsertLiveToolCall(state.toolCalls, event.callId, { toolName: event.toolName, status: event.status, resultSummary: event.summary }) };
    case "approval_required":
      // Legacy/defensive shape — never preceded by its own `tool_call` (broker.ts emits this
      // directly), so `upsertLiveToolCall` inserts a fresh entry here, not just patches one.
      // `approval` non-null (with `intent` left null) is what `deriveProposalCardState` reads as
      // "already filed" — see that function's header on why the two fields are never both set.
      return {
        ...state,
        toolCalls: upsertLiveToolCall(state.toolCalls, event.callId, {
          toolName: event.toolName, status: "pending", approvalId: event.approvalId, impact: event.impact,
          approval: { status: "pending", executionStatus: "not_applicable", executionError: null }, intent: null,
        }),
      };
    case "confirm_required":
      // The normal chat-path suspension. Also never preceded by its own `tool_call`. `intent`
      // non-null (with `approval` left null) is what marks this "drafted, not yet filed" — the
      // exact trap this file's header warns about, resolved by construction: nothing here ever
      // sets both fields at once.
      return {
        ...state,
        toolCalls: upsertLiveToolCall(state.toolCalls, event.callId, {
          toolName: event.toolName, status: "pending", args: event.args, impact: event.impact,
          intentId: event.intentId, expiresAt: event.expiresAt, intent: { status: "draft" }, approval: null,
        }),
      };
    case "done":
      return { ...state, status: "done" };
    case "error":
      // The backend's own `stopped` errorKind is a user-requested stop, not a failure — keep it a
      // distinct terminal status so the UI can say "stopped" instead of "error". `confirm_required`/
      // `approval_required` are ALSO not failures (Message.tsx renders them as proposal-pending,
      // never error styling) but they DO still end the turn, so `status` becomes "error" for both —
      // the card, not this generic error banner, is what tells the truth about what happened.
      return { ...state, status: event.errorKind === "stopped" ? "stopped" : "error", error: { message: event.error, kind: event.errorKind } };
    default:
      return state;
  }
}

// ============================================================== T4: proposal card state ==============
// The D14 execution-chip states this ticket exists to render (§7.2.7's full set). `deriveProposalCardState`
// is THE one function both a live (SSE-accumulated) and a persisted (GET-thread-joined) tool call feed
// through — see `ProposalJoinable`'s header for why one function can serve both.
export type ProposalCardState =
  | "awaiting_confirmation"
  | "dismissed"
  | "expired"
  | "sent_for_approval"
  | "executing"
  | "executed"
  | "execution_failed"
  | "not_executable"
  | "rejected"
  | "cancelled"
  /** Not a write proposal at all — a plain read/refusal. Callers render a small chip, never a card. */
  | "plain";

/** THE TRAP, mechanized: `approvalId` alone cannot distinguish "never a proposal" from "drafted,
 *  not yet filed" — both read `null`. This reads `intent` FIRST (a still-drafted/dismissed/expired
 *  write, never yet filed) and `approval` SECOND (a filed write, joined by `approvalId`), falling
 *  back to `"plain"` only when BOTH are absent — never inferring anything from `approvalId` itself. */
export function deriveProposalCardState(call: ProposalJoinable): ProposalCardState {
  if (call.intent) {
    switch (call.intent.status) {
      case "draft": return "awaiting_confirmation";
      case "dismissed": return "dismissed";
      case "expired": return "expired";
      case "filed": return "sent_for_approval"; // transient — the approval join takes over on the next read
    }
  }
  if (call.approval) {
    const { status, executionStatus } = call.approval;
    if (status === "rejected") return "rejected";
    if (status === "cancelled") return "cancelled";
    if (status === "pending") return "sent_for_approval";
    // status === "approved"
    if (executionStatus === "executed") return "executed";
    if (executionStatus === "failed") return "execution_failed";
    if (executionStatus === "not_applicable") return "not_executable";
    return "executing"; // 'executing' | 'pending' | any future value — approved, not yet resolved
  }
  return "plain";
}

/** Whether this call is a write proposal at all (a card) vs. a plain read/refusal (a chip) — the
 *  SAME intent-then-approval read `deriveProposalCardState` uses, never `approvalId` alone. */
export function isWriteProposal(call: ProposalJoinable): boolean {
  return call.intent !== null || call.approval !== null;
}

/** Only an `awaiting_confirmation` card can still be confirmed/dismissed — every other state is
 *  already decided (by the owner, an approver, the executor, or the TTL) and the buttons must not
 *  render, not merely be disabled: a disabled Confirm on an already-filed row would imply the
 *  click WOULD have done something, which is exactly the "the confirm request carries no args, so
 *  there's nothing left to re-send" property this state machine holds. */
export function canActOnProposal(state: ProposalCardState): boolean {
  return state === "awaiting_confirmation";
}

const PROPOSAL_STATE_LABEL: Record<ProposalCardState, string> = {
  awaiting_confirmation: "Awaiting your confirmation",
  dismissed: "Dismissed",
  expired: "Expired — never sent",
  sent_for_approval: "Sent for approval",
  executing: "Approved — executing",
  executed: "Approved and executed",
  execution_failed: "Approved — execution failed",
  not_executable: "Approved — nothing could execute it",
  rejected: "Rejected",
  cancelled: "Cancelled",
  plain: "",
};

export function proposalStateLabel(state: ProposalCardState): string {
  return PROPOSAL_STATE_LABEL[state];
}

/** Shape-only preview of an ALREADY-REDACTED args object (`redactToolArgs` on the backend) — one
 *  `key: [redacted:type]` line per top-level key. Never attempts to recover a value (there is none
 *  to recover: the wire never carries one) — this is deliberately as dumb as the data it's reading. */
export function formatRedactedArgs(args: unknown): { key: string; hint: string }[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key,
    hint: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

/** `expiresAt`'s display form — pinned locale + timeZone (CLAUDE.md's hydration-divergence trap:
 *  `toLocaleString` alone depends on runtime ICU, so an SSR pass and a client re-render can
 *  legitimately disagree; `charts/chartHover.ts::fmtDate` sets the precedent this follows). Returns
 *  `null` for an unparseable value rather than "Invalid Date" — an honest "don't know" beats a
 *  string that looks like a real answer. */
export function formatExpiresAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** The one shape `ProposalCard`/`ToolCallChips` actually render — `ThreadToolCall` (persisted,
 *  `id`-keyed) and `LiveToolCall` (in-flight, `callId`-keyed) both normalize down to this, which is
 *  what lets those two components stay ignorant of which source produced their data (the exact
 *  "Message.tsx already does this for citations/meta" split this file's other card-state helpers
 *  follow). `expiresAt` is `null` once filed (the approval join has no expiry concept) — only
 *  meaningful alongside `state === 'awaiting_confirmation'`. */
export interface NormalizedToolCall extends ProposalJoinable {
  callId: string;
  toolName: string;
  args: unknown;
  status: string;
  resultSummary: string | null;
  approvalId: string | null;
  impact: string | null;
  expiresAt: string | null;
}

export function normalizeThreadToolCall(c: ThreadToolCall): NormalizedToolCall {
  return {
    callId: c.id, toolName: c.toolName, args: c.args, status: c.status, resultSummary: c.resultSummary,
    approvalId: c.approvalId, impact: null, expiresAt: c.intent?.expiresAt ?? null,
    approval: c.approval, intent: c.intent,
  };
}

export function normalizeLiveToolCall(c: LiveToolCall): NormalizedToolCall {
  return {
    callId: c.callId, toolName: c.toolName, args: c.args ?? {}, status: c.status, resultSummary: c.resultSummary,
    approvalId: c.approvalId, impact: c.impact, expiresAt: c.expiresAt,
    approval: c.approval, intent: c.intent,
  };
}

export interface PartitionedToolCalls {
  /** Write proposals — render as `ProposalCard`s, in wire/arrival order. */
  proposals: NormalizedToolCall[];
  /** Plain reads/refusals — render as small `ToolCallChips`, in wire/arrival order. */
  chips: NormalizedToolCall[];
}

/** THE single split point: `isWriteProposal` (never `approvalId` alone — see this file's header)
 *  decides which of the two renderings a call gets. */
export function partitionToolCalls(calls: NormalizedToolCall[]): PartitionedToolCalls {
  const proposals: NormalizedToolCall[] = [];
  const chips: NormalizedToolCall[] = [];
  for (const c of calls) (isWriteProposal(c) ? proposals : chips).push(c);
  return { proposals, chips };
}

// Client-side error kinds this file's consumer synthesizes, layered onto the backend's own set
// (upstream_error | abnormal_drop | idle_timeout | stopped | client_disconnected | not_configured |
// transport_error — see docs/FRONTEND-BFF-CONTRACT.md §18). These cover failures the backend never
// gets a chance to report because the break happened between the browser and OUR OWN proxy, not
// between the platform and the gateway.
export const CLIENT_IDLE_TIMEOUT_MS = 120_000;

const ERROR_KIND_LABEL: Record<string, string> = {
  upstream_error: "The model provider returned an error.",
  abnormal_drop: "The connection to the model dropped unexpectedly.",
  idle_timeout: "The model stopped responding.",
  stopped: "Stopped.",
  client_disconnected: "The connection closed.",
  not_configured: "The assistant isn't configured on this environment yet.",
  transport_error: "A network error interrupted the reply.",
  client_idle_timeout: "No response for 2 minutes — the connection was closed.",
  client_abnormal_drop: "The connection ended before the reply finished.",
  client_error: "Something went wrong while streaming the reply.",
  // ── T4 (ASST-17/ASST-23) — the tool-turn's own errorKinds. `confirm_required`/`approval_required`
  // are deliberately EXCLUDED from this dict's callers (Message.tsx never renders them through the
  // generic error path — the proposal card is what tells that story), but a label still lives here
  // so `humanizeErrorKind` never falls through to the generic "Something went wrong." for them if
  // some other surface (a toast, a log) ever needs a one-line gloss.
  tool_denied: "Your account isn't authorized to use one of the tools this needed.",
  tool_not_executable: "That write can't be proposed yet — nothing on this platform can execute it.",
  runner_busy: "The assistant's tool runtime is busy — try again in a moment.",
  runner_error: "The assistant's tool runtime returned an error.",
  unknown_agent: "That isn't one of the assistant's tool agents.",
  no_authority: "The assistant couldn't establish who was asking.",
  intent_lost: "The proposal for that write was lost before it could be shown — please ask again.",
  confirm_required: "Awaiting your confirmation before this is sent for approval.",
  approval_required: "Sent for approval — nothing has been changed yet.",
};

export function humanizeErrorKind(kind: string): string {
  return ERROR_KIND_LABEL[kind] ?? "Something went wrong.";
}

// ============================================================== ASST-19: memory panel ==============
// Durable user memory (blueprint §4.1, memory #2 of 4) — owner-only end to end
// (resource_assistant_memory.yaml), exactly mirroring platform-nest's
// `modules/assistant/assistant.controller.ts` MemoryRow shape (see docs/FRONTEND-BFF-CONTRACT.md
// §18's "Memory panel backend" subsection). `confirmedAt === null` is a PROPOSAL — inert on the
// backend (never injected into an assembled prompt, context.ts's quarantine gate) and rendered
// here as "pending confirmation", never as if it were already a trusted fact.

export type AssistantMemoryScope = "user" | "company";

export interface AssistantMemory {
  id: string;
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

export interface MemoryListResult { items: AssistantMemory[]; total: number }

/** A memory row still awaiting confirmation — the panel's own "propose" affordance produces one of
 *  these, and it stays inert (context.ts never reads it) until `confirm` is called. */
export function isPendingMemory(m: Pick<AssistantMemory, "confirmedAt">): boolean {
  return m.confirmedAt === null;
}

/** Split a loaded memory list into "pending your confirmation" and "confirmed", each already
 *  ordered pinned-first-then-most-recent — the same grouping the backend's own `GET
 *  .../memory?confirmed=` filter exists for, done client-side once the panel has the full list
 *  loaded (mirrors `groupThreads`' client-side-grouping-over-one-page rationale above). */
export interface GroupedMemory {
  pending: AssistantMemory[];
  confirmed: AssistantMemory[];
}

function byPinnedThenRecency(a: AssistantMemory, b: AssistantMemory): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const av = a.confirmedAt ? Date.parse(a.confirmedAt) : Date.parse(a.createdAt);
  const bv = b.confirmedAt ? Date.parse(b.confirmedAt) : Date.parse(b.createdAt);
  return bv - av;
}

export function groupMemory(items: AssistantMemory[]): GroupedMemory {
  const pending = items.filter(isPendingMemory).sort(byPinnedThenRecency);
  const confirmed = items.filter((m) => !isPendingMemory(m)).sort(byPinnedThenRecency);
  return { pending, confirmed };
}

/** Panel copy for the scope selector — NOT a visibility control (see ASST-19's contract-doc note:
 *  `scope` records what the fact is ABOUT, not who else can read it; every row stays owner-private
 *  regardless). Kept here, not inline in the component, so the "not a sharing switch" framing
 *  can't drift between two copies of the same string. */
export const MEMORY_SCOPE_LABEL: Record<AssistantMemoryScope, string> = {
  user: "About you",
  company: "About the company",
};

// ============================================================== ASST-18: capabilities panel =======
// blueprint §8's right-rail "capabilities" list AND the empty-state capability cards — both fed
// from `GET :tenantId/assistant/capabilities`, mirroring platform-nest's `AssistantCapability`/
// `CapabilitiesResult` (modules/assistant/capabilities.ts) byte-for-byte.

export interface AssistantCapability {
  name: string;
  description: string;
  /** The owning `ModuleContract.key`, or `null` for an ungated platform-core tool. Grouping only —
   *  the filtering that decides whether a tool appears at ALL already happened server-side. */
  module: string | null;
}

// T4 (ASST-23, §7.4/T3a) — the composer's tools-mode agent picker, sourced from THIS, never a
// hand-maintained FE mirror of `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS` (broker.ts's
// own real maps, per the contract doc's "no FE mirror" rule). `writeTools` is always a subset of
// `tools`; an agent with an empty `writeTools` is read-only in exactly ASST-17's original sense.
export interface AssistantToolAgent {
  name: string;
  tools: readonly string[];
  writeTools: readonly string[];
}

export interface CapabilitiesResult {
  tools: AssistantCapability[];
  /** `false` means the assistant's tool hub isn't configured in THIS environment at all — distinct
   *  from "configured, and you genuinely have zero capabilities" (both currently render an empty
   *  `tools` array; this flag is what lets the panel word its empty state honestly rather than
   *  guessing which of the two is true). */
  hubConfigured: boolean;
  toolAgents: AssistantToolAgent[];
}

/** `name`'s dot-prefix (`"projects.list"` -> `"projects"`) as a display category. Purely a
 *  presentation grouping — the same "no server round trip for a client-side reshape" rationale
 *  `groupThreads`/`groupMemory` above already use. A tool with no dot groups under `"general"`. */
function capabilityCategory(name: string): string {
  const dot = name.indexOf(".");
  return dot > 0 ? name.slice(0, dot) : "general";
}

export interface CapabilityGroup {
  category: string;
  tools: AssistantCapability[];
}

/** Groups by dot-prefix category, each group's tools sorted by name, groups sorted by category —
 *  a stable, deterministic layout for the card grid (both the panel and the empty-state cards call
 *  this over the SAME loaded list, see `CapabilityCards`). */
export function groupCapabilities(tools: AssistantCapability[]): CapabilityGroup[] {
  const byCategory = new Map<string, AssistantCapability[]>();
  for (const t of tools) {
    const cat = capabilityCategory(t.name);
    const list = byCategory.get(cat) ?? [];
    list.push(t);
    byCategory.set(cat, list);
  }
  return [...byCategory.entries()]
    .map(([category, catTools]) => ({ category, tools: [...catTools].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// ============================================================== ASST-18: citation resolution ======

export interface ResolvedCitation {
  kind: string;
  label: string;
  href: string;
}

// ============================================================== ASST-22: `@drawer` page-context ===
// The resolved form of `lib/assistantContext.ts`'s `DerivedPageContext` — identical shape to
// `ResolvedCitation` plus the original `ref` (the chip needs it both to re-resolve on click, same
// discipline as `CitationChips`, and `AssistantWorkspace` needs it to build the first-message
// preamble — see `pageContextPrefix`). Kept as its own named type rather than reusing
// `ResolvedCitation & {ref}` inline at every call site so a rename of either shape is a compiler
// error, not a silent drift.
export interface PinnedPageContext {
  ref: string;
  kind: string;
  label: string;
  href: string;
}

// ============================================================== ASST-21: agent roster + handoff ====
// blueprint §8's "agent roster" line + D-B: "one Hermes front door + a visible agent roster — hand
// a longer task to a specialist." Mirrors platform-nest's `modules/assistant/handoffs.ts` shapes
// byte-for-byte (see docs/FRONTEND-BFF-CONTRACT.md §18's ASST-21 addendum).

/** One entry in `GET :t/assistant/agents`'s registry — the runner's REAL specialist list, never a
 *  hardcoded mirror (see handoffs.ts's `fetchRoster` header). `writeCapable` + `evaledProviders`
 *  let the panel show honestly whether a specialist's write is currently live (D13) or forced
 *  read-only, without the UI re-implementing D13's own enrollment logic. */
export interface RosterAgent {
  name: string;
  tools: string[];
  maxSteps: number;
  maxToolCalls: number;
  writeCapable: boolean;
  evaledProviders: string[];
}

/** One episodic run-history entry (ai-agents `Episode`, narrowed server-side to THIS caller's own
 *  handoff runs — see `fetchEpisodicHistory`'s header on why an Episode carries no user column). */
export interface RosterEpisode {
  runId: string;
  agent: string;
  goal: string;
  status: string;
  outcome: string | null;
  toolsCalled: string[];
  failedTools: string[];
  provider?: string;
  createdAt: number;
}

export interface RosterResult {
  agents: RosterAgent[];
  supervisor: { name: string } | null;
  /** `false` means the agent runner isn't reachable/configured in THIS environment at all —
   *  distinct from "configured, and there are genuinely zero specialists" (see `fetchRoster`'s own
   *  header — same convention as ASST-18's `hubConfigured`). */
  runnerConfigured: boolean;
  episodicHistory: RosterEpisode[];
}

/** Mirrors the runner's `GoalStatus` (ai-agents `runner/store.ts`) — a handoff's own lifecycle. */
export type HandoffStatus =
  | "queued" | "running" | "ok" | "suspended" | "budget_exhausted" | "failed" | "interrupted" | "cancelled";

const TERMINAL_HANDOFF_STATUSES = new Set<HandoffStatus>(["ok", "suspended", "budget_exhausted", "failed", "interrupted", "cancelled"]);

export interface AssistantHandoff {
  id: string;
  threadId: string;
  ownerUserId: string;
  agent: string;
  goalText: string;
  goalId: string;
  /** Set once the runner reports a terminal run for this goal — the run-watch view's cue that
   *  `GET :t/agents/runs/:runId` (now additionally readable by THIS owner, resource_agent_run.yaml)
   *  has something to show. `null` while still queued/running. */
  runId: string | null;
  status: HandoffStatus;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isHandoffTerminal(h: Pick<AssistantHandoff, "status">): boolean {
  return TERMINAL_HANDOFF_STATUSES.has(h.status);
}

/** Drives the run-watch view's poll loop — "keep polling while ANY handoff on this thread is still
 *  in flight", the same shape `hasActiveGoal` already uses for the Intelligence console's goal list
 *  (`lib/admin.ts`), kept as its own function here rather than imported so this file stays free of
 *  a dependency on the admin surface. */
export function hasActiveHandoff(handoffs: Pick<AssistantHandoff, "status">[]): boolean {
  return handoffs.some((h) => !isHandoffTerminal(h));
}

const HANDOFF_STATUS_LABEL: Record<HandoffStatus, string> = {
  queued: "Queued",
  running: "Running…",
  ok: "Done",
  suspended: "Waiting for approval",
  budget_exhausted: "Stopped (budget)",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export function handoffStatusLabel(status: string): string {
  return HANDOFF_STATUS_LABEL[status as HandoffStatus] ?? status;
}

// ============================================================== T4: pending-proposal poll ============
// A card whose approval is decided OUT OF BAND (a `company_admin`/`group_executive`/`platform_admin`
// deciding on `/approvals/[id]`, in a different tab or a different session entirely) never pushes an
// update into this thread — `GET thread`'s join is the only way to see it. The SAME "keep polling
// while something is still in flight, stop the instant it isn't" shape `hasActiveHandoff` above
// already established for handoffs, applied to proposal cards instead of runs.
const PENDING_DECISION_STATES = new Set<ProposalCardState>(["sent_for_approval", "executing"]);

/** True while ANY message on the currently-loaded page has a write-proposal card sitting in a
 *  state that a HUMAN ELSEWHERE could still change (filed-and-pending, or approved-and-executing) —
 *  the caller's cue to keep re-fetching the thread. A card already terminal (executed/failed/
 *  rejected/cancelled/not_executable) or not yet filed (awaiting_confirmation/dismissed/expired,
 *  all of which only this owner's own click can move) never keeps the poll alive. */
export function hasPendingProposalDecision(messages: Pick<AssistantMessage, "toolCalls">[]): boolean {
  return messages.some((m) =>
    (m.toolCalls ?? []).some((call) => isWriteProposal(call) && PENDING_DECISION_STATES.has(deriveProposalCardState(call))),
  );
}
