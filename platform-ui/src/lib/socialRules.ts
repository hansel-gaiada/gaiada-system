// SCP-5 W5-C5 (BFF §63.30) — the company's rules: their types, the parsers for what the routes answer, the words for a refusal, and the pure helpers the
// section editors share. No server-only import, so a client component may import the values.
//
// THE SERVER DECIDES. `platform-nest/src/modules/social/pipeline/rules.ts` validates every section and names the field of a refusal; nothing here re-validates. The editors only build the
// shape the server takes, keep a value they cannot build out of the draft, and say a refused field in words next to its control.
//
// FIVE SECTIONS, as the server has them: `reports`, `ideas`, `cycle`, `audit`, `saved`. The onboarding template is a PM template (63.29) and report automation is its own data (63.24.9):
// neither is in this document, so neither is a section here (see `socialOnboardingTemplate.ts` and `socialReportSchedules.ts`).
import { REFUSAL_WORDS, type Refusal } from "./socialPipeline";
import { PLAN_REFUSAL_REASON } from "./socialCycles";
import { KIND_LABEL, WEEKDAY_NAMES } from "./socialReportSchedules";

export const RULES_SECTIONS = ["reports", "ideas", "cycle", "audit", "saved"] as const;
export type RulesSection = (typeof RULES_SECTIONS)[number];
export const SECTION_LABEL: Readonly<Record<RulesSection, string>> = {
  reports: "Report rules", ideas: "Ideas for next month", cycle: "Monthly cycle", audit: "Audit scorecard", saved: "Saved categories",
};

export const PERIODIC_KINDS = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"] as const;
export type PeriodicKind = (typeof PERIODIC_KINDS)[number];
/** The two kinds the `next_period` column admits (63.24.2). */
export const SHORT_KINDS: readonly PeriodicKind[] = ["daily", "weekly"];
export const kindName = (k: PeriodicKind): string => KIND_LABEL[k];

export type ReportDueRule =
  | { rule: "working_days_after"; n: number }
  | { rule: "weekday"; weekday: number; week: "same" | "next" }
  | { rule: "report_due_day" };
export const CHECK_PARTS = ["narrative", "notes", "actionPlan", "nextPeriodLine"] as const;
export type CheckPart = (typeof CHECK_PARTS)[number];
export const CHECK_PART_LABEL: Readonly<Record<CheckPart, string>> = {
  narrative: "The narrative is written", notes: "Every notes area has a note", actionPlan: "The action plan has at least one item", nextPeriodLine: "The next-period line is filled in",
};
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

