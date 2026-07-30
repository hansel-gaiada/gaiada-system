// SM-47 — the SEM plan generator's provenance surface. `generateCampaignPlan` (sem-plan.ts's
// `buildCampaignPlan`) returns a per-ad-group `{providers, simulatedCount, realCount,
// unpulledCount}` block (design addendum §A2/§A4.7) — a plan built partly from SIMULATED keyword
// volumes must never present as though it reflects real market data. This component is the ONE
// place that block is ever rendered, so every rule below is binding, not stylistic:
//
//   1. THREE distinct states, never collapsed to two: real / simulated / unpulled. Folding
//      "unpulled" into either "real" or "simulated" is the exact ambiguity SM-12 already avoided
//      for per-keyword volume (`VolumeState` in searchMarketingShared.ts) — this must not
//      reintroduce it one level up, at the ad-group/plan level.
//   2. Providers are listed DISTINCTLY, never blended/averaged — a Semrush KD and an Ahrefs KD are
//      different formulas on different scales (§A2 clause 2). `ProviderLabel` (SM-38, reused here
//      rather than a second badge component per this ticket's own instruction) renders each one.
//   3. Reuses `SimulatedBadge` (SM-38) on the simulated count specifically — no new badge component.
//
// A count of 0 in one of the three buckets is an honest, computed answer ("no real-provider
// keywords in this group") — NOT the "— never 0" hazard, which is about an UNKNOWN value rendering
// as a plausible zero. Here every bucket is always known (the plan generator counted every keyword),
// so 0 is rendered as 0, same as any other member of the three-way partition.
import type { CSSProperties } from "react";
import { ProviderLabel, SimulatedBadge } from "./SimulatedBadge";
import type { KeywordProvenanceSummary } from "@/lib/searchMarketingShared";

const LABEL_STYLE: CSSProperties = {
  font: "600 10px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--erp-ink-50)",
};

export function ProvenanceBreakdown({ provenance }: { provenance: KeywordProvenanceSummary }) {
  const { providers, simulatedCount, realCount, unpulledCount } = provenance;
  const total = simulatedCount + realCount + unpulledCount;

  if (total === 0) {
    return (
      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
        No keywords in this ad group
      </span>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--text-primary)" }}>
          <strong>{realCount}</strong> real
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", font: "400 12px var(--font-body)", color: "var(--text-primary)" }}>
          <strong>{simulatedCount}</strong>&nbsp;simulated
          {simulatedCount > 0 && <SimulatedBadge />}
        </span>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
          <strong>{unpulledCount}</strong> not yet pulled
        </span>
      </div>
      {providers.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
          <span style={LABEL_STYLE}>Providers</span>
          {providers.map((p) => (
            <ProviderLabel key={p} provider={p} />
          ))}
        </div>
      )}
    </div>
  );
}
