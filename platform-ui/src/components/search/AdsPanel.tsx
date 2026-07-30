"use client";
// SM-47 — one ad group's ads: manual create, AI RSA draft (design §07/§08: "draft only", never
// auto-published), status transitions (draft/approved/rejected — 'live' is sync-only, SM-20/25/26),
// delete. `aiGenerated` renders as a plain provenance note, not a badge — it is a boolean fact about
// authorship, not a data-simulation claim, so it does not ride SimulatedBadge (that badge is reserved
// for SM-38's provider-sourced-metric contract).
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, StatusBadge, Button } from "@/components/ui";
import { createAd, updateAdStatus, deleteAd, draftAd } from "@/lib/searchMarketingActions";
import type { SearchAd } from "@/lib/searchMarketingShared";

export function AdsPanel({
  tenantId, campaignId, adGroupId, ads, canManage,
}: {
  tenantId: string;
  campaignId: string;
  adGroupId: string;
  ads: SearchAd[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [headlines, setHeadlines] = useState("");
  const [descriptions, setDescriptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    const hs = headlines.split("\n").map((h) => h.trim()).filter(Boolean);
    const ds = descriptions.split("\n").map((d) => d.trim()).filter(Boolean);
    if (hs.length === 0 || ds.length === 0) {
      setError("At least one headline and one description required (one per line).");
      return;
    }
    startTransition(async () => {
      const res = await createAd(tenantId, campaignId, adGroupId, { headlines: hs, descriptions: ds });
      if (!res.ok) {
        setError(res.error ?? "Couldn't create this ad.");
        return;
      }
      setHeadlines("");
      setDescriptions("");
      router.refresh();
    });
  }

  function draft() {
    setError(null);
    setDrafting(true);
    startTransition(async () => {
      const res = await draftAd(tenantId, campaignId, adGroupId);
      setDrafting(false);
      if (!res.ok) {
        setError(res.error ?? "Couldn't draft an ad.");
        return;
      }
      router.refresh();
    });
  }

  function setStatus(adId: string, status: "draft" | "approved" | "rejected") {
    setError(null);
    setPendingId(adId);
    startTransition(async () => {
      const res = await updateAdStatus(tenantId, campaignId, adId, status);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't update this ad.");
        return;
      }
      router.refresh();
    });
  }

  function remove(adId: string) {
    setError(null);
    setPendingId(adId);
    startTransition(async () => {
      const res = await deleteAd(tenantId, campaignId, adId);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't delete this ad.");
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
      {ads.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No ads drafted yet for this ad group.
        </p>
      ) : (
        <HairlineTable
          columns={[{ label: "Headlines" }, { label: "Descriptions" }, { label: "Origin" }, { label: "Status" }, { label: "" }]}
          rows={ads.map((a) => [
            <span key="h" style={{ font: "400 12px/1.5 var(--font-body)" }}>{a.headlines.join(" · ")}</span>,
            <span key="d" style={{ font: "400 12px/1.5 var(--font-body)" }}>{a.descriptions.join(" · ")}</span>,
            a.aiGenerated ? "AI draft" : "Manual",
            <StatusBadge key="s" label={a.status} />,
            canManage ? (
              <div key="actions" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {a.status !== "approved" && (
                  <Button variant="ghost" size="sm" disabled={pendingId === a.id} onClick={() => setStatus(a.id, "approved")}>Approve</Button>
                )}
                {a.status !== "rejected" && (
                  <Button variant="ghost" size="sm" disabled={pendingId === a.id} onClick={() => setStatus(a.id, "rejected")}>Reject</Button>
                )}
                {a.status !== "draft" && (
                  <Button variant="ghost" size="sm" disabled={pendingId === a.id} onClick={() => setStatus(a.id, "draft")}>Back to draft</Button>
                )}
                <Button variant="ghost" size="sm" disabled={pendingId === a.id} onClick={() => remove(a.id)}>Delete</Button>
              </div>
            ) : (
              <span key="actions" style={{ opacity: 0.5 }}>—</span>
            ),
          ])}
          tcols="1.6fr 1.6fr .8fr .8fr 1.8fr"
        />
      )}

      {canManage && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: ads.length > 0 ? "0.5px solid var(--erp-hairline)" : undefined, display: "flex", flexDirection: "column", gap: 10 }}>
          <Button variant="ghost" size="sm" disabled={drafting} onClick={draft}>
            {drafting ? "Drafting…" : "Draft an RSA ad with AI"}
          </Button>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
              Headlines (one per line)
              <textarea
                value={headlines} onChange={(e) => setHeadlines(e.target.value)} disabled={pending}
                rows={3}
                style={{ display: "block", marginTop: 6, width: 260, font: "400 13px var(--font-body)", padding: "5px 8px" }}
              />
            </label>
            <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
              Descriptions (one per line)
              <textarea
                value={descriptions} onChange={(e) => setDescriptions(e.target.value)} disabled={pending}
                rows={3}
                style={{ display: "block", marginTop: 6, width: 260, font: "400 13px var(--font-body)", padding: "5px 8px" }}
              />
            </label>
            <Button variant="solid" size="sm" onClick={create} disabled={pending}>
              {pending ? "Adding…" : "Add ad manually"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
