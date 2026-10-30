// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11; plan docs/plans/2026-10-27-ai-plan.md §6.3 items 6 and 9; rulings AIP-D7, AIP-D8, AIP-D9, AIP-D18): budgets,
// allowances and the soft stop, client-safe half. The wire shapes of the budget lines and the allowances, the pure rules for their words, the form
// validators (the server's own rules, said before the round trip; the server's answer is always the one that counts) and the soft stop's chat line.
// No server import and no I/O. The readers are in `aiUsage-data.ts`, the writes in `aiBudgetActions.ts`, the demo store in `demoAiUsage.ts`.
//
// COUNTS AND MONEY ONLY, and never a number in the chat line. A cost is an exact decimal STRING and stays one; a `null` spend is "unknown", never 0.

// ── The wire shape (§66.8) ────────────────────────────────────────────────────────────────────────

export type BudgetState = "under" | "over_80" | "over_100";
export type BudgetMode = "report" | "soft_stop";

/** The figures both kinds of budget line carry. `monthlyUsd` and `spentUsd` are exact decimal strings; `spentUsd` is null when no call had a cost. */
export interface BudgetFigures {
  monthlyUsd: string;
  spentUsd: string | null;
  /** Calls with no cost: never counted in `spentUsd`, so unknown money cannot cross a budget. */
  noCostCalls: number;
  /** Floored to one decimal by the server: it never shows a threshold it has not reached. */
  percent: number;
  state: BudgetState;
}

/** The company's alert figure (AIP-D8): no mode. */
export type CompanyBudgetLine = BudgetFigures;

/** One department's budget. `name: null` is a node no longer in the tree. `stopLifted` is true when the stop was lifted for the month the answer is about. */
export interface UnitBudgetLine extends BudgetFigures {
  unitNodeId: string;
  name: string | null;
  mode: BudgetMode;
  stopLifted: boolean;
}

/** `GET company`'s `budgets` (§66.8). */
export interface CompanyBudgets {
  company: CompanyBudgetLine | null;
  units: UnitBudgetLine[];
}

/** `GET allowances` (§66.9). `name: null` is a person whose name the server could not give. */
export interface AllowanceOverride { userId: string; name: string | null; dailyReplies: number; updatedAt: string | null }
export interface Allowances { defaultDailyReplies: number; overrides: AllowanceOverride[] }

// ── Parsing: the answer, checked ──────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function bad(what: string): never {
  throw new Error(`the AI usage answer had a bad ${what}`);
}

const DECIMAL = /^\d+(\.\d+)?$/;
const decimal = (v: unknown, what: string): string => (typeof v === "string" && DECIMAL.test(v) ? v : bad(what));
const wholeNumber = (v: unknown, what: string): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : bad(what));

function figures(o: Obj, where: string): BudgetFigures {
  const state = o.state;
  if (state !== "under" && state !== "over_80" && state !== "over_100") return bad(`${where}.state`);
  if (typeof o.percent !== "number" || !Number.isFinite(o.percent) || o.percent < 0) return bad(`${where}.percent`);
  return {
    monthlyUsd: decimal(o.monthlyUsd, `${where}.monthlyUsd`),
    spentUsd: o.spentUsd === null || o.spentUsd === undefined ? null : decimal(o.spentUsd, `${where}.spentUsd`),
    noCostCalls: wholeNumber(o.noCostCalls, `${where}.noCostCalls`),
    percent: o.percent,
    state,
  };
}

/** One unit's budget line (§66.8). */
export function asUnitBudgetLine(raw: unknown, where = "budget"): UnitBudgetLine {
  if (!isObj(raw)) return bad(where);
  if (typeof raw.unitNodeId !== "string" || raw.unitNodeId === "") return bad(`${where}.unitNodeId`);
  if (raw.mode !== "report" && raw.mode !== "soft_stop") return bad(`${where}.mode`);
  return {
    ...figures(raw, where),
    unitNodeId: raw.unitNodeId,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : null,
    mode: raw.mode,
    stopLifted: raw.stopLifted === true,
  };
}

/** `GET units/:id`'s `budget`: absent or null is "no budget set" (an older server answers no key at all). */
export function asUnitBudget(raw: unknown): UnitBudgetLine | null {
  return raw === undefined || raw === null ? null : asUnitBudgetLine(raw);
}

/** `GET company`'s `budgets`: absent or null is no budgets at all. */
export function asCompanyBudgets(raw: unknown): CompanyBudgets {
  if (raw === undefined || raw === null) return { company: null, units: [] };
  if (!isObj(raw)) return bad("budgets");
  const company = raw.company === undefined || raw.company === null ? null : isObj(raw.company) ? figures(raw.company, "budgets.company") : bad("budgets.company");
  if (raw.units !== undefined && !Array.isArray(raw.units)) return bad("budgets.units");
  return { company, units: ((raw.units as unknown[] | undefined) ?? []).map((u) => asUnitBudgetLine(u, "budgets.units")) };
}

