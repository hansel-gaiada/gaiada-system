// M5-V5-c — the experiments service, PURE half: input parsing, the pre-registration plan, reading the site's Umami events,
// matching a live `experiment` block against its registration, and the results view. No DB, no HTTP, no clock, no network
// (experiments.service.ts owns those), so every rule here is a plain unit test.
// Design: docs/plans/2026-10-12-m5-phase5-design.md §5.1 (the block), §5.3 (the events), §5.4 (the stopping rule), §5.5, §10 O6/O9.
//
// THE LOAD-BEARING PROPERTY: before the pre-registered horizon the results carry NO rate, difference, interval, p-value or
// conversion count, for any principal. Two layers hold it:
//   1. `evaluateOnExposures` reads the CONVERSIONS from Umami only after the exposure-only progress says the horizon is
//      reached (so before it the conversions are never even fetched), and
//   2. `toResultsDto` is a WHITELIST: the pre-horizon branch is built from `progress` and a reduced SRM verdict
//      (`evaluable` / `mismatch` / words, never the chi-square or its p), not by deleting fields from a bigger object.
import {
  EXPERIMENT_STATS_LIMITS,
  ExperimentStatsError,
  evaluateExperiment,
  progressView,
  projectDuration,
  sampleSizePerArm,
  type ArmCounts,
  type ExperimentPlan,
  type ExperimentView,
  type HorizonAnalysis,
} from "./experiment-stats";

// ---------------------------------------------------------------------------------------------
// Constants (design §5.1 rules, §5.5 caps, §10 O9)
// ---------------------------------------------------------------------------------------------

export const EXPERIMENT_KEY_RE = /^[a-z0-9][a-z0-9-]{2,47}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLLECTION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The goal events the block allows (§5.1) — the site's own EventName members. */
export const GOAL_EVENTS = ["generate_lead", "lead_form_start", "cta_click", "click_whatsapp", "click_phone", "click_email", "section_view"] as const;
export type GoalEvent = (typeof GOAL_EVENTS)[number];
export const GOAL_MATCH_KEYS = ["form_id", "link_location", "section_id"] as const;
export type GoalMatchKey = (typeof GOAL_MATCH_KEYS)[number];

export const ARM_KEYS = ["a", "b", "c", "d"] as const;
export const MIN_WEIGHT = 10;
export const MAX_RUNNING_PER_PROPERTY = 10;
/** Pre-registered hypotheses are short, human sentences. */
export const MAX_HYPOTHESIS_CHARS = 500;
export const MAX_NOTE_CHARS = 500;
/** The window of Umami traffic the baseline and the duration projection are read from (§5.4). */
export const TRAFFIC_WINDOW_DAYS = 28;
/** Umami's `event-data/values` returns at most this many rows; a full page may have been cut. */
export const UMAMI_VALUES_LIMIT = 100;
/** Relative MDE ceiling: +500 % is already beyond anything a headline test can honestly claim. */
export const MAX_RELATIVE_MDE = 5;
/** Counts under this leave the service as the string "<5" (visitor addendum R-V6, the same rule as umami-reads.ts). */
export const SMALL_CELL = 5;
export type Count = number | "<5";
export const suppressCount = (n: number): Count => (n < SMALL_CELL ? "<5" : n);

/** The stats engine's fixed design values (§10 O9). Not caller-editable. */
export const ALPHA = EXPERIMENT_STATS_LIMITS.alpha;
export const POWER = EXPERIMENT_STATS_LIMITS.power;

// ---------------------------------------------------------------------------------------------
// Typed refusals (the service turns these into HTTP errors; the TOKEN comes first in `message`)
// ---------------------------------------------------------------------------------------------

export class ExperimentRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 503,
    readonly token: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExperimentRefusal";
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; token: string; message: string };
const bad = (token: string, message: string): { ok: false; token: string; message: string } => ({ ok: false, token, message });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export type ExperimentTarget = "fields" | { block: number };
export interface ExperimentGoal { event: GoalEvent; match?: { [K in GoalMatchKey]?: string } }
export interface ArmWeight { key: string; weight: number }

