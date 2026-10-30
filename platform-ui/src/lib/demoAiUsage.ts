import "server-only";
// TEMP DEMO MODE: the AI usage reads (AIP-15, AIP-16, AIP-05; BFF §66), after `demoAssistantGuidance.ts` (the same people, the same placement). Routed
// from `demoFixtures.getDemoResponse`, so the three screens work with no backend. Read-only and deterministic: the same month answers the same figures.
// It models the rules the UI depends on, in the server's order of checks (PERMISSION-CONTRACT §58):
//   - `me`: any staff identity reads its own month; `demo-client*` (a client contact) is 403.
//   - `units/:id`: the owner (`demo-owner`) gets `people` on any unit; the head of a unit (`u-webhead` leads dept-1, `dept-manager` leads dept-3) gets
//     `people` on their own unit; the company admin (`demo-hansel`) gets the totals with NO `people` key; anyone else is 403 BEFORE anything says
//     whether the unit exists; an unknown unit is 404 `unit_not_found` for the company tier.
//   - `company`: the owner and the company admin only (the GM seat is not modelled).
// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11): the budget lines, the owner's writes and the lift, in a STATEFUL store (a write moves what the next read says).
// Seeded so each piece is drivable: the company alert figure at 80 percent or more, Web Dev (`dept-1`) in Soft stop mode and over its figure (the owner and
// Ketut Arta, its head, see "Lift the stop for the rest of this month"; after the lift the line says "lifted for this month"), SEO (`dept-3`) in Report only
// and well under, and one per-person allowance override (Made Putra). Writes follow the server's order of checks: `manage` is asked first (403 before the
// body is looked at), then the body (400), then the unit or the person (404). A lift is `manage`, or the head of that unit.
// Only September and October 2026 hold any use (so "No AI use recorded in <month>" is drivable by picking any other month). The figures show the live
// shape: knowledge embeds outnumber replies about 3,000 to 1, one surface is priced from our price table, one has estimated tokens, one has no
// token counts at all (a null sum), and a whole month costs about a tenth of a cent.
interface DemoResult { status: number; json: unknown }
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { message: error, field, error } : { error } });

const TENANT = "co-agency";
const UNITS: Record<string, string> = {
  "dept-1": "Web Dev", "dept-2": "Creatives", "dept-3": "SEO", "dept-4": "Social Media", "dept-5": "GM", "dept-6": "HR", "dept-7": "Finance", "dept-8": "IT",
};
const OWNER = "demo-owner";
const ADMIN = "demo-hansel";
const LED: Record<string, string[]> = { "u-webhead": ["dept-1"], "dept-manager": ["dept-3"] };
const PEOPLE: Record<string, { userId: string; name: string }[]> = {
  "dept-1": [{ userId: "u-webhead", name: "Ketut Arta" }, { userId: "u-web-2", name: "Made Putra" }],
  "dept-3": [{ userId: "dept-manager", name: "Wayan Sari" }],
};
const MONTHS_WITH_USE = new Set(["2026-09", "2026-10"]);

// ── The budget store (AIP-17b, AIP-18) ───────────────────────────────────────────────────────────
type Mode = "report" | "soft_stop";
interface BudgetStore {
  company: string | null;
  units: Record<string, { monthlyUsd: string; mode: Mode; liftedMonth: string | null }>;
  defaultDailyReplies: number;
  overrides: Record<string, { dailyReplies: number; updatedAt: string }>;
}
declare global {
  // eslint-disable-next-line no-var
  var __gaiadaDemoAiBudgets: BudgetStore | undefined;
}
// One store for the whole process (the route handler and the pages can load this module twice in dev), as `demoAssistant.ts` does.
const STORE: BudgetStore = globalThis.__gaiadaDemoAiBudgets ?? (globalThis.__gaiadaDemoAiBudgets = {
  company: "0.0011",
  units: { "dept-1": { monthlyUsd: "0.0001", mode: "soft_stop", liftedMonth: null }, "dept-3": { monthlyUsd: "0.0010", mode: "report", liftedMonth: null } },
  defaultDailyReplies: 200,
  overrides: { "u-web-2": { dailyReplies: 350, updatedAt: "2026-10-29T10:00:00.000Z" } },
});
const KNOWN_PEOPLE = new Set(Object.values(PEOPLE).flat().map((x) => x.userId));
const personName = (id: string): string | null => Object.values(PEOPLE).flat().find((x) => x.userId === id)?.name ?? null;

