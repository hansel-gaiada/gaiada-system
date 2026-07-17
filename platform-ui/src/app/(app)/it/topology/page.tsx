import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listDevices, buildTopology, summarizeHealth } from "@/lib/it";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Topology } from "@/components/it/Topology";

const LEGEND: { label: string; color: string; dim?: boolean }[] = [
  { label: "Online", color: "#4B7A5A" },
  { label: "Degraded", color: "#B5622F" },
  { label: "Offline", color: "#B5622F", dim: true },
  { label: "Unknown", color: "#A39174" },
];

export default async function TopologyPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="IT" title="Topology" subtitle="Site → Network → Device map." />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const devices = await listDevices(userId, tenant);
  const sites = buildTopology(devices);
  const health = summarizeHealth(devices);

  return (
    <>
      <PageHeader
        eyebrow="IT"
        title="Topology"
        subtitle={`Site → Network → Device. ${health.total} devices · ${health.online} online · ${health.offline + health.degraded} needing attention.`}
      />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        {LEGEND.map((l) => (
          <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 7, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.color, opacity: l.dim ? 0.6 : 1 }} />
            {l.label}
          </span>
        ))}
      </div>

      {devices.length === 0 ? (
        <Card><EmptyNote>No devices registered yet — nothing to map.</EmptyNote></Card>
      ) : (
        <div className="erp-scroll" style={{ overflowX: "auto" }}>
          <Topology sites={sites} />
        </div>
      )}
    </>
  );
}
