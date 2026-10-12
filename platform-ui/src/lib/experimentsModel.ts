// M5-V5-d — Website → Analytics → Experiments: the shapes of platform-nest's A/B experiments API (V5-c,
// docs/FRONTEND-BFF-CONTRACT.md §28e), a STRICT parser, and every sentence the tab says. Pure: no server-only imports.
//
// Rules the tab rests on (design §5.4, the stopping rule):
//   * Before the horizon the view shows PROGRESS and the sample-ratio check ONLY. `parseResults` keeps nothing else from a
//     pre-horizon body, so a rate, difference, interval or p that was present anyway cannot reach a component.
//   * A count under 5 arrives as "<5" and is said as "fewer than 5"; a rate that is null is said in words, never 0.
//   * `unavailable` (and not started / aborted) is a state with words, never zeros.
//   * Every refusal token is a plain sentence (`refusalWords`); a raw token or error text is never shown.

export class ExperimentShapeError extends Error {}

export type Status = "draft" | "running" | "stopped" | "aborted" | "decided";
export const STATUSES: readonly Status[] = ["draft", "running", "stopped", "aborted", "decided"];
export type Count = number | "<5";

export interface Experiment {
  id: string;
  propertyId: string;
  key: string;
  status: Status;
  hypothesis: string;
  item: { tenantSlug: string; siteId: string; itemId: string; collectionKey: string; locale: string };
  sectionId: string;
  goal: { event: string; match?: Record<string, string> };
  arms: Array<{ key: string; weight: number }>;
  enrolment: string;
  preRegistration: {
    baselineRate: number; baselineSource: string; relativeMde: number; alpha: number; power: number;
    nPerArm: number; dailyUnits: number; projectedDays: number; locked: boolean;
  };
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

export interface Progress {
  perArm: Array<{ key: string; exposures: Count; target: number; fraction: number | null }>;
  elapsedDays: number; minDays: number; maxDays: number; exposuresReached: boolean; minDaysReached: boolean;
}
export interface Srm { evaluable: boolean; mismatch: boolean; message: string }
export interface Analysis {
  control: { key: string; units: Count; conversions: Count; rate: number | null };
  comparisons: Array<{
    key: string; units: Count; conversions: Count; rate: number | null; difference: number; ciLower: number; ciUpper: number;
    ciLevel: number; pAdjusted: number; significantWinner: boolean;
  }>;
  decision: { action: "ship"; arm: string } | { action: "keep_control"; reason: string };
}
export type Decided = { decision: Record<string, unknown> | null; decidedAt: string; note: string | null };

export type Results =
  | { state: "not_started" | "aborted"; message: string }
  | { state: "unavailable"; reason: string; message: string }
  // Before the horizon: progress and SRM only. There is no field here a rate could live in.
  | { state: "ok"; horizonReached: false; phase: "collecting" | "inconclusive"; progress: Progress; srm: Srm; warnings: string[]; inconclusive: boolean }
  | { state: "ok"; horizonReached: true; phase: "horizon"; progress: Progress; srm: Srm; warnings: string[]; analysis: Analysis; decided: Decided | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown, at: string): Record<string, unknown> => { if (!isObj(v)) throw new ExperimentShapeError(`${at}: expected an object`); return v; };
const str = (v: unknown, at: string): string => { if (typeof v !== "string") throw new ExperimentShapeError(`${at}: expected a string`); return v; };
const strN = (v: unknown, at: string): string | null => (v === null || v === undefined ? null : str(v, at));
const num = (v: unknown, at: string): number => { if (typeof v !== "number" || !Number.isFinite(v)) throw new ExperimentShapeError(`${at}: expected a number`); return v; };
const numN = (v: unknown, at: string): number | null => (v === null || v === undefined ? null : num(v, at));
const bool = (v: unknown, at: string): boolean => { if (typeof v !== "boolean") throw new ExperimentShapeError(`${at}: expected true or false`); return v; };
const arr = (v: unknown, at: string): unknown[] => { if (!Array.isArray(v)) throw new ExperimentShapeError(`${at}: expected a list`); return v; };
const count = (v: unknown, at: string): Count => (v === "<5" ? "<5" : num(v, at));

export function parseExperiment(v: unknown, at = "experiment"): Experiment {
  const o = obj(v, at);
  const status = str(o.status, `${at}.status`);
  if (!(STATUSES as readonly string[]).includes(status)) throw new ExperimentShapeError(`${at}.status: unknown status`);
  const item = obj(o.item, `${at}.item`);
  const goal = obj(o.goal, `${at}.goal`);
  const pre = obj(o.preRegistration, `${at}.preRegistration`);
  return {
    id: str(o.id, `${at}.id`), propertyId: str(o.propertyId, `${at}.propertyId`), key: str(o.key, `${at}.key`), status: status as Status,
    hypothesis: str(o.hypothesis, `${at}.hypothesis`),
    item: {
      tenantSlug: str(item.tenantSlug, `${at}.item.tenantSlug`), siteId: str(item.siteId, `${at}.item.siteId`), itemId: str(item.itemId, `${at}.item.itemId`),
      collectionKey: str(item.collectionKey, `${at}.item.collectionKey`), locale: str(item.locale, `${at}.item.locale`),
    },
    sectionId: str(o.sectionId, `${at}.sectionId`),
    goal: { event: str(goal.event, `${at}.goal.event`), ...(isObj(goal.match) ? { match: goal.match as Record<string, string> } : {}) },
    arms: arr(o.arms, `${at}.arms`).map((a, i) => { const x = obj(a, `${at}.arms[${i}]`); return { key: str(x.key, `${at}.arms[${i}].key`), weight: num(x.weight, `${at}.arms[${i}].weight`) }; }),
    enrolment: str(o.enrolment, `${at}.enrolment`),
    preRegistration: {
      baselineRate: num(pre.baselineRate, `${at}.preRegistration.baselineRate`), baselineSource: str(pre.baselineSource, `${at}.preRegistration.baselineSource`),
      relativeMde: num(pre.relativeMde, `${at}.preRegistration.relativeMde`), alpha: num(pre.alpha, `${at}.preRegistration.alpha`), power: num(pre.power, `${at}.preRegistration.power`),
      nPerArm: num(pre.nPerArm, `${at}.preRegistration.nPerArm`), dailyUnits: num(pre.dailyUnits, `${at}.preRegistration.dailyUnits`),
      projectedDays: num(pre.projectedDays, `${at}.preRegistration.projectedDays`), locked: bool(pre.locked, `${at}.preRegistration.locked`),
    },
    startedAt: strN(o.startedAt, `${at}.startedAt`), stoppedAt: strN(o.stoppedAt, `${at}.stoppedAt`), createdAt: str(o.createdAt, `${at}.createdAt`),
  };
}

/** `GET …/experiments` — the SERVER's order is kept (newest first); nothing here sorts. */
export function parseExperimentList(body: unknown): Experiment[] {
  const o = obj(body, "experiments");
  return arr(o.experiments, "experiments.experiments").map((e, i) => parseExperiment(e, `experiments[${i}]`));
}
export const parseExperimentBody = (body: unknown): Experiment => parseExperiment(obj(body, "body").experiment);

function parseProgress(v: unknown): Progress {
  const p = obj(v, "progress");
  return {
    perArm: arr(p.perArm, "progress.perArm").map((a, i) => {
      const x = obj(a, `progress.perArm[${i}]`);
      return { key: str(x.key, "progress.perArm.key"), exposures: count(x.exposures, "progress.perArm.exposures"), target: num(x.target, "progress.perArm.target"), fraction: numN(x.fraction, "progress.perArm.fraction") };
    }),
    elapsedDays: num(p.elapsedDays, "progress.elapsedDays"), minDays: num(p.minDays, "progress.minDays"), maxDays: num(p.maxDays, "progress.maxDays"),
    exposuresReached: bool(p.exposuresReached, "progress.exposuresReached"), minDaysReached: bool(p.minDaysReached, "progress.minDaysReached"),
  };
}
function parseSrm(v: unknown): Srm {
  const s = obj(v, "srm");
  return { evaluable: bool(s.evaluable, "srm.evaluable"), mismatch: bool(s.mismatch, "srm.mismatch"), message: str(s.message, "srm.message") };
}
function parseAnalysis(v: unknown): Analysis {
  const a = obj(v, "analysis");
  const c = obj(a.control, "analysis.control");
  const d = obj(a.decision, "analysis.decision");
  const decision: Analysis["decision"] = d.action === "ship"
    ? { action: "ship", arm: str(d.arm, "analysis.decision.arm") }
    : { action: "keep_control", reason: str(d.reason, "analysis.decision.reason") };
  return {
    control: { key: str(c.key, "control.key"), units: count(c.units, "control.units"), conversions: count(c.conversions, "control.conversions"), rate: numN(c.rate, "control.rate") },
    comparisons: arr(a.comparisons, "analysis.comparisons").map((x, i) => {
      const o = obj(x, `comparisons[${i}]`);
      return {
        key: str(o.key, "comparison.key"), units: count(o.units, "comparison.units"), conversions: count(o.conversions, "comparison.conversions"), rate: numN(o.rate, "comparison.rate"),
        difference: num(o.difference, "comparison.difference"), ciLower: num(o.ciLower, "comparison.ciLower"), ciUpper: num(o.ciUpper, "comparison.ciUpper"),
        ciLevel: num(o.ciLevel, "comparison.ciLevel"), pAdjusted: num(o.pAdjusted, "comparison.pAdjusted"), significantWinner: bool(o.significantWinner, "comparison.significantWinner"),
      };
    }),
    decision,
  };
}

/** The results body. WHITELIST: a pre-horizon body is reduced to progress, SRM, warnings and the phase. */
export function parseResults(body: unknown): Results {
  const o = obj(body, "results");
  const state = str(o.state, "results.state");
  if (state === "not_started" || state === "aborted") return { state, message: typeof o.message === "string" ? o.message : "" };
  if (state === "unavailable") return { state: "unavailable", reason: str(o.reason, "results.reason"), message: typeof o.message === "string" ? o.message : "" };
  if (state !== "ok") throw new ExperimentShapeError("results.state: unknown state");
  const warnings = Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === "string") : [];
  const progress = parseProgress(o.progress);
  const srm = parseSrm(o.srm);
  // The horizon is reached only when BOTH the flag and the phase say so; anything else is treated as before it.
  if (o.horizonReached === true && o.phase === "horizon") {
    const decided = isObj(o.decided)
      ? { decision: isObj(o.decided.decision) ? o.decided.decision : null, decidedAt: str(o.decided.decidedAt, "decided.decidedAt"), note: strN(o.decided.note, "decided.note") }
      : null;
    return { state: "ok", horizonReached: true, phase: "horizon", progress, srm, warnings, analysis: parseAnalysis(o.analysis), decided };
  }
  const phase = o.phase === "inconclusive" ? "inconclusive" : "collecting";
  return { state: "ok", horizonReached: false, phase, progress, srm, warnings, inconclusive: phase === "inconclusive" };
}

