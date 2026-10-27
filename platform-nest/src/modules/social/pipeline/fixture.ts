// SCP-1b — the stage-machine fixture, loaded, typed and validated (FRONTEND-BFF-CONTRACT §63.3).
//
// THE FIXTURE IS THE CONTRACT. `../scp-stage-machine.json` holds the statuses, the phases, the change cases, the
// holders, the engine-status mapping, every action with its from, to, Cerbos action, guards and effects, the edit
// rules, the hand-off checks and the refusal catalogue. Nothing in this directory may hard-code a value the fixture
// holds; the machine (`machine.ts`) and the hand-off checks (`handoff-checks.ts`) read them from `SCP` below.
// platform-ui keeps a byte-identical twin (`platform-ui/src/lib/scpStageMachine.json`), compared byte for byte by
// its own test (the clientHealthGolden.json pattern).
//
// HOW IT IS LOADED. The file is read with `readFileSync`, resolved from this module's directory, as the other
// fixture loaders here do (`client-health-rules.test.ts`, `mail/__fixtures__/inbound`). The production image runs
// from `dist/`, and `tsc` copies a JSON file into `dist/` only when a module imports it, so this module also carries
// a bare `import "../scp-stage-machine.json"` (the side-effect form: nothing is bound, the value is never used). That
// one line is what puts the file beside `dist/modules/social/` for the loader to find; without it the image would
// fail to boot with ENOENT. The text read here is the file's own bytes, which is what the validation and the tests
// judge.
//
// VALIDATED AT LOAD. A fixture that names an unknown status, change case, Cerbos action or refusal code, or whose
// change cases differ from the six the database CHECK allows (BFF §63.1, the social_posts CHECKs), refuses to load:
// `parseScpFixture` throws with every problem at once. A wrong fixture must fail the boot and the suite, never
// half-run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Emits the fixture into dist/ (see the header). Side-effect only: the loader below reads the file's text.
import "../scp-stage-machine.json";

// ── Types (only the shape; every value comes from the file) ─────────────────────────────────────────────────────────

/** A `when` clause on a `to`, `setsChangeCase` or engine-status override. Its keys are interpreted by the machine. */
export type ScpWhen = Record<string, string | boolean>;

export interface ScpFromEntry {
  status: string;
  /** Present only with status `changes`: the change cases this action accepts. Absent: every change case. */
  changeCase?: string[];
  /** Prose ("this contact"); enforced by the action's `own_decision` guard, not by the status check. */
  decidedBy?: string;
}

export interface ScpGuard {
  guard: string;
  refusal: string;
}

export type ScpTo =
  | string
  | null
  | Array<{ when: ScpWhen; status: string }>
  | { from: string };

export interface ScpAction {
  action: string;
  kind?: "create" | "edit";
  /** A key of `cerbosActions`, or (unschedule) a map from `scheduleVia` to one. */
  cerbosAction: string | Record<string, string>;
  /** create: `{anyOf: [...]}`; reschedule: a map from `scheduleVia` to the extra actions it needs. */
  extraCerbos?: { anyOf: string[] } | Record<string, string[]>;
  extraCerbosRefusal?: string;
  actors: string[] | Record<string, string[]>;
  from: ScpFromEntry[];
  to: ScpTo;
  setsChangeCase?: string | Array<{ when: ScpWhen; changeCase: string }>;
  params: Record<string, string>;
  guards: ScpGuard[];
  effects: string[];
  plan: string;
}

export interface ScpChangeCase {
  key: string;
  changeBy: string;
  changeKind: string;
  returnTo: string;
  phase: string;
  holder: string;
  setBy: string[];
}

export interface ScpCommonGuard {
  order: number;
  guard: string;
  refusal?: string;
  http?: number;
  outcome?: string;
  appliesTo?: string[];
  note?: string;
}

export interface ScpEditRule {
  status: string;
  changeCases?: string[];
  fieldGroups: string[];
  alsoFields?: string[];
  copyLog?: boolean;
  refusal?: string;
  note?: string;
}

export interface ScpCheck {
  code: string;
  rule: string;
}

export interface ScpRefusal {
  http: number;
  with?: string;
  shape?: string;
  route?: string;
  new?: boolean;
}

export interface ScpCerbosAction {
  actors: string[];
  refusal: string;
}

export interface ScpScenarioStep {
  action: string;
  actor: string;
  params?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  refusal?: string;
  refusalHttp?: number;
  field?: string;
  expectedStatus?: string;
  target?: string;
  note?: string;
  precondition?: string;
}

