import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPresence } from "@/lib/network";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProvenanceBanner, NotBuiltNote } from "@/components/it/NetworkBanners";

export const metadata = { title: "Occupancy" };
export const dynamic = "force-dynamic";

// WiFi sensing measures how radio signals are disturbed by bodies in a room. It is filed under the
// network console because it rides WiFi hardware — but it is a FACILITIES tool, and the vocabulary
// on this page holds that line deliberately: zones, occupancy, sensors. Never "detection",
// never "intruder", never a person's name. See lib/network.ts PresenceZone — the shape has nowhere
// to put a person, which is the real guarantee; the wording is just the reminder.
export default async function NetworkPresencePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const feed = await getPresence(userId, tenant);
  const online = feed.zones.filter((z) => z.sensorOnline);
  const total = online.reduce((n, z) => n + z.occupancy, 0);
  const offline = feed.zones.length - online.length;

  return (
    <>
      <ProvenanceBanner source={feed.source} />

      {!feed.hardwareDeployed && (
        <div className="nw-banner nw-banner--info" role="note">
          <span className="nw-banner__label">No hardware</span>
          <span className="nw-banner__text">
            No sensing hardware has been chosen or installed. This page shows the intended shape of
            the surface so it can be judged before anything is bought.
          </span>
        </div>
      )}

      <div className="nw-kpis">
        <KpiTile
          label="People on site"
          value={String(total)}
          foot={`across ${online.length} zone${online.length === 1 ? "" : "s"}`}
          hint="Sum of zone occupancy from sensors currently reporting. Zones whose sensor is offline are excluded rather than counted as zero — an unmonitored room is not an empty one."
        />
        <KpiTile
          label="Zones"
          value={String(feed.zones.length)}
          foot={offline > 0 ? `${offline} sensor offline` : "all reporting"}
          hint="A zone is a physical area covered by one or more sensors, defined by us — not by the sensor hardware."
        />
        <KpiTile
          label="Lowest confidence"
          value={online.length ? `${Math.round(Math.min(...online.map((z) => z.confidence)) * 100)}%` : "—"}
          foot="weakest reporting zone"
          hint="WiFi sensing is probabilistic. A count presented without confidence overstates what the signal can actually tell you, so the weakest zone is surfaced rather than averaged away."
        />
      </div>

      <Card title="Zone occupancy" hint="How many people a zone's sensors believe are present. Counts only — this measures that a body is in a room, not who.">
        {feed.zones.length === 0 ? (
          <EmptyNote>No zones defined.</EmptyNote>
        ) : (
          <div className="nw-zones">
            {feed.zones.map((z) => (
              <div key={z.zoneId} className={`nw-zone${z.sensorOnline ? "" : " nw-zone--offline"}`}>
                <span className="nw-zone__name">{z.name}</span>
                <span className="nw-zone__count">{z.sensorOnline ? z.occupancy : "—"}</span>
                <span className="nw-zone__meta">
                  {z.sensorOnline ? `${Math.round(z.confidence * 100)}% confidence` : "sensor offline"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ marginTop: 20, display: "grid", gap: 16 }}>
        <NotBuiltNote title="This cannot run on the existing access points">
          Every working implementation needs raw Channel State Information, and UniFi does not expose
          CSI on any API. It requires dedicated hardware — a handful of ESP32s, or a Raspberry Pi
          with a patched WiFi chipset — plus a service running in the office. It is a hardware
          purchase and a research spike, not a page. The next step is one room, one option, measured.
        </NotBuiltNote>

        <NotBuiltNote title="What this will and will not store">
          Zone occupancy counts, and nothing else: <strong>no identity, no per-person tracks, no raw
          signal data kept at rest</strong>. The reason is not squeamishness. This senses people
          directly, including people carrying no device, inside rooms — and the device discovery
          design already refuses to store personal phones for a weaker version of the same concern,
          because ~25 of the hosts on the office network carry hostnames that name the employee
          holding them. Storing anything finer than a room count here needs a privacy assessment and
          notice to staff <strong>before the first sample is kept</strong>, not after.
        </NotBuiltNote>
      </div>
    </>
  );
}