// ───────────────────────────── words ─────────────────────────────

export const STATUS_WORDS: Record<Status, string> = {
  draft: "Draft: registered, not live yet",
  running: "Running",
  stopped: "Stopped: waiting for the decision",
  aborted: "Aborted: no result",
  decided: "Decided",
};

export const fmtCount = (c: Count): string => (c === "<5" ? "fewer than 5" : String(c));
export const fmtPct = (r: number, digits = 1): string => `${(r * 100).toFixed(digits)}%`;
export const fmtPctPoints = (d: number): string => `${d >= 0 ? "+" : "-"}${Math.abs(d * 100).toFixed(1)} points`;
export const armName = (key: string, control = "a"): string => (key === control ? `Control (${key})` : `Variant ${key}`);

export const GOAL_WORDS: Record<string, string> = {
  generate_lead: "a form is sent", lead_form_start: "a form is started", cta_click: "a button is clicked", click_whatsapp: "WhatsApp is tapped",
  click_phone: "the phone number is tapped", click_email: "the email address is tapped", section_view: "the section is seen",
};
export const goalWords = (event: string): string => GOAL_WORDS[event] ?? event;

export type Actions = { sync: boolean; stop: boolean; abort: boolean; decide: boolean };
/** Which actions a status allows. The API still refuses the rest; this only keeps buttons off the page. */
export function actionsFor(status: Status, canUpdate: boolean): Actions {
  if (!canUpdate) return { sync: false, stop: false, abort: false, decide: false };
  return {
    sync: status === "draft",
    stop: status === "running",
    abort: status === "draft" || status === "running" || status === "stopped",
    decide: status === "stopped",
  };
}

