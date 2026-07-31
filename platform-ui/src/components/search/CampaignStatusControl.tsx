"use client";
// SM-47 — the campaign detail header's status control. Only the two ERP-side draft states
// (`CAMPAIGN_STATUSES_WRITABLE`) are offered — 'live'/'paused'/'ended' need a live-ads sync
// (SM-20/25/26) and the backend refuses them (400) from this route regardless.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { updateCampaign } from "@/lib/searchMarketingActions";

export function CampaignStatusControl({
  tenantId, campaignId, status,
}: {
  tenantId: string;
  campaignId: string;
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function setStatus(next: "draft" | "proposed") {
    setError(null);
    startTransition(async () => {
      const res = await updateCampaign(tenantId, campaignId, { status: next });
      if (!res.ok) {
        setError(res.error ?? "Couldn't update this campaign's status.");
        return;
      }
      router.refresh();
    });
  }

  // Anything outside the two draft states this route may set (e.g. a 'live' campaign a future
  // live-ads sync produced) gets no control at all — never an option that would 400.
  if (status !== "draft" && status !== "proposed") return null;

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {status !== "proposed" && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setStatus("proposed")}>Mark proposed</Button>
      )}
      {status !== "draft" && (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setStatus("draft")}>Back to draft</Button>
      )}
      {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, var(--status-critical-fg))" }}>{error}</span>}
    </div>
  );
}
