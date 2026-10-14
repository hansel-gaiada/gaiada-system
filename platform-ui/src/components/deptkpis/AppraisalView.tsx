import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { conditionLabel, conditionTone, formatKpiValue, ratioParts, tileFoot } from "@/lib/deptKpiFormat";
import {
  TOO_FEW_NOTE, cycleAcceptsWrites, cycleRange, cycleStatusLabel, historyLabel, maxBandCount, monthShort, peopleHeadline, statusRows,
  type CyclePick, type DeptAppraisalView,
} from "@/lib/deptAppraisalFormat";
import { AssessmentForm, CommentaryForm } from "./AppraisalForms";
import "./deptKpis.css";
import "./deptAppraisal.css";

const day = (iso: string) => iso.slice(0, 10);

/**
 * The cycle picker (BFF §41.5): the company's cycles, newest first, as links that keep the department. `cycles` is null when the
 * cycle list is not the viewer's to read (a head or the company-wide tiers only), which is said, never shown as "no cycles".
 */
export function CyclePicker({
  unitId, cycles, chosenId, reason,
}: {
  unitId: string;
  cycles: CyclePick[] | null;
  chosenId: string | null;
  /** Why `cycles` is null: "forbidden" or an error sentence. */
  reason?: string;
}) {
  const here = (cycle: string | null) => `/appraisals/department?unit=${encodeURIComponent(unitId)}${cycle ? `&cycle=${encodeURIComponent(cycle)}` : ""}`;
  return (
    <nav className="da-picker" aria-label="Appraisal cycle">
      <span className="da-picker__label">Cycle</span>
      <ul className="da-picker__list">
        <li>
          <Link href={here(null)} className="da-picker__item" aria-current={chosenId === null ? "page" : undefined}>
            KPIs for a period
          </Link>
        </li>
        {cycles?.map((c) => (
          <li key={c.id}>
            <Link href={here(c.id)} className="da-picker__item" aria-current={chosenId === c.id ? "page" : undefined}>
              {c.name} <span className="da-picker__meta">{cycleStatusLabel(c.status)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {cycles === null && (
        <p className="da-picker__note">
          {reason === "forbidden"
            ? "The list of cycles is for department heads and the company-wide tiers."
            : `The list of cycles could not be read${reason ? `: ${reason}` : ""}. A cycle link still opens its department appraisal.`}
        </p>
      )}
      {cycles !== null && cycles.length === 0 && <p className="da-picker__note">There are no appraisal cycles yet.</p>}
    </nav>
  );
}

/**
 * The department appraisal for one cycle (BFF §41.1, §41.5): the §40 KPI results over the cycle, the history as a row of months,
 * the people block (counts, and the distribution or "too few to show"), the head's commentary and the GM's assessment. Every
 * number is the API's; this only words and lays them out. The two forms are offered only while the cycle accepts writes and only
 * to the people the UI capabilities reach (the server decides again).
 */
export function AppraisalView({ view, canComment, canAssess }: { view: DeptAppraisalView; canComment: boolean; canAssess: boolean }) {
  const { cycle, people, hodCommentary: hod, gmAssessment: gm } = view;
  const open = cycleAcceptsWrites(cycle.status);
  const tone = conditionTone(view.condition);
  return (
    <>
      <section className={`dk-banner dk-banner--${tone}`} aria-label="Department condition over the cycle">
        <span className={`dk-badge dk-badge--${tone}`}>{conditionLabel(view.condition)}</span>
        <span>
          {view.unit.name} over {cycle.name} ({cycleRange(cycle.periodStart, cycle.periodEnd)}). {cycleStatusLabel(cycle.status)}.
        </span>
      </section>
      {!open && (
        <p className="da-note" role="note">
          This cycle is closed. The department appraisal below is the record, and neither the commentary nor the assessment can change.
        </p>
      )}

      <h3 className="da-heading">KPI results</h3>
      <p className="da-note">Each result is judged against the target in force for the cycle&apos;s last month.</p>
      {view.kpis.length === 0 ? (
        <EmptyNote>This department has no KPIs defined yet.</EmptyNote>
      ) : (
        <ul className="dk-tiles" aria-label="KPI results over the cycle" style={{ listStyle: "none", padding: 0 }}>
          {view.kpis.map((k) => {
            const kt = conditionTone(k.condition);
            const parts = ratioParts(k);
            return (
              <li key={k.key} className={`dk-tile dk-tile--${kt}`}>
                <span className="dk-tile__label">{k.label}</span>
                <span className="dk-tile__value">{formatKpiValue(k.value, k.unit)}</span>
                <span className={`dk-badge dk-badge--${kt}`}>{conditionLabel(k.condition)}</span>
                <span className="dk-tile__foot">{tileFoot(k)}</span>
                {parts && <span className="dk-tile__foot">{parts}</span>}
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="da-heading">Condition, month by month</h3>
      {view.history.length === 0 ? (
        <EmptyNote>This cycle covers no whole month.</EmptyNote>
      ) : (
        <ol className="da-history" aria-label="Condition history">
          {view.history.map((h) => {
            const ht = conditionTone(h.condition);
            return (
              <li key={h.month} className={`da-month da-month--${ht}`} aria-label={historyLabel(h, conditionLabel)}>
                <span className="da-month__name">{monthShort(h.month)}</span>
                <span className={`dk-badge dk-badge--${ht}`}>{conditionLabel(h.condition)}</span>
              </li>
            );
          })}
        </ol>
      )}

      <Card
        title="The people's appraisals"
        hint="Only counts. The people of this department whose appraisal is in this cycle, as the roster stands today. No names, no individual scores and no commentary are shown here."
      >
        <p className="da-people__headline">{peopleHeadline(people)}</p>
        {people.total > 0 && (
          <ul className="da-status" aria-label="Appraisals by status">
            {statusRows(people).map((s) => (
              <li key={s.status}>
                <span className="da-status__label">{s.label}</span> <span className="da-status__count">{s.count}</span>
              </li>
            ))}
          </ul>
        )}
        {people.distribution === null ? (
          <p className="da-note">{TOO_FEW_NOTE}</p>
        ) : (
          <ul className="da-bands" aria-label="Distribution of composite scores by band">
            {people.distribution.map((b) => (
              <li key={b.band} className="da-band">
                <span className="da-band__label">Band {b.band}</span>
                <span className="da-band__bar" aria-hidden="true">
                  <span className="da-band__fill" style={{ width: `${Math.round((b.count / maxBandCount(people.distribution!)) * 100)}%` }} />
                </span>
                <span className="da-band__count">{b.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Head's commentary">
        {hod ? (
          <>
            <p className="da-text">{hod.text}</p>
            <p className="da-by">By {hod.byName || hod.by} on {day(hod.at)}</p>
          </>
        ) : (
          <EmptyNote>{open ? "No commentary written yet." : "No commentary was written for this cycle."}</EmptyNote>
        )}
        {open && canComment && <CommentaryForm cycleId={cycle.id} unitId={view.unit.id} current={hod} />}
      </Card>

      <Card title="GM's assessment" hint="The GM's own judgement of the department's condition. It is shown beside the computed condition and never replaces it.">
        {gm ? (
          <>
            <p className="da-judgement">
              <span>Computed: </span>
              <span className={`dk-badge dk-badge--${tone}`}>{conditionLabel(view.condition)}</span>
              <span className="da-judgement__sep"> · GM&apos;s judgement: </span>
              <span className={`dk-badge dk-badge--${conditionTone(gm.condition)}`}>{conditionLabel(gm.condition)}</span>
            </p>
            <p className="da-text">{gm.text}</p>
            <p className="da-by">By {gm.byName || gm.by} on {day(gm.at)}</p>
          </>
        ) : (
          <EmptyNote>{open ? "No assessment written yet." : "No assessment was written for this cycle."}</EmptyNote>
        )}
        {open && canAssess && <AssessmentForm cycleId={cycle.id} unitId={view.unit.id} current={gm} />}
      </Card>
    </>
  );
}
