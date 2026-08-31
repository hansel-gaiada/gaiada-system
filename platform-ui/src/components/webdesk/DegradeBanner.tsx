import { describeDegrade, type DegradeMeta } from "@/lib/webdesk";
import { formatDateTime } from "@/lib/format";

// WSK-24 — the ONE component every WebDesk console read renders through. WSK-23's own finding
// (docs/FRONTEND-BFF-CONTRACT.md §24): three of the four reads this tab consumes are ALWAYS
// `stale:true` — Zone B's control plane has no live read endpoint for site/environment status,
// releases, or submissions. A console that only shows a staleness banner "sometimes" would train
// people to read its ABSENCE as "this is live", which is false for almost everything on this tab.
// So this banner is not an error state bolted on top of the real UI — it IS part of the real UI,
// rendered unconditionally above every list this surface shows, in both the honest-normal case
// (stale:true, source:"facts") and the rare genuinely-live case (stale:false, source:"live").
//
// `role="status"` (not "alert"): a stale-but-known-current-as-of read is the NORMAL state here, not
// an emergency — see root MEMORY.md "role=log is a live region" for why an assertive/alarming
// treatment of a routine state is its own kind of lie.
const SOURCE_LABEL: Record<DegradeMeta["source"], string> = {
  live: "Live",
  cache: "Cached",
  facts: "Zone A facts",
  unavailable: "Unavailable",
};

const SOURCE_TONE: Record<DegradeMeta["source"], string> = {
  live: "var(--status-ok-fg)",
  cache: "var(--status-progress-fg)",
  facts: "var(--status-progress-fg)",
  unavailable: "var(--status-critical-fg)",
};

export function DegradeBanner({ meta, subject }: { meta: DegradeMeta; subject: string }) {
  const tone = SOURCE_TONE[meta.source];
  return (
    <div
      role="status"
      data-testid="degrade-banner"
      data-source={meta.source}
      data-stale={meta.stale ? "true" : "false"}
      style={{
        display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap",
        border: "0.5px solid var(--erp-hairline)", borderLeft: `3px solid ${tone}`,
        background: "var(--tint-hover)", padding: "10px 14px", marginBottom: 16,
      }}
    >
      <span style={{ font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: tone, whiteSpace: "nowrap" }}>
        {SOURCE_LABEL[meta.source]}
      </span>
      <span style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
        {describeDegrade(meta)}{" "}
        {meta.asOf ? (
          <>As of <strong>{formatDateTime(meta.asOf)}</strong> for {subject}.</>
        ) : (
          <>No data on file yet for {subject}.</>
        )}
      </span>
    </div>
  );
}
