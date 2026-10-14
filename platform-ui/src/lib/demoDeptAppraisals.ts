import "server-only";
// DW-4e-3 — DEMO_MODE fixtures for the department appraisal API (BFF §41, `GET /api/:t/dept-appraisals` and the two PUTs).
// Routed from demoFixtures.getDemoResponse; same convention as demoDeptKpis.ts: own file, `(method, p, qs, body, userId) =>
// DemoResult | null`, no import of demoFixtures.
//
// NOTHING IS INVENTED TWICE. The KPIs over a cycle and the condition of each month come from the department KPI fixture
// (demoDeptKpis.ts) by calling its own route, exactly as the real endpoint calls the section 40 engine: one custom range
// for the cycle judged against the target in force for the cycle's LAST month, then one month read per calendar month. The
// cycles come from the appraisal cycles fixture (demoAppraisals.ts) the same way, so a status change there (closing a cycle)
// is seen here: `demo-cycle-h2` is the OPEN cycle and `demo-cycle-h1` the CLOSED one. Only the people block (counts) and the
// two stored halves are held here.
//
// WHO (the same wiring as demoDeptKpis): the read is for the unit's heads (`whoReads` = "led") and the company-wide tiers
// ("wide": `demo-hansel`, `demo-owner`); a unit's staff, and anyone else, get 403 BEFORE any word on whether the unit or cycle
// exists, exactly as the server orders it. `demo-hansel` (company_admin) comments and assesses; `demo-owner` assesses but cannot
// comment (no appraisal_comment mirror); a head comments on their own unit only. A write on a closed cycle is 409 `cycle_closed`.
//
// STATEFUL for the two halves, so the flow (a head writes, the GM assesses, the cycle closes) can be exercised. Module-level
// state persists across requests in one dev-server process and resets on restart; `resetDeptAppraisalDemo()` is for tests.
import { appraisalsDemo } from "./demoAppraisals";
import { deptKpisDemo, whoReads } from "./demoDeptKpis";
import { isGmCondition, MAX_APPRAISAL_TEXT } from "./deptAppraisalFormat";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const GM = "demo-hansel";
const ASSESSORS = new Set(["demo-hansel", "demo-owner"]);
const MIN_SCORED = 3;
const NAMES: Record<string, string> = { "demo-hansel": "Hansel", "demo-head-webdev": "Web Dev head", "dept-manager": "SEO head" };

// ─────────────────────────────────────────────────────────────────── the people block ───────────────
interface PeopleRow { status: string; composite: number | null }
const STATUSES = ["draft", "submitted", "acknowledged", "disputed", "finalized"] as const;

/** The server's rule (dept-appraisals.ts `aggregatePeople`) on a fixed list of rows: counts, and the distribution unless fewer than 3 are scored. */
function aggregate(rows: readonly PeopleRow[]) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  const bands = [0, 0, 0, 0, 0];
  let scored = 0;
  for (const r of rows) {
    if ((STATUSES as readonly string[]).includes(r.status)) byStatus[r.status as (typeof STATUSES)[number]] += 1;
    if (r.status === "draft" || r.composite === null) continue;
    bands[Math.min(5, Math.max(1, Math.round(r.composite))) - 1] += 1;
    scored += 1;
  }
  if (scored < MIN_SCORED) return { total: rows.length, byStatus, distribution: null, reason: "too_few" as const };
  return { total: rows.length, byStatus, distribution: bands.map((count, i) => ({ band: i + 1, count })) };
}

const row = (status: string, composite: number | null): PeopleRow => ({ status, composite });
/** The cycle's appraisals of each unit's roster (a unit's people, counted; nobody is named). Units not listed have none. */
const PEOPLE: Record<string, Record<string, PeopleRow[]>> = {
  "demo-cycle-h2": {
    "dept-1": [row("draft", null), row("submitted", 3.2), row("submitted", 3.6), row("acknowledged", 4.1), row("finalized", 4.4), row("finalized", 4.9)],
    "dept-3": [row("submitted", 3.8), row("draft", null)],
    "dept-2": [row("submitted", 2.4), row("submitted", 3.1), row("acknowledged", 3.4)],
  },
  "demo-cycle-h1": {
    "dept-1": [row("finalized", 3.4), row("finalized", 4.2), row("finalized", 3.9), row("finalized", 4.6), row("finalized", 2.8)],
    "dept-3": [row("finalized", 4.0), row("finalized", 3.5)],
  },
};

