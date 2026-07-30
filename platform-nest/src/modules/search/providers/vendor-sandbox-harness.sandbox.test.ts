// SM-49 (tracker §6u; design addendum §A10) — harness-shape, auth-strictness, vendor-error-inside-200,
// and strictness-over-mocks proofs that do NOT need a live Postgres (AC 1, AC 6, AC 7, AC 11). The
// full-chain proofs (registry → dispatchProviderOp → cache → ledger, AC 2/3/4/5/8) live in the
// per-vendor `dataforseo.sandbox.test.ts` / `semrush.sandbox.test.ts` / `ahrefs.sandbox.test.ts` files
// instead, because THOSE need real Postgres for the money-safety guarantees under test — mixing the
// two here would make this file skip silently whenever DATABASE_URL_TEST is unset, hiding these
// DB-free assertions along with it.
//
// REMINDER (binding, §A10 MUST-NOT list): nothing here proves a vendor FACT — only OUR mechanics
// (socket-level auth encoding, the "vendor error inside a 200" parse path, strict request validation).
// A green run of this file is a validated client of our own vendor model, never a validated
// integration (§A10.5). Zero SM-41 clauses move; OQ-9/OQ-10/OQ-11 are untouched by anything below.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DataForSeoProvider } from "./dataforseo";
import { SemrushProvider } from "./semrush";
import { AhrefsProvider } from "./ahrefs";
import {
  startVendorSandbox,
  DFS_TASK_REJECTED_MARKER,
  DFS_ENVELOPE_ERROR_MARKER,
  SEMRUSH_ERROR_MARKER,
  AHREFS_ERROR_MARKER,
  type VendorSandbox,
} from "../../../testing/vendor-sandbox/server";

const CREDS = {
  dataforseo: { login: "sm49-dfs-login", password: "sm49-dfs-password" },
  semrush: { apiKey: "sm49-semrush-key" },
  ahrefs: { apiKey: "sm49-ahrefs-token" },
};

describe("SM-49 AC 1 — harness shape (ephemeral port, per-file instance, torn down in afterAll)", () => {
  let sandbox: VendorSandbox;

  beforeAll(async () => {
    sandbox = await startVendorSandbox(CREDS);
  });

  afterAll(async () => {
    await sandbox.close();
  });

  it("listens on 127.0.0.1 at a real, non-zero ephemeral port", () => {
    expect(sandbox.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(sandbox.origin).port);
    expect(port).toBeGreaterThan(0);
  });

  it("is a real listening socket — a plain fetch against an unknown path gets a real HTTP response, not a connection refusal", async () => {
    const res = await fetch(`${sandbox.origin}/definitely-not-a-real-vendor-path`);
    expect(res.status).toBe(404);
  });

  it("hit counters are per-instance and start at zero", () => {
    expect(sandbox.totalHits()).toBeGreaterThanOrEqual(0);
    expect(sandbox.hitCount("nonexistent-route")).toBe(0);
  });

  it("closes cleanly — a second close() is a no-op-safe operation the caller can always await", async () => {
    const other = await startVendorSandbox(CREDS);
    await expect(other.close()).resolves.toBeUndefined();
  });
});

