// SM-49 — the vendor-envelope sandbox HTTP server (tracker §6u; design addendum §A10, binding). A
// TEST-HARNESS FIXTURE, never a deployable environment (§A10.2): every instance is created inside a
// test file's `beforeAll` via `startVendorSandbox()`, listens on `127.0.0.1` at an EPHEMERAL port
// (`:0`), and is torn down via its returned `close()` in `afterAll`. No compose service, no
// Dockerfile, no published port, no long-lived process — nothing here is reachable outside a test
// run, and nothing under `src/modules/search/` or `main.ts` imports this module (see
// egress-inventory.test.ts's exact-set-equality allowlist).
//
// WHY THIS LIVES OUTSIDE src/modules/search/ (tracker §6u file-ownership note, §6e's pin): this file
// makes a real `node:http` `createServer()`/`.listen()` call — an actual network primitive. Putting it
// inside `src/modules/search/` would add a 6th file to egress-inventory.test.ts's approved-egress
// allowlist, which is asserted by EXACT SET EQUALITY specifically so that allowlist stays a complete,
// deliberate inventory of every network reference in that module. This directory is *reached only* by
// the `*.sandbox.test.ts` integration files under `src/modules/search/providers/` (test files, which
// egress-inventory.test.ts's own scope note excludes: "Test files legitimately reference
// `fetch`-shaped fakes ... that do not originate any real outbound call").
//
// WHAT MAKES THIS STRICTER THAN AN INJECTED `fetchImpl` MOCK (§A10.5, AC 11): every existing
// `providers/*.test.ts` mock only ever answers what THAT test scripted for the one path it invoked —
// an unrecognized path, or a request missing a documented required field, simply never gets asked.
// This server is a real listening socket with its own routing table: an unknown path 404s, and a
// request missing a required parameter gets a vendor-shaped refusal rather than silently being served
// whatever fixture the handler happened to have on hand. A driver bug that sends a malformed request
// is caught HERE, at the wire, not hidden by a mock that only ever hears the happy path.
//
// FIXTURE-FILE-DRIVEN (§A10.6, AC 10): every response body below is built from an imported
// `fixtures/**` file, never an inline literal — see that directory's own per-file
// `UNVERIFIED-VENDOR-FIXTURE` marker (asserted by `fixtures.test.ts`) and SM-41's future duty to drop
// in real recordings as replacement fixtures with zero code change here.
//
// STATE IS PER-INSTANCE, NOT MODULE-SCOPED (AC 1's "fresh instance per test file" made structural, not
// just a testing convention): every piece of mutable state (DFS task-queue state, Ahrefs per-target
// true-up scripting, hit counters, seeded rows) lives inside `startVendorSandbox()`'s own closure,
// returned fresh on every call — exactly the same "no shared mutable singleton across concurrent
// scopes" property SM-42's AsyncLocalStorage fix enforces for the Ahrefs driver itself (types.ts),
// applied here to the harness that now exercises that very fix over a real socket (AC 8).
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { taskCreatedEntry } from "./fixtures/dataforseo/task-created";
import { taskPendingEntry } from "./fixtures/dataforseo/task-pending";
import { taskReadyEntry } from "./fixtures/dataforseo/task-ready";
import { taskRejectedEntry } from "./fixtures/dataforseo/task-rejected";
import { envelopeErrorBody } from "./fixtures/dataforseo/envelope-error";
import { keywordsSearchVolumeEntry, type KeywordVolumeRow } from "./fixtures/dataforseo/keywords-search-volume";
import { backlinksSummaryEntry } from "./fixtures/dataforseo/backlinks-summary";
import { aiVisibilityEntry } from "./fixtures/dataforseo/ai-visibility";

import { phraseOrganicText } from "./fixtures/semrush/phrase-organic";
import { phraseTheseText } from "./fixtures/semrush/phrase-these";
import { backlinksOverviewText } from "./fixtures/semrush/backlinks-overview";
import { ERROR_LINE_NOTHING_FOUND, ERROR_LINE_INVALID_KEY, errorLineMissingParam } from "./fixtures/semrush/error-line";