// ─────────────────────────────────────────────────────────────────── the stored halves ───────────────
interface Hod { text: string; by: string; byName: string | null; at: string }
interface Gm { text: string; condition: string; by: string; byName: string | null; at: string }
let store = new Map<string, { hod: Hod | null; gm: Gm | null }>();

const key = (cycleId: string, unitId: string) => `${cycleId}|${unitId}`;

function seed(): Map<string, { hod: Hod | null; gm: Gm | null }> {
  const m = new Map<string, { hod: Hod | null; gm: Gm | null }>();
  // The closed cycle's record: a commentary and an assessment written while it was open.
  m.set(key("demo-cycle-h1", "dept-1"), {
    hod: { text: "Sample commentary: the first half was steady. Two client launches slipped on a vendor delay; both landed in June.", by: "demo-head-webdev", byName: NAMES["demo-head-webdev"], at: "2026-06-28T09:00:00.000Z" },
    gm: { text: "Sample assessment: a fair read of the half. Delivery recovered in the last quarter.", condition: "on_track", by: GM, byName: NAMES[GM], at: "2026-07-02T09:00:00.000Z" },
  });
  return m;
}
store = seed();

/** Tests only: back to the seeded state. */
export function resetDeptAppraisalDemo(): void {
  store = seed();
}

// ─────────────────────────────────────────────────────────────────── the cycle and the engine reads ───────────────
interface Cycle { id: string; name: string; periodStart: string; periodEnd: string; status: string }

function cycleOf(tenant: string, cycleId: string): Cycle | null {
  const r = appraisalsDemo("GET", `/api/${tenant}/appraisals/cycles/${encodeURIComponent(cycleId)}`, new URLSearchParams(), undefined, GM);
  if (!r || r.status !== 200) return null;
  const c = r.json as Cycle;
  return { id: c.id, name: c.name, periodStart: c.periodStart, periodEnd: c.periodEnd, status: c.status };
}

