// SCP-5 W5-A0 — the company rules core (FRONTEND-BFF-CONTRACT §63.30, SCP-Q41): the seed, the typed document, each section's
// validation, the read-through reader, the `rules_ref` a record keeps, the versioned save and the history.
//
// EVERY LATER WAVE-5 TICKET READS ITS RULES THROUGH THIS FILE. Nothing in social/ may hard-code a rule §63.30.1 names.
//
// ── THE INTERFACE (what the other lanes call) ─────────────────────────────────────────────────────────────────────────
//   Reading, inside the caller's `withTenants([tenantId], …, { modules: ["social"] })` transaction:
//     socialRules(c, tenantId): Promise<CompanyRules>
//         The company's rules in force now. Read-through: a company with no saved version reads the seed as version 0
//         (`ref` 'default:<defaultsVersion>'). Memoised for the HTTP request (core/request-context.ts `memoiseInRequest`).
//     rulesByRef(c, tenantId, ref): Promise<CompanyRules>
//         The rules a record was made under, from its `rules_ref` ('company:<version>' or 'default:<defaultsVersion>').
//         'default:scp-5a' (the constant every row made before this file carries) reads as the seed, whose monthly kind is
//         SCP-5a's as built. An unknown ref is a 500 `rules_ref_unknown` (a stored ref the server cannot read is a data fault).
//     rulesRefFor(rules: CompanyRules): string
//         The `rules_ref` to store on a new record (a report, a run, an audit, a cycle) made under `rules`.
//   Typed getters over a document (`CompanyRules.rules`), pure:
//     reportKindRules(rules: RulesDoc, kind: PeriodicKind): ReportKindRules
//     enabledReportKinds(rules: RulesDoc): PeriodicKind[]
//     fiscalYearStartMonth(rules: RulesDoc): number
//     cycleSteps(rules: RulesDoc): CycleStepRule[]
//     auditScorecard(rules: RulesDoc): AuditRules
//     auditBandFor(scorecard: AuditRules, overall: number | null): AuditBand | null
//     savedCategories(rules: RulesDoc, opts?: { enabledOnly?: boolean }): SavedCategoryView[]
//     ideasSettings(rules: RulesDoc): IdeasRules
//   The period and due-date maths those rules drive are in `rules-periods.ts` (periodOf, periodRange, reportDueDate,
//   cycleStepDueDate, cycleStepTitle).
//
// ── THE DOCUMENT ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Five sections, `reports`, `ideas`, `cycle`, `audit`, `saved`, each always whole (a save replaces one section and copies the
// other four). The onboarding template is a PM template (63.29) and report automation is its own data (63.24.9): neither is
// in this document. Who may act, the one-report-per-period rule, drafting-only AI and a schedule's owner are NOT settings
// (63.30.2): the validator has no key for them, and an unknown key is 400 `invalid_field` naming it.
//
// ── VALIDATION ────────────────────────────────────────────────────────────────────────────────────────────────────────
// `validateSection(section, value)` answers a normalised copy (labels trimmed) or throws 400 `invalid_field` with
// `field: '<section>.<path>'` (array items by index, e.g. `cycle.steps.2.title`): an unknown or missing key, a value out of
// its range, a repeated key, bands out of order, a due rule the kind cannot take, a `checkRequires` part the content turns
// off, a category that holds nothing. The seed itself is validated at load, so a bad seed fails the boot.
//
// ── VERSIONS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// `social_rule_versions` (202610301000_social_rules.sql) is append-only, one row per save, consecutive per company. A save
// takes `pg_advisory_xact_lock` on 'social_rules:<tenantId>', compares `expectedVersion` (409 `rules_changed`
// `{detail: {currentVersion}}` when another save came first) and writes version + 1 with the whole document.
import { BadRequestException, ConflictException, InternalServerErrorException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../../config";
import { forgetInRequest, memoiseInRequest } from "../../../core/request-context";
import { declareSocialModuleScope } from "../module-scope";
import { STEP_KEYS, type StepKey } from "./schedule-health";
import seedJson from "../social-rules-defaults.json";

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RULES_SECTIONS = ["reports", "ideas", "cycle", "audit", "saved"] as const;
export type RulesSection = (typeof RULES_SECTIONS)[number];

export const PERIODIC_KINDS = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"] as const;
export type PeriodicKind = (typeof PERIODIC_KINDS)[number];
/** Written during or just after their period; the only kinds the `next_period` column admits (63.24.2). */
export const SHORT_KINDS: readonly PeriodicKind[] = ["daily", "weekly"];
export const LONG_KINDS: readonly PeriodicKind[] = ["monthly", "quarterly", "semester", "yearly"];

export type ReportDueRule =
  | { rule: "working_days_after"; n: number }
  | { rule: "weekday"; weekday: number; week: "same" | "next" }
  | { rule: "report_due_day" };
export const CHECK_PARTS = ["narrative", "notes", "actionPlan", "nextPeriodLine"] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];
export interface NoteAreaRule { key: string; label: string }
export interface ReportKindRules {
  enabled: boolean;
  due: ReportDueRule;
  freezeAt: "create" | "submit";
  content: {
    narrative: { max: number | null };
    nextPeriodLine: boolean;
    notes: { areas: NoteAreaRule[] };
    actionPlan: { enabled: boolean; max: number };
  };
  checkRequires: CheckPart[];
  aiDrafting: boolean;
}
export interface ReportsRules { fiscalYearStartMonth: number; kinds: Record<PeriodicKind, ReportKindRules> }

