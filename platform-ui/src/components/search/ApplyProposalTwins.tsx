"use client";
// SM-19 — the SEM dual-mode EXECUTION picker (design §04/§07/§08 SM-19; SM-30's backend routes).
// This is NOT `PaidActionGate` (that's the per-metered-pull provider/cost/mode disclosure) — a
// change proposal's "mode" is manual-export-vs-API-push, a different axis SM-30/21 own, with no
// `search_data_cache`/provider-ledger involvement at all. Rendered per APPROVED or APPLIED proposal
// row; PROPOSED/DISMISSED rows show neither twin (nothing to execute yet, or ever).
//
// Honesty rules this file exists to enforce (ticket §12 AC: "both twins render; approval-pending +
// applied states correct"):
//   - The MANUAL twin (export CSV -> mark applied) is the only one with a real backend today
//     (SM-30, landed). It is rendered fully live.
//   - The AUTOMATED (api) twin has NO executor yet (SM-21 is still TODO) — rendered as an
//     honestly-DISABLED state naming the missing ticket, never a button that would silently do
//     nothing or 400. "Unavailable" here, same house rule PaidActionGate applies to a keyless
//     provider: absence of capability must never look like a working control.
//   - Re-export is harmless (SM-30's own backend rule: allowed on 'approved' AND 'applied', for a
//     re-download) — this component always offers a Download link once `exportFileId` exists,
//     regardless of which render this is.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ProviderLabel, SimulatedBadge } from "@/components/search/SimulatedBadge";
import { exportChangeProposal, markChangeProposalApplied } from "@/lib/searchMarketingActions";
import type { SearchChangeProposal, ChangeProposalExportResult } from "@/lib/searchMarketingShared";

const DANGER = "var(--erp-danger, #B5622F)";
const MUTED = "var(--erp-ink-60)";

function downloadHref(proposalId: string): string {
  return `/api/search/change-proposals/${proposalId}/export-file`;
}

function ProvenanceLine({ provenance }: { provenance: ChangeProposalExportResult["provenance"] }) {
  if (!provenance) return null; // non-'launch' kinds carry no keyword provenance — no chip, no claim.
  const { providers, simulatedCount, realCount, unpulledCount } = provenance;
  return (
    <p style={{ margin: 0, font: "400 12px/1.6 var(--font-body)", color: MUTED }}>
      Keyword data behind this export: {realCount} real, {simulatedCount} simulated, {unpulledCount} not yet pulled
      {providers.length > 0 && (
        <>
          {" — "}
          {providers.map((p) => <ProviderLabel key={p} provider={p} />)}
        </>
      )}
      {simulatedCount > 0 && <SimulatedBadge />}
    </p>
  );
}