export interface WebdeskRef { tenantSlug: string; siteId: string; itemId: string }

/** What a caller sends to register a test. `baselineRate` null means "suggest it from the last 28 days of Umami". */
export interface RegistrationInput {
  key: string;
  hypothesis: string;
  webdesk: WebdeskRef;
  sectionId: string;
  target: ExperimentTarget;
  enrolment: "consented" | "all";
  goal: ExperimentGoal;
  arms: ArmWeight[];
  baselineRate: number | null;
  relativeMde: number;
}

/** The fields a draft may still change (the item and the key never change: that would be another test). */
export type DraftPatch = Partial<Omit<RegistrationInput, "key" | "webdesk">>;

function parseKey(v: unknown): Parsed<string> {
  return typeof v === "string" && EXPERIMENT_KEY_RE.test(v) ? { ok: true, value: v } : bad("key_invalid", "key must be 3 to 48 characters: lower-case letters, digits and dashes, starting with a letter or digit");
}
function parseHypothesis(v: unknown): Parsed<string> {
  if (typeof v !== "string" || v.trim() === "") return bad("hypothesis_required", "hypothesis must be a sentence saying what you expect to change and why");
  if (v.trim().length > MAX_HYPOTHESIS_CHARS) return bad("hypothesis_too_long", `hypothesis is limited to ${MAX_HYPOTHESIS_CHARS} characters`);
  return { ok: true, value: v.trim() };
}
function parseSectionId(v: unknown): Parsed<string> {
  return typeof v === "string" && TOKEN_RE.test(v) ? { ok: true, value: v } : bad("section_id_invalid", "sectionId must be the Umami section_id of the tested section (letters, digits and . _ : -, at most 64)");
}
function parseTarget(v: unknown): Parsed<ExperimentTarget> {
  if (v === "fields") return { ok: true, value: "fields" };
  if (isObj(v) && Object.keys(v).length === 1 && typeof v.block === "number" && Number.isInteger(v.block) && v.block >= 1 && v.block <= 500) {
    return { ok: true, value: { block: v.block } };
  }
  return bad("target_invalid", 'target must be "fields" or {"block": <index of a generic block, at least 1>}');
}
function parseEnrolment(v: unknown, allowAll: boolean): Parsed<"consented" | "all"> {
  if (v === "consented") return { ok: true, value: "consented" };
  if (v === "all") {
    // §10 O6: consented only until counsel confirms F9; then chosen per experiment.
    return allowAll ? { ok: true, value: "all" } : bad("enrolment_all_not_enabled", 'enrolment "all" waits for counsel on F9 (design §10 O6); use "consented"');
  }
  return bad("enrolment_invalid", 'enrolment must be "consented" or "all"');
}
function parseGoal(v: unknown): Parsed<ExperimentGoal> {
  if (!isObj(v)) return bad("goal_invalid", "goal must be {event, match?}");
  for (const k of Object.keys(v)) if (k !== "event" && k !== "match") return bad("goal_invalid", `goal has an unknown member ${JSON.stringify(k.slice(0, 40))}`);
  if (typeof v.event !== "string" || !(GOAL_EVENTS as readonly string[]).includes(v.event)) return bad("goal_event_invalid", `goal.event must be one of ${GOAL_EVENTS.join(", ")}`);
  const goal: ExperimentGoal = { event: v.event as GoalEvent };
  if (v.match !== undefined) {
    if (!isObj(v.match)) return bad("goal_match_invalid", "goal.match must be an object with at most one of form_id, link_location, section_id");
    const keys = Object.keys(v.match);
    if (keys.length > 1) return bad("goal_match_invalid", "goal.match holds at most one of form_id, link_location, section_id");
    if (keys.length === 1) {
      const k = keys[0]!;
      const val = v.match[k];
      if (!(GOAL_MATCH_KEYS as readonly string[]).includes(k)) return bad("goal_match_invalid", "goal.match holds at most one of form_id, link_location, section_id");
      if (typeof val !== "string" || !TOKEN_RE.test(val)) return bad("goal_match_invalid", `goal.match.${k} must be 1 to 64 characters of letters, digits and . _ : -`);
      goal.match = { [k]: val } as ExperimentGoal["match"];
    }
  }
  return { ok: true, value: goal };
}
/** Arms 2 to 4 with keys a to d in order; integer weights of at least 10 summing to 100 (§5.1). */
export function parseArms(v: unknown): Parsed<ArmWeight[]> {
  if (!Array.isArray(v) || v.length < 2 || v.length > 4) return bad("arms_invalid", "arms must list 2 to 4 arms: a (the control), b, c, d in order");
  const out: ArmWeight[] = [];
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    if (!isObj(a)) return bad("arms_invalid", "each arm is {key, weight}");
    for (const k of Object.keys(a)) if (k !== "key" && k !== "weight") return bad("arms_invalid", "each arm is {key, weight}; the arm's content (override) lives in WebDesk, not here");
    if (a.key !== ARM_KEYS[i]) return bad("arms_invalid", `arm ${i + 1} must have the key "${ARM_KEYS[i]}"`);
    if (typeof a.weight !== "number" || !Number.isInteger(a.weight) || a.weight < MIN_WEIGHT) return bad("arms_invalid", `each weight is a whole number of at least ${MIN_WEIGHT}`);
    sum += a.weight;
    out.push({ key: a.key as string, weight: a.weight });
  }
  if (sum !== 100) return bad("arms_invalid", "the weights must add up to 100");
  return { ok: true, value: out };
}
function parseBaseline(v: unknown): Parsed<number | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0 && v < 1)) return bad("baseline_rate_invalid", "baselineRate must be a number between 0 and 1 (0.03 means 3 %), or omitted to suggest it from the last 28 days");
  return { ok: true, value: v };
}
function parseMde(v: unknown): Parsed<number> {
  if (typeof v !== "number" || !Number.isFinite(v) || !(v > 0 && v <= MAX_RELATIVE_MDE)) return bad("mde_invalid", `relativeMde must be a number above 0 and at most ${MAX_RELATIVE_MDE} (0.5 means 3.0 % -> 4.5 %)`);
  return { ok: true, value: v };
}
function parseWebdesk(v: unknown): Parsed<WebdeskRef> {
  if (!isObj(v)) return bad("webdesk_invalid", "webdesk must be {tenantSlug, siteId, itemId}");
  for (const k of Object.keys(v)) if (k !== "tenantSlug" && k !== "siteId" && k !== "itemId") return bad("webdesk_invalid", "webdesk must be {tenantSlug, siteId, itemId}");
  if (typeof v.tenantSlug !== "string" || !SLUG_RE.test(v.tenantSlug)) return bad("webdesk_invalid", "webdesk.tenantSlug must be a WebDesk tenant slug");
  if (typeof v.siteId !== "string" || !UUID_RE.test(v.siteId)) return bad("webdesk_invalid", "webdesk.siteId must be a valid id");
  if (typeof v.itemId !== "string" || !UUID_RE.test(v.itemId)) return bad("webdesk_invalid", "webdesk.itemId must be a valid id");
  return { ok: true, value: { tenantSlug: v.tenantSlug, siteId: v.siteId.toLowerCase(), itemId: v.itemId.toLowerCase() } };
}

