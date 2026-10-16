// The Overview's pure rules (DW-3a/3b, docs/plans/2026-10-13-department-workspaces.md §3): which bands and
// widgets a person sees, the period, the quick actions, and where `/` sends someone. No React
// and no server imports, so the components stay thin and every rule here is a plain unit test.
//
// Nothing here is a security boundary. `gateAllows` mirrors the surfaces the server enforces; every read
// behind a widget is narrowed by the server.
import {
  COMPANY_OVERVIEW, OVERVIEW_BANDS, REPORT_PERIODS, hrefFor, isPlanned,
  type OverviewBand, type OverviewWidget, type QuickAction,
} from "@/lib/workspaces";
import { gateAllows, routeActionsFor, workspaceKeysOf, type GateContext, type HomeArea, type MyWorkspaces, type WorkspaceRef } from "@/lib/workspaceAccess";
import type { DeptLauncher } from "@/lib/deptToolkits";
import { pinnedToolsFor } from "@/lib/pinnedTools";
import { effectiveWidgets, type WorkspaceOverviewPrefs } from "@/lib/overviewPrefs";

// ── The period (plan §3.2) ───────────────────────────────────────────────────────────────────────

export const OVERVIEW_PERIODS = ["day", "week", "month", "quarter", "semester", "year"] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = "month";

const PERIOD_LABEL: Record<OverviewPeriod, string> = {
  day: "Today", week: "Week", month: "Month", quarter: "Quarter", semester: "Semester", year: "Year",
};

export interface OverviewPeriodOption {
  key: OverviewPeriod;
  label: string;
  /** Set while the backend cannot report the period: shown, never selectable, never faked (§13 trap 4). */
  disabledReason?: string;
}

/** Day, week and month exist in the reports backend; the rest wait for DW-4a (`REPORT_PERIODS`'s `ticket`).
 *  A period `REPORT_PERIODS` does not list is disabled too, so a new key can never go live by accident. */
export const OVERVIEW_PERIOD_OPTIONS: readonly OverviewPeriodOption[] = OVERVIEW_PERIODS.map((key) => {
  const backend = REPORT_PERIODS.find((p) => p.key === key);
  const built = !!backend && !isPlanned(backend);
  return { key, label: PERIOD_LABEL[key], ...(built ? {} : { disabledReason: "Available when this report period exists" }) };
});

/** Anything unknown, forged or still disabled reads as the default, so a hand-typed `?period=year` shows a
 *  month rather than a year of numbers the backend cannot give. An array (a repeated param) uses its first. */
export function parseOverviewPeriod(raw: string | readonly string[] | null | undefined): OverviewPeriod {
  const value = typeof raw === "string" || raw == null ? raw : raw[0];
  const option = OVERVIEW_PERIOD_OPTIONS.find((o) => o.key === value);
  return option && !option.disabledReason ? option.key : DEFAULT_OVERVIEW_PERIOD;
}

/** The URL that selects a period, keeping every other param. */
export function periodHref(pathname: string, currentSearch: string, period: OverviewPeriod): string {
  const params = new URLSearchParams(currentSearch);
  params.set("period", period);
  return `${pathname}?${params.toString()}`;
}

// ── What the Overview is about ───────────────────────────────────────────────────────────────────

export interface OverviewSubject {
  /** The workspace's name, or "Company". */
  label: string;
  /** The registry key of the workspace (`Workspace.key`, "generic" for a generic department); null for Company. */
  workspaceKey: string | null;
  widgets: readonly OverviewWidget[];
  quickActions: readonly QuickAction[];
  /** The tools the Today block shows: the person's pinned tools of this workspace (DW-6c), or its first six
   *  when they have pinned none. Empty for Company. */
  tools: readonly DeptLauncher[];
  /** The department's org node id; null for a functional workspace without one, and for Company. */
  deptId: string | null;
  /** The unit and its ancestors, nearest first, for unit-scoped gates. */
  unitPath: readonly string[];
  /** The registry keys of the workspaces this company has a department for, for the `hasWorkspace` gate (DW-5f). */
  workspaces?: readonly string[];
  /** The active company's routes to other group companies (DW-10e), for the `hasRoutes` gate and the per-route quick actions. Set by
   *  the page that read them (`pilotFrame`); absent hides both. */
  routes?: GateContext["routes"];
}

/** `pins` is `Prefs.pinnedTools` (DW-6c); left out, the Today block shows the workspace's first six tools. `all` (DW-5f)
 *  gives the `hasWorkspace` gate the keys of the workspaces this company has a department for; left out, that gate hides. */
export function subjectOfRef(ref: WorkspaceRef, pins: Readonly<Record<string, string[]>> = {}, all?: MyWorkspaces): OverviewSubject {
  const { workspace, deptId, unitPath } = ref;
  return {
    label: workspace.label, workspaceKey: workspace.key, widgets: workspace.overview, quickActions: workspace.quickActions, tools: pinnedToolsFor(pins, workspace), deptId, unitPath,
    ...(all ? { workspaces: workspaceKeysOf(all) } : {}),
  };
}

/** The company-level Overview at `/` for someone whose home is the Company area. DW-3i fills it. */
export const COMPANY_SUBJECT: OverviewSubject = { label: "Company", workspaceKey: null, widgets: COMPANY_OVERVIEW, quickActions: [], tools: [], deptId: null, unitPath: [] };

/** The workspace a page belongs to, from its URL: a department by its org node id, or a functional one by
 *  its slug. The person's own come first, so `mine` wins over the same workspace listed under `all`. */