/** A decimal string as a BigInt scaled by 10^8 (the demo's costs are 8-place strings). */
const scaled8 = (d: string): bigint => { const [w, f = ""] = d.split("."); return BigInt(w) * 100000000n + BigInt(f.slice(0, 8).padEnd(8, "0")); };
/** The server's canonical figure: 4 places. */
const canonical = (raw: string): string => { const m = /^([0-9]{1,8})(?:\.([0-9]{1,4}))?$/.exec(raw)!; return `${m[1].replace(/^0+(?=[0-9])/, "")}.${(m[2] ?? "").padEnd(4, "0")}`; };

/** §66.8 figures: exact decimal arithmetic, percent floored to one decimal. */
function budgetFigures(spentUsd: string | null, monthlyUsd: string) {
  const spent = spentUsd === null ? 0n : scaled8(spentUsd);
  const monthly = scaled8(monthlyUsd);
  const percent = Number((spent * 1000n) / monthly) / 10;
  const state = spent * 100n >= monthly * 100n ? "over_100" : spent * 100n >= monthly * 80n ? "over_80" : "under";
  return { monthlyUsd, spentUsd, noCostCalls: spentUsd === null ? 0 : 3, percent, state };
}
const unitSpent = (month: string): string | null => (MONTHS_WITH_USE.has(month) ? body(month, 0.15).totals.costUsd : null);
const companySpent = (month: string): string | null => (MONTHS_WITH_USE.has(month) ? body(month, 1).totals.costUsd : null);
const unitLine = (id: string, month: string) => {
  const b = STORE.units[id];
  return b ? { unitNodeId: id, name: UNITS[id] ?? null, mode: b.mode, ...budgetFigures(unitSpent(month), b.monthlyUsd), stopLifted: b.liftedMonth === month } : null;
};
const companyLine = (month: string) => (STORE.company === null ? null : budgetFigures(companySpent(month), STORE.company));

interface Figures {
  calls: number; promptTokens: number | null; completionTokens: number | null; costUsd: string | null;
  estimatedTokenCalls: number; noTokenCalls: number; noCostCalls: number; providerCostCalls: number; tableCostCalls: number;
}
const ZERO: Figures = { calls: 0, promptTokens: null, completionTokens: null, costUsd: null, estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 0, tableCostCalls: 0 };

/** A deterministic scale for a month, so September differs from October. */
const scaleOf = (month: string): number => (month === "2026-09" ? 0.6 : 1);
const scaled = (f: Figures, k: number): Figures => ({
  ...f,
  calls: Math.max(1, Math.round(f.calls * k)),
  promptTokens: f.promptTokens === null ? null : Math.round(f.promptTokens * k),
  completionTokens: f.completionTokens === null ? null : Math.round(f.completionTokens * k),
  costUsd: f.costUsd === null ? null : (Number(f.costUsd) * k).toFixed(8),
});

