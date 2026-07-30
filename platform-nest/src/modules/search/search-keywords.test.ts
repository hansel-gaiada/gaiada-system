// SM-09 — keyword-set CRUD, CSV/paste import, /embed embeddings, dual-mode clustering + Hermes
// intent/labels, against LIVE Postgres (RLS) + the real HTTP layer, same harness as search.test.ts
// (SM-02). Cerbos is stubbed to always-allow here too (SM-03's resource_search_keyword.yaml parity
// matrix is covered separately by search-cerbos.test.ts) — this file exercises what SM-09 actually
// owns: the routes, tenant/RLS scoping, FK tenant-validation, and the clustering/embedding pipeline.
//
// The AI gateway is mocked at the module boundary (embedViaGateway/completeViaGateway) so these
// tests need no live ai-gateway-go — gateway-client.test.ts already proves the real HTTP contract
// and the "gateway is the only egress path" property in isolation.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { searchModule } from "./index";
import { recomputeRollups, syncMetricDefinitions, resetCoreRollupProviders } from "../../rollups/engine";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

// Deterministic synthetic embedding: a pure function of the keyword TEXT (never Math.random), so
// re-running a test (or the whole suite) reproduces byte-identical vectors. Keywords are named
// `t{topic}-kw{item}` by the fixtures below; unrecognized text (e.g. from other endpoint tests)
// still gets a stable low-dimension embedding derived from its char codes, so /embed never throws.
// One dominant axis per topic (near-orthogonal bases) -> reliably well-separated clusters
// regardless of topic count, deterministically (no RNG). `dim` covers the largest topic count any
// test in this file uses (the 1k fixture below uses 20 topics) plus headroom.
function syntheticEmbedding(text: string, dim = 24): number[] {
  const m = /^t(\d+)-kw(\d+)$/.exec(text);
  if (m) {
    const topic = Number(m[1]);
    const item = Number(m[2]);
    const base = Array.from({ length: dim }, (_, d) => (d === topic % dim ? 5 : Math.sin(d + topic) * 0.01));
    const wobble = Array.from({ length: dim }, (_, d) => Math.cos(item * 0.017 + d * 0.7) * 0.02);
    return base.map((b, d) => b + wobble[d]);
  }
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed += text.charCodeAt(i) * (i + 1);
  return Array.from({ length: dim }, (_, d) => Math.sin(seed + d));
}