export interface ScpScenario {
  name: string;
  loop?: string;
  creativeSource?: string;
  start?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  steps: ScpScenarioStep[];
}

export interface ScpSubMachineAction {
  action: string;
  cerbosAction: string;
  actors: string[];
  from?: string[];
  to?: unknown;
  guards?: ScpGuard[];
  refusals?: string[];
  [k: string]: unknown;
}

export interface ScpFixture {
  _about: string;
  version: number;
  rulings: string;
  statuses: string[];
  blockableStatuses: string[];
  pseudoTargets: Record<string, string>;
  portalStatusRefusal: string;
  phases: Array<{ key: string; label: string }>;
  phaseOf: Record<string, string>;
  changeCases: ScpChangeCase[];
  phaseRule: string;
  engineStatus: {
    byPipelineStatus: Record<string, string>;
    overrides: Array<{ when: ScpWhen; engineStatus: string }>;
    rule: string;
  };
  holders: Record<string, string | null>;
  primaryAction: Record<string, string | Record<string, string>>;
  actors: Record<string, string>;
  cerbosActions: Record<string, ScpCerbosAction>;
  fieldGroups: Record<string, string[]>;
  editRules: ScpEditRule[];
  requiredToSend: ScpCheck[];
  handoffChecks: ScpCheck[];
  handoffCheckRule: string;
  commonGuards: ScpCommonGuard[];
  actions: ScpAction[];
  systemRules: Array<{ rule: string; when: string; then: string; plan: string }>;
  boosts: { statuses: string[]; actions: ScpSubMachineAction[]; [k: string]: unknown };
  boostBudgets: { statuses: string[]; actions: ScpSubMachineAction[]; [k: string]: unknown };
  reports: {
    statuses: Array<{ status: string; label: string }>;
    actions: ScpSubMachineAction[];
    refusals: Record<string, ScpRefusal>;
    [k: string]: unknown;
  };
  refusals: Record<string, ScpRefusal>;
  scenarioPersonas: Record<string, string>;
  scenarios: ScpScenario[];
}

// ── What the fixture is checked against (the contract, not the fixture) ────────────────────────────────────────────

/** BFF §63.1, the social_posts CHECK "the six change cases only": `(change_by, change_kind, return_to) IN (…)`. The
 *  fixture's `changeCases` must cover exactly these, so the machine can never write a row the database refuses. */
export const CONTRACT_CHANGE_CASE_TUPLES: ReadonlyArray<readonly [string, string, string]> = [
  ["copywriter", "copy", "proofread"],
  ["hod", "copy", "hod"],
  ["final", "copy", "final"],
  ["final", "design", "final"],
  ["client", "copy", "proofread"],
  ["client", "design", "final"],
];

/** The `scheduleVia` values (BFF §63.1 `schedule_via`: `manual|publisher`), the keys of unschedule's per-route Cerbos
 *  action and reschedule's `extraCerbos`. */
export const SCHEDULE_VIA_VALUES = ["manual", "publisher"] as const;

/** The keys a `from` entry may carry. */
const FROM_KEYS = new Set(["status", "changeCase", "decidedBy"]);

/** A refusal written as one code token (as opposed to the prose some catalogue rows carry). */
export const isCodeToken = (s: unknown): s is string => typeof s === "string" && /^[a-z][a-z0-9_]*$/.test(s);

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────────────────

