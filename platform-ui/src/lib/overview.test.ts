import { describe, it, expect } from "vitest";
import { WORKSPACES, REPORT_PERIODS, OVERVIEW_BANDS, isPlanned, type OverviewWidget, type QuickAction } from "./workspaces";
import type { HomeArea } from "./workspaceAccess";
import { resolveMyWorkspaces } from "./workspaceAccess";
import {
  COMPANY_SUBJECT, DEFAULT_OVERVIEW_PERIOD, OVERVIEW_PERIOD_OPTIONS, dateLineFor, greetingFor, parseOverviewPeriod,
  periodHref, resolveHomeRoute, selectBands, selectQuickActions, subjectOfRef, workspaceRefForPage,
} from "./overview";
import { HOTEL, agencyTree, me, member } from "./workspaceFixtures";

const employee = me([member()]);
const ctx = { me: employee, tenantId: "co-a", unitPath: ["d-web"] as string[] };
const placed = resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });

describe("parseOverviewPeriod", () => {
  it("accepts the three periods the backend has", () => {
    expect(parseOverviewPeriod("day")).toBe("day");
    expect(parseOverviewPeriod("week")).toBe("week");
    expect(parseOverviewPeriod("month")).toBe("month");
  });

  it("maps anything unknown, empty or forged to month", () => {
    for (const raw of [undefined, null, "", "MONTH", "weeks", "../x", "0", " week"]) {
      expect(parseOverviewPeriod(raw as string | undefined)).toBe(DEFAULT_OVERVIEW_PERIOD);
    }
    expect(DEFAULT_OVERVIEW_PERIOD).toBe("month");
  });

  it("maps a disabled period back to month, never to a number the backend cannot give", () => {
    // The disabled keys come from the registry, so this holds as report periods get built (DW-4a).
    const disabled = OVERVIEW_PERIOD_OPTIONS.filter((o) => o.disabledReason);
    for (const o of disabled) expect(parseOverviewPeriod(o.key), o.key).toBe("month");
  });

  it("accepts every period that is enabled", () => {
    for (const o of OVERVIEW_PERIOD_OPTIONS.filter((o) => !o.disabledReason)) expect(parseOverviewPeriod(o.key), o.key).toBe(o.key);
    // Day, week and month exist in the reports backend today and stay enabled.
    for (const key of ["day", "week", "month"]) expect(OVERVIEW_PERIOD_OPTIONS.find((o) => o.key === key)?.disabledReason).toBeUndefined();
  });

  it("uses the first value of a repeated param", () => {
    expect(parseOverviewPeriod(["week", "day"])).toBe("week");
    expect(parseOverviewPeriod(["bogus", "week"])).toBe("month");
  });
});

describe("the period options", () => {
  it("lists Today, Week, Month, Quarter, Semester, Year, in that order", () => {
    expect(OVERVIEW_PERIOD_OPTIONS.map((o) => o.label)).toEqual(["Today", "Week", "Month", "Quarter", "Semester", "Year"]);
  });

  it("disables an option exactly when its REPORT_PERIODS entry is planned or missing, with a reason", () => {
    for (const o of OVERVIEW_PERIOD_OPTIONS) {
      const entry = REPORT_PERIODS.find((p) => p.key === o.key);
      const unavailable = !entry || isPlanned(entry);
      expect(!!o.disabledReason, o.key).toBe(unavailable);
      if (unavailable) expect(o.disabledReason, o.key).toBe("Available when this report period exists");
    }
  });
});

describe("periodHref", () => {
  it("sets the period and keeps every other param", () => {
    expect(periodHref("/departments/d-web", "sscope=co-b&x=1", "week")).toBe("/departments/d-web?sscope=co-b&x=1&period=week");
  });

  it("replaces an existing period instead of adding a second", () => {
    expect(periodHref("/hr", "period=day&a=b", "month")).toBe("/hr?period=month&a=b");
  });

  it("works from no query at all", () => {
    expect(periodHref("/it", "", "day")).toBe("/it?period=day");
  });
});

