// AIP-09 — the runner with `fetch` mocked: applied tier -> PASS/FAIL per the scorer, missing tier -> INVALID, 429 stops early, exit codes.
import { describe, expect, it } from "vitest";
import { CLASSIFY_CASES, SUMMARISE_CASES } from "./cases";
import { promptFor } from "./prompts";
import { ECHO_PREFIX, type EvalCase } from "./score";
import { main, parseArgs, median, type EvalReport } from "./run-eval";

const ALL: readonly EvalCase[] = [...SUMMARISE_CASES, ...CLASSIFY_CASES];
const caseOf = (prompt: string): EvalCase => {
  const c = ALL.find((x) => promptFor(x) === prompt);
  if (!c) throw new Error("request prompt is not any eval case's prompt");
  return c;
};

/** A correct answer for a case, from its own expectations. */
function oracle(c: EvalCase): string {
  if (c.task === "summarise") {
    const facts = c.mustKeep.map((f) => (typeof f === "string" ? f : f[0])).join("; ");
    return `Summary of the discussion. Key facts: ${facts}. Nothing else was decided.`;
  }
  if (c.kind === "social") return JSON.stringify(c.expected);
  return JSON.stringify({ summary: `Fix ${c.priorityCode} first.`, fixes: c.expectedFixCodes.map((code) => ({ code, suggestion: "do it" })) });
}
const wrongLabel = (c: EvalCase): string =>
  c.task === "classify" && c.kind === "social" ? JSON.stringify({ sentiment: "positive", category: "other", urgency: "low" }) : oracle(c);

interface Sent { url: string; headers: Record<string, string>; body: { prompt: string; task: string; tier: string } }

function harness(answer: (c: EvalCase, tier: string, n: number) => { status?: number; body?: Record<string, unknown>; throws?: Error }) {
  const sent: Sent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    try {
      const body = JSON.parse(String(init.body)) as Sent["body"];
      sent.push({ url, headers: init.headers as Record<string, string>, body });
      const r = answer(caseOf(body.prompt), body.tier, sent.length);
      if (r.throws) throw r.throws;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    } finally {
      inFlight--;
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, maxInFlight: () => maxInFlight };
}

const ok = (c: EvalCase, tier: string | undefined, text: string, extra: Record<string, unknown> = {}) => ({
  body: { provider: "openrouter", model: "glm-5.3-flash", text, ...(tier ? { tier } : {}), usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.001, source: "provider" }, ...extra },
});

async function run(argv: string[], h: ReturnType<typeof harness>, env: Record<string, string | undefined> = { GATEWAY_URL: "http://gw.test/", GATEWAY_TOKEN: "tok" }) {
  const lines: string[] = [];
  const files: Record<string, string> = {};
  let t = 0;
  const code = await main(argv, { fetchImpl: h.fetchImpl, env, now: () => (t += 50), log: (l) => lines.push(l), write: (f, d) => { files[f] = d; } });
  return { code, out: lines.join("\n"), files };
}

describe("runner: the happy path", () => {
  it("applied tier + good answers => every class PASS, exit 0, 38 sequential calls with the fixed contract", async () => {
    const h = harness((c, tier) => ok(c, tier, oracle(c)));
    const r = await run(["--out", "/tmp/x.json"], h);
    expect(r.code).toBe(0);
    expect(h.sent).toHaveLength(38);
    expect(h.maxInFlight()).toBe(1);
    expect(h.sent[0].url).toBe("http://gw.test/complete");
    expect(h.sent[0].headers.Authorization).toBe("Bearer tok");
    expect(Object.keys(h.sent[0].body).sort()).toEqual(["prompt", "task", "tier"]);
    expect(new Set(h.sent.map((s) => `${s.body.tier}:${s.body.task}`))).toEqual(new Set(["fast:summarise", "fast:classify", "standard:summarise", "standard:classify"]));
    const report = JSON.parse(r.files["/tmp/x.json"]) as EvalReport;
    expect(report.exitCode).toBe(0);
    expect(report.verdicts.fast.summarise).toMatchObject({ verdict: "PASS", passed: 9, total: 9, medianLatencyMs: 50, medianTokens: 120 });
    expect(report.verdicts.standard.classify).toMatchObject({ verdict: "PASS", passed: 10, total: 10 });
    expect(report.calls[0]).toMatchObject({ provider: "openrouter", model: "glm-5.3-flash", appliedTier: "fast", latencyMs: 50, promptTokens: 100, completionTokens: 20 });
    expect(report.calls[0].text).toContain("Summary of the discussion");
    expect(JSON.stringify(report)).not.toContain("tok\"");
    expect(r.out).toMatch(/fast\s+summarise\s+PASS\s+9\/9/);
    expect(r.out).not.toContain("Summary of the discussion"); // the model's text is never printed
  });

  it("--tiers and --task narrow the run", async () => {
    const h = harness((c, tier) => ok(c, tier, oracle(c)));
    const r = await run(["--tiers", "fast", "--task", "classify"], h);
    expect(h.sent).toHaveLength(10);
    expect(new Set(h.sent.map((s) => s.body.tier))).toEqual(new Set(["fast"]));
    expect(r.code).toBe(0);
    expect(r.files).toEqual({});
  });
});

