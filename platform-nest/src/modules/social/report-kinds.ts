// SCP-5 W5-A2 (docs/FRONTEND-BFF-CONTRACT.md §63.24.1 to §63.24.3, §63.30) — the periodic report kinds: what each kind's own rules make
// of a report. PURE: no I/O, no clock (the caller passes `today`). social-reports.controller.ts reads and writes; this file decides.
//
// ── THE RULES ARE THE COMPANY'S, AND A REPORT KEEPS ITS OWN ───────────────────────────────────────────────────────────────
// Every decision below reads a `ReportKindRules` (pipeline/rules.ts `reportKindRules`) of the rules the report was MADE under (its
// `rules_ref`), through `contentOf`: which parts the report takes and their limits, what the HoD check needs, when the numbers freeze
// and whether AI drafts it. Nothing here hard-codes a daily, weekly or monthly habit; the seed's defaults give the contract's table.
//
//   kind        period        freeze      content                                   the check needs
//   daily       YYYY-MM-DD    submit      summary + next-day line                   summary           (summary_missing)
//   weekly      YYYY-Www      submit      summary + next-week line                  summary
//   monthly     YYYY-MM       create      narrative, notes, action plan             notes             (notes_incomplete)
//   quarterly   YYYY-Qn       create      as the monthly                            notes
//   semester    YYYY-Hn       create      as the monthly                            notes
//   yearly      YYYY          create      as the monthly                            notes
//   campaign / adhoc: SMM-23's own: any period, no rules, nothing required.
//
// The `next_period` column (migration 202610301300) exists on the short kinds only, so a next-period line is a part of daily and weekly
// reports whatever the rules say about another kind; the same goes for what `checkRequires` names about it.
import { addDays } from "../hr/working-days";
import type { WorkingCalendar } from "../hr/working-days";
import {
  findUngroundedNumbers, parseReportNarrativeDraft, reportGroundingLines, type ReportNarrativeGroundingFacts, type ReportNarrativeKpiFact,
} from "./ai-drafts";
import {
  ACTION_PLAN_MAX, NOTE_AREAS, fitToMax, notesComplete, validateActionPlan, validateNotes, type DraftShape, type ReportAction, type ReportNotes,
} from "./report-notes";
import type { FrozenSocialReportMetrics, ReportKind } from "./reports";
import { PERIODIC_KINDS, SHORT_KINDS, type CheckPart, type NoteAreaRule, type PeriodicKind, type ReportDueRule, type ReportKindRules } from "./pipeline/rules";
import { periodRange, reportDueDate, type DateRange } from "./pipeline/rules-periods";

export const REPORT_KINDS: readonly ReportKind[] = [...PERIODIC_KINDS, "campaign", "adhoc"];
/** The five kinds migration 202610301300 gave a period format and the one-per-period index; the monthly keeps SCP-5a's advisory lock. */
export const INDEXED_KINDS: readonly PeriodicKind[] = ["daily", "weekly", "quarterly", "semester", "yearly"];
/** The kinds a client's `report_kinds` may name (the monthly is every client's, SCP-Q26). */
export const CLIENT_REPORT_KINDS = INDEXED_KINDS;

export const isReportKind = (v: unknown): v is ReportKind => typeof v === "string" && (REPORT_KINDS as readonly string[]).includes(v);
export const isPeriodicKind = (v: unknown): v is PeriodicKind => typeof v === "string" && (PERIODIC_KINDS as readonly string[]).includes(v);
export const isShortKind = (k: string): boolean => (SHORT_KINDS as readonly string[]).includes(k);

export const KIND_LABEL: Readonly<Record<ReportKind, string>> = {
  daily: "Daily report", weekly: "Weekly report", monthly: "Monthly report", quarterly: "Quarterly report", semester: "Half-year report",
  yearly: "Yearly report", campaign: "Campaign report", adhoc: "Report",
};

/** The shapes `GET reports?period=` accepts: one per kind (the route checks the form; the kind's own rules check the period itself). */
export const PERIOD_SHAPE_RE = /^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-(0[1-9]|1[0-2])|\d{4}-Q[1-4]|\d{4}-H[12]|\d{4})$/;

/** A next-period line's longest length (the column's CHECK holds the same). */
export const NEXT_PERIOD_MAX = 1000;

// ── What a report's rules make of it ──────────────────────────────────────────────────────────────────────────────────────

export interface ReportContent {
  /** A periodic kind, whose rules came from the company's document; false for campaign and ad hoc (SMM-23's own). */
  periodic: boolean;
  narrativeMax: number | null;
  /** The next-period line is a part of this report: the rule is on AND the kind has the column (daily, weekly). */
  nextPeriodLine: boolean;
  areas: NoteAreaRule[];
  actionPlan: { enabled: boolean; max: number };
  /** In the order the check reports them: narrative, notes, actionPlan, nextPeriodLine. */
  checkRequires: CheckPart[];
  freezeAt: "create" | "submit";
  aiDrafting: boolean;
  due: ReportDueRule | null;
}