type Existing = Record<string, unknown> | undefined;
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A refusal token as one plain sentence. Unknown tokens get a generic sentence; the raw token is never shown. */
export function refusalWords(token: string | undefined, status: number, existing?: Existing): string {
  switch (token) {
    case "underpowered": {
      const days = asNum(existing?.projectedDays);
      const max = asNum(existing?.maxDays) ?? 56;
      return days === null
        ? `This test cannot be run: the section had no visitors in the last 28 days, so there is nothing to project. A test may run for at most ${max} days.`
        : `This test would need about ${days} days at the section's recent traffic, and a test may run for at most ${max} days. Aim for a bigger change, a section with more visitors, or a goal that happens more often.`;
    }
    case "too_many_running": return "This site already has 10 tests in draft or running. Abort or finish one first.";
    case "pre_registration_locked": return "The plan cannot change once the test has started. Abort it and register a new test.";
    case "horizon_not_reached": return "The test has not reached its planned size yet, so it cannot be stopped. Looking early would spoil the result. Abort it instead if you must end it now.";
    case "experiment_still_live": return "The test block is still live on the page. Publish its removal first (or the winner merged in), then record the decision.";
    case "plan_mismatch": return "The live page does not match the registered plan, so the test was not started.";
    case "not_stopped": return "Only a stopped test can be decided. Stop it at its planned size first.";
    case "not_running": return "The test is not running.";
    case "experiment_closed": return "This test is closed and cannot be started.";
    case "already_decided": return "This test has already been decided.";
    case "key_taken": return "Another test on this site already uses that key. Pick a different one.";
    case "item_already_registered": return "This page already has a test in draft or running. Abort it first.";
    case "item_already_has_experiment": return "The live page already has a test block, so a test cannot be registered for it now.";
    case "item_not_found": return "WebDesk has no such page on this site. Check the page id.";
    case "item_deleted": return "That page is deleted.";
    case "mde_out_of_range": return "The change you want to detect is outside the range a test can honestly check.";
    case "mde_invalid": return "The change to detect must be above 0% and at most 500%.";
    case "baseline_unavailable": return "The section had no views in the last 28 days, so no starting rate can be suggested. Enter the current rate yourself.";
    case "baseline_rate_invalid": return "The current rate must be above 0% and below 100%.";
    case "key_invalid": return "The key must be 1 to 64 letters, digits or . _ : - characters.";
    case "hypothesis_required": return "Write what you expect to happen and why.";
    case "webdesk_invalid": return "The page ids are not valid. Check the page id.";
    case "section_id_invalid": return "The section id is not valid.";
    case "arms_invalid": return "The shares must be whole numbers of at least 10 and add up to 100.";
    case "enrolment_all_not_enabled": return "Only visitors who accepted analytics can be enrolled for now.";
    case "analytics_not_bound": case "analytics_not_configured": return "Website analytics is not linked to this site yet, so visitors cannot be counted.";
    case "analytics_unreachable": return "Website analytics could not be reached. Nothing was changed. Try again in a moment.";
    case "analytics_rejected": return "Website analytics refused the request. Nothing was changed.";
    default: break;
  }
  if (token && token.startsWith("goal_")) return "The goal is not valid. Pick one of the listed goals.";
  if (status === 403) return "You do not have permission to change tests here.";
  if (status === 404) return "That test or site was not found.";
  if (status === 409) return "The test is not in a state that allows this. Reload the page and look at its status.";
  if (status === 422) return "The test could not be registered as entered.";
  if (status === 503) return "A service this needs is not available right now. Nothing was changed. Try again in a moment.";
  return "Something went wrong. Nothing was changed. Try again in a moment.";
}

