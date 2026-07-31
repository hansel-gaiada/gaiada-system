"use client";
// SM-25b's UI half — the Search Console & GA4 tab (§6ay: "the department can finally read its own
// data", but "declined to attempt any UI verification" — this discharges that gap). $0 to the shared
// vendor deposit (§A12.1: a THIRD egress class, client-private OAuth) — CostTierBadge on the page
// renders "free" for that reason, even though the numbers are real client data, not our own crawl.
//
// The freshness/sampling fields exist because GSC lags 2-3 days and GA4 samples — §6ay's own words:
// "a chart that silently plots a clamped range as if it were today would reintroduce exactly the lie
// the backend went to trouble to prevent." So this panel states the clamp/truncation/sampling facts
// NEXT TO the numbers they describe, never only in a caption below the table.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, Button } from "@/components/ui";
import { SimulatedBadge } from "@/components/search/SimulatedBadge";
import {
  formatCtr, formatPosition, formatGoogleMetric, freshnessDisclosure,
  type GscPerformanceRow, type GscTopQueryRow, type Ga4MetricsRow, type GscPullOutcome, type Ga4PullOutcome,
} from "@/lib/searchMarketingShared";
import { pullGscPerformance, pullGa4Metrics } from "@/lib/searchMarketingActions";

function GscPullOutcomeBanner({ outcome }: { outcome: GscPullOutcome }) {
  return (
    <div style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-70)", border: "0.5px solid var(--erp-hairline)", borderRadius: 2, padding: "8px 10px", marginTop: 8 }}>
      <strong>{outcome.rowsUpserted} row(s) upserted.</strong> {freshnessDisclosure(outcome)}
      {outcome.truncated && (
        <>
          {" "}
          <span style={{ color: "var(--erp-warn, #9c6f1f)" }}>▲ Truncated — the page-count safety cap was hit while still full; more data may exist. Re-run with a narrower date range to see the rest.</span>
        </>
      )}
      {outcome.simulated && <SimulatedBadge />}
    </div>
  );
}

function Ga4PullOutcomeBanner({ outcome }: { outcome: Ga4PullOutcome }) {
  return (
    <div style={{ font: "400 12px/1.6 var(--font-body)", color: "var(--erp-ink-70)", border: "0.5px solid var(--erp-hairline)", borderRadius: 2, padding: "8px 10px", marginTop: 8 }}>
      <strong>{outcome.rowsUpserted} row(s) upserted.</strong> {freshnessDisclosure(outcome)}
      {outcome.sampled && (
        <>
          {" "}
          <span style={{ color: "var(--erp-warn, #9c6f1f)" }}>▲ Sampled — GA4 answered this report from a sample, not a full count. Sessions/conversions are an estimate.</span>
        </>
      )}
      {outcome.simulated && <SimulatedBadge />}
    </div>
  );
}

function GscControls({ tenantId, engagementId, canManage, onDone }: { tenantId: string; engagementId: string; canManage: boolean; onDone: (o: GscPullOutcome) => void }) {
  const [pending, startPull] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!canManage) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Button
        variant="solid" size="sm" disabled={pending}
        onClick={() => {
          setError(null);
          startPull(async () => {
            const res = await pullGscPerformance(tenantId, engagementId);
            if (!res.ok) { setError(res.error ?? "GSC pull failed."); return; }
            onDone(res.result!);
          });
        }}
      >
        {pending ? "Pulling…" : "Pull Search Console data"}
      </Button>
      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
        Needs a Search Console connection on this property (Connections tab). $0 to the shared deposit — client-private OAuth.
      </span>
      {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", margin: 0, width: "100%" }}>{error}</p>}
    </div>
  );
}

function Ga4Controls({ tenantId, engagementId, canManage, onDone }: { tenantId: string; engagementId: string; canManage: boolean; onDone: (o: Ga4PullOutcome) => void }) {
  const [ga4PropertyId, setGa4PropertyId] = useState("");
  const [pending, startPull] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!canManage) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        GA4 property id
        <input
          value={ga4PropertyId} onChange={(e) => setGa4PropertyId(e.target.value)}
          placeholder="e.g. 123456789" style={{ marginLeft: 8, width: 140, font: "400 13px var(--font-body)", padding: "4px 8px" }}
        />
      </label>
      <Button
        variant="solid" size="sm" disabled={pending}
        onClick={() => {
          setError(null);
          if (!ga4PropertyId.trim()) { setError("GA4 property id required."); return; }
          startPull(async () => {
            const res = await pullGa4Metrics(tenantId, engagementId, { ga4PropertyId: ga4PropertyId.trim() });
            if (!res.ok) { setError(res.error ?? "GA4 pull failed."); return; }
            onDone(res.result!);
          });
        }}
      >
        {pending ? "Pulling…" : "Pull GA4 data"}
      </Button>
      <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
        Needs a GA4 connection on this property (Connections tab).
      </span>
      {error && <p role="alert" style={{ font: "400 13px var(--font-body)", color: "var(--erp-danger, #B5622F)", margin: 0, width: "100%" }}>{error}</p>}
    </div>
  );
}

