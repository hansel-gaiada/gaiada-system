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
  /** ASST-12 — set the instant a `meta` frame arrives (before any token, per ASST-11's own
   *  ordering invariant). Null for the entire stream when the serving provider never announced
   *  itself — the honest "unknown provider" state, never an error. */
  meta: { provider: string; model: string } | null;
  usage: { tokens: number; latencyMs: number; source: "provider" | "estimate"; promptTokens?: number; completionTokens?: number } | null;
  // ASST-18 — set the instant a `citations` frame arrives (before any token, same ordering
  // guarantee as `meta`). `[]` for the entire stream when this turn used no RAG grounding — the
  // honest "nothing to cite" state, identical in rendering to "not answered yet".
  citations: AssistantCitation[];
  error: { message: string; kind: string } | null;
}

export function initialStreamState(): StreamState {
  return { status: "idle", text: "", meta: null, usage: null, citations: [], error: null };
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
    case "meta":
      return { ...state, meta: { provider: event.provider, model: event.model } };
    case "usage":
      return { ...state, usage: { tokens: event.tokens, latencyMs: event.latencyMs, source: event.source, promptTokens: event.promptTokens, completionTokens: event.completionTokens } };
    case "citations":
      return { ...state, citations: event.items };
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

export interface CapabilitiesResult {
  tools: AssistantCapability[];
  /** `false` means the assistant's tool hub isn't configured in THIS environment at all — distinct
   *  from "configured, and you genuinely have zero capabilities" (both currently render an empty
   *  `tools` array; this flag is what lets the panel word its empty state honestly rather than
   *  guessing which of the two is true). */
  hubConfigured: boolean;
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
