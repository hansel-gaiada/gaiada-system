import type { FeedRun, FeedSource } from "@/lib/network";
import { describeFeed, isFeedStale } from "@/lib/network";

/**
 * Says out loud where the numbers on this page came from.
 *
 * This is the direct countermeasure to the IT module's own history: 8 invented devices at a site
 * that does not exist shipped into the live tenant, rendered identically to real ones, and were
 * read as a topology bug for months. A fixture that cannot be told apart from a feed is worse than
 * an empty page, because an empty page is at least honest.
 */
export function ProvenanceBanner({ source }: { source: FeedSource }) {
  if (source === "live") return null;
  return (
    <div className="nw-banner nw-banner--fixture" role="note">
      <span className="nw-banner__label">Demo data</span>
      <span className="nw-banner__text">
        Nothing on this page is measured. The site collector that would supply it is not built, so
        these figures are illustrative fixtures shipped with the UI. Do not act on them.
      </span>
    </div>
  );
}

/**
 * Feed freshness. Renders unconditionally when there is a feed to describe, because a dead
 * collector and a quiet network otherwise look the same, and an operator reads silence as
 * "all clear".
 */
export function FeedBanner({ run, label = "Traffic feed" }: { run: FeedRun | null; label?: string }) {
  const stale = isFeedStale(run);
  return (
    <div className={`nw-banner ${stale ? "nw-banner--stale" : "nw-banner--ok"}`} role="note">
      <span className="nw-banner__label">{label}</span>
      <span className="nw-banner__text">Last collected {describeFeed(run)}</span>
      {run?.error && <span className="nw-banner__text" style={{ color: "var(--status-critical-fg)" }}>{run.error}</span>}
      {stale && !run?.error && (
        <strong className="nw-banner__text" style={{ color: "var(--status-critical-fg)", fontWeight: 700 }}>
          Feed is stale — the collector may be down. Everything below may be out of date.
        </strong>
      )}
    </div>
  );
}

/** A plain statement that a capability is designed but not built, and what it will do. Preferred
 *  over a disabled button: a greyed control invites the reader to hunt for the permission that
 *  would enable it, when the truth is there is no endpoint behind it at all. */
export function NotBuiltNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nw-note">
      <strong>{title}</strong>
      <div style={{ marginTop: 6 }}>{children}</div>
    </div>
  );
}
