import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/lib/rbac";
import { listConnectionsResult } from "@/lib/itSecurity";
import { CONNECTION_WINDOWS, DEVICE_KIND_LABEL, WINDOW_LABEL, agoFrom, describeDevice, parseWindow } from "@/lib/itSecurityView";
import { formatTimestamp } from "@/lib/format";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WindowChoice } from "@/components/it/WindowChoice";
import { BlockAddressControl, SignOutControl } from "@/components/it/SecurityControls";
import "@/components/it/network.css";

export const metadata = { title: "Connected" };
export const dynamic = "force-dynamic";

// DW-7h (BFF §52.6): who is connected to the ERP, from which address and on what device. It is what reached THIS system, not the
// office network (DW-D36: that waits for the office collector). A connection is recorded when a signed-in person's request
// reaches a company page, at most once a minute per person, session and address.
//
// The read is `it_account` `read`; Sign out and Block address are `it_account` `disable`, the same people (`it.manage`). The page
// mirrors that: a viewer without it is refused in words, and the server still decides.
type SearchParams = Promise<{ window?: string | string[] }>;

export default async function NetworkConnectedPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!canManageIT(me, tenant)) {
    return <ReadRefusal subject="who is connected to this company" kind="forbidden" detail="IT managers and company admins can see it." />;
  }

  const win = parseWindow((await searchParams).window, CONNECTION_WINDOWS, "24h");
  const result = await listConnectionsResult(userId, tenant, win);
  if (result.kind === "forbidden") return <ReadRefusal subject="who is connected to this company" kind="forbidden" />;
  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="The list of connections"
        kind="unavailable"
        reason={result.reason}
        detail="An empty list would say nobody is connected; that cannot be said while the list is unreadable."
      />
    );
  }

  const { asOf, connections } = result.data;
  const people = new Set(connections.map((c) => c.who.userId)).size;
  const addresses = new Set(connections.map((c) => c.ip).filter((ip): ip is string => ip !== null)).size;
  const cut = connections.filter((c) => c.revoked).length;

  return (
    <>
      <WindowChoice base="/it/network/presence" options={CONNECTION_WINDOWS} current={win} />

      <div className="nw-kpis">
        <KpiTile label="People connected" value={String(people)} foot={WINDOW_LABEL[win]} hint="People with at least one request to this company in the window." />
        <KpiTile label="Connections" value={String(connections.length)} foot="session and address pairs" hint="One row per person, browser session and network address. The same person on two networks is two rows." />
        <KpiTile label="Addresses" value={String(addresses)} foot="distinct" />
        <KpiTile label="Signed out by IT" value={String(cut)} foot="still showing here" hint="Connections whose session or login IT has ended. They stay listed until they age out of the window." />
      </div>

      <Card
        title="Who is connected"
        hint="Newest first, at most 500. This is the ERP's own record of who reached it, not a scan of the office network."
      >
        {connections.length === 0 ? (
          <EmptyNote>Nobody connected in this window ({WINDOW_LABEL[win].toLowerCase()}), as of {formatTimestamp(asOf)}.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Person" }, { label: "Device" }, { label: "Address" }, { label: "Last seen" }, { label: "Actions" }]}
            tcols="1.4fr 1.2fr 1fr 1fr 2fr"
            rows={connections.map((c) => {
              const who = c.who.displayName || c.who.email;
              return [
                <span key="p" className="nw-who">
                  <span className="nw-who__name">{who}</span>
                  <span className="nw-who__sub">{c.who.email}</span>
                </span>,
                <span key="d" className="nw-who">
                  <span className="nw-who__name">{describeDevice(c.device)}</span>
                  <span className="nw-who__sub">{DEVICE_KIND_LABEL[c.device.kind]}</span>
                </span>,
                <span key="ip" className="nw-who">
                  <span className="nw-mono">{c.ip ?? "Unknown"}</span>
                  {c.ipBlocked ? <span className="nw-flag">Blocked</span> : null}
                </span>,
                <span key="seen" className="nw-who" title={formatTimestamp(c.lastSeenAt)}>
                  <span className="nw-who__name">{agoFrom(asOf, c.lastSeenAt)}</span>
                  <span className="nw-who__sub">{c.requestCount.toLocaleString("en")} request{c.requestCount === 1 ? "" : "s"}</span>
                </span>,
                <span key="a" className="nw-who">
                  {c.revoked ? (
                    <span className="nw-flag">Signed out</span>
                  ) : c.sessionId ? (
                    <SignOutControl userId={c.who.userId} sessionId={c.sessionId} who={who} />
                  ) : (
                    <span className="nw-who__sub">No session id, so this one cannot be signed out on its own. Block the login in IT accounts.</span>
                  )}
                  {c.ip && !c.ipBlocked ? <BlockAddressControl ip={c.ip} inline /> : null}
                </span>,
              ];
            })}
          />
        )}
      </Card>
    </>
  );
}
