// ASST-06 — the send->stream engine's gateway-facing half: consume ai-gateway-go's
// `POST /complete/stream` (ASST-10 wire grammar v2, LIVE — see ai-gateway-go/internal/server/
// server.go's `writeSSEData`/`writeSSEError`/`writeSSEDone` comment block), re-emit typed events
// to OUR client, and own the in-memory "one active generation per thread" registry that backs
// `POST .../stop`.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-06").
//
// ── ASST-16 — provider hint request fields + the `event: session` split (consuming ASST-15) ────────
// ASST-15 rewrote the gateway wire to a SINGLE dialect (docs/FRONTEND-BFF-CONTRACT.md §18's
// "ASST-15" addendum, authoritative): `event: meta` ({provider, model}) fires PRE-first-token,
// UNCONDITIONALLY, for every provider including hermes — it NEVER carries `providerSession`
// anymore. The late-known fact (Hermes' session id) moved to its own additive TERMINAL
// `event: session` ({providerSession}), written after `usage` (if any) and before `done`, emitted
// AT MOST ONCE and only when the serving provider actually has one to report. This file mirrors
// that split exactly: `GatewayStreamEvent`'s `meta` variant no longer carries `providerSession`,
// and a new `session` variant/case handles the new event. The request body sent to
// `/complete/stream` also grows two optional fields this ticket adds — `provider` (a hint: route
// to the named provider FIRST when available and its breaker is closed, else fall through to the
// normal chain — OQ-6's "fail over and LABEL", never a hard error) and `providerSession` (an
// opaque token threaded verbatim to whichever provider implements
// providers.SessionStreamingProvider, today only hermes) — see `RelayGenerationInput`'s
// `provider`/`providerSession` fields and their one call site below.
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
// ── ASST-12 — CONSUMING ai-gateway-go's `meta`/`usage` (ASST-11, additive grammar-v2) ───────────────
// ASST-11 closed the gap the paragraph below used to describe: the gateway's `/complete/stream`
// wire now carries an additive `event: meta` (`{provider, model}` — see the ASST-16 header above:
// ASST-15 later removed the `providerSession?` field this originally carried), emitted EXACTLY
// ONCE at the DLP scrubber's first byte release — i.e. it names the provider that actually
// COMMITTED output, never a provider that died inside the hold window — and a terminal
// `event: usage` (`{promptTokens, completionTokens}`, emitted ONLY when the serving provider
// reports REAL end-of-stream counts — today that is `ollama` alone; `echo`/`openai`/`gemini`/
// `claude` report nothing, so `usage` is simply ABSENT for them, which is the common path, not an
// error). Both are handled as **absent-tolerant**: an older gateway (or any provider that never
// reports usage) emits neither, and that must read as "unknown provider" / "no real usage
// available" — never as a failure. `relayGeneration` below captures whichever of the two arrives
// and returns them on `RelayResult` so the controller can persist `provider`/`model` (previously
// always NULL for a streamed reply) and record `usageSource: 'provider' | 'estimate'` so nothing
// ever presents the ~4-chars/token estimate as if it were a measurement.
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
  | { type: "abnormal_drop" }
  /** ASST-11's `event: meta` — the provider that actually committed bytes to the wire. Non-
   *  terminal: arrives once, before the first token, then the loop continues. `model` may
   *  legitimately be `""` (a provider with no fixed-model concept, e.g. `echo`) — that is a
   *  truthful absence, not malformed data, so it is passed through as-is, never coerced to null
   *  or dropped. ASST-15: no longer carries `providerSession` — see `session` below. */
  | { type: "meta"; provider: string; model: string }
  /** ASST-11's terminal `event: usage` — REAL end-of-stream provider-reported counts (never
   *  zero-filled, never estimated). Arrives immediately before `done`, only when the serving
   *  provider reports them (today: `ollama` only) — absent on every other provider and on every
   *  error path, which is the common case, not an exception. */
  | { type: "usage"; promptTokens: number; completionTokens: number }
  /** ASST-15's additive terminal `event: session` — the late-known Hermes session id, split out
   *  of `meta` for exactly the reason documented at this file's header. Emitted at most once,
   *  after `usage` (if any) and before `done`, and only when the serving provider actually has a
   *  session to report (today: `hermes` only) — absent on every error path and for every other
   *  provider, which is the common case, not an exception. */
  | { type: "session"; providerSession: string };

/** Translate the gateway's raw SSE bytes into `GatewayStreamEvent`s per the ASST-10 grammar (plus
 *  ASST-11's additive `meta`/`usage`). Terminates (returns) after yielding `done`, `error`, or the
 *  synthesized `abnormal_drop` — never yields anything after a terminal event, mirroring the
 *  gateway's own "exactly one terminal" invariant. `meta`/`usage` are non-terminal and simply keep
 *  the loop going. Any OTHER/unrecognised named event (a future grammar-v3+ addition this file has
 *  never heard of) is silently ignored rather than mis-parsed as a token or thrown as an error —
 *  the additive-event contract this whole file consumes requires that an unknown event type never
 *  breaks the stream. */
