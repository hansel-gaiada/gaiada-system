import Link from "next/link";
import { COULD_NOT_BE_LOADED, isFinishedProjectStatus, turnaroundSentence } from "@/lib/clientHealth";
import {
  ballHeadline, ballItemHref, ballItemLabel, portalDate, relativeDays,
  type PortalBall, type PortalBallSide, type PortalHealth, type PortalHealthClient, type PortalHealthProject,
} from "@/lib/portal";
import { EmptyNote } from "@/components/systems/EmptyNote";

// PV7-03 — "Project health" on the portal Overview (BFF §54.5), one section per client the caller reaches.
//
// FACTS ONLY. The payload has no health state, so none is drawn: no "on track", no "at risk", no colour-coded verdict
// (L3). Every number is one the client can already see elsewhere in the portal (L1). A section the server could not read
// (`null`, or named in `unavailable[]`) says "Could not be loaded": an empty list is a claim, and a failed read must never
// make a project look idle or fine.
//
// `now` is passed in and never read from the clock here: a component that reads `new Date()` renders one value on the
// server and another in the browser (hydration).

/** The sources a section depends on. A section whose source is in `unavailable[]` is treated as failed even if the
 *  payload still carries it: the server named the read as failed, so its data cannot be trusted as complete. */
function sectionDown(health: PortalHealth) {
  const down = new Set<string>(health.unavailable);
  return { projects: down.has("projects"), ball: down.has("ball"), turnaround: down.has("turnaround") };
}
type Down = ReturnType<typeof sectionDown>;

function BallBlock({ side, ball }: { side: PortalBallSide; ball: PortalBall | null }) {
  const who = side === "you" ? "Waiting on you" : "Waiting on us";
  if (ball === null) {
    return (
      <div className="cp-ball" data-side={side}>
        <div className="cp-ball__head" role="status">{who}: {COULD_NOT_BE_LOADED}</div>
      </div>
    );
  }
  return (
    <div className="cp-ball" data-side={side}>
      <div className="cp-ball__head">{ballHeadline(side, ball)}</div>
      {ball.items.length > 0 && (
        <ul className="cp-ball__items">
          {ball.items.map((it) => {
            const href = ballItemHref(it.kind, it.id);
            const label = ballItemLabel(it.kind, side);
            return (
              <li key={`${it.kind}-${it.id}`}>
                {href ? <Link href={href}>{label}</Link> : <span>{label}</span>}
                {it.context && ` · ${it.context}`}
                {it.since && ` · since ${portalDate(it.since)}`}
              </li>
            );
          })}
        </ul>
      )}
      {ball.count > ball.items.length && (
        <p className="cp-ball__more">Showing the oldest {ball.items.length} of {ball.count}.</p>
      )}
    </div>
  );
}

function ProjectBlock({ p, ballDown, now, level }: { p: PortalHealthProject; ballDown: boolean; now: Date; level: "h4" | "h5" }) {
  const H = level;
  const m = p.milestones;
  const d = p.deliverables;
  return (
    <div className="cp-hproj" data-project={p.projectId}>
      <H className="cp-hproj__name"><Link href={`/portal/projects/${p.projectId}`}>{p.name}</Link></H>
      <dl className="cp-hfacts">
        <div>
          <dt>Milestones</dt>
          <dd>
            {m.done} done · {m.upcoming} coming up ·{" "}
            <span className={m.late > 0 ? "cp-hfacts__late" : undefined}>{m.late} late</span>
            {m.undated > 0 && ` · ${m.undated} undated`}
          </dd>
        </div>
        <div>
          <dt>Deliverables</dt>
          <dd>
            {d.delivered} of {d.total} delivered ·{" "}
            <span className={d.late > 0 ? "cp-hfacts__late" : undefined}>{d.late} late</span>
          </dd>
        </div>
        <div>
          <dt>Next milestone</dt>
          <dd>
            {p.nextMilestone
              ? <>{p.nextMilestone.name} · {portalDate(p.nextMilestone.dueDate)} ({relativeDays(p.nextMilestone.dueDate, now)})</>
              : "No dated milestones ahead."}
          </dd>
        </div>
      </dl>
      <div className="cp-hballs">
        <BallBlock side="you" ball={ballDown ? null : p.waitingOnYou} />
        <BallBlock side="us" ball={ballDown ? null : p.waitingOnUs} />
      </div>
    </div>
  );
}

function ClientSection({ c, multi, down, now }: { c: PortalHealthClient; multi: boolean; down: Down; now: Date }) {
  const projects = down.projects ? null : c.projects;
  const active = projects ? projects.filter((p) => !isFinishedProjectStatus(p.status)) : null;
  const finished = projects && active ? projects.length - active.length : 0;
  const level = multi ? "h5" : "h4";
  const t = down.turnaround ? null : c.turnaround;
  return (
    <section className="cp-health__section" data-client={c.clientId} aria-label={multi ? c.name : undefined}>
      {multi && <h4 className="cp-health__client">{c.name}</h4>}
      {active === null ? (
        <p className="cp-health__note" role="status">Projects: {COULD_NOT_BE_LOADED}</p>
      ) : active.length === 0 ? (
        <EmptyNote>No active projects right now.</EmptyNote>
      ) : (
        <div className="cp-health__projects">
          {active.map((p) => <ProjectBlock key={p.projectId} p={p} ballDown={down.ball} now={now} level={level} />)}
        </div>
      )}
      {finished > 0 && (
        <p className="cp-health__note" style={{ marginTop: 10 }}>
          {finished} finished {finished === 1 ? "project is" : "projects are"} under <Link href="/portal/projects">Projects</Link>.
        </p>
      )}
      {c.clientWide && (
        <div style={{ marginTop: 14 }} data-scope="client-wide">
          <h5 className="cp-health__sub">Across your whole account</h5>
          <div className="cp-hballs">
            <BallBlock side="you" ball={down.ball ? null : c.clientWide.waitingOnYou} />
            <BallBlock side="us" ball={down.ball ? null : c.clientWide.waitingOnUs} />
          </div>
        </div>
      )}
      <p className="cp-health__note" style={{ marginTop: 14 }} data-part="turnaround">
        {t === null
          ? <>Reply times: {COULD_NOT_BE_LOADED}</>
          : <>{turnaroundSentence("You", t.client)} · {turnaroundSentence("We", t.ours)} (last {t.windowDays} days)</>}
      </p>
    </section>
  );
}

/** The body of the "Project health" card. `health === null` is a failed read. */
export function PortalHealthBlock({ health, now }: { health: PortalHealth | null; now: Date }) {
  if (health === null) return <p className="cp-health__note" role="status">Project health: {COULD_NOT_BE_LOADED}</p>;
  if (health.clients.length === 0) return <EmptyNote>No projects to show yet.</EmptyNote>;
  const down = sectionDown(health);
  const multi = health.clients.length > 1;
  return (
    <div className="cp-health">
      {health.clients.map((c) => <ClientSection key={c.clientId} c={c} multi={multi} down={down} now={now} />)}
    </div>
  );
}
