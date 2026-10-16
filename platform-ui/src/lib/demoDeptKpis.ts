import "server-only";
// DW-4e-2 — DEMO_MODE fixtures for the department KPI API (BFF §40, `GET /api/:t/dept-kpis`, `/dept-kpis/overview`,
// `/dept-kpis/targets` and the three target POSTs). Routed from demoFixtures.getDemoResponse; same convention as
// demoLms.ts: own file, `(method, p, qs, body, userId) => DemoResult | null`, no import of demoFixtures.
//
// STATEFUL for targets, because the whole flow (a head proposes, the approver approves, a proposer cannot approve their
// own) cannot be exercised by a fixture that forgets what it was told. Module-level state persists across requests in one
// dev-server process and resets on restart; `resetDeptKpiDemo()` is for tests.
//
// WHO (the same wiring as demoLms / demoReports): `demo-hansel` is the approver and company-wide (company_admin tier);
// `demo-owner` reads, overviews, approves and rejects but cannot propose (§40.3a: no propose mirror for owner);
// `dept-manager` is the SEO head and leads `dept-3`; `u-webhead` is the Web Dev head and leads `dept-1` (DW-3k); `u-dev` is staff placed in `dept-1` and `seo-staff` in `dept-3`
// (they read their own department, never propose). The open Web Dev proposal below was made by `demo-head-webdev`, a
// head who is not a login, so `demo-hansel` can approve it. Anyone else is 403, and for a non-company-wide caller the 403
// comes BEFORE any word on whether the unit exists, exactly as the server orders it.
//
// THE FIVE DEPARTMENTS are `defaultStructure`'s agency tree: dept-1 Web Dev, dept-2 Creatives, dept-3 SEO, dept-4 Social
// Media, dept-5 GM. Their conditions are mixed on purpose (Creatives off track, Web Dev at risk, GM and SEO on track,
// Social Media unavailable) so the overview's worst-first order and every tile state render. The per-unit read and the
// overview rows are computed from ONE fixture, so they cannot disagree. Values are a fixed sample for any period; a
// target is in force for a period when its month start is on or before the period's start (§40.2).
//
// DW-10b-2 (BFF §58): `GET dept-kpis/months`, `POST dept-kpis/targets/batch` and `POST dept-kpis/targets/decide-batch`, in the section "THE MONTHLY SERIES"
// below. The series is built from the SAME fixture, so the current month's cells equal the page's tiles; earlier months vary around the sample reading
// (deterministically) so a trend has a shape, and two seeded approved targets (July and September 2026) give Web Dev's Projects on time two different
// targets over the window.
//
// ⚠ A DEMO LIBERTY, stated: the server only has readers for four report_fact KPIs (§40.1), so in a real Web Dev read
// `requests-within-sla` is `no_reader`. Here it carries a value and no target so the `no_target` state is reachable on the
// department the demo opens on. The page itself is honest either way.
import { compareByConditionThenName, isMonthStart, nextMonthStart, type DeptKpi, type KpiCondition, type KpiDirection, type KpiReason, type KpiUnit, type DeptKpiTargetRow } from "./deptKpiFormat";
import { ALERT_NOTE_MAX, type KpiAlert } from "./deptKpiAlertFormat";
import type { KpiDriver } from "./deptKpiDriverFormat";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });

const COMPANY_WIDE = new Set(["demo-hansel", "demo-owner"]);
/** Who may propose company-wide: the company_admin tier. `demo-owner` is deliberately absent (§40.3a). */
const PROPOSERS_WIDE = new Set(["demo-hansel"]);
const APPROVERS = new Set(["demo-hansel", "demo-owner"]);
// DW-3k: `u-webhead` (webhead@gaiada.com, DW-3h's demo head of Web Dev) leads `dept-1`, so the Overview's condition banner is drivable.
const LED: Record<string, string[]> = { "dept-manager": ["dept-3"], "u-webhead": ["dept-1"] };
const STAFF_OF: Record<string, string[]> = { "u-dev": ["dept-1"], "seo-staff": ["dept-3"] };

interface KpiDef { key: string; label: string; unit: KpiUnit; direction: KpiDirection; suggestedTarget: number | null; suggestedTolerance: number | null }
const DAY = 1440;
const pct = (key: string, label: string, direction: KpiDirection, t: number, tol: number): KpiDef => ({ key, label, unit: "percent", direction, suggestedTarget: t, suggestedTolerance: tol });

