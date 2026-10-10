// WSK-48b -- the /v1 golden harness. It replaces the old-router-vs-api differential (WSK-48a), which
// needed the Payload router; Payload is gone, the api is the reference now.
//
// The differential had already proved, request by request, that the api answers the contract
// replay (24 pairs + 1 status-only) and the extra corpus (662 pairs + 6 status-only: the error paths
// and edge cases) byte for byte like the old router, apart from the named M3 T1 divergences. Those
// responses are now recorded FROM THE API into committed golden files (./golden/*.json) and each run
// compares what the api answers against them.
//
// WHAT IS COMPARED, per request: status; the `content-type` and `cache-tag` response headers
// (present-or-absent too, as the differential did); the NORMALISED body, byte for byte. The request
// itself (method, normalised path and query, normalised headers) is part of the entry, so a corpus
// change shows up as a golden change. Every pair is compared in full, including the old "status-only"
// class (paths outside /v1/): the api's own 404 is the reference now.
//
// NORMALISATION -- everything volatile, by explicit rules, applied to request and response alike,
// in this order. Tokens are numbered by FIRST APPEARANCE within one corpus run, and one value always
// gets one token, so equality inside a recording (two rows sharing an id, a timestamp) is preserved:
//   1. api keys        `wdsk_test_<32 hex>`                      -> `<key:N>`
//   2. tenant slugs    `wsk06-<label>-<8 hex>`                   -> `wsk06-<label>-<sfx>`  (the label is
//                      the fixture's own, so tenants stay distinguishable)
//   3. cursors         the base64url value of `"cursor":"..."` in a body and `cursor=` in a query:
//                      decoded, rules 4 and 5 applied to the decoded text, kept readable as
//                      `<cursor:...>`; only when it decodes to text containing `|` and re-encodes to
//                      the same string (hand-made garbage cursors stay literal, they are constants)
//   4. uuids           any 8-4-4-4-12 hex                        -> `<uuid:N>`
//   5. timestamps      ISO-8601 (T or space separated, optional fraction and zone) that fall within
//                      +-2 days of the run's start (fixture rows, `now()` defaults, relative publish
//                      times, sitemap lastmod)                   -> `<ts:N>`; constants such as the
//                      crafted 2020 / 2999 cursor dates stay literal
// A fixture row's id ordering matters where rows share one created_at (the cursor's id tie-break):
// the corpus gives those rows ids whose first byte fixes their order, so the order is deterministic.
// Nothing else is rewritten.
//
// RECORD MODE: `WEBDESK_V1_GOLDEN_RECORD=1` makes the spec write the golden files instead of
// comparing (to ./golden/, or to the directory in `WEBDESK_V1_GOLDEN_DIR`). A change to /v1's bytes is
// then a reviewed diff of those files. The files were recorded twice, on two fresh databases, and were
// byte-identical (the WSK-48b determinism proof).
import fs from "node:fs";
import path from "node:path";
import type { V1Handle } from "./envelope-contract";

export type WireResponse = { status: number; body: Buffer; headers: Record<string, string> };
export type PairSpec = { method?: string; pathAndQuery: string; headers?: Record<string, string>; body?: string };
/** A behaviour the api changed on purpose in M3 T1 (the old Payload router had it differently); recorded as an annotation. */
export type IntendedDivergence = { name: string };
export type PairOptions = { note?: string; intended?: IntendedDivergence; normalizeRequestId?: boolean };
/** Sends one request to the api and records it; resolves to the raw (un-normalised) wire response. */
export type RecordPair = (spec: PairSpec | Request, opts?: PairOptions) => Promise<WireResponse>;

export type GoldenEntry = {
  request: { method: string; path: string; headers: Record<string, string>; body?: string };
  note?: string;
  intended?: string;
  status: number;
  contentType: string | null;
  cacheTag: string | null;
  body: string;
};

const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;

export class Normalizer {
  private keys = new Map<string, string>();
  private uuids = new Map<string, string>();
  private stamps = new Map<string, string>();
  constructor(private readonly runStart: number = Date.now()) {}

  private token(map: Map<string, string>, kind: string, value: string): string {
    let t = map.get(value);
    if (!t) {
      t = `<${kind}:${map.size + 1}>`;
      map.set(value, t);
    }
    return t;
  }

  private nearNow(raw: string): boolean {
    // "+00" / "+0000" zones and "YYYY-MM-DD HH:MM:SS" (no zone = UTC) both parse once made ISO-like.
    let s = raw.replace(" ", "T");
    s = s.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(s)) s += "Z";
    const t = Date.parse(s);
    return Number.isFinite(t) && Math.abs(t - this.runStart) <= TWO_DAYS_MS;
  }

  /** Rules 1, 2, 4 and 5. Not cursor-aware: callers go through `text`. */
  private plain(s: string): string {
    return s
      .replace(/wdsk_test_[0-9a-f]{32}/g, (m) => this.token(this.keys, "key", m))
      .replace(/wsk06-([a-z]+)-[0-9a-f]{8}/g, "wsk06-$1-<sfx>")
      .replace(UUID_RE, (m) => this.token(this.uuids, "uuid", m))
      .replace(TS_RE, (m) => (this.nearNow(m) ? this.token(this.stamps, "ts", m) : m));
  }

  private cursor(value: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return this.plain(value);
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (decoded.includes("|") && Buffer.from(decoded, "utf8").toString("base64url") === value) return `<cursor:${this.plain(decoded)}>`;
    return this.plain(value);
  }

  /** All rules, cursors first (a cursor embeds a uuid and a timestamp the later rules would otherwise miss). */
  text(s: string): string {
    const bodyCursors = s.replace(/("cursor":")([A-Za-z0-9_-]+)(")/g, (_m, a, v, c) => a + this.cursor(v) + c);
    const queryCursors = bodyCursors.replace(/([?&]cursor=)([^&#]*)/g, (_m, a, v) => {
      let raw = v;
      try {
        raw = decodeURIComponent(v);
      } catch {
        /* keep as sent */
      }
      return a + this.cursor(raw);
    });
    return this.plain(queryCursors);
  }
}

