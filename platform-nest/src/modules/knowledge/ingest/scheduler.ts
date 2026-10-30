// In-process scheduler for knowledge re-ingestion, started from main.ts like the other platform
// jobs (search pull scheduler, graph bridge, event relay).
//
// ── WHY A PLATFORM JOB RATHER THAN AN n8n FLOW ───────────────────────────────────────────────────
// Same reasoning the search pull scheduler records: it needs a tenant-context DB read across every
// company, and every n8n automation principal is minted `assurance: "low"` by construction. This
// loop also has no HTTP route, no tool binding and no principal — nothing on the MCP surface can
// reach it. Unlike that scheduler it spends no vendor money; its only cost is embedding calls
// through our own gateway.
//
// ── OVERLAP IS THE FAILURE MODE TO AVOID ─────────────────────────────────────────────────────────
// A full sweep walks every chunk of every company (embedding only the new or changed ones) and can outlast a short interval. Two concurrent
// sweeps would double the embedding load and race each other's retire step (one sweep's in-progress
// writes look like "missing" to the other's diff). `running` is therefore a hard gate: a tick that
// finds a sweep in flight logs and returns rather than queueing.
import { config, knowledgeIngestEnabled } from "../../../config";
import { runFullIngest } from "./ingest.service";
import type { IngestRunResult } from "./types";

let running = false;
let timer: NodeJS.Timeout | undefined;
let lastResults: IngestRunResult[] = [];
let lastRunAt = "";

/** AIP-03e: where a sweep's time went, for the one summary line. The per-tier timings already live in `lastResults`, but only in
 *  memory: the next deploy restarts the platform and they are gone, which is how a 35-minute sweep on 2026-10-29 (a re-sweep
 *  normally takes about 3.5 minutes) could not be explained afterwards. So the log line carries them. Pure, for the test.
 *  Shape: `public 135s (crawl 70s), companies 87s, slowest 019fb652… 87s`. */
export function sweepTimings(results: readonly IngestRunResult[]): string {
  const secs = (r: IngestRunResult): number => {
    const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  };
  const parts: string[] = [];
  const pub = results.find((r) => r.tier === "public");
  if (pub) parts.push(`public ${secs(pub)}s${typeof pub.crawlMs === "number" ? ` (crawl ${Math.round(pub.crawlMs / 1000)}s)` : ""}`);
  const internal = results.filter((r) => r.tier === "internal");
  if (internal.length > 0) {
    parts.push(`companies ${internal.reduce((a, r) => a + secs(r), 0)}s`);
    const slowest = internal.reduce((a, r) => (secs(r) > secs(a) ? r : a));
    parts.push(`slowest ${slowest.tenantId.slice(0, 8)}… ${secs(slowest)}s`);
  }
  return parts.join(", ");
}

/** Most recent sweep's per-tier results — surfaced by the admin console so a stale index is visible
 *  rather than something you discover by asking an agent a question it cannot answer. */
export function lastIngestRun(): { at: string; running: boolean; results: IngestRunResult[] } {
  return { at: lastRunAt, running, results: lastResults };
}

/** Run one sweep now, unless one is already in flight. Shared by the timer and the admin trigger. */
export async function runIngestSweep(): Promise<IngestRunResult[]> {
  if (running) return lastResults;
  running = true;
  try {
    lastResults = await runFullIngest();
    lastRunAt = new Date().toISOString();
    const totals = lastResults.reduce(
      (a, r) => ({ sources: a.sources + r.sources, chunks: a.chunks + r.chunks, errors: a.errors + r.errors.length, retired: a.retired + r.retired }),
      { sources: 0, chunks: 0, errors: 0, retired: 0 },
    );
    const stopped = lastResults.find((r) => r.aborted);
    if (stopped) {
      // ONE line, counts only: the sweep stopped (the gateway's embedding budget is spent, or the
      // store or its embedder is down) and retired nothing for the tier it was in. The next tick resumes.
      const why = stopped.abortReason === "consecutive_failures" ? "failures (documents failing in a row)" : "embedding budget (gateway 429)";
      console.warn(
        `knowledge ingest: STOPPED on ${why} after ${totals.sources} sources written, ${totals.chunks} chunks, ${totals.retired} retired; ${lastResults.length} tiers started; ${sweepTimings(lastResults)}`,
      );
    } else {
      console.log(`knowledge ingest: ${totals.sources} sources, ${totals.chunks} chunks, ${totals.errors} errors; ${sweepTimings(lastResults)}`);
    }
    return lastResults;
  } finally {
    running = false;
  }
}

export function startKnowledgeIngestLoop(): void {
  if (!knowledgeIngestEnabled()) return;
  const intervalMs = config.knowledgeIngest.intervalMs;
  // Deliberately NOT run at t=0: boot is the worst moment to add an embedding storm, and the first
  // tick is at most one interval away. An operator who wants it now has the admin trigger.
  timer = setInterval(() => {
    runIngestSweep().catch((err) => console.error("knowledge ingest sweep failed", err));
  }, intervalMs);
  timer.unref?.();
}

export function stopKnowledgeIngestLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
