// AIP-16 and AIP-05 (BFF §66, PERMISSION-CONTRACT §58, owner rulings AIP-D6 and AIP-D18): the AI usage screens, client-safe half. The wire shape of
// the three reads (§66.2 to §66.5), the pure rules for the month, and the words and figures the screens share. No server import and no I/O, so
// every rule here is a plain unit test. The reader is `aiUsage-data.ts`; the demo answers are `demoAiUsage.ts`.
//
// COUNTS AND MONEY ONLY. No answer carries text, and nothing here invents any.
//
// HONEST FIGURES (the AIP-01 rule). A `null` sum is "unknown", never 0. A cost is an exact decimal STRING and stays one: it is formatted by
// string and BigInt arithmetic, never through a float, because a whole month costs about $0.001 today and a float round trip is exactly where
// a tiny figure would be mangled. Whatever the answer says was estimated, priced from our table or left unpriced is said next to the figure.

import { asCompanyBudgets, asUnitBudget, type CompanyBudgets, type UnitBudgetLine } from "./aiBudget";

// ── The wire shape (§66.2 to §66.5) ───────────────────────────────────────────────────────────────

/** The figures every group carries (§66.2). */
export interface UsageFigures {
  calls: number;
  /** A SUM: null when no call in the group reported tokens (unknown, never 0). */
  promptTokens: number | null;
  completionTokens: number | null;
  /** An exact decimal string (`"0.00106000"`), or null when no call in the group had a cost. */
  costUsd: string | null;
  /** Calls whose tokens are a 4-characters-per-token estimate. */
  estimatedTokenCalls: number;
  /** Calls with no token counts at all. */
  noTokenCalls: number;
  /** Calls with no cost: the part of `costUsd` that is unknown. */
  noCostCalls: number;
  /** Costs from the provider's own figure. */
  providerCostCalls: number;
  /** Costs our price table filled. */
  tableCostCalls: number;
}

export interface UsageCapabilities { canSeePeople: boolean; canManage: boolean; canLiftStop: boolean }

export type SurfaceLine = UsageFigures & { surface: string };
export type ModelLine = UsageFigures & { provider: string | null; model: string | null };
export type DayLine = UsageFigures & { day: string };
export type PersonLine = UsageFigures & { userId: string; name: string | null };
/** `unitNodeId: null` is the bucket "No department recorded" (rows with a person but no node). */
export type DepartmentLine = UsageFigures & { unitNodeId: string | null; name: string | null };

/** §66.3, `GET ai-usage/me`. */
export interface MyUsage {
  month: string;
  totals: UsageFigures;
  bySurface: SurfaceLine[];
  byDay: DayLine[];
  capabilities: UsageCapabilities;
}

/** §66.4, `GET ai-usage/units/:unitNodeId`. `people` is `null` when the answer had no such key (the company tier): never an empty list. */
export interface UnitUsage {
  month: string;
  unit: { unitNodeId: string; name: string | null };
  totals: UsageFigures;
  bySurface: SurfaceLine[];
  byModel: ModelLine[];
  byDay: DayLine[];
  people: PersonLine[] | null;
  /** §66.8: that unit's OWN budget line, or null when none is set (also when an older server sends no key). */
  budget: UnitBudgetLine | null;
  capabilities: UsageCapabilities;
}

/** §66.5, `GET ai-usage/company`. `noPerson` is "Company, no person": rows with neither a person nor a node, by surface. */
export interface CompanyUsage {
  month: string;
  totals: UsageFigures;
  byDepartment: DepartmentLine[];
  noPerson: SurfaceLine[];
  bySurface: SurfaceLine[];
  byModel: ModelLine[];
  byDay: DayLine[];
  /** §66.8: the company's alert figure and every department's budget; empty when none is set. */
  budgets: CompanyBudgets;
  capabilities: UsageCapabilities;
}

// ── Parsing: the answer, checked ──────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function bad(what: string): never {
  throw new Error(`the AI usage answer had a bad ${what}`);
}

