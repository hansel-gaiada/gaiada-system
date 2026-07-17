import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listDevices, listDeviceEvents, summarizeHealth } from "@/lib/it";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

function whenTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const SEV_LABEL: Record<string, string> = { info: "active", warn: "on hold", critical: "blocked" };

export default async function ITOverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="IT" title="IT operations" subtitle="Device estate health and activity." />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const [devices, events] = await Promise.all([
    listDevices(userId, tenant),
    listDeviceEvents(userId, tenant, { limit: 15 }),
  ]);
  const health = summarizeHealth(devices);
  const openAlerts = events.filter((e) => e.severity === "critical" || e.severity === "warn").length;

  return (
    <>
      <PageHeader
        eyebrow="IT"
        title="IT operations"
        subtitle="Device estate health, heartbeat activity and events. Device events also flow to the audit log and notifications."
      />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Devices" value={String(health.total)} foot={`${health.unknown} unknown`} />
        <KpiTile label="Online" value={String(health.online)} />
        <KpiTile label="Degraded" value={String(health.degraded)} />
        <KpiTile label="Offline" value={String(health.offline)} />
        <KpiTile label="Open alerts" value={String(openAlerts)} foot="warn + critical" />
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <Link href="/it/devices" className="lux-btn lux-btn--solid lux-btn--sm" style={{ textDecoration: "none" }}>Devices</Link>
        <Link href="/it/topology" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>Topology</Link>
        <Link href="/it/workflows" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>Workflows</Link>
        <Link href="/admin/audit" className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>Audit log</Link>
      </div>

      <Card title="Recent device events">
        {events.length === 0 ? (
          <EmptyNote>No device events yet. Events appear as devices register and heartbeat.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Severity" }, { label: "Device" }, { label: "Event" }, { label: "When", align: "right" }]}
            rows={events.map((e) => [
              <StatusBadge key="s" label={SEV_LABEL[e.severity] ?? e.severity} />,
              e.deviceName ? (
                <Link key="d" href={`/it/devices/${e.deviceId}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{e.deviceName}</Link>
              ) : "—",
              e.message,
              whenTime(e.occurred_at),
            ])}
            tcols="0.8fr 1.2fr 2fr 1fr"
          />
        )}
      </Card>
    </>
  );
}
