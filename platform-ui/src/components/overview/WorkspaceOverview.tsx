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
import { builtPulseTiles } from "@/lib/overviewPulse";
import { workLinks, workWidgetPlaced } from "@/lib/overviewWork";
import { growthWidgetPlaced } from "@/lib/overviewGrowth";
import { conditionWidgetPlaced } from "@/lib/overviewCondition";
import { widgetTitle, youBandLabel, type OverviewView } from "@/lib/overviewTeam";
import { PeriodSelector } from "./PeriodSelector";
import { ViewSwitch } from "./ViewSwitch";
import { WidgetBoundary } from "./WidgetBoundary";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetComponent } from "./widgets";
import "./overview.css";

// DW-3a/3b: the frame of the Overview, the page that answers five questions in a fixed order (plan §3.1):
// what needs me, how am I doing, how is my department doing, where is our work, how am I growing. This
// ticket draws the header, the bands and the host each block plugs into. A block is its own ticket.
//
// Server component. Pilot only: the pages that render it check the switch, and everyone else keeps today's page.

/** A band's quiet label. The Department band carries the workspace's own name. */
function bandLabel(band: OverviewBand, subject: OverviewSubject, view: OverviewView): string {
  switch (band) {
    case "now": return "Now";
    case "you": return youBandLabel(view);
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

export function WorkspaceOverview({ me, tenantId, subject, period, view = "me", canSwitchView = false, legacy, now = new Date(), widgets = OVERVIEW_WIDGETS, moduleOn = () => true }: {
  me: Me;
  tenantId: string;
  subject: OverviewSubject;
  period: OverviewPeriod;
  /** Me or Team (DW-3h). `pilotFrame` resolves it (`resolveOverviewView`), so "team" arrives only for a head of this
   *  workspace's unit; the default is Me, which is every page that does not pass one. */
  view?: OverviewView;
  /** Whether to draw the Me | Team switch: the person is a head of this workspace's unit (`canSwitchToTeam`). */
  canSwitchView?: boolean;
  /** The page's own body as it was before the Overview, built once by the page. It stays under the bands
   *  until the Overview's blocks replace it (plan §2.6 rule 1: nothing is removed), and while it is there the
   *  "being built" line is not needed. */
  legacy?: ReactNode;
  /** The render clock; a prop so a test can pin the greeting and the date. */
  now?: Date;
  /** The widget host. The default is the real one; a test passes its own. */
  widgets?: Readonly<Record<string, OverviewWidgetComponent>>;
  /** The active company's module gate (`moduleGate(...).isEnabled`), read once by the page (`pilotFrame`). A block
   *  whose module is off is not placed (DW-3g). Omitted means every module is on. */
  moduleOn?: (moduleKey: string) => boolean;
}) {
  // Team mode is a head's alone: whatever the caller passed, without the switch the page is Me.
  const mode: OverviewView = canSwitchView ? view : "me";
  const ctx = { me, tenantId, unitPath: subject.unitPath, workspaces: subject.workspaces };
  // The Pulse is the one block whose content depends on the workspace: with no built tile it is not placed at
  // all, so the Department band does not draw a label over nothing.
  const pulse = builtPulseTiles(subject);
  // The Work blocks (DW-3f) read for the department unit: without one they are not placed, so the Work band is dropped.
  const links = workLinks(subject);
  // The condition (DW-3k) reads for the department unit, so a workspace without one does not place it. Whether the person may read it
  // is the server's answer: a refused read draws nothing, so a visitor sees no block on someone else's department.
  // The Growth blocks (DW-3g) are not placed for a company that switched their module off.
  const bands = selectBands(subject.widgets, ctx, (key) =>
    hasOverviewWidget(key, widgets) && (key !== "pulse" || pulse.length > 0) && workWidgetPlaced(key, subject) && conditionWidgetPlaced(key, subject) && growthWidgetPlaced(key, moduleOn));
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
          {canSwitchView && <ViewSwitch value={mode} period={period} />}
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
            <h2 id={`ov-band-${band}`} className="ov-band__label">{bandLabel(band, subject, mode)}</h2>
            <div className="ov-band__grid">
              {inBand.map((w) => {
                const Widget = widgets[w.key];
                return (
                  <WidgetBoundary key={`${w.key}:${mode}`} title={widgetTitle(w.key, w.label, mode)}>
                    <Suspense fallback={<WidgetSkeleton title={widgetTitle(w.key, w.label, mode)} />}>
                      <Widget
                        me={me}
                        tenantId={tenantId}
                        period={period}
                        deptId={subject.deptId}
                        unitPath={subject.unitPath}
                        tools={subject.tools}
                        widget={w}
                        pulse={pulse}
                        workLinks={links}
                        view={mode}
                        subjectLabel={subject.label}
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