/** The six estimated steps a cycle step's ready-by can be set back by (`schedule-health.ts` `STEP_KEYS`). */
export const STEP_KEYS = ["proofread", "hod", "design", "final", "client", "schedule"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export const STEP_KEY_LABEL: Readonly<Record<StepKey, string>> = {
  proofread: "Proofread", hod: "HoD approval", design: "Design", final: "Final check", client: "Client approval", schedule: "Scheduling",
};
export type CycleStepDue =
  | { rule: "ready_by"; lessEstimatesFrom: StepKey | null; lessWorkingDays: number }
  | { rule: "report_due_day"; monthOffset: number }
  | { rule: "none" };
export const AUTO_CLOSE_CONDITIONS = ["plan_laid_out", "copy_locked", "artwork_done", "client_approved", "all_scheduled"] as const;
export type CycleAutoClose = { rule: "manual" } | { rule: "report_delivered"; reportMonthOffset: number } | { rule: (typeof AUTO_CLOSE_CONDITIONS)[number] };
export interface CycleStepRule { key: string; title: string; due: CycleStepDue; autoClose: CycleAutoClose }
export interface CycleRules { steps: CycleStepRule[] }

export const AUDIT_AUTO_SOURCES = ["consistency", "format_mix", "engagement_rate", "reels", "stories", "boosting"] as const;
export type AuditSource = "typed" | (typeof AUDIT_AUTO_SOURCES)[number];
export const AUDIT_SOURCE_LABEL: Readonly<Record<AuditSource, string>> = {
  typed: "Typed by the person scoring", consistency: "Automatic: posting consistency", format_mix: "Automatic: format mix", engagement_rate: "Automatic: engagement rate against the benchmark",
  reels: "Automatic: reels", stories: "Automatic: stories", boosting: "Automatic: boosting",
};
export interface AuditDimension { key: string; label: string; weight: number; source: AuditSource; advice: string }
export interface AuditBand { key: string; label: string; from: number }
export type AuditBenchmark = { source: "own_clients_median" } | { source: "typed"; rates: Record<string, number> };
export interface AuditRules { dimensions: AuditDimension[]; bands: AuditBand[]; benchmark: AuditBenchmark }

export const SAVED_HOLDS = ["asset", "link", "text"] as const;
export type SavedHolds = (typeof SAVED_HOLDS)[number];
export const SAVED_HOLDS_LABEL: Readonly<Record<SavedHolds, string>> = { asset: "Files", link: "Links", text: "Text" };
/** The three categories read from elsewhere (63.26): renamed, reordered or hidden, never removed. */
export const DERIVED_SAVED_CATEGORIES: Readonly<Record<string, string>> = {
  photos: "Also shows the client's design photos.", posts: "Reads the client's approved posts.", hashtags: "Reads the client's hashtag sets.",
};
export interface SavedCategory { key: string; label: string; holds: SavedHolds[]; enabled: boolean }
export interface SavedRules { categories: SavedCategory[] }

export interface RulesDoc { reports: ReportsRules; ideas: IdeasRules; cycle: CycleRules; audit: AuditRules; saved: SavedRules }
export interface RulesSectionState { changed: boolean; version: number; editedBy: { id: string; name: string } | null; effectiveFrom: string | null }
export interface RulesAnswer {
  version: number;
  defaultsVersion: string;
  rules: RulesDoc;
  defaults: RulesDoc;
  sections: Record<RulesSection, RulesSectionState>;
  canEdit: boolean;
}
export interface RulesDiffEntry { path: string; from: unknown; to: unknown }
export interface RulesHistoryItem { version: number; section: RulesSection; reset: boolean; editedBy: { id: string; name: string }; effectiveFrom: string; diff: RulesDiffEntry[] }

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`rules: ${what}`);
}

/** A document's shape, checked only as far as the editors read it (the server validated the values). Throws, so the page says "cannot tell". */
function asDoc(raw: unknown, where: string): RulesDoc {
  need(isObj(raw), `${where} is not an object`);
  const r = raw as Record<string, unknown>;
  need(isObj(r.reports) && num(r.reports.fiscalYearStartMonth) !== null && isObj(r.reports.kinds), `${where}.reports`);
  const kinds = (r.reports as Record<string, unknown>).kinds as Record<string, unknown>;
  for (const k of PERIODIC_KINDS) {
    const o = kinds[k];
    need(isObj(o) && typeof o.enabled === "boolean" && isObj(o.due) && isObj(o.content) && Array.isArray(o.checkRequires), `${where}.reports.kinds.${k}`);
    const c = (o as Record<string, unknown>).content as Record<string, unknown>;
    need(isObj(c.narrative) && isObj(c.notes) && Array.isArray(c.notes.areas) && isObj(c.actionPlan), `${where}.reports.kinds.${k}.content`);
  }
  need(isObj(r.ideas) && typeof r.ideas.metricRequired === "boolean" && typeof r.ideas.sharedInMonthlyReport === "boolean", `${where}.ideas`);
  need(isObj(r.cycle) && Array.isArray(r.cycle.steps) && r.cycle.steps.every((s) => isObj(s) && isObj(s.due) && isObj(s.autoClose)), `${where}.cycle`);
  need(isObj(r.audit) && Array.isArray(r.audit.dimensions) && Array.isArray(r.audit.bands) && isObj(r.audit.benchmark), `${where}.audit`);
  need(isObj(r.saved) && Array.isArray(r.saved.categories), `${where}.saved`);
  return raw as RulesDoc;
}

/** `GET rules` (and what a save answers). Throws on a body that is not one, so the page says "cannot tell" instead of drawing defaults as the company's values. */
export function asRulesAnswer(raw: unknown): RulesAnswer {
  need(isObj(raw), "not an answer");
  const o = raw as Record<string, unknown>;
  need(num(o.version) !== null && str(o.defaultsVersion) !== null, "no version");
  need(isObj(o.sections), "no sections");
  const sections = {} as Record<RulesSection, RulesSectionState>;
  for (const s of RULES_SECTIONS) {
    const x = (o.sections as Record<string, unknown>)[s];
    need(isObj(x) && typeof x.changed === "boolean", `section ${s}`);
    const xo = x as Record<string, unknown>;
    const by = isObj(xo.editedBy) && typeof xo.editedBy.id === "string" ? { id: xo.editedBy.id, name: str(xo.editedBy.name) ?? "" } : null;
    sections[s] = { changed: xo.changed as boolean, version: num(xo.version) ?? 0, editedBy: by, effectiveFrom: str(xo.effectiveFrom) };
  }
  return {
    version: o.version as number, defaultsVersion: o.defaultsVersion as string, rules: asDoc(o.rules, "rules"), defaults: asDoc(o.defaults, "defaults"), sections,
    canEdit: o.canEdit === true,
  };
}

