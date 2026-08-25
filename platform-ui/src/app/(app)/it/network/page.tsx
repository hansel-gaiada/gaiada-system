import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getTraffic, topTalkers, egressByCountry, formatBytes } from "@/lib/network";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProvenanceBanner, FeedBanner } from "@/components/it/NetworkBanners";

export const metadata = { title: "Network traffic" };
export const dynamic = "force-dynamic";

export default async function NetworkTrafficPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const traffic = await getTraffic(userId, tenant);
  const talkers = topTalkers(traffic.rollups);
  const egress = egressByCountry(traffic.rollups);
  const totalIn = traffic.rollups.reduce((n, r) => n + r.bytesIn, 0);
  const totalOut = traffic.rollups.reduce((n, r) => n + r.bytesOut, 0);
  const countries = egress.length;
  // Scale every bar against the loudest host so the lengths are comparable across rows. Guard the
  // zero case: an empty feed would otherwise divide by zero and render NaN-width bars.
  const peak = talkers.length ? talkers[0].total : 1;

  return (
    <>
      <ProvenanceBanner source={traffic.source} />
      <FeedBanner run={traffic.lastRun} label="Traffic feed" />

      <div className="nw-kpis">
        <KpiTile
          label="Inbound"
          value={formatBytes(totalIn)}
          foot={`last ${traffic.windowHours}h`}
          hint="Total bytes pulled in by all hosts in the window, summed from hourly rollups. Not packet capture — the collector aggregates before sending."
        />
        <KpiTile
          label="Outbound"
          value={formatBytes(totalOut)}
          foot={`last ${traffic.windowHours}h`}
          hint="Total bytes sent out. The number to watch: sustained outbound volume from a host that should be quiet is what exfiltration looks like."
        />
        <KpiTile
          label="Destination countries"
          value={String(countries)}
          foot="distinct"
          hint="Distinct destination countries seen this window. One unexpected entry here is worth more than a hundred rows of normal volume."
        />
        <KpiTile
          label="Hosts with traffic"
          value={String(talkers.length)}
          foot={`${traffic.rollups.filter((r) => !r.deviceId).length} unregistered`}
          hint="Hosts that moved traffic. 'Unregistered' means the device registry has never seen them — a host nobody registered but that is actively talking is more interesting than a known one, not less."
        />
      </div>

      <Card title="Top talkers" hint="Ranked by inbound + outbound combined. Sorting on outbound alone would hide a compromised host pulling a payload; sorting on inbound alone would hide a camera streaming out. Both columns are shown so you decide which shape is wrong.">
        {talkers.length === 0 ? (
          <EmptyNote>No traffic recorded in this window.</EmptyNote>
        ) : (
          <HairlineTable
            // Column ORDER is load-bearing here. HairlineTable's grid has no column gap, so a
            // right-aligned header sits flush against the next left-aligned one and the two render
            // as a single word ("OUTSHARE OF TRAFFIC"). Keeping every right-aligned column at the
            // END is the fix that preserves numeric alignment; shortening labels or flipping one
            // column's alignment only moves the seam. The destination count rides inside the share
            // cell for the same reason — one fewer boundary — and reads better next to the bar it
            // qualifies anyway.
            columns={[
              { label: "Host" }, { label: "IP" }, { label: "Share of traffic" },
              { label: "In", align: "right" }, { label: "Out", align: "right" },
            ]}
            tcols="1.5fr 1fr 1.6fr 0.8fr 0.8fr"
            rows={talkers.map((t) => [
              t.deviceId ? t.deviceName : `${t.deviceName} (unregistered)`,
              t.ip ?? "—",
              <span className="nw-share" key="share">
                <span className="nw-bar" aria-label={`${formatBytes(t.total)} total`}>
                  <span className="nw-bar__fill" style={{ width: `${Math.max(2, (t.total / peak) * 100)}%` }} />
                </span>
                <span className="nw-share__n">{t.destinations} dest{t.destinations === 1 ? "" : "s"}</span>
              </span>,
              formatBytes(t.bytesIn),
              formatBytes(t.bytesOut),
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Where traffic leaves to" hint="Destination country by total volume. This is the 'what goes out of our network' half of the question — the device registry cannot answer it, because knowing a device exists says nothing about who it talks to.">
          {egress.length === 0 ? (
            <EmptyNote>No egress recorded in this window.</EmptyNote>
          ) : (
            <div className="nw-egress">
              {egress.map((e) => (
                <div className="nw-egress__row" key={e.country}>
                  <span className="nw-egress__country">{e.country}</span>
                  <span className="nw-egress__meta">
                    {formatBytes(e.bytes)} · {e.devices} host{e.devices === 1 ? "" : "s"} · {e.sessions.toLocaleString()} sessions
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
