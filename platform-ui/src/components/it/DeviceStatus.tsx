import type { DeviceStatus as Status } from "@/lib/it";
import "./it.css";

// Device status dot + label. The shared StatusBadge color map doesn't cover
// online/offline/degraded, so IT uses its own small map.
const COLORS: Record<Status, string> = {
  online: "var(--status-ok-fg)",
  degraded: "var(--status-critical-fg)",
  offline: "var(--status-critical-fg)",
  unknown: "var(--status-idle-fg)",
};
const LABELS: Record<Status, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
  unknown: "Unknown",
};

export function DeviceStatus({ status }: { status: Status }) {
  const color = COLORS[status] ?? COLORS.unknown;
  return (
    <span className="it-dot">
      <span className="it-dot__mark" style={{ background: color, opacity: status === "offline" ? 0.6 : 1 }} />
      <span className="it-dot__label" style={{ color }}>{LABELS[status] ?? "Unknown"}</span>
    </span>
  );
}
