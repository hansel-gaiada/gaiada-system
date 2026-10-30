import "server-only";
// TEMP DEMO MODE: the AI usage reads (AIP-15, AIP-16, AIP-05; BFF §66), after `demoAssistantGuidance.ts` (the same people, the same placement). Routed
// from `demoFixtures.getDemoResponse`, so the three screens work with no backend. Read-only and deterministic: the same month answers the same figures.
// It models the rules the UI depends on, in the server's order of checks (PERMISSION-CONTRACT §58):
//   - `me`: any staff identity reads its own month; `demo-client*` (a client contact) is 403.
//   - `units/:id`: the owner (`demo-owner`) gets `people` on any unit; the head of a unit (`u-webhead` leads dept-1, `dept-manager` leads dept-3) gets
//     `people` on their own unit; the company admin (`demo-hansel`) gets the totals with NO `people` key; anyone else is 403 BEFORE anything says
//     whether the unit exists; an unknown unit is 404 `unit_not_found` for the company tier.
//   - `company`: the owner and the company admin only (the GM seat is not modelled).
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

const CAPS = (people: boolean, manage: boolean) => ({ canSeePeople: people, canManage: manage, canLiftStop: manage });

export function aiUsageDemo(method: string, p: string, searchParams: URLSearchParams, userId: string): DemoResult | null {
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
    return ok({ month, totals: b.totals, byDepartment, noPerson, byModel: b.byModel, bySurface: b.bySurface, byDay: b.byDay, capabilities: CAPS(userId === OWNER, userId === OWNER) });
  }
  // A unit.
  if (unit === null || !UNITS[unit]) return err(404, "unit_not_found");
  const b = has ? body(month, 0.15) : emptyBody(month);
  const out: Record<string, unknown> = { month, unit: { unitNodeId: unit, name: UNITS[unit] }, totals: b.totals, bySurface: b.bySurface, byModel: b.byModel, byDay: b.byDay };
  if (decision === "unit-people") {
    const people = PEOPLE[unit] ?? [];
    out.people = has ? people.map((pe, i) => ({ ...pe, ...scaled(sum(body(month, 0.15 / (i + 2)).bySurface), 1) })) : [];
  }
  out.capabilities = CAPS(decision === "unit-people", userId === OWNER);
  return ok(out);
}
