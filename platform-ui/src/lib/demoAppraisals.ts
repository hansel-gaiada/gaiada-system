import "server-only";
// TR-26 — DEMO_MODE fixtures for the appraisal subsystem (appraisals.controller.ts). Routed from
// demoFixtures.getDemoResponse for every `/api/:t/appraisals*` path, mirroring demoCheckins.ts's/
// demoPm.ts's STATEFUL in-memory-store convention (module-level state persists across requests
// within one running dev-server process; resets on restart) — this ticket's whole manager
// draft->submit flow and subject ack/dispute flow need to read back what was just written, which a
// stateless fixture (demoReports.ts's own convention) can't exercise. One-way dependency: this file
// imports PURE helpers from lib/appraisals.ts (the same contract client components use) but must
// NOT import demoFixtures.ts or demoReports.ts/demoCheckins.ts.
//
// ─────────────────────────────── FAIL-CLOSED, PER THE BRIEF'S STANDING RULING ───────────────────
// Every seeded id is prefixed `demo-appr-*` / `demo-cycle-*` and every ack/dispute comment below is
// written to read unmistakably as sample copy (named demo people, explicit "this half"/"this cycle"
// phrasing) — none of it is a real employee's words, and this file has no code path that could ever
// be reached with `DEMO_MODE` unset (platformFetch's own guard). This is the ONLY place a suppressed
// small-cohort band, an evidence_stale block, and an append-only ack trail can be exercised in a
// browser without a live Postgres + Cerbos + a real appraisal cycle wound all the way through.
import {
  checkSubmitReadiness, previewComposite, MIN_COMMENTARY_LENGTH,
  type AppraisalAxis, type AppraisalAxisScore, type AppraisalCycleRow, type AppraisalPack,
  type AppraisalAckEntry, type CohortBandDatum, type GenerateRoster,
} from "./appraisals";

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: { error, field } });

let seq = 1;
const demoId = (p: string) => `demo-${p}-${seq++}`;

// ---------------------------------------------------------------------------
// Metric catalog — the same 8 PERSON_SAFE_METRICS appraisal-engine.ts derives from the registry
// (metrics.ts), duplicated here at just the fields this demo layer needs (metricKey/label/unit/
// axis/informationalOnly) purely to keep the seed data below readable — NOT a re-implementation of
// the banding engine itself.
// ---------------------------------------------------------------------------
interface MetricCatalogEntry { metricKey: string; metricLabel: string; unit: CohortBandDatum["unit"]; axis: string; informationalOnly: boolean }
const METRIC_CATALOG: MetricCatalogEntry[] = [
  { metricKey: "delivery.throughput_weighted", metricLabel: "Throughput (weighted)", unit: "minutes", axis: "delivery", informationalOnly: false },
  { metricKey: "delivery.on_time_rate", metricLabel: "On-time rate", unit: "percent", axis: "delivery", informationalOnly: false },
  { metricKey: "delivery.estimate_coverage", metricLabel: "Estimate coverage", unit: "percent", axis: "delivery", informationalOnly: false },
  { metricKey: "flow.reopen_rate", metricLabel: "Reopen rate", unit: "percent", axis: "quality", informationalOnly: false },
  { metricKey: "effort.estimate_accuracy", metricLabel: "Estimate accuracy", unit: "percent", axis: "effort", informationalOnly: false },
  { metricKey: "collab.contributed_minutes", metricLabel: "Contributed minutes (credited)", unit: "minutes", axis: "collaboration", informationalOnly: false },
  { metricKey: "discipline.checkin_compliance", metricLabel: "Check-in compliance", unit: "percent", axis: "discipline", informationalOnly: true },
  { metricKey: "discipline.time_logging_coverage", metricLabel: "Time-logging coverage", unit: "percent", axis: "discipline", informationalOnly: true },
];

interface MetricSeed { value: number; numerator?: number; denominator?: number; band: 1 | 2 | 3 | 4 | 5 }

/** Builds one subject's `cohortBands[]` from per-metric seed values. `cohortSize` below
 *  SMALL_COHORT_THRESHOLD (5) suppresses EVERY band + percentile in the array — never just some —
 *  matching appraisal-engine.ts's `computeCohortBands` (the small-cohort guard is per-cohort, not
 *  per-metric-within-a-cohort). */
