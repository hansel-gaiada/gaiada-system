// WSK-48a (tests port) — the differential gate's engine, ported from
// webdesk/payload/test/lib-v1-differential.mjs. It serves the OLD Payload-hosted router
// (payload/collections/router.ts `handleV1Request`, behind a plain Node http.Server) and the NEW
// api route side by side, sends every request to BOTH over real HTTP, and compares what actually
// crosses the wire.
//
// The comparison rules are the original's, unchanged:
// COMPARED, exactly: status code; body bytes (Buffer.equals — not parsed JSON); the `content-type`
// header; the `cache-tag` header (present-or-absent too).
// STATUS-ONLY class (counted separately, never folded into 'identical'): a path outside the /v1
// prefix. The old router FUNCTION answers those with its own 404, but in the old deployment it was
// only reached through public-gateway.mjs's `^/v1/` allowlist; in the new one Nest answers them.
// Different servers by design, so only "both answer the same status" is asserted.
// KNOWN FRAMEWORK DIVERGENCE (listed, counted separately): a raw '%' not followed by two hex digits
// in the PATH. Fastify refuses such a URL itself (400 FST_ERR_BAD_URL) before any route runs; the
// bare router function never saw that input class (Next.js sat in front of it in production).
// NOT compared (reported as informational header-NAME diffs): date, connection, keep-alive,
// framing headers, and the api's added x-ratelimit-*. Per-request values are neutralised by sending
// the SAME explicit `x-request-id` to both sides, so nothing in any body is ignored or rewritten —
// except `normalizeRequestId` probes, which send no x-request-id and compare after replacing the
// one random UUID in `requestId`.
//
// What changed in the port: module-level state and the process 'exit' hook became one object per
// run (createV1Differential), so a single vitest file can run several passes.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { V1Handle } from "./envelope-contract";

export type WireResponse = { status: number; body: Buffer; headers: Record<string, string> };
export type PairSpec = { method?: string; pathAndQuery: string; headers?: Record<string, string>; body?: string };
export type PairOptions = { normalizeRequestId?: boolean; note?: string };
export type Pair = { old: WireResponse; neu: WireResponse; same: boolean };
export type ComparePair = (spec: PairSpec | Request, opts?: PairOptions) => Promise<Pair>;

export type DiffStats = {
  pairs: number;
  identical: number;
  statusOnlyPairs: number;
  statusOnlyIdentical: number;
  knownDivergent: { request: string; old: number; new: number }[];
  mismatches: { request: string; note?: string; diffs: string[] }[];
  headerNameDiffs: Map<string, number>;
  byStatus: Map<string, number>;
};

const IGNORED_HEADER_NAMES = new Set(["date", "connection", "keep-alive", "transfer-encoding", "content-length"]);

