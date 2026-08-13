// SMM-11 — the honest 403 state (owner decision, smm-design-addendum-2026-08-12.md's SMM-11 row:
// "A denied read is a 403 and must look like one. Never fold an authorization failure into an
// empty state ('no posts yet') — the client portal already shipped that bug once in this estate").
//
// Deliberately NOT `TeachState` (components/departments/TeachState.tsx): that component's whole
// job is "here's what to do about a genuinely empty, first-run surface" — its warm tone and CTA
// pattern is exactly wrong for "you were refused," which is a permissions gap, not a setup step.
export function AccessDenied({ what }: { what: string }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex", gap: 12, alignItems: "flex-start",
        border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--status-critical-fg, #b3261e)",
        background: "var(--tint-hover)", padding: "14px 16px",
      }}
    >
      <span aria-hidden="true" style={{ font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--status-critical-fg, #b3261e)", whiteSpace: "nowrap", paddingTop: 1 }}>
        Access denied
      </span>
      <span style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
        You don&rsquo;t have permission to {what}. This is a Cerbos denial (403), not an empty list —
        ask a department manager for the <code style={{ font: "600 12px var(--font-mono, monospace)" }}>social_staff</code> or{" "}
        <code style={{ font: "600 12px var(--font-mono, monospace)" }}>social_manager</code> grant if you believe this is wrong.
      </span>
    </div>
  );
}