const CHECK_ORDER: readonly CheckPart[] = ["narrative", "notes", "actionPlan", "nextPeriodLine"];

/** SMM-23's campaign and ad hoc reports: the narrative, any of the three notes and up to ten actions, nothing required, frozen at create. */
const LEGACY_CONTENT: ReportContent = {
  periodic: false, narrativeMax: null, nextPeriodLine: false,
  areas: NOTE_AREAS.map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1) })),
  actionPlan: { enabled: true, max: ACTION_PLAN_MAX }, checkRequires: [], freezeAt: "create", aiDrafting: true, due: null,
};

/** The content rules of a report of `kind` made under `rules` (the kind's block of the report's own rules; null for campaign and ad hoc). */
export function contentOf(kind: ReportKind, rules: ReportKindRules | null): ReportContent {
  if (!rules || !isPeriodicKind(kind)) return LEGACY_CONTENT;
  const nextPeriodLine = rules.content.nextPeriodLine && isShortKind(kind);
  const required = new Set<CheckPart>(rules.checkRequires.filter((p) => p !== "nextPeriodLine" || nextPeriodLine));
  return {
    periodic: true,
    narrativeMax: rules.content.narrative.max,
    nextPeriodLine,
    areas: rules.content.notes.areas,
    actionPlan: rules.content.actionPlan,
    checkRequires: CHECK_ORDER.filter((p) => required.has(p)),
    freezeAt: rules.freezeAt,
    aiDrafting: rules.aiDrafting,
    due: rules.due,
  };
}

export const noteKeysOf = (c: ReportContent): string[] => c.areas.map((a) => a.key);

/** The long-kind draft's shape: its notes' areas, its action plan and its narrative's limit. */
export const draftShapeOf = (c: ReportContent): DraftShape => ({ areas: c.areas, actionPlan: c.actionPlan, narrativeMax: c.narrativeMax });

/** A report whose numbers are live until it is submitted: its rules freeze them at submit, and it is still a draft. */
export const isLiveWhile = (c: ReportContent, status: string): boolean => c.freezeAt === "submit" && status === "draft";

// ── Periods ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodResult = { ok: true; range: DateRange } | { ok: false; code: "invalid_field" | "period_not_over" };

/**
 * A periodic kind's `period` for a new report (BFF §63.24.3): in the kind's format, a real date or week, not in the future
 * (`invalid_field`), and, when the report's numbers freeze at create, already over (`period_not_over`; the caller exempts the
 * monthly of SCP-5a's create). `today` is the company's report day.
 */
export function resolvePeriod(
  kind: PeriodicKind, period: unknown, fiscalYearStartMonth: number, today: string, freezeAtCreateNeedsEnded: boolean,
): PeriodResult {
  if (typeof period !== "string") return { ok: false, code: "invalid_field" };
  const range = periodRange(kind, period, fiscalYearStartMonth);
  if (!range || range.start > today) return { ok: false, code: "invalid_field" };
  if (freezeAtCreateNeedsEnded && range.end >= today) return { ok: false, code: "period_not_over" };
  return { ok: true, range };
}

/** The next day or week after a short report's period: the days the pipeline's posts are "coming next". Null for a long kind. */
export function nextRangeOf(kind: string, range: DateRange): { range: DateRange; label: "day" | "week" } | null {
  if (kind === "daily") return { range: { start: addDays(range.end, 1), end: addDays(range.end, 1) }, label: "day" };
  if (kind === "weekly") return { range: { start: addDays(range.end, 1), end: addDays(range.end, 7) }, label: "week" };
  return null;
}

/** The day a report is due (BFF §63.24.1): its kind's due rule on its period's range; null for a kind with no rule, a malformed period,
 *  or a rule that needs the client's `report_due_day` when the client has none. */
export function dueOf(
  kind: ReportKind, period: string | null, rules: { fiscalYearStartMonth: number; due: ReportDueRule | null },
  ctx: { reportDueDay: number | null; calendar: WorkingCalendar },
): string | null {
  if (!isPeriodicKind(kind) || !period || !rules.due) return null;
  const range = periodRange(kind, period, rules.fiscalYearStartMonth);
  return range ? reportDueDate(rules.due, range, ctx) : null;
}

// ── Editing and the HoD check ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EditBody { narrativeMd?: unknown; notes?: unknown; actionPlan?: unknown; nextPeriod?: unknown }
export interface ValidEdit { narrativeMd?: string; notes?: ReportNotes; actionPlan?: ReportAction[]; nextPeriod?: string | null }