export function asAllowances(raw: unknown): Allowances {
  if (!isObj(raw)) return bad("allowances");
  const d = raw.defaultDailyReplies;
  if (typeof d !== "number" || !Number.isInteger(d) || d < 1) return bad("allowances.defaultDailyReplies");
  if (!Array.isArray(raw.overrides)) return bad("allowances.overrides");
  return {
    defaultDailyReplies: d,
    overrides: raw.overrides.map((o): AllowanceOverride => {
      if (!isObj(o) || typeof o.userId !== "string" || o.userId === "") return bad("allowances.overrides");
      if (typeof o.dailyReplies !== "number" || !Number.isInteger(o.dailyReplies) || o.dailyReplies < 1) return bad("allowances.overrides.dailyReplies");
      return {
        userId: o.userId,
        name: typeof o.name === "string" && o.name !== "" ? o.name : null,
        dailyReplies: o.dailyReplies,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
      };
    }),
  };
}

/** The allowance a person has: their override, else the default (and which of the two it is). */
export function allowanceOf(a: Allowances, userId: string): { dailyReplies: number; isDefault: boolean } {
  const o = a.overrides.find((x) => x.userId === userId);
  return o ? { dailyReplies: o.dailyReplies, isDefault: false } : { dailyReplies: a.defaultDailyReplies, isDefault: true };
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

/** A state in words: "under", "over 80%", "at or over 100%". */
export function budgetStateWords(state: BudgetState): string {
  return state === "over_100" ? "at or over 100%" : state === "over_80" ? "over 80%" : "under";
}

export const budgetModeLabel = (mode: BudgetMode): string => (mode === "soft_stop" ? "Soft stop" : "Report only");

export const BUDGET_MODE_HELP: Record<BudgetMode, string> = {
  report: "The owner and the department's head are told at 80% and at 100%. Nothing else changes.",
  soft_stop: "At 100%, replies for this department continue in a lighter mode and agent runs wait, until the stop is lifted or the month ends.",
};

/** "87.5%", "80%": the server's floored figure as it is, never rounded up. */
export const percentText = (percent: number): string => `${Math.round(percent * 10) / 10}%`;

export const NO_BUDGET_FORBIDDEN = "Only the owner can change AI budgets and allowances.";

// ── The forms' rules (§66.9): the server's own, said before the round trip ────────────────────────

export const MAX_MONTHLY_USD = "99999999.9999";
export const MAX_DAILY_REPLIES = 100000;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A monthly figure typed into a form: a positive decimal with at most 4 places and at most 8 whole digits, as the server requires. Leading and trailing
 * spaces are trimmed (a form field's habit); a comma, an exponent, a sign or an inner space is refused, as the server refuses them. The value goes
 * to the server as the string typed: the server canonicalises it and its answer is the one that counts.
 */
export function checkMonthlyUsd(raw: string): Checked<string> {
  const s = raw.trim();
  if (s === "") return { ok: false, error: "Enter a figure in US dollars." };
  const m = /^([0-9]{1,8})(?:\.([0-9]{1,4}))?$/.exec(s);
  if (!m) return { ok: false, error: `Use a positive number with at most 4 decimal places, up to ${MAX_MONTHLY_USD}, for example 250 or 0.05.` };
  if (!/[1-9]/.test(m[1] + (m[2] ?? ""))) return { ok: false, error: "The figure must be more than 0. To have no figure, use Remove." };
  return { ok: true, value: s };
}

/** A daily allowance typed into a form: a whole number from 1 to 100,000. */
export function checkDailyReplies(raw: string): Checked<number> {
  const s = raw.trim();
  if (s === "") return { ok: false, error: "Enter a number of replies a day." };
  if (!/^[0-9]+$/.test(s)) return { ok: false, error: `Use a whole number from 1 to ${MAX_DAILY_REPLIES.toLocaleString("en-US")}.` };
  const n = Number(s);
  if (n < 1 || n > MAX_DAILY_REPLIES) return { ok: false, error: `Use a whole number from 1 to ${MAX_DAILY_REPLIES.toLocaleString("en-US")}.` };
  return { ok: true, value: n };
}

/** The UTC month of `now` as `YYYY-MM` (the month a lift applies to). */
export function utcMonthOf(now: Date): string {
  return `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The lift button's exact conditions (AIP-18): the unit's own budget is in Soft stop mode, at or over 100%, not lifted this month; the answer's
 * `canLiftStop` is true; and the page shows the CURRENT UTC month (a lift always applies to the current month, so it is never offered beside a
 * past month's figures, where it would not mean what it says).
 */
export function liftOffered(line: UnitBudgetLine | null, caps: { canLiftStop: boolean }, month: string, now: Date = new Date()): boolean {
  return line !== null && caps.canLiftStop && line.mode === "soft_stop" && line.state === "over_100" && !line.stopLifted && month === utcMonthOf(now);
}

export const LIFT_BUTTON = "Lift the stop for the rest of this month";
export const LIFT_WARNING = "Replies return to normal for this department until the month ends, and waiting agent runs start. Next month's spend can stop it again.";

/** The server's refusal of a budget, allowance or lift write, in words. A 400 is the server's own sentence (it names the field). */
export function budgetErrorText(e: { status?: number; message: string }, what: "budget" | "allowance" | "lift" = "budget"): string {
  if (e.status === 403) return what === "lift" ? "Only the owner, or the head of this department, can lift its stop." : NO_BUDGET_FORBIDDEN;
  if (e.status === 404) {
    if (/no_soft_stop/.test(e.message)) return "This department has no soft stop to lift: it has no budget, or its budget is Report only.";
    if (/person_not_found/.test(e.message)) return "This person is not an active member of this company.";
    return "This department was not found. It may have been removed, or it is not a department of this company.";
  }
  if (e.status === 400) return e.message || "That could not be saved. Check it and try again.";
  return e.message || "That could not be saved just now. Try again.";
}

// ── The soft stop's chat line (AIP-18, §66.11) ────────────────────────────────────────────────────

export interface TurnBudget {
  kind: "allowance" | "department";
  unitNodeId?: string;
  /** The ISO instant the stop ends, as the server sent it (kept as sent: an unreadable one only drops the "until" clause). */
  resetsAt: string;
}

/** A `turn_budget` object (the part, the stream's `budget` frame, or the ask answer's `turnBudget`), checked. Anything else is null. */
export function asTurnBudget(v: unknown): TurnBudget | null {
  if (!isObj(v) || (v.kind !== "allowance" && v.kind !== "department")) return null;
  return {
    kind: v.kind,
    ...(typeof v.unitNodeId === "string" && v.unitNodeId !== "" ? { unitNodeId: v.unitNodeId } : {}),
    resetsAt: typeof v.resetsAt === "string" ? v.resetsAt : "",
  };
}

/** The `turn_budget` entry of a message's `parts`, or null. Absent on every unstopped turn, and on messages from before AIP-18. */
export function parseTurnBudget(parts: unknown): TurnBudget | null {
  if (!Array.isArray(parts)) return null;
  const found = parts.find((p) => isObj(p) && p.type === "turn_budget");
  return found ? asTurnBudget(found) : null;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const parsedInstant = (iso: string): Date | null => {
  const d = new Date(iso);
  return iso !== "" && Number.isFinite(d.getTime()) ? d : null;
};

/** `31 Oct, 08:00` in `timeZone` (the viewer's own when omitted), and the zone's short name (`GMT+8`) when it is not UTC. Assembled from parts, not from a locale pattern. */
function clock(d: Date, timeZone: string | undefined): { text: string; zone: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { text: `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`, zone: get("timeZoneName") };
}

/**
 * The reset instant in words, in the viewer's local time with UTC beside it: `31 Oct, 08:00 GMT+8 (31 Oct, 00:00 UTC)`. A viewer in UTC gets
 * `31 Oct, 00:00 UTC` once. An unreadable instant is null. `timeZone` is for tests; the viewer's own zone is used when it is omitted.
 */
export function formatResetTime(resetsAt: string, timeZone?: string): string | null {
  const d = parsedInstant(resetsAt);
  if (!d) return null;
  const utc = clock(d, "UTC").text;
  const local = clock(d, timeZone);
  return local.text === utc ? `${utc} UTC` : `${local.text} ${local.zone} (${utc} UTC)`;
}

/** The UTC month a department stop was for: the month just before the reset (the first of the next month, 00:00 UTC). "this month" when unreadable. */
export function stoppedMonthName(resetsAt: string): string {
  const d = parsedInstant(resetsAt);
  return d ? MONTH_NAMES[new Date(d.getTime() - 1).getUTCMonth()] : "this month";
}

/** The one quiet line under a stopped reply. No numbers: no figure, no count, no percent. */
export function turnBudgetLine(tb: TurnBudget, timeZone?: string): string {
  if (tb.kind === "allowance") {
    const when = formatResetTime(tb.resetsAt, timeZone);
    return `You have reached today's AI allowance. Replies continue in a lighter mode${when ? ` until ${when}` : ""}.`;
  }
  return `Your department has reached its AI budget for ${stoppedMonthName(tb.resetsAt)}. Replies continue in a lighter mode.`;
}

// ── Held hand-offs (AIP-18, §66.11) ───────────────────────────────────────────────────────────────

export const HELD_LABEL = "Waiting: over budget";

/** Which stop holds a hand-off, in a short note that also says it starts by itself. */
export function heldNote(holdKind: "allowance" | "department" | null): string {
  if (holdKind === "allowance") return "Your daily AI allowance is used up. It starts by itself when the allowance resets.";
  if (holdKind === "department") return "Your department's AI budget is used up. It starts by itself when the stop ends.";
  return "It starts by itself when the stop ends.";
}
