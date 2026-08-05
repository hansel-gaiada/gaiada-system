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
}

export interface ThreadListResult { items: AssistantThread[]; total: number }
export interface ThreadDetailResult { thread: AssistantThread; messages: AssistantMessage[]; hasMoreMessages: boolean }
export interface SendMessageResult { messageId: string; streamUrl: string }
export interface StopResult { ok: boolean; stopped: boolean }

export function threadTitle(t: Pick<AssistantThread, "title">): string {
  return t.title?.trim() || "New chat";
}

/** A message row that is still generating (no content yet, no terminal error yet). */
export function isPendingMessage(m: Pick<AssistantMessage, "content" | "errorKind">): boolean {
  return m.content === null && m.errorKind === null;
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

export type ClientStreamEvent =
  | { type: "token"; text: string }
  | { type: "usage"; tokens: number; latencyMs: number }
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
  switch (block.event) {
    case "token":
      return typeof obj.text === "string" ? { type: "token", text: obj.text } : null;
    case "usage": {
      const tokens = Number(obj.tokens);
      const latencyMs = Number(obj.latencyMs);
      if (!Number.isFinite(tokens) || !Number.isFinite(latencyMs)) return null;
      return { type: "usage", tokens, latencyMs };
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

export interface StreamState {
  status: StreamStatus;
  /** The TRUE accumulated text — every token concatenated, updated instantly. The typewriter
   *  smoother (render layer) lags behind this on purpose; never read this expecting animation. */
  text: string;
  usage: { tokens: number; latencyMs: number } | null;
  error: { message: string; kind: string } | null;
}

export function initialStreamState(): StreamState {
  return { status: "idle", text: "", usage: null, error: null };
}

const TERMINAL_STATUSES = new Set<StreamStatus>(["done", "error", "stopped"]);

export function streamReducer(state: StreamState, event: ClientStreamEvent): StreamState {
  // Guard: once a stream has resolved, every later event is either a duplicate delivery or an
  // orphan from a generation this component no longer cares about (e.g. a stale abort racing a
  // fresh send) — drop it rather than resurrecting a finished bubble.
  if (TERMINAL_STATUSES.has(state.status)) return state;
  switch (event.type) {
    case "token":
      return { ...state, status: "streaming", text: state.text + event.text };
    case "usage":
      return { ...state, usage: { tokens: event.tokens, latencyMs: event.latencyMs } };
    case "done":
      return { ...state, status: "done" };
    case "error":
      // The backend's own `stopped` errorKind is a user-requested stop, not a failure — keep it a
      // distinct terminal status so the UI can say "stopped" instead of "error".
      return { ...state, status: event.errorKind === "stopped" ? "stopped" : "error", error: { message: event.error, kind: event.errorKind } };
    default:
      return state;
  }
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
};

export function humanizeErrorKind(kind: string): string {
  return ERROR_KIND_LABEL[kind] ?? "Something went wrong.";
}
