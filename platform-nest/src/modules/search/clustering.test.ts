// SM-09 — pure-function tests for the clustering core (no DB, no network). Covers: cosine math,
// deterministic partitioning (run-to-run + a 1k-item fixture), dual-mode parity (the honest way to
// prove "both vector modes" when pgvector itself isn't installed on this machine — design §12
// OQ-8/D-7), and the Hermes label/intent parser's tolerance + fallback behavior.
import { describe, it, expect } from "vitest";
import {
  clusterEmbeddings,
  cosineSimilarity,
  parseEmbeddingValue,
  vectorLiteral,
  embeddingBindValue,
  parseClusterLabel,
  buildClusterPrompt,
  INTENTS,
  type EmbeddedKeyword,
} from "./clustering";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });
  it("is 0 (not NaN) when either vector is all-zero", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("parseEmbeddingValue / vectorLiteral / embeddingBindValue — dual-mode shapes", () => {
  it("parses the array-mode shape (node-pg already hands back a JS number[])", () => {
    expect(parseEmbeddingValue([1, 2.5, -3])).toEqual([1, 2.5, -3]);
  });
  it("parses the pgvector-mode shape (node-pg hands back the column's TEXT literal)", () => {
    expect(parseEmbeddingValue("[1,2.5,-3]")).toEqual([1, 2.5, -3]);
  });
  it("round-trips vectorLiteral -> parseEmbeddingValue losslessly", () => {
    const v = [0.1, -0.25, 3, 0];
    expect(parseEmbeddingValue(vectorLiteral(v))).toEqual(v);
  });
  it("handles an empty vector literal and non-array/non-string input", () => {
    expect(parseEmbeddingValue("[]")).toEqual([]);
    expect(parseEmbeddingValue(null)).toEqual([]);
    expect(parseEmbeddingValue(undefined)).toEqual([]);
  });
  it("embeddingBindValue casts pgvector writes with ::vector and leaves array writes uncast", () => {
    const v = [1, 2, 3];
    expect(embeddingBindValue("pgvector", v)).toEqual({ value: "[1,2,3]", cast: "::vector" });
    expect(embeddingBindValue("array", v)).toEqual({ value: v, cast: "" });
  });
});

// ── Deterministic partitioning ────────────────────────────────────────────────────────────────────
function kw(id: string, keyword: string, embedding: number[]): EmbeddedKeyword {
  return { id, keyword, embedding };
}

describe("clusterEmbeddings — determinism", () => {
  it("groups near-identical vectors together and keeps a distant vector separate", () => {
    const items = [
      kw("a", "running shoes", [1, 0, 0]),
      kw("b", "best running shoes", [0.98, 0.05, 0]),
      kw("c", "cheap running shoes", [0.97, 0.06, 0.01]),
      kw("d", "how to bake bread", [0, 0, 1]),
    ];
    const clusters = clusterEmbeddings(items, 0.9);
    expect(clusters).toHaveLength(2);
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([1, 3]);
  });

  it("running the SAME input twice yields byte-identical partitions (the AC's literal requirement)", () => {
    const items: EmbeddedKeyword[] = Array.from({ length: 200 }, (_, i) => {
      const topic = i % 10;
      const dim = 12;
      const base = Array.from({ length: dim }, (_, d) => Math.sin(topic * 7 + d * 3 + 1));
      const wobble = Array.from({ length: dim }, (_, d) => Math.cos((i % 50) * 0.013 + d) * 0.01);
      return kw(`k${i}`, `topic${topic}-kw${i}`, base.map((b, d) => b + wobble[d]));
    });
    const run1 = clusterEmbeddings(items, 0.82);
    const run2 = clusterEmbeddings(items, 0.82);
    const canon = (clusters: ReturnType<typeof clusterEmbeddings>) =>
      clusters
        .map((c) => c.members.map((m) => m.id).sort())
        .sort((a, b) => a[0].localeCompare(b[0]));
    expect(canon(run1)).toEqual(canon(run2));
    expect(run1.length).toBeGreaterThan(1); // sanity: it actually partitioned, not one giant blob
  });

  // ── The AC's literal "1k-keyword fixture" scale, at the pure-function level ─────────────────────
  it("clusters a 1k-keyword synthetic fixture deterministically (20 well-separated topics)", () => {
    const TOPICS = 20;
    const PER_TOPIC = 50; // 20 x 50 = 1000
    const dim = TOPICS + 4; // one dominant axis per topic -> near-orthogonal bases, deterministically
    const items: EmbeddedKeyword[] = [];
    for (let t = 0; t < TOPICS; t++) {
      const base = Array.from({ length: dim }, (_, d) => (d === t ? 5 : Math.sin(d + t) * 0.01));
      for (let i = 0; i < PER_TOPIC; i++) {
        const wobble = Array.from({ length: dim }, (_, d) => Math.cos(i * 0.017 + d * 0.7) * 0.02);
        items.push(kw(`t${t}-i${i}`, `topic${t}-kw${i}`, base.map((b, d) => b + wobble[d])));
      }
    }
    expect(items).toHaveLength(1000);

    const runA = clusterEmbeddings(items, 0.85);
    const runB = clusterEmbeddings(items, 0.85);
    const canon = (clusters: ReturnType<typeof clusterEmbeddings>) =>
      clusters.map((c) => c.members.map((m) => m.id).sort()).sort((a, b) => a[0].localeCompare(b[0]));
    expect(canon(runA)).toEqual(canon(runB)); // determinism at the literal 1k scale
    expect(runA).toHaveLength(TOPICS); // well-separated synthetic topics recover cleanly
    for (const c of runA) expect(c.members).toHaveLength(PER_TOPIC);
  });

  // ── Dual-mode parity: feed the SAME fixture through the array shape and the pgvector text-literal
  // round trip; clusterEmbeddings must not be able to tell the difference (design §12 OQ-8's honest
  // proof — pgvector itself isn't installed on this machine, so this is what "both vector modes
  // tested" means here: the read-side normalization is proven mode-invariant). ──────────────────────
  it("produces an identical partition whether embeddings arrive as array-mode or pgvector-mode values", () => {
    const items: EmbeddedKeyword[] = Array.from({ length: 90 }, (_, i) => {
      const topic = i % 6;
      const dim = 10;
      const base = Array.from({ length: dim }, (_, d) => Math.sin(topic * 13 + d * 2 + 1));
      const wobble = Array.from({ length: dim }, (_, d) => Math.cos(i * 0.02 + d) * 0.015);
      return kw(`k${i}`, `t${topic}-${i}`, base.map((b, d) => b + wobble[d]));
    });

    // Simulate the pgvector-mode read path: write with vectorLiteral, read back with parseEmbeddingValue.
    const pgvectorModeItems: EmbeddedKeyword[] = items.map((it) => ({
      ...it,
      embedding: parseEmbeddingValue(vectorLiteral(it.embedding)),
    }));

    const arrayResult = clusterEmbeddings(items, 0.85);
    const pgvectorResult = clusterEmbeddings(pgvectorModeItems, 0.85);
    const canon = (clusters: ReturnType<typeof clusterEmbeddings>) =>
      clusters.map((c) => c.members.map((m) => m.id).sort()).sort((a, b) => a[0].localeCompare(b[0]));
    expect(canon(arrayResult)).toEqual(canon(pgvectorResult));
  });
});

describe("parseClusterLabel — Hermes response parsing", () => {
  it("parses strict JSON", () => {
    expect(parseClusterLabel('{"label": "Running Shoes", "intent": "commercial"}', "fallback")).toEqual({
      label: "Running Shoes",
      intent: "commercial",
    });
  });
  it("tolerates surrounding prose / markdown fences", () => {
    const raw = 'Sure, here you go:\n```json\n{"label": "Bread Baking", "intent": "informational"}\n```\nHope that helps!';
    expect(parseClusterLabel(raw, "fallback")).toEqual({ label: "Bread Baking", intent: "informational" });
  });
  it("falls back to the deterministic default on malformed JSON", () => {
    expect(parseClusterLabel("not json at all", "fallback-label")).toEqual({ label: "fallback-label", intent: "informational" });
    expect(parseClusterLabel("{ this is not : valid", "fallback-label")).toEqual({ label: "fallback-label", intent: "informational" });
  });
  it("falls back to 'informational' when the model returns an intent outside the CHECK-constrained set", () => {
    expect(parseClusterLabel('{"label": "X", "intent": "made_up_value"}', "fallback")).toEqual({ label: "X", intent: "informational" });
  });
  it("falls back to the caller's label when the model omits it or sends an empty string", () => {
    expect(parseClusterLabel('{"intent": "navigational"}', "fallback")).toEqual({ label: "fallback", intent: "navigational" });
    expect(parseClusterLabel('{"label": "  ", "intent": "navigational"}', "fallback")).toEqual({ label: "fallback", intent: "navigational" });
  });
  it("every persisted intent is one of the four search_keywords.intent CHECK values (0034)", () => {
    expect(INTENTS).toEqual(["informational", "commercial", "transactional", "navigational"]);
  });
});

describe("buildClusterPrompt", () => {
  it("includes every keyword and asks for strict JSON", () => {
    const prompt = buildClusterPrompt(["a", "b", "c"]);
    expect(prompt).toContain("a, b, c");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).toContain("informational|commercial|transactional|navigational");
  });
});
