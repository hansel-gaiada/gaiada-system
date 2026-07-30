// SM-38 — simulated-data badging. Styled consistently with CostTierBadge.tsx (same chip
// anatomy: glyph + uppercase label, hairline border, tinted background), but its own color so it
// reads as a DISTINCT signal from the free/data-key cost tier next to it.
//
// The rule this exists to enforce (design addendum `seo-sem-design-addendum-providers.md` §A4,
// tracker §6 SM-38): an unlabelled plausible number is the most expensive kind of lie, for the
// same reason the "render '—', never '0'" invariant exists. A simulated figure looks exactly like
// a real one — same shape, same precision — so the badge is the ONLY thing standing between an
// operator and mistaking a synthetic dollar/volume/rank for a real one.
//
// Field names verified against platform-nest `providers/dispatch.ts`'s `ProjectedToolCost`
// (`simulated: boolean`, `provider: string | null`) and `projectMonthlyCost`'s returned
// `providerMode: ProviderMode` — the ONLY provenance-carrying fields the console can actually
// read today (`GET engagements/:id/cost-projection`). `search_keywords` has no equivalent
// (`metrics_provider`/`metrics_simulated` need migration 0048 / SM-36, not landed) — see
// KeywordWorkbench.tsx's header note for why no chip renders there yet.
import type { ProviderMode } from "@/lib/searchMarketingShared";

const VENDOR_LABEL: Record<string, string> = {
  dataforseo: "DataForSEO",
  semrush: "Semrush",
  ahrefs: "Ahrefs",
};

/** The vendor name a provider-sourced number came from (design addendum §A2 clause 2: "every
 *  provider-sourced metric renders with its provenance... never blended, never unlabelled" — this
 *  is what makes a Semrush KD and an Ahrefs KD, which are different formulas on different scales,
 *  impossible to mistake for each other downstream). Renders nothing for a null/unknown provider —
 *  absence must never read as a claim about which vendor served the number. */
export function ProviderLabel({ provider }: { provider: string | null | undefined }) {
  if (!provider) return null;
  const label = VENDOR_LABEL[provider] ?? provider;
  return (
    <span
      style={{
        font: "600 10px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)",
        marginLeft: 6, whiteSpace: "nowrap",
      }}
    >
      · {label}
    </span>
  );
}

/** The chip itself. Renders next to ONE number, not once per page/section — SM-38's AC is
 *  per-provenance-carrying-value, because an aggregate built from a mix of live and simulated rows
 *  would otherwise hide which half is fake (today, pre-SM-36, one platform mode covers every op
 *  kind in a single response, but the shape is per-row on purpose for when SM-36's per-capability
 *  cascade can put a live driver next to a simulated one in the same grid). */
export function SimulatedBadge() {
  return (
    <span
      title="Simulated — a synthetic figure from the platform's deterministic simulator (design addendum §A4), not a live vendor pull. Same rate tables as the real driver, but the number itself is not real."
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        font: "600 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase",
        padding: "2px 7px", borderRadius: 2, whiteSpace: "nowrap", marginLeft: 6,
        border: "0.5px solid var(--erp-hairline)",
        background: "rgba(156,111,31,.1)",
        color: "var(--erp-warn, #9c6f1f)",
      }}
    >
      <span aria-hidden="true">▲</span>
      Simulated
    </span>
  );
}

/** The engagement-header mode statement (SM-38 deliverable #2): states the platform's data mode
 *  ONCE, so an operator can tell at a glance without inferring it from chips scattered across the
 *  page. `null` means the cost-projection endpoint didn't answer — the mode is genuinely UNKNOWN,
 *  and must render as "—", never default to "Live" (that would be a false claim of realness, the
 *  same class of lie as rendering an absent value as 0). */
export function ProviderModeStatement({ mode }: { mode: ProviderMode | null }) {
  if (mode === null) {
    return (
      <span style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Data mode: <strong>— (unknown — cost-projection didn&apos;t answer)</strong>
      </span>
    );
  }
  const simulated = mode === "simulate";
  return (
    <span
      title={
        simulated
          ? "This platform is running in SIMULATE mode: every provider pull returns deterministic synthetic data, never a real vendor call."
          : "This platform is running in LIVE mode: provider pulls reach real vendor APIs and bill real (or amortized-subscription) dollars."
      }
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        font: "600 11px var(--font-body)", letterSpacing: "0.04em",
        color: simulated ? "var(--erp-warn, #9c6f1f)" : "var(--erp-ok, #3a7a54)",
      }}
    >
      <span aria-hidden="true">{simulated ? "▲" : "●"}</span>
      Data mode: {simulated ? "SIMULATED" : "Live"}
    </span>
  );
}