const sameSet = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every structural problem with the fixture, as readable lines. Empty means valid. Pure. */
export function validateScpFixture(f: ScpFixture): string[] {
  const problems: string[] = [];
  const p = (msg: string) => problems.push(msg);

  if (!Array.isArray(f.statuses) || f.statuses.length === 0) {
    return ["statuses must be a non-empty array"];
  }
  const statuses = new Set(f.statuses);
  if (statuses.size !== f.statuses.length) p("statuses has duplicates");
  for (const s of f.blockableStatuses ?? []) if (!statuses.has(s)) p(`blockableStatuses names unknown status '${s}'`);

  // Every status in each per-status table, and no table naming an unknown one.
  const perStatus: Array<[string, Record<string, unknown> | undefined]> = [
    ["phaseOf", f.phaseOf],
    ["holders", f.holders],
    ["engineStatus.byPipelineStatus", f.engineStatus?.byPipelineStatus],
    ["primaryAction", f.primaryAction],
  ];
  for (const [name, table] of perStatus) {
    if (!isObject(table)) {
      p(`${name} is missing`);
      continue;
    }
    for (const s of f.statuses) if (!(s in table)) p(`${name} has no entry for status '${s}'`);
    for (const k of Object.keys(table)) if (!statuses.has(k)) p(`${name} names unknown status '${k}'`);
  }

  const phaseKeys = new Set((f.phases ?? []).map((ph) => ph.key));
  for (const [s, ph] of Object.entries(f.phaseOf ?? {})) {
    if (s !== "changes" && !phaseKeys.has(ph)) p(`phaseOf.${s} names unknown phase '${ph}'`);
  }

  // The change cases: exactly the six of the database CHECK.
  const caseKeys = new Set<string>();
  for (const c of f.changeCases ?? []) {
    if (caseKeys.has(c.key)) p(`changeCases has duplicate key '${c.key}'`);
    caseKeys.add(c.key);
    if (!phaseKeys.has(c.phase)) p(`changeCases.${c.key}.phase names unknown phase '${c.phase}'`);
    if (!statuses.has(c.returnTo)) p(`changeCases.${c.key}.returnTo names unknown status '${c.returnTo}'`);
    if (!(c.holder in (f.actors ?? {}))) p(`changeCases.${c.key}.holder names unknown actor '${c.holder}'`);
  }
  const tuple = (a: string, b: string, c: string) => `${a}/${b}/${c}`;
  const fixtureTuples = (f.changeCases ?? []).map((c) => tuple(c.changeBy, c.changeKind, c.returnTo));
  const contractTuples = CONTRACT_CHANGE_CASE_TUPLES.map(([a, b, c]) => tuple(a, b, c));
  if (new Set(fixtureTuples).size !== fixtureTuples.length) p("changeCases repeat a (changeBy, changeKind, returnTo)");
  if (!sameSet(fixtureTuples, contractTuples)) {
    p(`changeCases (${[...fixtureTuples].sort().join(", ")}) differ from the contract CHECK's six (${[...contractTuples].sort().join(", ")})`);
  }

  // Holders name actors (the prose ones are interpreted by the machine).
  for (const [s, h] of Object.entries(f.holders ?? {})) {
    if (h === null) continue;
    if (!(h in (f.actors ?? {})) && !h.includes(" ")) p(`holders.${s} names unknown actor '${h}'`);
  }

  // The refusal catalogue.
  const refusals = f.refusals ?? {};
  const reportRefusals = f.reports?.refusals ?? {};
  const knownRefusal = (code: string) => code in refusals || code in reportRefusals;
  for (const [code, r] of Object.entries(refusals)) {
    if (!isCodeToken(code)) p(`refusals key '${code}' is not a code token`);
    if (typeof r?.http !== "number") p(`refusals.${code}.http is not a number`);
  }

  // Cerbos actions: the code-token refusals are catalogued.
  const cerbos = f.cerbosActions ?? {};
  for (const [name, c] of Object.entries(cerbos)) {
    if (isCodeToken(c.refusal) && !knownRefusal(c.refusal)) p(`cerbosActions.${name}.refusal '${c.refusal}' is not in refusals`);
  }
  const knownCerbos = (a: unknown) => typeof a === "string" && a in cerbos;

  // Engine-status overrides.
  for (const [i, o] of (f.engineStatus?.overrides ?? []).entries()) {
    for (const k of Object.keys(o.when ?? {})) {
      if (!["archived", "pipelineStatus", "anyVariantStatus"].includes(k)) p(`engineStatus.overrides[${i}].when has unknown key '${k}'`);
    }
    if (o.when?.pipelineStatus !== undefined && !statuses.has(String(o.when.pipelineStatus))) {
      p(`engineStatus.overrides[${i}] names unknown status '${String(o.when.pipelineStatus)}'`);
    }
  }

  // Actions.
  const actionNames = new Set<string>();
  for (const a of f.actions ?? []) {
    const at = `actions.${a.action}`;
    if (actionNames.has(a.action)) p(`${at} is duplicated`);
    actionNames.add(a.action);

    if (typeof a.cerbosAction === "string") {
      if (!knownCerbos(a.cerbosAction)) p(`${at}.cerbosAction '${a.cerbosAction}' is not a known Cerbos action`);
    } else if (isObject(a.cerbosAction)) {
      for (const [via, ca] of Object.entries(a.cerbosAction)) {
        if (!(SCHEDULE_VIA_VALUES as readonly string[]).includes(via)) p(`${at}.cerbosAction has unknown scheduleVia key '${via}'`);
        if (!knownCerbos(ca)) p(`${at}.cerbosAction.${via} '${String(ca)}' is not a known Cerbos action`);
      }
      if (!sameSet(Object.keys(a.cerbosAction), SCHEDULE_VIA_VALUES)) p(`${at}.cerbosAction must name every scheduleVia value`);
    } else {
      p(`${at}.cerbosAction is neither a name nor a per-scheduleVia map`);
    }

    if (a.extraCerbos !== undefined) {
      const ex = a.extraCerbos as Record<string, unknown>;
      for (const [k, v] of Object.entries(ex)) {
        if (k !== "anyOf" && !(SCHEDULE_VIA_VALUES as readonly string[]).includes(k)) p(`${at}.extraCerbos has unknown key '${k}'`);
        if (!Array.isArray(v) || v.length === 0) p(`${at}.extraCerbos.${k} is not a non-empty list`);
        else for (const ca of v) if (!knownCerbos(ca)) p(`${at}.extraCerbos.${k} names unknown Cerbos action '${String(ca)}'`);
      }
    }
    if (a.extraCerbosRefusal !== undefined && !knownRefusal(a.extraCerbosRefusal)) {
      p(`${at}.extraCerbosRefusal '${a.extraCerbosRefusal}' is not in refusals`);
    }

    for (const [i, fr] of (a.from ?? []).entries()) {
      for (const k of Object.keys(fr)) if (!FROM_KEYS.has(k)) p(`${at}.from[${i}] has unknown key '${k}'`);
      if (!statuses.has(fr.status)) p(`${at}.from[${i}] names unknown status '${fr.status}'`);
      if (fr.changeCase !== undefined) {
        if (fr.status !== "changes") p(`${at}.from[${i}] names change cases on status '${fr.status}'`);
        for (const cc of fr.changeCase) if (!caseKeys.has(cc)) p(`${at}.from[${i}] names unknown change case '${cc}'`);
      }
    }

    const to = a.to;
    if (typeof to === "string") {
      if (!statuses.has(to) && !(to in (f.pseudoTargets ?? {}))) p(`${at}.to names unknown status '${to}'`);
    } else if (Array.isArray(to)) {
      for (const [i, t] of to.entries()) if (!statuses.has(t.status)) p(`${at}.to[${i}] names unknown status '${t.status}'`);
    } else if (isObject(to)) {
      if (!("from" in to)) p(`${at}.to is an object without 'from'`);
    } else if (to !== null) {
      p(`${at}.to has an unknown shape`);
    }

    const sc = a.setsChangeCase;
    if (typeof sc === "string") {
      if (!caseKeys.has(sc)) p(`${at}.setsChangeCase names unknown change case '${sc}'`);
    } else if (Array.isArray(sc)) {
      for (const [i, s] of sc.entries()) if (!caseKeys.has(s.changeCase)) p(`${at}.setsChangeCase[${i}] names unknown change case '${s.changeCase}'`);
    }

    for (const g of a.guards ?? []) {
      if (!knownRefusal(g.refusal)) p(`${at}.guards.${g.guard}.refusal '${g.refusal}' is not in refusals`);
    }
  }

  // Every change case's `setBy` names actions (the prose suffix "while changedOnly" aside).
  for (const c of f.changeCases ?? []) {
    for (const by of c.setBy) {
      const name = by.split(" ")[0];
      if (!actionNames.has(name)) p(`changeCases.${c.key}.setBy names unknown action '${name}'`);
    }
  }

  // primaryAction values name actions (the `design` prose is interpreted by the machine).
  for (const [s, v] of Object.entries(f.primaryAction ?? {})) {
    if (typeof v === "string") {
      if (!v.includes(" ") && !actionNames.has(v) && !(f.boosts?.actions ?? []).some((b) => b.action === v)) {
        p(`primaryAction.${s} names unknown action '${v}'`);
      }
    } else if (isObject(v)) {
      if (!sameSet(Object.keys(v), caseKeys)) p(`primaryAction.${s} must name every change case`);
      for (const [cc, an] of Object.entries(v)) if (!actionNames.has(an)) p(`primaryAction.${s}.${cc} names unknown action '${an}'`);
    }
  }

  // Common guards: in order 1..n, code-token refusals catalogued.
  for (const [i, g] of (f.commonGuards ?? []).entries()) {
    if (g.order !== i + 1) p(`commonGuards[${i}].order is ${g.order}, expected ${i + 1}`);
    if (g.refusal !== undefined && isCodeToken(g.refusal) && !knownRefusal(g.refusal)) {
      p(`commonGuards.${g.guard}.refusal '${g.refusal}' is not in refusals`);
    }
    for (const ap of g.appliesTo ?? []) if (!knownCerbos(ap)) p(`commonGuards.${g.guard}.appliesTo names unknown Cerbos action '${ap}'`);
  }

  // Edit rules.
  const groupNames = new Set(Object.keys(f.fieldGroups ?? {}));
  const allFields = new Set(Object.values(f.fieldGroups ?? {}).flat());
  for (const [i, r] of (f.editRules ?? []).entries()) {
    if (r.status !== "any other" && !statuses.has(r.status)) p(`editRules[${i}] names unknown status '${r.status}'`);
    for (const cc of r.changeCases ?? []) if (!caseKeys.has(cc)) p(`editRules[${i}] names unknown change case '${cc}'`);
    for (const g of r.fieldGroups) if (!groupNames.has(g)) p(`editRules[${i}] names unknown field group '${g}'`);
    for (const fld of r.alsoFields ?? []) if (!allFields.has(fld)) p(`editRules[${i}] names unknown field '${fld}'`);
    if (r.refusal !== undefined && !knownRefusal(r.refusal)) p(`editRules[${i}].refusal '${r.refusal}' is not in refusals`);
  }

  // Hand-off checks: unique codes.
  const checkCodes = [...(f.requiredToSend ?? []), ...(f.handoffChecks ?? [])].map((c) => c.code);
  if (new Set(checkCodes).size !== checkCodes.length) p("requiredToSend and handoffChecks repeat a code");

  // The other machines' guards and refusals are catalogued too.
  for (const sub of [f.boosts?.actions ?? [], f.boostBudgets?.actions ?? []]) {
    for (const a of sub) for (const g of a.guards ?? []) {
      if (!knownRefusal(g.refusal)) p(`${a.action}.guards.${g.guard}.refusal '${g.refusal}' is not in refusals`);
    }
  }
  for (const a of f.reports?.actions ?? []) for (const r of a.refusals ?? []) {
    if (!(r in reportRefusals)) p(`reports.${a.action}.refusals '${r}' is not in reports.refusals`);
  }

  // Scenarios name known actions and catalogued refusals.
  const allActions = new Set([
    ...actionNames,
    ...(f.boosts?.actions ?? []).map((a) => a.action),
    ...(f.boostBudgets?.actions ?? []).map((a) => a.action),
    ...(f.reports?.actions ?? []).map((a) => a.action),
  ]);
  const scenarioNames = new Set<string>();
  for (const sc of f.scenarios ?? []) {
    if (scenarioNames.has(sc.name)) p(`scenario '${sc.name}' is duplicated`);
    scenarioNames.add(sc.name);
    for (const [i, st] of sc.steps.entries()) {
      if (!allActions.has(st.action)) p(`scenario '${sc.name}' step ${i} names unknown action '${st.action}'`);
      if (st.refusal !== undefined && !knownRefusal(st.refusal)) p(`scenario '${sc.name}' step ${i} refusal '${st.refusal}' is not in refusals`);
    }
  }

  return problems;
}

