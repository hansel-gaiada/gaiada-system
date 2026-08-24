// The corpus. Everything the simulation observes is written here as append-only JSONL, because the
// findings matter longer than the run does.
//
// WHY JSONL FILES AND NOT A TABLE
// -------------------------------
// The obvious alternative is a Postgres table on the live estate. Rejected: the whole point of this
// harness is to find out how the estate misbehaves under real work, and a log that lives INSIDE the
// system under test disappears exactly when it is most interesting (a failed migration, a crashed
// platform, an exhausted disk). Append-only files on a mounted volume survive all three. They are
// also trivially loadable later, and a COPY ... FROM PROGRAM can pull them into Postgres whenever a
// SQL shape is genuinely wanted.
//
// WHY SYNCHRONOUS APPENDS
// -----------------------
// appendFileSync per line, not a buffered stream. A buffered writer loses its tail on SIGKILL, and
// the tail is the most valuable part of a run that died: it holds whatever killed it. The cost is
// irrelevant at this volume (single-digit writes per second).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/** Bumped whenever a field's MEANING changes, so an analysis script can refuse a corpus it would
 *  misread rather than silently averaging two different definitions together. */
export const CORPUS_SCHEMA = 3;

export type ActorPath = "human" | "obo" | "agent" | "automation" | "external";

export interface Actor {
  /** Display name as it appears in the ERP, so a log line is readable without a join. */
  name: string;
  /** The users.id the platform will attribute the write to. */
  userId?: string;
  email?: string;
  department?: string;
  /** WHICH identity mechanism drove this call. The single most important field in the corpus: the
   *  agentic-native bar is the claim that a capability behaves identically across these paths, and
   *  this field is what lets the analysis test that claim per endpoint. */
  path: ActorPath;
}

export interface StepRecord {
  kind: "step";
  ts: string;
  seq: number;
  runId: string;
  scenario: string;
  step: string;
  actor: Actor;
  request: { method: string; url: string; bodyKeys?: string[] };
  response: { status: number; ms: number; ok: boolean; error?: string; bodyExcerpt?: string };
  /** Set when the harness itself judges the outcome wrong, even though the call "succeeded". */
  suspect?: string;
}

export interface FindingRecord {
  kind: "finding";
  ts: string;
  runId: string;
  /** Stable key so repeat occurrences aggregate instead of flooding: same key = same defect. */
  key: string;
  severity: "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  /** How many times this run has seen it so far. The analysis takes the max. */
  occurrence: number;
}

/** The teardown ledger. Every record the simulation creates is written here the moment it is
 *  created, BEFORE anything else happens to it. If the run dies mid-scenario, teardown still has a
 *  complete list of what to remove; a ledger written at the end of a scenario would not. */
export interface CreatedRecord {
  kind: "created";
  ts: string;
  runId: string;
  entity: string;
  id: string;
  tenantId: string;
  /** Enough to find it by hand in the UI if the id ledger is ever lost. */
  label?: string;
}

export type CorpusRecord = StepRecord | FindingRecord | CreatedRecord;

const runDir = join(config.logDir, config.runId);
const stepsFile = join(runDir, "steps.jsonl");
const findingsFile = join(runDir, "findings.jsonl");
const createdFile = join(runDir, "created.jsonl");
const summaryFile = join(runDir, "summary.json");

let seq = 0;
const findingCounts = new Map<string, number>();
const statusByEndpoint = new Map<string, { ok: number; fail: number }>();
/** Per (endpoint x actor path) tallies: the raw material for the agentic-native comparison. */
const pathMatrix = new Map<string, { ok: number; fail: number }>();

export function initCorpus(): void {
  mkdirSync(runDir, { recursive: true });
  // A manifest, written once, so a corpus found months later explains itself.
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify(
      {
        schema: CORPUS_SCHEMA,
        runId: config.runId,
        startedAt: new Date().toISOString(),
        mode: config.mode,
        tenantId: config.tenantId,
        platformUrl: config.platformUrl,
        marker: config.marker,
        note: "Simulated work against a live dev estate. Every record created by this run carries the marker and is listed in created.jsonl.",
      },
      null,
      2,
    ) + "\n",
  );
}

function append(file: string, rec: CorpusRecord): void {
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
}

