import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";
import { listDevices, DEVICE_STATUSES, DEVICE_CLASSES, type Device, type DeviceStatus } from "@/lib/it";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DeviceStatus as StatusPill } from "@/components/it/DeviceStatus";
import { DeviceForm } from "@/components/it/DeviceForm";
import { registerDevice } from "./actions";
import "@/components/it/it.css";

type SearchParams = Promise<{ status?: string; kind?: string; deviceClass?: string; q?: string; all?: string }>;

// Cap the table by default. The registry used to hold 8 seeded rows; a real discovered estate is
// ~58 and climbing, at which point an uncapped table is a wall of text with no way to navigate it.
const PAGE_CAP = 50;

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
  const { status, kind, deviceClass, q, all } = await searchParams;
  const canManage = canManageIT(me, tenant);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  // Search + class filtering happen in the backend (indexed, and correct across the whole estate);
  // status/kind stay client-side because their chip lists are derived from what came back.
  const matched = await listDevices(userId, tenant, { deviceClass, q });
  const kinds = [...new Set(matched.map((d) => d.kind))].sort();
  const filtered = matched.filter(
    (d) => (!status || d.status === (status as DeviceStatus)) && (!kind || d.kind === kind),
  );
  const shown = all ? filtered : filtered.slice(0, PAGE_CAP);

  const base = { ...(deviceClass ? { deviceClass } : {}), ...(q ? { q } : {}) };
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
  const groupLabel = (text: string) => (
    <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)", marginRight: 4 }}>
      {text}
    </span>
  );

  return (
    <>
      {canManage && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
          <DeviceForm register={registerDevice} />
        </div>
      )}

      <Card style={{ marginBottom: 16 }}>
        {/* Plain GET form — no client JS needed for search, and the result stays a shareable URL. */}
        <form method="get" action="/it/devices" style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search name, hostname, IP or MAC"
            aria-label="Search devices"
            className="lux-field__control"
            style={{ flex: "1 1 260px", minWidth: 0 }}
          />
          {deviceClass && <input type="hidden" name="deviceClass" value={deviceClass} />}
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Search</button>
          {q && (
            <Link href={`/it/devices${deviceClass ? `?deviceClass=${deviceClass}` : ""}`} className="lux-btn lux-btn--ghost lux-btn--sm" style={{ textDecoration: "none" }}>
              Clear
            </Link>
          )}
        </form>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {groupLabel("Class")}
          {chip("All", { ...(q ? { q } : {}) }, !deviceClass)}
          {DEVICE_CLASSES.map((c) => chip(c, { ...(q ? { q } : {}), deviceClass: c }, deviceClass === c))}
          <span style={{ width: 1, height: 18, background: "var(--erp-hairline)", margin: "0 4px" }} />
          {groupLabel("Status")}
          {chip("All", { ...base, ...(kind ? { kind } : {}) }, !status)}
          {DEVICE_STATUSES.map((s) => chip(s, { ...base, ...(kind ? { kind } : {}), status: s }, status === s))}
          <span style={{ width: 1, height: 18, background: "var(--erp-hairline)", margin: "0 4px" }} />
          {groupLabel("Type")}
          {chip("All", { ...base, ...(status ? { status } : {}) }, !kind)}
          {kinds.map((k) => chip(k, { ...base, ...(status ? { status } : {}), kind: k }, kind === k))}
        </div>
      </Card>

      <Card>
        {matched.length === 0 ? (
          <EmptyNote>
            {q || deviceClass
              ? "No devices match this search."
              : `No devices registered yet.${canManage ? " Use “Register device” to add one." : ""}`}
          </EmptyNote>
        ) : filtered.length === 0 ? (
          <EmptyNote>No devices match this filter.</EmptyNote>
        ) : (
          <>
            <HairlineTable
              columns={[{ label: "Name" }, { label: "Type" }, { label: "Source" }, { label: "Site / Network" }, { label: "IP" }, { label: "Status" }, { label: "Last seen", align: "right" }]}
              rows={shown.map((d: Device) => [
                <Link key="n" href={`/it/devices/${d.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>
                  {d.name}
                  {d.hostname && d.hostname !== d.name && (
                    <span className="it-tree__meta" style={{ marginLeft: 8 }}>{d.hostname}</span>
                  )}
                </Link>,
                d.kind,
                // Discovered vs Manual matters operationally: it decides which fields are editable
                // and whether a stale row means "device gone" or "nobody updated the registry".
                d.discoverySource === "unifi"
                  ? <span key="s" className="it-badge it-badge--discovered">discovered</span>
                  : <span key="s" className="it-badge">manual</span>,
                [d.site, d.network].filter(Boolean).join(" · ") || "—",
                d.ip ?? "—",
                <StatusPill key="st" status={d.status} />,
                when(d.lastSeenAt ?? d.lastHeartbeatAt),
              ])}
              tcols="1.6fr 0.8fr 0.8fr 1.2fr 1fr 0.9fr 1fr"
            />
            <p style={{ margin: "12px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              Showing {shown.length} of {filtered.length}
              {shown.length < filtered.length && (
                <>
                  {" · "}
                  <Link href={`/it/devices?${new URLSearchParams({ ...base, ...(status ? { status } : {}), ...(kind ? { kind } : {}), all: "1" })}`} style={{ color: "var(--erp-accent)" }}>
                    Show all
                  </Link>
                </>
              )}
            </p>
          </>
        )}
      </Card>
    </>
  );
}