interface DemoUnit { id: string; name: string; workspace: string; kpis: KpiDef[] }
const UNITS: DemoUnit[] = [
  { id: "dept-1", name: "Web Dev", workspace: "web-dev", kpis: [
    pct("projects-on-time", "Projects on time", "up_good", 0.85, 0.05),
    pct("requests-within-sla", "Requests delivered by the date needed", "up_good", 0.9, 0.05),
    pct("client-site-uptime", "Client site uptime", "up_good", 0.995, 0.005),
    pct("reopened-work-rate", "Reopened work rate", "down_good", 0.05, 0.03),
  ] },
  { id: "dept-2", name: "Creatives", workspace: "creatives", kpis: [
    pct("asset-requests-on-time", "Asset requests delivered on time", "up_good", 0.9, 0.05),
    { key: "revision-rounds", label: "Revision rounds per asset", unit: "count", direction: "down_good", suggestedTarget: 2, suggestedTolerance: 1 },
    { key: "assets-delivered", label: "Assets delivered", unit: "count", direction: "up_good", suggestedTarget: null, suggestedTolerance: null },
  ] },
  { id: "dept-3", name: "SEO", workspace: "seo", kpis: [
    pct("clients-ranking-growth", "Clients with ranking growth", "up_good", 0.7, 0.1),
    pct("client-reports-on-time", "Client reports delivered on time", "up_good", 0.95, 0.05),
    pct("ad-budgets-on-pace", "Ad budgets on pace", "up_good", 0.9, 0.05),
    pct("client-retention", "Client retention", "up_good", 0.9, 0.05),
  ] },
  { id: "dept-4", name: "Social Media", workspace: "social-media", kpis: [
    pct("posts-on-schedule", "Posts published on schedule", "up_good", 0.95, 0.05),
    { key: "client-approval-turnaround", label: "Client approval turnaround", unit: "minutes", direction: "down_good", suggestedTarget: 2 * DAY, suggestedTolerance: DAY },
    pct("engagement-growth", "Engagement growth across clients", "up_good", 0.05, 0.05),
  ] },
  { id: "dept-5", name: "GM", workspace: "gm", kpis: [
    pct("revenue-vs-plan", "Revenue against plan", "up_good", 1, 0.05),
    pct("margin", "Margin", "up_good", 0.3, 0.05),
    pct("utilization", "Utilization", "up_good", 0.8, 0.1),
    pct("departments-in-good-condition", "Departments in good condition", "up_good", 0.8, 0.2),
  ] },
];

/** The sample reading per KPI: a value (with parts for a ratio) or the reason there is none. */
interface Reading { value: number | null; numerator?: number; denominator?: number; reason?: KpiReason }
const NO_READER: Reading = { value: null, reason: "no_reader" };
const READINGS: Record<string, Record<string, Reading>> = {
  "dept-1": {
    "projects-on-time": { value: 17 / 21, numerator: 17, denominator: 21 },
    "requests-within-sla": { value: 0.93, numerator: 28, denominator: 30 },
    "reopened-work-rate": { value: 0.04, numerator: 2, denominator: 50 },
  },
  "dept-2": { "asset-requests-on-time": { value: 0.72, numerator: 18, denominator: 25 } },
  "dept-3": { "client-reports-on-time": { value: 0.96, numerator: 24, denominator: 25 } },
  "dept-4": {},
  "dept-5": { utilization: { value: 0.82 } },
};

let seq = 1;
let rows: DeptKpiTargetRow[] = [];

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;

function seedRows(): DeptKpiTargetRow[] {
  const approved = (unit: string, kpi: string, target: number, tolerance: number, effectiveFrom = "2026-07-01"): DeptKpiTargetRow => ({
    id: `demo-dkt-${seq++}`, unitNodeId: unit, kpiKey: kpi, effectiveFrom, target, tolerance, status: "approved",
    note: null, proposedBy: "demo-head", proposedAt: "2026-06-20T09:00:00.000Z", decidedBy: "demo-hansel", decidedAt: "2026-06-25T09:00:00.000Z",
  });
  const seeded = [
    // Web Dev's Projects on time: 82% from July, raised to 85% from September (DW-10b: a series over months with different targets).
    approved("dept-1", "projects-on-time", 0.82, 0.05),
    approved("dept-1", "projects-on-time", 0.85, 0.05, "2026-09-01"),
    approved("dept-1", "reopened-work-rate", 0.05, 0.03),
    approved("dept-2", "asset-requests-on-time", 0.9, 0.05),
    approved("dept-3", "client-reports-on-time", 0.95, 0.05),
    approved("dept-5", "utilization", 0.8, 0.1),
  ];
  // The open proposal: Web Dev's head asks for a target on the KPI that has none, from next month.
  seeded.push({
    id: `demo-dkt-${seq++}`, unitNodeId: "dept-1", kpiKey: "requests-within-sla", effectiveFrom: nextMonthStart(today()), target: 0.9, tolerance: 0.05,
    status: "proposed", note: "Support desk SLA, from the new rota.", proposedBy: "demo-head-webdev", proposedAt: `${today()}T08:30:00.000Z`,
    decidedBy: null, decidedAt: null,
  });
  return seeded;
}
rows = seedRows();