/** Serve the old router function behind a real http.Server, exactly as the original harness did. */
export async function serveOldRouter(oldHandle: V1Handle): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.append(k, Array.isArray(v) ? v.join(", ") : v);
      const response = await oldHandle(new Request(`http://internal${req.url}`, { method: req.method, headers }));
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(599, { "content-type": "text/plain" }).end(`HARNESS: old router threw: ${(err as Error)?.stack || err}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function wire(base: string, spec: Required<Pick<PairSpec, "method" | "pathAndQuery">> & PairSpec): Promise<WireResponse> {
  const res = await fetch(base + spec.pathAndQuery, { method: spec.method, headers: spec.headers, body: spec.body, redirect: "manual" });
  const body = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, body, headers };
}

function specFrom(requestOrSpec: PairSpec | Request): Required<Pick<PairSpec, "method" | "pathAndQuery">> & PairSpec {
  if (requestOrSpec instanceof Request) {
    const u = new URL(requestOrSpec.url);
    return { method: requestOrSpec.method, pathAndQuery: u.pathname + u.search, headers: Object.fromEntries(requestOrSpec.headers) };
  }
  return { method: "GET", headers: {}, ...requestOrSpec };
}

function toResponse(w: WireResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(w.headers)) if (!IGNORED_HEADER_NAMES.has(k)) headers.set(k, v);
  // A null-body status (204/304) cannot carry a body in the Response constructor.
  const nullBody = w.status === 204 || w.status === 304;
  return new Response(nullBody ? null : w.body, { status: w.status, headers });
}

/**
 * One differential run. `target` picks whose responses the caller's assertions see through
 * `handleV1Request` ('api' = the new route; 'old' = the baseline proving the tee is neutral).
 */
export function createV1Differential(opts: { oldUrl: string; newUrl: string; target: "api" | "old"; label: string }) {
  const { oldUrl, newUrl, target, label } = opts;
  const stats: DiffStats = {
    pairs: 0,
    identical: 0,
    statusOnlyPairs: 0,
    statusOnlyIdentical: 0,
    knownDivergent: [],
    mismatches: [],
    headerNameDiffs: new Map(),
    byStatus: new Map(),
  };
  let seq = 0;

  const comparePair: ComparePair = async (requestOrSpec, { normalizeRequestId = false, note } = {}) => {
    const spec = specFrom(requestOrSpec);
    spec.headers = { ...spec.headers };
    if (!normalizeRequestId && !Object.keys(spec.headers).some((h) => h.toLowerCase() === "x-request-id")) {
      spec.headers["x-request-id"] = `diff-${++seq}`;
    }
    const old = await wire(oldUrl, spec);
    const neu = await wire(newUrl, spec);

    let oldBody = old.body;
    let newBody = neu.body;
    if (normalizeRequestId) {
      const norm = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/("requestId":")[0-9a-f-]{36}(")/, "$1<uuid>$2"), "utf8");
      oldBody = norm(old.body);
      newBody = norm(neu.body);
    }

    const outsideV1 = !spec.pathAndQuery.startsWith("/v1/"); // the old gateway's allowlist was ^/v1/ (so bare /v1 was outside it too)
    if (outsideV1) {
      stats.statusOnlyPairs++;
      if (old.status === neu.status) stats.statusOnlyIdentical++;
      else stats.mismatches.push({ request: `${spec.method} ${spec.pathAndQuery}`, note: "status-only class", diffs: [`status old=${old.status} new=${neu.status}`] });
      return { old, neu, same: old.status === neu.status };
    }
    const diffs: string[] = [];
    if (old.status !== neu.status) diffs.push(`status old=${old.status} new=${neu.status}`);
    if (!oldBody.equals(newBody)) {
      diffs.push(
        `body bytes differ (old ${oldBody.length}B / new ${newBody.length}B): old=${JSON.stringify(oldBody.toString("utf8").slice(0, 300))} new=${JSON.stringify(newBody.toString("utf8").slice(0, 300))}`,
      );
    }
    if ((old.headers["content-type"] ?? null) !== (neu.headers["content-type"] ?? null)) diffs.push(`content-type old=${old.headers["content-type"]} new=${neu.headers["content-type"]}`);
    if ((old.headers["cache-tag"] ?? null) !== (neu.headers["cache-tag"] ?? null)) diffs.push(`cache-tag old=${old.headers["cache-tag"]} new=${neu.headers["cache-tag"]}`);

    stats.pairs++;
    const key = `${spec.method} ${old.status}`;
    stats.byStatus.set(key, (stats.byStatus.get(key) ?? 0) + 1);
    const badEscape = /%(?![0-9A-Fa-f]{2})/.test(spec.pathAndQuery.split("?")[0]);
    if (diffs.length === 0) stats.identical++;
    else if (badEscape && neu.status === 400 && neu.body.toString("utf8").includes("FST_ERR_BAD_URL")) {
      stats.knownDivergent.push({ request: `${spec.method} ${spec.pathAndQuery}`, old: old.status, new: neu.status });
    } else stats.mismatches.push({ request: `${spec.method} ${spec.pathAndQuery}`, note, diffs });

    const names = (h: Record<string, string>) => new Set(Object.keys(h).filter((n) => !IGNORED_HEADER_NAMES.has(n)));
    const o = names(old.headers);
    const n = names(neu.headers);
    for (const h of n) if (!o.has(h)) stats.headerNameDiffs.set(`only-new:${h}`, (stats.headerNameDiffs.get(`only-new:${h}`) ?? 0) + 1);
    for (const h of o) if (!n.has(h)) stats.headerNameDiffs.set(`only-old:${h}`, (stats.headerNameDiffs.get(`only-old:${h}`) ?? 0) + 1);

    return { old, neu, same: diffs.length === 0 };
  };

  /** Drop-in for collections/router.ts#handleV1Request: tees the request to both servers. */
  const handleV1Request: V1Handle = async (request) => {
    const { old, neu } = await comparePair(request);
    return toResponse(target === "api" ? neu : old);
  };

  /** The original's report lines, verbatim in shape (the runner parsed them; we print them). */
  function reportLines(): string[] {
    const different = stats.mismatches.filter((m) => m.note !== "status-only class").length;
    const lines = [
      `[v1-diff] ${label}: target-for-assertions=${target} pairs=${stats.pairs} identical=${stats.identical} different=${different} known_divergent=${stats.knownDivergent.length} statusonly=${stats.statusOnlyPairs} statusonly_same=${stats.statusOnlyIdentical}`,
      `[v1-diff] ${label}: status mix (method status -> count): ${[...stats.byStatus].map(([k, v]) => `${k}=${v}`).sort().join(" ")}`,
      `[v1-diff] ${label}: informational response-header-name differences (not compared): ${[...stats.headerNameDiffs].map(([k, v]) => `${k}x${v}`).join(" ") || "none"}`,
    ];
    for (const k of stats.knownDivergent) lines.push(`[v1-diff] KNOWN-DIVERGENCE (invalid % escape -> Fastify FST_ERR_BAD_URL) ${k.request}: old status ${k.old}, new ${k.new}`);
    for (const m of stats.mismatches) lines.push(`[v1-diff] MISMATCH ${m.request}${m.note ? ` (${m.note})` : ""}\n    ${m.diffs.join("\n    ")}`);
    return lines;
  }

  return { comparePair, handleV1Request, stats, reportLines };
}