const asDiff = (raw: unknown): RulesDiffEntry[] => (Array.isArray(raw) ? raw.filter(isObj).filter((d) => typeof d.path === "string").map((d) => ({ path: d.path as string, from: d.from ?? null, to: d.to ?? null })) : []);

/** `GET rules/versions`. */
export function asHistory(raw: unknown): { items: RulesHistoryItem[]; nextCursor: string | null } {
  need(isObj(raw) && Array.isArray((raw as Record<string, unknown>).items), "history is not a list");
  const o = raw as Record<string, unknown>;
  const items = (o.items as unknown[]).filter(isObj).filter((i) => num(i.version) !== null && (RULES_SECTIONS as readonly string[]).includes(i.section as string)).map((i): RulesHistoryItem => {
    const by = isObj(i.editedBy) ? i.editedBy : {};
    return {
      version: i.version as number, section: i.section as RulesSection, reset: i.reset === true, editedBy: { id: str(by.id) ?? "", name: str(by.name) ?? "" },
      effectiveFrom: str(i.effectiveFrom) ?? "", diff: asDiff(i.diff),
    };
  });
  return { items, nextCursor: str(o.nextCursor) };
}

export interface ReportDueRow { kind: PeriodicKind; enabled: boolean; period: string; range: { start: string; end: string }; due: string | null }
export interface PreviewStep { key: string; title: string; due: string | null; autoClose: string }
export interface AuditPreview {
  month: string; overall: number | null; band: string | null; bandLabel: string | null; scored: number; total: number;
  dimensions: Array<{ key: string; label: string; weight: number; used: number | null }>;
}
export interface RulesPreview {
  section: RulesSection;
  engagementId: string | null;
  reports: ReportDueRow[] | null;
  cycle: { cycleId: string; month: string; readyBy: string } | null;
  steps: PreviewStep[] | null;
  audit: AuditPreview | null;
  reason: "no_client" | "no_next_cycle" | null;
}

function asAuditPreview(raw: unknown): AuditPreview | null {
  if (!isObj(raw)) return null;
  const dims = Array.isArray(raw.dimensions)
    ? raw.dimensions.filter(isObj).filter((d) => typeof d.key === "string").map((d) => ({ key: d.key as string, label: str(d.label) ?? (d.key as string), weight: num(d.weight) ?? 0, used: num(d.used) }))
    : [];
  return {
    month: str(raw.month) ?? "", overall: num(raw.overall), band: str(raw.band), bandLabel: str(raw.bandLabel), scored: num(raw.scored) ?? 0, total: num(raw.total) ?? dims.length, dimensions: dims,
  };
}

/** `POST rules/preview`: what the unsaved value would do. A part the section has none of is null. */
export function asPreview(raw: unknown): RulesPreview {
  need(isObj(raw) && (RULES_SECTIONS as readonly string[]).includes((raw as Record<string, unknown>).section as string), "preview is not an answer");
  const o = raw as Record<string, unknown>;
  const reports = Array.isArray(o.reports)
    ? o.reports.filter(isObj).filter((r) => (PERIODIC_KINDS as readonly string[]).includes(r.kind as string) && typeof r.period === "string").map((r): ReportDueRow => {
      const rg = isObj(r.range) ? r.range : {};
      return { kind: r.kind as PeriodicKind, enabled: r.enabled !== false, period: r.period as string, range: { start: str(rg.start) ?? "", end: str(rg.end) ?? "" }, due: str(r.due) };
    })
    : null;
  const steps = Array.isArray(o.steps)
    ? o.steps.filter(isObj).filter((s) => typeof s.key === "string").map((s): PreviewStep => ({ key: s.key as string, title: str(s.title) ?? (s.key as string), due: str(s.due), autoClose: str(s.autoClose) ?? "manual" }))
    : null;
  const cy = isObj(o.cycle) && typeof o.cycle.cycleId === "string" ? { cycleId: o.cycle.cycleId, month: str(o.cycle.month) ?? "", readyBy: str(o.cycle.readyBy) ?? "" } : null;
  return {
    section: o.section as RulesSection, engagementId: str(o.engagementId), reports, cycle: cy, steps, audit: asAuditPreview(o.audit),
    reason: o.reason === "no_client" || o.reason === "no_next_cycle" ? o.reason : null,
  };
}

