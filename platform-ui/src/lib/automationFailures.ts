import "server-only";
// DW-7i-1 (docs/FRONTEND-BFF-CONTRACT.md §52.12): the failed runs of the shared n8n, for the owner, the GM, the PM and the platform
// operator (DW-D37).
//   GET /api/:t/automation/failures?window=24h|7d -> { asOf, window, state, reason?, failed, count, capped?, editorUrl? }
//
// ── A 200 IN THE WRONG SHAPE IS "UNAVAILABLE", NEVER "NO FAILURES" ──────────────────────────────────────────────
// "No workflow failed" is a claim only a real `state: "on"` answer may make. The demo layer answers `[]` to any GET it has no fixture
// for, and a drifted backend could do the same; read as `{}` that would be a confident all-clear. The reader checks what the page
// relies on and throws inside `readResult`, so a wrong shape renders as "cannot be read right now".
//
// `not_configured` and `unavailable` are carried as states with their reason, and their `failed` and `count` are dropped here, so
// a zero can never be drawn from a service that was not read.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";

export type FailuresWindow = "24h" | "7d";
export const FAILURES_WINDOWS: readonly FailuresWindow[] = ["24h", "7d"];

export interface FailedRun {
  executionId: string;
  workflowId: string;
  /** The workflow's name, or its id when n8n's workflow list could not be read. */
  workflowName: string;
  startedAt: string;
  stoppedAt: string | null;
  mode: string | null;
}

export type FailuresAnswer =
  | {
    asOf: string; window: FailuresWindow; state: "on";
    /** Newest first, at most 200. */
    failed: FailedRun[];
    /** The failed runs in the window; may exceed `failed.length`. */
    count: number;
    /** The server's page cap cut the window short: `count` is "at least". */
    capped: boolean;
    reason?: string;
    /** The browser-reachable n8n editor origin, when the platform knows it (a workflow opens at `<editorUrl>/workflow/<id>`). */
    editorUrl?: string;
  }
  | { asOf: string; window: FailuresWindow; state: "not_configured" | "unavailable"; reason: string; editorUrl?: string };

const bad = () => new Error("The failing-workflows read returned an unexpected answer.");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function toRun(raw: unknown): FailedRun {
  if (
    !isObj(raw) || !isStr(raw.executionId) || !isStr(raw.workflowId) || !isStr(raw.workflowName) || !isStr(raw.startedAt) ||
    !strOrNull(raw.stoppedAt ?? null) || !strOrNull(raw.mode ?? null)
  ) throw bad();
  return {
    executionId: raw.executionId, workflowId: raw.workflowId, workflowName: raw.workflowName, startedAt: raw.startedAt,
    stoppedAt: (raw.stoppedAt as string | null | undefined) ?? null, mode: (raw.mode as string | null | undefined) ?? null,
  };
}

function toFailures(d: unknown): FailuresAnswer {
  if (!isObj(d) || !isStr(d.asOf) || (d.window !== "24h" && d.window !== "7d")) throw bad();
  const base = { asOf: d.asOf, window: d.window as FailuresWindow, ...(isStr(d.editorUrl) && d.editorUrl ? { editorUrl: d.editorUrl } : {}) };
  if (d.state === "not_configured" || d.state === "unavailable") {
    // A state with no words is not an answer the page can show honestly.
    if (!isStr(d.reason) || d.reason === "") throw bad();
    return { ...base, state: d.state, reason: d.reason };
  }
  if (d.state !== "on" || !Array.isArray(d.failed) || typeof d.count !== "number" || !Number.isInteger(d.count) || d.count < 0) throw bad();
  const failed = d.failed.map(toRun);
  // The list is part of the count: a count that is smaller than what it lists is not one the server could have made.
  if (d.count < failed.length) throw bad();
  return {
    ...base, state: "on", failed, count: d.count, capped: d.capped === true,
    ...(isStr(d.reason) && d.reason ? { reason: d.reason } : {}),
  };
}

/** The failed runs inside the window. A 403 is `forbidden` (not for everyone), any other failure or a wrong shape is `unavailable`. */
export const listFailuresResult = (u: string, t: string, window: FailuresWindow = "24h"): Promise<ReadResult<FailuresAnswer>> =>
  readResult(platformFetch<unknown>(`/api/${t}/automation/failures?window=${window}`, u).then(toFailures));