export function GscGa4Panel({
  tenantId, engagementId, gscRows, topQueries, ga4Rows, canManage,
}: {
  tenantId: string;
  engagementId: string;
  gscRows: GscPerformanceRow[];
  topQueries: GscTopQueryRow[];
  ga4Rows: Ga4MetricsRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [gscOutcome, setGscOutcome] = useState<GscPullOutcome | null>(null);
  const [ga4Outcome, setGa4Outcome] = useState<Ga4PullOutcome | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h4 style={{ font: "700 12px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 8 }}>
          Search Console
        </h4>
        <GscControls
          tenantId={tenantId} engagementId={engagementId} canManage={canManage}
          onDone={(o) => { setGscOutcome(o); router.refresh(); }}
        />
        {gscOutcome && <GscPullOutcomeBanner outcome={gscOutcome} />}

        {gscRows.length === 0 ? (
          <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 12 }}>
            No Search Console data pulled yet for this property.
          </p>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <HairlineTable
              tcols="90px 1.3fr 1.3fr 80px 70px 80px 70px 80px"
              columns={[
                { label: "Date" }, { label: "Query" }, { label: "Page" }, { label: "Device" },
                { label: "Clicks", align: "right" }, { label: "Impr.", align: "right" },
                { label: "CTR", align: "right" }, { label: "Position", align: "right" },
              ]}
              rows={gscRows.map((r) => [
                r.date, r.query,
                <span key="page" style={{ font: "400 12px var(--font-body)" }}>{r.page.replace(/^https?:\/\/[^/]+/, "")}</span>,
                r.device,
                String(r.clicks), String(r.impressions), formatCtr(r.ctr),
                <span key="pos" style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", width: "100%" }}>
                  {formatPosition(r.position)}{r.simulated && <SimulatedBadge />}
                </span>,
              ])}
            />
          </div>
        )}

        {topQueries.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h5 style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)", marginBottom: 6 }}>
              Top queries (last 28 days, real data only)
            </h5>
            <HairlineTable
              tcols="1.6fr 90px 90px 90px 90px"
              columns={[{ label: "Query" }, { label: "Clicks", align: "right" }, { label: "Impr.", align: "right" }, { label: "CTR", align: "right" }, { label: "Position", align: "right" }]}
              rows={topQueries.map((q) => [q.query, String(q.clicks), String(q.impressions), formatCtr(q.ctr), formatPosition(q.position)])}
            />
          </div>
        )}
      </div>

      <div>
        <h4 style={{ font: "700 12px var(--font-body)", letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--erp-ink-60)", marginBottom: 8 }}>
          Analytics (GA4)
        </h4>
        <Ga4Controls
          tenantId={tenantId} engagementId={engagementId} canManage={canManage}
          onDone={(o) => { setGa4Outcome(o); router.refresh(); }}
        />
        {ga4Outcome && <Ga4PullOutcomeBanner outcome={ga4Outcome} />}

        {ga4Rows.length === 0 ? (
          <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)", marginTop: 12 }}>
            No GA4 data pulled yet for this property.
          </p>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <HairlineTable
              tcols="90px 1.2fr 90px 110px 100px 100px"
              columns={[
                { label: "Date" }, { label: "Channel" }, { label: "Sessions", align: "right" },
                { label: "Engaged", align: "right" }, { label: "Conversions", align: "right" }, { label: "Revenue", align: "right" },
              ]}
              rows={ga4Rows.map((r) => [
                r.date, r.channelGroup, String(r.sessions), String(r.engagedSessions),
                <span key="conv" style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", width: "100%" }}>
                  {formatGoogleMetric(r.conversions)}
                  {r.sampled && (
                    <span title="This report was too large to answer from unsampled data — GA4's own sampling flag." style={{ font: "600 10px var(--font-body)", color: "var(--erp-warn, #9c6f1f)", marginLeft: 6 }}>
                      ▲ sampled
                    </span>
                  )}
                  {r.simulated && <SimulatedBadge />}
                </span>,
                formatGoogleMetric(r.totalRevenue),
              ])}
            />
          </div>
        )}
      </div>
    </div>
  );
}