export interface IdeasRules { metricRequired: boolean; sharedInMonthlyReport: boolean }

export type CycleStepDue =
  | { rule: "ready_by"; lessEstimatesFrom: StepKey | null; lessWorkingDays: number }
  | { rule: "report_due_day"; monthOffset: number }
  | { rule: "none" };
/** The fixed menu of close conditions (code, 63.30.2: a company picks, it cannot write one). */
export const AUTO_CLOSE_CONDITIONS = ["plan_laid_out", "copy_locked", "artwork_done", "client_approved", "all_scheduled"] as const;
export type CycleAutoClose =
  | { rule: "manual" }
  | { rule: "report_delivered"; reportMonthOffset: number }
  | { rule: (typeof AUTO_CLOSE_CONDITIONS)[number] };
export interface CycleStepRule { key: string; title: string; due: CycleStepDue; autoClose: CycleAutoClose }
export interface CycleRules { steps: CycleStepRule[] }

/** The six automatic audit computations of 63.28.1 (code: a company picks from them). */
export const AUDIT_AUTO_SOURCES = ["consistency", "format_mix", "engagement_rate", "reels", "stories", "boosting"] as const;
export type AuditSource = "typed" | (typeof AUDIT_AUTO_SOURCES)[number];
export interface AuditDimension { key: string; label: string; weight: number; source: AuditSource; advice: string }
export interface AuditBand { key: string; label: string; from: number }
export type AuditBenchmark = { source: "own_clients_median" } | { source: "typed"; rates: Record<string, number> };
export interface AuditRules { dimensions: AuditDimension[]; bands: AuditBand[]; benchmark: AuditBenchmark }

export const SAVED_HOLDS = ["asset", "link", "text"] as const;
export type SavedHolds = (typeof SAVED_HOLDS)[number];
/** The three categories read from elsewhere (63.26): renamed, reordered or hidden, never removed; what they hold is fixed. */
export const DERIVED_SAVED_CATEGORIES: Readonly<Record<string, readonly SavedHolds[]>> = { photos: ["asset", "link"], posts: [], hashtags: [] };
/** Where items of a removed category show (63.26.1): never a category key. */
export const SAVED_OTHER_KEY = "other";
export interface SavedCategory { key: string; label: string; holds: SavedHolds[]; enabled: boolean }
export interface SavedCategoryView extends SavedCategory { derived: boolean }
export interface SavedRules { categories: SavedCategory[] }

export interface RulesDoc { reports: ReportsRules; ideas: IdeasRules; cycle: CycleRules; audit: AuditRules; saved: SavedRules }

