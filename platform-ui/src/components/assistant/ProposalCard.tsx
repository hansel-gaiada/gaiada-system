"use client";
import { useState } from "react";
import {
  canActOnProposal, deriveProposalCardState, formatExpiresAt, formatRedactedArgs, proposalStateLabel,
  type NormalizedToolCall,
} from "@/lib/assistant";
import { confirmWriteAction, dismissWriteAction } from "@/lib/assistantActions";

// T4 (ASST-23, §7.2/§7.4) — the D14 execution chip: the full write-proposal lifecycle in ONE card,
// `proposed (awaiting your confirm) -> sent for approval -> approved+executed | approved+failed
// (an administrator can retry) -> rejected | dismissed | expired | approved but not executable`.
// This ticket REMOVES the old "approval does not execute" disclaimer — that is no longer true (D14
// executes on decide) — by never having written one here in the first place; there is nothing to
// delete, only a requirement not to reintroduce it.
//
// ── WHY A LOCAL OPTIMISTIC OVERRIDE, AND WHY IT NEVER MASKS A NEWER RELOAD ────────────────────────
// Confirm/dismiss return the post-action state directly (no extra fetch needed) — used here as an
// immediate local override so the card doesn't sit on "awaiting confirmation" for the ~4s until the
// next reload/poll. The override is trusted ONLY while the caller's own `call` prop STILL reads
// `awaiting_confirmation` — the instant a fresher reload brings real (possibly further-advanced,
// e.g. already executed) state, the prop wins. That is the same "the ledger row is never mutated by
// this component, state is derived at read time" invariant the backend itself holds, applied
// client-side: this component never has to know whether it's ahead of or behind the server, it just
// always prefers the fresher of the two.
export function ProposalCard({ call, threadId }: { call: NormalizedToolCall; threadId: string }) {
  const [override, setOverride] = useState<Partial<NormalizedToolCall> | null>(null);
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const propState = deriveProposalCardState(call);
  const effective: NormalizedToolCall = propState === "awaiting_confirmation" && override ? { ...call, ...override } : call;
  const state = deriveProposalCardState(effective);
  const actionable = canActOnProposal(state);
  const argsPreview = formatRedactedArgs(effective.args);
  const expiresLabel = effective.expiresAt ? formatExpiresAt(effective.expiresAt) : null;

  async function handleConfirm() {
    setBusy("confirm");
    setActionError(null);
    const r = await confirmWriteAction(threadId, call.callId);
    setBusy(null);
    if (!r.ok) {
      setActionError(r.error);
      return;
    }
    setOverride({ approvalId: r.approvalId, approval: r.approval, intent: null });
  }

  async function handleDismiss() {
    setBusy("dismiss");
    setActionError(null);
    const r = await dismissWriteAction(threadId, call.callId);
    setBusy(null);
    if (!r.ok) {
      setActionError(r.error);
      return;
    }
    setOverride({ approvalId: null, approval: null, intent: { status: "dismissed" } });
  }

  return (
    <div className="asst-proposal" data-state={state}>
      <div className="asst-proposal__head">
        <span className="asst-proposal__tool">{effective.toolName}</span>
        {effective.impact && <span className="asst-proposal__impact">{effective.impact} impact</span>}
        <span className="asst-proposal__state">{proposalStateLabel(state)}</span>
      </div>

      {argsPreview.length > 0 && (
        <dl className="asst-proposal__args">
          {argsPreview.map((a) => (
            <div key={a.key} className="asst-proposal__arg">
              <dt>{a.key}</dt>
              <dd>{a.hint}</dd>
            </div>
          ))}
        </dl>
      )}

      {actionable && expiresLabel && <p className="asst-proposal__hint">Expires {expiresLabel} if not confirmed.</p>}

      {state === "execution_failed" && effective.approval?.executionError && (
        <p className="asst-proposal__error" role="alert">{effective.approval.executionError}</p>
      )}
      {actionError && <p className="asst-proposal__error" role="alert">{actionError}</p>}

      {actionable ? (
        <div className="asst-proposal__actions">
          <button
            type="button"
            className="lux-btn lux-btn--solid lux-btn--sm"
            disabled={busy !== null}
            aria-label={`Confirm write: ${effective.toolName} — send for approval`}
            onClick={handleConfirm}
          >
            {busy === "confirm" ? "Confirming…" : "Confirm"}
          </button>
          <button
            type="button"
            className="lux-btn lux-btn--ghost lux-btn--sm"
            disabled={busy !== null}
            aria-label={`Dismiss write: ${effective.toolName} — do not send it`}
            onClick={handleDismiss}
          >
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      ) : (
        effective.approvalId && (
          <a className="asst-proposal__link" href={`/approvals/${effective.approvalId}`}>
            View in Approvals →
          </a>
        )
      )}
    </div>
  );
}
