import {
  isPendingMessage, humanizeErrorKind, brainBadgeLabel, parseUsageMeta, parseCitations, parseSessionResumeMismatch, usageMeterLabel,
  normalizeThreadToolCall, normalizeLiveToolCall, partitionToolCalls,
  type AssistantMessage, type StreamState,
} from "@/lib/assistant";
import { renderMarkdownLite } from "./markdownLite";
import { CitationChips } from "./CitationChips";
import { ProposalCard } from "./ProposalCard";
import { ToolCallChips } from "./ToolCallChips";

// ASST-07 — one message bubble. `streaming`/`liveText` are set ONLY for the single row currently
// being generated in THIS tab (see AssistantWorkspace) — every other row renders its persisted
// `content` straight from the last server fetch, which is what makes "refresh restores the exact
// transcript" true: there is no separate "history" rendering path, the same component draws both.
//
// ── ASST-12 — "served by" badge + the truthful cost meter ─────────────────────────────────────────
// A finished row reads `message.provider`/`model` (filled from ASST-11's `meta` frame — null means
// the gateway never announced a serving provider, the honest common-path state) and its usage
// source out of `message.parts` (`parseUsageMeta`, mirroring platform-nest's `usageMetaParts`
// byte-for-byte — the source is READ, never re-derived here). The row currently streaming in THIS
// tab instead reads `liveState.meta`/`liveState.usage` so a mid-generation failover is visible the
// instant it happens, not only after the transcript reloads — that immediacy is the whole point of
// ASST-11 naming the provider at first-byte-release rather than at `done`.
// T4 (ASST-23) — `errorKind`s that end the turn but are NOT a failure: the proposal card (below)
// is what tells the true story for these two, so the generic red error paragraph must never render
// for them — rendering it would reintroduce exactly the "approval does not execute"-shaped
// confusion this ticket is required to remove (a suspended write is progress, not an error).
const NON_ERROR_TERMINAL_KINDS = new Set(["confirm_required", "approval_required"]);