/** The rules in force for a company, or the rules a record was made under. */
export interface CompanyRules {
  /** 'company:<version>' or 'default:<defaultsVersion>': what a new record stores in `rules_ref`. */
  ref: string;
  /** 0 for the seed. */
  version: number;
  /** The seed the version was made against (the seed itself for version 0). */
  defaultsVersion: string;
  rules: RulesDoc;
  /** When the version took effect; null for the seed. */
  effectiveFrom: string | null;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
type Obj = Record<string, unknown>;

function fail(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
/** `v` as an object holding exactly `keys`: an unknown key or a missing one is refused by its own path. */
function exactly(v: unknown, path: string, keys: readonly string[]): Obj {
  if (!isObj(v)) fail(path);
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${path}.${k}`);
  for (const k of keys) if (!(k in v)) fail(`${path}.${k}`);
  return v;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path);
  return v;
}
function int(v: unknown, path: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) fail(path);
  return v;
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(path);
  return v as T;
}
/** A label: a string, trimmed, 1 to `max` characters, no control characters. */
function text(v: unknown, path: string, max: number): string {
  if (typeof v !== "string") fail(path);
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  if (t.length < 1 || t.length > max || /[\u0000-\u001f\u007f]/.test(t)) fail(path);
  return t;
}
function list(v: unknown, path: string, lo: number, hi: number): unknown[] {
  if (!Array.isArray(v) || v.length < lo || v.length > hi) fail(path);
  return v;
}
function key(v: unknown, path: string, seen: Set<string>): string {
  if (typeof v !== "string" || !KEY_RE.test(v) || seen.has(v)) fail(path);
  seen.add(v);
  return v;
}
/** Distinct members of `allowed`, in the order sent. */
function distinct<T extends string>(v: unknown, path: string, allowed: readonly T[]): T[] {
  const arr = list(v, path, 0, allowed.length);
  const out: T[] = [];
  for (const x of arr) {
    if (typeof x !== "string" || !(allowed as readonly string[]).includes(x) || out.includes(x as T)) fail(path);
    out.push(x as T);
  }
  return out;
}

function validateDue(kind: PeriodicKind, v: unknown, path: string): ReportDueRule {
  if (!isObj(v)) fail(path);
  const rule = v.rule;
  if (rule === "working_days_after") {
    const o = exactly(v, path, ["rule", "n"]);
    return { rule, n: int(o.n, `${path}.n`, 0, 30) };
  }
  if (rule === "weekday" && kind === "weekly") {
    const o = exactly(v, path, ["rule", "weekday", "week"]);
    return { rule, weekday: int(o.weekday, `${path}.weekday`, 1, 7), week: oneOf(o.week, `${path}.week`, ["same", "next"] as const) };
  }
  if (rule === "report_due_day" && LONG_KINDS.includes(kind)) {
    exactly(v, path, ["rule"]);
    return { rule };
  }
  return fail(path); // a rule this kind cannot take, or none
}

function validateKind(kind: PeriodicKind, v: unknown, path: string): ReportKindRules {
  const o = exactly(v, path, ["enabled", "due", "freezeAt", "content", "checkRequires", "aiDrafting"]);
  const cp = `${path}.content`;
  const c = exactly(o.content, cp, ["narrative", "nextPeriodLine", "notes", "actionPlan"]);
  const n = exactly(c.narrative, `${cp}.narrative`, ["max"]);
  const max = n.max === null ? null : int(n.max, `${cp}.narrative.max`, 100, 10_000);
  const nextPeriodLine = bool(c.nextPeriodLine, `${cp}.nextPeriodLine`);
  // The `next_period` column admits the short kinds only (63.24.2, social_reports_next_period_ck): a structural limit.
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
  const checkRequires = distinct(o.checkRequires, `${path}.checkRequires`, CHECK_PARTS);
  for (const part of checkRequires) {
    const on = part === "narrative" || (part === "notes" && areas.length > 0) || (part === "actionPlan" && actionPlan.enabled)
      || (part === "nextPeriodLine" && nextPeriodLine);
    if (!on) fail(`${path}.checkRequires`);
  }
  return {
    enabled: bool(o.enabled, `${path}.enabled`),
    due: validateDue(kind, o.due, `${path}.due`),
    freezeAt: oneOf(o.freezeAt, `${path}.freezeAt`, ["create", "submit"] as const),
    content: { narrative: { max }, nextPeriodLine, notes: { areas }, actionPlan },
    checkRequires,
    aiDrafting: bool(o.aiDrafting, `${path}.aiDrafting`),
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

/** `{month}` and `{month-1}` to `{month-3}` are the title's only tokens. */
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
      due = {
        rule: "ready_by",
        lessEstimatesFrom: dd.lessEstimatesFrom === null ? null : oneOf(dd.lessEstimatesFrom, `${p}.due.lessEstimatesFrom`, STEP_KEYS),
        lessWorkingDays: int(dd.lessWorkingDays, `${p}.due.lessWorkingDays`, 0, 30),
      };
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
    if (isObj(a) && a.rule === "manual") {
      exactly(a, `${p}.autoClose`, ["rule"]);
      autoClose = { rule: "manual" };
    } else if (isObj(a) && a.rule === "report_delivered") {
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
    // 0 to 10, at most two decimals.
    if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 10 || Math.round(w * 100) !== w * 100) fail(`${p}.weight`);
    const source = oneOf(dd.source, `${p}.source`, ["typed", ...AUDIT_AUTO_SOURCES] as const);
    if (source !== "typed") {
      if (autos.has(source)) fail(`${p}.source`);
      autos.add(source);
    }
    return { key: key(dd.key, `${p}.key`, seen), label: text(dd.label, `${p}.label`, 80), weight: w as number, source, advice: text(dd.advice, `${p}.advice`, 300) };
  });
  if (!dimensions.some((d) => d.weight > 0)) fail("audit.dimensions");
  const bandKeys = new Set<string>();
  const bands = list(o.bands, "audit.bands", 2, 5).map((b, i): AuditBand => {
    const p = `audit.bands.${i}`;
    const bb = exactly(b, p, ["key", "label", "from"]);
    return { key: key(bb.key, `${p}.key`, bandKeys), label: text(bb.label, `${p}.label`, 60), from: int(bb.from, `${p}.from`, 0, 100) };
  });
  // Highest first, strictly descending, and the last from 0, so every score has exactly one band.
  for (let i = 1; i < bands.length; i++) if (bands[i].from >= bands[i - 1].from) fail("audit.bands");
  if (bands[bands.length - 1].from !== 0) fail("audit.bands");
  let benchmark: AuditBenchmark;
  const bm = o.benchmark;
  if (isObj(bm) && bm.source === "own_clients_median") {
    exactly(bm, "audit.benchmark", ["source"]);
    benchmark = { source: "own_clients_median" };
  } else if (isObj(bm) && bm.source === "typed") {
    const bo = exactly(bm, "audit.benchmark", ["source", "rates"]);
    if (!isObj(bo.rates)) fail("audit.benchmark.rates");
    const entries = Object.entries(bo.rates);
    if (entries.length < 1 || entries.length > 50) fail("audit.benchmark.rates");
    const rates: Record<string, number> = {};
    for (const [type, rate] of entries) {
      const t = type.trim();
      // A business type as `social_audits.business_type` holds it (<= 60); an engagement rate is a fraction (63.10's rule).
      if (t.length < 1 || t.length > 60 || t in rates) fail("audit.benchmark.rates");
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) fail(`audit.benchmark.rates.${t}`);
      rates[t] = rate;
    }
    benchmark = { source: "typed", rates };
  } else {
    return fail("audit.benchmark");
  }
  return { dimensions, bands, benchmark };
}

function validateSaved(v: unknown): SavedRules {
  const o = exactly(v, "saved", ["categories"]);
  const derivedKeys = Object.keys(DERIVED_SAVED_CATEGORIES);
  const seen = new Set<string>([SAVED_OTHER_KEY]);
  const categories = list(o.categories, "saved.categories", derivedKeys.length, 12 + derivedKeys.length).map((x, i): SavedCategory => {
    const p = `saved.categories.${i}`;
    const co = exactly(x, p, ["key", "label", "holds", "enabled"]);
    const k = key(co.key, `${p}.key`, seen);
    const holds = distinct(co.holds, `${p}.holds`, SAVED_HOLDS);
    const fixed = DERIVED_SAVED_CATEGORIES[k];
    if (fixed) {
      if (holds.length !== fixed.length || !holds.every((h) => fixed.includes(h))) fail(`${p}.holds`);
    } else if (holds.length === 0) {
      fail(`${p}.holds`); // a category that holds nothing
    }
    return { key: k, label: text(co.label, `${p}.label`, 60), holds, enabled: bool(co.enabled, `${p}.enabled`) };
  });
  for (const k of derivedKeys) if (!categories.some((c) => c.key === k)) fail("saved.categories");
  if (categories.filter((c) => !DERIVED_SAVED_CATEGORIES[c.key]).length > 12) fail("saved.categories");
  return { categories };
}

const VALIDATORS: { [S in RulesSection]: (v: unknown) => RulesDoc[S] } = {
  reports: validateReports, ideas: validateIdeas, cycle: validateCycle, audit: validateAudit, saved: validateSaved,
};

export function isRulesSection(s: unknown): s is RulesSection {
  return typeof s === "string" && (RULES_SECTIONS as readonly string[]).includes(s);
}

/** PURE. One section's value, validated and normalised, or 400 `invalid_field` `{field: '<section>.<path>'}`. */
export function validateSection<S extends RulesSection>(section: S, value: unknown): RulesDoc[S] {
  return VALIDATORS[section](value);
}

/** PURE. A whole document (the five sections, nothing else), validated. */
export function validateRulesDoc(v: unknown): RulesDoc {
  const o = exactly(v, "rules", RULES_SECTIONS);
  return {
    reports: validateReports(o.reports), ideas: validateIdeas(o.ideas), cycle: validateCycle(o.cycle), audit: validateAudit(o.audit),
    saved: validateSaved(o.saved),
  };
}

// ── The seed ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Load and validate a seed file's object: its `defaultsVersion` and its five sections (`_about` is prose). A bad seed throws. */
export function loadSeed(raw: unknown): { defaultsVersion: string; rules: RulesDoc } {
  if (!isObj(raw)) throw new Error("social-rules-defaults.json: not an object");
  const { _about: _a, defaultsVersion, ...sections } = raw;
  if (typeof defaultsVersion !== "string" || !DEFAULTS_VERSION_RE.test(defaultsVersion)) {
    throw new Error("social-rules-defaults.json: defaultsVersion is missing or malformed");
  }
  try {
    return { defaultsVersion, rules: validateRulesDoc(sections) };
  } catch (e) {
    const field = e instanceof BadRequestException ? (e.getResponse() as { field?: string }).field : String(e);
    throw new Error(`social-rules-defaults.json is invalid at ${field}`);
  }
}

const DEFAULTS_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const SEED = loadSeed(seedJson);
/** The seed's version (`defaultsVersion`), named in 'default:<…>' refs and in `social_rule_versions.defaults_version`. */
export const DEFAULTS_VERSION: string = SEED.defaultsVersion;
/** The seed document: version 0 of every company. */
export const DEFAULT_RULES: RulesDoc = SEED.rules;
/** The constant every `social_reports` and `social_cycles` row made before the rules existed carries (63.30.3). */
export const LEGACY_RULES_REF = "default:scp-5a";
/**
 * Every seed a record may name. 'scp-5a' reads as the first seed, whose monthly kind is SCP-5a's as built (pinned by
 * rules.test.ts). When the seed changes, the previous document stays here under its own version, so no record's rules move.
 */
export const DEFAULTS_ARCHIVE: Readonly<Record<string, RulesDoc>> = { [DEFAULTS_VERSION]: DEFAULT_RULES, "scp-5a": DEFAULT_RULES };

// ── Refs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The shape every `rules_ref` CHECK holds (social_reports, social_cycles here; social_audits, social_report_runs in W5-B1/A1). */
export const RULES_REF_RE = /^(company:[1-9][0-9]{0,9}|default:[A-Za-z0-9][A-Za-z0-9._-]{0,59})$/;

/** The `rules_ref` a new record made under `rules` stores. */
export function rulesRefFor(rules: Pick<CompanyRules, "ref">): string {
  return rules.ref;
}

export function parseRulesRef(ref: string): { kind: "company"; version: number } | { kind: "default"; defaultsVersion: string } | null {
  if (typeof ref !== "string" || !RULES_REF_RE.test(ref)) return null;
  return ref.startsWith("company:") ? { kind: "company", version: Number(ref.slice(8)) } : { kind: "default", defaultsVersion: ref.slice(8) };
}

const seedRules = (): CompanyRules => ({ ref: `default:${DEFAULTS_VERSION}`, version: 0, defaultsVersion: DEFAULTS_VERSION, rules: DEFAULT_RULES, effectiveFrom: null });

interface VersionRow { version: number; rules: RulesDoc; defaults_version: string; effective_from: string }
const companyRules = (r: VersionRow): CompanyRules => ({
  ref: `company:${r.version}`, version: Number(r.version), defaultsVersion: r.defaults_version, rules: r.rules,
  effectiveFrom: new Date(r.effective_from).toISOString(),
});
const memoPrefix = (tenantId: string): string => `social_rules:${tenantId.toLowerCase()}:`;

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The latest version row, read in the caller's transaction (no memo). */
async function readLatest(c: PoolClient, tenantId: string): Promise<CompanyRules> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<VersionRow>(
    `SELECT version, rules, defaults_version, effective_from FROM social_rule_versions WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0] ? companyRules(rows[0]) : seedRules();
}

/** The company's rules in force now (see the header). In the caller's transaction; memoised for the request. */
export function socialRules(c: PoolClient, tenantId: string): Promise<CompanyRules> {
  return memoiseInRequest(`${memoPrefix(tenantId)}current`, () => readLatest(c, tenantId));
}

/** The rules a record was made under, from its `rules_ref` (see the header). In the caller's transaction; memoised for the request. */
export function rulesByRef(c: PoolClient, tenantId: string, ref: string): Promise<CompanyRules> {
  const parsed = parseRulesRef(ref);
  if (!parsed) return Promise.reject(new InternalServerErrorException({ message: "rules_ref_unknown" }));
  if (parsed.kind === "default") {
    const doc = DEFAULTS_ARCHIVE[parsed.defaultsVersion];
    if (!doc) return Promise.reject(new InternalServerErrorException({ message: "rules_ref_unknown" }));
    return Promise.resolve({ ref, version: 0, defaultsVersion: parsed.defaultsVersion, rules: doc, effectiveFrom: null });
  }
  return memoiseInRequest(`${memoPrefix(tenantId)}${ref}`, async () => {
    await declareSocialModuleScope(c);
    const { rows } = await c.query<VersionRow>(
      `SELECT version, rules, defaults_version, effective_from FROM social_rule_versions WHERE tenant_id = $1 AND version = $2`,
      [tenantId, parsed.version],
    );
    if (!rows[0]) throw new InternalServerErrorException({ message: "rules_ref_unknown" });
    return companyRules(rows[0]);
  });
}

// ── Typed getters ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const reportKindRules = (rules: RulesDoc, kind: PeriodicKind): ReportKindRules => rules.reports.kinds[kind];
export const enabledReportKinds = (rules: RulesDoc): PeriodicKind[] => PERIODIC_KINDS.filter((k) => rules.reports.kinds[k].enabled);
export const fiscalYearStartMonth = (rules: RulesDoc): number => rules.reports.fiscalYearStartMonth;
export const cycleSteps = (rules: RulesDoc): CycleStepRule[] => rules.cycle.steps;
export const auditScorecard = (rules: RulesDoc): AuditRules => rules.audit;
export const ideasSettings = (rules: RulesDoc): IdeasRules => rules.ideas;

/** The band an overall score (0 to 100) falls in: the first band whose `from` it reaches. Null for no score. */
export function auditBandFor(scorecard: AuditRules, overall: number | null): AuditBand | null {
  if (overall === null || !Number.isFinite(overall)) return null;
  return scorecard.bands.find((b) => overall >= b.from) ?? scorecard.bands[scorecard.bands.length - 1] ?? null;
}

/** The company's Saved categories in their order, each marked `derived` (read from elsewhere); `enabledOnly` drops the hidden ones. */
export function savedCategories(rules: RulesDoc, opts: { enabledOnly?: boolean } = {}): SavedCategoryView[] {
  return rules.saved.categories
    .filter((c) => !opts.enabledOnly || c.enabled)
    .map((c) => ({ ...c, derived: DERIVED_SAVED_CATEGORIES[c.key] !== undefined }));
}

// ── Diff ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RulesDiffEntry { path: string; from: unknown; to: unknown }

/** PURE. The leaf changes from `a` to `b` under `path`: objects by key, arrays of equal length by index, anything else whole. */
export function diffRules(a: unknown, b: unknown, path: string): RulesDiffEntry[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffRules(a[k], b[k], `${path}.${k}`));
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    return a.flatMap((x, i) => diffRules(x, b[i], `${path}.${i}`));
  }
  return [{ path, from: a === undefined ? null : a, to: b === undefined ? null : b }];
}