export const SYNC_WORDS: Record<string, string> = {
  started: "The test is live on the page. It is now running.",
  already_running: "The test was already running.",
  not_live: "The test block is not live on the page yet. Publish the page, then check again.",
  plan_mismatch: refusalWords("plan_mismatch", 200),
};
const DIFF_WORDS: Record<string, string> = { key: "the key", target: "the block", enrolment: "who is enrolled", goal: "the goal", arms: "the shares" };
export const diffWords = (d: string[]): string => (d.length === 0 ? "" : ` It differs in ${d.map((x) => DIFF_WORDS[x] ?? x).join(", ")}.`);

export const UNAVAILABLE_WORDS: Record<string, string> = {
  not_configured: "Website analytics is not set up on this server yet, so visitors cannot be counted. Nothing is shown rather than zeros.",
  not_bound: "This site is not linked to a website in analytics yet, so visitors cannot be counted. Nothing is shown rather than zeros.",
  unreachable: "Website analytics could not be reached. Nothing is shown rather than zeros. Try again in a moment.",
  rejected: "Website analytics refused the request. Nothing is shown rather than zeros.",
  truncated: "Website analytics returned too much to count safely. Nothing is shown rather than a partial count.",
};
export const unavailableWords = (reason: string): string => UNAVAILABLE_WORDS[reason] ?? "The numbers are not available right now. Nothing is shown rather than zeros.";

