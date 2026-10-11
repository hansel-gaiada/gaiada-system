import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  clickIdLabel, consentBadge, EMPTY_LEADS_COPY, humanize, INTAKE_OFF_COPY, receivedAt, utmSummary,
  type WebLeadsBody,
} from "@/lib/websiteLeadsModel";
import "../content/content.css";
import "./leads.css";

/** Website -> Leads for one site. Read-only: each row opens the existing lead page, where the lead is worked.
 *  Click-id presence only ("gclid ✓"): the server never sends a value, and this component has none to show. */
export function LeadsView({ siteName, body }: { siteName: string; body: WebLeadsBody }) {
  const { leads } = body;
  return (
    <div className="wl-page" data-testid="website-leads">
      <p className="wc-lede">
        The enquiries {siteName}&apos;s forms have produced, newest first. Open one to work it in the pipeline. Ad click ids are shown only as present, never as the id itself.
      </p>

      {!body.leadIntakeEnabled ? (
        <div className="wc-notice" role="status" data-testid="leads-intake-off"><p>{INTAKE_OFF_COPY}</p></div>
      ) : null}

      {leads.length === 0 ? (
        <Card title="Leads"><EmptyNote>{EMPTY_LEADS_COPY}</EmptyNote></Card>
      ) : (
        <Card title={`Leads (${leads.length}${body.truncated ? "+" : ""})`}>
          <table className="wl-table">
            <thead>
              <tr><th>Lead</th><th>Form</th><th>Received</th><th>Pipeline</th><th>Where from</th><th>Consent</th></tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const a = l.attribution;
                const consent = consentBadge(l.marketingConsent);
                const utm = utmSummary(a);
                return (
                  <tr key={l.id} data-testid="web-lead-row">
                    <td>
                      <Link className="wl-name" href={`/agency/leads/${encodeURIComponent(l.id)}`}>{l.orgName}</Link>
                      {l.contactName && l.contactName !== l.orgName ? <div className="wc-muted">{l.contactName}</div> : null}
                    </td>
                    <td>{l.originForm ?? <span className="wc-muted">unknown</span>}</td>
                    <td className="wl-nowrap">{receivedAt(l.createdAt)}</td>
                    <td><span className="wc-chip">{humanize(l.stage)}</span> <span className="wc-muted">{humanize(l.status)}</span></td>
                    <td>
                      {a.landing ? <div>{a.landing}</div> : <div className="wc-muted">landing page unknown</div>}
                      {utm ? <div className="wc-muted">{utm}</div> : null}
                      {a.referrer ? <div className="wc-muted">from {a.referrer}</div> : null}
                      {a.clickIds.length > 0 ? (
                        <div className="wl-ids">{a.clickIds.map((c) => <span key={c} className="wc-chip wc-chip--info" data-testid="click-id">{clickIdLabel(c)}</span>)}</div>
                      ) : null}
                    </td>
                    <td><span className={`wc-chip${consent.tone === "ok" ? " wc-chip--ok" : consent.tone === "warn" ? " wc-chip--warn" : ""}`} data-testid="consent-badge">{consent.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {body.truncated ? <p className="wc-muted" data-testid="leads-truncated">Showing the newest {leads.length}. Older leads are in the Agency lead queue.</p> : null}
        </Card>
      )}
    </div>
  );
}
