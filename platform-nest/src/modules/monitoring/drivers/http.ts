// MON-11c — the `http` and `keyword` drivers. Both dial tenant-supplied hostnames, so every request
// goes through the MON-11b egress guard. There is exactly ONE place in this file that creates an
// agent, and it always installs `createGuardedLookup`.
//
// ── WHY MANUAL REDIRECTS ────────────────────────────────────────────────────────────────────────
// `fetch`/undici follows redirects internally and gives no hook to re-validate each hop. That is a
// hole, not an inconvenience: an allowlisted public URL can 302 to 169.254.169.254, and if the
// library follows it the guard never sees the second host. So this uses node:http(s) with
// `followRedirects` off and walks the chain itself, re-checking EVERY hop against the allowlist and
// the IP classifier. A redirect is a new dial and is treated as one.
//
// ── WHY `keyword` EXISTS AS A SEPARATE KIND ─────────────────────────────────────────────────────
// A hacked WordPress serves 200 with pharma spam. A PHP fatal serves 200 with a blank page. A status
// check calls both healthy. For an agency that is the ACTUAL failure mode, so content assertions are
// a first-class kind rather than an option on `http` — and the registry refuses a body assertion on
// plain `http`, so an operator cannot believe they configured one when they did not.
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import net from "node:net";
import { createGuardedLookup, isDeniedAddress, isHostAllowlisted, normalizeHost } from "./egress";
import type { MonitorDriver, ProbeCtx, ProbeResult } from "./registry";

export interface HttpConfig {
  url: string;
  expectStatus: number;
  method: "GET" | "HEAD";
}

export interface KeywordConfig extends HttpConfig {
  /** Text the body MUST contain. */
  expect?: string;
  /** Text the body must NOT contain — the defacement/spam-signature side. */
  forbid?: string;
}

const MAX_REDIRECTS = 5;
/** Cap the body we read. A monitor must not be turned into a memory-exhaustion vector by its target. */
const MAX_BODY_BYTES = 256 * 1024;

function parseUrl(raw: unknown, field = "url"): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${field} is required`);
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  // Only http(s). file:, gopher:, ftp: etc. are classic SSRF pivots, and no client website needs them.
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${field} must be http or https, got ${u.protocol}`);
  }
  return u;
}

export function validateHttpConfig(config: unknown): HttpConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  const u = parseUrl(c.url);
  const expectStatus = c.expectStatus === undefined ? 200 : Number(c.expectStatus);
  if (!Number.isInteger(expectStatus) || expectStatus < 100 || expectStatus > 599) {
    throw new Error("expectStatus must be an integer HTTP status");
  }
  const method = c.method === "HEAD" ? "HEAD" : "GET";
  return { url: u.toString(), expectStatus, method };
}

export function validateKeywordConfig(config: unknown): KeywordConfig {
  const base = validateHttpConfig(config);
  const c = (config ?? {}) as Record<string, unknown>;
  const expect = typeof c.expect === "string" && c.expect.trim() ? c.expect : undefined;
  const forbid = typeof c.forbid === "string" && c.forbid.trim() ? c.forbid : undefined;
  if (!expect && !forbid) {
    // A content check with no assertion is a plain status check wearing a costume: it would report
    // "up" while the operator believes their page content is being verified.
    throw new Error("a content check needs `expect` or `forbid` — otherwise it asserts nothing");
  }
  // HEAD returns no body, so a body assertion against it can never be evaluated.
  return { ...base, method: "GET", expect, forbid };
}

interface RawResponse {
  status: number;
  body: string;
  latencyMs: number;
}

/**
 * THE ONLY agent-creating path in this module. Every request it makes is bound to the caller's
 * allowlist and audit sink. A driver that built its own agent would bypass the guard entirely, which
 * is how this class of protection usually fails — `http.test.ts` pins that no other agent exists.
 */