const SURFACES: (Figures & { surface: string })[] = [
  { surface: "knowledge", calls: 3180, promptTokens: 412000, completionTokens: 0, costUsd: "0.00004100", estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 3180, tableCostCalls: 0 },
  { surface: "assistant", calls: 14, promptTokens: 9200, completionTokens: 2100, costUsd: "0.00086000", estimatedTokenCalls: 2, noTokenCalls: 0, noCostCalls: 3, providerCostCalls: 8, tableCostCalls: 3 },
  { surface: "title", calls: 6, promptTokens: 700, completionTokens: 40, costUsd: "0.00000900", estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 6, tableCostCalls: 0 },
  { surface: "agent", calls: 5, promptTokens: null, completionTokens: null, costUsd: null, estimatedTokenCalls: 0, noTokenCalls: 5, noCostCalls: 5, providerCostCalls: 0, tableCostCalls: 0 },
];
const MODELS: (Figures & { provider: string | null; model: string | null })[] = [
  { provider: "openrouter", model: "z-ai/glm-5.3-flash", calls: 25, promptTokens: 9900, completionTokens: 2140, costUsd: "0.00086900", estimatedTokenCalls: 2, noTokenCalls: 0, noCostCalls: 3, providerCostCalls: 14, tableCostCalls: 3 },
  { provider: "openrouter", model: "openai/text-embedding-3-small", calls: 3180, promptTokens: 412000, completionTokens: 0, costUsd: "0.00004100", estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 3180, tableCostCalls: 0 },
  { provider: null, model: null, calls: 5, promptTokens: null, completionTokens: null, costUsd: null, estimatedTokenCalls: 0, noTokenCalls: 5, noCostCalls: 5, providerCostCalls: 0, tableCostCalls: 0 },
];
const DAYS = ["01", "02", "05", "07", "12", "15", "20", "26"];

function sum(rows: Figures[]): Figures {
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
  let cost: bigint | null = null;
  for (const r of rows) if (r.costUsd !== null) cost = (cost ?? 0n) + BigInt(Math.round(Number(r.costUsd) * 1e8));
  const out = rows.reduce<Figures>((a, r) => ({
    calls: a.calls + r.calls, promptTokens: add(a.promptTokens, r.promptTokens), completionTokens: add(a.completionTokens, r.completionTokens), costUsd: null,
    estimatedTokenCalls: a.estimatedTokenCalls + r.estimatedTokenCalls, noTokenCalls: a.noTokenCalls + r.noTokenCalls, noCostCalls: a.noCostCalls + r.noCostCalls,
    providerCostCalls: a.providerCostCalls + r.providerCostCalls, tableCostCalls: a.tableCostCalls + r.tableCostCalls,
  }), ZERO);
  return { ...out, costUsd: cost === null ? null : `${cost / 100000000n}.${(cost % 100000000n).toString().padStart(8, "0")}` };
}

/** One group's month: the surfaces, models and days, each scaled by `k` (a unit is a share of the company). */
function body(month: string, k: number) {
  const km = k * scaleOf(month);
  const bySurface = SURFACES.map((s) => ({ surface: s.surface, ...scaled(s, km) }));
  const byModel = MODELS.map((m) => ({ provider: m.provider, model: m.model, ...scaled(m, km) }));
  const totals = sum(bySurface);
  const share = 1 / DAYS.length;
  const byDay = DAYS.map((d) => ({ day: `${month}-${d}`, ...scaled(totals, share) }));
  return { month, totals, bySurface, byModel, byDay };
}
const emptyBody = (month: string) => ({ month, totals: { ...ZERO }, bySurface: [], byModel: [], byDay: [] });

const CAPS = (people: boolean, manage: boolean, lift = manage) => ({ canSeePeople: people, canManage: manage, canLiftStop: lift });

