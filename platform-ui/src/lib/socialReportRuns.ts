// SCP-5 W5-A4 (BFF §63.24.5, §63.24.7) — "Generate with AI" for every client: the run's types, their defensive parsing and the words for them. Pure and client-safe (no I/O, no clock).
//
// A run is a background job: `POST reports/generate` answers at once (202) with the clients it will draft, and `GET reports/generate/:runId` answers its progress, each client's result as it
// lands. The panel polls that read at a modest interval until the run settles (`done` or `failed`). A parsed answer that is the wrong shape throws, and the caller says "cannot tell", never
// a plausible empty panel. Refusals are the contract's own codes; the words are `reportRefusalText`'s, plus the run's own (`runRefusalText`).
import { REFUSAL_WORDS, type Refusal } from "./socialPipeline";
import { REPORT_REFUSAL_WORDS, reportRefusalText, reportHref } from "./socialReports";
import { kindNoun } from "./socialReportKinds";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** How often the panel asks for the run's progress. A run takes minutes (a draft is seconds to tens of seconds), so a few seconds is plenty. */
export const RUN_POLL_MS = 4000;

export type RunStatus = "queued" | "running" | "done" | "failed";
export type ResultStatus = "created" | "existing" | "skipped" | "failed";
export const isSettled = (status: string): boolean => status === "done" || status === "failed";

export interface RunResult {
  engagementId: string;
  clientName: string;
  reportId: string | null;
  status: ResultStatus;
  /** `ai`, `fallback` (the plain template) or `none` (AI drafting off), for a created report. */
  draftedVia: string | null;
  reason: string | null;
  simulated: boolean;
}

export interface RunUsage { calls: number; promptTokens: number; completionTokens: number; costUsd: number | null }

/** `GET reports/generate/:runId`, and the 200 of a replayed start (which also carries `clients`). */
export interface RunProgress {
  runId: string;
  kind: string;
  period: string;
  status: string;
  total: number;
  done: number;
  results: RunResult[];
  startedAt: string | null;
  finishedAt: string | null;
  usage: RunUsage;
}

const RESULT_STATUSES: readonly string[] = ["created", "existing", "skipped", "failed"];

export function asRunResult(raw: unknown): RunResult | null {
  if (!isObj(raw) || typeof raw.engagementId !== "string" || typeof raw.status !== "string" || !RESULT_STATUSES.includes(raw.status)) return null;
  return {
    engagementId: raw.engagementId, clientName: str(raw.clientName) ?? "A client", reportId: str(raw.reportId), status: raw.status as ResultStatus,
    draftedVia: str(raw.draftedVia), reason: str(raw.reason), simulated: raw.simulated === true,
  };
}

export function asRunProgress(raw: unknown): RunProgress {
  if (!isObj(raw) || typeof raw.runId !== "string" || typeof raw.status !== "string" || !Array.isArray(raw.results)) throw new Error("run: not a run");
  const usage = isObj(raw.usage) ? raw.usage : {};
  return {
    runId: raw.runId, kind: str(raw.kind) ?? "", period: str(raw.period) ?? "", status: raw.status, total: int(raw.total), done: int(raw.done),
    results: raw.results.map(asRunResult).filter((r): r is RunResult => r !== null), startedAt: str(raw.startedAt), finishedAt: str(raw.finishedAt),
    usage: { calls: int(usage.calls), promptTokens: int(usage.promptTokens), completionTokens: int(usage.completionTokens), costUsd: typeof usage.costUsd === "number" ? usage.costUsd : null },
  };
}

/** What starting a run answers: 202 `{runId, kind, period, total, clients}`, or 200 with the run as it stands (a replayed `id`). Only the run's id and size are needed to start following it. */
export interface RunStarted { runId: string; kind: string; period: string; total: number }
export function asRunStarted(raw: unknown): RunStarted {
  if (!isObj(raw) || typeof raw.runId !== "string") throw new Error("run start: not a run");
  return { runId: raw.runId, kind: str(raw.kind) ?? "", period: str(raw.period) ?? "", total: int(raw.total) };
}

export interface RunListItem {
  runId: string;
  kind: string;
  period: string;
  status: string;
  total: number;
  done: number;
  counts: { created: number; existing: number; skipped: number; failed: number };
  trigger: string;
  createdAt: string | null;
  finishedAt: string | null;
}

