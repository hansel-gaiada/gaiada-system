import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDevice } from "@/lib/it";
import { formatUptime } from "@/lib/admin";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { LineChart } from "@/components/LineChart";
import { DeviceStatus } from "@/components/it/DeviceStatus";

type Params = Promise<{ deviceId: string }>;

const SEV_LABEL: Record<string, string> = { info: "active", warn: "on hold", critical: "blocked" };

function whenTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function shell(title: string, body: React.ReactNode) {
  return (
    <>
      <PageHeader eyebrow="IT" title={title} />
      {body}
    </>
  );
}

export default async function DeviceDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deviceId } = await params;

  if (!tenant) return shell("Device", <EmptyNote>Select a company from the top bar.</EmptyNote>);

  const device = await getDevice(userId, tenant, deviceId);
  if (!device) return shell("Device not found", <EmptyNote>No device with that id in this company.</EmptyNote>);

  const identity = [
    { label: "Type", value: device.kind },
    { label: "Vendor", value: device.vendor ?? "—" },
    { label: "Model", value: device.model ?? "—" },
    { label: "Firmware", value: device.firmware ?? "—" },
    { label: "IP address", value: device.ip ?? "—" },
    { label: "MAC", value: device.mac ?? "—" },
    { label: "Site", value: device.site ?? "—" },
    { label: "Network", value: device.network ?? "—" },
    { label: "Uptime", value: typeof device.uptimeSec === "number" ? formatUptime(device.uptimeSec) : "—" },
    { label: "Last heartbeat", value: whenTime(device.lastHeartbeatAt) },
    { label: "Registered", value: whenTime(device.registeredAt) },
  ];

  return (
    <>
      <PageHeader
        eyebrow="IT"
        title={device.name}
        subtitle={device.kind}
        actions={<DeviceStatus status={device.status} />}
      />

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title="Identity">
          <DescriptionList items={identity} />
        </Card>
        <Card title="Heartbeat">
          {device.heartbeats.length >= 2 ? (
            <>
              <LineChart series={device.heartbeats} height={160} />
              <p style={{ margin: "10px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                Recent reachability/latency samples. Gaps indicate missed heartbeats.
              </p>
            </>
          ) : (
            <EmptyNote>No heartbeat history yet.</EmptyNote>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Events">
          {device.events.length === 0 ? (
            <EmptyNote>No events recorded for this device.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Severity" }, { label: "Event" }, { label: "Message" }, { label: "When", align: "right" }]}
              rows={device.events.map((e) => [
                <StatusBadge key="s" label={SEV_LABEL[e.severity] ?? e.severity} />,
                e.type,
                e.message,
                whenTime(e.occurred_at),
              ])}
              tcols="0.8fr 0.9fr 2fr 1fr"
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Link href="/it/devices" style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)", textDecoration: "none" }}>← All devices</Link>
      </div>
    </>
  );
}