function buildCohortBands(cohortSize: number, seeds: Record<string, MetricSeed>): CohortBandDatum[] {
  const bandable = cohortSize >= 5;
  return METRIC_CATALOG.map((m) => {
    const s = seeds[m.metricKey];
    return {
      metricKey: m.metricKey, metricLabel: m.metricLabel, unit: m.unit, subjectValue: s.value,
      ...(s.numerator !== undefined ? { numerator: s.numerator } : {}),
      ...(s.denominator !== undefined ? { denominator: s.denominator } : {}),
      ...(bandable ? { subjectPercentile: [10, 30, 50, 70, 90][s.band - 1] } : {}),
      band: bandable ? s.band : null,
      cohortSize, axis: m.axis, informationalOnly: m.informationalOnly,
    };
  });
}

/** Mirrors appraisal-engine.ts's `axisAutoScores`: each weighted axis's auto-band is the rounded
 *  mean of its bandable, non-informational constituent metrics' bands; null if none are bandable. */
function axisAutoFromBands(bands: CohortBandDatum[]): Record<AppraisalAxis, number | null> {
  const axes: AppraisalAxis[] = ["delivery", "quality", "effort", "collaboration"];
  const out = {} as Record<AppraisalAxis, number | null>;
  for (const axis of axes) {
    const relevant = bands.filter((b) => b.axis === axis && !b.informationalOnly && b.band !== null);
    out[axis] = relevant.length === 0 ? null : Math.min(5, Math.max(1, Math.round(relevant.reduce((s, b) => s + (b.band as number), 0) / relevant.length)));
  }
  return out;
}

function scoresFrom(auto: Record<AppraisalAxis, number | null>, manager: Partial<Record<AppraisalAxis, { manager: number | null; note?: string }>>): Record<AppraisalAxis, AppraisalAxisScore> {
  const axes: AppraisalAxis[] = ["delivery", "quality", "effort", "collaboration"];
  const out = {} as Record<AppraisalAxis, AppraisalAxisScore>;
  for (const axis of axes) {
    out[axis] = { auto: auto[axis], manager: manager[axis]?.manager ?? null, ...(manager[axis]?.note ? { note: manager[axis]!.note } : {}) };
  }
  return out;
}

const DEFAULT_WEIGHTS: Record<AppraisalAxis, number> = { delivery: 0.35, quality: 0.3, effort: 0.1, collaboration: 0.25 };

const NAME_BY_USER: Record<string, string> = {
  "demo-hansel": "Clement Hansel", "gede-ic": "Gede Kusuma", "seo-staff": "Nyoman Ari",
  "u-dev": "Made Putra", "u-finance": "Rina Wibawa",
};

// ---------------------------------------------------------------------------
// Seed state
// ---------------------------------------------------------------------------
const cycles = new Map<string, AppraisalCycleRow>();
const appraisals = new Map<string, AppraisalPack>();
let seeded = false;

