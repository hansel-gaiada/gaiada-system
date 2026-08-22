// SMM-22 — renders `GET engagements/:id/usage` (`lib/social.ts#getEngagementUsage`). A pure,
// static server component — nothing here mutates, mirroring `AnalyticsPanel.tsx`'s own header note
// on why no `globalThis`-store trap applies.
//
// ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────────────────────────
// A tenant cap that has not been CONFIGURED (`capUsd: null`) is a DIFFERENT fact from a tenant cap
// that has been spent to zero remaining headroom — collapsing the two would make an operator who
// never set a tenant-wide cap believe one exists and is nearly exhausted. This file renders the
// unset case as its own honest sentence, never as a 0%-remaining bar.
import type { UsageSnapshot, UsageTier } from "@/lib/socialShared";

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function TierMeter({
  label, tier, warnRatio, note,
}: { label: string; tier: UsageTier; warnRatio: number; note?: string }) {
  if (tier.capUsd === null) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ font: "700 12px var(--font-body)", color: "var(--text-primary)", marginBottom: 4 }}>{label}</div>
        <div style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          No {label.toLowerCase()} cap configured — this tier is not enforced. Month-to-date spend
          here is {fmtUsd(tier.mtdUsd)}, tracked but not capped.
        </div>
      </div>
    );
  }

  const ratio = tier.capUsd > 0 ? tier.mtdUsd / tier.capUsd : 1;
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const nearOrOver = ratio >= warnRatio;
  const barColor = ratio >= 1
    ? "var(--status-critical-fg, #b3261e)"
    : nearOrOver
      ? "var(--status-caution-fg, #9a6700)"
      : "var(--status-positive-fg, #1a7f37)";

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ font: "700 12px var(--font-body)", color: "var(--text-primary)" }}>{label}</span>
        <span style={{ font: "400 12px var(--font-body)", color: nearOrOver ? barColor : "var(--erp-ink-60)" }}>
          {fmtUsd(tier.mtdUsd)} / {fmtUsd(tier.capUsd)} this month
        </span>
      </div>
      <div
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
        aria-label={`${label} metered spend`}
        style={{ height: 8, borderRadius: 4, background: "var(--tint-hover)", overflow: "hidden" }}
      >
        <div style={{ height: "100%", width: `${pct}%`, background: barColor, transition: "width 200ms ease" }} />
      </div>
      {note && <div style={{ font: "400 11px var(--font-body)", color: "var(--erp-ink-50)", marginTop: 3 }}>{note}</div>}
      {ratio >= 1 && (
        <div style={{ font: "600 11px var(--font-body)", color: barColor, marginTop: 3 }}>
          This tier is exhausted — a metered publish will refuse budget_exceeded until next month
          or until the cap is raised.
        </div>
      )}
    </div>
  );
}

export function UsagePanel({ usage }: { usage: UsageSnapshot }) {
  const nothingSpentAnywhere = usage.engagement.mtdUsd === 0 && usage.tenant.mtdUsd === 0 && usage.global.mtdUsd === 0;
  return (
    <div>
      <p style={{ margin: "0 0 14px", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
        X per-post fees against the D-9 stop-loss chain — engagement, then tenant, then the
        platform-wide cap. A metered publish refuses the FIRST tier that would be exceeded, and this
        panel reads the SAME month-to-date sums the gate itself evaluates.
      </p>
      {nothingSpentAnywhere && (
        <p style={{ margin: "0 0 14px", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
          No metered spend has posted anywhere yet this month — this is the genuine steady state
          while X ships disabled at the deployment level.
        </p>
      )}
      <TierMeter
        label="This engagement" tier={usage.engagement} warnRatio={usage.warnRatio}
        note="Set per engagement (Scope panel) — company_admin and up can raise it."
      />
      <TierMeter
        label="This tenant" tier={usage.tenant} warnRatio={usage.warnRatio}
        note="Shared across every engagement for this company."
      />
      <TierMeter
        label="Platform-wide" tier={usage.global} warnRatio={usage.warnRatio}
        note="Shared across every tenant on this deployment."
      />
    </div>
  );
}