const REGISTER_MEMBERS = ["key", "hypothesis", "webdesk", "sectionId", "target", "enrolment", "goal", "arms", "baselineRate", "relativeMde"] as const;

/** Parse the body of the register call. Allow-listed members only. Exported for the unit tests. */
export function parseRegistration(body: unknown, opts: { allowAllEnrolment?: boolean } = {}): Parsed<RegistrationInput> {
  if (!isObj(body)) return bad("body_invalid", "the body must be a JSON object");
  for (const k of Object.keys(body)) if (!(REGISTER_MEMBERS as readonly string[]).includes(k)) return bad("unknown_field", `${JSON.stringify(k.slice(0, 40))} is not a registration field`);
  const key = parseKey(body.key); if (!key.ok) return key;
  const hypothesis = parseHypothesis(body.hypothesis); if (!hypothesis.ok) return hypothesis;
  const webdesk = parseWebdesk(body.webdesk); if (!webdesk.ok) return webdesk;
  const sectionId = parseSectionId(body.sectionId); if (!sectionId.ok) return sectionId;
  const target = parseTarget(body.target ?? "fields"); if (!target.ok) return target;
  const enrolment = parseEnrolment(body.enrolment ?? "consented", opts.allowAllEnrolment === true); if (!enrolment.ok) return enrolment;
  const goal = parseGoal(body.goal); if (!goal.ok) return goal;
  const arms = parseArms(body.arms); if (!arms.ok) return arms;
  const baselineRate = parseBaseline(body.baselineRate); if (!baselineRate.ok) return baselineRate;
  const relativeMde = parseMde(body.relativeMde); if (!relativeMde.ok) return relativeMde;
  return {
    ok: true,
    value: {
      key: key.value, hypothesis: hypothesis.value, webdesk: webdesk.value, sectionId: sectionId.value, target: target.value,
      enrolment: enrolment.value, goal: goal.value, arms: arms.value, baselineRate: baselineRate.value, relativeMde: relativeMde.value,
    },
  };
}