function seedIfNeeded(tenantId: string): void {
  if (seeded) return;
  seeded = true;

  const cycleH1: AppraisalCycleRow = {
    id: "demo-cycle-h1", tenantId, name: "2026 H1 Performance Review",
    periodStart: "2026-01-01", periodEnd: "2026-06-30", status: "closed",
    defaultWeights: DEFAULT_WEIGHTS, roleWeights: {},
    createdBy: "demo-hansel", createdAt: "2026-01-05T09:00:00Z", updatedAt: "2026-07-01T09:00:00Z",
  };
  const cycleH2: AppraisalCycleRow = {
    id: "demo-cycle-h2", tenantId, name: "2026 H2 Performance Review",
    periodStart: "2026-07-01", periodEnd: "2026-12-31", status: "open",
    defaultWeights: DEFAULT_WEIGHTS, roleWeights: {},
    createdBy: "demo-hansel", createdAt: "2026-07-02T09:00:00Z", updatedAt: "2026-07-02T09:00:00Z",
  };
  cycles.set(cycleH1.id, cycleH1);
  cycles.set(cycleH2.id, cycleH2);

  function makePack(input: {
    id: string; cycleId: string; cycleName: string; subjectUserId: string; managerUserId: string; roleKey: string;
    cohortSize: number; metricSeeds: Record<string, MetricSeed>;
    manager: Partial<Record<AppraisalAxis, { manager: number | null; note?: string }>>;
    commentary: string | null; status: AppraisalPack["status"];
    evidenceStale?: boolean; acks?: { actorUserId: string; action: AppraisalPack["acks"][number]["action"]; comment: string | null; createdAt: string }[];
    submittedAt?: string | null; finalizedAt?: string | null;
  }): AppraisalPack {
    const cohortBands = buildCohortBands(input.cohortSize, input.metricSeeds);
    const auto = axisAutoFromBands(cohortBands);
    const scores = scoresFrom(auto, input.manager);
    const composite = previewComposite(DEFAULT_WEIGHTS, scores);
    return {
      id: input.id, tenantId, cycleId: input.cycleId, cycleName: input.cycleName,
      subjectUserId: input.subjectUserId, subjectName: NAME_BY_USER[input.subjectUserId] ?? input.subjectUserId,
      managerUserId: input.managerUserId, managerName: NAME_BY_USER[input.managerUserId] ?? input.managerUserId,
      roleKey: input.roleKey, weights: DEFAULT_WEIGHTS, scores,
      composite: input.status === "draft" ? null : composite,
      commentary: input.commentary, status: input.status, cohortBands,
      evidence: { periodIds: [`demo-period-${input.cycleId}`], revisions: { [`demo-period-${input.cycleId}`]: 1 } },
      evidenceStale: !!input.evidenceStale,
      periodId: `demo-period-${input.cycleId}`, revision: 1,
      submittedAt: input.submittedAt ?? (input.status !== "draft" ? "2026-07-03T10:00:00Z" : null),
      finalizedAt: input.finalizedAt ?? (input.status === "finalized" ? "2026-07-10T10:00:00Z" : null),
      createdAt: "2026-07-02T09:00:00Z", updatedAt: "2026-07-03T10:00:00Z",
      acks: (input.acks ?? []).map((a, i) => ({
        id: `demo-ack-${input.id}-${i}`, appraisalId: input.id, actorUserId: a.actorUserId,
        actorName: NAME_BY_USER[a.actorUserId] ?? a.actorUserId, action: a.action, comment: a.comment, createdAt: a.createdAt,
      })),
    };
  }

  // ── H1 #1 — gede-ic, ACKNOWLEDGED. Bandable cohort of 6 ("developer"). Effort deviates from the
  // auto band by 2 (>1) WITH a written note — demonstrates the enforced-justification requirement
  // on READ, not just on the form. Also carries a `time_logging_coverage` value of exactly 0.864 —
  // the same "0.86 read as 0.86 instead of 86%" defect class this whole program has hit twice
  // before (TR-17/TR-18); this seed exists specifically so a screenshot pass can catch it a third
  // time if it ever regresses.
  appraisals.set("demo-appr-h1-gede", makePack({
    id: "demo-appr-h1-gede", cycleId: cycleH1.id, cycleName: cycleH1.name,
    subjectUserId: "gede-ic", managerUserId: "demo-hansel", roleKey: "developer", cohortSize: 6,
    metricSeeds: {
      "delivery.throughput_weighted": { value: 2600, band: 4 },
      "delivery.on_time_rate": { value: 19 / 22, numerator: 19, denominator: 22, band: 4 },
      "delivery.estimate_coverage": { value: 20 / 22, numerator: 20, denominator: 22, band: 5 },
      "flow.reopen_rate": { value: 1 / 24, numerator: 1, denominator: 24, band: 4 },
      "effort.estimate_accuracy": { value: 0.65, numerator: 65, denominator: 100, band: 2 },
      "collab.contributed_minutes": { value: 310, band: 5 },
      "discipline.checkin_compliance": { value: 21 / 22, numerator: 21, denominator: 22, band: 5 },
      "discipline.time_logging_coverage": { value: 19 / 22, numerator: 19, denominator: 22, band: 4 },
    },
    manager: {
      delivery: { manager: 4 }, quality: { manager: 4 },
      effort: { manager: 4, note: "Pushed back on scope creep and re-planned two mis-estimated tasks mid-sprint — real ownership the raw estimate-accuracy number alone doesn't capture." },
      collaboration: { manager: 5 },
    },
    commentary: "Gede had an excellent first half — consistently on-time delivery, clean estimates on most work, and picked up slack on two blocked teammates' tasks without being asked. The effort score reflects real ownership beyond what the automated inputs alone would suggest.",
    status: "acknowledged",
    acks: [{ actorUserId: "gede-ic", action: "acknowledged", comment: "Thanks for the detailed feedback — appreciate the recognition on the blocked-teammate work.", createdAt: "2026-07-05T14:00:00Z" }],
  }));

  // ── H1 #2 — u-dev (Made Putra), DISPUTED. Same "developer" cohort (6) as gede-ic above.
  appraisals.set("demo-appr-h1-udev", makePack({
    id: "demo-appr-h1-udev", cycleId: cycleH1.id, cycleName: cycleH1.name,
    subjectUserId: "u-dev", managerUserId: "demo-hansel", roleKey: "developer", cohortSize: 6,
    metricSeeds: {
      "delivery.throughput_weighted": { value: 1400, band: 2 },
      "delivery.on_time_rate": { value: 12 / 22, numerator: 12, denominator: 22, band: 2 },
      "delivery.estimate_coverage": { value: 10 / 22, numerator: 10, denominator: 22, band: 2 },
      "flow.reopen_rate": { value: 6 / 20, numerator: 6, denominator: 20, band: 2 },
      "effort.estimate_accuracy": { value: 0.8, numerator: 80, denominator: 100, band: 3 },
      "collab.contributed_minutes": { value: 90, band: 2 },
      "discipline.checkin_compliance": { value: 16 / 22, numerator: 16, denominator: 22, band: 3 },
      "discipline.time_logging_coverage": { value: 15 / 22, numerator: 15, denominator: 22, band: 2 },
    },
    manager: {
      delivery: { manager: 2 },
      quality: { manager: 1, note: "Reopen rate stayed high after repeated QA feedback on the same class of checkout bug this half." },
      effort: { manager: 3 }, collaboration: { manager: 2 },
    },
    commentary: "This half showed slower throughput than the team average and a higher reopen rate on checkout-related work. We should pair on root-causing the recurring QA feedback next cycle rather than just re-shipping fixes.",
    status: "disputed",
    acks: [{ actorUserId: "u-dev", action: "disputed", comment: "I don't think the quality score reflects that most reopens this half traced back to a shared test-environment flake, not my code — flagging for HR review.", createdAt: "2026-07-06T09:30:00Z" }],
  }));

  // ── H1 #3 — u-finance (Rina Wibawa), SUBMITTED, SMALL-COHORT SUPPRESSED (cohortSize 2 <
  // SMALL_COHORT_THRESHOLD). Every band/percentile is null; every rate still carries its
  // numerator/denominator (§5.2 point 2) — including another 0.864/86% pair to double up the
  // regression-catching value of this seed.
  appraisals.set("demo-appr-h1-finance", makePack({
    id: "demo-appr-h1-finance", cycleId: cycleH1.id, cycleName: cycleH1.name,
    subjectUserId: "u-finance", managerUserId: "demo-hansel", roleKey: "finance_analyst", cohortSize: 2,
    metricSeeds: {
      "delivery.throughput_weighted": { value: 1800, band: 3 },
      "delivery.on_time_rate": { value: 20 / 22, numerator: 20, denominator: 22, band: 4 },
      "delivery.estimate_coverage": { value: 19 / 22, numerator: 19, denominator: 22, band: 4 },
      "flow.reopen_rate": { value: 1 / 18, numerator: 1, denominator: 18, band: 4 },
      "effort.estimate_accuracy": { value: 0.94, numerator: 94, denominator: 100, band: 4 },
      "collab.contributed_minutes": { value: 140, band: 3 },
      "discipline.checkin_compliance": { value: 1, numerator: 22, denominator: 22, band: 5 },
      "discipline.time_logging_coverage": { value: 20 / 22, numerator: 20, denominator: 22, band: 4 },
    },
    manager: { delivery: { manager: 4 }, quality: { manager: 4 }, effort: { manager: 3 }, collaboration: { manager: 4 } },
    commentary: "Rina's small team makes cohort comparison unavailable this cycle, so this score leans entirely on qualitative review: consistently accurate reporting, strong stakeholder communication, and full ownership of the month-end close process.",
    status: "submitted",
  }));

  // ── H1 #4 — seo-staff (Nyoman Ari), SUBMITTED, EVIDENCE_STALE. A loginable identity (seo@login),
  // so this state is reachable both from the HR console (demo-hansel) AND by logging in as
  // seo-staff and opening /appraisals/mine.
  appraisals.set("demo-appr-h1-seo", makePack({
    id: "demo-appr-h1-seo", cycleId: cycleH1.id, cycleName: cycleH1.name,
    subjectUserId: "seo-staff", managerUserId: "demo-hansel", roleKey: "seo_specialist", cohortSize: 5,
    metricSeeds: {
      "delivery.throughput_weighted": { value: 2000, band: 4 },
      "delivery.on_time_rate": { value: 17 / 20, numerator: 17, denominator: 20, band: 4 },
      "delivery.estimate_coverage": { value: 16 / 20, numerator: 16, denominator: 20, band: 4 },
      "flow.reopen_rate": { value: 2 / 19, numerator: 2, denominator: 19, band: 4 },
      "effort.estimate_accuracy": { value: 0.88, numerator: 88, denominator: 100, band: 4 },
      "collab.contributed_minutes": { value: 220, band: 4 },
      "discipline.checkin_compliance": { value: 19 / 20, numerator: 19, denominator: 20, band: 4 },
      "discipline.time_logging_coverage": { value: 17 / 20, numerator: 17, denominator: 20, band: 4 },
    },
    manager: { delivery: { manager: 4 }, quality: { manager: 4 }, effort: { manager: 4 }, collaboration: { manager: 4 } },
    commentary: "Nyoman kept the SEO workstream steady all half — consistent delivery cadence, tight estimates, and reliable collaboration with the content team. No concerns to flag this cycle.",
    status: "submitted", evidenceStale: true,
  }));

  // ── H2 (OPEN cycle) — gede-ic, DRAFT. The one a manager (demo-hansel) actively scores + submits
  // in a live walkthrough of the acceptance-bar flow. No manager scores, no commentary yet.
  appraisals.set("demo-appr-h2-gede", makePack({
    id: "demo-appr-h2-gede", cycleId: cycleH2.id, cycleName: cycleH2.name,
    subjectUserId: "gede-ic", managerUserId: "demo-hansel", roleKey: "developer", cohortSize: 6,
    metricSeeds: {
      "delivery.throughput_weighted": { value: 2700, band: 4 },
      "delivery.on_time_rate": { value: 20 / 23, numerator: 20, denominator: 23, band: 4 },
      "delivery.estimate_coverage": { value: 19 / 23, numerator: 19, denominator: 23, band: 3 },
      "flow.reopen_rate": { value: 2 / 25, numerator: 2, denominator: 25, band: 3 },
      "effort.estimate_accuracy": { value: 0.9, numerator: 90, denominator: 100, band: 3 },
      "collab.contributed_minutes": { value: 260, band: 4 },
      "discipline.checkin_compliance": { value: 21 / 23, numerator: 21, denominator: 23, band: 4 },
      "discipline.time_logging_coverage": { value: 20 / 23, numerator: 20, denominator: 23, band: 4 },
    },
    manager: {},
    commentary: null, status: "draft",
  }));
}