// ── Plain JSON helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const cloneJson = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The leaf changes from `a` to `b` under `path`, the server's `diffRules`: objects by key, arrays of equal length by index, anything else whole. */
export function diffRules(a: unknown, b: unknown, path: string): RulesDiffEntry[] {
  if (sameJson(a, b)) return [];
  if (isObj(a) && isObj(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffRules(a[k], b[k], `${path}.${k}`));
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.flatMap((x, i) => diffRules(x, b[i], `${path}.${i}`));
  return [{ path, from: a === undefined ? null : a, to: b === undefined ? null : b }];
}

export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[index], out[to]] = [out[to], out[index]];
  return out;
}

/** A key from a label: lower case, letters, digits and `_`, starting with a letter, at most 40, and not one of `taken`. */
export function slugKey(label: string, taken: readonly string[]): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `x_${base}`.replace(/_$/, "");
  if (base.length < 2) base = "item";
  let k = base;
  for (let i = 2; taken.includes(k); i++) k = `${base}_${i}`;
  return k;
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SEGMENT_WORDS: Readonly<Record<string, string>> = {
  fiscalYearStartMonth: "the fiscal year's first month", enabled: "on or off", due: "the due date", freezeAt: "when the report freezes", content: "the content", narrative: "the narrative",
  max: "the limit", nextPeriodLine: "the next-period line", notes: "the notes", areas: "the areas", actionPlan: "the action plan", checkRequires: "what the check requires", aiDrafting: "AI drafting",
  metricRequired: "the metric requirement", sharedInMonthlyReport: "shared ideas in the monthly report", steps: "the steps", title: "the title", key: "the key", label: "the name",
  autoClose: "how it closes", lessEstimatesFrom: "the step to count back from", lessWorkingDays: "the extra working days", monthOffset: "the month offset",
  reportMonthOffset: "the report's month offset", rule: "the rule", weight: "the weight", source: "where the score comes from", advice: "the advice", from: "the starting score",
  benchmark: "the benchmark", rates: "the typed rates", categories: "the categories", holds: "what it holds", weekday: "the weekday", week: "the week", n: "the number of days",
  dimensions: "the dimensions", bands: "the bands",
};
const LIST_NOUN: Readonly<Record<string, string>> = { steps: "step", areas: "notes area", dimensions: "dimension", bands: "band", categories: "category" };

/** "reports.kinds.weekly.due.n" in words: "Weekly report, the due date, the number of days". The first segment is the section, already named on the page. */
export function fieldWords(field: string): string {
  const parts = field.split(".").slice(1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === "kinds" && (PERIODIC_KINDS as readonly string[]).includes(parts[i + 1])) { out.push(`${kindName(parts[i + 1] as PeriodicKind)} report`); i++; continue; }
    if (p === "kinds") continue;
    const noun = LIST_NOUN[p];
    if (noun && /^\d+$/.test(parts[i + 1] ?? "")) { out.push(`${noun} ${Number(parts[i + 1]) + 1}`); i++; continue; }
    out.push(SEGMENT_WORDS[p] ?? p);
  }
  const s = out.join(", ");
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : "A value";
}

