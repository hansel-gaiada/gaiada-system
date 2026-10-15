import Link from "next/link";
import { portalResultsHeadline, sectionHref, type BusinessResults } from "@/lib/clientCentre";
import { COULD_NOT_BE_LOADED } from "@/lib/clientHealth";
import { NOT_MEASURED, formatKpiValue } from "@/components/client-centre/ServiceCard";
import { RESULTS_HIDDEN_COPY, RESULTS_UNAVAILABLE_COPY } from "@/components/client-centre/ResultsView";
import { PortalFigure, PortalLink } from "@/components/portal/PortalBits";

// PV7-03 — the results headline on the portal Overview: up to four figures from the portal's EXISTING results read
// (`GET :t/portal/centre/:clientId/results`, BFF §25), the first KPI of each active service. The full figures, their
// periods and their targets stay on Business › Services & results; money-like figures never come here (PV-D38).
//
// Three states besides the figures, each in words:
//   - `results === null`  the read failed: "Could not be loaded", never "no results".
//   - `visible === false` a contact limited to some projects (PV-D37): the SAME sentence the Business page shows.
//   - no active service   "No service is running yet", said only when nothing failed to load either.

export const NO_RESULTS_YET = "No service with results is running yet.";
/** The one link to the full page. Business opens on the contact's selected client. */
export const SERVICES_AND_RESULTS_HREF = sectionHref("/portal/company", { kind: "home" });

export interface ResultsHeadlineSection { clientId: string; name: string; results: BusinessResults | null }

function Section({ s, multi }: { s: ResultsHeadlineSection; multi: boolean }) {
  const r = s.results;
  let body: React.ReactNode;
  if (r === null) {
    body = <p className="cp-results__unknown" role="status">Results: {COULD_NOT_BE_LOADED}</p>;
  } else if (!r.visible) {
    body = <p className="cp-results__unknown">{RESULTS_HIDDEN_COPY}</p>;
  } else {
    const items = portalResultsHeadline(r);
    const failed = r.unavailable.length > 0;
    body = (
      <>
        {items.length > 0 && (
          <div className="cp-results__grid">
            {items.map((it) => (
              <PortalFigure
                key={`${it.service}-${it.areaId}-${it.kpi.key}`}
                label={it.kpi.label}
                value={it.kpi.value === null ? <span className="cp-results__unknown">{NOT_MEASURED}</span> : formatKpiValue(it.kpi.value, it.kpi.unit)}
                foot={it.cardTitle}
              />
            ))}
          </div>
        )}
        {items.length === 0 && !failed && <p className="cp-results__unknown">{NO_RESULTS_YET}</p>}
        {failed && <p className="cp-results__unknown" role="status">{RESULTS_UNAVAILABLE_COPY}</p>}
      </>
    );
  }
  return (
    <section data-client={s.clientId} aria-label={multi ? `${s.name} results` : undefined}>
      {multi && <h4 className="cp-health__client">{s.name}</h4>}
      {body}
    </section>
  );
}

/** The body of the "Results at a glance" card: one section per client, with a heading only when there are several. */
export function PortalResultsHeadline({ sections }: { sections: ResultsHeadlineSection[] }) {
  const multi = sections.length > 1;
  return (
    <div className="cp-results">
      {sections.map((s) => <Section key={s.clientId} s={s} multi={multi} />)}
      <div>
        <PortalLink href={SERVICES_AND_RESULTS_HREF}>Services &amp; results</PortalLink>
      </div>
    </div>
  );
}
