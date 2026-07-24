import { Card, KpiTile, StatusBadge } from "@/components/ui";
import { StatusDot } from "./StatusDot";
import { ConnectionState } from "./ConnectionState";
import { formatUptime, type SystemStatus } from "@/lib/admin";
import "./systems.css";

export function StatusCard({ status }: { status: SystemStatus | null }) {
  if (!status) return <ConnectionState system="This system" />;

  const counters = Object.entries(status.counters ?? {});
  // Additive (A5, doc §2.5): the bot's admin probe adds `detail.session`
  // (a WAHA session status string, e.g. "WORKING"/"unknown") once nest's
  // probeStatus("bot") wires it up (doc §2.4). Every other system's `detail`
  // shape is untouched — this only renders when the key is present.
  const sessionStatus = typeof status.detail?.session === "string" ? status.detail.session : null;

  return (
    <Card title="Status">
      <div className="sys-status-card__head">
        <StatusDot ok={status.ok} />
        {status.version && <span className="sys-status-card__version">v{status.version}</span>}
        {status.uptimeSec !== undefined && (
          <span className="sys-status-card__uptime">Up {formatUptime(status.uptimeSec)}</span>
        )}
        {sessionStatus && (
          <span title="WhatsApp session status">
            <StatusBadge label={sessionStatus} />
          </span>
        )}
      </div>
      {counters.length > 0 && (
        <div className="sys-status-card__counters">
          {counters.map(([key, value]) => (
            <KpiTile key={key} label={key} value={String(value)} />
          ))}
        </div>
      )}
    </Card>
  );
}
