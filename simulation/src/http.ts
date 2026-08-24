// The instrumented client every scenario calls through. It is deliberately more than a fetch
// wrapper: it is where the harness JUDGES a response, because a simulation that only records
// statuses needs a human to read 40,000 log lines to find anything.
//
// The judgements below are the ones that have already earned their place on this estate. The first
// probe run of this harness (2026-08-24) hit both:
//
//   * a 500 from GET /api/undefined/projects, where the mcp-hub had stringified a missing tenantId
//     straight into the path and platform-nest handed the literal text "undefined" to Postgres as a
//     uuid. Two defects, one request.
//
// A 5xx is ALWAYS a finding, never a "flaky call". Bad input deserves a 4xx; a 5xx means the server
// failed to anticipate something, which is the definition of a defect worth a ticket.
import { config } from "./config.js";
import { logStep, logFinding, type Actor } from "./log.js";

export interface CallOptions {
  method?: string;
  path: string;
  body?: unknown;
  /** Which identity mechanism to present. Chosen by the scenario, because the same business action
   *  performed by a human and by an agent is exactly the comparison this harness exists to make. */
  actor: Actor;
  scenario: string;
  step: string;
  /** Bearer for the "human" path. Absent for service-credential paths. */
  token?: string;
  /** OBO envelope for the bot/agent-on-behalf-of-a-human path. */
  obo?: { provider: string; externalId: string; agent?: string; actFor?: string };
  /** Statuses the scenario EXPECTS, so a deliberate negative test does not raise a finding. A 403
   *  probe asserting that authz denies something is a pass, not a defect. */
  expect?: number[];
  /** Base origin override; defaults to the internal platform alias. */
  base?: string;
  timeoutMs?: number;
}

export interface CallResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
  raw: string;
  ms: number;
}

/** Anything above this is worth recording as a latency outlier. Not a hard SLO: the point is to
 *  notice an endpoint that degrades under sustained real work, which a p50 would hide. */
const SLOW_MS = 3000;

