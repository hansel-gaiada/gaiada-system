import Link from "next/link";
import { kpiChange, targetMet, type ResultsKpi, type ResultsServiceCard } from "@/lib/clientCentre";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";

// PV6-03 — one service the business runs: title, status and "since", its items, and each KPI with its period,
// the change against the previous period and its target. THE RULE: a `null` figure reads "Not measured yet",
// never 0 (the backend's rule, types.ts in PV6-02). The change direction is always words, never colour alone.

const STATUS_LABEL: Record<ResultsServiceCard["status"], string> = {
  active: "Active",
  paused: "Paused",
  setting_up: "Setting up",
  ended: "Ended",
};

export const NOT_MEASURED = "Not measured yet";
export const NOT_ENOUGH_DATA = "Not enough data to compare";

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Pure formatter for a measured figure. Callers pass a non-null number; null is handled before this. */
export function formatKpiValue(value: number, unit: ResultsKpi["unit"]): string {
  switch (unit) {
    case "percent": return `${trim(value)}%`;
    case "ratio": return trim(value);
    case "position": return trim(value);
    default: return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

/** A change between two periods. For a percentage it is a difference in percentage POINTS (uptime 99.5% → 100% is
 *  "up 0.5 points", not "up 0.5%", which would read as a relative change). */
export function formatKpiDelta(delta: number, unit: ResultsKpi["unit"]): string {
  if (unit === "percent") return `${trim(delta)} ${delta === 1 ? "point" : "points"}`;
  return formatKpiValue(delta, unit);
}

function KpiRow({ k }: { k: ResultsKpi }) {
  const change = kpiChange(k);
  const met = targetMet(k);
  return (
    <div className="cc-kpi" data-kpi={k.key}>
      <dt className="cc-kpi__label">{k.label}</dt>
      <dd className="cc-kpi__body">
        {k.value === null ? (
          <span className="cc-kpi__value cc-kpi__value--unknown">{NOT_MEASURED}</span>
        ) : (
          <span className="cc-kpi__value">{formatKpiValue(k.value, k.unit)}</span>
        )}
        {k.period && <span className="cc-kpi__meta">{k.period.from} to {k.period.to}</span>}
        {k.value !== null && (
          <span className="cc-kpi__meta cc-kpi__change" data-direction={change.direction}>
            {change.direction === "none" && NOT_ENOUGH_DATA}
            {change.direction === "up" && `Up ${formatKpiDelta(change.delta, k.unit)} on the previous period`}
            {change.direction === "down" && `Down ${formatKpiDelta(Math.abs(change.delta), k.unit)} on the previous period`}
            {change.direction === "flat" && "No change on the previous period"}
          </span>
        )}
        {k.target !== null && (
          <span className="cc-kpi__meta cc-kpi__target">
            Target {formatKpiValue(k.target, k.unit)}
            {met === true && " · target met"}
            {met === false && " · target missed"}
          </span>
        )}
      </dd>
    </div>
  );
}

export function ServiceCard({
  card,
  showClientMarker,
  websiteHref,
  headingLevel = 3,
}: {
  card: ResultsServiceCard;
  /** Staff only: the "Client sees this" marker (PV3-09), driven by the card's `clientVisible`. */
  showClientMarker: boolean;
  /** Set only for a portal viewer who edits this client's website: the card then links to the Website tab. */
  websiteHref?: string | null;
  headingLevel?: 3 | 4;
}) {
  const H = `h${headingLevel}` as "h3" | "h4";
  return (
    <article className="cc-service" data-service={card.service} aria-label={card.title}>
      <header className="cc-service__head">
        <H className="cc-service__title">{card.title}</H>
        <span className="cc-service__status" data-status={card.status}>{STATUS_LABEL[card.status]}</span>
        {card.since && <span className="cc-service__since">Since {card.since}</span>}
        {showClientMarker && <ClientVisibilityMarker clientVisible={card.clientVisible} />}
      </header>
      {card.items.length > 0 && (
        <ul className="cc-service__items">
          {card.items.map((it, i) => (
            <li key={`${it.label}-${i}`}>
              <b>{it.label}</b>
              {it.detail && <span> · {it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {card.kpis.length > 0 && (
        <dl className="cc-service__kpis">
          {card.kpis.map((k) => <KpiRow key={k.key} k={k} />)}
        </dl>
      )}
      {card.service === "website" && websiteHref && (
        <p className="cc-service__link"><Link href={websiteHref}>Open the Website tab</Link></p>
      )}
    </article>
  );
}
