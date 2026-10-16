import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/lib/rbac";
import { listSignInsResult } from "@/lib/itSecurity";
import { SIGN_IN_WINDOWS, WINDOW_LABEL, parseWindow, signInsStateWords } from "@/lib/itSecurityView";
import { formatTimestamp } from "@/lib/format";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WindowChoice } from "@/components/it/WindowChoice";
import "@/components/it/network.css";

export const metadata = { title: "Sign-ins" };
export const dynamic = "force-dynamic";

// DW-7h (BFF §52.6): every sign-in, failed sign-in and sign-out of this company's people, from the sign-in service's own events.
//
// ⚠ THREE STATES, NEVER TWO. `on` (the events were read), `off` (the sign-in service records none) and `unavailable` (the read
// failed, or the role that reads events is missing). The last two are worded as what they are and draw NO figures: a "0 failed
// sign-ins" under a service that records nothing would read as an all-clear, which is the one thing this page must not say.
const SHOWN = 200;
const TYPE_LABEL = { sign_in: "Signed in", failed: "Failed", sign_out: "Signed out" } as const;
type SearchParams = Promise<{ window?: string | string[] }>;

export default async function NetworkSignInsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!canManageIT(me, tenant)) {
    return <ReadRefusal subject="the sign-in record for this company" kind="forbidden" detail="IT managers and company admins can see it." />;
  }

  const win = parseWindow((await searchParams).window, SIGN_IN_WINDOWS, "24h");
  const result = await listSignInsResult(userId, tenant, win);
  if (result.kind === "forbidden") return <ReadRefusal subject="the sign-in record for this company" kind="forbidden" />;
  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="The sign-in record"
        kind="unavailable"
        reason={result.reason}
        detail="Zero failed sign-ins is a claim; it cannot be made while the record is unreadable."
      />
    );
  }

  const a = result.data;
  const choice = <WindowChoice base="/it/network" options={SIGN_IN_WINDOWS} current={win} />;

  if (a.state !== "on") {
    const words = signInsStateWords(a.state, a.reason);
    return (
      <>
        {choice}
        <Card title={words.title}>
          <div className="nw-banner nw-banner--warn" role="note" style={{ marginBottom: 0 }}>
            <span className="nw-banner__label">{a.state === "off" ? "Not recorded" : "Cannot be read"}</span>
            <span className="nw-banner__text">{words.body}</span>
          </div>
        </Card>
      </>
    );
  }

  const { summary, unknownAccounts } = a;
  // Newest first; the page does not rely on the order the server happened to send.
  const events = [...a.events].sort((x, y) => y.at.localeCompare(x.at));
  const shown = events.slice(0, SHOWN);

  return (
    <>
      {choice}

      <div className="nw-kpis">
        <KpiTile label="Sign-ins" value={String(summary.signIns)} foot={WINDOW_LABEL[win]} hint="Successful sign-ins of this company's people." />
        <KpiTile label="Failed" value={String(summary.failed)} foot={`${summary.failedByAccount.length} account${summary.failedByAccount.length === 1 ? "" : "s"}`} hint="Wrong passwords and refused sign-ins for this company's people." />
        <KpiTile
          label="Unknown accounts"
          value={String(unknownAccounts.failed)}
          foot="failed sign-ins"
          hint="Failed sign-ins using a username that matches nobody in the ERP. The usernames are not shown. A run of these is someone guessing."
        />
      </div>

      {summary.failed > 0 ? (
        <div className="nw-twocol">
          <Card title="Failed sign-ins by account" hint="The people whose accounts were tried and failed most often in this window.">
            {summary.failedByAccount.length === 0 ? (
              <EmptyNote>None of the failures were for a person in this company.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Account" }, { label: "Failed", align: "right" }]}
                tcols="2fr 0.6fr"
                rows={[...summary.failedByAccount].sort((x, y) => y.count - x.count).map((r) => [r.email ?? r.userId, String(r.count)])}
              />
            )}
          </Card>
          <Card title="Failed sign-ins by address" hint="Where the failures came from. One address with many failures is worth blocking from Blocks.">
            {summary.failedByIp.length === 0 ? (
              <EmptyNote>No address was recorded for the failures.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Address" }, { label: "Failed", align: "right" }]}
                tcols="2fr 0.6fr"
                rows={[...summary.failedByIp].sort((x, y) => y.count - x.count).map((r) => [
                  <span key="ip" className="nw-mono">{r.ip ?? "Unknown"}</span>, String(r.count),
                ])}
              />
            )}
          </Card>
        </div>
      ) : null}

      <div style={{ marginTop: 20 }}>
        <Card title="Sign-in events" hint="Newest first. Only people who belong to this company are listed.">
          {events.length === 0 ? (
            <EmptyNote>
              No sign-ins, failures or sign-outs in this window ({WINDOW_LABEL[win].toLowerCase()}), as of {formatTimestamp(a.asOf)}. The sign-in service is recording events, so this is a real zero.
            </EmptyNote>
          ) : (
            <>
              <HairlineTable
                columns={[{ label: "When" }, { label: "What" }, { label: "Account" }, { label: "Address" }, { label: "Detail" }]}
                tcols="1.2fr 0.8fr 1.6fr 1fr 1.4fr"
                rows={shown.map((e) => [
                  formatTimestamp(e.at),
                  <span key="t" className={`nw-chip nw-chip--${e.type}`}>{TYPE_LABEL[e.type]}</span>,
                  e.email ?? "—",
                  <span key="ip" className="nw-mono">{e.ip ?? "—"}</span>,
                  e.error ? e.error.replaceAll("_", " ") : "",
                ])}
              />
              {events.length > shown.length ? (
                <p className="nw-more">Showing the newest {shown.length} of {events.length} events.</p>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
