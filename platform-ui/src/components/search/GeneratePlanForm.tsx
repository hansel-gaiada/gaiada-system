"use client";
// SM-47 — the plan generator's inline form + result. `POST engagements/:id/campaigns/generate-plan`
// (SM-18's `sem-plan.ts` `buildCampaignPlan`) turns an already-clustered keyword set into one
// campaign + one ad group per cluster, and — the reason this component exists — the response is the
// ONLY place this console can read the per-ad-group provenance breakdown (see
// `CampaignPlanResult`'s header note in searchMarketingShared.ts: the persisted ad-groups read has
// none of this). So the result is rendered HERE, immediately, from the real response envelope,
// rather than re-derived later from a read that cannot carry it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, HairlineTable } from "@/components/ui";
import { ProvenanceBreakdown } from "./CampaignProvenance";
import { generateCampaignPlan } from "@/lib/searchMarketingActions";
import type { SearchKeywordSet, CampaignPlanResult } from "@/lib/searchMarketingShared";

const PLATFORMS = ["google_ads", "microsoft_ads"] as const;

export function GeneratePlanForm({
  tenantId, engagementId, deptId, keywordSets,
}: {
  tenantId: string;
  engagementId: string;
  deptId: string;
  keywordSets: SearchKeywordSet[];
}) {
  const router = useRouter();
  const [keywordSetId, setKeywordSetId] = useState(keywordSets[0]?.id ?? "");
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("google_ads");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CampaignPlanResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (keywordSets.length === 0) {
    return (
      <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        Generating a plan needs an already-clustered keyword set — import and cluster one from the
        Keywords tab first.
      </p>
    );
  }

  function submit() {
    setError(null);
    setResult(null);
    if (!name.trim()) {
      setError("Name the campaign first (e.g. \"Q3 core services\").");
      return;
    }
    if (!keywordSetId) {
      setError("Pick a keyword set to plan from.");
      return;
    }
    startTransition(async () => {
      const res = await generateCampaignPlan(tenantId, engagementId, { keywordSetId, name: name.trim(), platform });
      if (!res.ok || !res.plan) {
        setError(res.error ?? "Couldn't generate a plan.");
        return;
      }
      setResult(res.plan);
      router.refresh();
    });
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Keyword set
          <select
            value={keywordSetId} disabled={pending}
            onChange={(e) => setKeywordSetId(e.target.value)}
            style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
          >
            {keywordSets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
          Campaign name
          <input
            value={name} onChange={(e) => setName(e.target.value)} disabled={pending}
            placeholder="Q3 core services"
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
          {pending ? "Generating…" : "Generate plan"}
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, var(--status-critical-fg))", marginTop: 8 }}>
          {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: "0.5px solid var(--erp-hairline)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <h4 style={{ font: "700 13px var(--font-body)", color: "var(--text-primary)", margin: 0 }}>
              Plan generated — {result.adGroups.length} ad group{result.adGroups.length === 1 ? "" : "s"}
            </h4>
            <a
              href={`/departments/${deptId}/planner/${result.id}`}
              style={{ font: "600 12px var(--font-body)", color: "var(--erp-accent)" }}
            >
              Open campaign →
            </a>
          </div>
          <p style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)", marginTop: 0, marginBottom: 12 }}>
            {result.totalClusteredKeywords} keywords clustered into ad groups
            {result.unclusteredSkipped > 0 ? `; ${result.unclusteredSkipped} unclustered keywords skipped` : ""}.
          </p>
          <HairlineTable
            columns={[
              { label: "Ad group" }, { label: "Intent" }, { label: "Keywords", align: "right" }, { label: "Provenance" },
            ]}
            rows={result.adGroups.map((g) => [
              g.name,
              g.intent ?? "—",
              String(g.keywordCount),
              <ProvenanceBreakdown key="prov" provenance={g.provenance} />,
            ])}
            tcols="1.2fr .8fr .6fr 2.2fr"
          />
        </div>
      )}
    </div>
  );
}
