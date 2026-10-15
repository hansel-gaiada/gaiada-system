// Areas: which part of the app a page belongs to (DW-1c, docs/plans/2026-10-13-department-workspaces.md).
//
// Every page of the app belongs to exactly one AREA, decided by `areaFor(pathname)`. The sidebar calls it
// on the client with `usePathname()` (Next layouts get no pathname, plan §13 trap 2), so this file is pure
// and client-safe: no `server-only`, no `node:` and no Next imports.
//
// - `workspace`: a department's workspace, either `/departments/[deptId]/...` (the area carries the deptId
//   read from the URL) or a route a workspace owns (the area carries its slug). Owned routes come ONLY
//   from the registry (`ownedRoutes`), never copied by hand.
// - `company` and `admin`: the Company and Admin areas. `personal` (You) and `performance` (Performance
//   and the AI Assistant) are drawn inside the person's current workspace. `shared` pages (records, and
//   lists more than one area links to) keep whatever area the person came from (`resolveArea`).
//
// Rules are written in the page tree's own spelling (`[name]` = one dynamic segment) and picked the way
// Next.js picks a route: more segments, then more static segments, then exact over subtree. The test
// (`areas.test.ts`) walks the page files and fails when a page matches no rule, or two rules tie. That is
// the guard against a page silently vanishing from the menu.
import { WORKSPACES } from "@/lib/workspaces";

export type AreaKind = "workspace" | "company" | "admin" | "personal" | "performance" | "shared";

export interface AreaRule {
  /** Static segments, or `[name]` for one dynamic segment. Never a catch-all. "/" only as an exact rule. */
  path: string;
  /** Matches the path and anything below it. Otherwise the segment count must be equal. */
  subtree?: boolean;
  kind: AreaKind;
  /** The workspace key, for a route a workspace owns. */
  slug?: string;
  why?: string;
}

export interface AreaMatch { kind: AreaKind; deptId?: string; slug?: string }

/** What the sidebar draws: always a concrete area. */
export type Area = { kind: "workspace"; deptId?: string; slug?: string } | { kind: "company" } | { kind: "admin" };

const rule = (path: string, kind: AreaKind, subtree = false, why?: string): AreaRule => ({
  path, kind, ...(subtree ? { subtree } : {}), ...(why ? { why } : {}),
});

const PERSONAL: AreaRule[] = [
  rule("/", "personal", false, "Today's Dashboard; DW-3a resolves it to the workspace Overview"),
  rule("/account", "personal"),
  rule("/approvals", "personal", true),
  rule("/calendar", "personal"),
  rule("/calendar/new", "personal", false, "DW-8g: schedule a meeting"),
  rule("/calendar/events", "personal", true, "DW-8g: one event, and its edit page"),
  rule("/meetings", "personal", true),
  rule("/timesheets", "personal"),
  rule("/me", "personal"),
  rule("/me/inbox", "personal"),
  rule("/me/mail", "personal", true, "DW-8j: your own Gmail; /me/mail/new and a thread"),
  rule("/me/leave", "personal"),
  rule("/me/loans", "personal", true),
  rule("/me/pay", "personal"),
  rule("/me/tasks", "personal"),
];

const PERFORMANCE: AreaRule[] = [
  rule("/me/learning", "performance", false, "My learning is Performance, not You"),
  rule("/assistant", "performance"),
  rule("/reports/person", "performance"),
  rule("/reports/department", "performance"),
  rule("/reports/team", "performance"),
  rule("/reports/project", "performance"),
  rule("/analytics/activity", "performance", false, "DW-4i: Analytics > My activity, the year map of all work (BFF section 44.9)"),
  rule("/analytics/activity/team", "performance", false, "DW-4i: Analytics > Team activity, for a head"),
  rule("/appraisals", "performance"),
  rule("/appraisals/mine", "performance"),
  rule("/appraisals/department", "performance"),
  rule("/appraisals/[id]", "performance", false, "An appraisal record; /appraisals/cycles beats it (static wins)"),
  rule("/learning", "performance"),
  rule("/learning/authoring", "performance", true),
  rule("/learning/compliance", "performance"),
];

// Records, and lists that more than one area links to: they keep the area the person came from.
const SHARED: AreaRule[] = [
  rule("/tasks", "shared", true, "Task records"),
  rule("/projects/[projectId]", "shared", true, "Project records; /projects/new beats it"),
  rule("/people/[userId]", "shared", true, "Person records; /people/new beats it"),
  rule("/clients", "shared", true, "Linked from Company and the GM's Clients & sales"),
  rule("/client-centre", "shared", true),
  rule("/simulated-psre", "shared", true, "PV5-11: the countersigner's page at the simulated PSrE; reached from a client's billing tab, so it keeps that area"),
  rule("/agency", "shared", true, "Campaigns and leads: Company and the GM both link them"),
  rule("/requests", "shared", true, "My requests, the new-request form and a request record: every workspace links them, and a record keeps the area you came from (DW-5c)"),
  rule("/learning/catalogue", "shared", false, "Company's catalogue and Performance > Learning both link it"),
  rule("/learning/courses", "shared", true),
  rule("/learning/paths", "shared", true),
  rule("/search", "shared"),
  rule("/companies/[companyId]/org", "shared", false, "HR's Org structure tab and Company > Organization both link it"),
];

