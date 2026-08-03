import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  buildGraph, buildTopology, countNodes, describeLastSync, getTopology, isDiscoveryStale, summarizeHealth,
} from "@/lib/it";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Topology } from "@/components/it/Topology";
import { TopologyGraph } from "@/components/it/TopologyGraph";
import "@/components/it/it.css";

const LEGEND: { label: string; color: string; dim?: boolean }[] = [
  { label: "Online", color: "var(--status-ok-fg)" },
  { label: "Degraded", color: "var(--status-critical-fg)" },
  { label: "Offline", color: "var(--status-critical-fg)", dim: true },
  { label: "Unknown", color: "var(--status-idle-fg)" },
];

export default async function TopologyPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const { devices, links, lastRun } = await getTopology(userId, tenant);
  const health = summarizeHealth(devices);
  const graph = buildGraph(devices, links);
  const stale = isDiscoveryStale(lastRun);
  // No edges at all means discovery has never resolved an uplink here (or the backend predates the
  // topology endpoint). Fall back to the old site→network grouping rather than showing a flat list
  // with no structure — it is a weaker view, but it is the honest one for that data.
  const graphable = links.length > 0;

  return (
    <>
      {/* Sync state first, and unconditionally. A dead collector and an empty network otherwise
          render identically, and an operator reads silence as "all clear". */}
      <div className={`it-sync ${stale ? "it-sync--stale" : "it-sync--ok"}`}>
        <span className="it-sync__label">Network discovery</span>
        {lastRun ? (
          <>
            <span>Last sync {describeLastSync(lastRun)}</span>
            <span className="it-tree__meta">{lastRun.devicesSeen} hosts seen</span>
            {lastRun.byodCount > 0 && (
              // BYOD is reported as an aggregate only — personal devices are deliberately never
              // persisted as rows (privacy gate, design §6).
              <span className="it-tree__meta">{lastRun.byodCount} personal (not registered)</span>
            )}
            {lastRun.error && <span style={{ color: "var(--status-critical-fg)" }}>{lastRun.error}</span>}
            {stale && !lastRun.error && (
              <strong style={{ color: "var(--status-critical-fg)", font: "400 12px var(--font-body)" }}>
                Feed is stale — the site collector may be down. Statuses below may be out of date.
              </strong>
            )}
          </>
        ) : (
          <span>
            Not connected. No site collector has reported yet, so this map shows only
            hand-registered devices — not what is actually on the network.
          </span>
        )}
      </div>

      <div style={{ font: "400 13px var(--font-body)", color: "var(--erp-ink-60)", marginBottom: 14 }}>
        {graphable ? "Gateway → access point / switch → device." : "Site → Network → Device."}{" "}
        {health.total} devices · {health.online} online · {health.offline + health.degraded} needing attention.
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        {LEGEND.map((l) => (
          <span key={l.label} style={{ display: "inline-flex", alignItems: "center", gap: 7, font: "400 12px var(--font-body)", color: "var(--erp-ink-60)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: l.color, opacity: l.dim ? 0.6 : 1 }} />
            {l.label}
          </span>
        ))}
      </div>

      {devices.length === 0 ? (
        // Unboxed per reva/ui's empty-state pass. The graphable branch is newer than that branch
        // and has to survive the merge — reva/ui simply predates the real topology graph.
        <EmptyNote>No devices registered yet — nothing to map.</EmptyNote>
      ) : graphable ? (
        <div className="erp-scroll" style={{ overflowX: "auto" }}>
          <TopologyGraph roots={graph.roots} unlinked={graph.unlinked} />
          {/* Proves the drawing accounts for every row it was handed; a mismatch would mean the
              edge set describes something the device list doesn't contain. */}
          <p style={{ margin: "14px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
            {countNodes(graph.roots)} mapped · {graph.unlinked.length} without a known uplink
          </p>
        </div>
      ) : (
        <div className="erp-scroll" style={{ overflowX: "auto" }}>
          <Topology sites={buildTopology(devices)} />
        </div>
      )}
    </>
  );
}
