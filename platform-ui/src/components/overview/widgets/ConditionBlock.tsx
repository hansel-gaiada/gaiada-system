import Link from "next/link";
import { refusalText } from "@/lib/overviewWork";
import type { ConditionView } from "@/lib/overviewCondition";
import "@/components/deptkpis/deptKpis.css";

// DW-3k: the department's condition on its Overview, drawn from `ConditionView` (lib/overviewCondition.ts). It reuses the department
// KPI page's own banner and tile classes (`dk-*`, DW-4e-2), so the Overview and the page look and word it the same. The condition is
// always said in words (the badge text), never by colour alone.
//   - banner: a head's view. The banner sentence, one tile per KPI with its own condition, a link to the department KPI page.
//   - strip: everyone else's, quiet: one line, no tiles, no link, no ranking.
//   - unavailable: the read failed. Says so; a department never reads as on track because its read failed.
// A refused read is not drawn at all (`kind: "none"` returns null in the widget).

export const CONDITION_TITLE = "Department condition";

export function ConditionBlock({ view, subjectLabel }: { view: Exclude<ConditionView, { kind: "none" }>; subjectLabel?: string }) {
  if (view.kind === "unavailable") {
    if (view.audience === "staff") {
      return (
        <section className="ov-cond ov-cond--strip" aria-label={CONDITION_TITLE} data-state="unavailable">
          <p className="ov-cond__strip dk-banner dk-banner--idle">{subjectLabel ? `${subjectLabel}: ` : ""}{refusalText("unavailable")}</p>
        </section>
      );
    }
    return (
      <section className="ov-cond ov-block ov-block--unavailable" aria-label={CONDITION_TITLE} data-state="unavailable">
        <h3 className="ov-block__title">{CONDITION_TITLE}</h3>
        <p className="ov-block__note">{refusalText("unavailable")}</p>
      </section>
    );
  }
  if (view.kind === "strip") {
    return (
      <section className="ov-cond ov-cond--strip" aria-label={CONDITION_TITLE} data-state="strip" data-condition={view.condition}>
        <p className={`ov-cond__strip dk-banner dk-banner--${view.tone}`}>
          <span className={`dk-badge dk-badge--${view.tone}`}>{view.conditionText}</span>
          <span data-part="sentence">{view.sentence}</span>
        </p>
      </section>
    );
  }
  return (
    <section className="ov-cond" aria-label={CONDITION_TITLE} data-state="banner" data-condition={view.condition}>
      <div className={`dk-banner dk-banner--${view.tone}`}>
        <span className={`dk-badge dk-badge--${view.tone}`}>{view.conditionText}</span>
        <span data-part="sentence">{view.sentence}</span>
        <Link href={view.href} className="ov-nums__link">Open the department KPIs</Link>
      </div>
      {view.tiles.length > 0 && (
        <ul className="dk-tiles ov-cond__tiles" aria-label="Department KPIs">
          {view.tiles.map((t) => (
            <li key={t.key} className={`dk-tile dk-tile--${t.tone}`} data-kpi={t.key} data-condition={t.condition}>
              <span className="dk-tile__label">{t.label}</span>
              <span className="dk-tile__value">{t.value}</span>
              <span className={`dk-badge dk-badge--${t.tone}`}>{t.conditionText}</span>
              <span className="dk-tile__foot">{t.foot}</span>
              {t.parts && <span className="dk-tile__foot">{t.parts}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
