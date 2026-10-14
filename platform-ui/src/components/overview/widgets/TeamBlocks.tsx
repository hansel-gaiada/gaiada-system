import Link from "next/link";
import { refusalText, type RequestsView } from "@/lib/overviewWork";
import { appraisalBreakdown, type BlockersView, type TeamAppraisalsView, type TeamLearningView, type TeamNumbersView } from "@/lib/overviewTeam";

// DW-3h: the four blocks a head sees in Team mode. Each is a pure view of its model (`lib/overviewTeam.ts`): a refused or
// failed read says "No access" or "Unavailable" in the block's own place (never 0 and never "nothing waiting"), and only a
// successful read may say "none". A block keeps its title and its own region, so one failing does not blank the others.

function Refusal({ title, kind }: { title: string; kind: "forbidden" | "unavailable" }) {
  return (
    <section className="ov-block ov-block--unavailable" aria-label={title} data-state={kind} data-view="team">
      <h3 className="ov-block__title">{title}</h3>
      <p className="ov-block__note">{refusalText(kind)}</p>
    </section>
  );
}

export const TEAM_NUMBERS_TITLE = "Team numbers";
export const TEAM_NEEDS_YOU_TITLE = "Team needs you";
export const TEAM_LEARNING_TITLE = "Team learning";
export const TEAM_APPRAISALS_TITLE = "Team appraisals";

export function TeamNumbersBlock({ view, reportHref }: { view: TeamNumbersView; reportHref: string }) {
  if (view.kind !== "ok") return <Refusal title={TEAM_NUMBERS_TITLE} kind={view.kind} />;
  return (
    <section className="ov-block ov-nums" aria-label={TEAM_NUMBERS_TITLE} data-state="ok" data-view="team">
      <h3 className="ov-block__title">{TEAM_NUMBERS_TITLE}</h3>
      {view.periodLabel && <p className="ov-block__note">{view.periodLabel}</p>}

      <ul className="ov-nums__tiles">
        {view.tiles.map((t) => (
          <li key={t.key} className="ov-nums__tile" data-tile={t.key} data-state={t.state}>
            <span className="ov-nums__label">{t.label}</span>
            <span className={`ov-nums__value${t.state !== "ok" ? " ov-nums__value--none" : ""}`}>{t.value}</span>
            {t.detail && <span className="ov-nums__detail">{t.detail}</span>}
          </li>
        ))}
      </ul>

      {view.note && <p className="ov-block__note" role="note">{view.note}</p>}

      <Link href={reportHref} className="ov-nums__link">Open the team report</Link>
    </section>
  );
}

export function TeamNeedsYouBlock({ requests, blockers, deptName, incomingHref, projectsHref }: {
  requests: RequestsView;
  blockers: BlockersView;
  deptName: string;
  /** The Incoming tab of the workspace's Requests row, where it has one. */
  incomingHref: string | null;
  projectsHref: string | null;
}) {
  return (
    <section className="ov-block ov-work" aria-label={TEAM_NEEDS_YOU_TITLE} data-view="team">
      <h3 className="ov-block__title">{TEAM_NEEDS_YOU_TITLE}</h3>

      <div data-part="requests">
        <p className="ov-work__meta">Waiting on {deptName}</p>
        {requests.kind !== "ok" ? (
          <p className="ov-block__note" data-state={requests.kind}>{refusalText(requests.kind)}</p>
        ) : requests.incoming === 0 ? (
          <p className="ov-block__note" data-state="empty">No request is waiting.</p>
        ) : (
          <p className="ov-work__health" data-state="ok">
            {requests.incoming} {requests.incoming === 1 ? "request" : "requests"} waiting
            {requests.oldestAge ? `, the oldest ${requests.oldestAge}` : ""}
          </p>
        )}
        {incomingHref && requests.kind === "ok" && requests.incoming > 0 && <Link href={incomingHref} className="ov-nums__link">Open incoming requests</Link>}
      </div>

      <div data-part="blockers">
        <p className="ov-work__meta">Blocked in its projects</p>
        {blockers.kind !== "ok" ? (
          <p className="ov-block__note" data-state={blockers.kind}>{refusalText(blockers.kind)}</p>
        ) : (
          <>
            {blockers.open === 0 ? (
              <p className="ov-block__note" data-state="empty">No open projects.</p>
            ) : blockers.total === 0 && blockers.unread === 0 ? (
              <p className="ov-block__note" data-state="empty">No blocked tasks.</p>
            ) : blockers.total === 0 ? (
              <p className="ov-block__note" data-state="partial">No blocked tasks in the projects that could be read.</p>
            ) : (
              <p className="ov-work__health ov-work__health--risk" data-state="ok">
                {blockers.total} blocked {blockers.total === 1 ? "task" : "tasks"}
              </p>
            )}
            {blockers.projects.length > 0 && (
              <ul className="ov-work__list">
                {blockers.projects.map((p) => (
                  <li key={p.id} className="ov-work__item" data-project={p.id}>
                    <Link href={`/projects/${p.id}`} className="ov-work__name">{p.name}</Link>
                    <span className="ov-work__meta">{p.blocked} blocked</span>
                  </li>
                ))}
              </ul>
            )}
            {blockers.unread > 0 && (
              <p className="ov-block__note">{blockers.unread} {blockers.unread === 1 ? "project" : "projects"} could not be read, so this may be more.</p>
            )}
            {projectsHref && <Link href={projectsHref} className="ov-nums__link">Open projects</Link>}
          </>
        )}
      </div>
    </section>
  );
}

