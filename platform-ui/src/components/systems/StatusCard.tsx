import { Card, KpiTile } from "@/components/ui";
import { StatusDot } from "./StatusDot";
import { ConnectionState } from "./ConnectionState";
import { formatUptime, type SystemStatus } from "@/lib/admin";
import "./systems.css";

export function StatusCard({ status }: { status: SystemStatus | null }) {
  if (!status) return <ConnectionState system="This system" />;

  const counters = Object.entries(status.counters ?? {});

  return (
    <Card title="Status">
      <div className="sys-status-card__head">
        <StatusDot ok={status.ok} />
        {status.version && <span className="sys-status-card__version">v{status.version}</span>}
        {status.uptimeSec !== undefined && (
          <span className="sys-status-card__uptime">Up {formatUptime(status.uptimeSec)}</span>
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