vi.mock("./providers/gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/gateway-client")>();
  return {
    ...actual,
    embedViaGateway: vi.fn(async (text: string) => syntheticEmbedding(text)),
    completeViaGateway: vi.fn(async (prompt: string) => {
      // Deterministic "Hermes" stand-in: label = the first keyword named in the prompt, intent
      // cycles off that keyword's char-code sum so different clusters get different intents.
      const m = /Keywords: ([^\n]+)/.exec(prompt);
      const first = (m?.[1] ?? "cluster").split(",")[0].trim();
      const intents = ["informational", "commercial", "transactional", "navigational"] as const;
      let seed = 0;
      for (let i = 0; i < first.length; i++) seed += first.charCodeAt(i);
      return { text: JSON.stringify({ label: `${first} theme`, intent: intents[seed % intents.length] }), provider: "hermes-mock" };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("search-marketing keywords (SM-09)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let engagementId: string;
  let propertyId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM09 Co A", ["search"]);
    C = await createCompany("SM09 Co C", ["search"]);
    uA = await createUser("sm09-a@a.test");
    uC = await createUser("sm09-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM09 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm09.example.com", siteUrl: "https://sm09.example.com" },
    });
    propertyId = propRes.json().id as string;
    const engRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM09 Engagement" },
    });
    engagementId = engRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("keyword-set CRUD + CSV/paste import, with dedupe and cross-tenant isolation", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "Seed set", source: "client" },
    });
    expect(create.statusCode).toBe(201);
    const setId = create.json().id as string;

    const importRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
      payload: { text: "keyword,locale\nrunning shoes,en-US\nbest running shoes,en-US\nrunning shoes,en-US" },
    });
    expect(importRes.statusCode).toBe(200);
    // parseKeywordImport dedupes WITHIN the pasted text itself (keyword-import.test.ts covers that in
    // isolation), so `submitted` here is the post-dedupe count (2) — the repeated "running shoes,
    // en-US" line never reaches the DB as a separate row to begin with.
    expect(importRes.json()).toEqual({ imported: 2, submitted: 2, duplicates: 0 });

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ keyword: string; hasEmbedding: boolean }>;
    expect(rows.map((r) => r.keyword).sort()).toEqual(["best running shoes", "running shoes"]);
    expect(rows.every((r) => r.hasEmbedding === false)).toBe(true);

    // A SECOND import re-submitting an already-persisted (keyword, locale) exercises the DB-level
    // `ON CONFLICT DO NOTHING` dedupe path (distinct from parseKeywordImport's in-text dedupe above).
    const reimport = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
      payload: { text: "keyword,locale\nrunning shoes,en-US\nnew keyword,en-US" },
    });
    expect(reimport.json()).toEqual({ imported: 1, submitted: 2, duplicates: 1 });

    // Cross-tenant: C cannot see A's keyword set at all.
    const cross = await app.inject({ method: "GET", url: `/api/${C}/modules/search/keyword-sets/${setId}`, headers: asUser(uC) });
    expect(cross.statusCode).toBe(404);
  });

  it("rejects a keyword-set create whose engagementId is not visible in this tenant (FK tenant-validation)", async () => {
    // Any id not present in A's RLS-scoped view fails the same way a genuine cross-tenant id would —
    // engagementRow() runs its SELECT under withTenants([A]), so a real other-tenant row and a
    // syntactically-valid-but-nonexistent uuid are indistinguishable to this check by construction.
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId: "00000000-0000-0000-0000-000000000000", name: "Should fail" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/engagementId not found/);
  });

  it("/embed writes a real embedding via the mocked ai-gateway-go client (array-mode fallback on this machine)", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "Embed set" },
    });
    const setId = create.json().id as string;
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
      payload: { text: "t0-kw0\nt0-kw1\nt1-kw0" },
    });

    const embed = await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {} });
    expect(embed.statusCode).toBe(200);
    const body = embed.json() as { mode: string; embedded: number };
    expect(body.embedded).toBe(3);
    // pgvector is NOT installed on this machine (design §12 OQ-8) — this is the real, live-verified
    // dual-mode branch that actually runs here, not an assumption.
    expect(body.mode).toBe("array");

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
    expect((list.json() as Array<{ hasEmbedding: boolean }>).every((r) => r.hasEmbedding)).toBe(true);

    // Re-embedding with onlyMissing (default) is a no-op; onlyMissing:false forces every row again.
    const again = await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {} });
    expect(again.json()).toMatchObject({ embedded: 0 });
    const force = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: { onlyMissing: false },
    });
    expect(force.json()).toMatchObject({ embedded: 3 });

    // ADVERSARIAL (QA, SM-09 tenant isolation): unlike keyword-set read + /cluster (already
    // covered above), /embed itself had NO cross-tenant test — closing that gap here. Tenant C
    // must not be able to embed (or discover the existence of) tenant A's keyword set via this id.
    const cross = await app.inject({
      method: "POST", url: `/api/${C}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uC), payload: {},
    });
    expect(cross.statusCode).toBe(404);
  });

  it("clusters keywords + persists Hermes intent/label, and rejects clustering a different tenant's set", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "Cluster set" },
    });
    const setId = create.json().id as string;
    const csv = Array.from({ length: 3 }, (_, t) => Array.from({ length: 4 }, (_, i) => `t${t}-kw${i}`).join("\n")).join("\n");
    await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA), payload: { text: csv } });
    await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {} });

    const cluster = await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/cluster`, headers: asUser(uA), payload: {} });
    expect(cluster.statusCode).toBe(200);
    const result = cluster.json() as { clusters: Array<{ label: string; intent: string; size: number }>; skipped: number };
    expect(result.skipped).toBe(0);
    expect(result.clusters).toHaveLength(3); // 3 well-separated synthetic topics

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
    const rows = list.json() as Array<{ intent: string | null; clusterLabel: string | null; clusterId: string | null }>;
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      expect(r.intent).not.toBeNull();
      expect(r.clusterLabel).not.toBeNull();
      expect(r.clusterId).not.toBeNull();
    }

    // Cross-tenant: C cannot trigger clustering on A's set.
    const cross = await app.inject({ method: "POST", url: `/api/${C}/modules/search/keyword-sets/${setId}/cluster`, headers: asUser(uC), payload: {} });
    expect(cross.statusCode).toBe(404);
  });

  // ── The AC's literal scale: "1k-keyword fixture clusters deterministically ... intents persisted" ──
  it(
    "clusters a 1k-keyword fixture deterministically end-to-end (import -> embed -> cluster x2) and persists intents",
    async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
        payload: { engagementId, name: "1k fixture set" },
      });
      const setId = create.json().id as string;

      const TOPICS = 20;
      const PER_TOPIC = 50;
      const lines: string[] = [];
      for (let t = 0; t < TOPICS; t++) for (let i = 0; i < PER_TOPIC; i++) lines.push(`t${t}-kw${i}`);
      expect(lines).toHaveLength(1000);

      const importRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
        payload: { text: lines.join("\n") },
      });
      expect(importRes.json()).toMatchObject({ imported: 1000 });

      const embed = await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {} });
      expect(embed.json()).toMatchObject({ embedded: 1000, mode: "array" });

      async function clusterAndSnapshot() {
        const res = await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/cluster`, headers: asUser(uA), payload: {} });
        expect(res.statusCode).toBe(200);
        const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
        const rows = list.json() as Array<{ id: string; keyword: string; clusterId: string; intent: string | null }>;
        expect(rows).toHaveLength(1000);
        // Canonical partition signature: group keyword NAMES (stable across runs, unlike the fresh
        // cluster_id uuid minted every run) by clusterId, sort within + across groups.
        const byCluster = new Map<string, string[]>();
        for (const r of rows) {
          expect(r.intent, `keyword ${r.keyword} has no intent persisted`).not.toBeNull();
          const arr = byCluster.get(r.clusterId) ?? [];
          arr.push(r.keyword);
          byCluster.set(r.clusterId, arr);
        }
        const partition = [...byCluster.values()].map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
        return partition;
      }

      const run1 = await clusterAndSnapshot();
      const run2 = await clusterAndSnapshot();
      expect(run1).toEqual(run2); // byte-identical partition across two independent cluster runs
      expect(run1).toHaveLength(TOPICS);
      for (const group of run1) expect(group).toHaveLength(PER_TOPIC);
    },
    30000,
  );

  // ADVERSARIAL (QA, SM-09 determinism): the 1k-fixture test above always imports keywords in the
  // SAME order they'd sort alphabetically-ish (t0-kw0, t0-kw1, ... t19-kw49), which risks the
  // determinism proof being an artifact of "insertion order happened to already look sorted"
  // rather than proof the ORDER BY clause genuinely normalizes arbitrary insertion order. This test
  // imports the identical keyword SET via two separate keyword-sets, one in forward order and one
  // FISHER-YATES SHUFFLED (deterministic seed, not Math.random, so the test itself is reproducible),
  // then asserts both converge to the identical canonical partition — proving determinism comes
  // from the `ORDER BY keyword ASC, id ASC` read, not from a lucky insertion order.
  it("clustering is deterministic regardless of import ORDER (not an artifact of a pre-sorted fixture)", async () => {
    const TOPICS = 8;
    const PER_TOPIC = 10;
    const keywords: string[] = [];
    for (let t = 0; t < TOPICS; t++) for (let i = 0; i < PER_TOPIC; i++) keywords.push(`t${t}-kw${i}`);

    // Deterministic pseudo-shuffle (LCG, fixed seed) — reproducible across runs/CI, not Math.random.
    function shuffled<T>(arr: T[], seed = 42): T[] {
      let s = seed;
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
    const shuffledKeywords = shuffled(keywords);
    expect(shuffledKeywords).not.toEqual(keywords); // sanity: the shuffle actually reordered something

    async function importEmbedClusterSnapshot(order: string[]) {
      const create = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
        payload: { engagementId, name: `order-test-${order === keywords ? "forward" : "shuffled"}` },
      });
      const setId = create.json().id as string;
      await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
        payload: { text: order.join("\n") },
      });
      await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {} });
      await app.inject({ method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/cluster`, headers: asUser(uA), payload: {} });
      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
      const rows = list.json() as Array<{ keyword: string; clusterId: string }>;
      const byCluster = new Map<string, string[]>();
      for (const r of rows) {
        const arr = byCluster.get(r.clusterId) ?? [];
        arr.push(r.keyword);
        byCluster.set(r.clusterId, arr);
      }
      return [...byCluster.values()].map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
    }

    const forwardPartition = await importEmbedClusterSnapshot(keywords);
    const shuffledPartition = await importEmbedClusterSnapshot(shuffledKeywords);
    expect(shuffledPartition).toEqual(forwardPartition);
  }, 30000);

  // ── SM-32 gate defect fix: bound keyword-set cardinality ────────────────────────────────────────
  it("SM-32: /import rejects an over-cap submission outright (no truncation), and /embed + /cluster refuse an over-cap set", async () => {
    const originalCap = config.search.maxKeywordsPerSet;
    try {
      config.search.maxKeywordsPerSet = 3;

      const create = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
        payload: { engagementId, name: "Cap-test set" },
      });
      const setId = create.json().id as string;

      // Importing exactly at the cap succeeds.
      const atCap = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
        payload: { text: "cap-kw-1\ncap-kw-2\ncap-kw-3" },
      });
      expect(atCap.statusCode).toBe(200);
      expect(atCap.json()).toMatchObject({ imported: 3 });

      // A further import that would push the set OVER the cap is rejected outright, naming the
      // limit — never silently truncated (a truncated 200 would be data loss disguised as success).
      const overCap = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/import`, headers: asUser(uA),
        payload: { text: "cap-kw-4" },
      });
      expect(overCap.statusCode).toBe(400);
      expect(overCap.json().error).toMatch(/exceeding the 3-keyword cap/);

      // Confirm the rejected import inserted nothing (still exactly the 3 from the first call).
      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/keyword-sets/${setId}/keywords`, headers: asUser(uA) });
      expect(list.json()).toHaveLength(3);

      // Lower the cap BELOW the set's existing count (simulating a set that grew over several prior
      // imports each individually under cap) and confirm /embed and /cluster REFUSE rather than
      // looping over an uncapped read, instead of silently processing only the first N.
      config.search.maxKeywordsPerSet = 2;
      const embedOverCap = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/embed`, headers: asUser(uA), payload: {},
      });
      expect(embedOverCap.statusCode).toBe(400);
      expect(embedOverCap.json().error).toMatch(/exceeding the 2-keyword cap/);

      const clusterOverCap = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/keyword-sets/${setId}/cluster`, headers: asUser(uA), payload: {},
      });
      expect(clusterOverCap.statusCode).toBe(400);
      expect(clusterOverCap.json().error).toMatch(/exceeding the 2-keyword cap/);
    } finally {
      config.search.maxKeywordsPerSet = originalCap;
    }
  });

  it("recomputes rollups without error once keyword data exists (sanity: no regression to SM-02's rollup providers)", async () => {
    await expect(recomputeRollups(A, "2026-07-01")).resolves.not.toThrow();
    expect(getModule("search")).toBe(searchModule);
  });
});