/** Every calendar month start from the month holding `start` to the month holding `end` (the server's `cycleMonthStarts`). */
function monthStarts(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const last = end.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym > last) break;
    out.push(`${ym}-01`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

interface KpiView { unit: { id: string; name: string }; workspace: string; condition: string; kpis: Array<{ key: string; condition: string } & Record<string, unknown>> }

function kpiRead(tenant: string, unitId: string, q: Record<string, string>): KpiView | null {
  const r = deptKpisDemo("GET", `/api/${tenant}/dept-kpis`, new URLSearchParams({ unitNodeId: unitId, ...q }), undefined, GM);
  return r && r.status === 200 ? (r.json as KpiView) : null;
}

const parse = (body?: string): Record<string, unknown> => {
  try {
    const v = body ? JSON.parse(body) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function textOf(b: Record<string, unknown>): { text: string } | DemoResult {
  const t = typeof b.text === "string" ? b.text.trim() : "";
  if (t.length === 0 || t.length > MAX_APPRAISAL_TEXT) return err(400, `text must be 1 to ${MAX_APPRAISAL_TEXT} characters`, "text");
  return { text: t };
}

/** The unit exists (404 `unit_not_found`) and the cycle is the company's (404 `cycle_not_found`). */
function unitAndCycle(tenant: string, unitId: string, cycleId: string): { cycle: Cycle } | DemoResult {
  if (!kpiRead(tenant, unitId, { periodKind: "month", start: "2026-01-01" })) return err(404, "unit_not_found", "unitNodeId");
  const cycle = cycleOf(tenant, cycleId);
  if (!cycle) return err(404, "cycle_not_found", "cycleId");
  return { cycle };
}

const isResult = (x: unknown): x is DemoResult => typeof x === "object" && x !== null && "status" in x && "json" in x;

function read(tenant: string, qs: URLSearchParams, userId: string): DemoResult {
  const cycleId = qs.get("cycleId");
  const unitId = qs.get("unitNodeId");
  if (!cycleId) return err(400, "cycleId is required", "cycleId");
  if (!unitId) return err(400, "unitNodeId is required", "unitNodeId");
  // The gate first: the unit's heads and the company-wide tiers. A unit's staff read the KPI page, not the appraisal.
  const who = whoReads(userId, unitId);
  if (who !== "wide" && who !== "led") return err(403, "outside your reporting line");
  const found = unitAndCycle(tenant, unitId, cycleId);
  if (isResult(found)) return found;
  const { cycle } = found;

  const last = monthStarts(cycle.periodEnd, cycle.periodEnd)[0];
  const overall = kpiRead(tenant, unitId, { periodKind: "custom", start: last, end: cycle.periodEnd });
  if (!overall) return err(404, "unit_not_found", "unitNodeId");
  const history = monthStarts(cycle.periodStart, cycle.periodEnd).map((month) => {
    const m = kpiRead(tenant, unitId, { periodKind: "month", start: month })!;
    return { month, condition: m.condition, kpis: m.kpis.map((k) => ({ key: k.key, condition: k.condition })) };
  });
  const stored = store.get(key(cycleId, unitId));
  return ok({
    cycle,
    unit: overall.unit,
    workspace: overall.workspace,
    kpis: overall.kpis,
    condition: overall.condition,
    history,
    people: aggregate(PEOPLE[cycleId]?.[unitId] ?? []),
    hodCommentary: stored?.hod ?? null,
    gmAssessment: stored?.gm ?? null,
  });
}

function write(tenant: string, half: "commentary" | "assessment", cycleId: string, unitId: string, body: string | undefined, userId: string): DemoResult {
  // Authorize first: nothing is validated or looked up for someone the server would refuse.
  const allowed = half === "assessment" ? ASSESSORS.has(userId) : userId === GM || whoReads(userId, unitId) === "led";
  if (!allowed) return err(403, "not authorized");
  const b = parse(body);
  const t = textOf(b);
  if (isResult(t)) return t;
  let condition = "";
  if (half === "assessment") {
    if (!isGmCondition(b.condition)) return err(400, "condition must be one of on_track, at_risk, off_track", "condition");
    condition = b.condition;
  }
  const found = unitAndCycle(tenant, unitId, cycleId);
  if (isResult(found)) return found;
  if (found.cycle.status === "closed") return err(409, "cycle_closed");

  const k = key(cycleId, unitId);
  const cur = store.get(k) ?? { hod: null, gm: null };
  const at = new Date().toISOString();
  if (half === "commentary") {
    cur.hod = { text: t.text, by: userId, byName: NAMES[userId] ?? null, at };
    store.set(k, cur);
    return ok({ hodCommentary: cur.hod });
  }
  cur.gm = { text: t.text, condition, by: userId, byName: NAMES[userId] ?? null, at };
  store.set(k, cur);
  return ok({ gmAssessment: cur.gm });
}

/** Returns null when the path is not a department-appraisal route, so the caller falls through. */
export function deptAppraisalsDemo(
  method: string, p: string, qs: URLSearchParams, body?: string, userId = "demo-hansel",
): DemoResult | null {
  const m = p.match(/^\/api\/([^/]+)\/dept-appraisals(?:\/(.*))?$/);
  if (!m) return null;
  const tenant = m[1];
  const rest = m[2] ?? "";
  const verb = method.toUpperCase();

  if (verb === "GET" && rest === "") return read(tenant, qs, userId);
  const w = rest.match(/^([^/]+)\/([^/]+)\/(commentary|assessment)$/);
  if (verb === "PUT" && w) return write(tenant, w[3] as "commentary" | "assessment", decodeURIComponent(w[1]), decodeURIComponent(w[2]), body, userId);
  return err(404, "not_found");
}