function writes(method: string, p: string, userId: string, rawBody: string | undefined): DemoResult | null {
  const w = p.match(/^\/api\/([^/]+)\/ai-usage\/(allowances|allowances\/([^/]+)|budgets\/company|budgets\/units\/([^/]+)|budgets\/units\/([^/]+)\/lift)$/);
  if (!w) return null;
  const verb = method.toUpperCase();
  const route = w[2];
  const isGet = verb === "GET" && route === "allowances";
  const isPut = verb === "PUT" && (route.startsWith("allowances/") || route === "budgets/company" || (route.startsWith("budgets/units/") && !route.endsWith("/lift")));
  const isLift = verb === "POST" && route.endsWith("/lift");
  if (!isGet && !isPut && !isLift) return err(404, "not_found");
  // `budgets/units/:id` captures group 4, `budgets/units/:id/lift` group 5 (the regex tries 4 first, which cannot match a slash).
  const unitRaw = w[5] ?? w[4];
  const unit = unitRaw ? decodeURIComponent(unitRaw) : null;

  // Authorization first, before the body, the unit or the person is looked at.
  const isOwner = w[1] === TENANT && userId === OWNER;
  const mayLift = isOwner || (w[1] === TENANT && unit !== null && (LED[userId] ?? []).includes(unit));
  if (isLift ? !mayLift : !isOwner) return err(403, "Forbidden");

  if (isGet) {
    return ok({
      defaultDailyReplies: STORE.defaultDailyReplies,
      overrides: Object.entries(STORE.overrides).map(([id, o]) => ({ userId: id, name: personName(id), dailyReplies: o.dailyReplies, updatedAt: o.updatedAt })),
    });
  }
  const month = new Date().toISOString().slice(0, 7);
  if (isLift) {
    if (unit === null || !UNITS[unit]) return err(404, "unit_not_found", "unitNodeId");
    const b = STORE.units[unit];
    if (!b || b.mode !== "soft_stop") return err(404, "no_soft_stop", "unitNodeId");
    const changed = b.liftedMonth !== month;
    b.liftedMonth = month;
    return ok({ month, changed, budget: unitLine(unit, month) });
  }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawBody || "{}") as Record<string, unknown>; } catch { return err(400, "the body must be an object", "body"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "the body must be an object", "body");

  if (route.startsWith("allowances/")) {
    const target = decodeURIComponent(route.slice("allowances/".length));
    const extra = Object.keys(parsed).find((k) => k !== "dailyReplies");
    if (extra) return err(400, `unknown field: ${extra}`, extra);
    if (!("dailyReplies" in parsed)) return err(400, "dailyReplies is required (a whole number, or null to use the default)", "dailyReplies");
    const n = parsed.dailyReplies;
    if (n !== null && !(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100000)) return err(400, "dailyReplies must be a whole number from 1 to 100000, or null", "dailyReplies");
    if (!KNOWN_PEOPLE.has(target)) return err(404, "person_not_found", "userId");
    const had = STORE.overrides[target];
    if (n === null) delete STORE.overrides[target];
    else STORE.overrides[target] = { dailyReplies: n as number, updatedAt: new Date().toISOString() };
    return ok({ userId: target, changed: n === null ? !!had : had?.dailyReplies !== n, dailyReplies: n ?? STORE.defaultDailyReplies, isDefault: n === null });
  }

  const isCompany = route === "budgets/company";
  const extra = Object.keys(parsed).find((k) => k !== "monthlyUsd" && (isCompany || k !== "mode"));
  if (extra) return err(400, `unknown field: ${extra}`, extra);
  if (!("monthlyUsd" in parsed)) return err(400, "monthlyUsd is required (a decimal string, or null to remove it)", "monthlyUsd");
  const fig = parsed.monthlyUsd;
  let figure: string | null = null;
  if (fig !== null) {
    if (typeof fig !== "string") return err(400, 'monthlyUsd must be a decimal string such as "250.00"', "monthlyUsd");
    if (!/^[0-9]{1,8}(?:\.[0-9]{1,4})?$/.test(fig)) return err(400, "monthlyUsd must be a positive decimal with at most 4 decimal places and at most 99999999.9999", "monthlyUsd");
    if (!/[1-9]/.test(fig)) return err(400, "monthlyUsd must be greater than 0 (remove the figure with null)", "monthlyUsd");
    figure = canonical(fig);
  }
  const mode = parsed.mode;
  if (mode !== undefined && mode !== "report" && mode !== "soft_stop") return err(400, "mode must be one of report, soft_stop", "mode");
  if (mode !== undefined && figure === null) return err(400, "mode needs a figure: a removed budget has no mode", "mode");

  if (isCompany) {
    const changed = STORE.company !== figure;
    STORE.company = figure;
    return ok({ month, changed, budget: companyLine(month) });
  }
  if (unit === null || !UNITS[unit]) return err(404, "unit_not_found", "unitNodeId");
  const had = STORE.units[unit];
  if (figure === null) {
    delete STORE.units[unit];
    return ok({ month, changed: !!had, budget: null });
  }
  const next = { monthlyUsd: figure, mode: (mode as Mode | undefined) ?? had?.mode ?? "report", liftedMonth: had?.liftedMonth ?? null };
  const changed = !had || had.monthlyUsd !== next.monthlyUsd || had.mode !== next.mode;
  STORE.units[unit] = next;
  return ok({ month, changed, budget: unitLine(unit, month) });
}

