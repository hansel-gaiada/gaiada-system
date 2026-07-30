"use client";
// SM-47 — the inline "+ new campaign" affordance on the Planner tab, for a manually-authored
// campaign shell (no keyword-cluster plan behind it yet — ad groups can be added one at a time from
// the campaign detail page). Kept deliberately tiny, same rationale as NewKeywordSetForm.tsx.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { createCampaign } from "@/lib/searchMarketingActions";

const PLATFORMS = ["google_ads", "microsoft_ads"] as const;

export function NewCampaignForm({
  tenantId, engagementId, deptId,
}: {
  tenantId: string;
  engagementId: string;
  deptId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("google_ads");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Name the campaign first.");
      return;
    }
    startTransition(async () => {
      const res = await createCampaign(tenantId, engagementId, { name: name.trim(), platform });
      if (!res.ok || !res.id) {
        setError(res.error ?? "Couldn't create the campaign.");
        return;
      }
      setName("");
      router.push(`/departments/${deptId}/planner/${res.id}`);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        New campaign name (manual, no plan)
        <input
          value={name} onChange={(e) => setName(e.target.value)} disabled={pending}
          placeholder="Brand terms"
          style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Platform
        <select
          value={platform} disabled={pending}
          onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
          style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>{p === "google_ads" ? "Google Ads" : "Microsoft Ads"}</option>
          ))}
        </select>
      </label>
      <Button variant="solid" size="sm" onClick={submit} disabled={pending}>
        {pending ? "Creating…" : "Create campaign"}
      </Button>
      {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, #B5622F)" }}>{error}</span>}
    </div>
  );
}
