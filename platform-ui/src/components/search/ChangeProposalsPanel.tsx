"use client";
// SM-47 (create/approve/dismiss) + SM-19 (this revision: the dual-mode EXECUTION picker design
// §04/§07 describes). The generic PATCH-based transition below still only ever reaches
// 'approved'/'dismissed' — 'applied' is unreachable from THAT code path by construction
// (`updateChangeProposalStatus`'s own type signature only accepts those two, mirroring
// `CHANGE_PROPOSAL_TRANSITIONS`). Actually EXECUTING an approved proposal now renders via
// `ApplyProposalTwins` (SM-30's manual export/mark-applied + the honestly-disabled automated twin)
// — see that file for the dual-mode picker itself; this panel just decides WHEN to show it (any
// row whose status is 'approved' or 'applied') and lets the operator choose 'manual'/'api' MODE up
// front, at the moment they propose a change (the mode is fixed thereafter — SM-18's own PATCH
// still permits editing `mode` only while status='proposed', which this panel does not offer a
// control for yet; changing your mind before approval means dismissing and re-proposing).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { createChangeProposal, updateChangeProposalStatus } from "@/lib/searchMarketingActions";
import { ApplyProposalTwins } from "@/components/search/ApplyProposalTwins";
import { CHANGE_PROPOSAL_KINDS, CHANGE_PROPOSAL_MODES, CHANGE_PROPOSAL_TRANSITIONS, type SearchChangeProposal } from "@/lib/searchMarketingShared";

export function ChangeProposalsPanel({
  tenantId, campaignId, proposals, canManage, canLaunch,
}: {
  tenantId: string;
  campaignId: string;
  proposals: SearchChangeProposal[];
  canManage: boolean;
  /** SM-19 — gates "Mark as applied" inside `ApplyProposalTwins` (Cerbos `apply_manual`,
   *  `search.campaign.launch`). Export/create/approve/dismiss stay on `canManage`. */
  canLaunch: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<(typeof CHANGE_PROPOSAL_KINDS)[number]>("pause");
  const [mode, setMode] = useState<(typeof CHANGE_PROPOSAL_MODES)[number]>("manual");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const res = await createChangeProposal(tenantId, campaignId, { kind, payload: { note: note.trim() || undefined }, mode });
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
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
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
          {/* SM-19 — the dual-mode picker itself: only an APPROVED or APPLIED proposal has anything
              to execute. Proposed/dismissed rows render neither twin (nothing exists to apply yet,
              or ever). Rendered per-row, directly below the table, so it stays attached to the
              proposal it belongs to rather than becoming a second, disconnected list. */}
          {proposals.filter((p) => p.status === "approved" || p.status === "applied").map((p) => (
            <div key={p.id} style={{ borderTop: "0.5px solid var(--erp-hairline-soft, var(--erp-hairline))", paddingTop: 6 }}>
              <p style={{ margin: "0 0 4px", font: "600 11px var(--font-body)", color: "var(--erp-ink-60)" }}>
                Apply — {p.kind} ({p.status})
              </p>
              <ApplyProposalTwins tenantId={tenantId} campaignId={campaignId} proposal={p} canManage={canManage} canLaunch={canLaunch} />
            </div>
          ))}
        </div>
      )}
      <p style={{ font: "400 11px/1.6 var(--font-body)", color: "var(--erp-ink-50)", marginTop: 8 }}>
        Approving or dismissing here never reaches a live ad account by itself. An approved proposal
        only reaches a live account through the twin above it chooses: the manual export/mark-applied
        path (built, SM-30) or a one-shot API push (SM-21, not built yet — that twin always renders
        disabled and says so).
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
            Execution mode
            <select
              value={mode} disabled={pending}
              onChange={(e) => setMode(e.target.value as (typeof CHANGE_PROPOSAL_MODES)[number])}
              style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
            >
              {CHANGE_PROPOSAL_MODES.map((m) => (
                <option key={m} value={m}>{m === "manual" ? "manual — export & apply by hand" : "api — automated push (SM-21 not built yet)"}</option>
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
          {mode === "api" && (
            <p role="alert" style={{ margin: 0, font: "400 11px/1.5 var(--font-body)", color: "var(--erp-warn, #9c6f1f)", flexBasis: "100%" }}>
              No automated executor exists yet (SM-21) — an api-mode proposal will sit at
              &apos;approved&apos; with no path to &apos;applied&apos; until it ships. Pick manual if
              you want to actually apply this change today.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