export function Message({ message, streaming, liveText, liveState, threadId }: {
  message: AssistantMessage;
  streaming?: boolean;
  liveText?: string;
  liveState?: StreamState;
  /** Needed only to build the Confirm/Dismiss endpoints' URL (`ProposalCard`) — this component
   *  otherwise has no reason to know which thread it's rendering inside. */
  threadId: string;
}) {
  const isUser = message.role === "user";
  const pending = isPendingMessage(message);
  const bodyText = streaming ? liveText ?? "" : message.content ?? "";
  const failed = !streaming && !!message.errorKind && message.errorKind !== "stopped" && !NON_ERROR_TERMINAL_KINDS.has(message.errorKind);
  const stopped = !streaming && message.errorKind === "stopped";

  const provider = streaming ? liveState?.meta?.provider ?? null : message.provider;
  const model = streaming ? liveState?.meta?.model ?? null : message.model;
  // While streaming, the row is STILL structurally "pending" (content is null until `done`), but
  // a `meta` frame may already have named the serving provider — show the badge as soon as it's
  // known rather than waiting for the pending guard to clear.
  const showBadge = !isUser && (streaming || !pending);

  const usageMeta = parseUsageMeta(message.parts);
  const tokens = streaming ? liveState?.usage?.tokens ?? null : message.tokens;
  const usageSource = streaming ? liveState?.usage?.source ?? null : usageMeta?.usageSource ?? null;
  const meterLabel = usageMeterLabel(tokens, usageSource);

  // ASST-18 — while streaming, read the LIVE frame (arrived before any token, per stream.ts's own
  // ordering guarantee); once finalized, read the persisted `parts` — the same "live state during
  // the turn, then the reload-safe record" split ASST-12's badge/meter already use above.
  const citations = streaming ? liveState?.citations ?? [] : parseCitations(message.parts);

  // ASST-24 — read-only, persisted-only (no live-stream counterpart exists — see
  // `parseSessionResumeMismatch`'s own header). Never shown on the row currently streaming in
  // THIS tab; appears once the transcript reloads after the turn finishes, exactly like a
  // refresh would show it. `null` for the overwhelming common case (a genuine resume, turn 1, or
  // an older gateway) — rendered as nothing, never as an error.
  const sessionResumeMismatch = !streaming ? parseSessionResumeMismatch(message.parts) : null;

  // T4 (ASST-23, §7.2/§7.4) — same "live during the turn, then the reload-safe record" split as
  // citations/meta/usage above: while THIS row is the one streaming, read the SSE-accumulated
  // `liveState.toolCalls`; once finalized (or on any historical row), read the persisted,
  // reload-joined `message.toolCalls`. Both normalize down to the SAME shape (`NormalizedToolCall`)
  // before `partitionToolCalls` splits them into plain chips vs. full proposal cards — see that
  // function's header for why `isWriteProposal`, never `approvalId` alone, is the split.
  const normalizedToolCalls = streaming
    ? (liveState?.toolCalls ?? []).map(normalizeLiveToolCall)
    : (message.toolCalls ?? []).map(normalizeThreadToolCall);
  const { proposals, chips } = partitionToolCalls(normalizedToolCalls);

  return (
    // VER-03 — `.asst-thread` (the ancestor list) is `role="log"`, an implicit-polite live region:
    // ANY DOM mutation inside it — including a text node changing, not just a node being added — is
    // fair game for a screen reader to queue up and announce. That is exactly what the typewriter
    // smoother (`useTypewriter`, REVEAL_TICK_MS = 16) produces for the row currently streaming: a
    // text-node mutation every ~16ms. Without this, that reads as the "spam every token" failure
    // mode this ticket calls out by name, even though nothing here uses `aria-live="assertive"` —
    // the implicit "polite" default on `role="log"` is enough to cause it on its own. `aria-live`
    // is re-computed per descendant, so setting it to "off" on JUST the actively-streaming row
    // takes this one row out of the log's liveness for the duration of the stream, while every
    // OTHER row (a newly-added user message, a newly-added assistant placeholder, a later reply
    // added to a DIFFERENT thread's log) is still announced normally. The already-separate
    // `StreamIndicator` (`role="status" aria-live="polite"`) is what actually announces the
    // thinking → responding → finished/stopped/error transitions — this row's own text is
    // deliberately never read aloud token-by-token OR as one long dump; a screen-reader user is
    // told when a reply lands and can then read it like any other content.
    <article className={`asst-msg asst-msg--${isUser ? "user" : "assistant"}`} aria-live={streaming ? "off" : undefined}>
      <div className="asst-msg__role">{isUser ? "You" : "Assistant"}</div>
      <div className="asst-msg__bubble">
        {pending && !streaming ? (
          <p className="asst-msg__meta">Generating a reply…</p>
        ) : bodyText ? (
          <div className="asst-msg__body">
            {renderMarkdownLite(bodyText)}
            {streaming && <span className="asst-cursor" aria-hidden="true" />}
          </div>
        ) : (
          !failed && !stopped && <p className="asst-msg__meta">(empty reply)</p>
        )}
        {stopped && <p className="asst-msg__meta asst-msg__meta--stopped">Stopped{bodyText ? "." : " before any reply."}</p>}
        {failed && <p className="asst-msg__error">{humanizeErrorKind(message.errorKind as string)}</p>}
        {!isUser && citations.length > 0 && <CitationChips citations={citations} />}
        {/* T4 (ASST-23) — tool chips (plain reads/refusals) then proposal cards (write intents this
            turn drafted). Order is deliberate: "here's what I looked at" before "here's what I want
            to do", the same order a human explanation would use. */}
        {!isUser && chips.length > 0 && <ToolCallChips calls={chips} />}
        {!isUser && proposals.length > 0 && (
          <div className="asst-proposal-row">
            {proposals.map((p) => <ProposalCard key={p.callId} call={p} threadId={threadId} />)}
          </div>
        )}
        {/* ASST-24 — quiet, honest note: the reply itself is valid (never rendered as an error or
            a failure state); only Hermes' OWN memory diverged. The earlier turns are still right
            here in this transcript — it is the provider's side that restarted. */}
        {!isUser && sessionResumeMismatch && (
          <p className="asst-msg__session-note">
            Hermes couldn&apos;t resume the previous conversation and started a new one.
          </p>
        )}
        {showBadge && (
          <div className="asst-msg__servedby">
            <span className="asst-msg__badge">{brainBadgeLabel(provider, model)}</span>
            {meterLabel && <span className="asst-msg__usage">{meterLabel}</span>}
          </div>
        )}
      </div>
    </article>
  );
}