const COMPANY: AreaRule[] = [
  rule("/departments", "company"),
  rule("/people", "company"),
  rule("/people/new", "company"),
  rule("/organization", "company", true),
  rule("/companies", "company", true),
  rule("/pm", "company"),
  rule("/project-management", "company"),
  rule("/projects", "company"),
  rule("/projects/new", "company"),
  rule("/deliverables", "company", true),
  rule("/knowledge", "company"),
  rule("/agents", "company", true),
  rule("/office", "company", true),
];

const ADMIN: AreaRule[] = [
  rule("/admin", "admin", true),
  rule("/group", "admin", true),
  rule("/rollups", "admin"),
  rule("/systems", "admin", true),
];

// A department's own pages carry its id from the URL; owned routes are generated from the registry.
const WORKSPACE: AreaRule[] = [
  rule("/departments/[deptId]", "workspace", true),
  ...WORKSPACES.flatMap((ws) =>
    ws.ownedRoutes.map((path): AreaRule => ({ path, subtree: true, kind: "workspace", slug: ws.key, why: `owned by the ${ws.label} workspace` })),
  ),
];

export const AREA_RULES: readonly AreaRule[] = [...PERSONAL, ...PERFORMANCE, ...SHARED, ...COMPANY, ...ADMIN, ...WORKSPACE];

// ── Matching ──────────────────────────────────────────────────────────────────────────────────────

const isDynamic = (seg: string) => seg.startsWith("[");
const split = (path: string) => path.split("/").filter(Boolean);

interface Compiled { rule: AreaRule; segs: string[]; statics: number }
const COMPILED: readonly Compiled[] = AREA_RULES.map((r) => {
  const segs = split(r.path);
  return { rule: r, segs, statics: segs.filter((s) => !isDynamic(s)).length };
});

function matches(c: Compiled, target: readonly string[]): boolean {
  if (c.rule.subtree ? target.length < c.segs.length : target.length !== c.segs.length) return false;
  return c.segs.every((s, i) => isDynamic(s) || s === target[i]);
}

/** Next.js's order: more segments, then more static segments, then exact over subtree. Positive = `a` wins. */
function specificity(a: Compiled, b: Compiled): number {
  return a.segs.length - b.segs.length || a.statics - b.statics || Number(!a.rule.subtree) - Number(!b.rule.subtree);
}

function bestCompiled(segments: readonly string[]): Compiled[] {
  const hits = COMPILED.filter((c) => matches(c, segments));
  if (hits.length === 0) return [];
  const top = hits.reduce((best, c) => (specificity(c, best) > 0 ? c : best));
  return hits.filter((c) => specificity(c, top) === 0);
}

/** The best rules for a path (for the test): every rule tied at the top specificity. */
export function bestRules(segments: readonly string[]): AreaRule[] {
  return bestCompiled(segments).map((c) => c.rule);
}

function decode(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/** The area of a concrete pathname. No rule: `shared`. A tie (the test forbids one): the earlier rule. */
export function areaFor(pathname: string): AreaMatch {
  const segments = split(pathname.split(/[?#]/)[0]);
  const best = bestCompiled(segments)[0];
  if (!best) return { kind: "shared" };
  const { rule: r, segs } = best;
  if (r.kind !== "workspace") return { kind: r.kind };
  if (r.slug) return { kind: "workspace", slug: r.slug };
  const i = segs.indexOf("[deptId]");
  return i >= 0 ? { kind: "workspace", deptId: decode(segments[i]) } : { kind: "workspace" };
}

// ── The last-area rule (plan §2.3) ────────────────────────────────────────────────────────────────

/** Workspace, Company and Admin pages are their own area. Personal and Performance pages always keep a
 *  WORKSPACE sidebar (the last one, else `home`). Shared pages keep the last area of any kind. `home` is
 *  the person's own workspace, supplied by the caller. */
export function resolveArea(match: AreaMatch, last: Area | null, home: Area): Area {
  switch (match.kind) {
    case "workspace":
      return { kind: "workspace", ...(match.deptId !== undefined ? { deptId: match.deptId } : {}), ...(match.slug !== undefined ? { slug: match.slug } : {}) };
    case "company": return { kind: "company" };
    case "admin": return { kind: "admin" };
    case "personal":
    case "performance": return last?.kind === "workspace" ? last : home;
    case "shared": return last ?? home;
  }
}

export function sameArea(a: Area, b: Area): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workspace" && b.kind === "workspace") return a.deptId === b.deptId && a.slug === b.slug;
  return true;
}