/**
 * The PATCH's parts against the report's own rules (BFF §63.24.3): a part the rules leave out, or one outside its shape or limit, is
 * `{ok: false, field}` (the route answers 400 `invalid_field` `{field}`). The first bad part in the order narrative, notes, action
 * plan, next period.
 */
export function validateEdit(c: ReportContent, b: EditBody): { ok: true; value: ValidEdit } | { ok: false; field: string } {
  const value: ValidEdit = {};
  if (b.narrativeMd !== undefined) {
    if (typeof b.narrativeMd !== "string" || (c.narrativeMax !== null && b.narrativeMd.length > c.narrativeMax)) return { ok: false, field: "narrativeMd" };
    value.narrativeMd = b.narrativeMd;
  }
  if (b.notes !== undefined) {
    const keys = noteKeysOf(c);
    const v = keys.length === 0 ? null : validateNotes(b.notes, keys);
    if (!v || !v.ok) return { ok: false, field: "notes" };
    value.notes = v.value;
  }
  if (b.actionPlan !== undefined) {
    const v = c.actionPlan.enabled ? validateActionPlan(b.actionPlan, c.actionPlan.max) : null;
    if (!v || !v.ok) return { ok: false, field: "actionPlan" };
    value.actionPlan = v.value;
  }
  if (b.nextPeriod !== undefined) {
    if (!c.nextPeriodLine) return { ok: false, field: "nextPeriod" };
    if (b.nextPeriod !== null && (typeof b.nextPeriod !== "string" || b.nextPeriod.length > NEXT_PERIOD_MAX)) return { ok: false, field: "nextPeriod" };
    value.nextPeriod = b.nextPeriod as string | null;
  }
  return { ok: true, value };
}

const hasText = (s: unknown): boolean => typeof s === "string" && /\S/.test(s);

/** The refusal codes of the HoD check, by the part of the report they name. */
export const CHECK_CODE: Readonly<Record<CheckPart, string>> = {
  narrative: "summary_missing", notes: "notes_incomplete", actionPlan: "action_plan_missing", nextPeriodLine: "next_period_missing",
};

/** The first part the report's rules require that the report lacks, as the refusal code (`summary_missing`, `notes_incomplete`,
 *  `action_plan_missing`, `next_period_missing`), or null when the check may pass. */
export function unmetCheck(
  c: ReportContent, r: { narrativeMd: string; notes: unknown; actionPlan: readonly unknown[]; nextPeriod: string | null },
): string | null {
  for (const part of c.checkRequires) {
    const met =
      part === "narrative" ? hasText(r.narrativeMd)
      : part === "notes" ? notesComplete(r.notes, noteKeysOf(c))
      : part === "actionPlan" ? r.actionPlan.length > 0
      : hasText(r.nextPeriod);
    if (!met) return CHECK_CODE[part];
  }
  return null;
}

/** The list's `notesComplete`: false only when the report's rules require its notes and they are not all there ("the check may pass"). */
export const notesCheckPasses = (c: ReportContent, notes: unknown): boolean => !c.checkRequires.includes("notes") || notesComplete(notes, noteKeysOf(c));

// ── A short report's grounding ────────────────────────────────────────────────────────────────────────────────────────────

/** The short kind's own facts a draft may state (the best post's reach, how many posts are coming), the text the prompt names whose
 *  digits are grounded, and the prompt lines. Null for any report whose snapshot carries none. */
export function shortKindGrounding(frozen: FrozenSocialReportMetrics): { kpis: ReportNarrativeKpiFact[]; extra: string[]; lines: string[] } | null {
  const s = frozen.shortKind;
  if (!s) return null;
  const kpis: ReportNarrativeKpiFact[] = [{ label: `Posts scheduled for the next ${s.nextLabel}`, value: s.nextPosts, unit: "count" }];
  if (s.bestPostReach !== null) kpis.push({ label: "Best post reach", value: s.bestPostReach, unit: "count" });
  const best = frozen.tables.find((t) => t.key === "best_post")?.rows[0];
  const next = frozen.tables.find((t) => t.key === "next_period")?.rows ?? [];
  const extra: string[] = [];
  const lines: string[] = [];
  if (best) {
    extra.push(String(best.post ?? ""), String(best.publishedAt ?? ""), String(best.network ?? ""));
    lines.push(`Best post by reach this period: "${best.post}" (${best.network}), reach ${best.reach}.`);
  }
  if (next.length > 0) {
    for (const r of next) extra.push(String(r.title ?? ""), String(r.scheduledAt ?? ""), String(r.format ?? ""));
    lines.push(`Posts scheduled for the next ${s.nextLabel}:\n${next.map((r) => `- "${r.title}" (${r.format ?? "format not set"}, ${r.scheduledAt})`).join("\n")}`);
  } else {
    lines.push(`No posts are scheduled yet for the next ${s.nextLabel}.`);
  }
  return { kpis, extra, lines };
}