// ---------------------------------------------------------------------------
// Access approximation (mirrors §8's matrix roughly enough to exercise the 403 branch under
// DEMO_MODE — not a re-implementation of Cerbos, same disclaimer demoReports.ts's own
// `isAuthorized` carries). `demo-hansel` is the only demo identity modelled with the elevated
// (platform_admin + group_executive) grant, so it is both HR/exec AND (per the controller's own
// comment) exempt from the exact-manager-match narrowing.
// ---------------------------------------------------------------------------
function isElevated(userId: string): boolean {
  return userId === "demo-hansel";
}

export function appraisalsDemo(method: string, p: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
  const tenantMatch = p.match(/^\/api\/([^/]+)\/appraisals(\/.*)?$/);
  if (!tenantMatch) return null;
  const tenantId = tenantMatch[1];
  seedIfNeeded(tenantId);
  const rest = tenantMatch[2] ?? "";

  // ---- cycles ----
  if (rest === "/cycles" && method === "GET") {
    if (!isElevated(userId)) return err(403, "forbidden");
    return ok({ cycles: [...cycles.values()].filter((c) => c.tenantId === tenantId).sort((a, b) => b.periodStart.localeCompare(a.periodStart)) });
  }
  if (rest === "/cycles" && method === "POST") {
    if (!isElevated(userId)) return err(403, "forbidden");
    const b = body ? JSON.parse(body) : {};
    if (!b.name) return err(400, "name is required", "name");
    if (!b.periodStart) return err(400, "periodStart must be a YYYY-MM-DD date", "periodStart");
    if (!b.periodEnd) return err(400, "periodEnd must be a YYYY-MM-DD date", "periodEnd");
    if (b.periodEnd < b.periodStart) return err(400, "periodEnd must be on or after periodStart", "periodEnd");
    const cycle: AppraisalCycleRow = {
      id: demoId("cycle"), tenantId, name: String(b.name).trim(), periodStart: b.periodStart, periodEnd: b.periodEnd,
      status: "draft", defaultWeights: b.defaultWeights ?? DEFAULT_WEIGHTS, roleWeights: b.roleWeights ?? {},
      createdBy: userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    cycles.set(cycle.id, cycle);
    return ok(cycle);
  }
  const cycleOneMatch = rest.match(/^\/cycles\/([^/]+)$/);
  if (cycleOneMatch && method === "GET") {
    if (!isElevated(userId)) return err(403, "forbidden");
    const cycle = cycles.get(cycleOneMatch[1]);
    if (!cycle) return err(404, "cycle not found");
    return ok(cycle);
  }
  if (cycleOneMatch && method === "PATCH") {
    if (!isElevated(userId)) return err(403, "forbidden");
    const cycle = cycles.get(cycleOneMatch[1]);
    if (!cycle) return err(404, "cycle not found");
    const b = body ? JSON.parse(body) : {};
    if (b.status !== undefined && !["draft", "open", "in_review", "closed"].includes(b.status)) {
      return err(400, "status must be one of draft, open, in_review, closed", "status");
    }
    const next: AppraisalCycleRow = {
      ...cycle,
      name: b.name?.trim() || cycle.name,
      periodStart: b.periodStart ?? cycle.periodStart,
      periodEnd: b.periodEnd ?? cycle.periodEnd,
      status: b.status ?? cycle.status,
      defaultWeights: b.defaultWeights ?? cycle.defaultWeights,
      roleWeights: b.roleWeights ?? cycle.roleWeights,
      updatedAt: new Date().toISOString(),
    };
    cycles.set(next.id, next);
    return ok(next);
  }

  // ---- generate ----
  const generateMatch = rest.match(/^\/cycles\/([^/]+)\/generate$/);
  if (generateMatch && method === "POST") {
    if (!isElevated(userId)) return err(403, "forbidden");
    const cycle = cycles.get(generateMatch[1]);
    if (!cycle) return err(404, "cycle not found");
    const b = body ? JSON.parse(body) : {};
    const roster: GenerateRoster[] = Array.isArray(b.subjects) ? b.subjects : [];
    if (roster.length === 0) return err(400, "subjects must be a non-empty array of {subjectUserId, managerUserId, roleKey?}", "subjects");
    const generated: string[] = [];
    const skippedExisting: string[] = [];
    for (const s of roster) {
      const existing = [...appraisals.values()].find((a) => a.cycleId === cycle.id && a.subjectUserId === s.subjectUserId);
      if (existing) { skippedExisting.push(s.subjectUserId); continue; }
      const weights = (s.roleKey && cycle.roleWeights[s.roleKey]) || cycle.defaultWeights;
      const id = demoId("appr");
      const scores = scoresFrom({ delivery: null, quality: null, effort: null, collaboration: null }, {});
      const pack: AppraisalPack = {
        id, tenantId, cycleId: cycle.id, cycleName: cycle.name,
        subjectUserId: s.subjectUserId, subjectName: NAME_BY_USER[s.subjectUserId] ?? s.subjectUserId,
        managerUserId: s.managerUserId, managerName: NAME_BY_USER[s.managerUserId] ?? s.managerUserId,
        roleKey: s.roleKey ?? null, weights, scores, composite: null, commentary: null, status: "draft",
        cohortBands: [], evidence: { periodIds: [], revisions: {} }, evidenceStale: false,
        periodId: `demo-period-${cycle.id}`, revision: 1,
        submittedAt: null, finalizedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        acks: [],
      };
      appraisals.set(id, pack);
      generated.push(id);
    }
    return ok({ generated, skippedExisting });
  }

  // ---- mine (must be checked before the single-id route) ----
  if (rest === "/mine" && method === "GET") {
    const cycleId = params.get("cycleId") ?? undefined;
    const mine = [...appraisals.values()].filter((a) => a.subjectUserId === userId && a.status !== "draft" && (!cycleId || a.cycleId === cycleId));
    return ok({ appraisals: mine });
  }

  // ---- list ----
  if (rest === "" && method === "GET") {
    const cycleId = params.get("cycleId") ?? undefined;
    const subjectId = params.get("subjectId") ?? undefined;
    let rows = [...appraisals.values()];
    if (isElevated(userId)) {
      // broad tier — no narrowing
    } else if (rows.some((a) => a.managerUserId === userId)) {
      rows = rows.filter((a) => a.managerUserId === userId);
    } else {
      rows = rows.filter((a) => a.subjectUserId === userId && a.status !== "draft");
    }
    if (cycleId) rows = rows.filter((a) => a.cycleId === cycleId);
    if (subjectId) rows = rows.filter((a) => a.subjectUserId === subjectId);
    return ok({ appraisals: rows.map((r) => ({ id: r.id, cycleId: r.cycleId, subjectUserId: r.subjectUserId, managerUserId: r.managerUserId, status: r.status, composite: r.composite })) });
  }

  // ---- single-id routes ----
  const submitMatch = rest.match(/^\/([^/]+)\/submit$/);
  if (submitMatch && method === "POST") {
    const a = appraisals.get(submitMatch[1]);
    if (!a) return err(404, "appraisal not found");
    if (!isElevated(userId) && userId !== a.managerUserId) return err(403, "not your assigned subject");
    if (a.status !== "draft") return err(409, "this appraisal is not in draft");
    const b = body ? JSON.parse(body) : {};
    const commentary: string | undefined = b.commentary !== undefined ? b.commentary : a.commentary ?? undefined;
    const readiness = checkSubmitReadiness(a.scores, commentary);
    if (!readiness.commentaryOk) return err(400, `commentary must be at least ${MIN_COMMENTARY_LENGTH} characters`, "commentary");
    if (readiness.incompleteAxes.length > 0) return err(400, `axis "${readiness.incompleteAxes[0]}" must be scored before submit`, "scores");
    if (readiness.missingDeviationNotes.length > 0) {
      return err(400, `axis "${readiness.missingDeviationNotes.join(", ")}" deviates from the computed band by more than one and requires a written note`, "scores");
    }
    const next: AppraisalPack = { ...a, status: "submitted", commentary: commentary ?? null, composite: previewComposite(a.weights, a.scores), submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    appraisals.set(next.id, next);
    return ok(next);
  }

  const ackMatch = rest.match(/^\/([^/]+)\/ack$/);
  if (ackMatch && method === "POST") {
    const a = appraisals.get(ackMatch[1]);
    if (!a) return err(404, "appraisal not found");
    if (userId !== a.subjectUserId) return err(403, "forbidden");
    const b = body ? JSON.parse(body) : {};
    if (b.action !== "acknowledged" && b.action !== "disputed") return err(400, 'action must be "acknowledged" or "disputed"', "action");
    if (!["submitted", "acknowledged", "disputed"].includes(a.status)) return err(409, "this appraisal cannot be acknowledged in its current state");
    const entry: AppraisalAckEntry = { id: demoId("ack"), appraisalId: a.id, actorUserId: userId, actorName: NAME_BY_USER[userId] ?? userId, action: b.action, comment: b.comment ?? null, createdAt: new Date().toISOString() };
    const next: AppraisalPack = { ...a, status: b.action, acks: [...a.acks, entry], updatedAt: new Date().toISOString() };
    appraisals.set(next.id, next);
    return ok(next);
  }

  const finalizeMatch = rest.match(/^\/([^/]+)\/finalize$/);
  if (finalizeMatch && method === "POST") {
    const a = appraisals.get(finalizeMatch[1]);
    if (!a) return err(404, "appraisal not found");
    if (!isElevated(userId)) return err(403, "forbidden");
    if (!["submitted", "acknowledged", "disputed"].includes(a.status)) return err(409, "this appraisal cannot be finalized in its current state");
    if (a.evidenceStale) {
      return err(409, "this appraisal's evidence has been amended since it was generated — a manager or HR must re-confirm (PATCH {confirmEvidence:true}) before it can be finalized");
    }
    const entry: AppraisalAckEntry = { id: demoId("ack"), appraisalId: a.id, actorUserId: userId, actorName: NAME_BY_USER[userId] ?? userId, action: "finalized", comment: null, createdAt: new Date().toISOString() };
    const next: AppraisalPack = { ...a, status: "finalized", finalizedAt: new Date().toISOString(), acks: [...a.acks, entry], updatedAt: new Date().toISOString() };
    appraisals.set(next.id, next);
    return ok(next);
  }

  const singleMatch = rest.match(/^\/([^/]+)$/);
  if (singleMatch && method === "GET") {
    const a = appraisals.get(singleMatch[1]);
    if (!a) return err(404, "appraisal not found");
    const elevated = isElevated(userId);
    const isManager = userId === a.managerUserId;
    const isSubject = userId === a.subjectUserId;
    if (!elevated && !isManager && !isSubject) return err(403, "forbidden");
    if (!elevated && isSubject && !isManager && a.status === "draft") return err(403, "this appraisal has not been submitted yet");
    return ok(a);
  }
  if (singleMatch && method === "PATCH") {
    const a = appraisals.get(singleMatch[1]);
    if (!a) return err(404, "appraisal not found");
    if (a.status === "finalized") return err(409, "a finalized appraisal cannot be edited");
    const elevated = isElevated(userId);
    const isManager = userId === a.managerUserId;
    const b = body ? JSON.parse(body) : {};
    const wantsScoreEdit = b.scores !== undefined || b.commentary !== undefined;
    const wantsConfirm = !!b.confirmEvidence;
    if (!wantsScoreEdit && !wantsConfirm) return err(400, "nothing to update — pass scores, commentary, or confirmEvidence");
    if (wantsScoreEdit && !elevated && !isManager) return err(403, "not your assigned subject");
    if (wantsScoreEdit && a.status !== "draft") return err(409, "scores/commentary can only be edited while the appraisal is in draft");

    let scores = a.scores;
    let commentary = a.commentary;
    if (wantsScoreEdit) {
      if (b.scores) {
        scores = { ...a.scores };
        for (const axis of Object.keys(b.scores) as AppraisalAxis[]) {
          const patch = b.scores[axis];
          if (!patch) continue;
          if (patch.manager !== undefined && patch.manager !== null && (!Number.isInteger(patch.manager) || patch.manager < 1 || patch.manager > 5)) {
            return err(400, "each axis score must be an integer 1-5", "scores");
          }
          scores[axis] = { ...scores[axis], ...(patch.manager !== undefined ? { manager: patch.manager } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) };
        }
      }
      if (b.commentary !== undefined) commentary = b.commentary;
    }
    let evidenceStale = a.evidenceStale;
    if (wantsConfirm) evidenceStale = false;
    const next: AppraisalPack = { ...a, scores, commentary, evidenceStale, updatedAt: new Date().toISOString() };
    appraisals.set(next.id, next);
    return ok(next);
  }

  return null;
}
