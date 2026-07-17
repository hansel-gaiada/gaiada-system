import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";
import { listDevices, DEVICE_STATUSES, type Device, type DeviceStatus } from "@/lib/it";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DeviceStatus as StatusPill } from "@/components/it/DeviceStatus";
import { DeviceForm } from "@/components/it/DeviceForm";
import { registerDevice } from "./actions";

type SearchParams = Promise<{ status?: string; kind?: string }>;

function when(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default async function DevicesPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { status, kind } = await searchParams;
  const canManage = canManageIT(me, tenant);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="IT" title="Devices" subtitle="Registered devices across the estate." />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const all = await listDevices(userId, tenant);
  const kinds = [...new Set(all.map((d) => d.kind))].sort();
  const filtered = all.filter(
    (d) => (!status || d.status === (status as DeviceStatus)) && (!kind || d.kind === kind),
  );

  const chip = (label: string, params: Record<string, string>, active: boolean) => {
    const qs = new URLSearchParams(params).toString();
    return (
      <Link
        key={label}
        href={`/it/devices${qs ? `?${qs}` : ""}`}
        className="lux-btn lux-btn--ghost lux-btn--sm"
        style={{ textDecoration: "none", ...(active ? { borderColor: "var(--erp-accent)", color: "var(--erp-accent)" } : {}) }}
      >
        {label}
      </Link>
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="IT"
        title="Devices"
        subtitle="Registered devices — CCTV, printers, servers, network gear and connected endpoints."
        actions={canManage ? <DeviceForm register={registerDevice} /> : undefined}
      />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginRight: 4 }}>Status</span>
          {chip("All", kind ? { kind } : {}, !status)}
          {DEVICE_STATUSES.map((s) => chip(s, { ...(kind ? { kind } : {}), status: s }, status === s))}
          <span style={{ width: 1, height: 18, background: "var(--erp-hairline)", margin: "0 4px" }} />
          <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginRight: 4 }}>Type</span>
          {chip("All", status ? { status } : {}, !kind)}
          {kinds.map((k) => chip(k, { ...(status ? { status } : {}), kind: k }, kind === k))}
        </div>
      </Card>

      <Card>
        {all.length === 0 ? (
          <EmptyNote>No devices registered yet.{canManage ? " Use “Register device” to add one." : ""}</EmptyNote>
        ) : filtered.length === 0 ? (
          <EmptyNote>No devices match this filter.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Name" }, { label: "Type" }, { label: "Site / Network" }, { label: "IP" }, { label: "Status" }, { label: "Last seen", align: "right" }]}
            rows={filtered.map((d: Device) => [
              <Link key="n" href={`/it/devices/${d.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{d.name}</Link>,
              d.kind,
              [d.site, d.network].filter(Boolean).join(" · ") || "—",
              d.ip ?? "—",
              <StatusPill key="s" status={d.status} />,
              when(d.lastHeartbeatAt),
            ])}
            tcols="1.4fr 0.8fr 1.3fr 1fr 0.9fr 1fr"
          />
        )}
      </Card>
    </>
  );
}