/** A golden recording of one corpus run against the api alone. */
export function createGoldenRecorder(opts: { baseUrl: string }) {
  const norm = new Normalizer();
  const entries: GoldenEntry[] = [];
  let seq = 0;

  const send = async (spec: Required<Pick<PairSpec, "method" | "pathAndQuery">> & PairSpec): Promise<WireResponse> => {
    const res = await fetch(opts.baseUrl + spec.pathAndQuery, { method: spec.method, headers: spec.headers, body: spec.body, redirect: "manual" });
    const body = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, body, headers };
  };

  const specFrom = (r: PairSpec | Request): Required<Pick<PairSpec, "method" | "pathAndQuery">> & PairSpec => {
    if (r instanceof Request) {
      const u = new URL(r.url);
      return { method: r.method, pathAndQuery: u.pathname + u.search, headers: Object.fromEntries(r.headers) };
    }
    return { method: "GET", headers: {}, ...r };
  };

  const recordPair: RecordPair = async (requestOrSpec, { note, intended, normalizeRequestId = false } = {}) => {
    const spec = specFrom(requestOrSpec);
    spec.headers = { ...spec.headers };
    // Same rule as the differential: a deterministic x-request-id on every request, so the body's
    // requestId is a constant; a request that already carries one keeps it. The probes that send none
    // (`normalizeRequestId`) get a random one from the api, which the uuid rule neutralises.
    if (!normalizeRequestId && !Object.keys(spec.headers).some((h) => h.toLowerCase() === "x-request-id")) {
      spec.headers["x-request-id"] = `diff-${++seq}`;
    }
    const res = await send(spec);
    const text = res.body.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(res.body)) throw new Error(`golden: ${spec.method} ${spec.pathAndQuery} answered non-UTF-8 bytes`);
    const reqHeaders: Record<string, string> = {};
    for (const k of Object.keys(spec.headers).sort()) reqHeaders[k] = norm.text(spec.headers[k]);
    entries.push({
      request: { method: spec.method, path: norm.text(spec.pathAndQuery), headers: reqHeaders, ...(spec.body !== undefined ? { body: spec.body } : {}) },
      ...(note ? { note } : {}),
      ...(intended ? { intended: intended.name } : {}),
      status: res.status,
      contentType: res.headers["content-type"] ?? null,
      cacheTag: res.headers["cache-tag"] === undefined ? null : norm.text(res.headers["cache-tag"]),
      body: norm.text(text),
    });
    return res;
  };

  /** Drop-in for the contract suite's handleV1Request: sends to the api, records, returns the real response. */
  const handleV1Request: V1Handle = async (request) => {
    const res = await recordPair(request);
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (!["date", "connection", "keep-alive", "transfer-encoding", "content-length"].includes(k)) headers.set(k, v);
    const nullBody = res.status === 204 || res.status === 304;
    return new Response(nullBody ? null : res.body, { status: res.status, headers });
  };

  return { recordPair, handleV1Request, entries };
}

export function goldenDir(): string {
  return process.env.WEBDESK_V1_GOLDEN_DIR || path.join(__dirname, "golden");
}

/** One entry per line inside a JSON array: valid JSON, and a golden change is a readable per-request diff. */
export function serializeGolden(entries: GoldenEntry[]): string {
  return `[\n${entries.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`;
}

export function writeGolden(name: string, entries: GoldenEntry[]): void {
  fs.mkdirSync(goldenDir(), { recursive: true });
  fs.writeFileSync(path.join(goldenDir(), `${name}.json`), serializeGolden(entries));
}

export function readGolden(name: string): GoldenEntry[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "golden", `${name}.json`), "utf8")) as GoldenEntry[];
}

/** Human-readable differences between a recording and the committed golden (empty = identical). */
export function diffGolden(actual: GoldenEntry[], golden: GoldenEntry[]): string[] {
  const out: string[] = [];
  if (actual.length !== golden.length) out.push(`entry count: recorded ${actual.length}, golden ${golden.length}`);
  for (let i = 0; i < Math.min(actual.length, golden.length); i++) {
    if (JSON.stringify(actual[i]) === JSON.stringify(golden[i])) continue;
    const g = golden[i];
    const a = actual[i];
    const why: string[] = [];
    if (JSON.stringify(a.request) !== JSON.stringify(g.request)) why.push(`request ${JSON.stringify(a.request)} vs golden ${JSON.stringify(g.request)}`);
    if (a.status !== g.status) why.push(`status ${a.status} vs golden ${g.status}`);
    if (a.contentType !== g.contentType) why.push(`content-type ${a.contentType} vs golden ${g.contentType}`);
    if (a.cacheTag !== g.cacheTag) why.push(`cache-tag ${a.cacheTag} vs golden ${g.cacheTag}`);
    if (a.body !== g.body) why.push(`body ${JSON.stringify(a.body.slice(0, 300))} vs golden ${JSON.stringify(g.body.slice(0, 300))}`);
    if (!why.length) why.push("annotation (note/intended) differs");
    out.push(`#${i} ${g.request.method} ${g.request.path}: ${why.join(" | ")}`);
    if (out.length >= 25) {
      out.push("... (more differences not shown)");
      break;
    }
  }
  return out;
}