export async function* parseGatewayStream(body: ReadableStream<Uint8Array>): AsyncGenerator<GatewayStreamEvent> {
  let sawTerminal = false;
  for await (const raw of iterateSSEBlocks(body)) {
    switch (raw.event) {
      case "error": {
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
      case "done": {
        sawTerminal = true;
        yield { type: "done" };
        return;
      }
      case "meta": {
        try {
          const parsed = JSON.parse(raw.data) as { provider?: unknown; model?: unknown };
          if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
            yield { type: "meta", provider: parsed.provider, model: parsed.model };
          }
          // A malformed-but-present meta frame (missing/wrong-typed fields) is dropped, not
          // thrown — absent-tolerant per the additive-event contract; the badge simply stays
          // "unknown provider" for this stream, exactly as if the gateway had never sent it.
        } catch {
          // Same reasoning — a parse failure must never break the stream.
        }
        continue;
      }
      case "usage": {
        try {
          const parsed = JSON.parse(raw.data) as { promptTokens?: unknown; completionTokens?: unknown };
          if (typeof parsed.promptTokens === "number" && typeof parsed.completionTokens === "number") {
            yield { type: "usage", promptTokens: parsed.promptTokens, completionTokens: parsed.completionTokens };
          }
        } catch {
          // Same reasoning — drop, never throw. The estimate remains the labelled fallback.
        }
        continue;
      }
      case "session": {
        // ASST-15 — terminal-adjacent (arrives after usage, before done), non-terminal itself.
        try {
          const parsed = JSON.parse(raw.data) as { providerSession?: unknown };
          if (typeof parsed.providerSession === "string" && parsed.providerSession) {
            yield { type: "session", providerSession: parsed.providerSession };
          }
          // Empty/missing/wrong-typed -> dropped, never thrown: the gateway's own discipline is
          // "never sent empty", but this consumer stays absent-tolerant regardless.
        } catch {
          // Same reasoning — a parse failure must never break the stream.
        }
        continue;
      }
      case "message": {
        // Default (unnamed) event: `data` is the JSON STRING of the token text (ASST-10).
        let text: unknown;
        try {
          text = JSON.parse(raw.data);
        } catch {
          text = raw.data; // defensive fallback — treat unparsable data as literal text
        }
        yield { type: "token", text: typeof text === "string" ? text : String(text) };
        continue;
      }
      default:
        // Unrecognised event name — a future additive frame this file has never heard of. Ignore
        // it and keep reading; this is the whole point of the additive-event contract.
        continue;
    }
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
  /** ASST-12 — relays a `meta` frame the instant it arrives (i.e. before any further tokens), so a
   *  live-streaming client can show "served by <provider>" without waiting for `done`. Called at
   *  most once per generation (the gateway's own invariant — see `GatewayStreamEvent`'s header).
   *  ASST-15: no longer carries `providerSession` — see `session` below. */
  meta: (provider: string, model: string) => void;
  /** ASST-15 — relays the terminal `event: session` the instant it arrives (after usage, before
   *  done): the late-known provider session id (today: hermes only). Called at most once, and
   *  only when the serving provider actually reported one. */
  session: (providerSession: string) => void;
  /** `tokens`/`latencyMs` keep their ASST-06 meaning (a total count + wall-clock latency at
   *  terminal time). `source` says which kind of count `tokens` actually is: `"provider"` when
   *  `promptTokens`/`completionTokens` came from ASST-11's real `usage` frame (in which case
   *  `tokens` is their sum), or `"estimate"` when no provider-reported usage ever arrived (the
   *  ~4-chars/token approximation, unchanged from ASST-06). `promptTokens`/`completionTokens` are
   *  only ever set alongside `source === "provider"`. */
  usage: (tokens: number, latencyMs: number, source: "provider" | "estimate", promptTokens?: number, completionTokens?: number) => void;
  done: () => void;
  error: (message: string, errorKind: string) => void;
}

export interface RelayResult {
  /** Full concatenated text received before the terminal event (possibly partial on error/stop). */
  text: string;
  /** Total token count. Despite the name (kept for call-site stability), this is the REAL
   *  provider-reported total (promptTokens + completionTokens) whenever `usageSource ===
   *  "provider"` — it is only ever the ~4-chars/token estimate when `usageSource === "estimate"`. */
  tokensEstimate: number;
  latencyMs: number;
  outcome: "done" | "error";
  errorKind?: string;
  errorMessage?: string;
  /** ASST-11's `meta` — the provider/model that actually served this reply. Undefined (persisted
   *  as NULL) when `meta` never arrived: an older gateway, or a provider that died before
   *  committing any bytes to the wire. Absence is "unknown provider", never an error. THIS may
   *  legitimately differ from `RelayGenerationInput.provider` (the hint) — a hint for a down
   *  provider falls through to the chain (OQ-6), and this field always names the ACTUAL server,
   *  never the requested one (ASST-16's "the badge shows the truth" requirement). */
  provider?: string;
  model?: string;
  /** ASST-15's terminal `event: session` — undefined unless the SERVING provider actually
   *  reported one (today: hermes only). ASST-16 persists this to
   *  `assistant_threads.hermes_session_id` and threads it back as `providerSession` on the NEXT
   *  turn so the same Hermes conversation resumes. */
  providerSession?: string;
  /** `"provider"` only when ASST-11's real `usage` frame arrived (today: `ollama` only);
   *  `"estimate"` otherwise — including every error/abnormal-drop path, since a provider never
   *  reports usage on those. This is what makes the persisted `tokens` column (and the UI's cost
   *  meter) able to say which kind of number it is showing instead of presenting an estimate as a
   *  measurement. */
  usageSource: "provider" | "estimate";
  promptTokens?: number;
  completionTokens?: number;
}

export interface RelayGenerationInput {
  tenantId: string;
  prompt: string;
  emit: RelayEmit;
  idleTimeoutMs?: number;
  gatewayUrl?: string;
  gatewayToken?: string;
  fetchImpl?: typeof fetch;
  /** ASST-16 — the thread's `brain_provider` (e.g. `'hermes'`), sent as `/complete/stream`'s
   *  optional `provider` HINT. A pure reordering of the chain's provider snapshot on the gateway
   *  side (ASST-15's `chain.RunWithHint`) — never a hard requirement. Absent/empty ⇒ the gateway's
   *  normal failover chain picks, byte-identical to before this ticket. */
  provider?: string;
  /** ASST-16 — the thread's `hermes_session_id` (if any), sent as `/complete/stream`'s optional
   *  `providerSession` field. Opaque to platform-nest too — we only round-trip whatever the
   *  gateway told us on a PRIOR turn's `event: session`; we never generate or inspect it. */
  providerSession?: string;
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

  // ASST-12 — captured from `meta`/`usage` GatewayStreamEvents as they arrive (see that type's
  // header). Both stay undefined when the corresponding frame never arrives, which is the common,
  // non-error case — every early-return below must therefore default `usageSource` to
  // `"estimate"` and leave `provider`/`model` undefined rather than guessing.
  let metaProvider: string | undefined;
  let metaModel: string | undefined;
  let metaProviderSession: string | undefined;
  let realPromptTokens: number | undefined;
  let realCompletionTokens: number | undefined;

  try {
    const url = (input.gatewayUrl ?? config.services.gateway.url).replace(/\/$/, "");
    if (!url) {
      const msg = "ai-gateway-go is not configured (GATEWAY_URL unset) — the assistant fails closed rather than degrading silently";
      input.emit.error(msg, "not_configured");
      return { text, tokensEstimate: 0, latencyMs: latencyMs(), outcome: "error", errorKind: "not_configured", errorMessage: msg, usageSource: "estimate" };
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
      // ASST-16: `provider`/`providerSession` are ASST-15's optional hint fields. Omitted (rather
      // than sent as "") when absent, matching the gateway's own "absent hint ⇒ byte-identical to
      // before this ticket" contract for every OTHER caller of this route.
      body: JSON.stringify({
        prompt: input.prompt,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.providerSession ? { providerSession: input.providerSession } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const msg = `ai-gateway /complete/stream returned HTTP ${res.status}`;
      input.emit.error(msg, "transport_error");
      return { text, tokensEstimate: estimateTokens(text), latencyMs: latencyMs(), outcome: "error", errorKind: "transport_error", errorMessage: msg, usageSource: "estimate" };
    }

    for await (const evt of parseGatewayStream(res.body as ReadableStream<Uint8Array>)) {
      resetIdleTimer(); // any activity from upstream resets the idle clock, tokens or terminal alike
      if (evt.type === "meta") {
        // Gateway invariant (ASST-11/15): emitted at most once, PRE-first-token, naming the
        // provider that actually committed bytes — captured verbatim, never re-derived. ASST-15:
        // never carries providerSession anymore (see the `session` case below).
        metaProvider = evt.provider;
        metaModel = evt.model;
        input.emit.meta(evt.provider, evt.model);
        continue;
      }
      if (evt.type === "usage") {
        // Terminal-adjacent (arrives just before `done`), but non-terminal itself — keep reading.
        realPromptTokens = evt.promptTokens;
        realCompletionTokens = evt.completionTokens;
        continue;
      }
      if (evt.type === "session") {
        // ASST-15: terminal-adjacent (arrives after usage, before done) — the late-known Hermes
        // session id. Captured + relayed the instant it arrives; never invented on any other path.
        metaProviderSession = evt.providerSession;
        input.emit.session(evt.providerSession);
        continue;
      }
      if (evt.type === "token") {
        text += evt.text;
        input.emit.token(evt.text);
        continue;
      }
      if (evt.type === "done") {
        const lm = latencyMs();
        // Real provider-reported usage OVERRIDES the estimate whenever it arrived; otherwise the
        // ASST-06 ~4-chars/token estimate remains the labelled fallback — never presented as a
        // measurement (see RelayResult.usageSource's header).
        const hasRealUsage = realPromptTokens !== undefined && realCompletionTokens !== undefined;
        const tokensTotal = hasRealUsage ? realPromptTokens! + realCompletionTokens! : estimateTokens(text);
        const usageSource: "provider" | "estimate" = hasRealUsage ? "provider" : "estimate";
        input.emit.usage(tokensTotal, lm, usageSource, realPromptTokens, realCompletionTokens);
        input.emit.done();
        return {
          text, tokensEstimate: tokensTotal, latencyMs: lm, outcome: "done",
          provider: metaProvider, model: metaModel, providerSession: metaProviderSession,
          usageSource, promptTokens: realPromptTokens, completionTokens: realCompletionTokens,
        };
      }
      if (evt.type === "error") {
        const lm = latencyMs();
        input.emit.error(evt.error, "upstream_error");
        return {
          text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "upstream_error", errorMessage: evt.error,
          provider: metaProvider, model: metaModel, providerSession: metaProviderSession, usageSource: "estimate",
        };
      }
      // evt.type === "abnormal_drop" — the wire ended without done/error. Treated as an error,
      // never as success (this ticket's explicit mandate).
      const lm = latencyMs();
      const msg = "upstream stream ended without a done event (abnormal drop)";
      input.emit.error(msg, "abnormal_drop");
      return {
        text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "abnormal_drop", errorMessage: msg,
        provider: metaProvider, model: metaModel, providerSession: metaProviderSession, usageSource: "estimate",
      };
    }
    // Unreachable in practice: parseGatewayStream always yields exactly one terminal event before
    // its generator returns. Kept as a typed fallback rather than an assertion so a future
    // change to that generator fails loudly here instead of hanging the caller.
    const lm = latencyMs();
    const msg = "upstream stream ended unexpectedly with no terminal event";
    input.emit.error(msg, "abnormal_drop");
    return {
      text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind: "abnormal_drop", errorMessage: msg,
      provider: metaProvider, model: metaModel, providerSession: metaProviderSession, usageSource: "estimate",
    };
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
    return {
      text, tokensEstimate: estimateTokens(text), latencyMs: lm, outcome: "error", errorKind, errorMessage,
      provider: metaProvider, model: metaModel, providerSession: metaProviderSession, usageSource: "estimate",
    };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    activeGenerations.delete(entry.threadId);
  }
}

// ────────────────────────────────── persistence-shape helper (ASST-12) ───────────────────────────

/** The shape persisted into `assistant_messages.parts` (jsonb, previously always `[]` and unused —
 *  no schema change needed, see this ticket's own header note) to carry `usageSource` and the
 *  real prompt/completion breakdown, alongside the existing `provider`/`model`/`tokens` columns.
 *  Kept as its own tiny helper (not inlined at the one call site) so the shape has exactly one
 *  definition the UI's `parseUsageMeta` mirrors byte-for-byte. */
export interface UsageMetaPart {
  type: "usage_meta";
  usageSource: "provider" | "estimate";
  promptTokens?: number;
  completionTokens?: number;
}

export function usageMetaParts(result: Pick<RelayResult, "usageSource" | "promptTokens" | "completionTokens">): UsageMetaPart[] {
  return [{
    type: "usage_meta",
    usageSource: result.usageSource,
    ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
    ...(result.completionTokens !== undefined ? { completionTokens: result.completionTokens } : {}),
  }];
}

// ──────────────────────────────────── SSE encoding to OUR client ─────────────────────────────────

/** Encode ONE line of the SSE response THIS controller sends to the ERP browser, applying the
 *  identical "exactly one line of JSON" discipline ASST-10 fixed on the gateway's own wire — see
 *  this file's header. `JSON.stringify` of any value can never itself contain a raw newline
 *  (embedded `\n`/`\n\n` become the two/four-character escapes), so this framing is safe for
 *  arbitrary token text (markdown, fenced code, multi-paragraph answers) end to end, the same
 *  property ASST-10 established for the gateway->platform hop. */
export function sseLine(event: "token" | "meta" | "usage" | "done" | "error", data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
