import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { refusalText } from "@/lib/overviewWork";
import { appraisalBreakdown } from "@/lib/overviewTeam";
import { countsText, type DepartmentsView } from "@/lib/overviewDepartments";
import {
  appraisalProgressText, partsText,
  type CompanyAppraisalsView, type CompanyCampaignsView, type CompanyLearningView, type CompanyModel, type DecisionsView,
} from "@/lib/overviewCompany";

// DW-3i: the company Overview's six blocks (plan §3.5). Each is a pure view of its model (`lib/overviewCompany.ts`,
// `lib/overviewDepartments.ts`): a refused or failed read says "No access" or "Unavailable" in the block's own place (never 0 and never
// "nothing is waiting"), and only a successful read may say "none". A block keeps its title and its own region, so one failing
// does not blank the others.

export const DECISIONS_TITLE = "Needs you: decisions";
export const COMPANY_TITLE = "Company";
export const DEPARTMENTS_TITLE = "Departments by condition";
export const CAMPAIGNS_TITLE = "Campaigns";
export const LEARNING_TITLE = "Learning compliance";
export const APPRAISAL_TITLE = "Appraisal cycle";

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

// ── Needs you: decisions ─────────────────────────────────────────────────────────────────────────

export function DecisionsBlock({ view }: { view: DecisionsView }) {
  if (view.kind !== "ok") return <Refusal title={DECISIONS_TITLE} kind="unavailable" />;
  const { total, stale, notYours, rows, incomplete } = view;
  return (
    <section className="ov-block ov-work" aria-label={DECISIONS_TITLE} data-state={total === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{DECISIONS_TITLE}</h3>
      {total === 0 ? (
        <p className="ov-block__note">
          {incomplete.length > 0 ? "Nothing found in the sources that could be read." : "Nothing is waiting on a decision."}
        </p>
      ) : (
        <>
          <p className="ov-block__note" data-part="count">
            {total} awaiting a decision{stale > 0 ? `, ${stale} waiting 5 days or more` : ""}{notYours > 0 ? `, ${notYours} not yours to decide` : ""}
          </p>
          <ul className="ov-work__list">
            {rows.map((r) => (
              <li key={r.id} className="ov-work__item" data-decision={r.id}>
                {r.href
                  ? <Link href={r.href} className="ov-work__name">{r.title}</Link>
                  : <span className="ov-work__name">{r.title}</span>}
                <span className="ov-work__meta">{[r.kind, r.context].filter(Boolean).join(" · ")}</span>
                <span className="ov-work__meta">{[r.waiting ? `Waiting ${r.waiting}` : null, r.decidable ? null : "Someone else must act"].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
          {total > rows.length && <p className="ov-block__note">{rows.length} of {total} shown, in rank order</p>}
        </>
      )}
      {incomplete.length > 0 && <p className="ov-block__note" role="note">This list is incomplete: {incomplete.join(", ")} could not be read.</p>}
      <Link href="/approvals" className="ov-nums__link">All approvals</Link>
    </section>
  );
}

// ── Company ──────────────────────────────────────────────────────────────────────────────────────

export function CompanyBlock({ model, reportHref, financeHref }: { model: CompanyModel; reportHref: string; financeHref: string }) {
  return (
    <section className="ov-block ov-nums" aria-label={COMPANY_TITLE} data-state="ok">
      <h3 className="ov-block__title">{COMPANY_TITLE}</h3>
      {(model.periodLabel || model.moneyWindow) && (
        <p className="ov-block__note">
          {[model.periodLabel, model.moneyWindow ? `Money: ${model.moneyWindow}` : null].filter(Boolean).join(" · ")}
        </p>
      )}
      {model.noBooks && (
        <p className="ov-block__note" data-state="no-books">
          No fiscal calendar yet, or the finance module is off, so there are no books to report revenue from. This is a setup state, not a zero.
        </p>
      )}
      {model.tiles.length > 0 && (
        <ul className="ov-nums__tiles">
          {model.tiles.map((t) => (
            <li key={t.key} className="ov-nums__tile" data-tile={t.key} data-state={t.state}>
              <span className="ov-nums__label">{t.label}</span>
              <span className={`ov-nums__value${t.state !== "ok" ? " ov-nums__value--none" : ""}`}>{t.value}</span>
              {t.detail && <span className="ov-nums__detail">{t.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {model.note && <p className="ov-block__note" role="note">{model.note}</p>}
      {model.links.report && <Link href={reportHref} className="ov-nums__link">Company report</Link>}
      {model.links.finance && <Link href={financeHref} className="ov-nums__link">Finance</Link>}
    </section>
  );
}

// ── Departments by condition ─────────────────────────────────────────────────────────────────────

export function DepartmentsBlock({ view }: { view: DepartmentsView }) {
  if (view.kind !== "ok") return <Refusal title={DEPARTMENTS_TITLE} kind={view.kind} />;
  const { rows, total, counts } = view;
  return (
    <section className="ov-block ov-work" aria-label={DEPARTMENTS_TITLE} data-state={total === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{DEPARTMENTS_TITLE}</h3>
      {total === 0 ? (
        <p className="ov-block__note">No department in the org structure.</p>
      ) : (
        <>
          <p className="ov-block__note" data-part="counts">{countsText(counts)}, worst first</p>
          <ul className="ov-work__list">
            {rows.map((r) => (
              <li key={r.id} className="ov-work__item" data-dept={r.id} data-condition={r.condition}>
                <Link href={r.href} className="ov-work__name">{r.name}</Link>
                <span className={`ov-work__health${r.condition === "off_track" || r.condition === "at_risk" ? " ov-work__health--risk" : ""}`}>{r.conditionText}</span>
                <span className="ov-work__meta">{r.detail}</span>
              </li>
            ))}
          </ul>
          {total > rows.length && <p className="ov-block__note">{rows.length} of {total} departments shown, worst first</p>}
        </>
      )}
    </section>
  );
}

// ── Campaigns across departments ─────────────────────────────────────────────────────────────────

export function CompanyCampaignsBlock({ view }: { view: CompanyCampaignsView }) {
  if (view.kind !== "ok") return <Refusal title={CAMPAIGNS_TITLE} kind={view.kind} />;
  return (
    <section className="ov-block ov-work" aria-label={CAMPAIGNS_TITLE} data-state={view.rows.length === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{CAMPAIGNS_TITLE}</h3>
      {view.rows.length === 0 ? (
        <p className="ov-block__note">No open campaigns.</p>
      ) : (
        <>
          <p className="ov-block__note">{view.total > view.rows.length ? `${view.rows.length} of ${view.total} open campaigns, soonest ending first` : `${view.total} open`}</p>
          <ul className="ov-work__list">
            {view.rows.map((r) => (
              <li key={r.id} className="ov-work__item" data-campaign={r.id}>
                <Link href={`/agency/${r.id}`} className="ov-work__name">{r.name}</Link>
                <span className="ov-work__health"><StatusBadge label={r.status} /> {partsText(r.parts)}</span>
                {dateRange(r.startsOn, r.endsOn) && <span className="ov-work__meta">{dateRange(r.startsOn, r.endsOn)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <Link href="/agency" className="ov-nums__link">All campaigns</Link>
    </section>
  );
}

// ── Growth ───────────────────────────────────────────────────────────────────────────────────────

export function CompanyLearningBlock({ view, href }: { view: CompanyLearningView; href: string }) {
  if (view.kind !== "ok") return <Refusal title={LEARNING_TITLE} kind={view.kind} />;
  const { assigned, completed, outstanding, overdue, coverage, paths, lowest } = view;
  return (
    <section className="ov-block ov-work" aria-label={LEARNING_TITLE} data-state={assigned === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{LEARNING_TITLE}</h3>
      {assigned === 0 || coverage === null ? (
        <p className="ov-block__note">No mandatory training is assigned.</p>
      ) : (
        <>
          <p className="ov-block__note" data-part="coverage">{coverage}% of mandatory training complete</p>
          <p className="ov-work__meta">{completed} of {assigned} assigned, across {paths} mandatory {paths === 1 ? "path" : "paths"}</p>
          {outstanding > 0 && <p className="ov-work__meta">{outstanding} outstanding</p>}
          {overdue > 0 && <p className="ov-work__health ov-work__health--risk" data-flag="overdue">{overdue} overdue</p>}
          {lowest && <p className="ov-work__meta" data-part="lowest">Lowest: {lowest.title}, {lowest.coverage}%</p>}
        </>
      )}
      <Link href={href} className="ov-nums__link">Learning compliance</Link>
    </section>
  );
}

export function CompanyAppraisalsBlock({ view, href }: { view: CompanyAppraisalsView; href: string }) {
  if (view.kind !== "ok") return <Refusal title={APPRAISAL_TITLE} kind={view.kind} />;
  const breakdown = appraisalBreakdown(view);
  return (
    <section className="ov-block ov-work" aria-label={APPRAISAL_TITLE} data-state={view.total === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">{APPRAISAL_TITLE}</h3>
      {view.total === 0 ? (
        <p className="ov-block__note">No appraisals yet.</p>
      ) : (
        <>
          <p className="ov-block__note" data-part="progress">{appraisalProgressText(view)}</p>
          <p className="ov-work__meta">Across {view.cycles} {view.cycles === 1 ? "cycle" : "cycles"}</p>
          {breakdown && <p className="ov-work__meta" data-part="breakdown">{breakdown}</p>}
        </>
      )}
      <Link href={href} className="ov-nums__link">All appraisals</Link>
    </section>
  );
}
