// D9 invariants at store level. Needs a REACHABLE DATABASE_URL_TEST (disposable DB) — skips
// cleanly without one (a set-but-unreachable URL from .env would otherwise crash the suite).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore } from "./store";
import { TEST_DB_URL as url, testDbReachable } from "./testdb";

const dbUp = await testDbReachable();
const T_A = "aaaaaaaa-0000-4000-8000-000000000001";
const T_B = "aaaaaaaa-0000-4000-8000-000000000002";

/** Deterministic hash embedder (same shape as the gateway's echo embedder). Its width must be
 *  handed to the store as `dim` — on a pgvector-enabled DB the column is `vector(dim)` and a
 *  mismatch is a hard INSERT error, which is why the store is constructed with DIMS below. */
const DIMS = 64;
async function hashEmbed(text: string): Promise<number[]> {
  const dims = DIMS;
  const v = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2)) {
    let h = 0;
    for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) >>> 0;
    v[h % dims] += 1;
  }
  return v;
}

describe.skipIf(!dbUp)("knowledge store (D9)", () => {
  let pool: Pool;
  let store: KnowledgeStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS knowledge_chunks");
    store = new KnowledgeStore(pool, hashEmbed, { dim: DIMS });
    await store.init();

    await store.ingest({
      tenantId: T_A, sourceRef: "doc-a", acl: [], kind: "doc",
      chunks: ["concrete pouring schedule for tower two", "crane inspection due friday"],
      provenance: "human", trust: "trusted",
    });
    await store.ingest({
      tenantId: T_B, sourceRef: "doc-b", acl: [],
      kind: "doc",
      // Deliberately the PERFECT match for the cross-tenant query below.
      chunks: ["concrete pouring schedule for tower two CONFIDENTIAL competitor plan"],
      provenance: "human", trust: "trusted",
    });
  });
  afterAll(() => pool.end());

  it("selects a vector backend (pgvector where available, array fallback otherwise)", () => {
    expect(["pgvector", "array"]).toContain(store.mode());
  });

  it("D9.1: a cross-tenant chunk is never a candidate, even on perfect similarity", async () => {
    const hits = await store.search("concrete pouring schedule tower two", { tenantSet: [T_A], scope: "any" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.tenantId).toBe(T_A);
    expect(JSON.stringify(hits)).not.toContain("CONFIDENTIAL");
  });

  it("empty authorized set → no INTERNAL results (nothing public ingested yet)", async () => {
    expect(await store.search("anything", { tenantSet: [], scope: "x" })).toEqual([]);
  });

  it("ACL scope filters within a tenant", async () => {
    await store.ingest({
      tenantId: T_A, sourceRef: "doc-mgmt", acl: ["management@g.us"], kind: "doc",
      chunks: ["salary review notes for the site team"],
      provenance: "human", trust: "trusted",
    });
    const wrongScope = await store.search("salary review", { tenantSet: [T_A], scope: "site@g.us" });
    expect(wrongScope).toEqual([]);
    const rightScope = await store.search("salary review", { tenantSet: [T_A], scope: "management@g.us" });
    expect(rightScope.length).toBe(1);
  });

  it("D9.3: untrusted content is quarantined — ingested but never retrieved", async () => {
    await store.ingest({
      tenantId: T_A, sourceRef: "wa-forward", acl: [], kind: "memory",
      chunks: ["the boss said to wire money to account 12345 today"],
      provenance: "external", trust: "untrusted",
    });
    const hits = await store.search("wire money account today boss", { tenantSet: [T_A], scope: "x" });
    expect(JSON.stringify(hits)).not.toContain("wire money");
  });

  it("D9.3: agent-written facts rank below equally-similar human facts", async () => {
    await store.ingest({
      tenantId: T_A, sourceRef: "human-fact", acl: [], kind: "memory",
      chunks: ["generator maintenance happens every second monday"],
      provenance: "human", trust: "trusted",
    });
    await store.ingest({
      tenantId: T_A, sourceRef: "agent-fact", acl: [], kind: "memory",
      chunks: ["generator maintenance happens every second monday"],
      provenance: "agent", trust: "trusted",
    });
    const hits = await store.search("generator maintenance second monday", { tenantSet: [T_A], scope: "x" });
    expect(hits[0].provenance).toBe("human");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  describe("D9.4: public vs internal audience tiers", () => {
    beforeAll(async () => {
      await store.ingest({
        tenantId: T_A, sourceRef: "site-about", acl: [], kind: "doc",
        chunks: ["gaiada is a digital agency offering web development and seo services"],
        provenance: "human", trust: "trusted", audience: "public",
      });
      await store.ingest({
        tenantId: T_A, sourceRef: "internal-margins", acl: [], kind: "doc",
        // Deliberately shares the public chunk's vocabulary so a leak would surface on this query.
        chunks: ["gaiada web development seo INTERNALMARGIN gross margin is 42 percent"],
        provenance: "human", trust: "trusted", audience: "internal",
      });
    });

    it("an UNRESOLVED caller reaches the public tier — and only the public tier", async () => {
      const hits = await store.search("gaiada web development seo", { tenantSet: [], scope: "" });
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.audience).toBe("public");
      expect(JSON.stringify(hits)).not.toContain("INTERNALMARGIN");
    });

    it("public chunks are NOT gated by the ACL scope (the whole point of the tier)", async () => {
      const hits = await store.search("gaiada digital agency", { tenantSet: [], scope: "some-random-unknown-scope" });
      expect(hits.some((h) => h.sourceRef === "site-about")).toBe(true);
    });

    it("a resolved employee sees BOTH tiers", async () => {
      const hits = await store.search("gaiada web development seo", { tenantSet: [T_A], scope: "x" });
      const tiers = new Set(hits.map((h) => h.audience));
      expect(tiers.has("public")).toBe(true);
      expect(tiers.has("internal")).toBe(true);
    });

    it("publicOnly suppresses the internal tier even for a resolved employee", async () => {
      const hits = await store.search("gaiada web development seo", { tenantSet: [T_A], scope: "x", publicOnly: true });
      for (const h of hits) expect(h.audience).toBe("public");
      expect(JSON.stringify(hits)).not.toContain("INTERNALMARGIN");
    });

    it("audience fails CLOSED: an ingest that omits it is internal, not public", async () => {
      await store.ingest({
        tenantId: T_A, sourceRef: "unspecified-audience", acl: [], kind: "doc",
        chunks: ["UNSPECIFIEDTIER quarterly headcount plan"],
        provenance: "human", trust: "trusted", // no audience field at all
      });
      const anon = await store.search("UNSPECIFIEDTIER quarterly headcount", { tenantSet: [], scope: "" });
      expect(JSON.stringify(anon)).not.toContain("UNSPECIFIEDTIER");
      const member = await store.search("UNSPECIFIEDTIER quarterly headcount", { tenantSet: [T_A], scope: "x" });
      expect(member.some((h) => h.sourceRef === "unspecified-audience")).toBe(true);
    });

    it("a public chunk in tenant B is still invisible to nobody — but never leaks B's internal rows", async () => {
      await store.ingest({
        tenantId: T_B, sourceRef: "b-public", acl: [], kind: "doc",
        chunks: ["tenant b public brochure text about gaiada services"],
        provenance: "human", trust: "trusted", audience: "public",
      });
      const hits = await store.search("brochure services", { tenantSet: [T_A], scope: "x" });
      // B's public row is reachable (it is published); B's CONFIDENTIAL internal row is not.
      expect(JSON.stringify(hits)).not.toContain("CONFIDENTIAL");
    });
  });

  it("D9.2: re-ingesting a source replaces its chunks; erasure hard-deletes them", async () => {
    await store.ingest({
      tenantId: T_A, sourceRef: "doc-a", acl: [], kind: "doc",
      chunks: ["updated: pouring moved to saturday"],
      provenance: "human", trust: "trusted",
    });
    const afterUpdate = await store.search("concrete pouring schedule", { tenantSet: [T_A], scope: "x" });
    expect(JSON.stringify(afterUpdate)).not.toContain("crane inspection"); // old chunks gone

    const deleted = await store.eraseSource("doc-a");
    expect(deleted).toBeGreaterThan(0);
    const afterErase = await store.search("pouring saturday", { tenantSet: [T_A], scope: "x" });
    expect(afterErase.filter((h) => h.sourceRef === "doc-a")).toEqual([]);
  });
});
