"use client";
// SM-47 — a campaign's change proposals: the dual-mode EXECUTION ARTIFACT design §04/§07 describes,
// but this ticket only ever creates proposals and lets a human approve/dismiss them — it NEVER
// executes one. 'applied' is unreachable from this file by construction (the action's own type
// signature only accepts 'approved'|'dismissed', mirroring `CHANGE_PROPOSAL_TRANSITIONS`), so there
// is no code path here that could ever imply a push to a live ad account. That is SM-19 (dual-mode
// picker) / SM-30 (manual export) / SM-21 (api-mode execution) — named explicitly below rather than
// offering a button that would read as "apply".
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { createChangeProposal, updateChangeProposalStatus } from "@/lib/searchMarketingActions";
import { CHANGE_PROPOSAL_KINDS, CHANGE_PROPOSAL_TRANSITIONS, type SearchChangeProposal } from "@/lib/searchMarketingShared";

export function ChangeProposalsPanel({
  tenantId, campaignId, proposals, canManage,
}: {
  tenantId: string;
  campaignId: string;
  proposals: SearchChangeProposal[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof CHANGE_PROPOSAL_KINDS)[number]>("pause");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const res = await createChangeProposal(tenantId, campaignId, { kind, payload: { note: note.trim() || undefined } });
      if (!res.ok) {
        setError(res.error ?? "Couldn't create this proposal.");
        return;
      }
      setNote("");
      router.refresh();
    });
  }

  function transition(proposalId: string, status: "approved" | "dismissed") {
    setError(null);
    setPendingId(proposalId);
    startTransition(async () => {
      const res = await updateChangeProposalStatus(tenantId, campaignId, proposalId, status);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't update this proposal.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {error && (
        <p role="alert" style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, #B5622F)", marginBottom: 8 }}>
          {error}
        </p>
      )}
      {proposals.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No change proposals yet for this campaign.
        </p>
      ) : (
        <HairlineTable
          columns={[{ label: "Kind" }, { label: "Mode" }, { label: "Status" }, { label: "" }]}
          rows={proposals.map((p) => {
            const reachable = CHANGE_PROPOSAL_TRANSITIONS[p.status] ?? [];
            return [
              p.kind,
              p.mode,
              <StatusBadge key="s" label={p.status} />,
              canManage ? (
                <div key="actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {reachable.includes("approved") && (
                    <Button variant="ghost" size="sm" disabled={pendingId === p.id} onClick={() => transition(p.id, "approved")}>Approve</Button>
                  )}
                  {reachable.includes("dismissed") && (
                    <Button variant="ghost" size="sm" disabled={pendingId === p.id} onClick={() => transition(p.id, "dismissed")}>Dismiss</Button>
                  )}
                  {reachable.length === 0 && <span style={{ opacity: 0.5 }}>No further action</span>}
                </div>
              ) : (
                <span key="actions" style={{ opacity: 0.5 }}>—</span>
              ),
            ];
          })}
          tcols="1fr .8fr .8fr 1.8fr"
        />
      )}
      {/* Deliberately no "Apply"/"Push to Google Ads" affordance anywhere on this panel — this
          ticket refuses that at the app layer server-side too. The dual-mode apply picker is SM-19;
          manual export is SM-30. */}
      <p style={{ font: "400 11px/1.6 var(--font-body)", color: "var(--erp-ink-50)", marginTop: 8 }}>
        Approving or dismissing here never reaches a live ad account. Actually applying an approved
        proposal (export for manual entry, or a one-shot API push) is a separate step, not built yet
        — owned by SM-30 and SM-19/21.
      </p>

      {canManage && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: proposals.length > 0 ? "0.5px solid var(--erp-hairline)" : undefined, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
            Kind
            <select
              value={kind} disabled={pending}
              onChange={(e) => setKind(e.target.value as (typeof CHANGE_PROPOSAL_KINDS)[number])}
              style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
            >
              {CHANGE_PROPOSAL_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
          <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
            Note (optional)
            <input
              value={note} onChange={(e) => setNote(e.target.value)} disabled={pending}
              placeholder="Why this change"
              style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
            />
          </label>
          <Button variant="solid" size="sm" onClick={create} disabled={pending}>
            {pending ? "Proposing…" : "Propose change"}
          </Button>
        </div>
      )}
    </div>
  );
}