describe("selectBands", () => {
  const w = (key: string, band: OverviewWidget["band"], extra: Partial<OverviewWidget> = {}): OverviewWidget => ({ key, band, label: key, ...extra });

  it("returns the bands in the fixed order whatever order the registry lists the widgets in", () => {
    const widgets = [w("g", "growth"), w("d", "department"), w("n", "now"), w("k", "work"), w("y", "you")];
    expect(selectBands(widgets, ctx).map((b) => b.band)).toEqual([...OVERVIEW_BANDS]);
    expect(OVERVIEW_BANDS).toEqual(["now", "you", "department", "work", "growth"]);
  });

  it("keeps the registry's order inside a band", () => {
    const bands = selectBands([w("b", "now"), w("a", "now")], ctx);
    expect(bands).toHaveLength(1);
    expect(bands[0].widgets.map((x) => x.key)).toEqual(["b", "a"]);
  });

  it("hides a widget whose ticket is still open", () => {
    const bands = selectBands([w("built", "now"), w("planned", "now", { ticket: "DW-3c" })], ctx);
    expect(bands[0].widgets.map((x) => x.key)).toEqual(["built"]);
  });

  it("hides a widget its gate refuses", () => {
    const bands = selectBands([w("open", "work"), w("admin-only", "work", { gate: { kind: "elevated" } })], ctx);
    expect(bands[0].widgets.map((x) => x.key)).toEqual(["open"]);
    // The same gate lets a platform admin through: the gate is evaluated, not ignored.
    const admin = { ...ctx, me: me([{ role: "platform_admin", scopeType: "global", scopeId: null }]) };
    expect(selectBands([w("admin-only", "work", { gate: { kind: "elevated" } })], admin)).toHaveLength(1);
  });

  it("evaluates the agency pack gate against the active company", () => {
    const agencyOnly: OverviewWidget = w("campaigns", "work", { gate: { kind: "pack", pack: "agency" } });
    expect(selectBands([agencyOnly], ctx)).toHaveLength(1);
    const hotel = { me: me([member("co-h")], [HOTEL]), tenantId: "co-h", unitPath: [] };
    expect(selectBands([agencyOnly], hotel)).toEqual([]);
  });

  it("does not draw a band with no visible widget", () => {
    const bands = selectBands([w("a", "now", { ticket: "DW-3c" }), w("b", "growth"), w("c", "work", { gate: { kind: "elevated" } })], ctx);
    expect(bands.map((b) => b.band)).toEqual(["growth"]);
  });

  it("hides a built widget that has no component in the host, so a half-done widget never draws", () => {
    const bands = selectBands([w("has", "now"), w("lacks", "now")], ctx, (key) => key === "has");
    expect(bands[0].widgets.map((x) => x.key)).toEqual(["has"]);
    expect(selectBands([w("lacks", "now")], ctx, () => false)).toEqual([]);
  });

  it("draws only the Now band for every real workspace while the other blocks are planned", () => {
    for (const ws of WORKSPACES) expect(selectBands(ws.overview, ctx).map((b) => b.band), ws.key).toEqual(["now"]);
    // The company frame has Today; its decisions block waits for DW-3i.
    expect(selectBands(COMPANY_SUBJECT.widgets, ctx).map((b) => [b.band, b.widgets.map((w) => w.key)])).toEqual([["now", ["today"]]]);
    // Department workspaces have Needs you and Today.
    const dept = WORKSPACES.find((w) => w.key === "web-dev")!;
    expect(selectBands(dept.overview, ctx)[0].widgets.map((w) => w.key)).toEqual(["needs-you", "today"]);
  });
});