// ── THE ALERTS (DW-4j-2, BFF §43.5 and §43.6a) ──────────────────────────────────────────────────────────────────────────────────
// `GET dept-kpis/alerts` (the caller's open, unacknowledged alerts of the units they lead EXACTLY: nobody else's), `GET dept-kpis/alerts?unitNodeId=`
// (one unit's whole history under the unit read's gate, newest first, at most 100) and `POST dept-kpis/alerts/:id/acknowledge {note?}`.
//
// What the fixture holds, and why. An OPEN alert is only ever on a KPI that is off track in the fixture above: Creatives' "Asset requests delivered on
// time" (72% against 90%), so the alert the demo shows is the state the fixture really is in. Nobody in the demo heads Creatives (`LED` has no one
// for dept-2, and adding a lead would change who may propose there), so no demo user's Needs you shows it: it is read on the Creatives KPI page by the
// company-wide users (`demo-hansel`, `demo-owner`), who may acknowledge it (§43.5: a head of the unit or the company-wide tier). Web Dev (the head
// `u-webhead`'s unit) has HISTORY only, because it has no off-track KPI: one alert resolved as back on track after its head acknowledged it with a
// note, and one resolved as `unavailable` (the KPI has no reader) that nobody acknowledged. `u-webhead` therefore reads history on the page and has an
// honestly empty Needs you. Acknowledging stays in memory, like the targets, and resets with `resetDeptKpiDemo()`.
interface DemoAlert {
  id: string; unitId: string; kpiKey: string; periodStart: string; openedAt: string; value: number | null; target: number | null;
  acknowledgedBy: string | null; acknowledgedAt: string | null; ackNote: string | null; resolvedAt: string | null; resolvedCondition: KpiCondition | null;
}
/** Display names of the people who can acknowledge in the demo (`users.name`). */
const ALERT_NAMES: Record<string, string> = { "demo-hansel": "Hansel", "demo-owner": "Owner", "dept-manager": "SEO head", "u-webhead": "Ketut Arta" };

function seedAlerts(): DemoAlert[] {
  const none = { acknowledgedBy: null, acknowledgedAt: null, ackNote: null, resolvedAt: null, resolvedCondition: null };
  return [
    { id: "demo-dka-1", unitId: "dept-2", kpiKey: "asset-requests-on-time", periodStart: "2026-10-01", openedAt: "2026-10-03T06:30:00.000Z", value: 0.72, target: 0.9, ...none },
    {
      id: "demo-dka-2", unitId: "dept-1", kpiKey: "projects-on-time", periodStart: "2026-08-01", openedAt: "2026-08-12T06:30:00.000Z", value: 0.78, target: 0.85,
      acknowledgedBy: "u-webhead", acknowledgedAt: "2026-08-13T09:10:00.000Z", ackNote: "Two launches slipped on client content. Rebooked.",
      resolvedAt: "2026-09-02T06:30:00.000Z", resolvedCondition: "on_track",
    },
    {
      id: "demo-dka-3", unitId: "dept-1", kpiKey: "client-site-uptime", periodStart: "2026-09-01", openedAt: "2026-09-15T06:30:00.000Z", value: 0.97, target: 0.995,
      acknowledgedBy: null, acknowledgedAt: null, ackNote: null, resolvedAt: "2026-10-01T06:30:00.000Z", resolvedCondition: "unavailable",
    },
  ];
}
let alertRows: DemoAlert[] = seedAlerts();

/** Tests only: back to the seeded state. */
export function resetDeptKpiDemo(): void {
  seq = 1;
  rows = seedRows();
  alertRows = seedAlerts();
}

function inForce(unit: string, kpi: string, asOfStart: string): DeptKpiTargetRow | null {
  const cands = rows.filter((r) => r.unitNodeId === unit && r.kpiKey === kpi && r.status === "approved" && r.effectiveFrom <= asOfStart);
  cands.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0));
  return cands[0] ?? null;
}

const EPS = 1e-9;
function kpiCondition(def: KpiDef, value: number, target: number, tolerance: number): KpiCondition {
  const gap = def.direction === "up_good" ? target - value : value - target; // > 0 means worse than the target
  if (gap <= EPS) return "on_track";
  return gap <= tolerance + EPS ? "at_risk" : "off_track";
}

function deptCondition(kpis: DeptKpi[]): KpiCondition {
  const n = (c: KpiCondition) => kpis.filter((k) => k.condition === c).length;
  if (n("off_track") > 0 || n("at_risk") >= 2) return "off_track";
  if (n("at_risk") === 1) return "at_risk";
  if (n("on_track") > 0) return "on_track";
  return "unavailable";
}

