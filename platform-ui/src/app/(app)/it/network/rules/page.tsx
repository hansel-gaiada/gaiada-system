import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getIsolations, describeExpiry } from "@/lib/network";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ProvenanceBanner, NotBuiltNote } from "@/components/it/NetworkBanners";

export const metadata = { title: "Network isolation" };
export const dynamic = "force-dynamic";

export default async function NetworkRulesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const feed = await getIsolations(userId, tenant);
  const active = feed.isolations.filter((i) => i.state === "active");
  const pending = feed.isolations.filter((i) => i.state === "pending_approval");
  const history = feed.isolations.filter((i) => i.state === "expired" || i.state === "reverted");

  return (
    <>
      <ProvenanceBanner source={feed.source} />

      {!feed.enforcementEnabled && (
        <div className="nw-banner nw-banner--info" role="note">
          <span className="nw-banner__label">Read-only</span>
          <span className="nw-banner__text">
            Enforcement is designed but not built, and the ERP currently has no write path to the
            gateway. This page shows the shape of the control, not a live one.
          </span>
        </div>
      )}

      <div className="nw-kpis">
        <KpiTile
          label="Active isolations"
          value={String(active.length)}
          foot="in force now"
          hint="Hosts currently moved into the quarantine group. Every one has an expiry — an isolation that outlives its incident is an outage nobody remembers causing."
        />
        <KpiTile
          label="Awaiting approval"
          value={String(pending.length)}
          foot="proposed, not applied"
          hint="Proposing is not executing. These sit until an approver decides; approving is what executes them."
        />
        <KpiTile
          label="History"
          value={String(history.length)}
          foot="expired or reverted"
          hint="Isolations no longer in force. Kept so an incident can be reconstructed afterwards."
        />
      </div>

      <Card title="Current state" hint="Everything the ERP believes is quarantined. UniFi remains the authority — this is a record of what we asked for and when it was applied, not a mirror the ERP reconciles.">
        {feed.isolations.length === 0 ? (
          <EmptyNote>No host has ever been isolated.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Host" }, { label: "IP" }, { label: "Reason" },
              { label: "Requested by" }, { label: "Approved by" }, { label: "State" }, { label: "Expires" },
            ]}
            tcols="1fr 0.9fr 2fr 1fr 1fr 0.9fr 0.9fr"
            rows={feed.isolations.map((i) => [
              i.deviceName,
              i.ip ?? "—",
              i.reason,
              i.requestedBy,
              i.approvedBy ?? "—",
              <span key="st" className={`nw-chip nw-chip--${i.state}`}>{i.state.replace("_", " ")}</span>,
              // An applied isolation shows time remaining; an unapplied one has no clock to show,
              // because the window only starts when the collector actually applies it.
              i.appliedAt ? describeExpiry(i.expiresAt) : "not applied",
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 20, display: "grid", gap: 16 }}>
        <NotBuiltNote title="How isolation will work">
          A proposal names one host and a reason, and files an approval. <strong>Approving executes
          it</strong> — there is no second confirm step, which is deliberate: a decision that does
          nothing until someone presses another button is a decision nobody trusts. The approved
          action is then picked up by the office collector on its next poll, so an isolation is
          <strong> not instant</strong>; it lands within about a minute. The page will say so, because
          an operator who believes a block already took effect will act on that during the one moment
          it matters.
        </NotBuiltNote>

        <NotBuiltNote title="What the ERP will never be able to do">
          It can move a host into a pre-created quarantine group and nothing else — it cannot author,
          reorder or delete firewall rules. A bug therefore costs one device its internet, never the
          office its firewall. Four targets are refused server-side regardless of who asks: the
          gateway, any adopted infrastructure device, the collector host, and <strong>the host the
          approver is connected from</strong>. Without that last one, the first real incident response
          ends with the responder locked out mid-response.
        </NotBuiltNote>

        <NotBuiltNote title="Prerequisite">
          Quarantine needs somewhere to put a host. The office currently runs one flat
          10.10.0.0/22 for clients, so the VLAN work has to land before any of this can be switched
          on.
        </NotBuiltNote>
      </div>
    </>
  );
}