const PATCH_MEMBERS = ["hypothesis", "sectionId", "target", "enrolment", "goal", "arms", "baselineRate", "relativeMde"] as const;

/** Parse the body of a draft edit. The key and the item never change; an empty patch is refused. */
export function parseDraftPatch(body: unknown, opts: { allowAllEnrolment?: boolean } = {}): Parsed<DraftPatch> {
  if (!isObj(body)) return bad("body_invalid", "the body must be a JSON object");
  const keys = Object.keys(body);
  if (keys.length === 0) return bad("empty_patch", "send at least one field to change");
  for (const k of keys) {
    if (k === "key" || k === "webdesk") return bad("field_not_editable", `${k} never changes: register a new test instead`);
    if (!(PATCH_MEMBERS as readonly string[]).includes(k)) return bad("unknown_field", `${JSON.stringify(k.slice(0, 40))} is not an editable field`);
  }
  const out: DraftPatch = {};
  if (body.hypothesis !== undefined) { const r = parseHypothesis(body.hypothesis); if (!r.ok) return r; out.hypothesis = r.value; }
  if (body.sectionId !== undefined) { const r = parseSectionId(body.sectionId); if (!r.ok) return r; out.sectionId = r.value; }
  if (body.target !== undefined) { const r = parseTarget(body.target); if (!r.ok) return r; out.target = r.value; }
  if (body.enrolment !== undefined) { const r = parseEnrolment(body.enrolment, opts.allowAllEnrolment === true); if (!r.ok) return r; out.enrolment = r.value; }
  if (body.goal !== undefined) { const r = parseGoal(body.goal); if (!r.ok) return r; out.goal = r.value; }
  if (body.arms !== undefined) { const r = parseArms(body.arms); if (!r.ok) return r; out.arms = r.value; }
  if (body.baselineRate !== undefined) { const r = parseBaseline(body.baselineRate); if (!r.ok) return r; out.baselineRate = r.value; }
  if (body.relativeMde !== undefined) { const r = parseMde(body.relativeMde); if (!r.ok) return r; out.relativeMde = r.value; }
  return { ok: true, value: out };
}

/** Parse the optional note of a decide call. */
export function parseNote(body: unknown): Parsed<string | null> {
  if (body === undefined || body === null) return { ok: true, value: null };
  if (!isObj(body)) return bad("body_invalid", "the body must be a JSON object");
  for (const k of Object.keys(body)) if (k !== "note") return bad("unknown_field", `${JSON.stringify(k.slice(0, 40))} is not a field of this call`);
  if (body.note === undefined || body.note === null) return { ok: true, value: null };
  if (typeof body.note !== "string") return bad("note_invalid", "note must be text");
  const n = body.note.trim();
  if (n.length > MAX_NOTE_CHARS) return bad("note_too_long", `note is limited to ${MAX_NOTE_CHARS} characters`);
  return { ok: true, value: n === "" ? null : n };
}

// ---------------------------------------------------------------------------------------------
// The pre-registration plan
// ---------------------------------------------------------------------------------------------

