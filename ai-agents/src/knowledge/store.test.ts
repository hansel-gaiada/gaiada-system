// D9 invariants at store level. Needs a REACHABLE DATABASE_URL_TEST (disposable DB) — skips
// cleanly without one (a set-but-unreachable URL from .env would otherwise crash the suite).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore, normaliseDepartmentId, normaliseSearchDepartment, parseDepartmentBoost, type IngestDoc } from "./store";
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

  // ── Re-ingest skips unchanged chunks (2026-10-28: a sweep re-embedded the whole corpus daily and
  // exhausted the AI gateway's 2,000-call cap). The embedder here counts calls and can be made to fail
  // like the gateway's 429, over the same table as the store above.
  describe("re-ingest embeds only what changed", () => {
    const REF = "reingest-doc";
    let calls: string[];
    let failAfter: number;
    let counting: KnowledgeStore;
    const embed = async (text: string) => {
      if (calls.length >= failAfter) throw new Error("gateway /embed 429");
      calls.push(text);
      return hashEmbed(text);
    };
    const doc = (chunks: string[], extra: Partial<Parameters<KnowledgeStore["ingest"]>[0]> = {}) => ({
      tenantId: T_A, sourceRef: REF, acl: [] as string[], kind: "doc" as const, chunks,
      provenance: "human" as const, trust: "trusted" as const, ...extra,
    });
    const rows = async () =>
      (await pool.query<{ id: string; text: string }>(`SELECT id, text FROM knowledge_chunks WHERE source_ref = $1 ORDER BY text`, [REF])).rows;

    beforeEach(async () => {
      calls = [];
      failAfter = Infinity;
      counting = new KnowledgeStore(pool, embed, { dim: DIMS });
      await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref = $1`, [REF]);
    });

    it("an unchanged chunk is not embedded again and keeps its row", async () => {
      await counting.ingest(doc(["alpha unchanged paragraph", "beta unchanged paragraph"]));
      const first = await rows();
      calls = [];
      const r = await counting.ingestDetailed(doc(["alpha unchanged paragraph", "beta unchanged paragraph"]));
      expect(calls).toEqual([]);
      expect(r).toEqual({ written: 2, embedded: 0, reused: 2 });
      expect(await rows()).toEqual(first); // same ids: nothing was deleted and re-inserted
    });

    it("a changed chunk is re-embedded, a new one is embedded, a removed one is deleted", async () => {
      await counting.ingest(doc(["keep this paragraph", "edit this paragraph", "drop this paragraph"]));
      calls = [];
      const r = await counting.ingestDetailed(doc(["keep this paragraph", "edited this paragraph", "brand new paragraph"]));
      expect(calls.sort()).toEqual(["brand new paragraph", "edited this paragraph"]);
      expect(r).toEqual({ written: 3, embedded: 2, reused: 1 });
      expect((await rows()).map((x) => x.text)).toEqual(["brand new paragraph", "edited this paragraph", "keep this paragraph"]);
    });

    it("repeated identical chunks are matched as a multiset", async () => {
      await counting.ingest(doc(["same line", "same line"]));
      calls = [];
      await counting.ingest(doc(["same line", "same line", "same line"]));
      expect(calls).toEqual(["same line"]); // two reused, one new
      expect(await rows()).toHaveLength(3);
      await counting.ingest(doc(["same line"]));
      expect(await rows()).toHaveLength(1);
    });

    it("a kept chunk still takes the new metadata (acl, trust => quarantine, audience)", async () => {
      await counting.ingest(doc(["secret paragraph"]));
      await counting.ingest(doc(["secret paragraph"], { acl: ["finance"], trust: "untrusted" }));
      const { rows: r } = await pool.query(`SELECT acl, quarantined FROM knowledge_chunks WHERE source_ref = $1`, [REF]);
      expect(r).toEqual([{ acl: ["finance"], quarantined: true }]);
    });

    it("an embedding failure midway leaves the stored source exactly as it was", async () => {
      await counting.ingest(doc(["stays one", "stays two"]));
      const before = await rows();
      calls = [];
      failAfter = 1; // the first new chunk embeds, the second is refused
      await expect(counting.ingest(doc(["stays one", "new one", "new two"]))).rejects.toThrow(/429/);
      expect(await rows()).toEqual(before);
    });

    it("kept and fresh chunks are both retrievable by similarity", async () => {
      await counting.ingest(doc(["zebra stripes pattern"]));
      await counting.ingest(doc(["zebra stripes pattern", "giraffe spotted neck"]));
      const hits = await counting.search("giraffe neck", { tenantSet: [T_A], scope: "x" });
      expect(hits.some((h) => h.text === "giraffe spotted neck")).toBe(true);
      const kept = await counting.search("zebra stripes", { tenantSet: [T_A], scope: "x" });
      expect(kept.some((h) => h.text === "zebra stripes pattern")).toBe(true);
    });
  });
});

// ── AIP-11 / AIP-12: a chunk's department, and the ranking boost for the asker's own department ────────────────────
// The pure halves (how an id and a boost are read) run without a database; the SQL and array backends need the DB.
describe("department inputs are read fail-soft", () => {
  it("normaliseDepartmentId keeps a trimmed non-empty string of at most 100 characters, else null", () => {
    expect(normaliseDepartmentId("d-seo")).toBe("d-seo");
    expect(normaliseDepartmentId("  d-seo \n")).toBe("d-seo");
    expect(normaliseDepartmentId("x".repeat(100))).toBe("x".repeat(100));
    expect(normaliseDepartmentId("x".repeat(101))).toBeNull(); // dropped, not truncated: a cut id would name another department
    for (const bad of ["", "   ", null, undefined, 7, {}, ["d-seo"], true]) expect(normaliseDepartmentId(bad)).toBeNull();
  });

  it("normaliseSearchDepartment needs a uuid tenant and a usable node id, and ignores everything else", () => {
    const t = "AAAAAAAA-0000-4000-8000-000000000001";
    expect(normaliseSearchDepartment({ tenantId: t, nodeId: " d-seo " })).toEqual({ tenantId: t.toLowerCase(), nodeId: "d-seo" });
    for (const bad of [
      undefined, null, "d-seo", 5, [],
      { tenantId: "not-a-uuid", nodeId: "d-seo" },
      { tenantId: t },
      { tenantId: t, nodeId: "" },
      { tenantId: t, nodeId: "x".repeat(101) },
      { tenantId: 12, nodeId: "d-seo" },
      { tenantId: t, nodeId: 12 },
    ]) expect(normaliseSearchDepartment(bad)).toBeNull();
  });

  it("parseDepartmentBoost: missing, empty or NaN is 1.25; anything else is clamped to [1, 2]", () => {
    for (const d of [undefined, null, "", "  ", "abc", Number.NaN]) expect(parseDepartmentBoost(d)).toBe(1.25);
    expect(parseDepartmentBoost("1.5")).toBe(1.5);
    expect(parseDepartmentBoost(1.1)).toBe(1.1);
    expect(parseDepartmentBoost("0.5")).toBe(1); // never a demotion
    expect(parseDepartmentBoost("-3")).toBe(1);
    expect(parseDepartmentBoost("9")).toBe(2); // never a partition
    expect(parseDepartmentBoost("Infinity")).toBe(2);
  });
});

describe.skipIf(!dbUp)("knowledge store: department column and boost (AIP-11/12)", () => {
  const T_C = "aaaaaaaa-0000-4000-8000-000000000003"; // a company the asker is NOT authorized for
  const SEO = "d-seo";
  const QUERY = "kestrel falcon osprey";
  let pool: Pool;
  let store: KnowledgeStore;
  let calls: string[];

  // A fixed vocabulary, one dimension per word, so the similarities below are exact (the hash embedder can collide
  // buckets). Text with none of the words lands on its own dimension: a zero vector would make pgvector's cosine NaN.
  const VOCAB = ["kestrel", "falcon", "osprey", "harrier"];
  const embed = async (text: string): Promise<number[]> => {
    calls.push(text);
    const v = new Array<number>(DIMS).fill(0);
    const words = text.toLowerCase().split(/[^a-z]+/);
    VOCAB.forEach((w, i) => { if (words.includes(w)) v[i] = 1; });
    if (!v.some((x) => x !== 0)) v[DIMS - 1] = 1;
    return v;
  };

  const put = (tenantId: string, sourceRef: string, chunk: string, extra: Partial<IngestDoc> = {}) =>
    store.ingestDetailed({
      tenantId, sourceRef, acl: [], kind: "doc", chunks: [chunk], provenance: "human", trust: "trusted", ...extra,
    });
  const ranked = async (ctx: Parameters<KnowledgeStore["search"]>[1]) =>
    (await store.search(QUERY, { topK: 100, ...ctx })).filter((h) => h.sourceRef.startsWith("dept-"));
  const byRef = (hits: Awaited<ReturnType<typeof ranked>>, ref: string) => hits.find((h) => h.sourceRef === ref);
  const dbDept = async (ref: string) =>
    (await pool.query<{ department_id: string | null }>(`SELECT department_id FROM knowledge_chunks WHERE source_ref = $1`, [ref])).rows.map((r) => r.department_id);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    calls = [];
    store = new KnowledgeStore(pool, embed, { dim: DIMS });
    await store.init();
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref LIKE 'dept-%'`);
    // The company-wide chunk is the PERFECT match for QUERY (similarity 1); every department chunk is a little less similar
    // (0.866, one extra word), so only the boost can put a department chunk first.
    await put(T_A, "dept-general", "kestrel falcon osprey");
    await put(T_A, "dept-seo", "kestrel falcon osprey harrier", { departmentId: SEO });
    await put(T_A, "dept-hr", "kestrel falcon osprey harrier", { departmentId: "d-hr" });
    await put(T_B, "dept-b-seo", "kestrel falcon osprey harrier", { departmentId: SEO }); // same node id, ANOTHER company
    await put(T_C, "dept-c-seo", "kestrel falcon osprey", { departmentId: SEO }); // a perfect match in a company nobody here may read
    await put(T_A, "dept-public", "kestrel falcon osprey harrier", { departmentId: SEO, audience: "public" });
    await put(T_A, "dept-zero", "nothing relevant at all", { departmentId: SEO }); // similarity 0
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref LIKE 'dept-%'`);
    await pool.end();
  });

  it("the column exists, with its index", async () => {
    const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'knowledge_chunks' AND column_name = 'department_id'`);
    expect(col.rowCount).toBe(1);
    const idx = await pool.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'knowledge_chunks' AND indexname = 'idx_knowledge_tenant_dept'`);
    expect(idx.rowCount).toBe(1);
  });

  it("stores the department on ingest, normalised, and returns it on the hit", async () => {
    expect(await dbDept("dept-seo")).toEqual([SEO]);
    expect(await dbDept("dept-general")).toEqual([null]);
    const hits = await ranked({ tenantSet: [T_A], scope: "x" });
    expect(byRef(hits, "dept-seo")?.departmentId).toBe(SEO);
    expect(byRef(hits, "dept-general")?.departmentId).toBeNull();

    await put(T_A, "dept-norm", "kestrel one", { departmentId: "  d-ops  " });
    expect(await dbDept("dept-norm")).toEqual(["d-ops"]);
    for (const bad of ["", "   ", "x".repeat(101), 42 as unknown as string, null]) {
      await put(T_A, "dept-norm", "kestrel one", { departmentId: "d-ops" });
      await put(T_A, "dept-norm", "kestrel one", { departmentId: bad });
      expect(await dbDept("dept-norm")).toEqual([null]);
    }
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref = 'dept-norm'`);
  });

  it("the backfill: re-ingesting the SAME text with a department embeds nothing and stamps the existing rows", async () => {
    await put(T_A, "dept-backfill", "kestrel backfill paragraph two"); // the row as an old store left it: no department
    const before = (await pool.query<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE source_ref = 'dept-backfill'`)).rows;
    expect(await dbDept("dept-backfill")).toEqual([null]);

    calls = [];
    const r = await put(T_A, "dept-backfill", "kestrel backfill paragraph two", { departmentId: SEO });
    expect(calls).toEqual([]); // nothing was embedded: the stored text is the identity
    expect(r).toEqual({ written: 1, embedded: 0, reused: 1 });
    expect(await dbDept("dept-backfill")).toEqual([SEO]);
    expect((await pool.query<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE source_ref = 'dept-backfill'`)).rows).toEqual(before); // same row

    // and the other way: a record that left its department is cleared on the next sweep, again without an embed
    calls = [];
    await put(T_A, "dept-backfill", "kestrel backfill paragraph two");
    expect(calls).toEqual([]);
    expect(await dbDept("dept-backfill")).toEqual([null]);
    await pool.query(`DELETE FROM knowledge_chunks WHERE source_ref = 'dept-backfill'`);
  });

  it("with no department the order is the pure similarity order and nothing carries a boost", async () => {
    const hits = await ranked({ tenantSet: [T_A], scope: "x" });
    expect(hits[0].sourceRef).toBe("dept-general");
    expect(byRef(hits, "dept-general")!.score).toBeCloseTo(1, 4);
    expect(byRef(hits, "dept-seo")!.score).toBeCloseTo(0.866, 3);
    expect(byRef(hits, "dept-hr")!.score).toBeCloseTo(0.866, 3);
  });

  it("the boost puts a slightly-less-similar chunk of the asker's department first, and boosts only that department", async () => {
    const base = await ranked({ tenantSet: [T_A], scope: "x" });
    const hits = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 1.25 });
    expect(hits[0].sourceRef).toBe("dept-seo");
    expect(byRef(hits, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score * 1.25, 4); // the boosted score is the one returned
    expect(byRef(hits, "dept-general")!.score).toBeCloseTo(byRef(base, "dept-general")!.score, 6); // company-wide: untouched
    expect(byRef(hits, "dept-hr")!.score).toBeCloseTo(byRef(base, "dept-hr")!.score, 6); // another department: untouched
  });

  it("it is a boost, not a partition: a much more similar company chunk still beats a weak department chunk", async () => {
    const hits = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 1.05 });
    expect(hits[0].sourceRef).toBe("dept-general"); // 1.0 against 0.866 * 1.05 = 0.909
  });

  it("the factor is clamped to [1, 2] inside the store too", async () => {
    const base = await ranked({ tenantSet: [T_A], scope: "x" });
    const high = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 50 });
    expect(byRef(high, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score * 2, 4);
    const low = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 0.1 });
    expect(byRef(low, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score, 6);
    const none = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO } }); // default 1.25
    expect(byRef(none, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score * 1.25, 4);
  });

  it("the boost never adds a row: a department of a company outside the tenant set is not a candidate, perfect match or not", async () => {
    // Asking as company C's department while authorized for A only: C's perfect-match chunk must not appear.
    const asC = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_C, nodeId: SEO } });
    expect(asC.some((h) => h.tenantId === T_C)).toBe(false);
    // Asking as A's department while authorized for A and B only: C's chunk still must not appear.
    const asA = await ranked({ tenantSet: [T_A, T_B], scope: "x", department: { tenantId: T_A, nodeId: SEO } });
    expect(asA.some((h) => h.sourceRef === "dept-c-seo")).toBe(false);
    // and without any internal authorization the department adds nothing at all
    const anon = await ranked({ tenantSet: [], scope: "", department: { tenantId: T_A, nodeId: SEO } });
    expect(anon.every((h) => h.audience === "public")).toBe(true);
    // a boost cannot rescue a chunk with no similarity (the score > 0 cut is on the base score)
    const withDept = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 2 });
    expect(byRef(withDept, "dept-zero")).toBeUndefined();
  });

  it("the same node id in ANOTHER authorized company is not boosted (node ids repeat across companies)", async () => {
    const base = await ranked({ tenantSet: [T_A, T_B], scope: "x" });
    const asA = await ranked({ tenantSet: [T_A, T_B], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 1.25 });
    expect(byRef(asA, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score * 1.25, 4);
    expect(byRef(asA, "dept-b-seo")!.score).toBeCloseTo(byRef(base, "dept-b-seo")!.score, 6);
    const asB = await ranked({ tenantSet: [T_A, T_B], scope: "x", department: { tenantId: T_B, nodeId: SEO }, departmentBoost: 1.25 });
    expect(byRef(asB, "dept-b-seo")!.score).toBeCloseTo(byRef(base, "dept-b-seo")!.score * 1.25, 4);
    expect(byRef(asB, "dept-seo")!.score).toBeCloseTo(byRef(base, "dept-seo")!.score, 6);
  });

  it("the public tier is unaffected: a public chunk tagged with the department is not boosted", async () => {
    const base = await ranked({ tenantSet: [T_A], scope: "x" });
    const hits = await ranked({ tenantSet: [T_A], scope: "x", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 2 });
    expect(byRef(hits, "dept-public")!.audience).toBe("public");
    expect(byRef(hits, "dept-public")!.score).toBeCloseTo(byRef(base, "dept-public")!.score, 6);
    // an unresolved caller sees the same public chunk at the same score, department or not
    const anonBase = await ranked({ tenantSet: [], scope: "" });
    const anon = await ranked({ tenantSet: [], scope: "", department: { tenantId: T_A, nodeId: SEO }, departmentBoost: 2 });
    expect(anon).toEqual(anonBase);
    // publicOnly stays public-only
    const pub = await ranked({ tenantSet: [T_A], scope: "x", publicOnly: true, department: { tenantId: T_A, nodeId: SEO } });
    expect(pub.every((h) => h.audience === "public")).toBe(true);
  });

  it("no department, or an unusable one: results and order are exactly the same", async () => {
    const base = await ranked({ tenantSet: [T_A, T_B], scope: "x" });
    expect(base.length).toBeGreaterThan(3);
    expect(await ranked({ tenantSet: [T_A, T_B], scope: "x", department: undefined })).toEqual(base);
    expect(await ranked({ tenantSet: [T_A, T_B], scope: "x", department: { tenantId: "not-a-uuid", nodeId: SEO } })).toEqual(base);
    expect(await ranked({ tenantSet: [T_A, T_B], scope: "x", department: { tenantId: T_A, nodeId: "" } })).toEqual(base);
    // a factor with no department is inert
    expect(await ranked({ tenantSet: [T_A, T_B], scope: "x", departmentBoost: 2 })).toEqual(base);
  });

  it("listSources carries the department", async () => {
    const rows = await store.listSources([T_A]);
    expect(rows.find((r) => r.sourceRef === "dept-seo")?.departmentId).toBe(SEO);
    expect(rows.find((r) => r.sourceRef === "dept-general")?.departmentId).toBeNull();
  });
});