export function aiUsageDemo(method: string, p: string, searchParams: URLSearchParams, userId: string, rawBody?: string): DemoResult | null {
  const written = writes(method, p, userId, rawBody);
  if (written) return written;
  const m = p.match(/^\/api\/([^/]+)\/ai-usage\/(me|company|units\/([^/]+))$/);
  if (!m) return null;
  if (method.toUpperCase() !== "GET") return err(404, "not_found");
  const tenant = m[1];
  const route = m[2];
  const isClient = userId.startsWith("demo-client");
  const monthParam = searchParams.get("month");
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Authorization first (a refused caller always gets 403, never 400).
  let decision: "own" | "unit-people" | "unit-totals" | "company" | "refused" = "refused";
  const unit = m[3] ? decodeURIComponent(m[3]) : null;
  if (tenant === TENANT && !isClient) {
    if (route === "me") decision = "own";
    else if (route === "company") decision = userId === OWNER || userId === ADMIN ? "company" : "refused";
    else if (userId === OWNER || (unit !== null && (LED[userId] ?? []).includes(unit))) decision = "unit-people";
    else if (userId === ADMIN) decision = "unit-totals";
  }
  if (decision === "refused") return err(403, "Forbidden");

  const month = monthParam ?? currentMonth;
  if (!/^(19[7-9]\d|[2-9]\d{3})-(0[1-9]|1[0-2])$/.test(month)) return err(400, "month must be YYYY-MM", "month");
  const has = MONTHS_WITH_USE.has(month);

  if (decision === "own") {
    const b = has ? body(month, 0.002) : emptyBody(month);
    return ok({ month, totals: b.totals, bySurface: b.bySurface, byDay: b.byDay, capabilities: CAPS(false, false) });
  }
  if (decision === "company") {
    const b = has ? body(month, 1) : emptyBody(month);
    const names = Object.entries(UNITS);
    const byDepartment = has
      ? [
          ...names.slice(0, 4).map(([id, name], i) => ({ unitNodeId: id, name, ...scaled(sum(body(month, 0.12 / (i + 1)).bySurface), 1) })),
          { unitNodeId: null, name: null, ...scaled(sum(body(month, 0.05).bySurface), 1) },
        ]
      : [];
    const noPerson = has ? [{ surface: "knowledge", ...scaled(SURFACES[0], scaleOf(month) * 0.4) }] : [];
    const budgets = { company: companyLine(month), units: Object.keys(STORE.units).sort().map((id) => unitLine(id, month)) };
    return ok({ month, totals: b.totals, byDepartment, noPerson, byModel: b.byModel, bySurface: b.bySurface, byDay: b.byDay, budgets, capabilities: CAPS(userId === OWNER, userId === OWNER) });
  }
  // A unit.
  if (unit === null || !UNITS[unit]) return err(404, "unit_not_found");
  const b = has ? body(month, 0.15) : emptyBody(month);
  const out: Record<string, unknown> = { month, unit: { unitNodeId: unit, name: UNITS[unit] }, totals: b.totals, bySurface: b.bySurface, byModel: b.byModel, byDay: b.byDay };
  if (decision === "unit-people") {
    const people = PEOPLE[unit] ?? [];
    out.people = has ? people.map((pe, i) => ({ ...pe, ...scaled(sum(body(month, 0.15 / (i + 2)).bySurface), 1) })) : [];
  }
  out.budget = unitLine(unit, month);
  out.capabilities = CAPS(decision === "unit-people", userId === OWNER, userId === OWNER || (LED[userId] ?? []).includes(unit));
  return ok(out);
}
