// MON-13 — the heartbeat driver. The inverse of every other kind: nothing is dialled. A job calls US,
// and silence is the failure signal.
//
// ── WHY THIS IS THE HIGHEST-VALUE DRIVER IN THE MODULE ───────────────────────────────────────────
// A dead scheduled job is currently invisible on this estate, and it has cost real outages twice,
// both silently:
//   * `N8N_BRIDGE_ENTITY_TYPES` was unset, which darkened every event-triggered n8n flow. Nothing
//     errored; the flows simply never ran.
//   * `mcp-hub` served ZERO module tools for days after a restart, because a one-shot fail-soft fetch
//     had no retry. Every agent and automation silently lost its entire tool surface.
// Both are exactly this shape: a thing that should happen periodically stopped, and the absence
// produced no signal. Pull-based checks cannot catch it — there is nothing to probe. Only "I expected
// to hear from you and did not" catches it.
//
// ── NO NETWORK, DELIBERATELY ────────────────────────────────────────────────────────────────────
// `probe()` here is a pure function of (lastSeenAt, graceSec, now). That means no egress guard, no
// SSRF surface, and a test suite that cannot skip for want of infrastructure. The ingest endpoint is
// where the trust boundary lives (unauthenticated by design — the URL token IS the credential), and
// that is the controller's concern, not this file's.
import type { MonitorDriver, ProbeCtx, ProbeResult } from "./registry";

export interface HeartbeatConfig {
  /**
   * Seconds of silence tolerated before the monitor is considered failed. Distinct from the monitor's
   * `interval_sec`: interval is how often WE evaluate, grace is how long the JOB may be quiet. A
   * nightly job has a 24h+ grace and may be evaluated every minute.
   */
  graceSec: number;
}

/**
 * State the runner supplies from `monitor_heartbeats`. Passed in rather than read here so this file
 * stays pure — the same reason the search module's pure helpers live apart from its readers.
 */
export interface HeartbeatState {
  lastSeenAt: Date | null;
  now?: Date;
}

export const MIN_GRACE_SEC = 30;

export function validateHeartbeatConfig(config: unknown): HeartbeatConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  const raw = c.graceSec === undefined ? 300 : Number(c.graceSec);
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new Error("graceSec must be an integer number of seconds");
  }
  if (raw < MIN_GRACE_SEC) {
    // A grace shorter than this turns ordinary scheduling jitter into a page, and an alert that cries
    // wolf gets muted — which costs you the very signal this driver exists to provide.
    throw new Error(`graceSec must be at least ${MIN_GRACE_SEC}s`);
  }
  return { graceSec: raw };
}

/**
 * The whole decision, pure and separately testable.
 *
 * `lastSeenAt === null` is `unknown`, NOT `down`. A heartbeat monitor that has never been pinged is
 * almost always a job whose URL was not wired up yet — a configuration state, not an outage. Calling
 * it `down` would page someone on creation and teach them that this alert means nothing. The board
 * renders `unknown` with "never", which is honest and actionable, and the stale-detection on the
 * board is what stops it being mistaken for healthy.
 */
export function evaluateHeartbeat(config: HeartbeatConfig, state: HeartbeatState): ProbeResult {
  const now = state.now ?? new Date();

  if (state.lastSeenAt === null) {
    return {
      status: "unknown",
      latencyMs: null,
      detail: "no heartbeat has ever been received — check that the job is calling its push URL",
    };
  }

  const silentMs = now.getTime() - state.lastSeenAt.getTime();

  // A future timestamp means clock skew between us and the job's host, or a replayed ping. Treat it
  // as recent rather than as a huge negative silence, but SAY so: silently normalising it would hide
  // a skew that will eventually produce a false alert nobody can explain.
  if (silentMs < 0) {
    return {
      status: "up",
      latencyMs: null,
      detail: `heartbeat timestamp is ${Math.abs(Math.round(silentMs / 1000))}s in the future — check clock skew on the job host`,
    };
  }

  const graceMs = config.graceSec * 1000;
  if (silentMs <= graceMs) {
    return { status: "up", latencyMs: null, detail: null };
  }

  const overdueSec = Math.round((silentMs - graceMs) / 1000);
  return {
    status: "down",
    latencyMs: null,
    // Names the overdue amount, not just "late": "40s overdue" and "9 hours overdue" call for
    // completely different responses, and a generic message forces the reader back to the raw data.
    detail: `no heartbeat for ${Math.round(silentMs / 1000)}s, which is ${overdueSec}s past the ${config.graceSec}s grace`,
  };
}

/**
 * Driver shape for the registry. `probe` reads state off `ctx` because the interface is shared with
 * dialling drivers; the runner attaches it. If the runner forgets, this THROWS rather than reporting
 * a status — a heartbeat monitor silently evaluating as "up" with no state would be the worst
 * possible failure for the one driver whose entire job is noticing silence.
 */
export interface HeartbeatProbeCtx extends ProbeCtx {
  heartbeat?: HeartbeatState;
}

export const heartbeatDriver: MonitorDriver<HeartbeatConfig> = {
  kind: "heartbeat",
  capabilities: ["grace_period"],
  validate: validateHeartbeatConfig,
  async probe(config, ctx): Promise<ProbeResult> {
    const state = (ctx as HeartbeatProbeCtx).heartbeat;
    if (!state) {
      throw new Error(
        "heartbeat driver invoked without heartbeat state — the runner must supply lastSeenAt. " +
          "Refusing rather than defaulting, because a heartbeat monitor that reports 'up' with no " +
          "state would silently invert the only thing it is for.",
      );
    }
    return evaluateHeartbeat(config, state);
  },
};