describe("SM-49 AC 11 — strictness over mocks: unknown paths 404, missing required params get vendor-shaped refusals", () => {
  let sandbox: VendorSandbox;

  beforeAll(async () => {
    sandbox = await startVendorSandbox(CREDS);
  });
  afterAll(async () => {
    await sandbox.close();
  });

  it("DataForSEO: an unrecognized path 404s (with valid auth)", async () => {
    const auth = `Basic ${Buffer.from(`${CREDS.dataforseo.login}:${CREDS.dataforseo.password}`).toString("base64")}`;
    const res = await fetch(`${sandbox.origin}/v3/not-a-real-endpoint`, { headers: { Authorization: auth } });
    expect(res.status).toBe(404);
  });

  it("DataForSEO: task_post missing the required 'keyword' field gets a vendor-shaped (200-carrying) error, not a fixture", async () => {
    const auth = `Basic ${Buffer.from(`${CREDS.dataforseo.login}:${CREDS.dataforseo.password}`).toString("base64")}`;
    const res = await fetch(`${sandbox.origin}/v3/serp/google/organic/task_post`, {
      method: "POST",
      headers: { Authorization: auth, "content-type": "application/json" },
      body: JSON.stringify([{ location_code: 2840 }]), // no keyword
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status_code: number };
    expect(body.status_code).toBeGreaterThanOrEqual(40000);
  });

  it("Ahrefs: an unrecognized path 404s (with valid auth)", async () => {
    const res = await fetch(`${sandbox.origin}/not-a-real-ahrefs-path`, { headers: { Authorization: `Bearer ${CREDS.ahrefs.apiKey}` } });
    expect(res.status).toBe(404);
  });

  it("Ahrefs: keywords-explorer/overview missing the required 'keywords' param gets HTTP 400, never a silently-served fixture", async () => {
    const res = await fetch(`${sandbox.origin}/keywords-explorer/overview?country=us`, {
      headers: { Authorization: `Bearer ${CREDS.ahrefs.apiKey}` },
    });
    expect(res.status).toBe(400);
  });

  it("Ahrefs: serp-overview missing the required project_id STILL enforces at the endpoint level "
    + "(independent of the driver's own pre-network refusal for the same case)", async () => {
    const res = await fetch(
      `${sandbox.origin}/serp-overview/serp-overview?keyword=k&country=us`, // no project_id
      { headers: { Authorization: `Bearer ${CREDS.ahrefs.apiKey}` } },
    );
    expect(res.status).toBe(400);
  });

  it("Semrush: a request with an unknown 'type' gets a vendor-shaped ERROR line, not a silent 200 fixture", async () => {
    const url = new URL(sandbox.origin);
    url.searchParams.set("key", CREDS.semrush.apiKey);
    url.searchParams.set("type", "not_a_real_report");
    url.searchParams.set("database", "us");
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/^ERROR \d+ ::/);
  });

  it("Semrush: phrase_organic missing the required 'phrase' param gets a vendor-shaped ERROR line", async () => {
    const url = new URL(sandbox.origin);
    url.searchParams.set("key", CREDS.semrush.apiKey);
    url.searchParams.set("type", "phrase_organic");
    url.searchParams.set("database", "us");
    const res = await fetch(url);
    const text = await res.text();
    expect(text).toMatch(/^ERROR \d+ ::/);
  });
});

