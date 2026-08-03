import Link from "next/link";
import type { Device, DeviceLink, TopoNode } from "@/lib/it";
import { DeviceStatus } from "./DeviceStatus";
import "./it.css";

// IT-06 — the REAL topology: gateway → AP/switch → client, drawn from the resolved edge set that
// GET /api/:t/it/topology returns. Replaces the old Topology.tsx (kept for the no-links fallback),
// which could only regroup rows by two free-text strings and had no way to express an uplink at all.
//
// Pure presentation of a prebuilt forest (see buildGraph in lib/it.ts). CSS-only, no client JS.

function mediumLabel(medium: DeviceLink["medium"] | null, port: number | null): string | null {
  if (!medium) return null;
  if (medium === "wired") return port == null ? "wired" : `port ${port}`;
  if (medium === "wireless") return "wireless";
  return null;
}

function Row({ device, medium, port }: { device: Device; medium: DeviceLink["medium"] | null; port: number | null }) {
  const link = mediumLabel(medium, port);
  return (
    <Link href={`/it/devices/${device.id}`} className={`it-tree__row it-tree__row--${device.status}`}>
      <span className="it-tree__name">{device.name}</span>
      <span className="it-tree__meta">
        {device.kind}
        {device.ip ? ` · ${device.ip}` : ""}
        {device.ssid ? ` · ${device.ssid}` : ""}
      </span>
      {device.deviceClass === "infrastructure" && (
        <span className="it-badge it-badge--infrastructure">infra</span>
      )}
      {device.discoverySource === "unifi" && <span className="it-badge it-badge--discovered">discovered</span>}
      <span className="it-tree__spacer" />
      {link && <span className="it-tree__meta">{link}</span>}
      <DeviceStatus status={device.status} />
    </Link>
  );
}

function Branch({ node }: { node: TopoNode }) {
  return (
    <li className="it-tree__item">
      <Row device={node.device} medium={node.medium} port={node.port} />
      {node.children.length > 0 && (
        <ul className="it-tree">
          {node.children.map((c) => (
            <Branch key={c.device.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TopologyGraph({ roots, unlinked }: { roots: TopoNode[]; unlinked: Device[] }) {
  return (
    <div>
      {roots.length > 0 && (
        <ul className="it-tree" aria-label="Network topology">
          {roots.map((r) => (
            <Branch key={r.device.id} node={r} />
          ))}
        </ul>
      )}
      {unlinked.length > 0 && (
        <section style={{ marginTop: roots.length ? 24 : 0 }} aria-label="Devices with no known uplink">
          <div className="it-net__head">
            <span className="it-net__name">No known uplink ({unlinked.length})</span>
          </div>
          {/* Shown rather than omitted: hand-registered devices never report an uplink, and a
              first poll can legitimately not have resolved a parent yet. Hiding them would make
              the map quietly disagree with the device list. */}
          <div className="it-net__devices">
            {unlinked.map((d) => (
              <Link key={d.id} href={`/it/devices/${d.id}`} className={`it-tile it-tile--${d.status}`}>
                <span className="it-tile__name">{d.name}</span>
                <span className="it-tile__meta">{d.kind}{d.ip ? ` · ${d.ip}` : ""}</span>
                <DeviceStatus status={d.status} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
