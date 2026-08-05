// ASST-06 — the send->stream engine's gateway-facing half: consume ai-gateway-go's
// `POST /complete/stream` (ASST-10 wire grammar v2, LIVE — see ai-gateway-go/internal/server/
// server.go's `writeSSEData`/`writeSSEError`/`writeSSEDone` comment block), re-emit typed events
// to OUR client, and own the in-memory "one active generation per thread" registry that backs
// `POST .../stop`.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-06").
//
// ── THE WIRE GRAMMAR THIS FILE CONSUMES (do not re-derive, ASST-10 already shipped it) ───────────
// Every `data:` line on the gateway's stream route is EXACTLY ONE line of JSON:
//   - a default (unnamed) event's `data:` is the JSON STRING of the token text, e.g. `data: "a\nb"`
//     (embedded newlines are the two-char escape `\n`, never a raw line break — so this framing
//     can never be split or truncated by a token's own content, unlike the pre-ASST-10 bug).
//   - `event: error` / `data: {"error": string}` — an explicit upstream failure.
//   - `event: done` / `data: {}` — the ONLY clean-completion signal. Its ABSENCE (the connection
//     just closes) means an abnormal drop, per this ticket's mandate — parseGatewayStream()
//     synthesizes an `abnormal_drop` event in that case rather than ever treating stream-end as
//     success.
// ASST-04 already scrubs response bytes (DLP) upstream of this file, at the gateway's wire
// boundary — this file must NEVER re-scrub or decode-then-rescrub what it receives.
//
// ── WHY provider/model ARE NOT RECORDED FOR A STREAMED REPLY ──────────────────────────────────────
// A thread's `brain` (brain_provider/brain_model) is STORED (migration 0079) but NOT ROUTED in
// Phase 1 — the gateway's own chain/failover picks whichever provider actually serves the prompt
// (ollama -> ... -> echo), and unlike the non-streaming `/complete` route (`{text, provider}`),
// `/complete/stream`'s SSE wire carries no field naming which provider served it. So the platform
// genuinely cannot attribute a streamed reply to a specific provider without ai-gateway-go adding
// one — recording the thread's REQUESTED brain on the message would misrepresent a failed-over
// reply as having been served by the brain the user picked. `assistant_messages.provider`/`model`
// are therefore left NULL for every streamed message in Phase 1; per-brain routing + provider
// attribution is Phase 2 work (see this file's header and docs/FRONTEND-BFF-CONTRACT.md §18).
import { config } from "../../config";

// ─────────────────────────────────────── low-level SSE parsing ───────────────────────────────────

interface RawSSEEvent {
  event: string; // "message" when the block carried no `event:` line (the SSE spec default)
  data: string;
}

/** Byte/line-level SSE block reader: splits a `ReadableStream<Uint8Array>` on the blank-line
 *  event terminator and extracts the `event:`/`data:` fields from each block. Deliberately
 *  generic (not ASST-10-specific) — the JSON-decoding of `data` happens one layer up in
 *  `parseGatewayStream`, so this function only knows SSE framing, not the assistant's grammar. */
async function* iterateSSEBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<RawSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSSEBlock(block);
        if (parsed) yield parsed;
      }
    }
    // Defensive: a truncated final block with no trailing blank line (the gateway always emits
    // one, but a hard connection drop mid-write might not) is still worth trying to parse rather
    // than silently dropping its content.
    const tail = parseSSEBlock(buf);
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released/closed — nothing to do
    }
  }
}

function parseSSEBlock(block: string): RawSSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // `:` comment lines and other fields (id:, retry:) are intentionally ignored — the gateway's
    // stream route never emits them.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// ─────────────────────────────────────── typed gateway events ────────────────────────────────────

export type GatewayStreamEvent =
  | { type: "token"; text: string }
  | { type: "error"; error: string }
  | { type: "done" }
  /** Stream ended without a `done` (or `error`) event ever arriving — the abnormal-drop case this
   *  ticket calls out by name. Kept as its OWN variant (not folded into `error`) so callers can
   *  classify it precisely (`error_kind = 'abnormal_drop'`) instead of string-matching a message. */
  | { type: "abnormal_drop" };

