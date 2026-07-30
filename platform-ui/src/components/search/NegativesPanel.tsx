"use client";
// SM-47 — a campaign's negative keywords: manual create, AI classification over a pasted
// search-term list (design §07: "Search-term -> negative classification"; no live search-term sync
// exists yet, SM-20's job), status transitions (proposed/approved/dismissed — 'applied' is stamped
// only by SM-30/21's execution flow, never reachable here), delete.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { createNegative, updateNegativeStatus, deleteNegative, proposeNegatives } from "@/lib/searchMarketingActions";
import type { SearchNegative } from "@/lib/searchMarketingShared";

export function NegativesPanel({
  tenantId, campaignId, negatives, canManage,
}: {
  tenantId: string;
  campaignId: string;
  negatives: SearchNegative[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [proposeText, setProposeText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [proposeNote, setProposeNote] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    if (!term.trim()) {
      setError("Enter a search term to exclude.");
      return;
    }
    startTransition(async () => {
      const res = await createNegative(tenantId, campaignId, { term: term.trim() });
      if (!res.ok) {
        setError(res.error ?? "Couldn't create this negative.");
        return;
      }
      setTerm("");
      router.refresh();
    });
  }

  function propose() {
    setError(null);
    setProposeNote(null);
    if (!proposeText.trim()) {
      setError("Paste at least one submitted search term (one per line).");
      return;
    }
    setProposing(true);
    startTransition(async () => {
      const res = await proposeNegatives(tenantId, campaignId, proposeText);
      setProposing(false);
      if (!res.ok || !res.result) {
        setError(res.error ?? "Couldn't classify these terms.");
        return;
      }
      setProposeText("");
      setProposeNote(
        `Proposed ${res.result.proposed} of ${res.result.submitted} submitted terms as negatives` +
          `${res.result.draftedVia === "fallback" ? " (fallback — the AI gateway didn't answer)" : ""}.`,
      );
      router.refresh();
    });
  }

  function setStatus(negativeId: string, status: "proposed" | "approved" | "dismissed") {
    setError(null);
    setPendingId(negativeId);
    startTransition(async () => {
      const res = await updateNegativeStatus(tenantId, campaignId, negativeId, status);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't update this negative.");
        return;
      }
      router.refresh();
    });
  }

  function remove(negativeId: string) {
    setError(null);
    setPendingId(negativeId);
    startTransition(async () => {
      const res = await deleteNegative(tenantId, campaignId, negativeId);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't delete this negative.");
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
      {negatives.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No negative keywords proposed yet for this campaign.
        </p>
      ) : (
        <HairlineTable
          columns={[{ label: "Term" }, { label: "Match type" }, { label: "Source" }, { label: "Status" }, { label: "" }]}
          rows={negatives.map((n) => [
            n.term,
            n.matchType,
            n.source === "ai" ? "AI proposed" : "Manual",
            <StatusBadge key="s" label={n.status} />,
            canManage ? (
              <div key="actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {n.status !== "approved" && (
                  <Button variant="ghost" size="sm" disabled={pendingId === n.id} onClick={() => setStatus(n.id, "approved")}>Approve</Button>
                )}
                {n.status !== "dismissed" && (
                  <Button variant="ghost" size="sm" disabled={pendingId === n.id} onClick={() => setStatus(n.id, "dismissed")}>Dismiss</Button>
                )}
                <Button variant="ghost" size="sm" disabled={pendingId === n.id} onClick={() => remove(n.id)}>Delete</Button>
              </div>
            ) : (
              <span key="actions" style={{ opacity: 0.5 }}>—</span>
            ),
          ])}
          tcols="1.4fr .8fr .9fr .8fr 1.8fr"
        />
      )}

      {canManage && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: negatives.length > 0 ? "0.5px solid var(--erp-hairline)" : undefined, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
              Add a negative term manually
              <input
                value={term} onChange={(e) => setTerm(e.target.value)} disabled={pending}
                placeholder="free trial"
                style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
              />
            </label>
            <Button variant="solid" size="sm" onClick={create} disabled={pending}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </div>
          <div>
            <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
              Classify submitted search terms with AI (one per line — this does not read any live
              search-term data, paste terms from a search-term report)
              <textarea
                value={proposeText} onChange={(e) => setProposeText(e.target.value)} disabled={pending}
                rows={4}
                style={{ display: "block", marginTop: 6, width: 340, font: "400 13px var(--font-body)", padding: "5px 8px" }}
              />
            </label>
            <div style={{ marginTop: 8 }}>
              <Button variant="ghost" size="sm" disabled={proposing} onClick={propose}>
                {proposing ? "Classifying…" : "Propose negatives"}
              </Button>
            </div>
            {proposeNote && (
              <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", marginTop: 6 }}>{proposeNote}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