// ── Saving ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One save, in the caller's transaction (`withTenants([tenantId], …, { modules: ["social"] })`): the company's lock, the
 * `expectedVersion` check (409 `rules_changed` `{detail: {currentVersion}}`), then version + 1 holding the whole document with
 * `section` replaced by `value` (already validated) or, with `reset`, by the seed's. Answers the new version and the section's diff.
 */
export async function saveRulesSectionInTx(
  c: PoolClient,
  a: { tenantId: string; actorId: string; section: RulesSection; expectedVersion: number; value?: unknown; reset: boolean },
): Promise<{ version: number; diff: RulesDiffEntry[] }> {
  await declareSocialModuleScope(c);
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`social_rules:${a.tenantId.toLowerCase()}`]);
  const current = await readLatest(c, a.tenantId);
  if (current.version !== a.expectedVersion) {
    throw new ConflictException({ message: "rules_changed", detail: { currentVersion: current.version } });
  }
  const nextSection = a.reset ? DEFAULT_RULES[a.section] : a.value;
  const next: RulesDoc = { ...current.rules, [a.section]: nextSection };
  const version = current.version + 1;
  await c.query(
    `INSERT INTO social_rule_versions (tenant_id, version, rules, section, reset, defaults_version, edited_by, origin_site)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
    [a.tenantId, version, JSON.stringify(next), a.section, a.reset, DEFAULTS_VERSION, a.actorId, config.originSite],
  );
  forgetInRequest(memoPrefix(a.tenantId));
  return { version, diff: diffRules(current.rules[a.section], nextSection, a.section) };
}

// ── The read answer and the history ─────────────────────────────────────────────────────────────────────────────────────

export interface RulesSectionState { changed: boolean; version: number; editedBy: { id: string; name: string } | null; effectiveFrom: string | null }
export interface RulesAnswer {
  version: number;
  defaultsVersion: string;
  rules: RulesDoc;
  defaults: RulesDoc;
  sections: Record<RulesSection, RulesSectionState>;
  canEdit: boolean;
}

/** `GET rules`'s answer, in the caller's transaction. `changed` is "differs from the seed"; `version` the last save of that section (0: never). */
export async function readRulesAnswer(c: PoolClient, tenantId: string, canEdit: boolean): Promise<RulesAnswer> {
  const current = await socialRules(c, tenantId);
  await declareSocialModuleScope(c); // the memo may have answered without a query in this transaction
  const { rows } = await c.query<{ section: RulesSection; version: number; edited_by: string; name: string | null; effective_from: string }>(
    `SELECT DISTINCT ON (v.section) v.section, v.version, v.edited_by, u.name, v.effective_from
       FROM social_rule_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.tenant_id = $1
      ORDER BY v.section, v.version DESC`,
    [tenantId],
  );
  const last = new Map(rows.map((r) => [r.section, r]));
  const sections = {} as Record<RulesSection, RulesSectionState>;
  for (const s of RULES_SECTIONS) {
    const r = last.get(s);
    sections[s] = {
      changed: JSON.stringify(current.rules[s]) !== JSON.stringify(DEFAULT_RULES[s]),
      version: r ? Number(r.version) : 0,
      editedBy: r ? { id: r.edited_by, name: r.name ?? "" } : null,
      effectiveFrom: r ? new Date(r.effective_from).toISOString() : null,
    };
  }
  return { version: current.version, defaultsVersion: current.defaultsVersion, rules: current.rules, defaults: DEFAULT_RULES, sections, canEdit };
}

export interface RulesHistoryItem {
  version: number;
  section: RulesSection;
  reset: boolean;
  editedBy: { id: string; name: string };
  effectiveFrom: string;
  diff: RulesDiffEntry[];
}

/** The history, newest first: each version's change to its section, against the version before it (the seed before version 1). */
export async function readRulesHistory(
  c: PoolClient, tenantId: string, opts: { section: RulesSection | null; beforeVersion: number | null; limit: number },
): Promise<{ items: RulesHistoryItem[]; nextBeforeVersion: number | null }> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ version: number; section: RulesSection; reset: boolean; edited_by: string; name: string | null; effective_from: string; rules: RulesDoc }>(
    `SELECT v.version, v.section, v.reset, v.edited_by, u.name, v.effective_from, v.rules
       FROM social_rule_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.tenant_id = $1 AND ($2::text IS NULL OR v.section = $2) AND ($3::int IS NULL OR v.version < $3)
      ORDER BY v.version DESC
      LIMIT $4`,
    [tenantId, opts.section, opts.beforeVersion, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  const prevVersions = page.map((r) => Number(r.version) - 1).filter((v) => v >= 1);
  const prev = new Map<number, RulesDoc>();
  if (prevVersions.length) {
    const p = await c.query<{ version: number; rules: RulesDoc }>(
      `SELECT version, rules FROM social_rule_versions WHERE tenant_id = $1 AND version = ANY($2::int[])`,
      [tenantId, prevVersions],
    );
    for (const r of p.rows) prev.set(Number(r.version), r.rules);
  }
  const items = page.map((r): RulesHistoryItem => {
    const before = Number(r.version) === 1 ? DEFAULT_RULES : prev.get(Number(r.version) - 1) ?? DEFAULT_RULES;
    return {
      version: Number(r.version), section: r.section, reset: r.reset, editedBy: { id: r.edited_by, name: r.name ?? "" },
      effectiveFrom: new Date(r.effective_from).toISOString(), diff: diffRules(before[r.section], r.rules[r.section], r.section),
    };
  });
  return { items, nextBeforeVersion: rows.length > opts.limit ? items[items.length - 1].version : null };
}

// ── The audit preview seam ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST rules/preview` for `audit` answers a client's score under the edited scorecard. The scoring is W5-B4's (63.28); until it
 * registers here the preview answers `audit: null`. Called outside any transaction, as the route's caller.
 */
export type AuditPreviewer = (a: { tenantId: string; engagementId: string; scorecard: AuditRules }) => Promise<unknown>;
let auditPreviewer: AuditPreviewer | null = null;
export function setAuditPreviewer(fn: AuditPreviewer | null): void {
  auditPreviewer = fn;
}
export function currentAuditPreviewer(): AuditPreviewer | null {
  return auditPreviewer;
}

/** Bad ref guard re-exported for callers that validate a stored ref before reading it. */
export const isRulesRef = (ref: unknown): ref is string => typeof ref === "string" && RULES_REF_RE.test(ref);

/** Throws 400 `invalid_field` on `field` (the module's refusal shape), for the routes. */
export const rulesInvalid = fail;