/** Validate and return the fixture, or throw with every problem. */
export function parseScpFixture(raw: unknown): ScpFixture {
  if (!isObject(raw)) throw new Error("scp-stage-machine.json: not an object");
  const f = raw as unknown as ScpFixture;
  const problems = validateScpFixture(f);
  if (problems.length) {
    throw new Error(`scp-stage-machine.json is invalid (${problems.length}):\n  - ${problems.join("\n  - ")}`);
  }
  return f;
}

/** The fixture's path: beside this module's parent, `src/modules/social/` under vitest and `dist/modules/social/` in
 *  the image (where the side-effect import above puts it). */
export const SCP_FIXTURE_PATH = join(__dirname, "..", "scp-stage-machine.json");

/** Read the fixture file's text (its raw bytes, as UTF-8). */
export function readScpFixtureText(path: string = SCP_FIXTURE_PATH): string {
  return readFileSync(path, "utf8");
}

/** The loaded, validated fixture. Every reader in `pipeline/` uses this one object. */
export const SCP: ScpFixture = parseScpFixture(JSON.parse(readScpFixtureText()));

// ── Small lookups over the fixture ──────────────────────────────────────────────────────────────────────────────────

const ACTIONS_BY_NAME = new Map(SCP.actions.map((a) => [a.action, a]));
const CASES_BY_KEY = new Map(SCP.changeCases.map((c) => [c.key, c]));

export function scpAction(name: string): ScpAction | undefined {
  return ACTIONS_BY_NAME.get(name);
}

export function scpChangeCase(key: string): ScpChangeCase | undefined {
  return CASES_BY_KEY.get(key);
}

export function scpRefusalHttp(code: string): number | undefined {
  return SCP.refusals[code]?.http ?? SCP.reports.refusals[code]?.http;
}
