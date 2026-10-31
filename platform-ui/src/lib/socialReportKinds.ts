// SCP-5 W5-A4 (BFF §63.24.1, §63.24.7) — the report KINDS as the pages know them: the kind switch, each kind's period (its format, its range, the period before and after,
// the ones a person may pick), the company's rules the pages read (`GET rules`: which kinds are on, which are drafted by hand), and the words for each kind.
// Pure and client-safe: no I/O, no clock (the caller passes `today`), no server-only import. The maths twin the server's `pipeline/rules-periods.ts` (quarters, halves and years follow
// the company's fiscal year start, and a fiscal year is named by the calendar year it STARTS in); the server decides every write, so a period this file offers that the server
// refuses is said in words, never guessed around.

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const PERIODIC_KINDS = ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"] as const;
export type PeriodicKind = (typeof PERIODIC_KINDS)[number];
/** The two kinds whose numbers stay live while a draft and whose page shows a summary and a next-period line (BFF §63.24.1). */
export const SHORT_KINDS: readonly string[] = ["daily", "weekly"];
export const isPeriodicKind = (v: unknown): v is PeriodicKind => typeof v === "string" && (PERIODIC_KINDS as readonly string[]).includes(v);
export const isShortKind = (kind: string): boolean => SHORT_KINDS.includes(kind);

/** The kind switch's seven tabs, in the design's order. `other` is the campaign and ad hoc reports. */
export const KIND_TABS = [
  { key: "daily", label: "Daily" }, { key: "weekly", label: "Weekly" }, { key: "monthly", label: "Monthly" }, { key: "quarterly", label: "Quarterly" },
  { key: "semester", label: "Half-year" }, { key: "yearly", label: "Yearly" }, { key: "other", label: "Other" },
] as const;
export type KindTab = (typeof KIND_TABS)[number]["key"];
export const isKindTab = (v: unknown): v is KindTab => typeof v === "string" && KIND_TABS.some((t) => t.key === v);
/** The tab a report of `kind` sits under. */
export const tabOfKind = (kind: string): KindTab => (isPeriodicKind(kind) ? kind : "other");

/** The kind in a noun phrase ("Daily report"), as the server titles it (`KIND_LABEL`). */
export const KIND_NOUN: Readonly<Record<string, string>> = {
  daily: "Daily report", weekly: "Weekly report", monthly: "Monthly report", quarterly: "Quarterly report", semester: "Half-year report", yearly: "Yearly report",
  campaign: "Campaign report", adhoc: "Report",
};
export const kindNoun = (kind: string): string => KIND_NOUN[kind] ?? "Report";

// ── Period maths ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const DAY_MS = 86_400_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export const isRealIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isoWeekday = (iso: string): number => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
const mondayOf = (iso: string): string => addDays(iso, 1 - isoWeekday(iso));
const monthKeyOf = (total: number): string => `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
const totalOf = (year: number, month1: number): number => year * 12 + (month1 - 1);
const lastDayOfMonth = (month: string): string => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** The ISO week key `YYYY-Www` of a date (the ISO year is the year of the week's Thursday). */
export function isoWeekKey(iso: string): string {
  const thursday = addDays(mondayOf(iso), 3);
  const year = Number(thursday.slice(0, 4));
  const firstThursday = addDays(mondayOf(`${pad(year, 4)}-01-04`), 3);
  const week = Math.round((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${firstThursday}T00:00:00Z`)) / (7 * DAY_MS)) + 1;
  return `${pad(year, 4)}-W${pad(week)}`;
}

/** The period of `kind` holding the day `iso`. */
export function periodOf(kind: PeriodicKind, iso: string, fiscalYearStartMonth = 1): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (kind === "daily") return iso;
  if (kind === "weekly") return isoWeekKey(iso);
  if (kind === "monthly") return iso.slice(0, 7);
  const offset = (m - fiscalYearStartMonth + 12) % 12;
  const fy = m >= fiscalYearStartMonth ? y : y - 1;
  if (kind === "quarterly") return `${pad(fy, 4)}-Q${Math.floor(offset / 3) + 1}`;
  if (kind === "semester") return `${pad(fy, 4)}-H${Math.floor(offset / 6) + 1}`;
  return pad(fy, 4);
}

export interface DateRange { start: string; end: string }

