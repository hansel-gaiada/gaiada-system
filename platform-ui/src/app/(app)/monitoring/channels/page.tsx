import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import {
  listChannels,
  listRoutes,
  channelHealth,
  isCatchAll,
} from "@/lib/monitoring";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ChannelManager } from "@/components/monitoring/ChannelManager";
import { RouteManager } from "@/components/monitoring/RouteManager";

export const metadata = { title: "Alert channels" };
export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [channels, routes, clients] = await Promise.all([
    listChannels(userId, tenant),
    listRoutes(userId, tenant),
    listClients(userId, tenant),
  ]);
  const canManage = can(me, "monitoring.channel.manage", tenant);

  const failing = channels.filter((c) => channelHealth(c) === "failing");
  const catchAlls = routes.filter((r) => r.enabled && isCatchAll(r));
  const routedChannelIds = new Set(routes.filter((r) => r.enabled).map((r) => r.channelId));
  const unrouted = channels.filter((c) => c.enabled && !routedChannelIds.has(c.id));

  return (
    <>
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap", marginBottom: 4 }}>
        <p style={{ margin: 0 }}>
          <Link href="/monitoring">← Monitoring</Link>
        </p>
        <Link href="/monitoring/maintenance" style={{ fontSize: 13 }}>Maintenance windows</Link>
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Alert channels</h1>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Where monitoring alerts go. Every alert is emitted to the platform event log first, so
        automation flows and agents see the same event a person does — these channels are delivery,
        not a separate alerting system.
        {!canManage && " You have read access here; ask a manager or company admin for changes."}
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
        <ChannelManager tenantId={tenant} channels={channels} canManage={canManage} />
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card
          title="Routes"
          hint="Which alerts go to which channel. A route with no conditions matches everything."
        >
          <RouteManager
            tenantId={tenant}
            routes={routes}
            channels={channels.map((c) => ({ id: c.id, name: c.name }))}
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
            canManage={canManage}
          />
        </Card>
      </div>
    </>
  );
}