export async function call<T = unknown>(opts: CallOptions): Promise<CallResult<T>> {
  const method = opts.method ?? "GET";
  const base = opts.base ?? config.platformUrl;
  const url = base.replace(/\/$/, "") + opts.path;

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  if (opts.token) {
    // The human path: a real IdP token, the same credential a browser presents.
    headers["authorization"] = "Bearer " + opts.token;
  } else if (opts.obo) {
    // The service path. The guard requires the service token here and THEN reads the envelope, so
    // both are always sent together; sending the envelope alone yields a bare 401 that looks like a
    // credential problem rather than a missing envelope.
    headers["authorization"] = "Bearer " + config.serviceToken;
    headers["x-obo-provider"] = opts.obo.provider;
    headers["x-obo-external-id"] = opts.obo.externalId;
    if (opts.obo.agent) headers["x-obo-agent"] = opts.obo.agent;
    if (opts.obo.actFor) headers["x-act-for"] = opts.obo.actFor;
  }

  const started = Date.now();
  let status = 0;
  let raw = "";
  let parsed: T | null = null;
  let transportError: string | undefined;

  if (config.dryRun && method !== "GET") {
    // A dry run still exercises reads (harmless, and they surface plenty) but never writes.
    return { status: 0, ok: true, body: null, raw: "[dry-run]", ms: 0 };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
      status = res.status;
      raw = await res.text();
      if (raw) {
        try {
          parsed = JSON.parse(raw) as T;
        } catch {
          // Left null on purpose. A non-JSON body from a JSON API is itself informative, and the
          // excerpt below preserves it for the corpus.
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    transportError = (err as Error).name === "AbortError" ? "timeout" : (err as Error).message;
  }

  const ms = Date.now() - started;
  const expected = opts.expect;
  const ok = transportError ? false : expected ? expected.includes(status) : status >= 200 && status < 400;

  const step = logStep({
    scenario: opts.scenario,
    step: opts.step,
    actor: opts.actor,
    request: {
      method,
      url,
      ...(opts.body && typeof opts.body === "object" ? { bodyKeys: Object.keys(opts.body as object) } : {}),
    },
    response: {
      status,
      ms,
      ok,
      ...(transportError ? { error: transportError } : {}),
      // Bounded excerpt: enough to diagnose, never enough to turn the corpus into a copy of the DB.
      ...(raw && !ok ? { bodyExcerpt: raw.slice(0, 600) } : {}),
    },
  });

  // ── Judgements ────────────────────────────────────────────────────────────────────────────────
  // A malformed path segment reaching the server at all. This catches the whole class the first
  // probe run found, at whichever layer produced it, and it is checked before the status because a
  // literal "undefined" in a URL is wrong even on a 200.
  if (/\/(undefined|null|NaN|\[object%20Object\])(\/|$|[?])/.test(url)) {
    logFinding({
      key: "malformed-path-segment",
      severity: "high",
      title: "A request was built with a literal 'undefined'/'null' path segment",
      detail:
        "The caller stringified a missing value directly into the URL. Downstream this reaches the database as text where a uuid is expected. Whatever built this URL is missing an argument check.",
      evidence: { url, method, status, scenario: opts.scenario, step: opts.step, actorPath: opts.actor.path },
    });
  }

  if (transportError) {
    logFinding({
      key: "transport-" + transportError,
      severity: transportError === "timeout" ? "high" : "medium",
      title: "Request did not complete: " + transportError,
      detail: "No HTTP status was returned. Either the service is down, the request exceeded the timeout, or the network path is broken.",
      evidence: { url, method, ms, scenario: opts.scenario, step: opts.step },
    });
  } else if (status >= 500) {
    logFinding({
      key: "5xx " + method + " " + opts.path.replace(/[0-9a-f-]{36}/gi, ":id"),
      severity: "high",
      title: status + " from " + method + " " + opts.path,
      detail:
        "A 5xx is always a defect. Invalid input should be rejected with a 4xx; a 5xx means the server did not anticipate this request. Check for an unhandled exception in the service log.",
      evidence: { url, method, status, bodyExcerpt: raw.slice(0, 400), actorPath: opts.actor.path, actor: opts.actor.name },
    });
  } else if (!ok && expected === undefined && (status === 401 || status === 403)) {
    // Not automatically a defect: it may be authz working correctly. Recorded as info so the
    // summary's parity table can decide, since the interesting version of this is "denied for an
    // agent, allowed for a human" and that is only visible in aggregate.
    logFinding({
      key: "authz-" + status + " " + method + " " + opts.path.replace(/[0-9a-f-]{36}/gi, ":id"),
      severity: "info",
      title: status + " for " + opts.actor.path + " on " + method + " " + opts.path,
      detail:
        "Authorization refused this call. Correct or not depends on intent; the parity table in summary.json shows whether another identity path was allowed the same endpoint.",
      evidence: { url, method, status, actorPath: opts.actor.path, actor: opts.actor.name, bodyExcerpt: raw.slice(0, 300) },
    });
  } else if (!ok && expected === undefined && status === 400) {
    logFinding({
      key: "400 " + method + " " + opts.path.replace(/[0-9a-f-]{36}/gi, ":id"),
      severity: "medium",
      title: "400 from " + method + " " + opts.path,
      detail:
        "The server rejected the body the harness sent. Either the harness has drifted from the real contract (the frontend-first drift this program warns about) or the endpoint rejects something it should accept.",
      evidence: { url, method, bodyKeys: opts.body && typeof opts.body === "object" ? Object.keys(opts.body as object) : [], bodyExcerpt: raw.slice(0, 400) },
    });
  }

  if (ms > SLOW_MS) {
    logFinding({
      key: "slow " + method + " " + opts.path.replace(/[0-9a-f-]{36}/gi, ":id"),
      severity: "low",
      title: "Slow response (" + ms + "ms) from " + method + " " + opts.path,
      detail: "Recorded to catch endpoints that degrade under sustained real work rather than in a single cold probe.",
      evidence: { url, method, ms, status },
    });
  }

  void step;
  return { status, ok, body: parsed, raw, ms };
}