function readKpis(unit: DemoUnit, periodStart: string, others?: Map<string, KpiCondition>): DeptKpi[] {
  return unit.kpis.map((d): DeptKpi => {
    let reading: Reading = READINGS[unit.id]?.[d.key] ?? NO_READER;
    if (d.key === "departments-in-good-condition") {
      // Derived (§40.3a): the share of the OTHER departments that are on track.
      const list = [...(others ?? new Map<string, KpiCondition>()).entries()].filter(([id]) => id !== unit.id);
      reading = list.length === 0 ? NO_READER
        : { value: list.filter(([, c]) => c === "on_track").length / list.length, numerator: list.filter(([, c]) => c === "on_track").length, denominator: list.length };
    }
    const f = inForce(unit.id, d.key, periodStart);
    const base = { key: d.key, label: d.label, unit: d.unit, direction: d.direction };
    const parts = { ...(reading.numerator !== undefined ? { numerator: reading.numerator } : {}), ...(reading.denominator !== undefined ? { denominator: reading.denominator } : {}) };
    if (reading.value === null) {
      return { ...base, value: null, target: f ? f.target : null, tolerance: f ? f.tolerance : null, targetSource: f ? "approved" : "none", condition: "unavailable", reason: reading.reason ?? "no_data" };
    }
    if (!f) return { ...base, value: reading.value, ...parts, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_target" };
    return { ...base, value: reading.value, ...parts, target: f.target, tolerance: f.tolerance, targetSource: "approved", condition: kpiCondition(d, reading.value, f.target, f.tolerance) };
  });
}

function periodOf(qs: URLSearchParams) {
  const periodKind = qs.get("periodKind") || "month";
  const given = qs.get("start") || today();
  if (periodKind === "month") {
    const start = monthStart(given);
    const next = nextMonthStart(start);
    const last = new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    return { periodKind, start, end: last };
  }
  return { periodKind, start: given, end: qs.get("end") || given };
}

/** One department's view, with the cross-department condition map the derived KPI needs. */
function unitView(unit: DemoUnit, period: { periodKind: string; start: string; end: string }) {
  // Conditions of every department WITHOUT any derived KPI, so two GM-workspace units can never depend on each other.
  const conds = new Map<string, KpiCondition>();
  for (const u of UNITS) conds.set(u.id, deptCondition(readKpis({ ...u, kpis: u.kpis.filter((k) => k.key !== "departments-in-good-condition") }, period.start)));
  const kpis = readKpis(unit, period.start, conds);
  return { unit: { id: unit.id, name: unit.name }, workspace: unit.workspace, period, condition: deptCondition(kpis), kpis };
}

/** Exported for demoDeptAppraisals.ts (DW-4e-3): the same placement gate, so the two fixtures cannot disagree about who leads a unit. */
export type Who = "wide" | "led" | "staff" | "none";
export function whoReads(userId: string, unitId: string): Who {
  if (COMPANY_WIDE.has(userId)) return "wide";
  if ((LED[userId] ?? []).includes(unitId)) return "led";
  if ((STAFF_OF[userId] ?? []).includes(unitId)) return "staff";
  return "none";
}

const monthAsOf = () => monthStart(today());

function targetsView(unit: DemoUnit) {
  const asOf = monthAsOf();
  return {
    unit: { id: unit.id, name: unit.name },
    workspace: unit.workspace,
    asOf,
    kpis: unit.kpis.map((d) => {
      const mine = rows.filter((r) => r.unitNodeId === unit.id && r.kpiKey === d.key);
      const history = mine.filter((r) => r.status !== "proposed").sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
      return {
        key: d.key, label: d.label, unit: d.unit, direction: d.direction,
        suggestedTarget: d.suggestedTarget, suggestedTolerance: d.suggestedTolerance,
        inForce: inForce(unit.id, d.key, asOf),
        proposals: mine.filter((r) => r.status === "proposed"),
        history,
      };
    }),
  };
}

function parse(body?: string): Record<string, unknown> {
  try {
    const v = body ? JSON.parse(body) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function decide(id: string, verb: "approve" | "reject", userId: string, body?: string): DemoResult {
  const row = rows.find((r) => r.id === id);
  if (!row) return err(404, "target_not_found");
  // The read gate first (the tenant-wide read), then the order the server uses: the row, own proposal, the approver, state.
  if (whoReads(userId, row.unitNodeId) === "none") return err(403, "not authorized");
  if (row.proposedBy === userId) return err(409, "cannot_approve_own_proposal");
  if (!APPROVERS.has(userId)) return err(403, "not authorized");
  if (row.status !== "proposed") return err(409, "not_proposed");
  const now = new Date().toISOString();
  void parse(body); // the decision note is the activity row's, not the table's (§40.3a)
  const superseded: string[] = [];
  if (verb === "approve") {
    for (const r of rows) {
      if (r !== row && r.unitNodeId === row.unitNodeId && r.kpiKey === row.kpiKey && r.status === "approved" && r.effectiveFrom >= row.effectiveFrom) {
        r.status = "superseded";
        superseded.push(r.id);
      }
    }
    row.status = "approved";
  } else {
    row.status = "rejected";
  }
  row.decidedBy = userId;
  row.decidedAt = now;
  return ok({ ...row, superseded });
}

function propose(userId: string, body?: string): DemoResult {
  const b = parse(body);
  const unitId = typeof b.unitNodeId === "string" ? b.unitNodeId : "";
  // Authorize first: the company_admin tier, or the head of the unit. Everything else is 403 before any validation.
  if (!PROPOSERS_WIDE.has(userId) && !(LED[userId] ?? []).includes(unitId)) return err(403, "not authorized");
  const effectiveFrom = typeof b.effectiveFrom === "string" ? b.effectiveFrom : "";
  if (!isMonthStart(effectiveFrom)) return err(400, "effectiveFrom must be the first day of a month", "effectiveFrom");
  const target = b.target;
  const tolerance = b.tolerance;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) return err(400, "tolerance must be 0 or more", "tolerance");
  const unit = UNITS.find((u) => u.id === unitId);
  if (!unit) return err(404, "unit_not_found", "unitNodeId");
  const def = unit.kpis.find((k) => k.key === b.kpiKey);
  if (!def) return err(400, "kpiKey is not one of this department's KPIs", "kpiKey");
  if (typeof target !== "number" || !Number.isFinite(target)) return err(400, "target must be a number", "target");
  if (def.unit === "percent" && (target < 0 || target > 1)) return err(400, "a percent target is a fraction between 0 and 1", "target");
  const row: DeptKpiTargetRow = {
    id: `demo-dkt-${seq++}`, unitNodeId: unit.id, kpiKey: def.key, effectiveFrom, target, tolerance, status: "proposed",
    note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null, proposedBy: userId, proposedAt: new Date().toISOString(),
    decidedBy: null, decidedAt: null,
  };
  rows.push(row);
  return { status: 201, json: { id: row.id, status: "proposed" } };
}

const newestOpened = (a: DemoAlert, b: DemoAlert) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0);

function alertView(a: DemoAlert): KpiAlert {
  const unit = UNITS.find((u) => u.id === a.unitId);
  const def = unit?.kpis.find((k) => k.key === a.kpiKey);
  return {
    id: a.id, unit: { id: a.unitId, name: unit?.name ?? a.unitId }, kpiKey: a.kpiKey, kpiLabel: def?.label ?? a.kpiKey, kpiUnit: def?.unit ?? null,
    periodStart: a.periodStart, openedAt: a.openedAt, value: a.value, target: a.target,
    acknowledgedBy: a.acknowledgedBy, acknowledgedByName: a.acknowledgedBy ? ALERT_NAMES[a.acknowledgedBy] ?? null : null, acknowledgedAt: a.acknowledgedAt,
    ackNote: a.ackNote, resolvedAt: a.resolvedAt, resolvedCondition: a.resolvedCondition,
  };
}

/** The server's check order for an acknowledge (§43.6a): the alert (404), the narrowing (403), the state (409 `resolved`, then `already_acknowledged`), then the note (400). */
function acknowledge(id: string, userId: string, body?: string): DemoResult {
  const a = alertRows.find((r) => r.id === id);
  if (!a) return err(404, "alert_not_found", "id");
  // A head of THAT unit or the company-wide tier; a unit's staff or another unit's head is out of line.
  if (!COMPANY_WIDE.has(userId) && !(LED[userId] ?? []).includes(a.unitId)) return err(403, "outside your reporting line");
  if (a.resolvedAt) return err(409, "resolved");
  if (a.acknowledgedAt) return err(409, "already_acknowledged");
  const noteRaw = parse(body).note;
  if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== "string" || noteRaw.length > ALERT_NOTE_MAX)) {
    return err(400, `note must be a string of at most ${ALERT_NOTE_MAX} characters`, "note");
  }
  a.acknowledgedBy = userId;
  a.acknowledgedAt = new Date().toISOString();
  a.ackNote = typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : null;
  return ok(alertView(a));
}