/** What the server's refusal of one field means, for the fields whose rule is not obvious from the name. */
function ruleHint(field: string): string | null {
  const last = field.split(".").pop() ?? "";
  if (field === "audit.bands") return "The bands must run from the highest starting score down, each starting lower than the one before, and the last one must start at 0. Keep two to five.";
  if (field === "audit.dimensions") return "Keep one to 20 dimensions, and give at least one a weight above 0.";
  if (field === "saved.categories") return "Photos, posts and hashtags cannot be removed, and at most 12 more are allowed.";
  if (field === "cycle.steps") return "Keep one to 12 steps.";
  if (/\.checkRequires$/.test(field)) return "The check can only require a part the report's content has turned on.";
  if (/\.content\.nextPeriodLine$/.test(field)) return "Only the daily and weekly reports can have a next-period line.";
  if (/\.due$/.test(field)) return "This kind of report cannot take that due rule.";
  if (last === "key") return "Each key is unique, in lower case, starts with a letter and uses only letters, digits and underscores.";
  if (last === "label" || last === "title" || last === "advice") return "It needs some words, within its length limit and without special characters.";
  if (last === "weight") return "A weight is 0 to 10, with at most two decimals.";
  if (/narrative\.max$/.test(field)) return "A limit is a whole number from 100 to 10,000, or no limit.";
  if (/actionPlan\.max$/.test(field)) return "The action plan keeps 1 to 20 items.";
  if (/areas$/.test(field)) return "Keep at most 6 notes areas, each with its own key.";
  if (last === "fiscalYearStartMonth") return "Choose a month from January to December.";
  if (last === "lessWorkingDays" || (last === "n" && /\.due\.n$/.test(field))) return "A number of working days is 0 to 30.";
  if (last === "monthOffset" || last === "reportMonthOffset") return "A month offset is 0 to 3 months back.";
  if (/benchmark\.rates/.test(field)) return "A typed rate is a fraction from 0 to 1 for each business type, and a business type is named once.";
  if (/\.holds$/.test(field)) return "A category must hold something, and photos, posts and hashtags keep what they hold.";
  if (last === "source") return "Each automatic source can be used by only one dimension.";
  return null;
}

/** The words for a 400 `invalid_field`: the field in words, then the rule where it is not obvious. */
export function invalidFieldWords(field: string | undefined): string {
  if (!field) return "A value is not valid.";
  if (field === "expectedVersion" || field === "section" || field === "body" || field === "value" || field === "cursor" || field === "limit") {
    return "Something went wrong with the request. Reload the page and try again.";
  }
  if (field === "engagementId") return "Choose a client from the list.";
  const hint = ruleHint(field);
  return `${fieldWords(field)} is not valid.${hint ? ` ${hint}` : ""}`;
}

export type RulesWrite = "save" | "reset" | "preview" | "history";

/** The sentence for a refusal of a rules route: the contract's code stays the code; this is its words. */
export function rulesRefusalText(r: Refusal, kind: RulesWrite): string {
  switch (r.error) {
    case "not_a_social_approver": return PLAN_REFUSAL_REASON.replace("change this", kind === "history" ? "see the history of the rules" : "change the company's rules");
    case "automation_cannot_act": return "An automated account cannot change the rules. A person does.";
    case "invalid_field": return invalidFieldWords(r.field);
    case "rules_changed": return REFUSAL_WORDS.rules_changed;
    case "session_expired": return "Session expired — sign in again.";
    case "no_company": return "No active company selected.";
    default: break;
  }
  if (r.status === 403) return PLAN_REFUSAL_REASON.replace("change this", "change the company's rules");
  return REFUSAL_WORDS[r.error] ?? "That did not work. Reload the page and try again.";
}

/** A value in a few words, for the diff lines. */
export function valueWords(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v === "" ? "empty" : v;
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? "item" : "items"}`;
  const j = JSON.stringify(v);
  return j.length > 70 ? `${j.slice(0, 67)}…` : j;
}

export interface DiffRow { path: string; words: string; now: string; wasOrDefault: string }
/** The lines of "what differs": `from` is the older value (the default, or the one before), `to` the newer. */
export function diffRows(from: unknown, to: unknown, section: RulesSection): DiffRow[] {
  return diffRules(from, to, section).map((d) => ({ path: d.path, words: fieldWords(d.path), now: valueWords(d.to), wasOrDefault: valueWords(d.from) }));
}

/** One history line's change, in words (at most three, then "and n more"). */
export function historyWords(item: RulesHistoryItem): string {
  if (item.reset) return "Set back to the default.";
  if (item.diff.length === 0) return "Saved with no change to the values.";
  const shown = item.diff.slice(0, 3).map((d) => `${fieldWords(d.path)}: ${valueWords(d.from)} to ${valueWords(d.to)}`);
  const more = item.diff.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`;
}

// ── Due rules, close conditions, the choices the editors offer ────────────────────────────────────────────────────────────

