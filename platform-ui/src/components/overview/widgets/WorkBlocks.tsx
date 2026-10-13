import Link from "next/link";
import { formatDate } from "@/lib/format";
import {
  healthText, refusalText,
  type CampaignsView, type ProjectsView, type RequestsView,
} from "@/lib/overviewWork";

// DW-3f: the Work band's three blocks. Each is a pure view of its model: a refused or failed read says "No access"
// or "Unavailable" in the block's own place (never an empty list and never 0), and only a successful read may say
// "none". A block keeps its title and its own region, so one failing does not blank the others.

function Refusal({ title, kind }: { title: string; kind: "forbidden" | "unavailable" }) {
  return (
    <section className="ov-block ov-block--unavailable" aria-label={title} data-state={kind}>
      <h3 className="ov-block__title">{title}</h3>
      <p className="ov-block__note">{refusalText(kind)}</p>
    </section>
  );
}

const dateRange = (a: string | null, b: string | null): string | null =>
  a && b ? `${formatDate(a)} to ${formatDate(b)}` : a ? `From ${formatDate(a)}` : b ? `Until ${formatDate(b)}` : null;

export function ProjectsBlock({ view, href }: { view: ProjectsView; href: string | null }) {
  if (view.kind !== "ok") return <Refusal title="Projects" kind={view.kind} />;
  return (
    <section className="ov-block ov-work" aria-label="Projects" data-state={view.rows.length === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">Projects</h3>
      {view.rows.length === 0 ? (
        <p className="ov-block__note">No open projects.</p>
      ) : (
        <>
          <p className="ov-block__note">{view.total > view.rows.length ? `${view.rows.length} of ${view.total} open, most at risk first` : `${view.total} open`}</p>
          <ul className="ov-work__list">
            {view.rows.map((r) => (
              <li key={r.id} className="ov-work__item" data-project={r.id}>
                <Link href={`/projects/${r.id}`} className="ov-work__name">{r.name}</Link>
                <span className={`ov-work__health${r.health.kind === "ok" && r.health.atRisk ? " ov-work__health--risk" : ""}`}>{healthText(r.health)}</span>
                <span className="ov-work__meta">{r.nextDue ? `Next due ${formatDate(r.nextDue)}` : "No upcoming due date"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {href && <Link href={href} className="ov-nums__link">All projects</Link>}
    </section>
  );
}

export function CampaignsBlock({ view, href }: { view: CampaignsView; href: string | null }) {
  if (view.kind !== "ok") return <Refusal title="Campaigns" kind={view.kind} />;
  return (
    <section className="ov-block ov-work" aria-label="Campaigns" data-state={view.rows.length === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">Campaigns</h3>
      {view.rows.length === 0 ? (
        <p className="ov-block__note">No shared campaigns.</p>
      ) : (
        <>
          {view.total > view.rows.length && <p className="ov-block__note">{view.rows.length} of {view.total} shared campaigns</p>}
          <ul className="ov-work__list">
            {view.rows.map((r) => (
              <li key={r.id} className="ov-work__item" data-campaign={r.id}>
                <Link href={`/agency/${r.id}`} className="ov-work__name">{r.name}</Link>
                <span className="ov-work__health">Our part: {r.ourPart}</span>
                {dateRange(r.startsOn, r.endsOn) && <span className="ov-work__meta">{dateRange(r.startsOn, r.endsOn)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {href && <Link href={href} className="ov-nums__link">Shared campaigns</Link>}
    </section>
  );
}

export function RequestsBlock({ view, incomingHref, sentHref }: { view: RequestsView; incomingHref: string | null; sentHref: string | null }) {
  if (view.kind !== "ok") return <Refusal title="Requests" kind={view.kind} />;
  const tile = (key: string, label: string, value: number, href: string | null) => {
    const body = (
      <>
        <span className="ov-nums__label">{label}</span>
        <span className="ov-nums__value">{value}</span>
      </>
    );
    return (
      <li key={key} className="ov-pulse__item" data-tile={key}>
        {href ? <Link href={href} className="ov-pulse__tile">{body}</Link> : <div className="ov-pulse__tile">{body}</div>}
      </li>
    );
  };
  return (
    <section className="ov-block ov-work" aria-label="Requests" data-state="ok">
      <h3 className="ov-block__title">Requests</h3>
      <ul className="ov-pulse__tiles">
        {tile("incoming", "Waiting on us", view.incoming, incomingHref)}
        {tile("sent", "We are waiting on", view.sent, sentHref)}
      </ul>
      {view.incoming === 0
        ? <p className="ov-block__note">Nothing is waiting on this department.</p>
        : <p className="ov-block__note">{view.oldestAge ? `Oldest waiting: ${view.oldestAge}` : "Oldest waiting: age not known"}</p>}
    </section>
  );
}