import { serpOverviewEnvelope } from "./fixtures/ahrefs/serp-overview";
import { keywordsExplorerOverviewEnvelope, type KeywordsExplorerRow } from "./fixtures/ahrefs/keywords-explorer-overview";
import { backlinksStatsEnvelope } from "./fixtures/ahrefs/backlinks-stats";
import { domainRatingEnvelope } from "./fixtures/ahrefs/domain-rating";
import { AHREFS_ERROR_BODY } from "./fixtures/ahrefs/error-401";

// ── sentinel substrings a test embeds in its OWN keyword/target to select sandbox behaviour ─────────
// (never a separate side channel — the same string the driver sends is what selects the response, so
// no test needs any handle into the sandbox beyond the subject string it already has to pass anyway).
export const DFS_NEVER_READY_MARKER = "sm49-neverready";
export const DFS_TASK_REJECTED_MARKER = "sm49-task-error";
export const DFS_ENVELOPE_ERROR_MARKER = "sm49-envelope-error";
export const SEMRUSH_ERROR_MARKER = "sm49-error";
export const AHREFS_ERROR_MARKER = "sm49-error";
// SM-67 (tracker §6be/§6bc, §A14.2 refuse-as-not-found) — a keyword containing this marker gets its
// task_get answer echoed back under a DIFFERENT `id` than the one task_post minted and the driver
// requested. Deterministic ids alone (taskIdFor) can never express this: the sandbox otherwise ALWAYS
// echoes the id it was asked for, which is exactly why the audit called this axis untestable via the
// existing harness — proving dataforseo.ts's identity check needs a harness that can lie about it.
export const DFS_TASK_ID_MISMATCH_MARKER = "sm67-id-mismatch";
// SM-68 (tracker §6be/§6bc, billing-adjacent) — a task_post request containing a keyword with this
// marker gets ONE extra, wholly UNREQUESTED task appended to the response's `tasks` array — modelling
// a vendor/intermediary response longer than what was posted (a duplicated array entry, a proxy
// replay). Structurally impossible to express by seeding a single row/keyword, since the whole point
// is a response entry with NO corresponding request entry at all.
export const DFS_EXTRA_TASK_MARKER = "sm68-extra-task";

export interface VendorSandboxCredentials {
  dataforseo: { login: string; password: string };
  semrush: { apiKey: string };
  ahrefs: { apiKey: string };
}

export interface AhrefsTrueUpScript {
  /** x-api-units-cost-total-actual to set on the backlinks-stats response for this target.
   *
   *  SM-66 (tracker §6be.1/§6bc): widened from `number` to `number | string` so a test can inject the
   *  exact vendor/intermediary anomaly this ticket's driver fix guards against — an empty, whitespace,
   *  negative, or non-finite header STRING — which a purely numeric field structurally cannot express
   *  (`Number` can't hold `""` or `"   "`). `String(...)` in the handler below is a no-op for an
   *  already-string value, so every existing numeric caller is unaffected byte-for-byte. This is
   *  exactly the harness-is-the-gap class §6be.1/§A10.5 names: a green sandbox run had validated our
   *  code against our own model of the vendor, and the model itself couldn't say "malformed". */
  statsUnits?: number | string;
  /** x-api-units-cost-total-actual to set on the domain-rating response for this target. Same SM-66
   *  widening as `statsUnits` above. */
  ratingUnits?: number | string;
  /** Artificial delay (ms) before the domain-rating response resolves, for this target — lets a test
   *  force two concurrent getBacklinkSummary() calls' internal HTTP calls to interleave (AC 8's
   *  concurrency proof), the same technique ahrefs.test.ts's own racing test uses. */
  ratingDelayMs?: number;
}