/** Translate the gateway's raw SSE bytes into `GatewayStreamEvent`s per the ASST-10 grammar.
 *  Terminates (returns) after yielding `done`, `error`, or the synthesized `abnormal_drop` — never
 *  yields anything after a terminal event, mirroring the gateway's own "exactly one terminal"
 *  invariant. */
export async function* parseGatewayStream(body: ReadableStream<Uint8Array>): AsyncGenerator<GatewayStreamEvent> {
  let sawTerminal = false;
  for await (const raw of iterateSSEBlocks(body)) {
    if (raw.event === "error") {
      sawTerminal = true;
      let message = "unknown upstream error";
      try {
        const parsed = JSON.parse(raw.data) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
      } catch {
        // Malformed JSON from an otherwise-conformant gateway shouldn't happen, but a parse
        // failure must still surface as SOME error rather than silently dropping the event.
      }
      yield { type: "error", error: message };
      return;
    }
    if (raw.event === "done") {
      sawTerminal = true;
      yield { type: "done" };
      return;
    }
    // Default (unnamed) event: `data` is the JSON STRING of the token text (ASST-10).
    let text: unknown;
    try {
      text = JSON.parse(raw.data);
    } catch {
      text = raw.data; // defensive fallback — treat unparsable data as literal text
    }
    yield { type: "token", text: typeof text === "string" ? text : String(text) };
  }
  if (!sawTerminal) {
    yield { type: "abnormal_drop" };
  }
}

// ──────────────────────────────────────── token estimation ───────────────────────────────────────

/** ~4 chars/token English-text approximation. NOT a real tokenizer count — see this file's header
 *  and config.ts's `assistant.contextCharBudget` comment for why: the gateway's stream wire has no
 *  `usage` field to calibrate against. Used for BOTH the persisted `tokens` column and the
 *  context-assembly budget in context.ts. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ───────────────────────────────────── active-generation registry ────────────────────────────────

/** One thread has AT MOST one active generation at a time (the controller's precondition check on
 *  `POST .../messages` enforces this at the DB layer — see assistant.controller.ts's header on the
 *  advisory-lock + re-check pattern). This registry is the process-local, best-effort mechanism
 *  `POST .../stop` uses to reach the in-flight upstream fetch and cancel it — same "best-effort,
 *  single-instance v1" posture as mcp-hub's nonce cache (D14 plan §5.7): the AUTHORITATIVE
 *  guarantee that only one generation ever runs per thread is the DB precondition, not this map. */
interface GenerationEntry {
  threadId: string;
  messageId: string;
  controller: AbortController;
  /** Set by `requestStop()` BEFORE calling `abort()`, so the `catch` block in `relayGeneration`
   *  can tell "the user clicked stop" apart from every other reason the fetch could throw. */
  stopRequested: boolean;
  /** Set by the idle-timeout timer BEFORE calling `abort()` — same reasoning. */
  idleTimedOut: boolean;
  /** Set by `abortForClientDisconnect()` (the SSE socket the ERP browser held closed) — same
   *  reasoning, third and last of the three deliberate-abort classifications. */
  clientDisconnected: boolean;
}

const activeGenerations = new Map<string, GenerationEntry>(); // keyed by threadId

/** True while a generation is in flight for this thread. */
export function hasActiveGeneration(threadId: string): boolean {
  return activeGenerations.has(threadId);
}

/**
 * Synchronously claim the "one active generation per thread" slot, or return `null` if one is
 * already held. MUST be called with NO `await` between the controller's `hasActiveGeneration`-
 * adjacent checks and this call — the entire point of making this a separate, synchronous
 * function (rather than folding the check into `relayGeneration`, which only runs after several
 * awaited DB round-trips for the placeholder fetch + context assembly) is to close the TOCTOU
 * window a check-then-later-register pattern would otherwise leave open: two concurrent
 * `GET .../stream` calls for the same thread could both observe "nothing active yet" while each
 * is still awaiting its own context-assembly query, and both then start generating. Node's
 * single-threaded execution model guarantees this `Map.has`+`Map.set` pair can never be
 * interleaved by another synchronous call, so reserving the slot HERE, before any `await`, is
 * what makes the check race-free within one process. (Across processes, the DB-level "content IS
 * NULL AND error_kind IS NULL" precondition on the placeholder row is the real backstop — same
 * best-effort-in-memory-plus-authoritative-DB-claim split as D14's hub nonce cache / platform
 * claim, plan §5.7.)
 */
