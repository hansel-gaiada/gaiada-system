// SMM-21 — renders `GET metrics/daily` / `GET metrics/posts` (`lib/social.ts`). A pure, static
// server component: nothing here mutates, so there is no `globalThis`-store trap to guard against
// (that lesson applies to WRITE paths — `demoSocial.ts`'s own header names it).
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────────────────────────
// A counter the engine never reported is `null` on the wire (`DailyMetricRow`/`PostMetricRow`, both
// fully optional per field — `socialShared.ts`'s own header). It renders here as an EM DASH,
// **never** as `0` — a real `0` (the engine reported zero impressions) and an absent field (the
// engine reported nothing, or was never asked) are different facts, and collapsing them would be
// the exact "quota_unknown read as zero used" mistake this module's quota strip already refuses to
// make (`describeQuota`/`QUOTA_UNKNOWN_RULE`). `fmtMetric` below is the ONE place a number becomes
// text in this component — every cell goes through it, so there is exactly one place to audit.
import type { CSSProperties } from "react";
import type { DailyMetricRow, PostMetricRow } from "@/lib/socialShared";
import { EmptyNote } from "@/components/systems/EmptyNote";

function fmtMetric(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : v.toLocaleString();
}

function fmtDate(d: string): string {
  // `d` is already plain `YYYY-MM-DD` text (the controller casts the SQL date column to text
  // specifically so this component never has to reason about a client-side timezone shift).
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// `.lux-table__head`/`.lux-table__row` are the ACTUAL CSS grid containers (`ui.css`); `.lux-table`
// itself is only a flex column wrapper around them, so a gap belongs on the grid elements, not on
// their parent — applied inline here rather than editing the shared `ui.css` rule (which every
// other `.lux-table` consumer in the codebase also uses, several with tighter columns that were
// clearly tuned to the no-gap default).
const GRID_GAP: CSSProperties = { columnGap: 12 };

function AccountDailyTable({ network, handle, displayName, rows }: {
  network: string; handle: string; displayName: string | null; rows: DailyMetricRow[];
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ font: "700 12px var(--font-body)", color: "var(--text-primary)", marginBottom: 6 }}>
        {displayName ?? handle} <span style={{ opacity: 0.55, fontWeight: 400 }}>· {network} · @{handle}</span>
      </div>
      <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "620px" }}>
        <div className="lux-table" style={{ ["--lux-tcols" as string]: "1fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr 0.9fr" }}>
          <div className="lux-table__head" style={GRID_GAP}>
            <span>Date</span><span>Followers</span><span>Impressions</span><span>Reach</span>
            <span>Engagements</span><span>Link clicks</span><span>Video views</span>
          </div>
          {rows.map((r) => (
            <div className="lux-table__row" style={GRID_GAP} key={`${r.accountId}-${r.date}`}>
              <span>{fmtDate(r.date)}</span>
              <span>{fmtMetric(r.followers)}</span>
              <span>{fmtMetric(r.impressions)}</span>
              <span>{fmtMetric(r.reach)}</span>
              <span>{fmtMetric(r.engagements)}</span>
              <span>{fmtMetric(r.linkClicks)}</span>
              <span>{fmtMetric(r.videoViews)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPanel({ dailySeries, postMetrics }: {
  dailySeries: DailyMetricRow[]; postMetrics: PostMetricRow[];
}) {
  if (dailySeries.length === 0 && postMetrics.length === 0) {
    return (
      <EmptyNote>
        No metrics have been pulled yet for this engagement. The nightly `pullMetrics` sweep
        (platform-nest's <code>metrics-job.ts</code>) writes here once it runs against at least one
        connected, published account — this is a genuine "not yet fetched" state, not a zero.
      </EmptyNote>
    );
  }

  const byAccount = new Map<string, DailyMetricRow[]>();
  for (const r of dailySeries) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r);
    byAccount.set(r.accountId, list);
  }

  return (
    <div>
      {byAccount.size > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ font: "700 13px var(--font-body)", color: "var(--text-primary)", margin: "0 0 10px" }}>
            Per-account daily metrics
          </h3>
          {[...byAccount.values()].map((rows) => {
            const first = rows[0];
            return (
              <AccountDailyTable
                key={first.accountId} network={first.network} handle={first.handle}
                displayName={first.displayName} rows={rows}
              />
            );
          })}
        </section>
      )}

      {postMetrics.length > 0 && (
        <section>
          <h3 style={{ font: "700 13px var(--font-body)", color: "var(--text-primary)", margin: "0 0 10px" }}>
            Published posts — latest known metrics
          </h3>
          <p style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", margin: "0 0 8px" }}>
            One row per post, showing the most recent pull. A published post that never appears here
            has simply never been pulled — never a fabricated zero-engagement row.
          </p>
          <div className="lux-table-scroll erp-scroll" style={{ ["--lux-table-min" as string]: "600px" }}>
            <div className="lux-table" style={{ ["--lux-tcols" as string]: "0.9fr 0.9fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr 0.9fr" }}>
              <div className="lux-table__head" style={GRID_GAP}>
                <span>Network</span><span>Published</span><span>Impr.</span><span>Likes</span>
                <span>Comments</span><span>Shares</span><span>Saves</span><span>Last pulled</span>
              </div>
              {postMetrics.map((p) => (
                <div className="lux-table__row" style={GRID_GAP} key={p.variantId}>
                  <span>
                    {p.publishedUrl
                      ? <a href={p.publishedUrl} target="_blank" rel="noreferrer">{p.network}</a>
                      : p.network}
                  </span>
                  <span>{p.publishedAt ? fmtDate(p.publishedAt.slice(0, 10)) : "—"}</span>
                  <span>{fmtMetric(p.impressions)}</span>
                  <span>{fmtMetric(p.likes)}</span>
                  <span>{fmtMetric(p.comments)}</span>
                  <span>{fmtMetric(p.shares)}</span>
                  <span>{fmtMetric(p.saves)}</span>
                  <span>{new Date(p.fetchedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