/** Normalises an endpoint for aggregation: ids collapse to :id so a thousand task patches become
 *  one row instead of a thousand. Without this the corpus is unaggregatable. */
export function endpointKey(method: string, url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const generalised = path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
    .replace(/\/\d+/g, "/:n")
    .replace(/[?].*$/, "");
  return method + " " + generalised;
}

export function logStep(rec: Omit<StepRecord, "kind" | "ts" | "seq" | "runId">): StepRecord {
  const full: StepRecord = { kind: "step", ts: new Date().toISOString(), seq: ++seq, runId: config.runId, ...rec };
  append(stepsFile, full);

  const ep = endpointKey(full.request.method, full.request.url);
  const tally = statusByEndpoint.get(ep) ?? { ok: 0, fail: 0 };
  if (full.response.ok) tally.ok++;
  else tally.fail++;
  statusByEndpoint.set(ep, tally);

  const pk = ep + " | " + full.actor.path;
  const pmTally = pathMatrix.get(pk) ?? { ok: 0, fail: 0 };
  if (full.response.ok) pmTally.ok++;
  else pmTally.fail++;
  pathMatrix.set(pk, pmTally);

  return full;
}

export function logFinding(f: Omit<FindingRecord, "kind" | "ts" | "runId" | "occurrence">): void {
  const n = (findingCounts.get(f.key) ?? 0) + 1;
  findingCounts.set(f.key, n);
  // Every occurrence is written, not just the first: the count matters (a defect that fires 400
  // times is a different problem from one that fires once), and de-duplicating at write time would
  // throw away the timing that shows whether it is constant or bursty.
  append(findingsFile, { kind: "finding", ts: new Date().toISOString(), runId: config.runId, occurrence: n, ...f });
}

export function logCreated(entity: string, id: string, label?: string): void {
  append(createdFile, {
    kind: "created",
    ts: new Date().toISOString(),
    runId: config.runId,
    entity,
    id,
    tenantId: config.tenantId,
    ...(label ? { label } : {}),
  });
}

/** Rewritten (not appended) on every flush, so the newest snapshot is always the whole file and a
 *  reader never has to find the last of N summaries. */
export function writeSummary(extra: Record<string, unknown> = {}): void {
  const endpoints = [...statusByEndpoint.entries()]
    .map(([ep, t]) => ({ endpoint: ep, ok: t.ok, fail: t.fail, failRate: t.fail / (t.ok + t.fail) }))
    .sort((a, b) => b.fail - a.fail || b.ok + b.fail - (a.ok + a.fail));

  // The agentic-native view: for each endpoint, how did each identity path fare? An endpoint that
  // is green for "human" and red for "agent" is precisely the bar's failure mode, and this is the
  // table that shows it without any further analysis.
  const byPath: Record<string, Record<string, { ok: number; fail: number }>> = {};
  for (const [k, v] of pathMatrix) {
    const idx = k.lastIndexOf(" | ");
    if (idx < 0) continue;
    const ep = k.slice(0, idx);
    const path = k.slice(idx + 3);
    (byPath[ep] ??= {})[path] = v;
  }
  const parityGaps = Object.entries(byPath)
    .filter(([, paths]) => {
      const entries = Object.entries(paths);
      if (entries.length < 2) return false;
      const anyGreen = entries.some(([, t]) => t.ok > 0 && t.fail === 0);
      const anyRed = entries.some(([, t]) => t.fail > 0 && t.ok === 0);
      return anyGreen && anyRed;
    })
    .map(([ep, paths]) => ({ endpoint: ep, paths }));

  writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        schema: CORPUS_SCHEMA,
        runId: config.runId,
        updatedAt: new Date().toISOString(),
        steps: seq,
        findings: [...findingCounts.entries()]
          .map(([key, n]) => ({ key, occurrences: n }))
          .sort((a, b) => b.occurrences - a.occurrences),
        endpoints,
        /** Endpoints that work on one identity path and fail on another: the agentic-native gate. */
        parityGaps,
        ...extra,
      },
      null,
      2,
    ) + "\n",
  );
}

export function corpusPaths() {
  return { runDir, stepsFile, findingsFile, createdFile, summaryFile };
}
