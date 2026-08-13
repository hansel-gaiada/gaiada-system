import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listChannels,
  listRoutes,
  channelHealth,
  isCatchAll,
  ageSeconds,
  formatAge,
} from "@/lib/monitoring";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

export const metadata = { title: "Alert channels" };
export const dynamic = "force-dynamic";

const HEALTH_LABEL: Record<string, string> = {
  ok: "active",
  degraded: "at risk",
  failing: "critical",
  unused: "draft",
};

export default async function ChannelsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [channels, routes] = await Promise.all([listChannels(userId, tenant), listRoutes(userId, tenant)]);

  const now = Date.now();
  const failing = channels.filter((c) => channelHealth(c) === "failing");
  const catchAlls = routes.filter((r) => r.enabled && isCatchAll(r));
  const routedChannelIds = new Set(routes.filter((r) => r.enabled).map((r) => r.channelId));
  const unrouted = channels.filter((c) => c.enabled && !routedChannelIds.has(c.id));

  return (
    <>
      <p style={{ marginBottom: 12 }}>
        <Link href="/monitoring">← Monitoring</Link>
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Alert channels</h1>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Where monitoring alerts go. Every alert is emitted to the platform event log first, so
        automation flows and agents see the same event a person does — these channels are delivery,
        not a separate alerting system.
      </p>

      {/* Three quiet failure modes, stated up front rather than left for someone to notice.
          Each one means "you believe you are covered and you are not". */}
      {failing.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {failing.length} channel{failing.length === 1 ? " has" : "s have"} failed their last
            three deliveries. Alerts routed only through {failing.length === 1 ? "it" : "them"} are
            not reaching anyone.
          </EmptyNote>
        </div>
      )}
      {unrouted.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <EmptyNote>
            {unrouted.length} enabled channel{unrouted.length === 1 ? "" : "s"}
            {unrouted.length === 1 ? " has" : " have"} no route pointing at
            {unrouted.length === 1 ? " it" : " them"} — configured, but nothing will ever be sent.
          </EmptyNote>
        </div>
      )}
      {catchAlls.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            {catchAlls.length} route{catchAlls.length === 1 ? "" : "s"} match every event. That is
            occasionally intended, and is usually how one channel ends up flooded and then muted.
          </EmptyNote>
        </div>
      )}

      <Card
        title="Channels"
        hint="Health is based on recent delivery, not on whether the channel exists. A configured channel that keeps failing is worse than none — it looks like coverage."
      >
        {channels.length === 0 ? (
          <EmptyNote>
            No channels configured. Monitoring will still record incidents, but nobody will be told
            about them.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Channel" },
              { label: "Kind" },
              { label: "Destination" },
              { label: "Health" },
              { label: "Last delivery" },
            ]}
            rows={channels.map((c) => [
              c.name,
              c.kind,
              c.destination ?? "—",
              <StatusBadge key={`h-${c.id}`} label={HEALTH_LABEL[channelHealth(c)] ?? "draft"} />,
              c.lastDeliveryAt
                ? `${formatAge(ageSeconds(c.lastDeliveryAt, now))}${c.lastDeliveryOk === false ? " (failed)" : ""}`
                : "never",
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Routes"
          hint="Which alerts go to which channel. A route with no conditions matches everything."
        >
          {routes.length === 0 ? (
            <EmptyNote>
              No routes configured. Channels exist but nothing is directed to them.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Channel" },
                { label: "Client" },
                { label: "Severity" },
                { label: "Check type" },
                { label: "Status" },
              ]}
              rows={routes.map((r) => [
                r.channelName ?? r.channelId,
                r.matchClientName ?? (r.matchClientId ? r.matchClientId : "any"),
                r.matchSeverity ?? "any",
                r.matchKind ?? "any",
                <span key={`st-${r.id}`} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <StatusBadge label={r.enabled ? "active" : "suspended"} />
                  {r.enabled && isCatchAll(r) && <StatusBadge label="at risk" />}
                </span>,
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
