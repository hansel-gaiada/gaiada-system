import type { CostTier } from "@/lib/searchMarketing";

// The console is explicit about what a capability COSTS, because in this module
// that is the difference between "click freely" and "this bills the shared
// DataForSEO deposit". Design §08 splits every capability into two tiers:
//   FREE     — our own crawlers + AI over our own data; $0 external spend.
//   DATA KEY — a metered provider call, gated on BOTH the deposit and the
//              engagement's own tool-scope toggle, and counted by the stop-loss.
// Rendering this next to an action is a deliberate anti-surprise measure: nobody
// should discover the cost tier from an invoice.
export function CostTierBadge({ tier }: { tier: CostTier }) {
  const free = tier === "free";
  return (
    <span
      title={
        free
          ? "Free — runs on our own crawlers and AI over our own data. No external spend."
          : "Needs the metered data provider. Billed to the shared deposit and counted against the engagement, tenant and platform stop-loss caps."
      }
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        font: "600 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase",
        padding: "2px 7px", borderRadius: 2, whiteSpace: "nowrap",
        border: "0.5px solid var(--erp-hairline)",
        background: free ? "color-mix(in srgb, var(--status-ok) 8%, transparent)" : "color-mix(in srgb, var(--status-info) 8%, transparent)",
        color: free ? "var(--erp-ok, var(--status-ok-fg))" : "var(--erp-info, var(--status-info-fg))",
      }}
    >
      <span aria-hidden="true">{free ? "●" : "◆"}</span>
      {free ? "Free" : "Data key"}
    </span>
  );
}
