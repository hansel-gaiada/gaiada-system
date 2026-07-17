// Explicit "this needs a backend" banner. Phase-0 honesty: where a screen is
// built but its endpoint isn't live yet, say so plainly instead of showing an
// empty table that looks like real (empty) data. Pass `contract` to point the
// backend team at the exact endpoint(s).
export function BackendPending({ what, contract }: { what: string; contract?: string }) {
  return (
    <div
      role="note"
      style={{
        display: "flex", gap: 12, alignItems: "flex-start",
        border: "0.5px solid var(--erp-hairline)", borderLeft: "3px solid var(--erp-accent)",
        background: "rgba(110,90,67,.05)", padding: "12px 14px", marginBottom: 16,
      }}
    >
      <span aria-hidden="true" style={{ font: "700 11px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-accent)", whiteSpace: "nowrap", paddingTop: 1 }}>
        Backend pending
      </span>
      <span style={{ font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
        {what}
        {contract ? <> Backend contract: <code style={{ font: "600 12px var(--font-mono, monospace)" }}>{contract}</code>.</> : null}
      </span>
    </div>
  );
}