export function decisionWords(d: Analysis["decision"]): string {
  if (d.action === "ship") return `Ship variant ${d.arm}. It beat the control by more than chance.`;
  return d.reason === "no_significant_winner"
    ? "Keep the control. No variant beat it by more than chance."
    : "Keep the control.";
}

// ───────────────────────────── the register form ─────────────────────────────

export interface RegisterForm {
  key: string; hypothesis: string; itemId: string; sectionId: string; goalEvent: string; goalMatchKey: string; goalMatchValue: string;
  /** percent, e.g. "3" for 3%; empty = suggest from the last 28 days */
  baselinePct: string;
  /** percent, e.g. "20" for +20% relative */
  mdePct: string;
  weightA: string; weightB: string;
}
export const EMPTY_FORM: RegisterForm = { key: "", hypothesis: "", itemId: "", sectionId: "", goalEvent: "generate_lead", goalMatchKey: "", goalMatchValue: "", baselinePct: "", mdePct: "20", weightA: "50", weightB: "50" };

/** The request body, or a sentence. Alpha and power are fixed by the API (0.05 and 0.8) and are never sent. */
export function buildRegistration(f: RegisterForm, scope: { tenantSlug: string; siteId: string }): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const key = f.key.trim(), hyp = f.hypothesis.trim(), item = f.itemId.trim(), section = f.sectionId.trim();
  if (!key) return { ok: false, message: "Give the test a key." };
  if (!hyp) return { ok: false, message: "Write what you expect to happen and why." };
  if (!item) return { ok: false, message: "Enter the id of the page the test runs on." };
  if (!section) return { ok: false, message: "Enter the id of the section being tested." };
  const mde = Number(f.mdePct);
  if (!Number.isFinite(mde) || mde <= 0 || mde > 500) return { ok: false, message: "The change to detect must be above 0% and at most 500%." };
  const wa = Number(f.weightA), wb = Number(f.weightB);
  if (!Number.isInteger(wa) || !Number.isInteger(wb) || wa < 10 || wb < 10 || wa + wb !== 100) return { ok: false, message: "The two shares must be whole numbers of at least 10 and add up to 100." };
  const body: Record<string, unknown> = {
    key, hypothesis: hyp, webdesk: { tenantSlug: scope.tenantSlug, siteId: scope.siteId, itemId: item }, sectionId: section,
    goal: f.goalMatchKey && f.goalMatchValue.trim() ? { event: f.goalEvent, match: { [f.goalMatchKey]: f.goalMatchValue.trim() } } : { event: f.goalEvent },
    arms: [{ key: "a", weight: wa }, { key: "b", weight: wb }],
    relativeMde: mde / 100,
  };
  if (f.baselinePct.trim()) {
    const b = Number(f.baselinePct);
    if (!Number.isFinite(b) || b <= 0 || b >= 100) return { ok: false, message: "The current rate must be above 0% and below 100%." };
    body.baselineRate = b / 100;
  }
  return { ok: true, body };
}