/** `GET reports/generate`: `{ items: [...] }`, the last 30 days' runs (the company's for the four, one's own for anyone else). */
export function asRunList(raw: unknown): RunListItem[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("runs: not a list of runs");
  return raw.items.flatMap((r): RunListItem[] => {
    if (!isObj(r) || typeof r.runId !== "string" || typeof r.status !== "string") return [];
    const c = isObj(r.counts) ? r.counts : {};
    return [{
      runId: r.runId, kind: str(r.kind) ?? "", period: str(r.period) ?? "", status: r.status, total: int(r.total), done: int(r.done),
      counts: { created: int(c.created), existing: int(c.existing), skipped: int(c.skipped), failed: int(c.failed) }, trigger: str(r.trigger) ?? "person",
      createdAt: str(r.createdAt), finishedAt: str(r.finishedAt),
    }];
  });
}

// ── The words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RUN_STATUS_WORDS: Readonly<Record<string, string>> = { queued: "Waiting its turn", running: "Drafting", done: "Finished", failed: "Stopped" };
export const runStatusWords = (s: string): string => RUN_STATUS_WORDS[s] ?? s;

/** "3 of 12 clients done." */
export function progressLine(p: Pick<RunProgress, "done" | "total">): string {
  return `${p.done} of ${p.total} ${p.total === 1 ? "client" : "clients"} done.`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The run's tally in the notice's own words: "12 drafts ready, 6 already there, 1 failed". Nothing counted is left out; an empty tally says so. */
export function tallyLine(c: { created: number; existing: number; skipped: number; failed: number }): string {
  const parts = [
    c.created > 0 ? `${plural(c.created, "draft", "drafts")} ready` : null,
    c.existing > 0 ? `${c.existing} already there` : null,
    c.skipped > 0 ? `${c.skipped} skipped` : null,
    c.failed > 0 ? `${c.failed} failed` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(", ") : "Nothing to draft";
}

export function tallyOf(results: readonly RunResult[]): { created: number; existing: number; skipped: number; failed: number } {
  const t = { created: 0, existing: 0, skipped: 0, failed: 0 };
  for (const r of results) t[r.status] += 1;
  return t;
}

/** Why a client was skipped, or why its draft failed. A failed draft's reason is the refusal's own code (never prose); one this page has no words for is shown plainly, never as the bare code. */
export function reasonWords(reason: string | null, kind: string): string {
  switch (reason) {
    case null: return "";
    case "kind_not_due": return `This client is not due a ${kindNoun(kind).toLowerCase()}. Turn it on for the client on the Allocation page.`;
    case "internal_client": return "Our own company is not a client, so it gets no client reports.";
    case "not_allowed": return "You may not draft for this client.";
    case "requester_inactive": return "The person who started the run is no longer active, so it could not go on.";
    default: return REPORT_REFUSAL_WORDS[reason] ?? REFUSAL_WORDS[reason] ?? `The draft could not be made (${reason.replace(/_/g, " ")}).`;
  }
}

/** A client's result in a line. */
export function resultWords(r: RunResult, kind: string): string {
  switch (r.status) {
    case "created":
      return r.draftedVia === "fallback" ? "Draft ready, from the plain template (the AI could not be used just now)."
        : r.draftedVia === "none" ? "Empty draft started (AI drafting is off for this kind)."
        : "Draft ready.";
    case "existing": return "Already had one, so it was left as it is.";
    case "skipped": return `Skipped. ${reasonWords(r.reason, kind)}`.trim();
    case "failed": return `Failed. ${reasonWords(r.reason, kind)}`.trim();
  }
}

/** Where a result's report opens, or null when it has none (skipped or failed). */
export const resultHref = (deptId: string, r: RunResult): string | null => (r.reportId ? reportHref(deptId, r.reportId) : null);

/** The heading of a run: "Weekly report, Week 46, 2026 (9 to 15 Nov 2026)". */
export const runTitle = (kind: string, periodWords: string): string => `${kindNoun(kind)}, ${periodWords}`;

// ── The refusals ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A refusal of the run routes in a sentence: a 403 says who may generate (`GENERATE_REASON`), `generation_running` says a run is already going (the panel then follows it, taking the id
 * from the refusal), a 404 `run_not_found` says the run is not the person's or is gone. Everything else is the report words.
 */
export const runRefusalText = (r: Refusal): string => reportRefusalText(r, "generate");

/** The id of the run that is already going, from a 409 `generation_running` `{detail: {runId}}`. */
export function runningRunId(r: Refusal): string | null {
  if (r.status !== 409 || r.error !== "generation_running") return null;
  const id = r.detail?.runId;
  return typeof id === "string" && id !== "" ? id : null;
}
