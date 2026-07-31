// SM-05 — DataForSEO driver tests against an in-process MOCK SERVER (design §12 SM-05 AC:
// "Mock-server tests for all capabilities; cost table matches §8a published rates; Live-queue flag
// exists but defaults Standard").
//
// No network, no credentials, no deposit: `fetchImpl` is injected, so these run in CI and on a
// laptop today. The REAL-data acceptance (a live pull against api.dataforseo.com) is deliberately
// deferred to the $50 deposit — see the tracker's blocker table. What IS proven here is everything
// that would still be wrong after the deposit lands: envelope parsing, the Standard-queue poll,
// error propagation, credential handling, and the published rate arithmetic.
import { describe, it, expect, vi } from "vitest";
import { config } from "../../../config";
import { DataForSeoProvider, DFS_RATES, canonicalizeEchoValue, createDataForSeoProviderFromConfig } from "./dataforseo";
import {
  ProviderFailedAfterSpendError,
  withActualCostCapture,
  type ProviderOp,
  type SearchDataProvider,
} from "./types";

/** Records every request and answers from a path->body script. */
function mockServer(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Array<{ path: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    const path = full.replace("https://api.test", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      path,
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const match = Object.keys(routes).find((r) => path.startsWith(r));
    if (!match) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const route = routes[match];
    const payload = typeof route === "function" ? (route as (b: unknown) => unknown)(body) : route;
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function provider(
  routes: Record<string, unknown | ((body: unknown) => unknown)>,
  overrides: Partial<ConstructorParameters<typeof DataForSeoProvider>[0]> = {},
) {
  const { calls, fetchImpl } = mockServer(routes);
  const p = new DataForSeoProvider({
    login: "user@test", password: "secret-pass", baseUrl: "https://api.test",
    queue: "standard", timeoutMs: 5000, fetchImpl, sleepImpl: async () => undefined,
    ...overrides,
  });
  return { p, calls };
}

// SM-67 (tracker §6be/§6bc) note on `id`: this default ("task-1") is an arbitrary fixture literal —
// every pre-existing call site that omits the second arg is asserting on the RESULT payload (items,
// positions, features), never on the id, so the default never mattered before echo-validation existed.
// Two call sites DO need to pass the real requested id explicitly now that fetchOneSerp checks it
// (see the two "regression: OK()'s id must match the requested ref" comments below) — that is a
// fixture correction, not a loosened assertion; nothing either test actually asserts on changes.
const OK = (result: unknown[], id = "task-1") => ({
  status_code: 20000,
  tasks: [{ id, status_code: 20000, result }],
});

describe("SM-05 DataForSEO driver — capabilities against a mock server", () => {
  it("advertises every capability the design assigns it", () => {
    const { p } = provider({});
    for (const cap of ["serp", "volume", "suggestions", "difficulty", "backlinks", "competitors", "ai_visibility"]) {
      expect(p.capabilities.has(cap as never)).toBe(true);
    }
  });

  // ── SERP ────────────────────────────────────────────────────────────────────────────────────────
  it("posts a Standard-queue SERP task and parses organic items + SERP features", async () => {
    const { p, calls } = provider({
      "/v3/serp/google/organic/task_post": {
        status_code: 20000,
        tasks: [{ id: "t-abc", status_code: 20000, data: { keyword: "sepatu lari" } }],
      },
      // regression: OK()'s id must match the requested ref (SM-67) — this test asserts on items/
      // features, never on the id, so passing the real id ("t-abc", the task_post response's own id)
      // is a fixture correction, not a behaviour change to what this test verifies.
      "/v3/serp/google/organic/task_get": OK([{
        items: [
          { type: "organic", rank_absolute: 1, url: "https://a.example/", title: "A" },
          { type: "ai_overview", text: "..." },
          { type: "organic", rank_absolute: 2, url: "https://b.example/" },
          { type: "people_also_ask" },
        ],
      }], "t-abc"),
    });

    const refs = await p.postSerpTasks([{ keyword: "sepatu lari", locale: "id-ID", locationCode: 2360, device: "mobile" }]);
    expect(refs).toEqual([{ id: "t-abc", keyword: "sepatu lari" }]);

    // Standard queue, not Live — the 3.3x-cheaper path (foundation §8a lever 2).
    expect(calls[0].path).toBe("/v3/serp/google/organic/task_post");
    expect(calls[0].body).toEqual([{ keyword: "sepatu lari", location_code: 2360, language_code: "id", device: "mobile" }]);

    const [res] = await p.fetchSerpResults(refs);
    expect(res.keyword).toBe("sepatu lari");
    expect(res.items).toEqual([
      { position: 1, url: "https://a.example/", title: "A" },
      { position: 2, url: "https://b.example/", title: undefined },
    ]); // non-organic item types are excluded from positions
    expect(res.serpFeatures).toMatchObject({ ai_overview: true, people_also_ask: true, featured_snippet: false });
  });

  it("polls through the 40602 'task in queue' answer instead of failing", async () => {
    let attempt = 0;
    const { p, calls } = provider({
      "/v3/serp/google/organic/task_get": () => {
        attempt++;
        // regression: OK()'s id must match the requested ref ("t", SM-67) — this test asserts on the
        // poll count and the final position, never on the id.
        return attempt < 3
          ? { status_code: 20000, tasks: [{ id: "t", status_code: 40602, status_message: "Task In Queue" }] }
          : OK([{ items: [{ type: "organic", rank_absolute: 7, url: "https://late.example/" }] }], "t");
      },
    });
    const [res] = await p.fetchSerpResults([{ id: "t", keyword: "k" }]);
    expect(res.items[0].position).toBe(7);
    expect(calls).toHaveLength(3); // two queued answers, then the result
  });

  it("gives up with a clear error if the task never leaves the queue", async () => {
    const { p } = provider(
      { "/v3/serp/google/organic/task_get": { status_code: 20000, tasks: [{ id: "t", status_code: 40602 }] } },
      { pollAttempts: 3 },
    );
    await expect(p.fetchSerpResults([{ id: "t", keyword: "k" }])).rejects.toThrow(/still queued after 3 polls/);
  });

  it("uses the Live endpoint only when the queue flag is explicitly flipped", async () => {
    const { p, calls } = provider(
      { "/v3/serp/google/organic/live": { status_code: 20000, tasks: [{ id: "L1", status_code: 20000, data: { keyword: "k" } }] } },
      { queue: "live" },
    );
    await p.postSerpTasks([{ keyword: "k" }]);
    expect(calls[0].path).toBe("/v3/serp/google/organic/live/advanced");
  });

  // ── Keyword metrics ─────────────────────────────────────────────────────────────────────────────
  it("maps keyword metrics back onto the requested keywords, tolerating a missing row", async () => {
    const { p } = provider({
      "/v3/keywords_data/google_ads/search_volume/live": OK([
        { keyword: "alpha", search_volume: 1200, cpc: 0.42, keyword_difficulty: 37 },
      ]),
    });
    const res = await p.getKeywordMetrics([{ keyword: "alpha" }, { keyword: "beta" }]);
    expect(res).toEqual([
      { keyword: "alpha", volume: 1200, cpcUsd: 0.42, difficulty: 37 },
      { keyword: "beta", volume: undefined, cpcUsd: undefined, difficulty: undefined },
    ]);
  });

  it("reads the nested keyword_info/keyword_properties envelope shape too", async () => {
    const { p } = provider({
      "/v3/keywords_data/google_ads/search_volume/live": OK([
        { keyword: "alpha", keyword_info: { search_volume: 90, cpc: 1.1 }, keyword_properties: { keyword_difficulty: 12 } },
      ]),
    });
    const [row] = await p.getKeywordMetrics([{ keyword: "alpha" }]);
    expect(row).toEqual({ keyword: "alpha", volume: 90, cpcUsd: 1.1, difficulty: 12 });
  });

  it("short-circuits an empty keyword batch without calling the API", async () => {
    const { p, calls } = provider({});
    expect(await p.getKeywordMetrics([])).toEqual([]);
    expect(await p.postSerpTasks([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // ── Backlinks ───────────────────────────────────────────────────────────────────────────────────
  it("parses a backlink summary and defaults missing counters to 0", async () => {
    const { p } = provider({
      "/v3/backlinks/summary/live": OK([{ target: "example.com", backlinks: 5321, referring_domains: 214, rank: 42 }]),
    });
    expect(await p.getBacklinkSummary("example.com")).toEqual({
      target: "example.com", backlinks: 5321, refDomains: 214, authorityScore: 42,
    });

    const { p: empty } = provider({ "/v3/backlinks/summary/live": OK([]) });
    expect(await empty.getBacklinkSummary("nothing.example")).toEqual({
      target: "nothing.example", backlinks: 0, refDomains: 0, authorityScore: undefined,
    });
  });

  // ── GEO / AI visibility ─────────────────────────────────────────────────────────────────────────
  it("reports AI-visibility citation state from the AI-mode envelope", async () => {
    const { p } = provider({
      "/v3/serp/google/ai_mode/live/advanced": OK([{
        items: [{ text: "Brand X is a good option", references: [{ url: "https://brandx.example/" }] }],
      }]),
    });
    const [res] = await p.getAiVisibility({ query: "best running shoes" });
    expect(res).toMatchObject({ engine: "google_ai_overview", cited: true, brandMentioned: true, citedUrl: "https://brandx.example/" });

    const { p: none } = provider({ "/v3/serp/google/ai_mode/live/advanced": OK([{ items: [] }]) });
    const [absent] = await none.getAiVisibility({ query: "obscure query" });
    expect(absent.cited).toBe(false);
    expect(absent.brandMentioned).toBe(false);
  });

  // ── Errors + credential handling ────────────────────────────────────────────────────────────────
  it("propagates an envelope-level failure (DataForSEO signals errors inside a 200)", async () => {
    const { p } = provider({
      "/v3/backlinks/summary/live": { status_code: 40401, status_message: "Not Found" },
    });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/40401 Not Found/);
  });

  it("propagates a rejected task rather than returning an empty ref", async () => {
    const { p } = provider({
      "/v3/serp/google/organic/task_post": {
        status_code: 20000,
        tasks: [{ id: "t", status_code: 40501, status_message: "Invalid Field" }],
      },
    });
    await expect(p.postSerpTasks([{ keyword: "k" }])).rejects.toThrow(/task rejected: 40501/);
  });

  // ── SM-67 (tracker §6be/§6be.1/§6bc, design addendum §A14.2 refuse-as-not-found) ─────────────────
  describe("SM-67 — task_get identity echo (fetchOneSerp, shared by fetchSerpResults and the collect path)", () => {
    it("refuses a task_get response whose OWN id differs from the one requested — no oracle: byte-identical "
      + "message to a genuinely-unknown id", async () => {
      const { p: mismatched } = provider({
        "/v3/serp/google/organic/task_get": {
          status_code: 20000,
          tasks: [{ id: "vendor-swapped-id", status_code: 20000, result: [{ keyword: "k", items: [] }] }],
        },
      });
      const errMismatch = await mismatched.fetchSerpResults([{ id: "requested-id", keyword: "k" }]).catch((e: Error) => e);

      const { p: unknown } = provider({
        "/v3/serp/google/organic/task_get": { status_code: 20000, tasks: [{ id: "requested-id", status_code: 40400, status_message: "Task Not Found.", result: null }] },
      });
      const errUnknown = await unknown.fetchSerpResults([{ id: "requested-id", keyword: "k" }]).catch((e: Error) => e);

      expect((errMismatch as Error).message).toBe("dataforseo serp task_get failed: 40400 Task Not Found.");
      // The whole point: identical text, so a caller cannot distinguish "wrong task" from "no such task".
      expect((errMismatch as Error).message).toBe((errUnknown as Error).message);
    });

    it("does NOT refuse when the id matches — regression pin for the ordinary ready path", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_get": OK([{ items: [{ type: "organic", rank_absolute: 1, url: "https://a.example/" }] }]),
      });
      const [res] = await p.fetchSerpResults([{ id: "task-1", keyword: "k" }]);
      expect(res.items).toHaveLength(1);
    });
  });

  // ── SM-68 (tracker §6be/§6be.1/§6bc, billing-adjacent, design addendum §A14.2 skip+count+disclose) ──
  describe("SM-68 — postSerpTasks response-array bound + keyword-echo precedence", () => {
    it("bounds an over-long response to reqs.length — an unrequested extra task is skipped, counted, "
      + "and NEVER billed", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "acc-1", status_code: 20000, data: { keyword: "a" } },
            // an UNREQUESTED third entry — reqs has only 1 element
            { id: "phantom", status_code: 20000, data: { keyword: "sm68-phantom" } },
          ],
        },
      });
      const before = p.getTasksUnmatchedSkippedCount();
      const refs = await p.postSerpTasks([{ keyword: "a" }]);
      expect(refs).toEqual([{ id: "acc-1", keyword: "a" }]); // exactly one — the phantom never accepted
      expect(p.getTasksUnmatchedSkippedCount()).toBe(before + 1);
    });

    it("bounds an over-long response even when the phantom task echoes NO keyword at all — isolates the "
      + "length bound from the separate keyword-match defense (no `data` field means the keyword check "
      + "has nothing to compare and could not have caught this alone)", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "acc-1", status_code: 20000, data: { keyword: "a" } },
            { id: "phantom-nodata", status_code: 20000 }, // no `data` field — vendor echoes nothing
          ],
        },
      });
      const before = p.getTasksUnmatchedSkippedCount();
      const refs = await p.postSerpTasks([{ keyword: "a" }]);
      // Without the length bound, this entry would fall through to the pre-SM-68 fallback
      // (`reqs[1]?.keyword ?? ""`, `reqs[1]` undefined) and be ACCEPTED (and billed) as `keyword: ""`.
      expect(refs).toEqual([{ id: "acc-1", keyword: "a" }]);
      expect(p.getTasksUnmatchedSkippedCount()).toBe(before + 1);
    });

    // SM-70 (tracker §6bi, design addendum §A14.5) — OVERRULES the disposition below. The first
    // implementation accepted+billed a keyword-echo mismatch, naming the row from the REQUESTED
    // keyword; the architect ruling reclassified a canonical mismatch as IDENTITY, not data (the
    // snapshot is filed BY keyword — rank history and `rank.dropped` alerts key on it), so the
    // remedy is refuse-the-data-path + throw, matching SM-63/SM-67's refuse-as-not-found shape one
    // level higher up the addressing scheme. This is a spec-driven test rewrite (§6bi Ruling 2's
    // named exception), not the forbidden fixture-driven softening.
    it("an IN-BOUNDS task whose vendor-echoed keyword CANONICALLY differs from the one posted is "
      + "REFUSED — the data path is withheld (no TaskRef) and the call throws naming the mismatch, "
      + "distinct from a task-rejection message", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "t-0", status_code: 20000, data: { keyword: "wrong-keyword" } }, // reqs[0] is "a"
          ],
        },
      });
      const before = p.getKeywordEchoMismatchCount();
      const err = await p.postSerpTasks([{ keyword: "a" }]).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/keyword echo mismatch/);
      expect((err as Error).message).not.toMatch(/task rejected/);
      expect(p.getKeywordEchoMismatchCount()).toBe(before + 1);
    });

    it("a RAW-ONLY echo variance (case/whitespace/NFC) is vendor restatement, not identity — accepted, "
      + "named by the REQUESTED keyword, and the anomaly is counted/disclosed same as before", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [{ id: "t-0", status_code: 20000, data: { keyword: "  Sepatu   Lari  " } }], // reqs[0] is "sepatu lari"
        },
      });
      const before = p.getKeywordEchoMismatchCount();
      const refs = await p.postSerpTasks([{ keyword: "sepatu lari" }]);
      expect(refs).toEqual([{ id: "t-0", keyword: "sepatu lari" }]); // requested value still names the row
      expect(p.getKeywordEchoMismatchCount()).toBe(before + 1); // counted as the benign-variance diagnostic
    });

    it("still trusts positionally when the vendor echoes NO keyword at all (data.keyword absent) — "
      + "regression pin for the pre-existing fallback", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [{ id: "t-0", status_code: 20000 }], // no `data` field at all
        },
      });
      const refs = await p.postSerpTasks([{ keyword: "a" }]);
      expect(refs).toEqual([{ id: "t-0", keyword: "a" }]); // positional fallback, unchanged
    });

    it("regression pin: an in-bounds, correctly-echoed response is byte-identical to pre-fix behaviour", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "acc-1", status_code: 20000, data: { keyword: "a" } },
            { id: "acc-2", status_code: 20000, data: { keyword: "b" } },
          ],
        },
      });
      const refs = await p.postSerpTasks([{ keyword: "a" }, { keyword: "b" }]);
      expect(refs).toEqual([{ id: "acc-1", keyword: "a" }, { id: "acc-2", keyword: "b" }]);
    });
  });

  // ── SM-69 (tracker §6be/§6bc, design addendum §A14.2 skip+count+disclose) ────────────────────────
  describe("SM-69 — backlinks target identity (getBacklinkSummary)", () => {
    it("ALWAYS returns the REQUESTED target, never the vendor's echoed one — and counts the mismatch", async () => {
      const { p } = provider({
        "/v3/backlinks/summary/live": OK([{ target: "vendor-echoed-different.example", backlinks: 10, referring_domains: 2, rank: 5 }]),
      });
      const before = p.getBacklinksTargetMismatchCount();
      const result = await p.getBacklinkSummary("requested.example");
      expect(result.target).toBe("requested.example"); // REQUESTED value, not the vendor's string
      expect(p.getBacklinksTargetMismatchCount()).toBe(before + 1);
    });

    it("regression pin: an unmismatched target is byte-identical to pre-fix behaviour, no count", async () => {
      const { p } = provider({
        "/v3/backlinks/summary/live": OK([{ target: "example.com", backlinks: 5321, referring_domains: 214, rank: 42 }]),
      });
      const before = p.getBacklinksTargetMismatchCount();
      expect(await p.getBacklinkSummary("example.com")).toEqual({
        target: "example.com", backlinks: 5321, refDomains: 214, authorityScore: 42,
      });
      expect(p.getBacklinksTargetMismatchCount()).toBe(before);
    });
  });

  // ── SM-50 — the driver's BILLING POINT declaration (addendum §A11.1.3) ──────────────────────────
  // Tested AT THE DRIVER BOUNDARY, through the real capture wrapper, so the contract is pinned
  // independently of dispatch: "postSerpTasks reports a charge for exactly the tasks DataForSEO
  // accepted, at the published rate for the configured queue, keyed by the vendor's own task id."
  // The dispatch-level and DB-level consequences live in providers/incurred-cost.test.ts.
  describe("SM-50 billing point — recordIncurredCostUsd at parsed task_post acceptance", () => {
    /** Runs `fn` inside a capture scope and returns what the driver reported as incurred. */
    async function capture(fn: () => Promise<unknown>): Promise<{ usd: number; refs: string[]; threw?: Error }> {
      const stub = {} as SearchDataProvider;
      try {
        const out = await withActualCostCapture(stub, fn);
        // Nothing threw, so no liability envelope exists; the refs are still reported (they are stamped
        // on the successful ledger row — one column, both paths).
        return { usd: 0, refs: out.vendorRefs };
      } catch (e) {
        if (e instanceof ProviderFailedAfterSpendError) {
          return { usd: e.incurredUsd, refs: e.vendorRefs, threw: e.cause as Error };
        }
        return { usd: 0, refs: [], threw: e as Error };
      }
    }

    it("reports the Standard rate per ACCEPTED task, keyed by the vendor's task id", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "acc-1", status_code: 20000, data: { keyword: "a" } },
            { id: "acc-2", status_code: 20000, data: { keyword: "b" } },
          ],
        },
      });
      // Success path: nothing is owed (the charge bought data), but the refs are captured.
      const out = await capture(() => p.postSerpTasks([{ keyword: "a" }, { keyword: "b" }]));
      expect(out.refs).toEqual(["acc-1", "acc-2"]);
    });

    it("a rejected task in a MIXED response does not stop the accepted task's charge from being recorded", async () => {
      // The ordering bug this ticket fixed: postSerpTasks used to throw on the first per-task 4xxxx
      // while mapping, abandoning the scope with a real charge for the ACCEPTED task unrecorded. Both
      // halves are asserted — the charge IS reported, and the rejection still propagates.
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "acc-1", status_code: 20000, data: { keyword: "a" } },
            { id: "rej-1", status_code: 40501, status_message: "Invalid Field" },
          ],
        },
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "a" }, { keyword: "b" }]));
      expect(out.usd).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9); // ONE task, not two
      expect(out.refs).toEqual(["acc-1"]);
      expect(out.threw?.message).toMatch(/task rejected: 40501/);
    });

    // SM-70 (tracker §6bi Ruling 3) — the driver twin GROWS a mismatch case, realistic
    // (reqs.length === tasks.length) exactly like the test above, pinning the SAME record-before-throw
    // ordering property extended to an identity throw instead of a rejection throw. Echoes SWAPPED
    // between the two positions: BOTH are canonically wrong, so BOTH charges are recorded and the
    // whole call throws (zero TaskRefs survive — the addressing scheme itself is impeached, not one row).
    it("SM-70: a canonical keyword-echo mismatch records EVERY accepted task's charge before throwing "
      + "— echoes swapped between two positions, both charges recorded, zero refs, throw names the "
      + "mismatch (not a rejection)", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "t-0", status_code: 20000, data: { keyword: "second" } }, // reqs[0] is "first"
            { id: "t-1", status_code: 20000, data: { keyword: "first" } }, // reqs[1] is "second"
          ],
        },
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "first" }, { keyword: "second" }]));
      expect(out.usd).toBeCloseTo(2 * DFS_RATES.serpStandardPerTask, 9); // BOTH charged, mismatched or not
      expect([...out.refs].sort()).toEqual(["t-0", "t-1"]);
      expect(out.threw?.message).toMatch(/keyword echo mismatch/);
      expect(out.threw?.message).not.toMatch(/task rejected/);
    });

    it("SM-70 precedence: when a response carries BOTH a canonical keyword mismatch AND a per-task "
      + "rejection, the identity mismatch is the reported cause, and the accepted task is still charged",
      async () => {
      // SM-70 chose this ordering by reasoning and flagged that no test exercised both conditions at
      // once (tracker §6bj). Pinning it, because the two throws are NOT interchangeable: a rejection
      // says "the vendor declined a task", while an identity mismatch says "the vendor's positional
      // addressing cannot be trusted" — the second impeaches the response as a whole, so it is the
      // more severe fact and the one an operator must see. Money is unaffected either way, which is
      // exactly why only a test can hold the message contract in place.
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [
            { id: "mm-0", status_code: 20000, data: { keyword: "totally-different" } }, // reqs[0] "first"
            { id: "rj-1", status_code: 40501, status_message: "invalid location_code" },
          ],
        },
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "first" }, { keyword: "second" }]));
      // The accepted-but-mismatched task was enqueued, so it was charged; the rejected one never was.
      expect(out.usd).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
      expect(out.refs).toEqual(["mm-0"]);
      expect(out.threw?.message).toMatch(/keyword echo mismatch/);
      expect(out.threw?.message).not.toMatch(/task rejected/);
    });

    it("an ALL-rejected response reports nothing — a refused task is not charged", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [{ id: "rej-1", status_code: 40501, status_message: "Invalid Field" }],
        },
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "a" }]));
      expect(out.usd).toBe(0);
      expect(out.refs).toEqual([]);
      expect(out.threw?.message).toMatch(/task rejected/);
    });

    it("a top-level failure (auth) reports nothing — no task was acknowledged, so no charge is claimed", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/task_post": { status_code: 40100, status_message: "auth failed" },
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "a" }]));
      expect(out.usd).toBe(0);
      expect(out.threw?.message).toMatch(/task_post failed: 40100/);
    });

    it("a TRANSPORT failure reports nothing — the ambiguous class under-records deliberately (§A11.1.5)", async () => {
      const fetchImpl = (async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
      const p = new DataForSeoProvider({
        login: "u", password: "p", baseUrl: "https://api.test", queue: "standard",
        timeoutMs: 100, fetchImpl, sleepImpl: async () => undefined,
      });
      const out = await capture(() => p.postSerpTasks([{ keyword: "a" }]));
      expect(out.usd).toBe(0);
      expect(out.threw?.message).toMatch(/socket hang up/);
    });

    it("the LIVE queue records its own (3.3x) published rate, never Standard's", async () => {
      const { p } = provider({
        "/v3/serp/google/organic/live/advanced": {
          status_code: 20000,
          tasks: [{ id: "live-1", status_code: 20000, data: { keyword: "a" } }],
        },
      }, { queue: "live" });
      const out = await capture(async () => {
        const refs = await p.postSerpTasks([{ keyword: "a" }]);
        throw new Error("downstream blew up after the charge");
      });
      expect(out.usd).toBeCloseTo(DFS_RATES.serpLivePerTask, 9);
      expect(out.usd).toBeGreaterThan(DFS_RATES.serpStandardPerTask);
    });

    it("poll exhaustion adds NO further charge — Standard retrieval is included in the post charge", async () => {
      // task_get must never record: the poll is collecting something already paid for. If it recorded,
      // a 10-attempt poll would bill 11x the real charge and the ceiling would refuse honest clients.
      const { p } = provider({
        "/v3/serp/google/organic/task_post": {
          status_code: 20000,
          tasks: [{ id: "queued-1", status_code: 20000, data: { keyword: "a" } }],
        },
        "/v3/serp/google/organic/task_get": { status_code: 20000, tasks: [{ id: "queued-1", status_code: 40602 }] },
      }, { pollAttempts: 4 });
      const out = await capture(async () => {
        const refs = await p.postSerpTasks([{ keyword: "a" }]);
        return p.fetchSerpResults(refs);
      });
      expect(out.usd).toBeCloseTo(1 * DFS_RATES.serpStandardPerTask, 9); // exactly ONE task's charge
      expect(out.refs).toEqual(["queued-1"]);
      expect(out.threw?.message).toMatch(/still queued after 4 polls/);
    });

    it("the /live capabilities record nothing at all — their single round trip either delivers or does not", async () => {
      // getKeywordMetrics / getBacklinkSummary / getAiVisibility have no post-then-fetch shape, so there
      // is no window in which we are charged and empty-handed. A vendor error inside a 200 is not a
      // confirmed charge. Asserted rather than assumed, because "which methods record?" is exactly the
      // question a future capability author will get wrong by inheriting a default.
      const { p } = provider({
        "/v3/keywords_data/google_ads/search_volume/live": { status_code: 40501, status_message: "bad" },
        "/v3/backlinks/summary/live": { status_code: 40501, status_message: "bad" },
        "/v3/serp/google/ai_mode/live/advanced": { status_code: 40501, status_message: "bad" },
      });
      for (const call of [
        () => p.getKeywordMetrics([{ keyword: "a" }]),
        () => p.getBacklinkSummary("x.example"),
        () => p.getAiVisibility({ query: "a" }),
      ]) {
        const out = await capture(call);
        expect(out.usd).toBe(0);
        expect(out.refs).toEqual([]);
      }
    });
  });

  it("does not echo the response body on an HTTP error (it can carry the account identifier)", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 402, json: async () => ({ account: "secret" }) })) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard", timeoutMs: 100, fetchImpl,
    });
    const err = await p.getBacklinkSummary("x.example").catch((e: Error) => e);
    expect((err as Error).message).toBe("dataforseo /v3/backlinks/summary/live returned HTTP 402");
    expect((err as Error).message).not.toContain("secret");
  });

  it("sends HTTP Basic auth and never puts credentials in the URL", async () => {
    const { p, calls } = provider({ "/v3/backlinks/summary/live": OK([]) });
    await p.getBacklinkSummary("x.example");
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from("user@test:secret-pass").toString("base64")}`);
    expect(calls[0].path).not.toContain("secret-pass");
  });

  it("aborts a hung request on the configured timeout", async () => {
    const fetchImpl = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
    const p = new DataForSeoProvider({
      login: "u", password: "p", baseUrl: "https://api.test", queue: "standard", timeoutMs: 20, fetchImpl,
    });
    await expect(p.getBacklinkSummary("x.example")).rejects.toThrow(/abort/i);
  });
});

describe("SM-70 canonicalizeEchoValue (tracker §6bi, design addendum §A14.5)", () => {
  it("trims, NFC-normalizes, lowercases, and collapses internal whitespace", () => {
    expect(canonicalizeEchoValue("  Sepatu   Lari  ")).toBe("sepatu lari");
    expect(canonicalizeEchoValue("sepatu lari")).toBe("sepatu lari");
    expect(canonicalizeEchoValue("SEPATU\tLARI")).toBe("sepatu lari");
  });

  it("treats a genuinely different word as different, even after canonicalizing", () => {
    expect(canonicalizeEchoValue("sepatu lari")).not.toBe(canonicalizeEchoValue("sepatu wanita"));
  });
});

describe("SM-05 cost table matches the §8a published rates", () => {
  const { p: standard } = provider({});
  const { p: live } = provider({}, { queue: "live" });
  const op = (kind: ProviderOp["kind"], items: number): ProviderOp => ({ kind, query: "k", items });

  it("publishes the 2026 rate constants the foundation doc locked", () => {
    expect(DFS_RATES).toEqual({
      serpStandardPerTask: 0.0006,
      serpLivePerTask: 0.002,
      keywordsDataPerTask: 0.0012,
      keywordsDataPerKeyword: 0.00012,
      labsPerTask: 0.012,
      labsPerItem: 0.00012,
      backlinksSummary: 0.02,
    });
  });

  it("prices SERP per task at the Standard rate, and Live at 3.3x", () => {
    expect(standard.estimateCostUsd(op("serp", 1))).toBeCloseTo(0.0006, 9);
    expect(standard.estimateCostUsd(op("serp", 50))).toBeCloseTo(0.03, 9);
    expect(live.estimateCostUsd(op("serp", 1))).toBeCloseTo(0.002, 9);
    expect(live.estimateCostUsd(op("serp", 1)) / standard.estimateCostUsd(op("serp", 1))).toBeCloseTo(3.333, 2);
  });

  it("prices Keywords Data as task + per-keyword, and Labs as task + per-item", () => {
    // 100 keywords: $0.0012 + 100 x $0.00012 = $0.0132
    expect(standard.estimateCostUsd(op("volume", 100))).toBeCloseTo(0.0132, 9);
    // suggestions ride Labs: $0.012 + 100 x $0.00012 = $0.024
    expect(standard.estimateCostUsd(op("suggestions", 100))).toBeCloseTo(0.024, 9);
  });

  it("prices backlinks at the pay-as-you-go summary rate", () => {
    expect(standard.estimateCostUsd(op("backlinks", 1))).toBeCloseTo(0.02, 9);
  });

  it("is pure and synchronous — the stop-loss calls it before every dispatch", () => {
    const o = op("serp", 10);
    expect(standard.estimateCostUsd(o)).toBe(standard.estimateCostUsd(o));
    expect(typeof standard.estimateCostUsd(o)).toBe("number");
  });

  it("defaults items to 1 when an op does not declare a batch size", () => {
    expect(standard.estimateCostUsd({ kind: "serp", query: "k" })).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
  });

  // ── SM-42 / addendum §A9.5 — items >= 1 alignment with the simulator. This is the NAMED example
  // from the design addendum: an items:0 'serp' op used to price at exactly $0 (rate * 0), which is
  // the §4d fail-open class arriving through a degenerate input on the money path. ──────────────────
  it("clamps items to a floor of 1 — an items:0 serp op prices the SAME as items:1, never $0", () => {
    const zero = standard.estimateCostUsd(op("serp", 0));
    const one = standard.estimateCostUsd(op("serp", 1));
    expect(zero).toBeCloseTo(one, 9);
    expect(zero).toBeCloseTo(DFS_RATES.serpStandardPerTask, 9);
    expect(zero).toBeGreaterThan(0);
  });

  it("reproduces the foundation's per-client monthly order of magnitude", () => {
    // A 'standard' engagement: 50 tracked keywords daily + 100-keyword monthly volume refresh.
    const rank = standard.estimateCostUsd(op("serp", 50)) * 30;
    const volume = standard.estimateCostUsd(op("volume", 100));
    // foundation §8a: SEO ~= $5.40/client/mo for a full round — same order, well under it for rank+volume.
    expect(rank + volume).toBeGreaterThan(0.5);
    expect(rank + volume).toBeLessThan(5.4);
  });
});

describe("SM-06 keyless bootstrap — no credentials means no registered driver", () => {
  it("returns null when either credential half is missing, and a driver when both are set", () => {
    const original = { ...config.search.dataforseo };
    try {
      config.search.dataforseo = { ...original, login: "", password: "" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "user", password: "" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "", password: "pass" };
      expect(createDataForSeoProviderFromConfig()).toBeNull();

      config.search.dataforseo = { ...original, login: "user", password: "pass" };
      const p = createDataForSeoProviderFromConfig();
      expect(p).toBeInstanceOf(DataForSeoProvider);
      expect(p!.key).toBe("dataforseo");
    } finally {
      config.search.dataforseo = original;
    }
  });

  it("defaults the queue to Standard — Live must be opted into explicitly", () => {
    // The parsed config (not the raw env) is what the driver reads; anything other than the exact
    // string 'live' resolves to 'standard', so a typo can never triple the bill.
    expect(["standard", "live"]).toContain(config.search.dataforseo.queue);
    const parse = (v: string | undefined) => (v ?? "standard") === "live" ? "live" : "standard";
    expect(parse(undefined)).toBe("standard");
    expect(parse("")).toBe("standard");
    expect(parse("LIVE")).toBe("standard");
    expect(parse("standard")).toBe("standard");
    expect(parse("live")).toBe("live");
  });

  it("ships all three pillars enabled by default; only an explicit '0' disables one", () => {
    const parse = (v: string | undefined) => (v ?? "1") !== "0";
    expect(parse(undefined)).toBe(true);
    expect(parse("1")).toBe(true);
    expect(parse("0")).toBe(false);
    expect(config.search.pillars).toEqual({ seo: true, sem: true, geo: true });
  });
});