export function reserveGeneration(threadId: string, messageId: string): GenerationEntry | null {
  if (activeGenerations.has(threadId)) return null;
  const entry: GenerationEntry = {
    threadId,
    messageId,
    controller: new AbortController(),
    stopRequested: false,
    idleTimedOut: false,
    clientDisconnected: false,
  };
  activeGenerations.set(threadId, entry);
  return entry;
}

/** Release a reservation WITHOUT aborting anything — for a caller that reserved the slot via
 *  `reserveGeneration` and then hit an error (e.g. the placeholder row vanished) before ever
 *  calling `relayGeneration` (whose own `finally` is what normally releases it). A no-op if the
 *  entry is already gone. */
export function releaseGeneration(threadId: string): void {
  activeGenerations.delete(threadId);
}

/** `POST .../stop`'s primary path: abort the in-flight upstream fetch for this thread, if this
 *  process is the one running it. Returns false when there is nothing to abort here (already
 *  finished, or the generation never reached this process) — the controller falls back to a
 *  direct DB UPDATE of any still-pending placeholder message in that case. */
export function requestStop(threadId: string): boolean {
  const entry = activeGenerations.get(threadId);
  if (!entry) return false;
  entry.stopRequested = true;
  entry.controller.abort();
  return true;
}

/** The SSE socket to the ERP browser closed (tab closed, network drop) while a generation was
 *  in flight for it. Aborts the upstream fetch so a client-side disconnect doesn't leave the
 *  gateway generating (and the DLP/budget/audit path spending) into the void. */
export function abortForClientDisconnect(threadId: string): boolean {
  const entry = activeGenerations.get(threadId);
  if (!entry) return false;
  entry.clientDisconnected = true;
  entry.controller.abort();
  return true;
}

// ───────────────────────────────────────── the relay itself ──────────────────────────────────────

export interface RelayEmit {
  token: (text: string) => void;
  usage: (tokens: number, latencyMs: number) => void;
  done: () => void;
  error: (message: string, errorKind: string) => void;
}

export interface RelayResult {
  /** Full concatenated text received before the terminal event (possibly partial on error/stop). */
  text: string;
  tokensEstimate: number;
  latencyMs: number;
  outcome: "done" | "error";
  errorKind?: string;
  errorMessage?: string;
}

export interface RelayGenerationInput {
  tenantId: string;
  prompt: string;
  emit: RelayEmit;
  idleTimeoutMs?: number;
  gatewayUrl?: string;
  gatewayToken?: string;
  fetchImpl?: typeof fetch;
}

/** Call ai-gateway-go's `POST /complete/stream`, relay each parsed event through `emit`, and
 *  return a summary the controller persists. Takes an ALREADY-RESERVED `entry` (from
 *  `reserveGeneration`, called synchronously by the caller before any `await` — see that
 *  function's header for why the reservation cannot happen in here) and ALWAYS unregisters it in
 *  a `finally` — a thrown error here must never leave the thread permanently "generating" from
 *  this registry's point of view (the DB precondition is the true backstop, but a stuck
 *  in-memory entry would still block same-process `stop` calls for no reason).
 *
 *  Never throws: every failure path (unconfigured gateway, non-2xx, network error, abort, an
 *  upstream `event: error`, or an abnormal drop) is classified into `RelayResult.outcome === "error"`
 *  with a typed `errorKind`, and `emit.error(...)` is called exactly once before returning — the
 *  controller's persistence code has one shape to handle, not a try/catch around this call too. */
