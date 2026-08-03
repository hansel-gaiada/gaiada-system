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
// A full sweep embeds every chunk of every company and can outlast a short interval. Two concurrent
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
      (a, r) => ({ sources: a.sources + r.sources, chunks: a.chunks + r.chunks, errors: a.errors + r.errors.length }),
      { sources: 0, chunks: 0, errors: 0 },
    );
    console.log(`knowledge ingest: ${totals.sources} sources, ${totals.chunks} chunks, ${totals.errors} errors`);
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