/** The days `period` covers, or null when it is not a real period of `kind`. */
export function periodRange(kind: PeriodicKind, period: string, fiscalYearStartMonth = 1): DateRange | null {
  if (kind === "daily") return isRealIsoDate(period) ? { start: period, end: period } : null;
  if (kind === "weekly") {
    const w = /^(\d{4})-W(\d{2})$/.exec(period);
    if (!w) return null;
    const week = Number(w[2]);
    if (week < 1 || week > 53) return null;
    const start = addDays(mondayOf(`${w[1]}-01-04`), (week - 1) * 7);
    return isoWeekKey(start) === period ? { start, end: addDays(start, 6) } : null;
  }
  if (kind === "monthly") {
    const mm = /^(\d{4})-(\d{2})$/.exec(period);
    return mm && Number(mm[2]) >= 1 && Number(mm[2]) <= 12 ? { start: `${period}-01`, end: lastDayOfMonth(period) } : null;
  }
  let year: number; let firstMonth: number; let months: number;
  if (kind === "quarterly") {
    const q = /^(\d{4})-Q([1-4])$/.exec(period);
    if (!q) return null;
    year = Number(q[1]); firstMonth = (Number(q[2]) - 1) * 3; months = 3;
  } else if (kind === "semester") {
    const h = /^(\d{4})-H([12])$/.exec(period);
    if (!h) return null;
    year = Number(h[1]); firstMonth = (Number(h[2]) - 1) * 6; months = 6;
  } else {
    if (!/^\d{4}$/.test(period)) return null;
    year = Number(period); firstMonth = 0; months = 12;
  }
  const start = totalOf(year, fiscalYearStartMonth) + firstMonth;
  return { start: `${monthKeyOf(start)}-01`, end: lastDayOfMonth(monthKeyOf(start + months - 1)) };
}

export const isPeriodOfKind = (kind: string, period: unknown, fiscalYearStartMonth = 1): period is string =>
  isPeriodicKind(kind) && typeof period === "string" && periodRange(kind, period, fiscalYearStartMonth) !== null;

/** The period `delta` periods away (negative: before). Null for a period that is not one. */
export function shiftPeriod(kind: PeriodicKind, period: string, delta: number, fiscalYearStartMonth = 1): string | null {
  const range = periodRange(kind, period, fiscalYearStartMonth);
  if (!range) return null;
  if (kind === "daily") return addDays(range.start, delta);
  if (kind === "weekly") return isoWeekKey(addDays(range.start, delta * 7));
  const step = kind === "monthly" ? 1 : kind === "quarterly" ? 3 : kind === "semester" ? 6 : 12;
  const first = totalOf(Number(range.start.slice(0, 4)), Number(range.start.slice(5, 7))) + delta * step;
  return periodOf(kind, `${monthKeyOf(first)}-01`, fiscalYearStartMonth);
}