export function ApplyProposalTwins({
  tenantId, campaignId, proposal, canManage, canLaunch,
}: {
  tenantId: string;
  campaignId: string;
  proposal: SearchChangeProposal;
  /** Gates "Export CSV" — the backend's own `update` Cerbos action (baseline `search.manage`). */
  canManage: boolean;
  /** Gates "Mark as applied" — the backend's elevated `apply_manual` Cerbos action
   *  (`search.campaign.launch`). Deliberately a DIFFERENT flag from `canManage`: an operator who can
   *  export cannot necessarily attest the change was actually made in the ad platform. */
  canLaunch: boolean;
}) {
  const router = useRouter();
  const [exportResult, setExportResult] = useState<ChangeProposalExportResult | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exportPending, startExport] = useTransition();
  const [applyPending, startApply] = useTransition();

  if (proposal.status !== "approved" && proposal.status !== "applied") return null;

  const isManual = proposal.mode === "manual";

  function doExport() {
    setError(null);
    startExport(async () => {
      const res = await exportChangeProposal(tenantId, campaignId, proposal.id);
      if (!res.ok || !res.result) {
        setError(res.error ?? "Couldn't export this proposal.");
        return;
      }
      setExportResult(res.result);
      router.refresh(); // picks up the persisted exportFileId for a future page load
    });
  }

  function doMarkApplied() {
    setError(null);
    startApply(async () => {
      const res = await markChangeProposalApplied(tenantId, campaignId, proposal.id, note.trim() || undefined);
      if (!res.ok) {
        setError(res.error ?? "Couldn't mark this proposal applied.");
        return;
      }
      setNote("");
      router.refresh();
    });
  }

  const hasExport = Boolean(exportResult) || Boolean(proposal.exportFileId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 0" }}>
      {error && <p role="alert" style={{ margin: 0, font: "400 12px var(--font-body)", color: DANGER }}>{error}</p>}

      {proposal.status === "applied" && (
        <p style={{ margin: 0, font: "600 12px var(--font-body)", color: "var(--erp-ok, #3a7a54)" }}>
          Applied{proposal.appliedBy ? ` by user ${proposal.appliedBy}` : ""}
          {proposal.appliedAt ? ` at ${new Date(proposal.appliedAt).toLocaleString()}` : ""}.
        </p>
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {/* Manual twin — the only one with a real executor today. */}
        <div style={{ border: "0.5px solid var(--erp-hairline)", borderRadius: 4, padding: 10, flex: "1 1 260px", opacity: isManual ? 1 : 0.55 }}>
          <p style={{ margin: "0 0 8px", font: "600 11px var(--font-body)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-primary)" }}>
            Manual twin
          </p>
          {!isManual ? (
            <p style={{ margin: 0, font: "400 12px/1.6 var(--font-body)", color: MUTED }}>
              This proposal is mode=&apos;api&apos; — the manual export/mark-applied path is only
              available for mode=&apos;manual&apos; proposals (the backend refuses it here).
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0, font: "400 12px/1.6 var(--font-body)", color: MUTED }}>
                Export an Ads-Editor-ready CSV, apply it by hand in the ad platform, then confirm it
                here. Zero OAuth, no live side effect from this console.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {canManage && (
                  <Button variant="ghost" size="sm" disabled={exportPending} onClick={doExport}>
                    {exportPending ? "Exporting…" : hasExport ? "Re-export CSV" : "Export CSV"}
                  </Button>
                )}
                {hasExport && (
                  <a href={downloadHref(proposal.id)} style={{ font: "600 12px var(--font-body)", color: "var(--text-primary)" }}>
                    Download {exportResult?.filename ?? "export"}
                  </a>
                )}
              </div>
              {exportResult && <ProvenanceLine provenance={exportResult.provenance} />}
              {canLaunch && proposal.status === "approved" && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 4 }}>
                  <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: MUTED }}>
                    Note (optional)
                    <input
                      value={note} onChange={(e) => setNote(e.target.value)} disabled={applyPending}
                      placeholder="Applied via Ads Editor import"
                      style={{ display: "block", marginTop: 6, width: 200, font: "400 13px var(--font-body)", padding: "5px 8px" }}
                    />
                  </label>
                  <Button variant="solid" size="sm" disabled={applyPending} onClick={doMarkApplied}>
                    {applyPending ? "Marking…" : "Mark as applied"}
                  </Button>
                </div>
              )}
              {!canLaunch && proposal.status === "approved" && (
                <p style={{ margin: 0, font: "400 11px var(--font-body)", color: MUTED }}>
                  Marking this applied needs the <code>search.campaign.launch</code> permission.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Automated (api) twin — no executor yet. Always rendered, always disabled, names the gap. */}
        <div style={{ border: "0.5px solid var(--erp-hairline)", borderRadius: 4, padding: 10, flex: "1 1 260px" }}>
          <p style={{ margin: "0 0 8px", font: "600 11px var(--font-body)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--text-primary)" }}>
            Automated (API) twin
          </p>
          <p style={{ margin: 0, font: "400 12px/1.6 var(--font-body)", color: DANGER }}>
            Unavailable — the one-shot API executor (SM-21) is not built yet.
            {isManual
              ? " This proposal is mode='manual' anyway, so it was never headed for this path."
              : ` This proposal is mode='api' and currently has no way to reach 'applied'${
                  proposal.approvalId ? "" : " (no approvalId has been minted)"
                } until SM-21 ships.`}
          </p>
        </div>
      </div>
    </div>
  );
}
