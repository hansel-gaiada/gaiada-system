import "server-only";
// SCP-5 W5-C5 (BFF §63.30) — DEMO_MODE's copy of the server's section validation (`platform-nest/.../pipeline/rules.ts`, `validateSection`), so the demo refuses what the server refuses and
// names the same field. It is a port for the demo only: the real page never validates, the server decides. A value is answered normalised (labels trimmed), or the first bad field.
import {
  AUDIT_AUTO_SOURCES, AUTO_CLOSE_CONDITIONS, CHECK_PARTS, PERIODIC_KINDS, SAVED_HOLDS, SHORT_KINDS, STEP_KEYS,
  type AuditBand, type AuditBenchmark, type AuditDimension, type AuditRules, type CheckPart, type CycleAutoClose, type CycleRules, type CycleStepDue, type CycleStepRule,
  type IdeasRules, type PeriodicKind, type ReportDueRule, type ReportKindRules, type ReportsRules, type RulesDoc, type RulesSection, type SavedCategory, type SavedHolds, type SavedRules,
} from "./socialRules";

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
type Obj = Record<string, unknown>;
class Bad extends Error { constructor(readonly field: string) { super(field); } }
const fail = (field: string): never => { throw new Bad(field); };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
function exactly(v: unknown, path: string, keys: readonly string[]): Obj {
  if (!isObj(v)) return fail(path);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`);
  for (const k of keys) if (!(k in v)) fail(`${path}.${k}`);
  return v;
}
function bool(v: unknown, path: string): boolean { if (typeof v !== "boolean") fail(path); return v as boolean; }
function int(v: unknown, path: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) fail(path);
  return v as number;
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(path);
  return v as T;
}
function text(v: unknown, path: string, max: number): string {
  if (typeof v !== "string") fail(path);
  const t = (v as string).trim();
  // eslint-disable-next-line no-control-regex
  if (t.length < 1 || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) fail(path);
  return t;
}
function list(v: unknown, path: string, lo: number, hi: number): unknown[] { if (!Array.isArray(v) || v.length < lo || v.length > hi) fail(path); return v as unknown[]; }
function key(v: unknown, path: string, seen: Set<string>): string {
  if (typeof v !== "string" || !KEY_RE.test(v) || seen.has(v)) fail(path);
  seen.add(v as string);
  return v as string;
}
function distinct<T extends string>(v: unknown, path: string, allowed: readonly T[]): T[] {
  const out: T[] = [];
  for (const x of list(v, path, 0, allowed.length)) {
    if (typeof x !== "string" || !(allowed as readonly string[]).includes(x) || out.includes(x as T)) fail(path);
    out.push(x as T);
  }
  return out;
}

function validateDue(kind: PeriodicKind, v: unknown, path: string): ReportDueRule {
  if (!isObj(v)) return fail(path);
  if (v.rule === "working_days_after") { const o = exactly(v, path, ["rule", "n"]); return { rule: "working_days_after", n: int(o.n, `${path}.n`, 0, 30) }; }
  if (v.rule === "weekday" && kind === "weekly") {
    const o = exactly(v, path, ["rule", "weekday", "week"]);
    return { rule: "weekday", weekday: int(o.weekday, `${path}.weekday`, 1, 7), week: oneOf(o.week, `${path}.week`, ["same", "next"] as const) };
  }
  if (v.rule === "report_due_day" && !SHORT_KINDS.includes(kind)) { exactly(v, path, ["rule"]); return { rule: "report_due_day" }; }
  return fail(path);
}

function validateKind(kind: PeriodicKind, v: unknown, path: string): ReportKindRules {
  const o = exactly(v, path, ["enabled", "due", "freezeAt", "content", "checkRequires", "aiDrafting"]);
  const cp = `${path}.content`;
  const c = exactly(o.content, cp, ["narrative", "nextPeriodLine", "notes", "actionPlan"]);
  const n = exactly(c.narrative, `${cp}.narrative`, ["max"]);
  const max = n.max === null ? null : int(n.max, `${cp}.narrative.max`, 100, 10_000);
  const nextPeriodLine = bool(c.nextPeriodLine, `${cp}.nextPeriodLine`);
  if (nextPeriodLine && !SHORT_KINDS.includes(kind)) fail(`${cp}.nextPeriodLine`);
  const notes = exactly(c.notes, `${cp}.notes`, ["areas"]);
  const seen = new Set<string>();
  const areas = list(notes.areas, `${cp}.notes.areas`, 0, 6).map((a, i) => {
    const ap = `${cp}.notes.areas.${i}`;
    const ao = exactly(a, ap, ["key", "label"]);
    return { key: key(ao.key, `${ap}.key`, seen), label: text(ao.label, `${ap}.label`, 60) };
  });
  const ap = exactly(c.actionPlan, `${cp}.actionPlan`, ["enabled", "max"]);
  const actionPlan = { enabled: bool(ap.enabled, `${cp}.actionPlan.enabled`), max: int(ap.max, `${cp}.actionPlan.max`, 1, 20) };
  const checkRequires: CheckPart[] = distinct(o.checkRequires, `${path}.checkRequires`, CHECK_PARTS);
  for (const part of checkRequires) {
    const on = part === "narrative" || (part === "notes" && areas.length > 0) || (part === "actionPlan" && actionPlan.enabled) || (part === "nextPeriodLine" && nextPeriodLine);
    if (!on) fail(`${path}.checkRequires`);
  }
  return {
    enabled: bool(o.enabled, `${path}.enabled`), due: validateDue(kind, o.due, `${path}.due`), freezeAt: oneOf(o.freezeAt, `${path}.freezeAt`, ["create", "submit"] as const),
    content: { narrative: { max }, nextPeriodLine, notes: { areas }, actionPlan }, checkRequires, aiDrafting: bool(o.aiDrafting, `${path}.aiDrafting`),
  };
}

function validateReports(v: unknown): ReportsRules {
  const o = exactly(v, "reports", ["fiscalYearStartMonth", "kinds"]);
  const k = exactly(o.kinds, "reports.kinds", PERIODIC_KINDS);
  const kinds = {} as Record<PeriodicKind, ReportKindRules>;
  for (const kind of PERIODIC_KINDS) kinds[kind] = validateKind(kind, k[kind], `reports.kinds.${kind}`);
  return { fiscalYearStartMonth: int(o.fiscalYearStartMonth, "reports.fiscalYearStartMonth", 1, 12), kinds };
}

function validateIdeas(v: unknown): IdeasRules {
  const o = exactly(v, "ideas", ["metricRequired", "sharedInMonthlyReport"]);
  return { metricRequired: bool(o.metricRequired, "ideas.metricRequired"), sharedInMonthlyReport: bool(o.sharedInMonthlyReport, "ideas.sharedInMonthlyReport") };
}

const TITLE_TOKEN_RE = /\{month(?:-[1-3])?\}/g;

function validateCycle(v: unknown): CycleRules {
  const o = exactly(v, "cycle", ["steps"]);
  const seen = new Set<string>();
  const steps = list(o.steps, "cycle.steps", 1, 12).map((s, i): CycleStepRule => {
    const p = `cycle.steps.${i}`;
    const so = exactly(s, p, ["key", "title", "due", "autoClose"]);
    const k = key(so.key, `${p}.key`, seen);
    const title = text(so.title, `${p}.title`, 200);
    if (/[{}]/.test(title.replace(TITLE_TOKEN_RE, ""))) fail(`${p}.title`);
    let due: CycleStepDue;
    const d = so.due;
    if (isObj(d) && d.rule === "ready_by") {
      const dd = exactly(d, `${p}.due`, ["rule", "lessEstimatesFrom", "lessWorkingDays"]);
      due = { rule: "ready_by", lessEstimatesFrom: dd.lessEstimatesFrom === null ? null : oneOf(dd.lessEstimatesFrom, `${p}.due.lessEstimatesFrom`, STEP_KEYS), lessWorkingDays: int(dd.lessWorkingDays, `${p}.due.lessWorkingDays`, 0, 30) };
    } else if (isObj(d) && d.rule === "report_due_day") {
      const dd = exactly(d, `${p}.due`, ["rule", "monthOffset"]);
      due = { rule: "report_due_day", monthOffset: int(dd.monthOffset, `${p}.due.monthOffset`, -3, 0) };
    } else if (isObj(d) && d.rule === "none") {
      exactly(d, `${p}.due`, ["rule"]);
      due = { rule: "none" };
    } else {
      return fail(`${p}.due`);
    }
    let autoClose: CycleAutoClose;
    const a = so.autoClose;
    if (isObj(a) && a.rule === "manual") { exactly(a, `${p}.autoClose`, ["rule"]); autoClose = { rule: "manual" }; }
    else if (isObj(a) && a.rule === "report_delivered") {
      const ao = exactly(a, `${p}.autoClose`, ["rule", "reportMonthOffset"]);
      autoClose = { rule: "report_delivered", reportMonthOffset: int(ao.reportMonthOffset, `${p}.autoClose.reportMonthOffset`, -3, 0) };
    } else if (isObj(a) && typeof a.rule === "string" && (AUTO_CLOSE_CONDITIONS as readonly string[]).includes(a.rule)) {
      exactly(a, `${p}.autoClose`, ["rule"]);
      autoClose = { rule: a.rule as (typeof AUTO_CLOSE_CONDITIONS)[number] };
    } else {
      return fail(`${p}.autoClose`);
    }
    return { key: k, title, due, autoClose };
  });
  return { steps };
}

function validateAudit(v: unknown): AuditRules {
  const o = exactly(v, "audit", ["dimensions", "bands", "benchmark"]);
  const seen = new Set<string>();
  const autos = new Set<string>();
  const dimensions = list(o.dimensions, "audit.dimensions", 1, 20).map((d, i): AuditDimension => {
    const p = `audit.dimensions.${i}`;
    const dd = exactly(d, p, ["key", "label", "weight", "source", "advice"]);
    const w = dd.weight;
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 10 || Math.round(w * 100) !== w * 100) fail(`${p}.weight`);
    const source = oneOf(dd.source, `${p}.source`, ["typed", ...AUDIT_AUTO_SOURCES] as const);
    if (source !== "typed") { if (autos.has(source)) fail(`${p}.source`); autos.add(source); }
    return { key: key(dd.key, `${p}.key`, seen), label: text(dd.label, `${p}.label`, 80), weight: w as number, source, advice: text(dd.advice, `${p}.advice`, 300) };
  });
  if (!dimensions.some((d) => d.weight > 0)) fail("audit.dimensions");
  const bandKeys = new Set<string>();
  const bands = list(o.bands, "audit.bands", 2, 5).map((b, i): AuditBand => {
    const p = `audit.bands.${i}`;
    const bb = exactly(b, p, ["key", "label", "from"]);
    return { key: key(bb.key, `${p}.key`, bandKeys), label: text(bb.label, `${p}.label`, 60), from: int(bb.from, `${p}.from`, 0, 100) };
  });
  for (let i = 1; i < bands.length; i++) if (bands[i].from >= bands[i - 1].from) fail("audit.bands");
  if (bands[bands.length - 1].from !== 0) fail("audit.bands");
  let benchmark: AuditBenchmark;
  const bm = o.benchmark;
  if (isObj(bm) && bm.source === "own_clients_median") { exactly(bm, "audit.benchmark", ["source"]); benchmark = { source: "own_clients_median" }; }
  else if (isObj(bm) && bm.source === "typed") {
    const bo = exactly(bm, "audit.benchmark", ["source", "rates"]);
    if (!isObj(bo.rates)) fail("audit.benchmark.rates");
    const entries = Object.entries(bo.rates as Obj);
    if (entries.length < 1 || entries.length > 50) fail("audit.benchmark.rates");
    const rates: Record<string, number> = {};
    for (const [type, rate] of entries) {
      const t = type.trim();
      if (t.length < 1 || t.length > 60 || t in rates) fail("audit.benchmark.rates");
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) fail(`audit.benchmark.rates.${t}`);
      rates[t] = rate as number;
    }
    benchmark = { source: "typed", rates };
  } else {
    return fail("audit.benchmark");
  }
  return { dimensions, bands, benchmark };
}

const DERIVED: Readonly<Record<string, readonly SavedHolds[]>> = { photos: ["asset", "link"], posts: [], hashtags: [] };

function validateSaved(v: unknown): SavedRules {
  const o = exactly(v, "saved", ["categories"]);
  const derivedKeys = Object.keys(DERIVED);
  const seen = new Set<string>(["other"]);
  const categories = list(o.categories, "saved.categories", derivedKeys.length, 12 + derivedKeys.length).map((x, i): SavedCategory => {
    const p = `saved.categories.${i}`;
    const co = exactly(x, p, ["key", "label", "holds", "enabled"]);
    const k = key(co.key, `${p}.key`, seen);
    const holds = distinct(co.holds, `${p}.holds`, SAVED_HOLDS);
    const fixed = DERIVED[k];
    if (fixed) { if (holds.length !== fixed.length || !holds.every((h) => fixed.includes(h))) fail(`${p}.holds`); }
    else if (holds.length === 0) fail(`${p}.holds`);
    return { key: k, label: text(co.label, `${p}.label`, 60), holds, enabled: bool(co.enabled, `${p}.enabled`) };
  });
  for (const k of derivedKeys) if (!categories.some((c) => c.key === k)) fail("saved.categories");
  if (categories.filter((c) => !DERIVED[c.key]).length > 12) fail("saved.categories");
  return { categories };
}

const VALIDATORS: { [S in RulesSection]: (v: unknown) => RulesDoc[S] } = { reports: validateReports, ideas: validateIdeas, cycle: validateCycle, audit: validateAudit, saved: validateSaved };

/** One section's value, validated and normalised, or the first bad field as `'<section>.<path>'`. */
export function demoValidateSection<S extends RulesSection>(section: S, value: unknown): { ok: true; value: RulesDoc[S] } | { ok: false; field: string } {
  try {
    return { ok: true, value: VALIDATORS[section](value) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, field: e.field };
    throw e;
  }
}