/** A count or a sum: a number, or a numeric string (Postgres sums can arrive as one). Anything else is not a figure. */
function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}
function count(v: unknown, what: string): number {
  const n = numberOrNull(v);
  return n === null ? bad(what) : n;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** The figures of one group. A missing or malformed count is a bad answer (never a quiet 0); a sum may be null; a cost is a decimal string or null. */
export function asFigures(raw: unknown, where = "figures"): UsageFigures {
  if (!isObj(raw)) return bad(where);
  const tokens = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : (numberOrNull(v) ?? bad(what)));
  let costUsd: string | null = null;
  if (raw.costUsd !== null && raw.costUsd !== undefined) {
    if (typeof raw.costUsd !== "string" || !DECIMAL.test(raw.costUsd)) return bad(`${where}.costUsd`);
    costUsd = raw.costUsd;
  }
  return {
    calls: count(raw.calls, `${where}.calls`),
    promptTokens: tokens(raw.promptTokens, `${where}.promptTokens`),
    completionTokens: tokens(raw.completionTokens, `${where}.completionTokens`),
    costUsd,
    estimatedTokenCalls: count(raw.estimatedTokenCalls, `${where}.estimatedTokenCalls`),
    noTokenCalls: count(raw.noTokenCalls, `${where}.noTokenCalls`),
    noCostCalls: count(raw.noCostCalls, `${where}.noCostCalls`),
    providerCostCalls: count(raw.providerCostCalls, `${where}.providerCostCalls`),
    tableCostCalls: count(raw.tableCostCalls, `${where}.tableCostCalls`),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function list<T>(raw: unknown, where: string, one: (o: Obj) => T): T[] {
  if (!Array.isArray(raw)) return bad(where);
  return raw.map((r) => (isObj(r) ? one(r) : bad(where)));
}
const surfaceLine = (o: Obj): SurfaceLine => ({ ...asFigures(o, "surface"), surface: str(o.surface) ?? bad("surface") });
const modelLine = (o: Obj): ModelLine => ({ ...asFigures(o, "model"), provider: str(o.provider), model: str(o.model) });
const dayLine = (o: Obj): DayLine => ({ ...asFigures(o, "day"), day: typeof o.day === "string" && /^\d{4}-\d{2}-\d{2}/.test(o.day) ? o.day.slice(0, 10) : bad("day") });
const personLine = (o: Obj): PersonLine => ({ ...asFigures(o, "person"), userId: str(o.userId) ?? bad("person"), name: str(o.name) });
const departmentLine = (o: Obj): DepartmentLine => ({ ...asFigures(o, "department"), unitNodeId: str(o.unitNodeId), name: str(o.name) });

function asCapabilities(raw: unknown): UsageCapabilities {
  const o = isObj(raw) ? raw : {};
  return { canSeePeople: o.canSeePeople === true, canManage: o.canManage === true, canLiftStop: o.canLiftStop === true };
}

function monthOf(o: Obj): string {
  return typeof o.month === "string" && MONTH_RE.test(o.month) ? o.month : bad("month");
}

export function asMyUsage(raw: unknown): MyUsage {
  if (!isObj(raw)) return bad("answer");
  return {
    month: monthOf(raw),
    totals: asFigures(raw.totals, "totals"),
    bySurface: list(raw.bySurface, "bySurface", surfaceLine),
    byDay: list(raw.byDay, "byDay", dayLine),
    capabilities: asCapabilities(raw.capabilities),
  };
}

export function asUnitUsage(raw: unknown): UnitUsage {
  if (!isObj(raw)) return bad("answer");
  const u = isObj(raw.unit) ? raw.unit : null;
  if (!u || typeof u.unitNodeId !== "string") return bad("unit");
  return {
    month: monthOf(raw),
    unit: { unitNodeId: u.unitNodeId, name: str(u.name) },
    totals: asFigures(raw.totals, "totals"),
    bySurface: list(raw.bySurface, "bySurface", surfaceLine),
    byModel: list(raw.byModel, "byModel", modelLine),
    byDay: list(raw.byDay, "byDay", dayLine),
    // The server omits the key for the company tier. Absent stays absent (`null`): it is not "nobody".
    people: "people" in raw && raw.people !== undefined ? list(raw.people, "people", personLine) : null,
    budget: asUnitBudget(raw.budget),
    capabilities: asCapabilities(raw.capabilities),
  };
}

export function asCompanyUsage(raw: unknown): CompanyUsage {
  if (!isObj(raw)) return bad("answer");
  return {
    month: monthOf(raw),
    totals: asFigures(raw.totals, "totals"),
    byDepartment: list(raw.byDepartment, "byDepartment", departmentLine),
    noPerson: list(raw.noPerson, "noPerson", surfaceLine),
    bySurface: list(raw.bySurface, "bySurface", surfaceLine),
    byModel: list(raw.byModel, "byModel", modelLine),
    byDay: list(raw.byDay, "byDay", dayLine),
    budgets: asCompanyBudgets(raw.budgets),
    capabilities: asCapabilities(raw.capabilities),
  };
}

// ── The month (UTC calendar months, §66.2) ────────────────────────────────────────────────────────

/** `YYYY-MM`, month 01 to 12, year 1970 to 9998: what the server accepts. */
export const MONTH_RE = /^(19[7-9]\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The UTC month of `now`, as `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month the page shows: the `?month=` when it is a real one, else the current UTC month. The server never sees anything else. */
export function parseMonth(raw: string | string[] | undefined, now: Date = new Date()): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && MONTH_RE.test(v) && !isAfter(v, currentMonth(now)) ? v : currentMonth(now);
}

const isAfter = (a: string, b: string): boolean => a > b; // `YYYY-MM` sorts as text

/** The month `delta` months from `month` (`2026-01`, -1 is `2025-12`). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** "October 2026". Pure string work, so the server and the client agree. An unreadable value comes back as it was. */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const i = m ? Number(m[2]) - 1 : -1;
  return m && i >= 0 && i < 12 ? `${MONTH_NAMES[i]} ${m[1]}` : month;
}

/** The last `n` months, newest first, ending at the current one: the picker's choices. */
export function recentMonths(now: Date = new Date(), n = 12): string[] {
  const cur = currentMonth(now);
  return Array.from({ length: n }, (_, i) => shiftMonth(cur, -i));
}

/** "3 Oct" from `2026-10-03` (the UTC day). */
export function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
  const i = m ? Number(m[1]) - 1 : -1;
  return m && i >= 0 && i < 12 ? `${Number(m[2])} ${MONTH_NAMES[i].slice(0, 3)}` : day;
}

// ── Where the screens live ────────────────────────────────────────────────────────────────────────

export const MY_AI_USAGE_PATH = "/analytics/ai-usage";
export const DEPARTMENT_AI_USAGE_PATH = "/analytics/ai-usage/department";
export const COMPANY_AI_USAGE_PATH = "/ai-usage";

const withQuery = (path: string, params: Record<string, string | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
};

export const myAiUsageHref = (month?: string): string => withQuery(MY_AI_USAGE_PATH, { month });
export const departmentAiUsageHref = (unit?: string, month?: string): string => withQuery(DEPARTMENT_AI_USAGE_PATH, { unit, month });
export const companyAiUsageHref = (month?: string): string => withQuery(COMPANY_AI_USAGE_PATH, { month });

/** `GET allowances` (§66.9), under the tenant: `manage` only. */
export const allowancesPath = (tenantId: string): string => `/api/${encodeURIComponent(tenantId)}/ai-usage/allowances`;

/** The read routes' paths and query (§66.3 to §66.5), under the tenant. */
export const myUsagePath = (tenantId: string, month: string): string => `/api/${encodeURIComponent(tenantId)}/ai-usage/me?month=${encodeURIComponent(month)}`;
export const unitUsagePath = (tenantId: string, unitNodeId: string, month: string): string =>
  `/api/${encodeURIComponent(tenantId)}/ai-usage/units/${encodeURIComponent(unitNodeId)}?month=${encodeURIComponent(month)}`;
export const companyUsagePath = (tenantId: string, month: string): string => `/api/${encodeURIComponent(tenantId)}/ai-usage/company?month=${encodeURIComponent(month)}`;

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────

export const UNKNOWN = "unknown";

const SURFACE_LABELS: Record<string, string> = {
  assistant: "Assistant replies",
  compaction: "Assistant chat summaries",
  title: "Assistant chat titles",
  agent: "AI agents",
  knowledge: "Knowledge (embedding and search)",
  search: "Search tools",
  bot: "Chat bots",
  other: "Other",
};

/** A surface in words. A surface this build does not know is shown as the server named it, never dropped. */
export function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] ?? (surface === "" ? "Other" : surface.charAt(0).toUpperCase() + surface.slice(1).replace(/[_-]+/g, " "));
}

/** A model line in words: `provider / model`, either missing part said as unknown. */
export function modelLabel(m: { provider: string | null; model: string | null }): string {
  if (!m.provider && !m.model) return "Model not recorded";
  return [m.provider, m.model ?? "model not recorded"].filter(Boolean).join(" / ");
}

export const NO_DEPARTMENT = "No department recorded";
export const NO_PERSON = "Company, no person";

export const departmentLabel = (d: { unitNodeId: string | null; name: string | null }): string =>
  d.unitNodeId === null ? NO_DEPARTMENT : (d.name ?? "Department not in the organisation tree");

export const personLabel = (p: { name: string | null }): string => p.name ?? "Name not available";

export const noUseText = (month: string): string => `No AI use recorded in ${monthLabel(month)}`;

export const AI_USAGE_FORBIDDEN = "Only the department's head, the owner and company admins can open a department's AI usage. Your own use is under Analytics › My AI use.";
export const AI_USAGE_COMPANY_FORBIDDEN = "The company's AI usage is for the owner, the GM, company admins and the superadmin. Your own use is under Analytics › My AI use.";
export const AI_USAGE_NOT_FOUND = "This department was not found. It may have been removed, or it is not a department of this company.";

// ── Figures in words ──────────────────────────────────────────────────────────────────────────────

/** A count with thousands separators, fixed to en-US so the server and the browser render the same text. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** A token sum: null is unknown, never 0. */
export const formatTokens = (n: number | null): string => (n === null ? UNKNOWN : formatCount(n));

const TINY_COST = "under $0.0001";

/**
 * A cost in USD from its decimal string, by string and BigInt arithmetic (never a float):
 * - null is "unknown", never `$0`;
 * - under $1: four decimals, half up (`"0.00106000"` is `$0.0011`);
 * - a non-zero cost under $0.0001 is "under $0.0001", never `$0.0000`;
 * - $1 and over: two decimals with thousands separators.
 * A value that is not a plain decimal string is "unknown" rather than guessed at.
 */
export function formatCost(costUsd: string | null): string {
  if (costUsd === null || !DECIMAL.test(costUsd)) return UNKNOWN;
  const [whole, frac = ""] = costUsd.split(".");
  const intPart = BigInt(whole);
  const scale = frac.length;
  const digits = BigInt(`${whole}${frac}`);
  if (digits === 0n) return intPart === 0n ? "$0.0000" : "$0.00";
  const pow = (n: number): bigint => 10n ** BigInt(n);
  const roundTo = (places: number): bigint => {
    // `digits / 10^scale` in units of `10^-places`, half up.
    if (scale <= places) return digits * pow(places - scale);
    const div = pow(scale - places);
    const q = digits / div;
    return (digits % div) * 2n >= div ? q + 1n : q;
  };
  if (intPart === 0n) {
    // Strictly under $0.0001, before any rounding could lift it to it.
    if (scale >= 4 ? digits < pow(scale - 4) : false) return TINY_COST;
    const u = roundTo(4);
    if (u >= 10000n) return "$1.00"; // 0.99996 rounds up to a dollar: that is the two-decimal tier
    return `$0.${u.toString().padStart(4, "0")}`;
  }
  const cents = roundTo(2);
  const dollars = cents / 100n;
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "1 call" / "3 calls". */
const calls = (n: number): string => `${formatCount(n)} ${n === 1 ? "call" : "calls"}`;

/** What the cost's own counts say about where it came from, or null when it all came from the provider's figure (the norm). */
export function costMark(f: Pick<UsageFigures, "providerCostCalls" | "tableCostCalls">): string | null {
  if (f.tableCostCalls > 0) return f.providerCostCalls > 0 ? "partly from our price table" : "from our price table";
  return null;
}

/** "estimated" when any call's tokens are a 4-characters-per-token estimate. */
export function tokenMark(f: Pick<UsageFigures, "estimatedTokenCalls">): string | null {
  return f.estimatedTokenCalls > 0 ? "estimated" : null;
}

/** "partial" when a cost is shown but some calls in the group had none: the figure is a floor, not the whole. */
export function costGapMark(f: Pick<UsageFigures, "costUsd" | "noCostCalls">): string | null {
  return f.costUsd !== null && f.noCostCalls > 0 ? "partial" : null;
}

/** The sentences under a group's figures that say what is estimated, priced from our table or missing. Empty when everything is the provider's own. */
export function figureNotes(f: UsageFigures): string[] {
  const out: string[] = [];
  if (f.estimatedTokenCalls > 0) out.push(`Tokens are estimated for ${calls(f.estimatedTokenCalls)} (about 4 characters a token).`);
  if (f.noTokenCalls > 0) out.push(`${calls(f.noTokenCalls)} reported no token counts, so the token sums leave them out.`);
  if (f.tableCostCalls > 0) out.push(`Cost is from our price table for ${calls(f.tableCostCalls)}${f.providerCostCalls > 0 ? ` and the provider's own figure for ${calls(f.providerCostCalls)}` : ""}.`);
  else if (f.providerCostCalls > 0) out.push("Cost is the provider's own figure.");
  if (f.noCostCalls > 0) out.push(`${calls(f.noCostCalls)} had no cost figure, so the cost is ${f.costUsd === null ? "unknown" : "a floor, not the whole"}.`);
  return out;
}

/** An empty month: nothing at all recorded in the answer's totals. */
export const isEmptyMonth = (totals: UsageFigures): boolean => totals.calls === 0;

// ── Budget lines in words (§66.8; the rules and the wire shape are in `aiBudget.ts`) ─────────────

/** What has been spent against the figure, in words: `$0.8000 of $1.0000`. Unknown spend says so, never `$0`. */
export function budgetSpentText(b: { spentUsd: string | null; monthlyUsd: string }): string {
  return `${formatCost(b.spentUsd)} of ${formatCost(b.monthlyUsd)}`;
}

/** The note under a budget line when some calls had no cost: they are never counted against the figure. */
export function budgetNoCostNote(noCostCalls: number): string | null {
  return noCostCalls > 0 ? `${calls(noCostCalls)} had no cost figure, so ${noCostCalls === 1 ? "it is" : "they are"} not counted against the figure.` : null;
}
