import Link from "next/link";
import { formatDate } from "@/lib/format";
import { refusalText } from "@/lib/overviewWork";
import { APPRAISAL_HREF, LEARNING_HREF, type AppraisalView, type LearningView } from "@/lib/overviewGrowth";

// DW-3g: the Growth band's two blocks. Each is a pure view of its model: a refused or failed read says "No access" or
// "Unavailable" in the block's own place (never 0 and never "nothing assigned"), and only a successful read may say "none".

function Refusal({ title, kind }: { title: string; kind: "forbidden" | "unavailable" }) {
  return (
    <section className="ov-block ov-block--unavailable" aria-label={title} data-state={kind}>
      <h3 className="ov-block__title">{title}</h3>
      <p className="ov-block__note">{refusalText(kind)}</p>
    </section>
  );
}

export function LearningBlock({ view }: { view: LearningView }) {
  if (view.kind !== "ok") return <Refusal title="Learning" kind={view.kind} />;
  const { outstanding, inProgress, overdue, nextDue } = view;
  return (
    <section className="ov-block ov-work" aria-label="Learning" data-state={outstanding === 0 ? "empty" : "ok"}>
      <h3 className="ov-block__title">Learning</h3>
      {outstanding === 0 ? (
        <p className="ov-block__note">Nothing outstanding.</p>
      ) : (
        <p className="ov-block__note">
          {outstanding} outstanding{inProgress > 0 ? `, ${inProgress} in progress` : ""}
        </p>
      )}
      {overdue > 0 && <p className="ov-work__health ov-work__health--risk" data-flag="overdue">{overdue} overdue</p>}
      <p className="ov-work__meta" data-next-due>
        {nextDue ? (
          <>Next due: {nextDue.title}, {formatDate(nextDue.dueOn)}{nextDue.overdue ? " (overdue)" : ""}</>
        ) : "Nothing due"}
      </p>
      <Link href={LEARNING_HREF} className="ov-nums__link">My learning</Link>
    </section>
  );
}

export function AppraisalBlock({ view }: { view: AppraisalView }) {
  if (view.kind !== "ok") return <Refusal title="Appraisal" kind={view.kind} />;
  const { current, last } = view;
  return (
    <section className="ov-block ov-work" aria-label="Appraisal" data-state={!current && !last ? "empty" : "ok"}>
      <h3 className="ov-block__title">Appraisal</h3>
      {!current && !last && <p className="ov-block__note">No appraisal yet</p>}
      {current && (
        <div data-part="current">
          <p className="ov-work__health">{current.cycleName}: {current.statusText}</p>
          {current.nextStep && <p className="ov-work__meta" data-next-step>My next step: {current.nextStep}</p>}
        </div>
      )}
      {last && (
        <p className="ov-work__meta" data-part="last">
          Last result: {last.scoreText ?? "no score recorded"}, {last.cycleName}
        </p>
      )}
      <Link href={APPRAISAL_HREF} className="ov-nums__link">My appraisals</Link>
    </section>
  );
}
