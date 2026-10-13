import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import type { Me } from "@/lib/platform";
import { activeCompany } from "@/lib/companyContext";
import type { OverviewBand } from "@/lib/workspaces";
import {
  dateLineFor, greetingFor, selectBands, selectQuickActions,
  type OverviewPeriod, type OverviewSubject,
} from "@/lib/overview";
import { Skeleton } from "@/components/Feedback";
import { PeriodSelector } from "./PeriodSelector";
import { WidgetBoundary } from "./WidgetBoundary";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetComponent } from "./widgets";
import "./overview.css";

// DW-3a/3b: the frame of the Overview, the page that answers five questions in a fixed order (plan §3.1):
// what needs me, how am I doing, how is my department doing, where is our work, how am I growing. This
// ticket draws the header, the bands and the host each block plugs into. A block is its own ticket.
//
// Server component. Pilot only: the pages that render it check the switch, and everyone else keeps today's page.

/** A band's quiet label. The Department band carries the workspace's own name. */
function bandLabel(band: OverviewBand, subject: OverviewSubject): string {
  switch (band) {
    case "now": return "Now";
    case "you": return "You";
    case "department": return subject.label;
    case "work": return "Work";
    case "growth": return "Growth";
  }
}

/** The loading state of one block: quiet, with its title, so the page does not jump when it arrives. */
function WidgetSkeleton({ title }: { title: string }) {
  return (
    <section className="ov-block" aria-busy="true" aria-label={`${title}, loading`}>
      <Skeleton width={96} height={12} />
      <Skeleton width="60%" height={22} />
      <Skeleton width="85%" height={12} />
    </section>
  );
}

export function WorkspaceOverview({ me, tenantId, subject, period, legacy, now = new Date(), widgets = OVERVIEW_WIDGETS }: {
  me: Me;
  tenantId: string;
  subject: OverviewSubject;
  period: OverviewPeriod;
  /** The page's own body as it was before the Overview, built once by the page. It stays under the bands
   *  until the Overview's blocks replace it (plan §2.6 rule 1: nothing is removed), and while it is there the
   *  "being built" line is not needed. */
  legacy?: ReactNode;
  /** The render clock; a prop so a test can pin the greeting and the date. */
  now?: Date;
  /** The widget host. The default is the real one; a test passes its own. */
  widgets?: Readonly<Record<string, OverviewWidgetComponent>>;
}) {
  const ctx = { me, tenantId, unitPath: subject.unitPath };
  const bands = selectBands(subject.widgets, ctx, (key) => hasOverviewWidget(key, widgets));
  const actions = selectQuickActions(subject.quickActions, { ...ctx, deptId: subject.deptId });
  const company = activeCompany(me, tenantId)?.name;
  const firstName = me.name.trim().split(/\s+/)[0];

  return (
    <div className="ov">
      <header className="ov-head">
        <div className="ov-head__who">
          <h1 className="ov-head__greeting">{greetingFor(now)}, {firstName}</h1>
          <p className="ov-head__line">{[subject.label, company, dateLineFor(now)].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="ov-head__controls">
          <PeriodSelector value={period} />
          {actions.length > 0 && (
            <nav className="ov-actions" aria-label="Quick actions">
              {actions.map((a) => (
                <Link key={a.key} href={a.href} className="lux-btn lux-btn--ghost lux-btn--sm">{a.label}</Link>
              ))}
            </nav>
          )}
        </div>
      </header>

      {bands.length === 0 && legacy == null ? (
        // Honest, never invented: no block is built for this workspace yet.
        <p className="ov-empty">
          The {subject.label} Overview is being built. Until then, use its pages from the sidebar.
        </p>
      ) : (
        bands.map(({ band, widgets: inBand }) => (
          <section key={band} className="ov-band" aria-labelledby={`ov-band-${band}`}>
            <h2 id={`ov-band-${band}`} className="ov-band__label">{bandLabel(band, subject)}</h2>
            <div className="ov-band__grid">
              {inBand.map((w) => {
                const Widget = widgets[w.key];
                return (
                  <WidgetBoundary key={w.key} title={w.label}>
                    <Suspense fallback={<WidgetSkeleton title={w.label} />}>
                      <Widget
                        me={me}
                        tenantId={tenantId}
                        period={period}
                        deptId={subject.deptId}
                        unitPath={subject.unitPath}
                        tools={subject.tools}
                        widget={w}
                      />
                    </Suspense>
                  </WidgetBoundary>
                );
              })}
            </div>
          </section>
        ))
      )}

      {legacy != null && (
        <section className="ov-band" aria-labelledby="ov-band-legacy">
          <h2 id="ov-band-legacy" className="ov-band__label">More from {subject.label}</h2>
          <div className="ov-legacy">{legacy}</div>
        </section>
      )}
    </div>
  );
}
