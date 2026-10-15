// DW-7i-1 (BFF §52.12) — the failed runs of the shared n8n inside a window. PURE: the n8n GET is injected, so the window
// filter, the paging and every degraded answer are tested without a network. The controller supplies the real fetch.
//
// RULE: a failure is never answered as `[]`. A run list that cannot be read is `unavailable` with a reason, and a service
// that is not set up is `not_configured`; only a successful read of n8n that found no failed run is `on` with `count: 0`.

export type FailuresWindow = "24h" | "7d";

export const WINDOW_MS: Readonly<Record<FailuresWindow, number>> = { "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };
export const PAGE_LIMIT = 250;
export const MAX_PAGES = 5;
export const MAX_FAILED = 200;

export interface FailedRun {
  executionId: string;
  workflowId: string;
  workflowName: string;
  startedAt: string;
  stoppedAt: string | null;
  mode: string | null;
}

export interface FailuresResult {
  state: "on" | "not_configured" | "unavailable";
  reason?: string;
  failed: FailedRun[];
  /** The failed runs in the window. A lower bound when `capped`. */
  count: number;
  /** True when the page cap cut the window short: `count` is "at least". */
  capped: boolean;
}

/** n8n GET (path with query), returning parsed JSON or throwing. */
export type N8nGet = (path: string) => Promise<unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface RawRun {
  id: string;
  workflowId: string;
  startedAt: string;
  startedMs: number;
  stoppedAt: string | null;
  mode: string | null;
}

/** PURE. One execution row from n8n, or null when it is not shaped like one. */
function parseRun(v: unknown): RawRun | null {
  if (!isObj(v)) return null;
  const id = v.id;
  const wf = v.workflowId;
  const started = v.startedAt;
  if ((typeof id !== "string" && typeof id !== "number") || (typeof wf !== "string" && typeof wf !== "number")) return null;
  if (typeof started !== "string") return null;
  const startedMs = Date.parse(started);
  if (!Number.isFinite(startedMs)) return null;
  return {
    id: String(id),
    workflowId: String(wf),
    startedAt: started,
    startedMs,
    stoppedAt: typeof v.stoppedAt === "string" ? v.stoppedAt : null,
    mode: typeof v.mode === "string" ? v.mode : null,
  };
}

/** PURE. `status` is checked defensively though the query already asks for errors; a row without one is taken as asked for. */
function isErrorRow(v: unknown): boolean {
  return !isObj(v) || typeof v.status !== "string" || v.status === "error";
}

function unavailable(reason: string): FailuresResult {
  return { state: "unavailable", reason, failed: [], count: 0, capped: false };
}

/**
 * Page through `GET /api/v1/executions?status=error&limit=250` (newest first) until a run older than the window shows up
 * (the window is covered), the cursor runs out, or MAX_PAGES pages were read. When the cap stops the walk with the window
 * still not covered, the answer is `capped` and `reason` says the count is a lower bound.
 */
export async function collectFailures(get: N8nGet, window: FailuresWindow, nowMs: number): Promise<FailuresResult> {
  const cutoff = nowMs - WINDOW_MS[window];
  const inWindow: RawRun[] = [];
  let cursor: string | null = null;
  let covered = false;

  for (let page = 0; page < MAX_PAGES && !covered; page++) {
    const path = `/api/v1/executions?status=error&limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let body: unknown;
    try {
      body = await get(path);
    } catch (e) {
      return unavailable(`n8n did not answer the failed runs (${(e as Error).message})`);
    }
    if (!isObj(body) || !Array.isArray(body.data)) return unavailable("n8n answered with something other than a list of runs");
    for (const row of body.data) {
      if (!isErrorRow(row)) continue;
      const run = parseRun(row);
      if (!run) return unavailable("n8n answered with runs in an unexpected shape");
      if (run.startedMs < cutoff) covered = true; // newest first: everything after this is older still
      else inWindow.push(run);
    }
    const next = body.nextCursor;
    if (typeof next === "string" && next !== "") cursor = next;
    else {
      covered = true; // no more pages: every run n8n holds was read
      cursor = null;
    }
  }

  const capped = !covered;

  // Names: one best-effort read. A failure here costs the names, never the list.
  const names = new Map<string, string>();
  if (inWindow.length > 0) {
    try {
      const wf = await get(`/api/v1/workflows?limit=${PAGE_LIMIT}`);
      if (isObj(wf) && Array.isArray(wf.data)) {
        for (const w of wf.data) {
          if (isObj(w) && (typeof w.id === "string" || typeof w.id === "number") && typeof w.name === "string") names.set(String(w.id), w.name);
        }
      }
    } catch {
      /* the id stands in for the name */
    }
  }

  inWindow.sort((a, b) => b.startedMs - a.startedMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const failed: FailedRun[] = inWindow.slice(0, MAX_FAILED).map((r) => ({
    executionId: r.id,
    workflowId: r.workflowId,
    workflowName: names.get(r.workflowId) ?? r.workflowId,
    startedAt: r.startedAt,
    stoppedAt: r.stoppedAt,
    mode: r.mode,
  }));

  return {
    state: "on",
    ...(capped ? { reason: `The window holds more failed runs than the ${MAX_PAGES} pages read; the count is at least ${inWindow.length}` } : {}),
    failed,
    count: inWindow.length,
    capped,
  };
}