export function workspaceRefForPage(ws: MyWorkspaces, target: { deptId: string } | { slug: string }): WorkspaceRef | null {
  const match = (r: WorkspaceRef) => ("deptId" in target ? r.deptId === target.deptId : r.workspace.key === target.slug);
  return ws.mine.find(match) ?? ws.all.find(match) ?? null;
}

// ── Bands and widgets (plan §3.1, §3.6) ──────────────────────────────────────────────────────────

export interface OverviewBandView {
  band: OverviewBand;
  widgets: OverviewWidget[];
}

/** The widgets that could be placed at all: built, allowed and (when `has` is given) with a component to draw, grouped by band
 *  in the fixed order. A band with none is dropped, never drawn empty. */
function placeable(widgets: readonly OverviewWidget[], ctx: GateContext, has: (key: string) => boolean): OverviewBandView[] {
  const out: OverviewBandView[] = [];
  for (const band of OVERVIEW_BANDS) {
    const visible = widgets.filter((w) => w.band === band && !isPlanned(w) && has(w.key) && gateAllows(w.gate, ctx));
    if (visible.length > 0) out.push({ band, widgets: visible });
  }
  return out;
}

/** The bands to draw: the fixed order, each with the widgets that are built, allowed and (when `has` is
 *  given) have a component to draw. A band with none is dropped, never drawn empty.
 *
 *  DW-10d (DW-D34): the person's own choice (`prefs`, their entry of `Prefs.overview` for this workspace) is applied FIRST, before
 *  the gates and the placement rules, in `effectiveWidgets`: a hidden widget is never placed, so its component never renders and its
 *  reads never run, and an optional one is placed only when switched on, and then still needs its gate. Left out, `prefs` is "no
 *  choice made": every default widget, no optional one. The order is the registry's whatever `prefs` says. */
export function selectBands(
  widgets: readonly OverviewWidget[],
  ctx: GateContext,
  has: (key: string) => boolean = () => true,
  prefs?: Partial<WorkspaceOverviewPrefs>,
): OverviewBandView[] {
  return placeable(effectiveWidgets(widgets, prefs), ctx, has);
}

/** What the Customise control lists: every widget this person could see on this Overview if they chose to, in the fixed order, that
 *  is built, allowed and has a component, whatever they hid or left off. Nothing the person may not see is offered. */
export function selectCustomisable(widgets: readonly OverviewWidget[], ctx: GateContext, has: (key: string) => boolean = () => true): OverviewBandView[] {
  return placeable(widgets, ctx, has);
}

export interface OverviewAction { key: string; label: string; href: string }
const MAX_QUICK_ACTIONS = 3;

/** The header's quick actions: built, allowed, with their ids filled in, at most three. An action that
 *  needs an id the person's workspace lacks is dropped, like the sidebar's links. */
export function selectQuickActions(
  actions: readonly QuickAction[],
  ctx: GateContext & { deptId: string | null },
): OverviewAction[] {
  const out: OverviewAction[] = [];
  // DW-10e (§60.9): the same-company actions first, then one per active route; the header still shows at most three.
  const routeActions = routeActionsFor(ctx).map((a): QuickAction => ({ key: a.key, label: a.label, href: a.href }));
  for (const a of [...actions, ...routeActions]) {
    if (isPlanned(a) || !gateAllows(a.gate, ctx)) continue;
    const href = hrefFor(a.href, { deptId: ctx.deptId, companyId: ctx.tenantId });
    if (href) out.push({ key: a.key, label: a.label, href });
    if (out.length === MAX_QUICK_ACTIONS) break;
  }
  return out;
}

// ── The header's words ───────────────────────────────────────────────────────────────────────────

/** By the clock of the machine rendering the page. There is no per-person
 *  time zone yet, so near a day boundary this can differ from the reader's own clock. */
export function greetingFor(now: Date): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** "Tuesday 13 October", built from parts so the comma some locales add never creeps in. Same clock as the greeting. */
export function dateLineFor(now: Date): string {
  const part = (o: Intl.DateTimeFormatOptions) => now.toLocaleDateString("en-GB", o);
  return `${part({ weekday: "long" })} ${part({ day: "numeric" })} ${part({ month: "long" })}`;
}

// ── `/` (plan §3.7) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type HomeRoute =
  | { kind: "redirect"; href: string }
  | { kind: "company" };

/** What `/` does. A person whose home is a workspace goes
 *  to that workspace's Overview, and a Company-area person stays for the company frame. A target that
 *  cannot be made concrete, or that is `/` itself, falls back to the frame, so it can never loop. */
export function resolveHomeRoute(input: { home: HomeArea; tenantId: string | null }): HomeRoute {
  if (input.home.kind === "company") return { kind: "company" };
  const { workspace, deptId } = input.home.ref;
  const href = hrefFor(workspace.overviewHref, { deptId, companyId: input.tenantId });
  return href && href !== "/" ? { kind: "redirect", href } : { kind: "company" };
}

/** DW-3a2: the layout's own answer to `/`. The page's `redirect()` sits under `loading.tsx`, so on a document
 *  request Next has already streamed the shell and emits a meta refresh instead of a 307. The layout is outside
 *  that boundary, so it redirects there: on exactly `/` (the proxy's pathname header, no
 *  query), when `resolveHomeRoute` says redirect. Anything else returns null and the page decides as before. */
export function layoutHomeRedirect(input: { pathname: string | null; home: HomeArea; tenantId: string | null }): string | null {
  if (input.pathname !== "/") return null;
  const route = resolveHomeRoute({ home: input.home, tenantId: input.tenantId });
  return route.kind === "redirect" ? route.href : null;
}
