import type { ReactNode } from "react";
import type { ReportDocument } from "@/lib/reports";
import { comparisonLabel } from "@/lib/reports";
import { KpiTiles } from "./charts/KpiTiles";
import { TrendLine } from "./charts/TrendLine";
import { Donut } from "./charts/Donut";
import { GroupedBars } from "./charts/GroupedBars";
import { StackedBars } from "./charts/StackedBars";
import { ReportTableView } from "./charts/ReportTableView";
import { WarningsBanner } from "./WarningsBanner";
import { ComparisonChip } from "./ComparisonChip";
import { PeriodSelector, type PeriodSelectorValue } from "./PeriodSelector";
import "./reports.css";

// The report viewer layout (TR-16 deliverable 3): composes ONE ReportDocument
// into a page. Deliberately NOT "use client" itself — it's plain composition
// over already-client leaf components (PeriodSelector/the charts), the same
// server-renders-client-children pattern the rest of the app uses, so a
// grain page (TR-17) can call this from either a server or client component.
//
// `children`, when supplied, is the grain-specific chart arrangement from
// §7's per-grain table (e.g. project grain = Burndown + CFD + throughput
// bars + ...) — that arrangement genuinely differs per grain and is TR-17's
// job to wire. Omit `children` and this viewer instead AUTO-COMPOSES a safe
// generic layout straight from `document.series`/`distributions`/`tables` —
// satisfying "every §7 component renders from document JSON alone" without
// needing a grain page yet. The auto-composition deliberately gives every
// series/distribution its OWN chart card rather than guessing which ones
// share a scale (dataviz's hard "one axis" rule — never combine two
// differently-scaled measures on one plot without knowing they're the same
// unit family).
export function ReportViewer({ document, periodControl, scopeHeading = true, children }: {
  document: ReportDocument;
  periodControl?: { value: PeriodSelectorValue; onChange: (next: PeriodSelectorValue) => void; todayIso: string };
  /** Render the scope name as this surface's OWN heading. True by default, because the PRINT
   *  surface (`app/print/reports/[jobToken]`) mounts this viewer with no `PageHeader` above it and
   *  `print.css` styles `.rc-header__scope` as the document title — suppressing it there would ship
   *  a titleless PDF. The in-app grain pages pass FALSE: their `PageHeader` already states the scope,
   *  and rendering both printed the company name twice in a row at two different sizes. */
  scopeHeading?: boolean;
  children?: ReactNode;
}) {
  const { header } = document;
  const cmpLabel = comparisonLabel(header.comparison);

  return (
    <div className="rc-viz rc-page">
      <div className="rc-header">
        <div>
          {scopeHeading && <h2 className="rc-header__scope">{header.scopeName}</h2>}
          <div className="rc-header__meta">
            <span>{header.periodLabel}</span>
            {header.sealed ? (
              <span className="rc-header__seal rc-header__seal--sealed">Sealed · rev {header.revision}</span>
            ) : header.warnings?.adHoc ? (
              <span className="rc-header__seal rc-header__seal--adhoc">Ad hoc · unsealed</span>
            ) : (
              <span className="rc-header__seal">Live</span>
            )}
            {header.providerView && <span>{header.providerView.servedTenantName} (served)</span>}
            {cmpLabel && <ComparisonChip comparison={header.comparison} />}
          </div>
        </div>
        {periodControl && (
          <PeriodSelector value={periodControl.value} onChange={periodControl.onChange} todayIso={periodControl.todayIso} />
        )}
      </div>

      <WarningsBanner header={header} />

      <KpiTiles kpis={document.kpis} comparisonLabel={cmpLabel} />

      {children ?? <AutoComposedCharts document={document} />}

      {document.highlights.length > 0 && (
        <section className="rc-section">
          <h3 className="rc-section__title">Highlights</h3>
          <div className="rc-highlights">
            {document.highlights.map((h, i) => (
              <div key={i} className={`rc-highlight rc-highlight--${h.kind}`}>
                <span className="rc-highlight__badge">{h.kind}</span>
                <span>{h.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {document.narrative.text && (
        <section className="rc-section">
          <h3 className="rc-section__title">Summary</h3>
          <p className="rc-narrative">{document.narrative.text}</p>
          <span className="rc-narrative__source">{document.narrative.source === "ai" ? `AI-drafted${document.narrative.model ? ` · ${document.narrative.model}` : ""}` : "Deterministic summary"}</span>
        </section>
      )}
    </div>
  );
}

function AutoComposedCharts({ document }: { document: ReportDocument }) {
  const { series, distributions, tables, header } = document;
  if (series.length === 0 && distributions.length === 0 && tables.length === 0) return null;
  return (
    <div className="rc-sections-grid">
      {series.map((s) => (
        <section className="rc-section" key={s.key}>
          <h3 className="rc-section__title">{s.label}</h3>
          <TrendLine series={[s]} dayCount={header.dayCount} title={s.label} unit={s.unit} />
        </section>
      ))}
      {distributions.map((d) => (
        <section className="rc-section" key={d.key}>
          <h3 className="rc-section__title">{d.label}</h3>
          {d.kind === "donut" ? (
            <Donut distribution={d} title={d.label} />
          ) : d.kind === "stacked" ? (
            <StackedBars kind="category" distributions={[d]} title={d.label} />
          ) : (
            <GroupedBars kind="category" distributions={[d]} title={d.label} />
          )}
        </section>
      ))}
      {tables.map((t) => (
        <section className="rc-section" key={t.key}>
          <h3 className="rc-section__title">{t.label}</h3>
          <ReportTableView table={t} />
        </section>
      ))}
    </div>
  );
}