export async function relayGeneration(entry: GenerationEntry, input: RelayGenerationInput): Promise<RelayResult> {
  const started = Date.now();
  const controller = entry.controller;

  const idleTimeoutMs = input.idleTimeoutMs ?? config.assistant.streamIdleTimeoutMs;
  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      entry.idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  let text = "";
  const latencyMs = () => Date.now() - started;

  try {
    const url = (input.gatewayUrl ?? config.services.gateway.url).replace(/\/$/, "");
    if (!url) {
      const msg = "ai-gateway-go is not configured (GATEWAY_URL unset) — the assistant fails closed rather than degrading silently";
      input.emit.error(msg, "not_configured");
      return { text, tokensEstimate: 0, latencyMs: latencyMs(), outcome: "error", errorKind: "not_configured", errorMessage: msg };
    }
    const fetchImpl = input.fetchImpl ?? fetch;
    resetIdleTimer();
    const res = await fetchImpl(`${url}/complete/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.gatewayToken ?? config.services.gateway.token}`,
        "x-tenant-id": input.tenantId,
      },
      body: JSON.stringify({ prompt: input.prompt }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const msg = `ai-gateway /complete/stream returned HTTP ${res.status}`;
      input.emit.error(msg, "transport_error");
      return { text, tokensEstimate: estimateTokens(text), latencyMs: latencyMs(), outcome: "error", errorKind: "transport_error", errorMessage: msg };
    }

    for await (const evt of parseGatewayStream(res.body as ReadableStream<Uint8Array>)) {
      resetIdleTimer(); // any activity from upstream resets the idle clock, tokens or terminal alike
      if (evt.type === "token") {
        text += evt.text;
        input.emit.token(evt.text);
        continue;
      }
      if (evt.type === "done") {
        const tokensEstimate = estimateTokens(text);
        const lm = latencyMs();
        input.emit.usage(tokensEstimate, lm);
        input.emit.done();
        return { text, tokensEstimate, latencyMs: lm, outcome: "done" };
      }
      if (evt.type === "error") {
        const lm = latencyMs();
        input.emit.error(evt.error, "upstream_error");
        return { text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "upstream_error", errorMessage: evt.error };
      }
      // evt.type === "abnormal_drop" — the wire ended without done/error. Treated as an error,
      // never as success (this ticket's explicit mandate).
      const lm = latencyMs();
      const msg = "upstream stream ended without a done event (abnormal drop)";
      input.emit.error(msg, "abnormal_drop");
      return { text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "abnormal_drop", errorMessage: msg };
    }
    // Unreachable in practice: parseGatewayStream always yields exactly one terminal event before
    // its generator returns. Kept as a typed fallback rather than an assertion so a future
    // change to that generator fails loudly here instead of hanging the caller.
    const lm = latencyMs();
    const msg = "upstream stream ended unexpectedly with no terminal event";
    input.emit.error(msg, "abnormal_drop");
    return { text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "abnormal_drop", errorMessage: msg };
  } catch (err) {
    const lm = latencyMs();
    const isAbort = (err as Error)?.name === "AbortError";
    let errorKind = "transport_error";
    let errorMessage = (err as Error)?.message || "unknown error calling ai-gateway-go";
    if (isAbort) {
      if (entry.stopRequested) {
        errorKind = "stopped";
        errorMessage = "generation stopped by user";
      } else if (entry.idleTimedOut) {
        errorKind = "idle_timeout";
        errorMessage = `no activity from ai-gateway-go for ${idleTimeoutMs}ms`;
      } else if (entry.clientDisconnected) {
        errorKind = "client_disconnected";
        errorMessage = "the client's connection closed";
      } else {
        // Aborted, but by none of our own three triggers — e.g. the caller's own r.Context()
        // (an upstream Fastify-level disconnect not yet reflected in `clientDisconnected`).
        errorKind = "aborted";
        errorMessage = "the request was aborted";
      }
    }
    input.emit.error(errorMessage, errorKind);
    return { text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind, errorMessage };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    activeGenerations.delete(entry.threadId);
  }
}

// ──────────────────────────────────── SSE encoding to OUR client ─────────────────────────────────

/** Encode ONE line of the SSE response THIS controller sends to the ERP browser, applying the
 *  identical "exactly one line of JSON" discipline ASST-10 fixed on the gateway's own wire — see
 *  this file's header. `JSON.stringify` of any value can never itself contain a raw newline
 *  (embedded `\n`/`\n\n` become the two/four-character escapes), so this framing is safe for
 *  arbitrary token text (markdown, fenced code, multi-paragraph answers) end to end, the same
 *  property ASST-10 established for the gateway->platform hop. */
export function sseLine(event: "token" | "usage" | "done" | "error", data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