export function TeamLearningBlock({ view, href, deptName }: { view: TeamLearningView; href: string; deptName: string }) {
  if (view.kind !== "ok") return <Refusal title={TEAM_LEARNING_TITLE} kind={view.kind} />;
  return (
    <section className="ov-block ov-work" aria-label={TEAM_LEARNING_TITLE} data-state={view.learners === 0 ? "empty" : "ok"} data-view="team">
      <h3 className="ov-block__title">{TEAM_LEARNING_TITLE}</h3>
      {view.learners === 0 ? (
        // The roster size is the server's own claim: with nobody placed, every count is zero and means nothing.
        <p className="ov-block__note">No one is placed in {deptName} today, so there is no progress to show.</p>
      ) : view.coverage === null ? (
        <p className="ov-block__note">No required training is assigned to {view.learners} {view.learners === 1 ? "person" : "people"}.</p>
      ) : (
        <>
          <p className="ov-nums__value" data-part="coverage">{view.coverage}% complete</p>
          <p className="ov-block__note">
            {view.completed} of {view.assigned} required assignments, {view.learners} {view.learners === 1 ? "person" : "people"}
          </p>
          <p className="ov-work__meta">{view.outstanding} outstanding</p>
          {view.overdue > 0 && <p className="ov-work__health ov-work__health--risk" data-flag="overdue">{view.overdue} overdue</p>}
        </>
      )}
      <Link href={href} className="ov-nums__link">Team progress</Link>
    </section>
  );
}

export function TeamAppraisalsBlock({ view, href }: { view: TeamAppraisalsView; href: string }) {
  if (view.kind !== "ok") return <Refusal title={TEAM_APPRAISALS_TITLE} kind={view.kind} />;
  const rest = appraisalBreakdown(view);
  return (
    <section className="ov-block ov-work" aria-label={TEAM_APPRAISALS_TITLE} data-state={view.total === 0 ? "empty" : "ok"} data-view="team">
      <h3 className="ov-block__title">{TEAM_APPRAISALS_TITLE}</h3>
      {view.total === 0 ? (
        <p className="ov-block__note">No appraisals yet.</p>
      ) : (
        <>
          <p className="ov-nums__value" data-part="finalized">{view.finalized} of {view.total} finalized</p>
          {rest && <p className="ov-block__note" data-part="breakdown">{rest}</p>}
          <p className="ov-work__meta">
            Across {view.cycles} {view.cycles === 1 ? "cycle" : "cycles"}, the people you lead and score
          </p>
        </>
      )}
      <Link href={href} className="ov-nums__link">Team appraisals</Link>
    </section>
  );
}
