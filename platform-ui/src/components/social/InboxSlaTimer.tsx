"use client";
// SMM-18 — the SLA countdown/overdue chip, driven by `sla_due_at`. Ticks every 60s on the client
// (a countdown that only ever updated on page reload would be misleading the moment a breach
// happens between loads) but deliberately carries NO `aria-live` — smm-tracker.md's own recurring
// hazard note ("role=log is a live region — aria-live spam, no assertive") applies just as much to
// a plain per-minute countdown: announcing every tick would spam a screen reader for no benefit.
// The exact due timestamp is always available via the native `<time title>` tooltip instead.
//
// `null` (no SLA target at all) is a real, distinct, legitimate state per `inbox-triage-job.ts`'s
// own "never invent a fallback duration" rule — rendered plainly, never as an error or a 0-based
// countdown.
import { useEffect, useState } from "react";
import { describeSla, type SlaState } from "@/lib/socialShared";

const STATE_COLOR: Record<SlaState, string> = {
  on_track: "var(--erp-ink-60)",
  due_soon: "var(--status-caution-fg, #9a6700)",
  overdue: "var(--status-critical-fg, #b3261e)",
  none: "var(--erp-ink-50)",
};

export function InboxSlaTimer({ slaDueAt }: { slaDueAt: string | null }) {
  const [nowIso, setNowIso] = useState<string>(() => new Date().toISOString());
  useEffect(() => {
    const id = setInterval(() => setNowIso(new Date().toISOString()), 60_000);
    return () => clearInterval(id);
  }, []);
  const sla = describeSla(slaDueAt, nowIso);
  return (
    <span style={{ font: "600 11px var(--font-body)", color: STATE_COLOR[sla.state] }}>
      {slaDueAt ? (
        <time dateTime={slaDueAt} title={new Date(slaDueAt).toLocaleString()}>{sla.label}</time>
      ) : (
        <span title={sla.label}>{sla.label}</span>
      )}
    </span>
  );
}
