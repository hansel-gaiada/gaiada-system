import Link from "next/link";
import type { TopologySite } from "@/lib/it";
import { DeviceStatus } from "./DeviceStatus";
import "./it.css";

// Read-only Site → Network → Device map. Pure presentation of a prebuilt
// topology (see buildTopology in lib/it.ts). CSS-only, responsive.
export function Topology({ sites }: { sites: TopologySite[] }) {
  return (
    <div className="it-topo">
      {sites.map((site) => {
        const count = site.networks.reduce((n, net) => n + net.devices.length, 0);
        return (
          <section className="it-site" key={site.name} aria-label={`Site ${site.name}`}>
            <div className="it-site__head">
              <span className="it-site__name">{site.name}</span>
              <span className="it-site__count">{count} device{count === 1 ? "" : "s"}</span>
            </div>
            {site.networks.map((net) => (
              <div className="it-net" key={net.name}>
                <div className="it-net__head">
                  <span className="it-net__name">{net.name}</span>
                </div>
                <div className="it-net__devices">
                  {net.devices.map((d) => (
                    <Link
                      key={d.id}
                      href={`/it/devices/${d.id}`}
                      className={`it-tile it-tile--${d.status}`}
                    >
                      <span className="it-tile__name">{d.name}</span>
                      <span className="it-tile__meta">{d.kind}{d.ip ? ` · ${d.ip}` : ""}</span>
                      <DeviceStatus status={d.status} />
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