describe("selectQuickActions", () => {
  const a = (key: string, extra: Partial<QuickAction> = {}): QuickAction => ({ key, label: key, href: `/x/${key}`, ...extra });
  const qctx = { ...ctx, deptId: "d-web" };

  it("offers Web Dev's built actions, made concrete with the department id", () => {
    const web = WORKSPACES.find((x) => x.key === "web-dev")!;
    expect(selectQuickActions(web.quickActions, qctx)).toEqual([
      { key: "new-briefing", label: "New briefing", href: "/departments/d-web/prd" },
      { key: "triage-requests", label: "Triage requests", href: "/departments/d-web/requests" },
    ]);
  });

  it("never shows a planned action", () => {
    expect(selectQuickActions([a("later", { ticket: "DW-5f" }), a("now")], qctx).map((x) => x.key)).toEqual(["now"]);
  });

  it("drops an action its gate refuses", () => {
    expect(selectQuickActions([a("admin", { gate: { kind: "elevated" } }), a("open")], qctx).map((x) => x.key)).toEqual(["open"]);
  });

  it("drops an action that needs a department id the workspace does not have", () => {
    const needsDept = a("d", { href: "/departments/{dept}/prd" });
    expect(selectQuickActions([needsDept, a("plain")], { ...qctx, deptId: null }).map((x) => x.key)).toEqual(["plain"]);
    expect(selectQuickActions([needsDept], qctx)[0].href).toBe("/departments/d-web/prd");
  });

  it("returns at most three, counting only the ones that qualify", () => {
    const many = [a("p0", { ticket: "T" }), a("a1"), a("a2"), a("a3"), a("a4"), a("a5")];
    expect(selectQuickActions(many, qctx).map((x) => x.key)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("workspaceRefForPage", () => {
  it("finds a department by its org node id, and prefers the person's own entry", () => {
    expect(workspaceRefForPage(placed, { deptId: "d-web" })).toBe(placed.mine[0]);
    const seo = workspaceRefForPage(placed, { deptId: "d-seo" });
    expect(seo?.workspace.key).toBe("seo");
    expect(seo?.unitPath).toEqual(["d-seo", "root"]);
  });

  it("finds a functional workspace by slug even when the org tree does not hold it", () => {
    const hr = workspaceRefForPage(placed, { slug: "hr" });
    expect(hr?.workspace.key).toBe("hr");
    expect(hr?.deptId).toBeNull();
  });

  it("is null for a department this company does not have", () => {
    expect(workspaceRefForPage(placed, { deptId: "nope" })).toBeNull();
    expect(workspaceRefForPage(placed, { slug: "nope" })).toBeNull();
  });

  it("builds the subject a page draws, with the workspace's own widgets and unit path", () => {
    const subject = subjectOfRef(placed.mine[0]);
    expect(subject.label).toBe("Web Dev");
    expect(subject.deptId).toBe("d-web");
    expect(subject.unitPath).toEqual(["d-web", "root"]);
    expect(subject.widgets).toBe(WORKSPACES.find((x) => x.key === "web-dev")!.overview);
  });
});

describe("resolveHomeRoute (what `/` does)", () => {
  it("sends a pilot user whose home is a department to that department's Overview", () => {
    expect(placed.home.kind).toBe("workspace");
    expect(resolveHomeRoute({ shell: "workspaces", home: placed.home, tenantId: "co-a" })).toEqual({ kind: "redirect", href: "/departments/d-web" });
  });

  it("leaves a classic user on today's page, whatever their home", () => {
    expect(resolveHomeRoute({ shell: "classic", home: placed.home, tenantId: "co-a" })).toEqual({ kind: "classic" });
    expect(resolveHomeRoute({ shell: "classic", home: { kind: "company" }, tenantId: "co-a" })).toEqual({ kind: "classic" });
  });

  it("keeps a pilot user whose home is the Company area on `/`, for the company frame", () => {
    const unplaced = resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: agencyTree() });
    expect(unplaced.home).toEqual({ kind: "company" });
    expect(resolveHomeRoute({ shell: "workspaces", home: unplaced.home, tenantId: "co-a" })).toEqual({ kind: "company" });
  });

  it("sends a functional home with no department id to its slug route", () => {
    const hrStaff = me([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]);
    const ws = resolveMyWorkspaces({ me: hrStaff, tenantId: "co-a", root: agencyTree() });
    expect(ws.home.kind === "workspace" && ws.home.ref.deptId).toBeNull();
    expect(resolveHomeRoute({ shell: "workspaces", home: ws.home, tenantId: "co-a" })).toEqual({ kind: "redirect", href: "/hr" });
  });

  it("sends the Office of the GM's home to its own page", () => {
    const gmTree = resolveMyWorkspaces({
      me: me([{ role: "platform_admin", scopeType: "global", scopeId: null }]), tenantId: "co-a", root: agencyTree(),
    });
    expect(resolveHomeRoute({ shell: "workspaces", home: gmTree.home, tenantId: "co-a" })).toEqual({ kind: "redirect", href: "/departments/d-gm" });
  });

  it("can never redirect to `/` or to a link it cannot make concrete: that falls back to the frame", () => {
    const base = WORKSPACES.find((x) => x.key === "web-dev")!;
    const loop: HomeArea = { kind: "workspace", ref: { workspace: { ...base, overviewHref: "/" }, deptId: "d-web", unitPath: [], lead: false } };
    expect(resolveHomeRoute({ shell: "workspaces", home: loop, tenantId: "co-a" })).toEqual({ kind: "company" });
    const noId: HomeArea = { kind: "workspace", ref: { workspace: base, deptId: null, unitPath: [], lead: false } };
    expect(resolveHomeRoute({ shell: "workspaces", home: noId, tenantId: "co-a" })).toEqual({ kind: "company" });
  });

  it("never redirects to `/` for any registry workspace", () => {
    for (const workspace of WORKSPACES) {
      const route = resolveHomeRoute({ shell: "workspaces", home: { kind: "workspace", ref: { workspace, deptId: "d-1", unitPath: [], lead: false } }, tenantId: "co-a" });
      expect(route.kind === "redirect" && route.href, workspace.key).not.toBe("/");
    }
  });
});

describe("the header's words", () => {
  it("greets by the hour of the render clock", () => {
    expect(greetingFor(new Date(2026, 9, 13, 0, 5))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 9, 13, 11, 59))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 9, 13, 12, 0))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 9, 13, 17, 59))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 9, 13, 18, 0))).toBe("Good evening");
  });

  it("writes the date as weekday, day and month, with no comma", () => {
    expect(dateLineFor(new Date(2026, 9, 13, 9, 0))).toBe("Tuesday 13 October");
    expect(dateLineFor(new Date(2026, 0, 1, 9, 0))).toBe("Thursday 1 January");
  });
});