export function dueRuleWords(due: ReportDueRule): string {
  if (due.rule === "working_days_after") return due.n === 0 ? "On the day the period ends" : `${due.n} working ${due.n === 1 ? "day" : "days"} after the period ends`;
  if (due.rule === "weekday") return `On ${WEEKDAY_NAMES[due.weekday - 1] ?? "a weekday"} of the ${due.week === "next" ? "next" : "same"} week`;
  return "On the client's report day, in the month after the period";
}

export const AUTO_CLOSE_LABEL: Readonly<Record<string, string>> = {
  manual: "Only by hand", report_delivered: "When the monthly report is delivered", plan_laid_out: "When the plan is laid out", copy_locked: "When the copy is locked",
  artwork_done: "When the artwork is done", client_approved: "When the client has approved", all_scheduled: "When every post is scheduled",
};
export const autoCloseRules = (): string[] => ["manual", "report_delivered", ...AUTO_CLOSE_CONDITIONS];
export function autoCloseFor(rule: string): CycleAutoClose {
  if (rule === "manual") return { rule: "manual" };
  if (rule === "report_delivered") return { rule: "report_delivered", reportMonthOffset: 0 };
  return { rule: rule as (typeof AUTO_CLOSE_CONDITIONS)[number] };
}
export const STEP_DUE_LABEL: Readonly<Record<CycleStepDue["rule"], string>> = {
  ready_by: "Before the cycle's ready-by date", report_due_day: "On the client's report day", none: "No due date",
};
export function stepDueFor(rule: CycleStepDue["rule"]): CycleStepDue {
  if (rule === "ready_by") return { rule: "ready_by", lessEstimatesFrom: null, lessWorkingDays: 0 };
  if (rule === "report_due_day") return { rule: "report_due_day", monthOffset: 0 };
  return { rule: "none" };
}

/** The due rules a kind can take (the server refuses any other). */
export function dueChoices(kind: PeriodicKind): Array<{ rule: ReportDueRule["rule"]; label: string }> {
  const out: Array<{ rule: ReportDueRule["rule"]; label: string }> = [{ rule: "working_days_after", label: "Some working days after the period ends" }];
  if (kind === "weekly") out.push({ rule: "weekday", label: "A weekday of the same or the next week" });
  if (!SHORT_KINDS.includes(kind)) out.push({ rule: "report_due_day", label: "The client's report day, in the month after" });
  return out;
}
export function dueFor(rule: ReportDueRule["rule"]): ReportDueRule {
  if (rule === "weekday") return { rule: "weekday", weekday: 1, week: "next" };
  if (rule === "report_due_day") return { rule: "report_due_day" };
  return { rule: "working_days_after", n: 1 };
}

/** Whether a check part is turned on by the kind's content (a part that is off cannot be required). */
export function checkPartOn(k: ReportKindRules, part: CheckPart): boolean {
  if (part === "narrative") return true;
  if (part === "notes") return k.content.notes.areas.length > 0;
  if (part === "actionPlan") return k.content.actionPlan.enabled;
  return k.content.nextPeriodLine;
}
/** A kind with the check parts its content turned off dropped, so a save is not refused for them. */
export function pruneCheck(k: ReportKindRules): ReportKindRules {
  return { ...k, checkRequires: k.checkRequires.filter((p) => checkPartOn(k, p)) };
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** A new notes area, a step, a dimension, a band and a category, for the editors' Add buttons; each takes a key not already used. */
export const newArea = (taken: string[]): NoteAreaRule => ({ key: slugKey("area", taken), label: "New area" });
export const newStep = (taken: string[]): CycleStepRule => ({ key: slugKey("step", taken), title: "New step", due: { rule: "none" }, autoClose: { rule: "manual" } });
export const newDimension = (taken: string[]): AuditDimension => ({ key: slugKey("dimension", taken), label: "New dimension", weight: 1, source: "typed", advice: "What to do when this scores low." });
export const newBand = (taken: string[]): AuditBand => ({ key: slugKey("band", taken), label: "New band", from: 0 });
export const newCategory = (taken: string[]): SavedCategory => ({ key: slugKey("category", [...taken, "other"]), label: "New category", holds: ["text"], enabled: true });

/** The preview request's body: the unsaved value, and the client when one is chosen. */
export function previewBody(section: RulesSection, value: unknown, engagementId: string | null): Record<string, unknown> {
  return { section, value, ...(engagementId ? { engagementId } : {}) };
}
