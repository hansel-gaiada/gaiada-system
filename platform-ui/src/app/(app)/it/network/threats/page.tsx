import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getThreats, summarizeThreats, canProposeIsolation, describeFeed } from "@/lib/network";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProvenanceBanner, FeedBanner, NotBuiltNote } from "@/components/it/NetworkBanners";

export const metadata = { title: "Network threats" };
export const dynamic = "force-dynamic";

const DIR_LABEL: Record<string, string> = { inbound: "IN →", outbound: "→ OUT", internal: "↔ LAN" };

export default async function NetworkThreatsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const feed = await getThreats(userId, tenant);
  const s = summarizeThreats(feed.threats);
  // Newest first. An operator opens this page to answer "what is happening now", not "what is the
  // worst thing on record" — severity sorting would bury a fresh critical under an old one.
  const rows = [...feed.threats].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return (
    <>
      <ProvenanceBanner source={feed.source} />
      <FeedBanner run={feed.lastRun} label="Threat feed" />

      <div className="nw-kpis">
        <KpiTile
          label="Open"
          value={String(s.open)}
          foot={`of ${s.total} total`}
          hint="New plus investigating. Resolved and false-positive events are history, not workload — rolling them into one total produces a number that only ever goes up and therefore means nothing."
        />
        <KpiTile
          label="Critical"
          value={String(s.bySeverity.critical)}
          foot={`${s.bySeverity.high} high`}
          hint="Severity as reported by the gateway's IDS signature set, not re-scored here."
        />
        <KpiTile
          label="Blocked"
          value={String(s.blocked)}
          foot="by the gateway"
          hint="The gateway actively dropped this traffic (IPS mode). Contrast with Detected, where it only logged."
        />
        <KpiTile
          label="Detected only"
          value={String(s.detected)}
          foot="logged, not stopped"
          hint="Seen and recorded, but the traffic still flowed. If this number is high and Blocked is zero, the gateway is running IDS without IPS — it is watching, not defending."
        />
      </div>

      {s.detected > 0 && s.blocked === 0 && (
        <div className="nw-banner nw-banner--info" role="note" style={{ marginBottom: 18 }}>
          <span className="nw-banner__label">Detection only</span>
          <span className="nw-banner__text">
            Every event in this window was logged but not stopped, which is what a gateway running
            IDS without IPS looks like. Worth confirming in the UniFi console before treating this
            page as a defence.
          </span>
        </div>
      )}

      <Card title="Events" hint="Straight from the gateway's threat-management engine, newest first. Nothing here is re-scored or filtered by the ERP.">
        {rows.length === 0 ? (
          <EmptyNote>
            No threat events in this window. Confirm the feed timestamp above before reading this as
            good news.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Signature" }, { label: "Severity" }, { label: "Direction" },
              { label: "Source" }, { label: "Host" }, { label: "Action" }, { label: "Triage" },
            ]}
            tcols="2.2fr 0.7fr 0.7fr 1fr 1fr 0.8fr 0.9fr"
            rows={rows.map((t) => [
              <span key="sig" title={new Date(t.occurredAt).toLocaleString()}>{t.signature}</span>,
              <span key="sev" className={`nw-chip nw-chip--${t.severity}`}>{t.severity}</span>,
              <span key="dir" className="nw-dir">{DIR_LABEL[t.direction] ?? t.direction}</span>,
              t.srcIp,
              t.deviceName ?? "—",
              <span key="act" className={`nw-chip nw-chip--${t.action}`}>{t.action}</span>,
              <span key="tri" className={`nw-chip nw-chip--${t.triageState}`}>{t.triageState.replace("_", " ")}</span>,
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <NotBuiltNote title="Isolation is not wired up yet">
          {rows.filter((t) => canProposeIsolation(t)).length} of these events involve a host we
          control and could therefore be proposed for isolation. That action files an approval and
          only takes effect once someone approves it — it is designed but not built. An inbound
          attacker is never isolatable: there is nothing of ours to quarantine. See the Isolation
          tab. Feed last collected {describeFeed(feed.lastRun)}.
        </NotBuiltNote>
      </div>
    </>
  );
}