// ── "BEHIND THE MISS" (DW-4j-3, BFF §43.8 and §43.8a) ─────────────────────────────────────────────────────────────────────────────
// `GET dept-kpis/drivers?unitNodeId=&kpiKey=&periodKind=&start=[&end=]`: the projects or people behind one KPI's miss, worst first, at most 5.
// The gate is the head-only unit read's (`authorizeUnitHeadRead`): the company-wide demo users and the unit's demo head; a unit's staff, another
// unit's head and everyone else are 403 (departments are never ranked to their own staff, plan §5.5). The demo never shows what the real server cannot
// answer, so the fixture holds drivers ONLY for the report-fact KPIs that have them: Web Dev's at-risk "Projects on time" (17 of 21 milestones: the two
// projects below missed 2 each, so they add up to the department's four misses) and Web Dev's on-track "Reopened work rate" (one person with a reopen).
// Every other KPI answers as the server does. Creatives' off-track "Asset requests delivered on time" is a module KPI: it has a value in this fixture
// (a demo liberty, see the top of the file) and no breakdown, so it answers `no_drivers` (the server's answer once a module KPI has a reader seam; today
// `no_reader`). A KPI with no reading at all answers `no_reader`; the derived KPI and utilization answer `no_drivers`. Nothing here changes a condition,
// value, lead or target above.
const DRIVERS: Record<string, Record<string, KpiDriver[]>> = {
  "dept-1": {
    "projects-on-time": [
      { kind: "project", id: "p-web-1", name: "Client site redesign", value: 3 / 5, numerator: 3, denominator: 5 },
      { kind: "project", id: "p-web-2", name: "Mobile app revamp", value: 4 / 6, numerator: 4, denominator: 6 },
    ],
    "reopened-work-rate": [{ kind: "person", id: "u-dev", name: "Made Putra", value: 2 / 18, numerator: 2, denominator: 18 }],
  },
};