export interface PlanInputs { baselineRate: number; relativeMde: number; weights: readonly number[]; dailyUnits: number }
export interface RegisteredPlan { nPerArm: number; projectedDays: number; limitedByMinimum: boolean }

/**
 * n per arm and the projected duration. Throws `ExperimentRefusal(422)`:
 *  - `mde_out_of_range` when baseline x (1 + MDE) is not below 1,
 *  - `underpowered` when the projection at the observed traffic exceeds 56 days (design §5.4); the refusal carries the
 *    projection as `detail` so the caller can show it.
 */
export function computePlan(i: PlanInputs): RegisteredPlan {
  let n: number;
  try {
    n = sampleSizePerArm({ baselineRate: i.baselineRate, relativeMde: i.relativeMde, alpha: ALPHA, power: POWER }).nPerArm;
  } catch (e) {
    if (e instanceof ExperimentStatsError) throw new ExperimentRefusal(422, "mde_out_of_range", `mde_out_of_range: ${e.message}`);
    throw e;
  }
  const dur = projectDuration({ nPerArm: n, weights: i.weights, dailyUnits: i.dailyUnits });
  if (!dur.ok) {
    const days = Number.isFinite(dur.projectedDays) ? dur.projectedDays : null;
    throw new ExperimentRefusal(
      422, "underpowered",
      days === null
        ? `underpowered: no eligible traffic was seen in the last ${TRAFFIC_WINDOW_DAYS} days, so the test would never reach its ${n} exposures per arm`
        : `underpowered: at the last ${TRAFFIC_WINDOW_DAYS} days' traffic this test needs ${days} days, more than the ${dur.maxDays}-day limit (${n} exposures per arm)`,
      { projectedDays: days, maxDays: dur.maxDays, nPerArm: n, dailyUnits: i.dailyUnits },
    );
  }
  return { nPerArm: n, projectedDays: dur.days, limitedByMinimum: dur.limitedByMinimum };
}

// ---------------------------------------------------------------------------------------------
// Reading the site's events from Umami (§5.3: `ev` = "<key>:<arm>:<c|s>" on exp_exposure / exp_convert)
// ---------------------------------------------------------------------------------------------

export const EXPOSURE_EVENT = "exp_exposure";
export const CONVERT_EVENT = "exp_convert";
export const EV_PROPERTY = "ev";

export interface EvCounts { counts: number[]; /** the page may have been cut at Umami's 100-row limit */ truncated: boolean }

/**
 * Sum the `ev` values of one experiment into one count per arm (c and s unit kinds are added: a `consented` test only has
 * `c`, an `all` test has both). Rows of other experiments, arms the test does not have, or malformed values are ignored.
 */
export function countEvValues(body: unknown, key: string, armKeys: readonly string[]): EvCounts {
  const rows = Array.isArray(body) ? body : [];
  const counts = armKeys.map(() => 0);
  for (const r of rows) {
    if (!isObj(r) || typeof r.value !== "string" || typeof r.total !== "number" || !Number.isFinite(r.total) || r.total < 0) continue;
    const parts = r.value.split(":");
    if (parts.length !== 3 || parts[0] !== key || (parts[2] !== "c" && parts[2] !== "s")) continue;
    const idx = armKeys.indexOf(parts[1]!);
    if (idx >= 0) counts[idx]! += Math.floor(r.total);
  }
  return { counts, truncated: rows.length >= UMAMI_VALUES_LIMIT };
}

/** The total of one value in an Umami `event-data/values` body ([{value,total}]). */
export function totalOfValue(body: unknown, value: string): number {
  for (const r of Array.isArray(body) ? body : []) {
    if (isObj(r) && String(r.value) === value && typeof r.total === "number" && Number.isFinite(r.total)) return Math.max(0, r.total);
  }
  return 0;
}
/** The count of one event name in an Umami `metrics?type=event` body ([{x,y}]). */
export function totalOfEvent(body: unknown, eventName: string): number {
  for (const r of Array.isArray(body) ? body : []) {
    if (isObj(r) && r.x === eventName && typeof r.y === "number" && Number.isFinite(r.y)) return Math.max(0, r.y);
  }
  return 0;
}

