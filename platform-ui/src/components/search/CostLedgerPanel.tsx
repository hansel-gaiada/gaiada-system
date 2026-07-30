// SM-17 — the console tab body for the ledger/cost surface (design addendum §A3; tracker §6j). The
// FIRST UI onto the money ledger, so every rendering decision below traces back to a BINDING AC —
// see `lib/searchMarketingShared.ts`'s header note on `EngagementLedger`/`COST_TO_SERVE_LEGEND` for
// the full citation. Presentational only: all arithmetic (the sums, the mode filter, the true-up)
// happens on the backend; this component never re-derives a total from `rows`.
import { HairlineTable, StatusBadge } from "@/components/ui";
import { SimulatedBadge, ProviderLabel } from "@/components/search/SimulatedBadge";
import { formatUsd, COST_TO_SERVE_LEGEND, type EngagementLedger } from "@/lib/searchMarketing";

export function CostLedgerPanel({ ledger }: { ledger: EngagementLedger | null }) {
  // `null` = the endpoint didn't answer (404/403 — module gate, Cerbos denial, or an unknown
  // engagement). This is a DIFFERENT claim from "zero rows recorded" and must not render the same
  // way as the genuine-empty state below (lib/searchMarketing.ts's own note on `getEngagementLedger`).
  if (!ledger) {
    return (
      <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
        Cost ledger unavailable — the module may not be enabled for this engagement, or you may not
        have <code>search:ledger:read</code>.
      </p>
    );
  }

  // The sum is CURRENT-MODE ONLY (AC3) — if the platform is running in simulate mode, every dollar
  // in `costToServeUsd` is by construction synthetic, so the aggregate itself gets the same chip a
  // per-row figure would. Never derived from anything in `rows` here.
  const currentModeSimulated = ledger.providerMode === "simulate";
  const hasCurrentModeRows = ledger.currentModeRowCount > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* The KPI figure. Language is BINDING: "Cost to serve (standard rates)" — never "spend",
          never "cash", never "actual" (see the module header note for why). A zero ROW COUNT reads
          as "no provider calls recorded yet", never as "$0.00 of cost-to-serve" — those are
          different claims, and conflating them is the same class of lie the "— never 0" rule exists
          to prevent, just on the empty-collection axis. */}
      <div>
        <div style={{ font: "600 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginBottom: 4 }}>
          Cost to serve (standard rates) — current period
        </div>
        {hasCurrentModeRows ? (
          <div style={{ font: "600 28px var(--font-body)", color: "var(--text-primary)", display: "flex", alignItems: "center" }}>
            {formatUsd(ledger.costToServeUsd)}
            {currentModeSimulated && <SimulatedBadge />}
          </div>
        ) : (
          <div style={{ font: "400 14px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
            No provider calls recorded yet for the current period.
          </div>
        )}
      </div>

      {/* Simulated history (excluded) — a SEPARATE, explicitly labelled line (AC3). Only rendered
          when the OTHER mode has month-to-date rows; never blended into the figure above. */}
      {ledger.simulatedHistoryExcludedUsd !== null && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 6,
            font: "400 13px var(--font-body)", color: "var(--erp-ink-50)",
            borderLeft: "2px solid var(--erp-hairline)", paddingLeft: 10,
          }}
        >
          <span>
            {currentModeSimulated ? "Live" : "Simulated"} history (excluded): {formatUsd(ledger.simulatedHistoryExcludedUsd)}
          </span>
          {!currentModeSimulated && <SimulatedBadge />}
        </div>
      )}

      {/* Row detail — every row carries its OWN provider + simulated flag (AC1), never inherited
          from the platform's current mode, so a historical row keeps badging its own truth after a
          mode flip. `status` renders VERBATIM via StatusBadge (casing only, never relabelled).
          `rows.length === 0` implies `currentModeRowCount === 0` (rows is a superset across BOTH
          modes), so the KPI section above has ALREADY stated "no provider calls recorded yet" —
          rendering a second, differently-worded empty message here would be redundant, not
          additive, so this section renders nothing rather than repeat itself. */}
      {ledger.rows.length > 0 && (
        <div>
        {/* The rows and the KPI above DELIBERATELY do not reconcile, so the table says so. The KPI
            is month-to-date in the CURRENT mode; this table is the most recent 200 calls across ALL
            periods and BOTH modes. Without this caption an operator adds the visible rows, gets a
            different number from the headline figure, and reasonably concludes the ledger is broken
            — the support ticket writes itself. An unlabelled figure that invites a false
            reconciliation is the same class of problem as an unlabelled simulated one; both state
            something untrue by omission. */}
        <div style={{ font: "600 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginBottom: 4 }}>
          Recent provider calls — latest 200, all periods and both modes
        </div>
        <div style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginBottom: 8 }}>
          This list is not the basis of the figure above: it spans every period and both data modes, so
          its rows are not expected to sum to the current-period total.
        </div>
        {/* 7 columns do not fit this console's narrow content column at native width — scroll the
            TABLE horizontally rather than let its cells wrap/overlap (the page body itself must
            never scroll sideways). */}
        <div style={{ overflowX: "auto" }}>
          <HairlineTable
            tcols="150px 130px 220px 60px 80px 100px 120px"
            columns={[
              { label: "When" }, { label: "Provider" }, { label: "Endpoint" },
              { label: "Items", align: "right" }, { label: "Cache hit" }, { label: "Status" },
              { label: "Cost to serve", align: "right" },
            ]}
            rows={ledger.rows.map((r) => [
              new Date(r.createdAt).toLocaleString(),
              <span key="provider" style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
                {r.provider}
                <ProviderLabel provider={r.provider} />
              </span>,
              <span key="endpoint" style={{ whiteSpace: "nowrap" }}>{r.endpoint}</span>,
              String(r.items),
              r.cacheHit ? "Yes" : "No",
              <StatusBadge key="status" label={r.status} />,
              <span key="cost" style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
                {formatUsd(r.costUsd)}
                {r.simulated && <SimulatedBadge />}
              </span>,
            ])}
          />
        </div>
        </div>
      )}

      {/* Standing legend (AC2) — carried VERBATIM from the design addendum. This is the only place
          "actual cash" appears on this surface, and it appears here deliberately: it names the
          real-world two-line cash model (fixed subscriptions + DataForSEO PAYG), which is the
          opposite of overclaiming precision on any single figure above. */}
      <p style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-50)", borderTop: "0.5px solid var(--erp-hairline)", paddingTop: 12, margin: 0 }}>
        {COST_TO_SERVE_LEGEND}
      </p>
    </div>
  );
}
