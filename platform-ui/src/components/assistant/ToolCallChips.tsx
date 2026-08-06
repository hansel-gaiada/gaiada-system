import type { NormalizedToolCall } from "@/lib/assistant";

// T4 (ASST-23) — the plain-read/refusal half of a tool turn (`partitionToolCalls`'s `chips` bucket:
// `isWriteProposal(call) === false` — never a write proposal, so there is nothing to confirm/dismiss
// and no D14 state to track; just "this ran, here's what happened"). Deliberately a small inline row
// under the bubble, matching `CitationChips`'s own visual weight — a write proposal is the thing that
// deserves a full `ProposalCard`; a read succeeding or being denied does not.
const CHIP_LABEL: Record<string, string> = {
  running: "Running…",
  succeeded: "Succeeded",
  failed: "Failed",
  denied: "Denied",
  pending: "Pending",
};

export function ToolCallChips({ calls }: { calls: NormalizedToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <div className="asst-toolchip-row" aria-label="Tool calls">
      {calls.map((c) => (
        <span key={c.callId} className="asst-toolchip" data-status={c.status} title={c.resultSummary ?? undefined}>
          <span className="asst-toolchip__name">{c.toolName}</span>
          <span className="asst-toolchip__status">{CHIP_LABEL[c.status] ?? c.status}</span>
        </span>
      ))}
    </div>
  );
}
