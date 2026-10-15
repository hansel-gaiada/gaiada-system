import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { canManageIT } from "@/components/shell/nav";
import { listAlertsResult } from "@/lib/itSecurity";
import { ALERT_RULES, CONNECTION_WINDOWS, SEVERITY_LABEL, WINDOW_LABEL, alertLabel, countBySeverity, parseWindow, signInsStateWords } from "@/lib/itSecurityView";
import { formatTimestamp } from "@/lib/format";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { WindowChoice } from "@/components/it/WindowChoice";
import "@/components/it/network.css";

export const metadata = { title: "Alerts" };
export const dynamic = "force-dynamic";

// DW-7h (BFF §52.6): alerts computed on read from the sign-in events and the connections the ERP recorded. Nothing is stored,
// so there is nothing to acknowledge or close: an alert is on this page while its rule still holds inside the window.
//
// ⚠ AN EMPTY LIST IS ONLY AN ALL-CLEAR WHEN EVERY RULE RAN. When the sign-in service records nothing (`off`) or cannot be read
// (`unavailable`) the two failed-sign-in rules cannot run, the answer says so in `signIns`, and this page says it in a bar above
// the list and words the empty state as "the rules that ran found nothing", never as "no alerts".
type SearchParams = Promise<{ window?: string | string[] }>;

export default async function NetworkAlertsPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  if (!canManageIT(me, tenant)) {
    return <ReadRefusal subject="security alerts for this company" kind="forbidden" detail="IT managers and company admins can see them." />;
  }

  const win = parseWindow((await searchParams).window, CONNECTION_WINDOWS, "24h");
  const result = await listAlertsResult(userId, tenant, win);
  if (result.kind === "forbidden") return <ReadRefusal subject="security alerts for this company" kind="forbidden" />;
  if (result.kind === "unavailable") {
    return (
      <ReadRefusal
        subject="Security alerts"
        kind="unavailable"
        reason={result.reason}
        detail="An empty list would say nothing is wrong; that cannot be said while the alerts are unreadable."
      />
    );
  }

  const { asOf, signIns, alerts, reason } = result.data;
  const rows = [...alerts].sort((a, b) => b.at.localeCompare(a.at));
  const n = countBySeverity(rows);
  const partial = signIns !== "on";
  const words = partial ? signInsStateWords(signIns, reason) : null;

  return (
    <>
      <WindowChoice base="/it/network/threats" options={CONNECTION_WINDOWS} current={win} />

      {partial && words ? (
        <div className="nw-banner nw-banner--warn" role="note">
          <span className="nw-banner__label">{signIns === "off" ? "Sign-ins not recorded" : "Sign-ins cannot be read"}</span>
          <span className="nw-banner__text">
            The two failed-sign-in rules cannot run, so the alerts below come only from the rules that can (new devices and blocked addresses). {words.body}
          </span>
        </div>
      ) : null}

      <div className="nw-kpis">
        <KpiTile label="High" value={String(n.high)} foot={WINDOW_LABEL[win]} hint="Repeated failed sign-ins on one account or from one address." />
        <KpiTile label="Medium" value={String(n.medium)} foot="new devices" hint="A person connecting from an address and device we have not seen them use." />
        <KpiTile label="Low" value={String(n.low)} foot="blocked addresses" hint="A blocked address that kept trying." />
      </div>

      <Card title="Alerts" hint="Newest first. Computed when you open the page from what the ERP recorded in the window.">
        {rows.length === 0 ? (
          <EmptyNote>
            {partial
              ? `The rules that could run found nothing in this window (${WINDOW_LABEL[win].toLowerCase()}), as of ${formatTimestamp(asOf)}. The failed sign-in rules are not running, so this is not an all-clear.`
              : `No alerts in this window (${WINDOW_LABEL[win].toLowerCase()}), as of ${formatTimestamp(asOf)}. Every rule ran.`}
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Severity" }, { label: "Alert" }, { label: "Who and where" }, { label: "When" }, { label: "Times", align: "right" }]}
            tcols="0.7fr 2.4fr 1.6fr 1fr 0.6fr"
            rows={rows.map((a) => [
              <span key="s" className={`nw-chip nw-chip--${a.severity}`}>{SEVERITY_LABEL[a.severity]}</span>,
              <span key="a" className="nw-who">
                <span className="nw-who__name">{alertLabel(a.kind)}</span>
                <span className="nw-who__sub">{a.detail}</span>
              </span>,
              <span key="w" className="nw-who">
                {a.subject.email ? <span className="nw-who__name">{a.subject.email}</span> : null}
                {a.subject.ip ? <span className="nw-mono">{a.subject.ip}</span> : null}
                {!a.subject.email && !a.subject.ip ? "—" : null}
              </span>,
              formatTimestamp(a.at),
              String(a.count),
            ])}
          />
        )}
      </Card>

      <div style={{ marginTop: 20 }}>
        <Card title="What each alert means">
          <ul className="nw-rules">
            {(Object.keys(ALERT_RULES) as (keyof typeof ALERT_RULES)[]).map((k) => (
              <li key={k} className="nw-rules__item">
                <strong>{ALERT_RULES[k].label}.</strong> {ALERT_RULES[k].meaning}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