describe("runner: FAIL, INVALID and the exit codes", () => {
  it("applied tier but wrong labels => classify FAIL, exit 1, with a readable diff", async () => {
    const h = harness((c, tier) => ok(c, tier, wrongLabel(c)));
    const r = await run(["--tiers", "fast"], h);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/fast\s+classify\s+FAIL/);
    expect(r.out).toMatch(/fast\s+summarise\s+PASS/);
    expect(r.out).toContain("wrong label: sentiment: expected");
  });

  it("an answer with no `tier` is INVALID (never a pass), exit 2", async () => {
    const h = harness((c) => ok(c, undefined, oracle(c)));
    const r = await run(["--tiers", "fast", "--task", "summarise"], h);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/fast\s+summarise\s+INVALID\s+0\/9/);
    expect(r.out).toContain("did not apply tier fast");
  });

  it("a different applied tier than asked is INVALID", async () => {
    const h = harness((c) => ok(c, "standard", oracle(c)));
    const r = await run(["--tiers", "fast", "--task", "classify"], h);
    expect(r.code).toBe(2);
    expect(r.out).toContain("asked for tier fast but the gateway applied standard");
  });

  it("the echo fallback (provider or text) is INVALID", async () => {
    const byProvider = await run(["--tiers", "fast", "--task", "classify"], harness((c, tier) => ok(c, tier, oracle(c), { provider: "echo" })));
    expect(byProvider.code).toBe(2);
    const byText = await run(["--tiers", "fast", "--task", "classify"], harness((c, tier) => ok(c, tier, `${ECHO_PREFIX} ${oracle(c)}`)));
    expect(byText.code).toBe(2);
    expect(byText.out).toContain("echo fallback");
  });

  it("an HTTP error on one case makes that class INVALID, and the run continues", async () => {
    const h = harness((c, tier, n) => (n === 2 ? { status: 503, body: { error: "dlp" } } : ok(c, tier, oracle(c))));
    const r = await run(["--tiers", "fast", "--task", "classify"], h);
    expect(h.sent).toHaveLength(10);
    expect(r.code).toBe(2);
    expect(r.out).toContain("gateway returned HTTP 503");
  });

  it("the first HTTP 429 stops the run: no further calls, INVALID, exit 2", async () => {
    const h = harness((c, tier, n) => (n === 3 ? { status: 429, body: { error: "budget" } } : ok(c, tier, oracle(c))));
    const r = await run([], h);
    expect(h.sent).toHaveLength(3);
    expect(r.code).toBe(2);
    expect(r.out).toContain("STOPPED EARLY: HTTP 429 (budget)");
    expect(r.out).toMatch(/fast\s+summarise\s+INVALID/);
    expect(r.out).toMatch(/standard\s+classify\s+INVALID\s+0\/10/);
  });

  it("an unreachable gateway stops after the first call, INVALID, exit 2", async () => {
    const h = harness(() => ({ throws: new Error("connect ECONNREFUSED") }));
    const r = await run([], h);
    expect(h.sent).toHaveLength(1);
    expect(r.code).toBe(2);
    expect(r.out).toContain("gateway unreachable");
  });

  it("the exit code follows `fast` only: standard failing does not block the gate", async () => {
    const h = harness((c, tier) => ok(c, tier, tier === "fast" ? oracle(c) : wrongLabel(c)));
    const r = await run([], h);
    expect(r.out).toMatch(/standard\s+classify\s+FAIL/);
    expect(r.code).toBe(0);
  });

  it("no gateway config or bad arguments: exit 2 and no call", async () => {
    const h = harness((c, tier) => ok(c, tier, oracle(c)));
    expect((await run([], h, { GATEWAY_URL: "http://gw.test" })).code).toBe(2);
    expect((await run(["--tiers", "strong"], h)).code).toBe(2);
    expect((await run(["--task", "chat"], h)).code).toBe(2);
    expect((await run(["--bogus"], h)).code).toBe(2);
    expect(h.sent).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("parseArgs defaults to both tiers, all tasks, no out file", () => {
    expect(parseArgs([])).toEqual({ tiers: ["fast", "standard"], tasks: ["summarise", "classify"], out: null });
    expect(parseArgs(["--tiers", "standard", "--task", "summarise", "--out", "a.json"])).toEqual({ tiers: ["standard"], tasks: ["summarise"], out: "a.json" });
  });
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
  });
});
