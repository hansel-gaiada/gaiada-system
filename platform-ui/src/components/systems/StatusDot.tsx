import "./systems.css";

const COLORS = {
  online: "var(--status-ok-fg)",
  down: "var(--status-critical-fg)",
  unknown: "var(--status-idle-fg)",
} as const;

export function StatusDot({ ok }: { ok: boolean | null }) {
  const state = ok === true ? "online" : ok === false ? "down" : "unknown";
  const label = ok === true ? "Online" : ok === false ? "Down" : "Unknown";
  const color = COLORS[state];
  return (
    <span className="sys-status-dot">
      <span className="sys-status-dot__mark" style={{ background: color }} />
      <span className="sys-status-dot__label" style={{ color }}>{label}</span>
    </span>
  );
}
