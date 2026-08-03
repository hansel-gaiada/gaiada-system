import type { ReactNode } from "react";

// A titled block inside the task detail. Replaces <Card> there: the detail had ten nested cards, so
// every section carried a border and equal visual weight. Here the eyebrow label plus a hairline
// does the same job with none of the boxing (see task-detail.css).
export function Section({ label, count, right, children }: {
  label: string;
  /** Small figure beside the label, e.g. "2/3" for subtasks or a file count. */
  count?: string | number;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pm-sec">
      <div className="pm-sec__head">
        <span className="type-eyebrow pm-sec__label">{label}</span>
        {count !== undefined && count !== "" ? <span className="pm-sec__count">{count}</span> : null}
        {right}
      </div>
      <div className="pm-sec__body">{children}</div>
    </section>
  );
}

/** One row of the properties column: uppercase label, control on the right.
 *  `stack` puts the control on its own line beneath the label — for controls too wide for the
 *  86px-label + value split (the progress slider with its Set button clipped out of the column
 *  otherwise). */
export function Prop({ label, children, muted, stack }: {
  label: string; children: ReactNode; muted?: boolean; stack?: boolean;
}) {
  return (
    <div className={`pm-prop${stack ? " pm-prop--stack" : ""}`}>
      <span className="pm-prop__label">{label}</span>
      <span className={`pm-prop__value${muted ? " pm-prop__value--muted" : ""}`}>{children}</span>
    </div>
  );
}
