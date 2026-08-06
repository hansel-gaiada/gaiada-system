import {
  isPendingMessage, humanizeErrorKind, brainBadgeLabel, parseUsageMeta, parseCitations, parseSessionResumeMismatch, usageMeterLabel,
  type AssistantMessage, type StreamState,
} from "@/lib/assistant";
import { renderMarkdownLite } from "./markdownLite";
import { CitationChips } from "./CitationChips";

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
export function Message({ message, streaming, liveText, liveState }: {
  message: AssistantMessage;
  streaming?: boolean;
  liveText?: string;
  liveState?: StreamState;
}) {
  const isUser = message.role === "user";
  const pending = isPendingMessage(message);
  const bodyText = streaming ? liveText ?? "" : message.content ?? "";
  const failed = !streaming && !!message.errorKind && message.errorKind !== "stopped";
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

  return (
    <article className={`asst-msg asst-msg--${isUser ? "user" : "assistant"}`}>
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
