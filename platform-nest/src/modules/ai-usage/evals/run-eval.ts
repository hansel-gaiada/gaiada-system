// AIP-09 — the gateway tier eval: does the `fast` tier summarise and classify well enough to become a task's default?
//
// WHY. Ruling AIP-D1 maps every tier to the one live model (OpenRouter GLM 5.3 Flash), so the first run only records a BASELINE. The value is
// the harness and the gate rule below: when a second, cheaper model is put on `fast`, this eval decides whether `summarise` or `classify`
// may move to it. Prompts are the production ones (prompts.ts), the cases are synthetic mock text (cases.ts), the scoring is pure (score.ts).
//
// RUN IT (live box; the lead runs it after a deploy, never CI). The platform image compiles only `src/` and has no `tsx`:
//   docker exec gaiada-platform-1 node dist/modules/ai-usage/evals/run-eval.js --out /tmp/aip09.json
//   docker cp gaiada-platform-1:/tmp/aip09.json ./aip09-<date>.json          (keep it: it is the evidence)
// It uses the container's own GATEWAY_URL and GATEWAY_TOKEN. Dev checkout: `npx tsx scripts/ai-tier-eval.ts <same arguments>`.
// Arguments:
//   --tiers fast,standard        tiers to test (default both)
//   --task summarise|classify|all   task classes to run (default all)
//   --out <file.json>            write the full report, INCLUDING the model's text of every call (all inputs are mock). Nothing is written
//                                to any database, and the text is never printed or logged.
// Cost: 9 summarise + 10 classify cases = 19 calls per tier, 38 for the default run (hard stop of the design: under 60). Calls are
// sequential (one in flight), each with a 180 s timeout (the gateway's own per-provider timeout; long meeting prompts take up to ~130 s).
//
// VERDICTS, per tier and task class:
//   PASS     the class met its threshold (score.ts: SUMMARISE_MIN_PASS_RATE / CLASSIFY_MIN_ACCURACY) and no summary invented a fact.
//   FAIL     the answers were real and the tier applied, but the quality is below the threshold (or a fact was invented).
//   INVALID  the run did not test what it claims: the answer has no `tier` (the gateway did not apply the tier), it applied a different tier
//            than asked, the answer was the echo fallback, the gateway was unreachable or refused (HTTP error), or the run stopped early
//            (HTTP 429 = budget cap: it stops at the first one rather than burning the cap). INVALID is never a pass.
// EXIT CODE: 0 only when every class run for `fast` is PASS (with `fast` not in --tiers, every class run on the tiers given); 1 when a class
// FAILs; 2 when any class is INVALID (INVALID wins over FAIL: an unproven run proves nothing), and for bad arguments or no gateway config.
//
// THE GATE RULE. `summarise` or `classify` may be mapped to `fast` (GATEWAY_TASK_TIERS) only after a run in which THAT class is PASS on
// `fast`, with the run's JSON kept as evidence next to the change. Re-run after any change to the model behind `fast`, to a prompt in
// prompts.ts's sources, or to a threshold. Until a second model sits on `fast`, a PASS only proves the baseline.
import { writeFileSync } from "fs";
import { GATEWAY_TASKS, readGatewayTier, type GatewayTier } from "../routing";
import { readGatewayUsage } from "../gateway-usage";
import { CLASSIFY_CASES, SUMMARISE_CASES } from "./cases";
import { promptFor } from "./prompts";
import { classVerdict, scoreCase, type CaseResult, type ClassVerdict, type EvalCase, type TaskClass, type Verdict } from "./score";
import * as thresholds from "./score";

export const CALL_TIMEOUT_MS = 180_000;
export type EvalTier = Extract<GatewayTier, "fast" | "standard">;
const EVAL_TIERS: readonly EvalTier[] = ["fast", "standard"];
const EVAL_TASKS: readonly TaskClass[] = ["summarise", "classify"];
// Compile-time-ish guard that the eval's classes are real gateway classes.
for (const t of EVAL_TASKS) if (!(GATEWAY_TASKS as readonly string[]).includes(t)) throw new Error(`eval task ${t} is not a gateway task class`);

export interface CallRecord {
  caseId: string;
  task: TaskClass;
  requestedTier: EvalTier;
  status: CaseResult["status"];
  reasons: string[];
  score: number;
  httpStatus: number | null;
  provider: string | null;
  model: string | null;
  /** The tier the gateway says it applied; null when the answer had none (=> INVALID). */
  appliedTier: GatewayTier | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  /** The model's answer. Goes into the --out file only; never printed. */
  text: string | null;
}

export interface TierTaskSummary extends ClassVerdict {
  medianLatencyMs: number | null;
  medianTokens: number | null;
}

export interface EvalReport {
  startedAt: string;
  gatewayUrl: string;
  tiers: EvalTier[];
  tasks: TaskClass[];
  thresholds: Record<string, number>;
  stoppedEarly: string | null;
  calls: CallRecord[];
  verdicts: Record<string, Record<string, TierTaskSummary>>;
  exitCode: 0 | 1 | 2;
}