async function guardedRequest(url: URL, ctx: ProbeCtx, method: string, hops = 0): Promise<RawResponse> {
  if (hops > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);

  // Re-checked on EVERY hop, not just the first: a redirect is a new dial.
  if (!isHostAllowlisted(url.hostname, ctx.allowlistHosts)) {
    ctx.audit({ host: normalizeHost(url.hostname), allowed: false, reason: "not_allowlisted" });
    throw new Error(`egress refused: ${url.hostname} is not allowlisted (redirect hop ${hops})`);
  }

  // Node SKIPS DNS for an IP-literal host, so the agent's `lookup` is never called and the IP
  // classifier would never run. Proven empirically, not assumed. That made the guard's protection
  // conditional on DNS happening at all -- fine for a hostname, a bypass for `http://169.254.169.254/`.
  // The allowlist is derived from verified properties so this was not trivially reachable, but
  // "safe only when DNS occurs" is not an invariant worth resting on.
  const denied = ctx.isDeniedOverride ?? isDeniedAddress;
  const literal = net.isIP(url.hostname) !== 0;
  if (literal && denied(url.hostname)) {
    ctx.audit({ host: normalizeHost(url.hostname), allowed: false, reason: "private_ip" });
    throw new Error(`egress refused: ${url.hostname} is a non-public address`);
  }

  const mod = url.protocol === "https:" ? https : http;
  const AgentCtor = url.protocol === "https:" ? https.Agent : http.Agent;
  const agent = new AgentCtor({
    lookup: createGuardedLookup(ctx.allowlistHosts, ctx.audit, ctx.isDeniedOverride) as never,
    keepAlive: false,
  });

  const started = Date.now();
  return await new Promise<RawResponse>((resolve, reject) => {
    const req = mod.request(
      url,
      { method, agent, timeout: ctx.timeoutMs, headers: { "user-agent": "gaiada-monitor/1.0" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // drain, or the socket lingers
          let next: URL;
          try {
            next = parseUrl(new URL(location, url).toString(), "redirect target");
          } catch (e) {
            reject(e as Error);
            return;
          }
          guardedRequest(next, ctx, method, hops + 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (d: Buffer) => {
          size += d.length;
          if (size <= MAX_BODY_BYTES) chunks.push(d);
          else res.destroy(); // stop reading; we have enough to evaluate an assertion
        });
        res.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks).toString("utf8"), latencyMs: Date.now() - started }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${ctx.timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

export const httpDriver: MonitorDriver<HttpConfig> = {
  kind: "http",
  capabilities: ["status", "latency", "redirect"],
  validate: validateHttpConfig,
  async probe(config, ctx): Promise<ProbeResult> {
    try {
      const res = await guardedRequest(new URL(config.url), ctx, config.method);
      if (res.status !== config.expectStatus) {
        return {
          status: "down",
          latencyMs: res.latencyMs,
          detail: `expected HTTP ${config.expectStatus}, got ${res.status}`,
        };
      }
      return { status: "up", latencyMs: res.latencyMs, detail: null };
    } catch (e) {
      // `down`, never `unknown`: we reached a definite conclusion (it did not answer correctly).
      // `unknown` is reserved for "we did not check", and conflating them would let a real outage
      // render as an un-run check.
      return { status: "down", latencyMs: null, detail: (e as Error).message };
    }
  },
};

export const keywordDriver: MonitorDriver<KeywordConfig> = {
  kind: "keyword",
  capabilities: ["status", "latency", "body_contains", "body_absent"],
  validate: validateKeywordConfig,
  async probe(config, ctx): Promise<ProbeResult> {
    try {
      const res = await guardedRequest(new URL(config.url), ctx, "GET");
      if (res.status !== config.expectStatus) {
        return { status: "down", latencyMs: res.latencyMs, detail: `expected HTTP ${config.expectStatus}, got ${res.status}` };
      }
      if (config.forbid && res.body.includes(config.forbid)) {
        // DOWN, not degraded: forbidden content is the defacement/spam signal, and a compromised
        // page serving 200 is the failure this kind exists to catch.
        return { status: "down", latencyMs: res.latencyMs, detail: `body contains forbidden text` };
      }
      if (config.expect && !res.body.includes(config.expect)) {
        // DEGRADED, not down: the server answered correctly and the page is reachable, but it is not
        // serving what it should. A human reading the board should see those as different situations.
        return { status: "degraded", latencyMs: res.latencyMs, detail: `body does not contain the expected text` };
      }
      return { status: "up", latencyMs: res.latencyMs, detail: null };
    } catch (e) {
      return { status: "down", latencyMs: null, detail: (e as Error).message };
    }
  },
};