export interface VendorSandbox {
  origin: string;
  /** Total requests received across every vendor/route since start (or the last resetHitCounts()). */
  totalHits(): number;
  /** Requests received for one logical route, e.g. "dataforseo:task_get" — see `bump()` call sites in
   *  each vendor's handler below. Used to prove a cache hit issues ZERO new sandbox requests (AC 4)
   *  and that a DFS poll genuinely took >= 2 "pending" answers before going ready (AC 5). */
  hitCount(route: string): number;
  resetHitCounts(): void;
  /** Script a target's Ahrefs true-up header + delay for getBacklinkSummary's two parallel calls. */
  configureAhrefsTrueUp(target: string, script: AhrefsTrueUpScript): void;
  /** Seed the row a DataForSEO/Ahrefs keyword-metrics pull returns for one keyword (defaults to an
   *  all-zero row when unseeded — a test only seeds the keywords it actually asserts on). */
  seedDfsVolumeRow(keyword: string, row: KeywordVolumeRow): void;
  seedAhrefsVolumeRow(keyword: string, row: KeywordsExplorerRow): void;
  /** Seed the row a backlinks pull returns for one target. */
  /** `row.target`, when provided, is echoed back INSTEAD of the requested target — SM-69's harness
   *  widening for a vendor-echo-identity mismatch (see `dfsBacklinks`'s own doc comment above). Omit
   *  it (the default, every existing caller) to keep today's byte-for-byte behaviour: the requested
   *  target echoed correctly. */
  seedDfsBacklinks(target: string, row: { target?: string; backlinks: number; referring_domains: number; rank: number }): void;
  seedAhrefsBacklinks(target: string, row: { live: number; live_refdomains: number; domain_rating: number }): void;
  /** Semrush fixtures are rendered TEXT, not structured rows (the vendor's own wire format) — seed
   *  the exact line(s) a given phrase/target should return. Falls back to the shared fixture
   *  builders (fixtures/semrush/*.ts) with a zeroed row when unseeded. */
  seedSemrushPhraseOrganic(keyword: string, text: string): void;
  seedSemrushBacklinksOverview(target: string, text: string): void;
  setSemrushPhraseThese(text: string): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseBasicAuth(header: string | undefined): { login: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

function parseBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

interface DfsTaskState {
  keyword: string;
  pollsSeen: number;
  readyAfterPolls: number;
  neverReady: boolean;
  rejected: boolean;
  /** SM-67 — when true, the ready task_get answer's `id` field is a DIFFERENT string than the taskId
   *  this state is keyed by (and than the id the driver originally requested), modelling a vendor/
   *  intermediary echoing the wrong task under the id we asked for. */
  idMismatch: boolean;
}

/** Deterministic (djb2), never random — the sandbox must behave identically across two consecutive
 *  runs (tracker §6u AC 12: "suite deterministic, two consecutive green runs"). */
function taskIdFor(keyword: string): string {
  let h = 5381;
  for (let i = 0; i < keyword.length; i++) h = (h * 33) ^ keyword.charCodeAt(i);
  return `dfs-sandbox-task-${(h >>> 0).toString(16)}`;
}

function firstReqSubject(body: unknown, field: "keyword" | "keywords" | "target"): string {
  const arr = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
  const first = arr[0];
  if (!first) return "";
  const v = first[field];
  if (field === "keywords" && Array.isArray(v)) return String(v[0] ?? "");
  return typeof v === "string" ? v : "";
}

export async function startVendorSandbox(creds: VendorSandboxCredentials): Promise<VendorSandbox> {
  const dfsTasks = new Map<string, DfsTaskState>();
  const ahrefsTrueUp = new Map<string, AhrefsTrueUpScript>();
  const hits = new Map<string, number>();

  const semrushPhraseOrganic = new Map<string, string>();
  const semrushBacklinksOverview = new Map<string, string>();
  let semrushPhraseThese: string | undefined;

  const dfsVolumeRows = new Map<string, KeywordVolumeRow>();
  // SM-69 (tracker §6be/§6bc) — `target` is OPTIONAL and, when seeded, deliberately DIFFERENT from the
  // key this row is stored under: the handler below spreads `seeded` AFTER the request's own `target`
  // (`{ target, ...seeded }`), so a seeded `target` field wins and echoes a MISMATCHED value — the
  // vendor-echo-identity anomaly dataforseo.ts's getBacklinkSummary fix must not adopt. Without this
  // seeding capability the sandbox always echoes the requested target correctly (line below's default
  // has no `target` key at all), which is exactly why this axis was unverifiable via the harness before.
  const dfsBacklinks = new Map<string, { target?: string; backlinks: number; referring_domains: number; rank: number }>();
  const ahrefsVolumeRows = new Map<string, KeywordsExplorerRow>();
  const ahrefsBacklinks = new Map<string, { live: number; live_refdomains: number; domain_rating: number }>();

  function bump(route: string): void {
    hits.set(route, (hits.get(route) ?? 0) + 1);
  }

  async function handleDataForSeo(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const auth = parseBasicAuth(req.headers.authorization);
    const authOk = !!auth && auth.login === creds.dataforseo.login && auth.password === creds.dataforseo.password;

    if (!authOk) {
      bump("dataforseo:auth_refused");
      sendText(res, 401, "Unauthorized");
      return;
    }

    if (method === "POST" && (url.pathname === "/v3/serp/google/organic/task_post" || url.pathname === "/v3/serp/google/organic/live/advanced")) {
      const isLive = url.pathname.endsWith("/live/advanced");
      bump(isLive ? "dataforseo:live_advanced" : "dataforseo:task_post");
      const body = parseJsonBody(await readBody(req));
      const reqs = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
      if (reqs.some((r) => typeof r.keyword !== "string" || r.keyword.length === 0)) {
        sendJson(res, 200, envelopeErrorBody("Invalid Field: 'keyword' is required."));
        return;
      }
      const tasks = reqs.map((r) => {
        const keyword = String(r.keyword);
        const taskId = taskIdFor(keyword);
        if (keyword.includes(DFS_TASK_REJECTED_MARKER)) {
          dfsTasks.set(taskId, { keyword, pollsSeen: 0, readyAfterPolls: 0, neverReady: false, rejected: true, idMismatch: false });
          return taskRejectedEntry({ taskId });
        }
        dfsTasks.set(taskId, {
          keyword,
          pollsSeen: 0,
          readyAfterPolls: keyword.includes(DFS_NEVER_READY_MARKER) ? Number.POSITIVE_INFINITY : isLive ? 0 : 2,
          neverReady: keyword.includes(DFS_NEVER_READY_MARKER),
          rejected: false,
          idMismatch: keyword.includes(DFS_TASK_ID_MISMATCH_MARKER),
        });
        return taskCreatedEntry({ taskId, keyword });
      });
      // SM-68 — one keyword in the batch carrying this marker is enough to make the sandbox append a
      // WHOLLY UNREQUESTED extra task to the response, modelling a vendor/intermediary response longer
      // than what was posted. The phantom task is a real, retrievable task_get state (so a driver that
      // (wrongly) tried to collect it wouldn't hit a 404 and mask the real bug) — it is simply not one
      // of `reqs`.
      if (reqs.some((r) => typeof r.keyword === "string" && r.keyword.includes(DFS_EXTRA_TASK_MARKER))) {
        const phantomKeyword = `sm68-phantom-unrequested-task-${tasks.length}`;
        const phantomId = taskIdFor(phantomKeyword);
        dfsTasks.set(phantomId, { keyword: phantomKeyword, pollsSeen: 0, readyAfterPolls: 0, neverReady: false, rejected: false, idMismatch: false });
        tasks.push(taskCreatedEntry({ taskId: phantomId, keyword: phantomKeyword }));
      }
      sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks });
      return;
    }

    const taskGetMatch = /^\/v3\/serp\/google\/organic\/task_get\/advanced\/(.+)$/.exec(url.pathname);
    if (method === "GET" && taskGetMatch) {
      bump("dataforseo:task_get");
      const taskId = decodeURIComponent(taskGetMatch[1]);
      const state = dfsTasks.get(taskId);
      if (!state) {
        sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [{ id: taskId, status_code: 40400, status_message: "Task Not Found.", result: null }] });
        return;
      }
      if (state.rejected) {
        sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [taskRejectedEntry({ taskId })] });
        return;
      }
      state.pollsSeen += 1;
      if (state.neverReady || state.pollsSeen <= state.readyAfterPolls) {
        sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [taskPendingEntry({ taskId })] });
        return;
      }
      // SM-67 — echo a DIFFERENT id than the one just looked up by when idMismatch was scripted at
      // task_post time. The lookup above still succeeds (real DFS would also route by the URL's
      // path-segment id, then return whatever it thinks that task is) — only the response BODY's own
      // `id` field lies, which is the one field dataforseo.ts's fix must catch.
      const readyId = state.idMismatch ? `${taskId}-vendor-swapped` : taskId;
      sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [taskReadyEntry({ taskId: readyId, keyword: state.keyword })] });
      return;
    }

    if (method === "POST" && url.pathname === "/v3/keywords_data/google_ads/search_volume/live") {
      bump("dataforseo:search_volume");
      const body = parseJsonBody(await readBody(req));
      const arr = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
      const keywordsArr = Array.isArray(arr[0]?.keywords) ? (arr[0]!.keywords as string[]) : [];
      if (keywordsArr.length === 0) {
        sendJson(res, 200, envelopeErrorBody("Invalid Field: 'keywords' is required."));
        return;
      }
      if (keywordsArr[0].includes(DFS_ENVELOPE_ERROR_MARKER)) {
        sendJson(res, 200, envelopeErrorBody("Auth error. You have not enough money on your account."));
        return;
      }
      const rows = keywordsArr.map((k) => dfsVolumeRows.get(k) ?? { keyword: k, search_volume: 0, cpc: 0, keyword_difficulty: 0 });
      // dataforseo.ts reads `res.tasks?.[0]?.result` — the top-level envelope MUST wrap the per-task
      // entry in a `tasks` array, exactly like task_post/task_get above (this endpoint is still a
      // "task" in DataForSEO's own model, just synchronous).
      sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [keywordsSearchVolumeEntry(rows)] });
      return;
    }

    if (method === "POST" && url.pathname === "/v3/backlinks/summary/live") {
      bump("dataforseo:backlinks_summary");
      const body = parseJsonBody(await readBody(req));
      const target = firstReqSubject(body, "target");
      if (!target) {
        sendJson(res, 200, envelopeErrorBody("Invalid Field: 'target' is required."));
        return;
      }
      if (target.includes(DFS_ENVELOPE_ERROR_MARKER)) {
        sendJson(res, 200, envelopeErrorBody("Auth error. You have not enough money on your account."));
        return;
      }
      const seeded = dfsBacklinks.get(target) ?? { backlinks: 0, referring_domains: 0, rank: 0 };
      // dataforseo.ts reads `res.tasks?.[0]?.result?.[0]` — same tasks-array wrapping requirement.
      sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [backlinksSummaryEntry({ target, ...seeded })] });
      return;
    }

    if (method === "POST" && url.pathname === "/v3/serp/google/ai_mode/live/advanced") {
      bump("dataforseo:ai_visibility");
      const body = parseJsonBody(await readBody(req));
      const query = firstReqSubject(body, "keyword");
      if (!query) {
        sendJson(res, 200, envelopeErrorBody("Invalid Field: 'keyword' is required."));
        return;
      }
      if (query.includes(DFS_ENVELOPE_ERROR_MARKER)) {
        sendJson(res, 200, envelopeErrorBody("Auth error. You have not enough money on your account."));
        return;
      }
      const citedUrl = `https://sandbox-ai-cited.example/${encodeURIComponent(query)}`;
      // dataforseo.ts reads `res.tasks?.[0]?.result?.[0]?.items` — same tasks-array wrapping requirement.
      sendJson(res, 200, { status_code: 20000, status_message: "Ok.", tasks: [aiVisibilityEntry({ query, citedUrl })] });
      return;
    }

    bump("dataforseo:unknown_path");
    sendJson(res, 404, { status_code: 40400, status_message: "Not Found." });
  }

  async function handleSemrush(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    bump("semrush:request");
    const key = url.searchParams.get("key");
    const type = url.searchParams.get("type");

    if (!key || key !== creds.semrush.apiKey) {
      bump("semrush:auth_refused");
      sendText(res, 200, ERROR_LINE_INVALID_KEY);
      return;
    }

    if (type === "phrase_organic") {
      bump("semrush:phrase_organic");
      const phrase = url.searchParams.get("phrase");
      if (!phrase) {
        sendText(res, 200, errorLineMissingParam("phrase"));
        return;
      }
      if (phrase.includes(SEMRUSH_ERROR_MARKER)) {
        sendText(res, 200, ERROR_LINE_NOTHING_FOUND);
        return;
      }
      sendText(res, 200, semrushPhraseOrganic.get(phrase) ?? phraseOrganicText(phrase));
      return;
    }

    if (type === "phrase_these") {
      bump("semrush:phrase_these");
      const phrase = url.searchParams.get("phrase");
      if (!phrase) {
        sendText(res, 200, errorLineMissingParam("phrase"));
        return;
      }
      sendText(res, 200, semrushPhraseThese ?? phraseTheseText([]));
      return;
    }

    if (type === "backlinks_overview") {
      bump("semrush:backlinks_overview");
      const target = url.searchParams.get("target");
      if (!target) {
        sendText(res, 200, errorLineMissingParam("target"));
        return;
      }
      if (target.includes(SEMRUSH_ERROR_MARKER)) {
        sendText(res, 200, ERROR_LINE_NOTHING_FOUND);
        return;
      }
      sendText(res, 200, semrushBacklinksOverview.get(target) ?? backlinksOverviewText({ ascore: 0, total: 0, domains_num: 0 }));
      return;
    }

    bump("semrush:unknown_type");
    sendText(res, 200, errorLineMissingParam("type"));
  }

  async function handleAhrefs(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const token = parseBearer(req.headers.authorization);
    if (!token || token !== creds.ahrefs.apiKey) {
      bump("ahrefs:auth_refused");
      sendJson(res, 401, AHREFS_ERROR_BODY);
      return;
    }

    if (url.pathname === "/serp-overview/serp-overview") {
      bump("ahrefs:serp_overview");
      const keyword = url.searchParams.get("keyword");
      if (!keyword) {
        sendJson(res, 400, { error: "missing required parameter: keyword" });
        return;
      }
      // docs.ahrefs.com documents project_id as a REQUIRED param for this endpoint (ahrefs.ts's own
      // header) — the driver already refuses BEFORE any network call when it isn't configured, so
      // this branch is normally unreachable via the driver, but the ENDPOINT must enforce it too
      // (AC 11: the sandbox must be stricter than an injected mock, independent of what the driver
      // happens to check client-side).
      if (!url.searchParams.get("project_id")) {
        sendJson(res, 400, { error: "missing required parameter: project_id" });
        return;
      }
      sendJson(res, 200, serpOverviewEnvelope({ keyword }));
      return;
    }

    if (url.pathname === "/keywords-explorer/overview") {
      bump("ahrefs:keywords_explorer_overview");
      const keywordsParam = url.searchParams.get("keywords");
      if (!keywordsParam) {
        sendJson(res, 400, { error: "missing required parameter: keywords" });
        return;
      }
      const rows = keywordsParam.split(",").map((k) => ahrefsVolumeRows.get(k) ?? { keyword: k, volume: 0, difficulty: 0 });
      sendJson(res, 200, keywordsExplorerOverviewEnvelope(rows));
      return;
    }

    if (url.pathname === "/site-explorer/backlinks-stats") {
      bump("ahrefs:backlinks_stats");
      const target = url.searchParams.get("target");
      if (!target) {
        sendJson(res, 400, { error: "missing required parameter: target" });
        return;
      }
      if (target.includes(AHREFS_ERROR_MARKER)) {
        sendJson(res, 403, AHREFS_ERROR_BODY);
        return;
      }
      const script = ahrefsTrueUp.get(target);
      const seeded = ahrefsBacklinks.get(target) ?? { live: 0, live_refdomains: 0, domain_rating: 0 };
      const headers: Record<string, string> = script?.statsUnits !== undefined ? { "x-api-units-cost-total-actual": String(script.statsUnits) } : {};
      sendJson(res, 200, backlinksStatsEnvelope({ live: seeded.live, live_refdomains: seeded.live_refdomains }), headers);
      return;
    }

    if (url.pathname === "/site-explorer/domain-rating") {
      bump("ahrefs:domain_rating");
      const target = url.searchParams.get("target");
      if (!target) {
        sendJson(res, 400, { error: "missing required parameter: target" });
        return;
      }
      if (target.includes(AHREFS_ERROR_MARKER)) {
        sendJson(res, 403, AHREFS_ERROR_BODY);
        return;
      }
      const script = ahrefsTrueUp.get(target);
      if (script?.ratingDelayMs) await new Promise((r) => setTimeout(r, script.ratingDelayMs));
      const seeded = ahrefsBacklinks.get(target) ?? { live: 0, live_refdomains: 0, domain_rating: 0 };
      const headers: Record<string, string> = script?.ratingUnits !== undefined ? { "x-api-units-cost-total-actual": String(script.ratingUnits) } : {};
      sendJson(res, 200, domainRatingEnvelope({ domain_rating: seeded.domain_rating }), headers);
      return;
    }

    bump("ahrefs:unknown_path");
    sendJson(res, 404, { error: "not found" });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://sandbox.invalid");
    bump("__all__");
    // Semrush's classic API has exactly ONE real path — the bare root (semrush.ts's own call() always
    // fetches `${baseUrl}/?key=...`) — so it is matched EXACTLY, never as a catch-all fallback. A path
    // matching none of the three vendors' real shapes is a genuine unknown path and must 404, not
    // silently be treated as a Semrush request (AC 1/AC 11's "a real listening socket 404s the
    // unexpected", proven directly by this exactness rather than assumed from a permissive default).
    const vendor =
      url.pathname.startsWith("/v3/") ? "dataforseo"
      : url.pathname.startsWith("/site-explorer/") || url.pathname.startsWith("/keywords-explorer/") || url.pathname.startsWith("/serp-overview/") ? "ahrefs"
      : url.pathname === "/" ? "semrush"
      : null;
    if (!vendor) {
      bump("unknown_path");
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const handler = vendor === "dataforseo" ? handleDataForSeo : vendor === "ahrefs" ? handleAhrefs : handleSemrush;
    handler(req, res, url).catch((err: Error) => {
      // A harness-internal bug must fail the test loudly, not silently 500 — but still respond so the
      // driver's own fetch doesn't hang out the request timeout.
      sendJson(res, 500, { error: `vendor-sandbox internal error: ${err.message}` });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    totalHits: () => hits.get("__all__") ?? 0,
    hitCount: (route: string) => hits.get(route) ?? 0,
    resetHitCounts: () => hits.clear(),
    configureAhrefsTrueUp: (target, script) => ahrefsTrueUp.set(target, script),
    seedDfsVolumeRow: (keyword, row) => dfsVolumeRows.set(keyword, row),
    seedAhrefsVolumeRow: (keyword, row) => ahrefsVolumeRows.set(keyword, row),
    seedDfsBacklinks: (target, row) => dfsBacklinks.set(target, row),
    seedAhrefsBacklinks: (target, row) => ahrefsBacklinks.set(target, row),
    seedSemrushPhraseOrganic: (keyword, text) => semrushPhraseOrganic.set(keyword, text),
    seedSemrushBacklinksOverview: (target, text) => semrushBacklinksOverview.set(target, text),
    setSemrushPhraseThese: (text) => {
      semrushPhraseThese = text;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