export interface RunDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  write?: (file: string, data: string) => void;
}

export interface ParsedArgs { tiers: EvalTier[]; tasks: TaskClass[]; out: string | null }

export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let tiers: EvalTier[] = [...EVAL_TIERS];
  let tasks: TaskClass[] = [...EVAL_TASKS];
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--tiers") {
      if (v === undefined) return { error: "--tiers needs a value (fast, standard or fast,standard)" };
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0 || parts.some((p) => !(EVAL_TIERS as readonly string[]).includes(p))) return { error: `--tiers must be a list of: ${EVAL_TIERS.join(", ")}` };
      tiers = [...new Set(parts)] as EvalTier[];
      i++;
    } else if (a === "--task") {
      if (v === undefined) return { error: "--task needs a value (summarise, classify or all)" };
      if (v === "all") tasks = [...EVAL_TASKS];
      else if ((EVAL_TASKS as readonly string[]).includes(v)) tasks = [v as TaskClass];
      else return { error: "--task must be summarise, classify or all" };
      i++;
    } else if (a === "--out") {
      if (v === undefined || v.startsWith("--")) return { error: "--out needs a file path" };
      out = v;
      i++;
    } else {
      return { error: `unknown argument ${a}` };
    }
  }
  return { tiers, tasks, out };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const casesFor = (task: TaskClass): readonly EvalCase[] => (task === "summarise" ? SUMMARISE_CASES : CLASSIFY_CASES);

const emptyRecord = (c: EvalCase, tier: EvalTier): CallRecord => ({
  caseId: c.id, task: c.task, requestedTier: tier, status: "invalid", reasons: [], score: 0, httpStatus: null, provider: null, model: null,
  appliedTier: null, latencyMs: null, promptTokens: null, completionTokens: null, costUsd: null, text: null,
});

/** One gateway call for one case. `stop` is set when the run must not continue (429, gateway unreachable). */
async function callOne(c: EvalCase, tier: EvalTier, url: string, token: string, fetchImpl: typeof fetch, now: () => number): Promise<{ rec: CallRecord; stop: string | null }> {
  const rec = emptyRecord(c, tier);
  const started = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${url}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: promptFor(c), task: c.task, tier }),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    rec.latencyMs = now() - started;
    const msg = ctl.signal.aborted ? `timed out after ${CALL_TIMEOUT_MS / 1000}s` : (err as Error).message;
    rec.reasons = [`gateway unreachable: ${msg}`];
    return { rec, stop: `gateway unreachable at ${c.id} (${tier}): ${msg}` };
  }
  rec.latencyMs = now() - started;
  rec.httpStatus = res.status;
  type GatewayBody = { text?: unknown; provider?: unknown; model?: unknown; tier?: unknown; usage?: unknown };
  const readBody = async (): Promise<GatewayBody | null | "bad"> => {
    if (!res.ok) return null;
    try { return (await res.json()) as GatewayBody; } catch { return "bad"; }
  };
  const got = await readBody();
  clearTimeout(timer);
  if (res.status === 429) {
    rec.reasons = ["HTTP 429: the AI budget cap is reached; the run stops here rather than burn it"];
    return { rec, stop: `HTTP 429 (budget) at ${c.id} (${tier})` };
  }
  if (got === "bad") {
    rec.reasons = ["gateway answer was not JSON"];
    return { rec, stop: null };
  }
  if (!res.ok || !got) {
    rec.reasons = [`gateway returned HTTP ${res.status}`];
    return { rec, stop: null };
  }
  const body = got;
  rec.provider = typeof body.provider === "string" ? body.provider : null;
  rec.model = typeof body.model === "string" ? body.model : null;
  rec.appliedTier = readGatewayTier(body.tier);
  const usage = readGatewayUsage(body.usage);
  rec.promptTokens = usage?.promptTokens ?? null;
  rec.completionTokens = usage?.completionTokens ?? null;
  rec.costUsd = usage?.costUsd ?? null;
  const text = typeof body.text === "string" ? body.text : "";
  rec.text = text;

  if (rec.appliedTier === null) {
    rec.reasons = [`answer has no \`tier\`: the gateway did not apply tier ${tier}, so this run did not test it`];
    return { rec, stop: null };
  }
  if (rec.appliedTier !== tier) {
    rec.reasons = [`asked for tier ${tier} but the gateway applied ${rec.appliedTier}`];
    return { rec, stop: null };
  }
  if (rec.provider === "echo") {
    rec.reasons = ["provider is echo: no provider key configured, not a model answer"];
    return { rec, stop: null };
  }
  const scored = scoreCase(c, text);
  rec.status = scored.status;
  rec.reasons = scored.reasons;
  rec.score = scored.score;
  return { rec, stop: null };
}