const PERIOD_KINDS = new Set(["day", "week", "month", "quarter", "semester", "year", "custom"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The server's check order (§43.8a): the parameters, the period, the head-only gate (403 before any word on whether the unit exists), the KPI being in the unit's set. */
function drivers(userId: string, qs: URLSearchParams): DemoResult {
  const unitId = qs.get("unitNodeId");
  if (!unitId || unitId.trim() === "") return err(400, "unitNodeId is required", "unitNodeId");
  const kpiKey = qs.get("kpiKey");
  if (!kpiKey || kpiKey.trim() === "") return err(400, "kpiKey is required", "kpiKey");
  const kind = qs.get("periodKind");
  if (!kind || !PERIOD_KINDS.has(kind)) return err(400, "periodKind must be one of day, week, month, quarter, semester, year, custom", "periodKind");
  const start = qs.get("start");
  if (!start || !DATE_RE.test(start)) return err(400, "start must be a YYYY-MM-DD date", "start");
  if (kind === "custom" && !DATE_RE.test(qs.get("end") ?? "")) return err(400, "end is required when periodKind=custom", "end");
  const who = whoReads(userId, unitId);
  if (who !== "wide" && who !== "led") return err(403, "outside your reporting line");
  const unit = UNITS.find((u) => u.id === unitId);
  if (!unit) return err(404, "unit_not_found", "unitNodeId");
  const def = unit.kpis.find((k) => k.key === kpiKey);
  if (!def) return err(400, `kpiKey is not a KPI of this unit's workspace (${unit.workspace})`, "kpiKey");
  const kpi = { key: def.key, label: def.label, unit: def.unit, direction: def.direction };
  const period = periodOf(qs);
  const rows = DRIVERS[unit.id]?.[def.key];
  if (rows) return ok({ kpi, period, drivers: rows });
  const hasReader = def.key === "departments-in-good-condition" || READINGS[unit.id]?.[def.key] !== undefined;
  return ok({ kpi, period, drivers: null, reason: hasReader ? "no_drivers" : "no_reader" });
}

// ── THE MONTHLY SERIES AND THE BATCH WRITES (DW-10b-2, BFF §58) ─────────────────────────────────────────────────────────────────────
// `GET dept-kpis/months?unitNodeId=&from=YYYY-MM&to=YYYY-MM`: the unit read's gate (403 before any word on whether the unit exists, then 404), then the window
// (the 12 months ending with the current month by default; a bad month, `from` after `to`, more than 12 months or a `to` after the current month is 400 with the
// field). One cell per KPI per month, each a month's own `KpiRead`: the target in force THAT month, `unavailable` with its reason when there is no reading (never 0).
// Two kinds of month are unreadable on purpose so the table shows the state: every month before the fixture's fact history (January 2026), and May 2026 (a sync gap).
// `POST dept-kpis/targets/batch` and `POST dept-kpis/targets/decide-batch` keep the server's order of checks and are ALL OR NOTHING.
const HISTORY_FROM = "2026-01";
const GAP_MONTH = "2026-05";
const WINDOW_MAX = 12;
const BATCH_MAX = 36;
const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Month-to-month wobble around the sample reading, as a fraction of the value: a fixed cycle, so a trend has a shape and a test can pin it. */
const WOBBLE = [0, -0.1, 0.07, -0.04, 0.11, -0.08, 0.03];

const monthKeyOf = (iso: string) => iso.slice(0, 7);
function shiftMonth(key: string, by: number): string {
  const idx = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + by;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
const monthSpan = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
const lastDayOf = (key: string) => new Date(Date.parse(`${nextMonthStart(`${key}-01`)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

function windowOf(qs: URLSearchParams): { from: string; to: string } | DemoResult {
  const current = monthKeyOf(today());
  const from = qs.get("from");
  const to = qs.get("to");
  if (from !== null && from !== "" && !MONTH_KEY_RE.test(from)) return err(400, "from must be a month, YYYY-MM", "from");
  if (to !== null && to !== "" && !MONTH_KEY_RE.test(to)) return err(400, "to must be a month, YYYY-MM", "to");
  // Without BOTH bounds the window is the default one (§58.1, §58.6); the value that was sent is still checked.
  if (!from || !to) return { from: shiftMonth(current, -(WINDOW_MAX - 1)), to: current };
  if (from > to) return err(400, "from must not be after to", "from");
  if (monthSpan(from, to) > WINDOW_MAX) return err(400, `a window is at most ${WINDOW_MAX} months`, "from");
  if (to > current) return err(400, "to must not be after the current month", "to");
  return { from, to };
}

/** One month's reading of one KPI: the sample reading varied by month (the current month is the sample itself, month to date), or why there is none. */
function monthReading(unit: DemoUnit, def: KpiDef, month: string, current: string): Reading {
  const base: Reading = def.key === "departments-in-good-condition" ? NO_READER : READINGS[unit.id]?.[def.key] ?? NO_READER;
  if (base.value === null) return base;
  if (month < HISTORY_FROM || month === GAP_MONTH) return { value: null, reason: "no_data" };
  if (month === current) return base;
  const wobble = WOBBLE[(Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) + def.key.length) % WOBBLE.length];
  if (base.denominator !== undefined) {
    const n = Math.min(base.denominator, Math.max(0, Math.round((base.value + wobble) * base.denominator)));
    return { value: n / base.denominator, numerator: n, denominator: base.denominator };
  }
  return { value: Math.min(1, Math.max(0, base.value + wobble)) };
}

function months(userId: string, qs: URLSearchParams): DemoResult {
  const unitId = qs.get("unitNodeId");
  if (!unitId) return err(400, "unitNodeId is required", "unitNodeId");
  if (whoReads(userId, unitId) === "none") return err(403, "outside your reporting line");
  const unit = UNITS.find((u) => u.id === unitId);
  if (!unit) return err(404, "unit_not_found", "unitNodeId");
  const w = windowOf(qs);
  if ("status" in w) return w;
  const current = monthKeyOf(today());
  const keys = Array.from({ length: monthSpan(w.from, w.to) }, (_, i) => shiftMonth(w.from, i));
  const kpis = unit.kpis.map((d) => ({
    key: d.key, label: d.label, unit: d.unit, direction: d.direction,
    cells: keys.map((month) => {
      const reading = monthReading(unit, d, month, current);
      const f = inForce(unit.id, d.key, `${month}-01`);
      const target = f ? { target: f.target, tolerance: f.tolerance, targetSource: "approved" as const } : { target: null, tolerance: null, targetSource: "none" as const };
      const parts = { ...(reading.numerator !== undefined ? { numerator: reading.numerator } : {}), ...(reading.denominator !== undefined ? { denominator: reading.denominator } : {}) };
      if (reading.value === null) return { month, value: null, ...target, condition: "unavailable" as KpiCondition, reason: reading.reason ?? "no_data" };
      if (!f) return { month, value: reading.value, ...parts, ...target, condition: "unavailable" as KpiCondition, reason: "no_target" };
      return { month, value: reading.value, ...parts, ...target, condition: kpiCondition(d, reading.value, f.target, f.tolerance) };
    }),
  }));
  return ok({
    unit: { id: unit.id, name: unit.name },
    workspace: unit.workspace,
    months: keys.map((month, i) => ({
      month, start: `${month}-01`, end: lastDayOf(month), partial: month === current,
      condition: deptCondition(kpis.map((k) => k.cells[i]) as unknown as DeptKpi[]),
    })),
    kpis,
  });
}

const errAt = (status: number, error: string, field: string): DemoResult => ({ status, json: { error, field } });
const errFailed = (status: number, error: string, failedId: string): DemoResult => ({ status, json: { error, failedId } });

/** The server's order (§58.2): authorize before any body validation, then each item in order (shape, duplicate, workspace), the unit's existence last of all. */
function proposeBatch(userId: string, body?: string): DemoResult {
  const b = parse(body);
  const unitId = typeof b.unitNodeId === "string" ? b.unitNodeId : "";
  if (!PROPOSERS_WIDE.has(userId) && !(LED[userId] ?? []).includes(unitId)) return err(403, "not authorized");
  if (unitId === "") return errAt(400, "unitNodeId is required", "unitNodeId");
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > BATCH_MAX) return errAt(400, `items must be a list of 1 to ${BATCH_MAX}`, "items");
  const unit = UNITS.find((u) => u.id === unitId);
  const seen = new Set<string>();
  const made: DeptKpiTargetRow[] = [];
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object" || Array.isArray(it)) return errAt(400, "each item must be an object", `items[${i}]`);
    const effectiveFrom = typeof it.effectiveFrom === "string" ? it.effectiveFrom : "";
    if (!isMonthStart(effectiveFrom)) return errAt(400, "effectiveFrom must be the first day of a month", `items[${i}].effectiveFrom`);
    const { target, tolerance } = it;
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) return errAt(400, "tolerance must be 0 or more", `items[${i}].tolerance`);
    if (typeof target !== "number" || !Number.isFinite(target)) return errAt(400, "target must be a number", `items[${i}].target`);
    const dup = `${String(it.kpiKey)}|${effectiveFrom}`;
    if (seen.has(dup)) return errAt(400, "one item per KPI and month", `items[${i}].effectiveFrom`);
    seen.add(dup);
    if (!unit) continue; // the unit's existence is answered after the items' shape, as the single route orders it
    const def = unit.kpis.find((k) => k.key === it.kpiKey);
    if (!def) return errAt(400, "kpiKey is not one of this department's KPIs", `items[${i}].kpiKey`);
    if (def.unit === "percent" && (target < 0 || target > 1)) return errAt(400, "a percent target is a fraction between 0 and 1", `items[${i}].target`);
    made.push({
      id: `demo-dkt-${seq + made.length}`, unitNodeId: unit.id, kpiKey: def.key, effectiveFrom, target, tolerance, status: "proposed",
      note: typeof it.note === "string" && it.note.trim() ? it.note.trim() : null, proposedBy: userId, proposedAt: new Date().toISOString(),
      decidedBy: null, decidedAt: null,
    });
  }
  if (!unit) return errAt(404, "unit_not_found", "unitNodeId");
  seq += made.length;
  rows.push(...made); // all or nothing: nothing above wrote
  return { status: 201, json: { ids: made.map((r) => r.id) } };
}

/** The server's order (§58.3): the body, then per id in the order given (exists 404, proposed 409, own approval 409, the approver tier 403), then ONE all-or-nothing pass. */
function decideBatch(userId: string, body?: string): DemoResult {
  const b = parse(body);
  if (b.decision !== "approve" && b.decision !== "reject") return errAt(400, "decision must be approve or reject", "decision");
  const ids = b.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > BATCH_MAX || ids.some((x) => typeof x !== "string" || x === "") || new Set(ids).size !== ids.length) {
    return errAt(400, `ids must be 1 to ${BATCH_MAX} distinct ids`, "ids");
  }
  const picked: DeptKpiTargetRow[] = [];
  for (const id of ids as string[]) {
    const row = rows.find((r) => r.id === id);
    if (!row) return errFailed(404, "target_not_found", id);
    if (row.status !== "proposed") return errFailed(409, "not_proposed", id);
    if (b.decision === "approve" && row.proposedBy === userId) return errFailed(409, "cannot_approve_own_proposal", id);
    if (!APPROVERS.has(userId)) return errFailed(403, "not authorized", id);
    picked.push(row);
  }
  // Apply in (unit, KPI, month, id) order: an approval supersedes the approved rows from its month ON, so a later month must not go before an earlier one.
  const order = [...picked].sort((x, y) =>
    x.unitNodeId.localeCompare(y.unitNodeId) || x.kpiKey.localeCompare(y.kpiKey) || x.effectiveFrom.localeCompare(y.effectiveFrom) || x.id.localeCompare(y.id));
  const now = new Date().toISOString();
  const result = new Map<string, { id: string; status: string; superseded: string[] }>();
  for (const row of order) {
    const superseded: string[] = [];
    if (b.decision === "approve") {
      for (const r of rows) {
        if (r !== row && r.unitNodeId === row.unitNodeId && r.kpiKey === row.kpiKey && r.status === "approved" && r.effectiveFrom >= row.effectiveFrom) {
          r.status = "superseded";
          superseded.push(r.id);
        }
      }
    }
    row.status = b.decision === "approve" ? "approved" : "rejected";
    row.decidedBy = userId;
    row.decidedAt = now;
    result.set(row.id, { id: row.id, status: row.status, superseded });
  }
  return ok({ decided: (ids as string[]).map((id) => result.get(id)!) });
}

/** Returns null when the path is not a department-KPI route, so the caller falls through. */
export function deptKpisDemo(
  method: string, p: string, qs: URLSearchParams, body?: string, userId = "demo-hansel",
): DemoResult | null {
  const m = p.match(/^\/api\/[^/]+\/dept-kpis(?:\/(.*))?$/);
  if (!m) return null;
  const rest = m[1] ?? "";
  const verb = method.toUpperCase();

  if (verb === "GET" && rest === "") {
    const unitId = qs.get("unitNodeId");
    if (!unitId) return err(400, "unitNodeId is required", "unitNodeId");
    if (whoReads(userId, unitId) === "none") return err(403, "outside your reporting line");
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return err(404, "unit_not_found", "unitNodeId");
    return ok(unitView(unit, periodOf(qs)));
  }

  if (verb === "GET" && rest === "overview") {
    if (!COMPANY_WIDE.has(userId)) return err(403, "not authorized");
    const period = periodOf(qs);
    const departments = UNITS.map((u) => unitView(u, period)).map((v) => ({ unit: v.unit, workspace: v.workspace, condition: v.condition, kpis: v.kpis }));
    departments.sort(compareByConditionThenName);
    return ok({ period, departments });
  }

  if (verb === "GET" && rest === "targets") {
    const unitId = qs.get("unitNodeId");
    if (!unitId) return err(400, "unitNodeId is required", "unitNodeId");
    if (whoReads(userId, unitId) === "none") return err(403, "outside your reporting line");
    const unit = UNITS.find((u) => u.id === unitId);
    if (!unit) return err(404, "unit_not_found", "unitNodeId");
    return ok(targetsView(unit));
  }

  if (verb === "GET" && rest === "drivers") return drivers(userId, qs);
  if (verb === "GET" && rest === "months") return months(userId, qs);
  if (verb === "POST" && rest === "targets/batch") return proposeBatch(userId, body);
  if (verb === "POST" && rest === "targets/decide-batch") return decideBatch(userId, body);

  if (verb === "GET" && rest === "alerts") {
    const unitId = qs.get("unitNodeId");
    if (unitId === null) {
      // Needs you: the open, unacknowledged alerts of the units the caller leads exactly. Anyone else (company-wide tiers included) has none, and that is true.
      const led = LED[userId] ?? [];
      return ok({ alerts: alertRows.filter((a) => !a.resolvedAt && !a.acknowledgedAt && led.includes(a.unitId)).sort(newestOpened).map(alertView) });
    }
    if (unitId.trim() === "") return err(400, "unitNodeId must not be empty", "unitNodeId");
    if (whoReads(userId, unitId) === "none") return err(403, "outside your reporting line");
    if (!UNITS.some((u) => u.id === unitId)) return err(404, "unit_not_found", "unitNodeId");
    return ok({ alerts: alertRows.filter((a) => a.unitId === unitId).sort(newestOpened).slice(0, 100).map(alertView) });
  }
  const ack = rest.match(/^alerts\/([^/]+)\/acknowledge$/);
  if (verb === "POST" && ack) return acknowledge(decodeURIComponent(ack[1]), userId, body);

  if (verb === "POST" && rest === "targets") return propose(userId, body);
  const d = rest.match(/^targets\/([^/]+)\/(approve|reject)$/);
  if (verb === "POST" && d) return decide(decodeURIComponent(d[1]), d[2] as "approve" | "reject", userId, body);

  return err(404, "not_found");
}