// ── A short report's draft: a summary and a next-period line ─────────────────────────────────────────────────────────────

export interface ShortDraftContext {
  kind: "daily" | "weekly";
  narrativeMax: number | null;
  nextPeriodLine: boolean;
  /** `shortKindGrounding(...).lines`. */
  extraLines: string[];
  nextLabel: "day" | "week";
  nextPosts: number;
  nextTitles: string[];
}

export interface ShortReportDraft {
  narrativeMd: string;
  nextPeriod: string | null;
  draftedVia: "ai" | "template";
  rejected?: { part: "narrative" | "nextPeriod"; numbers?: string[] };
}

/** The prompt of a daily or weekly report: the summary and, when the report has one, the line about what comes next, as one strict JSON object. */
export function buildShortReportDraftPrompt(facts: ReportNarrativeGroundingFacts, ctx: ShortDraftContext): string {
  const what = ctx.kind === "daily" ? "day" : "week";
  const ask = [`a short summary for the client of how the ${what} went${ctx.narrativeMax === null ? "" : ` (at most ${ctx.narrativeMax} characters)`}`];
  const json = ['"narrative": "..."'];
  if (ctx.nextPeriodLine) {
    ask.push(`one line about what comes next ${ctx.nextLabel} (at most ${NEXT_PERIOD_MAX} characters)`);
    json.push('"nextPeriod": "..."');
  }
  return [
    ...reportGroundingLines(facts),
    ...ctx.extraLines,
    `Write ${ask.join(" and ")}, in this brand's voice.`,
    "NEVER state a number you were not given above, and never imply a metric was zero just because it was not mentioned: say "
      + "it has not been fetched yet instead. Never suggest generating or attaching an image: this system has no "
      + "image-generation capability.",
    `Reply with STRICT JSON only, no prose, no markdown fences: {${json.join(", ")}}`,
  ].join("\n\n");
}

/** The plain next-period line: how many posts are scheduled, and the first few titles. States only what the pipeline holds. */
export function templateNextLine(ctx: Pick<ShortDraftContext, "nextLabel" | "nextPosts" | "nextTitles">): string {
  if (ctx.nextPosts === 0) return `Nothing is scheduled yet for the next ${ctx.nextLabel}.`;
  const n = ctx.nextPosts;
  const titles = ctx.nextTitles.slice(0, 3).map((t) => `"${t}"`).join(", ");
  return `${n} ${n === 1 ? "post is" : "posts are"} scheduled for the next ${ctx.nextLabel}${titles ? `: ${titles}` : ""}.`;
}

function shortTemplate(facts: ReportNarrativeGroundingFacts, ctx: ShortDraftContext, rejected?: ShortReportDraft["rejected"]): ShortReportDraft {
  return {
    narrativeMd: fitToMax(parseReportNarrativeDraft(null, facts).text, ctx.narrativeMax),
    nextPeriod: ctx.nextPeriodLine ? fitToMax(templateNextLine(ctx), NEXT_PERIOD_MAX) : null,
    draftedVia: "template",
    ...(rejected ? { rejected } : {}),
  };
}

/** Parse the gateway's answer into a short report's proposal. NEVER throws; any part that fails makes the whole proposal the template. */
export function parseShortReportDraft(raw: string | null, facts: ReportNarrativeGroundingFacts, ctx: ShortDraftContext): ShortReportDraft {
  if (!raw) return shortTemplate(facts, ctx);
  const narrative = parseReportNarrativeDraft(raw, facts);
  if (narrative.draftedVia !== "ai") {
    return shortTemplate(facts, ctx, narrative.rejectedNumbers ? { part: "narrative", numbers: narrative.rejectedNumbers } : undefined);
  }
  if (ctx.narrativeMax !== null && narrative.text.length > ctx.narrativeMax) return shortTemplate(facts, ctx, { part: "narrative" });
  let nextPeriod: string | null = null;
  if (ctx.nextPeriodLine) {
    let parsed: { nextPeriod?: unknown };
    try {
      parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)![0]) as typeof parsed;
    } catch {
      return shortTemplate(facts, ctx);
    }
    const line = typeof parsed.nextPeriod === "string" ? parsed.nextPeriod.trim() : "";
    if (line.length === 0 || line.length > NEXT_PERIOD_MAX) return shortTemplate(facts, ctx, { part: "nextPeriod" });
    const ungrounded = findUngroundedNumbers(line, facts);
    if (ungrounded.length > 0) return shortTemplate(facts, ctx, { part: "nextPeriod", numbers: ungrounded });
    nextPeriod = line;
  }
  return { narrativeMd: narrative.text, nextPeriod, draftedVia: "ai" };
}