/** "9 Nov 2026" */
export const dayWords = (iso: string): string => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const monthYear = (iso: string): string => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const MONTH_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const monthTitleOf = (period: string): string => `${MONTH_FULL[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

/** "9 to 15 Nov 2026", "29 Dec 2026 to 4 Jan 2027": a range in words. */
export function rangeWords(r: DateRange): string {
  if (r.start === r.end) return dayWords(r.start);
  if (r.start.slice(0, 7) === r.end.slice(0, 7)) return `${Number(r.start.slice(8, 10))} to ${dayWords(r.end)}`;
  if (r.start.slice(0, 4) === r.end.slice(0, 4)) return `${Number(r.start.slice(8, 10))} ${MON[Number(r.start.slice(5, 7)) - 1]} to ${dayWords(r.end)}`;
  return `${dayWords(r.start)} to ${dayWords(r.end)}`;
}

/**
 * A period in words, as the server titles a delivered report: "9 Nov 2026", "Week 46, 2026 (9 to 15 Nov 2026)", "September 2026", "Q4 2026", "H2 2026", "2026". With a fiscal year that does not
 * start in January the quarter, half or year also says its months. A period the kind does not know is shown as it came, never dropped.
 */
export function periodLabel(kind: PeriodicKind, period: string, fiscalYearStartMonth = 1): string {
  const range = periodRange(kind, period, fiscalYearStartMonth);
  if (!range) return period;
  if (kind === "daily") return dayWords(range.start);
  if (kind === "weekly") return `Week ${Number(period.slice(6, 8))}, ${period.slice(0, 4)} (${rangeWords(range)})`;
  if (kind === "monthly") return monthTitleOf(period);
  const base = kind === "quarterly" ? `Q${period.slice(-1)} ${period.slice(0, 4)}` : kind === "semester" ? `H${period.slice(-1)} ${period.slice(0, 4)}` : period;
  return fiscalYearStartMonth === 1 ? base : `${base} (${monthYear(range.start)} to ${monthYear(range.end)})`;
}

/** The plain label of a period for any report kind: the campaign and ad hoc reports keep SMM-23's rules (a month, or a custom period). */
export function anyPeriodLabel(kind: string, period: string | null, fiscalYearStartMonth = 1): string {
  if (period && isPeriodicKind(kind) && periodRange(kind, period, fiscalYearStartMonth)) return periodLabel(kind, period, fiscalYearStartMonth);
  if (period && /^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return monthTitleOf(period);
  return period && kind !== "monthly" ? period : kind === "monthly" ? "No period" : "Custom period";
}

export interface PeriodChoice { value: string; label: string; ended: boolean }

/**
 * The periods a person may pick for `kind` on `today`, newest first. Every kind offers its ended periods; a short kind (its numbers live until it is submitted) and a one-client monthly draft
 * (SCP-5a's create takes the month so far) also offer the period still going, marked "so far". A run over a period still going is refused for every kind frozen at create, so "all clients"
 * never offers it. `count` is how many periods back to offer.
 */
export function periodChoices(kind: PeriodicKind, today: string, o: { fiscalYearStartMonth?: number; allowCurrent: boolean; count?: number }): PeriodChoice[] {
  const fy = o.fiscalYearStartMonth ?? 1;
  const count = o.count ?? (kind === "daily" ? 14 : kind === "weekly" ? 12 : kind === "monthly" ? 12 : kind === "yearly" ? 5 : 8);
  const current = periodOf(kind, today, fy);
  const out: PeriodChoice[] = [];
  let p: string | null = current;
  for (let i = 0; p !== null && out.length < count; i++) {
    if (i > 0 || o.allowCurrent) out.push({ value: p, label: i === 0 ? `${periodLabel(kind, p, fy)} (so far)` : periodLabel(kind, p, fy), ended: i > 0 });
    p = shiftPeriod(kind, p, -1, fy);
  }
  return out;
}

/** True once the period's last day is before `today`. */
export function periodHasEnded(kind: PeriodicKind, period: string, today: string, fiscalYearStartMonth = 1): boolean {
  const r = periodRange(kind, period, fiscalYearStartMonth);
  return r !== null && r.end < today;
}
/** True once the period has begun (the server refuses a period in the future). */
export function periodHasStarted(kind: PeriodicKind, period: string, today: string, fiscalYearStartMonth = 1): boolean {
  const r = periodRange(kind, period, fiscalYearStartMonth);
  return r !== null && r.start <= today;
}

/** What the short kind's "next" is called: the day after a daily report, the week after a weekly one. */
export const nextWord = (kind: string): "day" | "week" => (kind === "daily" ? "day" : "week");

// ── The company's rules the pages read (`GET rules`, BFF §63.30.4) ───────────────────────────────────────────────────────────

export interface KindRule { enabled: boolean; aiDrafting: boolean; freezeAt: "create" | "submit"; narrativeMax: number | null }
export interface ReportRules {
  fiscalYearStartMonth: number;
  kinds: Partial<Record<PeriodicKind, KindRule>>;
  ideas: { metricRequired: boolean };
}

/** The part of `GET rules` the report pages read: which kinds are on, how each is drafted, the fiscal year and the ideas' metric rule. Throws on a body that is not the rules. */
export function asReportRules(raw: unknown): ReportRules {
  const rules = isObj(raw) && isObj(raw.rules) ? raw.rules : null;
  const reports = rules && isObj(rules.reports) ? rules.reports : null;
  if (!rules || !reports || !isObj(reports.kinds)) throw new Error("rules: not the company's rules");
  const kinds: ReportRules["kinds"] = {};
  for (const k of PERIODIC_KINDS) {
    const r = reports.kinds[k];
    if (!isObj(r)) continue;
    const narrative = isObj(r.content) && isObj(r.content.narrative) ? r.content.narrative : {};
    kinds[k] = {
      enabled: r.enabled === true, aiDrafting: r.aiDrafting !== false, freezeAt: r.freezeAt === "submit" ? "submit" : "create",
      narrativeMax: typeof narrative.max === "number" ? narrative.max : null,
    };
  }
  const fy = typeof reports.fiscalYearStartMonth === "number" && Number.isInteger(reports.fiscalYearStartMonth) && reports.fiscalYearStartMonth >= 1 && reports.fiscalYearStartMonth <= 12 ? reports.fiscalYearStartMonth : 1;
  const ideas = isObj(rules.ideas) ? rules.ideas : {};
  return { fiscalYearStartMonth: fy, kinds, ideas: { metricRequired: ideas.metricRequired !== false } };
}

/** The tabs a person is offered: the kinds the company has on, and Other (the campaign and ad hoc reports are not a company rule). The rules not read: the monthly report only, and Other. */
export function offeredTabs(rules: ReportRules | null): KindTab[] {
  if (!rules) return ["monthly", "other"];
  return KIND_TABS.map((t) => t.key).filter((k) => k === "other" || rules.kinds[k]?.enabled === true);
}

/** The kind a page shows: the one asked for when it is offered, else the monthly report when it is, else the first offered. */
export function chosenTab(asked: KindTab | null, offered: readonly KindTab[]): KindTab {
  if (asked && offered.includes(asked)) return asked;
  return offered.includes("monthly") ? "monthly" : offered[0] ?? "other";
}