/**
 * The goal's baseline rate over the traffic window: goal events divided by the tested section's views, kept inside
 * (0.0001, 0.9) so the sample-size formula stays defined. Null when the section had no views.
 */
export function suggestBaseline(goalEvents: number, sectionViews: number): number | null {
  if (!(sectionViews > 0)) return null;
  return Math.min(0.9, Math.max(0.0001, goalEvents / sectionViews));
}

// ---------------------------------------------------------------------------------------------
// The live block (vocabulary 1.5.0) against the registration
// ---------------------------------------------------------------------------------------------

export interface RegisteredShape {
  key: string; target: ExperimentTarget; enrolment: string; goal: ExperimentGoal; arms: ArmWeight[];
}

/** The first `experiment` block of an item's blocks, as its props, or null. */
export function experimentBlockOf(blocks: unknown): Record<string, unknown> | null {
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (isObj(b) && b.type === "experiment") return isObj(b.props) ? b.props : {};
  }
  return null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

/**
 * What differs between the registration and the block that went live (the statistics assume the registered weights, goal and
 * enrolment). Empty means the live block IS the registered test. The arms' overrides are WebDesk's own business.
 */
export function planDifferences(reg: RegisteredShape, props: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (props.key !== reg.key) out.push("key");
  if (!same(props.target ?? "fields", reg.target)) out.push("target");
  if ((props.enrolment ?? "consented") !== reg.enrolment) out.push("enrolment");
  if (!same(props.goal ?? null, reg.goal)) out.push("goal");
  const liveArms = (Array.isArray(props.arms) ? props.arms : []).map((a) => (isObj(a) ? { key: a.key, weight: a.weight } : null));
  if (!same(liveArms, reg.arms)) out.push("arms");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Evaluation: exposures first, conversions only at the horizon
// ---------------------------------------------------------------------------------------------

export interface EvalPlan {
  nPerArm: number;
  armKeys: readonly string[];
  weights: readonly number[];
}
export interface EvalOutcome {
  view: ExperimentView;
  /** The counts the view was built from. `conversions` are all 0 and NEVER READ unless `horizon` is true. */
  arms: ArmCounts[];
  warnings: string[];
}

/**
 * Evaluate with the exposures first. `loadConversions` is called ONLY when the exposure-only progress says every arm has its
 * n and the minimum days have passed; before that the engine gets zeros it never reads (its pre-horizon branch is built from
 * exposure counts only), so no conversion count is fetched, held or returned for a test that has not reached its horizon.
 */
export async function evaluateOnExposures(
  plan: EvalPlan,
  exposures: readonly number[],
  elapsedDays: number,
  loadConversions: () => Promise<readonly number[]>,
): Promise<EvalOutcome> {
  const enginePlan: ExperimentPlan = { nPerArm: plan.nPerArm, weights: plan.weights, armKeys: plan.armKeys };
  const progress = progressView(enginePlan, exposures, elapsedDays);
  const horizon = progress.exposuresReached && progress.minDaysReached;
  const warnings: string[] = [];
  let conversions: readonly number[] = plan.armKeys.map(() => 0);
  if (horizon) {
    conversions = await loadConversions();
    if (conversions.length !== plan.armKeys.length) throw new ExperimentStatsError("one conversion count per arm");
  }
  const arms: ArmCounts[] = plan.armKeys.map((key, i) => {
    const units = exposures[i]!;
    let c = conversions[i]!;
    if (c > units) {
      // A conversion without a recorded exposure (a lost event): never more converts than exposed units.
      warnings.push(`conversions_exceed_exposures:${key}`);
      c = units;
    }
    return { key, units, conversions: c };
  });
  return { view: evaluateExperiment(enginePlan, { arms, elapsedDays }), arms, warnings };
}

// ---------------------------------------------------------------------------------------------
// The results view (a WHITELIST)
// ---------------------------------------------------------------------------------------------

export interface ProgressDto {
  perArm: Array<{ key: string; exposures: Count; target: number; fraction: number | null }>;
  elapsedDays: number;
  minDays: number;
  maxDays: number;
  exposuresReached: boolean;
  minDaysReached: boolean;
}
export interface SrmDto { evaluable: boolean; mismatch: boolean; message: string }

export interface AnalysisDto {
  control: { key: string; units: Count; conversions: Count; rate: number | null };
  comparisons: Array<{
    key: string; units: Count; conversions: Count; rate: number | null; difference: number; ciLower: number; ciUpper: number; ciLevel: number;
    method: "z" | "fisher"; pRaw: number; pAdjusted: number; significantWinner: boolean;
  }>;
  decision: { action: "ship"; arm: string } | { action: "keep_control"; reason: string };
  alpha: number;
}

export type ResultsDto =
  | {
      state: "ok"; phase: "collecting" | "inconclusive"; horizonReached: false; progress: ProgressDto; srm: SrmDto;
      decision?: { action: "keep_control"; reason: string }; warnings: string[];
    }
  | { state: "ok"; phase: "horizon"; horizonReached: true; progress: ProgressDto; srm: SrmDto; analysis: AnalysisDto; warnings: string[] };

export function progressDto(p: ReturnType<typeof progressView>): ProgressDto {
  return {
    perArm: p.perArm.map((a) => ({
      key: a.key,
      exposures: suppressCount(a.exposures),
      target: a.target,
      fraction: a.exposures < SMALL_CELL ? null : Math.round(a.fraction * 1000) / 1000,
    })),
    elapsedDays: p.elapsedDays, minDays: p.minDays, maxDays: p.maxDays,
    exposuresReached: p.exposuresReached, minDaysReached: p.minDaysReached,
  };
}

/** The SRM verdict in words. The chi-square and its p stay inside the engine: they are an outcome-adjacent number before the horizon. */
export function srmDto(s: { evaluable: boolean; mismatch: boolean }): SrmDto {
  return {
    evaluable: s.evaluable,
    mismatch: s.mismatch,
    message: !s.evaluable
      ? "No exposures yet, so the arm shares cannot be checked."
      : s.mismatch
        ? "Sample ratio mismatch: the arms are not receiving visitors in the planned proportions. This is a data-quality alarm about the site's assignment, not a result. Do not trust any outcome until it is explained."
        : "The arms are receiving visitors in the planned proportions.",
  };
}

const rateOf = (conversions: number, units: number): number | null =>
  conversions < SMALL_CELL || units <= 0 ? null : conversions / units;

function analysisDto(a: HorizonAnalysis): AnalysisDto {
  return {
    control: { key: a.control.key, units: suppressCount(a.control.units), conversions: suppressCount(a.control.conversions), rate: rateOf(a.control.conversions, a.control.units) },
    comparisons: a.comparisons.map((c) => ({
      key: c.key, units: suppressCount(c.units), conversions: suppressCount(c.conversions), rate: rateOf(c.conversions, c.units),
      difference: c.difference, ciLower: c.ciLower, ciUpper: c.ciUpper, ciLevel: c.ciLevel, method: c.method,
      pRaw: c.pRaw, pAdjusted: c.pAdjusted, significantWinner: c.significantWinner,
    })),
    decision: a.decision.action === "ship" ? { action: "ship", arm: a.decision.arm } : { action: "keep_control", reason: a.decision.reason },
    alpha: a.alpha,
  };
}

/** The results the API returns. Built field by field: the pre-horizon branch cannot reach an outcome. */
export function toResultsDto(view: ExperimentView, warnings: string[] = []): ResultsDto {
  const progress = progressDto(view.progress);
  const srm = srmDto(view.srm);
  if (view.phase === "horizon") {
    return { state: "ok", phase: "horizon", horizonReached: true, progress, srm, analysis: analysisDto(view.analysis), warnings };
  }
  return {
    state: "ok", phase: view.phase, horizonReached: false, progress, srm, warnings,
    ...(view.decision ? { decision: { action: "keep_control" as const, reason: view.decision.reason } } : {}),
  };
}

/** What the decision snapshot stores about the arms: ids and counts only. */
export function countsForSnapshot(arms: readonly ArmCounts[]): Array<{ key: string; units: number; conversions: number }> {
  return arms.map((a) => ({ key: a.key, units: a.units, conversions: a.conversions }));
}
