import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";
import { listBlocksResult } from "@/lib/itSecurity";
import { blockEndedAs, personOf, revocationOf } from "@/lib/itSecurityView";
import { formatTimestamp } from "@/lib/format";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { BlockAddressControl, LiftBlockControl } from "@/components/it/SecurityControls";
import "@/components/it/network.css";

export const metadata = { title: "Blocks" };
export const dynamic = "force-dynamic";

// DW-7h (BFF §52.5, §52.6): the addresses IT has blocked from this company's data, and the sessions it has ended. A block
// refuses every request from that address to this company's pages for as long as it lasts (it never touches sign-in itself,
// which is the sign-in service's), takes effect within about 10 seconds, and is lifted from here.
//
// The read is `it_account` `read`; Lift, the form and the per-row controls on Connected are `it_account` `disable`.
export default async function NetworkBlocksPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!canManageIT(me, tenant)) {
    return <ReadRefusal subject="address blocks for this company" kind="forbidden" detail="IT managers and company admins can see and change them." />;
  }

  const result = await listBlocksResult(userId, tenant);
  if (result.kind === "forbidden") return <ReadRefusal subject="address blocks for this company" kind="forbidden" />;
  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="The list of blocks"
        kind="unavailable"
        reason={result.reason}
        detail="An empty list would say no address is blocked; that cannot be said while the list is unreadable."
      />
    );
  }

  const { ipBlocks, revokedSessions } = result.data;
  const active = ipBlocks.filter((b) => b.active);
  const past = ipBlocks.filter((b) => !b.active);
  const stopped = active.reduce((sum, b) => sum + b.hitCount, 0);

  return (
    <>
      <div className="nw-kpis">
        <KpiTile label="Blocked addresses" value={String(active.length)} foot="active now" />
        <KpiTile label="Requests stopped" value={String(stopped)} foot="by the active blocks" hint="Requests turned away because they came from a blocked address. Counted at most once a minute per block." />
        <KpiTile label="Sessions ended" value={String(revokedSessions.length)} foot="last 7 days" hint="Sign-outs and blocked logins by this company's IT in the last 7 days." />
      </div>

      <Card title="Block an address" hint="Everyone at that address is turned away from this company's pages until the block ends or you lift it. Private office addresses and your own are refused.">
        <BlockAddressControl />
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="Blocked now">
          {active.length === 0 ? (
            <EmptyNote>No address is blocked right now.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Address" }, { label: "Reason" }, { label: "Until" }, { label: "Stopped" }, { label: "Actions" }]}
              tcols="1fr 2fr 1.2fr 1fr 1.6fr"
              rows={active.map((b) => [
                <span key="ip" className="nw-mono">{b.ip}</span>,
                <span key="r" className="nw-who">
                  <span className="nw-who__name">{b.reason}</span>
                  <span className="nw-who__sub">Blocked {formatTimestamp(b.createdAt)}{` by ${b.createdBy.displayName}`}</span>
                </span>,
                formatTimestamp(b.expiresAt),
                b.hitCount === 0 ? "Nothing yet" : `${b.hitCount.toLocaleString("en")} request${b.hitCount === 1 ? "" : "s"}${b.lastHitAt ? `, last ${formatTimestamp(b.lastHitAt)}` : ""}`,
                <LiftBlockControl key="a" blockId={b.id} ip={b.ip} />,
              ])}
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Earlier blocks" hint="Blocks that ended in the last 30 days, lifted or run out.">
          {past.length === 0 ? (
            <EmptyNote>No block has ended in the last 30 days.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Address" }, { label: "Reason" }, { label: "Ended" }, { label: "How" }, { label: "Stopped" }]}
              tcols="1fr 2fr 1.2fr 0.8fr 1fr"
              rows={past.map((b) => {
                const how = blockEndedAs(b);
                return [
                  <span key="ip" className="nw-mono">{b.ip}</span>,
                  b.reason,
                  formatTimestamp(b.liftedAt ?? b.expiresAt),
                  <span key="h" className={`nw-chip nw-chip--${how}`}>{how === "lifted" ? "Lifted" : "Ran out"}</span>,
                  String(b.hitCount),
                ];
              })}
            />
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Sessions ended recently" hint="Sign-outs from Connected and blocked logins from IT accounts, last 7 days.">
          {revokedSessions.length === 0 ? (
            <EmptyNote>IT has not ended any session in the last 7 days.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Person" }, { label: "What" }, { label: "When" }, { label: "Reason" }]}
              tcols="1.4fr 1.8fr 1.2fr 1.6fr"
              rows={[...revokedSessions].sort((a, b) => b.revokedAt.localeCompare(a.revokedAt)).map((r) => [
                <span key={`p${r.id}`} className="nw-who">
                  <span className="nw-who__name">{personOf(r.who)}</span>
                  <span className="nw-who__sub">{r.who.email}</span>
                </span>,
                revocationOf(r),
                <span key={`w${r.id}`} className="nw-who">
                  <span className="nw-who__name">{formatTimestamp(r.revokedAt)}</span>
                  {r.revokedBy ? <span className="nw-who__sub">by {r.revokedBy.displayName}</span> : null}
                </span>,
                r.reason ?? "—",
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