describe("SM-49 AC 6 — auth strictness per vendor scheme (positive accepted, negative refused)", () => {
  let sandbox: VendorSandbox;

  beforeAll(async () => {
    sandbox = await startVendorSandbox(CREDS);
  });
  afterAll(async () => {
    await sandbox.close();
  });

  // ── DataForSEO: HTTP Basic ──────────────────────────────────────────────────────────────────────
  it("DataForSEO: the driver's REAL serialized Basic auth is accepted", async () => {
    const p = new DataForSeoProvider({
      login: CREDS.dataforseo.login, password: CREDS.dataforseo.password,
      baseUrl: sandbox.origin, queue: "standard", timeoutMs: 5000,
      pollAttempts: 1, pollIntervalMs: 1,
    });
    const refs = await p.postSerpTasks([{ keyword: "sm49-auth-ok-dfs" }]);
    expect(refs).toHaveLength(1);
  });

  it("DataForSEO: wrong credentials surface a typed failure through the driver, never silently succeed", async () => {
    const p = new DataForSeoProvider({
      login: "wrong", password: "creds",
      baseUrl: sandbox.origin, queue: "standard", timeoutMs: 5000,
    });
    await expect(p.postSerpTasks([{ keyword: "sm49-auth-bad-dfs" }])).rejects.toThrow(/HTTP 401/);
  });

  // ── Semrush: `key` query param ──────────────────────────────────────────────────────────────────
  it("Semrush: the driver's REAL serialized key= auth is accepted", async () => {
    const p = new SemrushProvider({
      apiKey: CREDS.semrush.apiKey, baseUrl: sandbox.origin, database: "us", timeoutMs: 5000, costPerUnitUsd: 0.001,
    });
    const res = await p.getBacklinkSummary("sm49-auth-ok-semrush.example");
    expect(res.target).toBe("sm49-auth-ok-semrush.example");
  });

  it("Semrush: a wrong key surfaces a typed failure through the driver's own error-line parser", async () => {
    const p = new SemrushProvider({
      apiKey: "wrong-key", baseUrl: sandbox.origin, database: "us", timeoutMs: 5000, costPerUnitUsd: 0.001,
    });
    await expect(p.getBacklinkSummary("sm49-auth-bad-semrush.example")).rejects.toThrow(/ERROR \d+/);
  });

  // ── Ahrefs: Bearer ──────────────────────────────────────────────────────────────────────────────
  it("Ahrefs: the driver's REAL serialized Bearer auth is accepted", async () => {
    const p = new AhrefsProvider({
      apiKey: CREDS.ahrefs.apiKey, baseUrl: sandbox.origin, timeoutMs: 5000, country: "us", costPerUnitUsd: 0.001,
    });
    const res = await p.getKeywordMetrics([{ keyword: "sm49-auth-ok-ahrefs" }]);
    expect(res).toHaveLength(1);
  });

  it("Ahrefs: a wrong bearer token surfaces a typed failure through dispatch, never the response body", async () => {
    const p = new AhrefsProvider({
      apiKey: "wrong-token", baseUrl: sandbox.origin, timeoutMs: 5000, country: "us", costPerUnitUsd: 0.001,
    });
    const err = await p.getKeywordMetrics([{ keyword: "sm49-auth-bad-ahrefs" }]).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain("bearer token"); // never echoes the error body
  });
});

describe("SM-49 AC 7 — vendor errors returned INSIDE a 200 (or the vendor's own error shape), parsed by the driver as typed refusals", () => {
  let sandbox: VendorSandbox;

  beforeAll(async () => {
    sandbox = await startVendorSandbox(CREDS);
  });
  afterAll(async () => {
    await sandbox.close();
  });

  it("DataForSEO: a task-level 40501 (task rejected) inside a 200 envelope throws a typed error naming the code", async () => {
    const p = new DataForSeoProvider({
      login: CREDS.dataforseo.login, password: CREDS.dataforseo.password,
      baseUrl: sandbox.origin, queue: "standard", timeoutMs: 5000,
    });
    await expect(p.postSerpTasks([{ keyword: `sm49 ${DFS_TASK_REJECTED_MARKER}` }])).rejects.toThrow(/40501/);
  });

  it("DataForSEO: a top-level 40401 envelope error (search_volume) throws before any row is parsed", async () => {
    const p = new DataForSeoProvider({
      login: CREDS.dataforseo.login, password: CREDS.dataforseo.password,
      baseUrl: sandbox.origin, queue: "standard", timeoutMs: 5000,
    });
    await expect(p.getKeywordMetrics([{ keyword: `sm49 ${DFS_ENVELOPE_ERROR_MARKER}` }])).rejects.toThrow(/40401/);
  });

  it("Semrush: an ERROR line (HTTP 200) throws a typed error naming the code and message", async () => {
    const p = new SemrushProvider({
      apiKey: CREDS.semrush.apiKey, baseUrl: sandbox.origin, database: "us", timeoutMs: 5000, costPerUnitUsd: 0.001,
    });
    await expect(p.getBacklinkSummary(`sm49-${SEMRUSH_ERROR_MARKER}.example`)).rejects.toThrow(/ERROR 50.*NOTHING FOUND/);
  });

  it("Ahrefs: a non-2xx JSON error body throws a typed error WITHOUT echoing the body", async () => {
    const p = new AhrefsProvider({
      apiKey: CREDS.ahrefs.apiKey, baseUrl: sandbox.origin, timeoutMs: 5000, country: "us", costPerUnitUsd: 0.001,
    });
    const err = await p.getBacklinkSummary(`sm49-${AHREFS_ERROR_MARKER}.example`).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 403/);
    expect((err as Error).message).not.toContain("sandbox-modeled");
  });
});