export async function runEval(args: { tiers: EvalTier[]; tasks: TaskClass[] }, deps: Required<Pick<RunDeps, "fetchImpl" | "now">> & { url: string; token: string }): Promise<Pick<EvalReport, "calls" | "verdicts" | "stoppedEarly" | "exitCode">> {
  const calls: CallRecord[] = [];
  let stoppedEarly: string | null = null;
  for (const tier of args.tiers) {
    for (const task of args.tasks) {
      for (const c of casesFor(task)) {
        if (stoppedEarly) {
          const rec = emptyRecord(c, tier);
          rec.reasons = [`not run: ${stoppedEarly}`];
          calls.push(rec);
          continue;
        }
        const { rec, stop } = await callOne(c, tier, deps.url, deps.token, deps.fetchImpl, deps.now);
        calls.push(rec);
        if (stop) stoppedEarly = stop;
      }
    }
  }
  const verdicts: EvalReport["verdicts"] = {};
  for (const tier of args.tiers) {
    verdicts[tier] = {};
    for (const task of args.tasks) {
      const mine = calls.filter((r) => r.requestedTier === tier && r.task === task);
      const v = classVerdict(task, mine.map((r) => ({ id: r.caseId, task, status: r.status, reasons: r.reasons, score: r.score, ...(r.reasons.some((x) => x.startsWith("INVENTED")) ? { invented: true } : {}) })));
      const ran = mine.filter((r) => r.latencyMs !== null && r.httpStatus !== null);
      verdicts[tier][task] = {
        ...v,
        medianLatencyMs: median(ran.map((r) => r.latencyMs as number)),
        medianTokens: median(ran.filter((r) => r.promptTokens !== null && r.completionTokens !== null).map((r) => (r.promptTokens as number) + (r.completionTokens as number))),
      };
    }
  }
  // The gate tier: fast when it ran, otherwise every tier that did.
  const gateTiers = args.tiers.includes("fast") ? (["fast"] as EvalTier[]) : args.tiers;
  const gate: Verdict[] = gateTiers.flatMap((t) => args.tasks.map((k) => verdicts[t][k].verdict));
  const exitCode: 0 | 1 | 2 = gate.includes("INVALID") ? 2 : gate.includes("FAIL") ? 1 : 0;
  return { calls, verdicts, stoppedEarly, exitCode };
}

export function renderTable(report: Pick<EvalReport, "verdicts" | "stoppedEarly" | "calls">): string {
  const rows: string[][] = [["tier", "task", "verdict", "pass", "median ms", "median tokens", "why"]];
  for (const [tier, byTask] of Object.entries(report.verdicts)) {
    for (const [task, v] of Object.entries(byTask)) {
      rows.push([tier, task, v.verdict, `${v.passed}/${v.total}`, v.medianLatencyMs === null ? "-" : String(v.medianLatencyMs), v.medianTokens === null ? "-" : String(v.medianTokens), v.reason]);
    }
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const out = rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
  if (report.stoppedEarly) out.push("", `STOPPED EARLY: ${report.stoppedEarly}`);
  const bad = report.calls.filter((r) => r.status !== "pass" && !r.reasons.some((x) => x.startsWith("not run")));
  for (const r of bad) out.push("", `${r.requestedTier} ${r.caseId} [${r.status}]`, ...r.reasons.map((x) => `  - ${x}`));
  return out.join("\n");
}

/** The operator entry point: returns the exit code (the script wrapper calls process.exit with it). */
export async function main(argv: readonly string[] = process.argv.slice(2), deps: RunDeps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    log(`ai-tier-eval: ${parsed.error}\nusage: run-eval.js [--tiers fast,standard] [--task summarise|classify|all] [--out file.json]`);
    return 2;
  }
  const url = (env.GATEWAY_URL ?? "").replace(/\/$/, "");
  const token = env.GATEWAY_TOKEN ?? "";
  if (!url || !token) {
    log("ai-tier-eval: INVALID: GATEWAY_URL and GATEWAY_TOKEN must both be set (run it inside gaiada-platform-1). No call was made.");
    return 2;
  }
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const result = await runEval(parsed, { fetchImpl: deps.fetchImpl ?? fetch, now, url, token });
  const report: EvalReport = {
    startedAt, gatewayUrl: url, tiers: parsed.tiers, tasks: parsed.tasks,
    thresholds: Object.fromEntries(Object.entries(thresholds).filter(([, v]) => typeof v === "number")) as Record<string, number>,
    ...result,
  };
  log(renderTable(report));
  if (parsed.out) {
    (deps.write ?? ((f: string, d: string) => writeFileSync(f, d, "utf8")))(parsed.out, `${JSON.stringify(report, null, 2)}\n`);
    log(`\nreport written to ${parsed.out} (contains the model's text; inputs are mock)`);
  }
  log(`\nexit ${report.exitCode} (${report.exitCode === 0 ? "PASS" : report.exitCode === 1 ? "FAIL" : "INVALID"})`);
  return report.exitCode;
}
