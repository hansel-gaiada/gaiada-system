// SM-09 — keyword embeddings + dual-mode clustering + Hermes intent/label drafting (design §04/§07/
// §12 SM-09: "1k-keyword fixture clusters deterministically in both vector modes; intents
// persisted"). Mirrors ai-agents/src/knowledge/store.ts's dual-mode pattern (pgvector vs
// double-precision[] fallback, detected by reading pg_extension — the owner role can't CREATE the
// extension, only detect it) and 0034_module_search.sql's guarded ADD COLUMN block, which already
// created search_keywords.embedding in whichever mode the DB supports. No migration needed here —
// every column/table this file touches already exists (0034).
//
// ── Determinism (the AC's hard requirement) ─────────────────────────────────────────────────────
// clusterEmbeddings() is a PURE function of its input array: no randomness, no Date.now(), no
// Map/Set iteration over unordered keys feeding the algorithm. It is the CALLER's job to feed it a
// stably-ordered input (this file always reads `ORDER BY keyword ASC, id ASC`) — same order in, same
// partition out, every run, in both vector-storage modes (parseEmbeddingValue normalizes both
// representations to the identical number[] before clustering ever sees them, so the algorithm
// itself never knows or cares which mode produced its input).
import type { PoolClient } from "pg";
import { newId } from "../../db";
import { config } from "../../config";
import { completeViaGateway, type GatewayCallOptions, embedViaGateway } from "./providers/gateway-client";

// ── SM-32 gate defect fix: bound keyword-set cardinality ────────────────────────────────────────────
// Thrown by embedKeywordSet/clusterKeywordSet instead of running their sequential per-keyword (or
// per-cluster) gateway-call loop unbounded. Both functions run on a connection `withTenants` holds
// open in a real BEGIN…COMMIT for the whole loop (src/db/index.ts) — an uncapped set turns "how long
// is one pooled connection held" into "however long N sequential network round trips take", which is
// how a few concurrent large imports exhaust the pool. See config.search.maxKeywordsPerSet for the
// cap value + the deliberate decision to keep ONE transaction (vs. chunked commits) for now.
export class KeywordSetTooLargeError extends Error {
  constructor(
    public readonly limit: number,
    public readonly count: number,
  ) {
    super(
      `keyword set has ${count} keyword(s), exceeding the ${limit}-keyword cap (SEARCH_MAX_KEYWORDS_PER_SET) — ` +
        "refusing to embed/cluster unbounded rather than looping over an uncapped set",
    );
    this.name = "KeywordSetTooLargeError";
  }
}

// ── Dual-mode embedding storage (mirrors ai-agents/src/knowledge/store.ts) ──────────────────────────
export type EmbeddingMode = "pgvector" | "array";

/** Detect-only (0034 header: "the owner role cannot CREATE it, so we only DETECT it"). Safe to call
 *  on any tenant+module-scoped connection — pg_extension is a system catalog, not RLS-guarded. */
export async function detectEmbeddingMode(c: PoolClient): Promise<EmbeddingMode> {
  const r = await c.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  return (r.rowCount ?? 0) > 0 ? "pgvector" : "array";
}

/** pgvector text literal: '[1,2,3]' (same helper as the knowledge store). */
export function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Parse a raw `search_keywords.embedding` value back into number[], mode-agnostic. In pgvector mode
 *  node-pg has no built-in `vector` type parser, so the driver hands back the column's TEXT
 *  representation (`'[1,2,3]'`); in array mode (`double precision[]`) node-pg already parses it into
 *  a JS number[]. Normalizing both shapes to the same representation HERE is what makes clustering
 *  genuinely mode-agnostic downstream — see clustering.test.ts's "dual-mode parity" case, which feeds
 *  the identical fixture through both shapes and asserts clusterEmbeddings() returns the identical
 *  partition either way (the honest way to prove "both vector modes" when pgvector itself is not
 *  installed on this machine, design §12 OQ-8 — the fallback is the one that actually runs). */
export function parseEmbeddingValue(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") {
    const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
    if (trimmed === "") return [];
    return trimmed.split(",").map((s) => Number(s.trim()));
  }
  return [];
}

/** The bind value + SQL cast suffix for writing one embedding, mode-aware. pgvector wants a
 *  `'[..]'::vector` literal; the array backend takes the number[] straight as a query parameter
 *  (node-pg encodes a JS array as a Postgres array automatically for a `double precision[]` column). */
export function embeddingBindValue(mode: EmbeddingMode, embedding: number[]): { value: unknown; cast: string } {
  return mode === "pgvector" ? { value: vectorLiteral(embedding), cast: "::vector" } : { value: embedding, cast: "" };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 0;
  const out = new Array(dim).fill(0) as number[];
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i] ?? 0;
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

export interface EmbeddedKeyword {
  id: string;
  keyword: string;
  embedding: number[];
}

export interface Cluster {
  members: EmbeddedKeyword[];
  centroid: number[];
}

/** Deterministic single-pass greedy clustering (design §07: "cluster (cosine/HDBSCAN-style in the
 *  service)"; v1 locks the cosine/greedy variant — HDBSCAN-style density clustering is a noted v2
 *  refinement, out of scope for this ticket's AC). Each item joins the BEST-scoring existing cluster
 *  (by running centroid cosine similarity) if that score clears `threshold`; ties are broken by
 *  cluster CREATION ORDER (strict `>` comparison never displaces an earlier equal-scoring cluster),
 *  and cluster creation order is itself a pure function of the input order. So: same input order +
 *  same embeddings => byte-identical partition, every run, regardless of vector storage mode. */
export function clusterEmbeddings(items: EmbeddedKeyword[], threshold = 0.82): Cluster[] {
  const clusters: Cluster[] = [];
  for (const item of items) {
    let best: { cluster: Cluster; score: number } | null = null;
    for (const cluster of clusters) {
      const score = cosineSimilarity(item.embedding, cluster.centroid);
      if (score >= threshold && (!best || score > best.score)) best = { cluster, score };
    }
    if (best) {
      best.cluster.members.push(item);
      best.cluster.centroid = meanVector(best.cluster.members.map((m) => m.embedding));
    } else {
      clusters.push({ members: [item], centroid: item.embedding.slice() });
    }
  }
  return clusters;
}

// ── Hermes intent/label drafting (design §07: "Hermes names clusters + tags intent") ───────────────
export const INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;
export type Intent = (typeof INTENTS)[number];

function isIntent(v: unknown): v is Intent {
  return typeof v === "string" && (INTENTS as readonly string[]).includes(v);
}

export interface ClusterLabel {
  label: string;
  intent: Intent;
}

/** Build the labeling prompt for one cluster. Deliberately asks for STRICT JSON so parseClusterLabel
 *  has a reliable shape to parse — Hermes is prompted, never fine-tuned, so tolerance for
 *  surrounding prose still matters (see parseClusterLabel). */
export function buildClusterPrompt(keywords: string[]): string {
  return [
    "You are labeling one cluster of related search keywords for an SEO keyword-research tool.",
    `Keywords: ${keywords.join(", ")}`,
    'Reply with STRICT JSON only, no prose, no markdown fences: {"label": "<a short 2-4 word theme name>", "intent": "<one of informational|commercial|transactional|navigational>"}',
  ].join("\n");
}

/** Parse Hermes's /complete response for a cluster label + intent. Tolerates surrounding prose by
 *  extracting the first balanced-looking `{...}` substring; falls back to a deterministic default
 *  (the caller's supplied fallback label, intent 'informational') if parsing fails OR the intent
 *  isn't one of the four values `search_keywords.intent` CHECK-constrains (0034) — this function
 *  must NEVER throw and must NEVER return a value the DB would reject. */
export function parseClusterLabel(raw: string, fallbackLabel: string): ClusterLabel {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { label?: unknown; intent?: unknown };
      const label = typeof parsed.label === "string" && parsed.label.trim().length > 0 ? parsed.label.trim() : fallbackLabel;
      const intent = isIntent(parsed.intent) ? parsed.intent : "informational";
      return { label, intent };
    } catch {
      /* malformed JSON -> fall through to the deterministic default below */
    }
  }
  return { label: fallbackLabel, intent: "informational" };
}

// ── DB-facing orchestration (runs on an already tenant+module-scoped connection) ────────────────────
export interface EmbedResult {
  mode: EmbeddingMode;
  embedded: number;
}

/** Embed every keyword in a set that has no embedding yet (or ALL of them, if `onlyMissing: false` —
 *  used to re-embed after an edit). One `/embed` call per keyword (the gateway's contract takes a
 *  single `text`, design §01) — a set is now BOUNDED by config.search.maxKeywordsPerSet (SM-32),
 *  refused up front rather than silently truncated.
 *
 *  SM-32 transaction decision: this still runs inside the caller's single `withTenants` transaction
 *  (one BEGIN…COMMIT held for the whole sequential embed loop), a DELIBERATE choice over chunking
 *  into several committed batches, for two reasons: (1) `embedViaGateway` is a pure function of the
 *  keyword TEXT with no side effect beyond the UPDATE this function itself issues, so a retry after
 *  a mid-loop failure is safe either way — chunking would not have bought correctness, only smaller
 *  blast radius; (2) the cap is now small and fixed (1000, matching the only size this pipeline is
 *  proven deterministic at), so the worst case is "1000 sequential gateway calls on one held
 *  connection", not the previous unbounded case. If maxKeywordsPerSet is ever raised meaningfully
 *  above the proven AC size, revisit this and move to committing in bounded chunks — at which point
 *  a partial run leaves SOME keywords embedded and some not (a keyword with `embedding IS NOT NULL`
 *  is done; `onlyMissing: true`, the default, makes a retry naturally resume only the remainder). */
export async function embedKeywordSet(
  c: PoolClient,
  setId: string,
  opts: {
    onlyMissing?: boolean;
    embed?: typeof embedViaGateway;
    gatewayOpts?: GatewayCallOptions;
    /** Test-only override of config.search.maxKeywordsPerSet. */
    maxKeywords?: number;
  } = {},
): Promise<EmbedResult> {
  const mode = await detectEmbeddingMode(c);
  const clause = opts.onlyMissing === false ? "" : "AND embedding IS NULL";
  const maxKeywords = opts.maxKeywords ?? config.search.maxKeywordsPerSet;

  // SM-32: count first and refuse over-cap rather than silently truncating via LIMIT — a truncated
  // embed pass would look like success while quietly leaving keywords past the cap unembedded.
  const countRes = await c.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM search_keywords WHERE set_id = $1 AND deleted_at IS NULL ${clause}`,
    [setId],
  );
  const count = Number(countRes.rows[0]?.count ?? 0);
  if (count > maxKeywords) throw new KeywordSetTooLargeError(maxKeywords, count);

  const rows = await c.query<{ id: string; keyword: string }>(
    `SELECT id, keyword FROM search_keywords
      WHERE set_id = $1 AND deleted_at IS NULL ${clause}
      ORDER BY keyword ASC, id ASC LIMIT $2`,
    [setId, maxKeywords],
  );
  const embed = opts.embed ?? embedViaGateway;
  let embedded = 0;
  for (const row of rows.rows) {
    const vec = await embed(row.keyword, opts.gatewayOpts);
    const { value, cast } = embeddingBindValue(mode, vec);
    await c.query(`UPDATE search_keywords SET embedding = $2${cast}, updated_at = now() WHERE id = $1`, [row.id, value]);
    embedded++;
  }
  return { mode, embedded };
}

export interface ClusterSummary {
  clusterId: string;
  label: string;
  intent: Intent;
  size: number;
  keywordIds: string[];
}

export interface ClusterKeywordSetResult {
  mode: EmbeddingMode;
  clusters: ClusterSummary[];
  skipped: number; // keywords with no embedding yet — excluded from clustering, reported so the caller can /embed first
}

/** Cluster every embedded keyword in a set, then Hermes-label + intent-tag each resulting cluster,
 *  then persist (cluster_id/cluster_label/intent) on every member row. Runs entirely on the caller's
 *  already tenant+module-scoped connection — this file never opens its own tenant scope (the RLS
 *  choke-point stays a controller/call-site concern, exactly like providers/ledger.ts). */
export async function clusterKeywordSet(
  c: PoolClient,
  setId: string,
  opts: {
    threshold?: number;
    complete?: typeof completeViaGateway;
    gatewayOpts?: GatewayCallOptions;
    /** Test-only override of config.search.maxKeywordsPerSet. */
    maxKeywords?: number;
  } = {},
): Promise<ClusterKeywordSetResult> {
  const mode = await detectEmbeddingMode(c);
  const maxKeywords = opts.maxKeywords ?? config.search.maxKeywordsPerSet;

  // SM-32: same cap + same "refuse, don't truncate" rule as embedKeywordSet — clusterKeywordSet
  // fires one sequential awaited gateway call per CLUSTER (not per keyword) but the underlying read
  // is still uncapped in the original code, and cluster count scales with keyword count.
  const countRes = await c.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM search_keywords WHERE set_id = $1 AND deleted_at IS NULL`,
    [setId],
  );
  const count = Number(countRes.rows[0]?.count ?? 0);
  if (count > maxKeywords) throw new KeywordSetTooLargeError(maxKeywords, count);

  const rows = await c.query<{ id: string; keyword: string; embedding: unknown }>(
    `SELECT id, keyword, embedding FROM search_keywords
      WHERE set_id = $1 AND deleted_at IS NULL
      ORDER BY keyword ASC, id ASC LIMIT $2`,
    [setId, maxKeywords],
  );

  const items: EmbeddedKeyword[] = [];
  let skipped = 0;
  for (const r of rows.rows) {
    const embedding = parseEmbeddingValue(r.embedding);
    if (embedding.length === 0) {
      skipped++;
      continue;
    }
    items.push({ id: r.id, keyword: r.keyword, embedding });
  }

  const clusters = clusterEmbeddings(items, opts.threshold ?? 0.82);
  const complete = opts.complete ?? completeViaGateway;
  const summaries: ClusterSummary[] = [];

  for (const cluster of clusters) {
    // Sorted independently of clustering-internal member order so the fallback label (and the
    // prompt's keyword listing) is itself deterministic regardless of push order within the cluster.
    const sortedKeywords = [...cluster.members].map((m) => m.keyword).sort();
    const fallbackLabel = sortedKeywords[0];
    let label = fallbackLabel;
    let intent: Intent = "informational";
    try {
      const res = await complete(buildClusterPrompt(sortedKeywords.slice(0, 20)), opts.gatewayOpts);
      const parsed = parseClusterLabel(res.text, fallbackLabel);
      label = parsed.label;
      intent = parsed.intent;
    } catch {
      // Gateway unreachable/misconfigured: fail SOFT on the label/intent draft only. The clustering
      // partition itself is still real and gets persisted with the deterministic fallback label —
      // never silently drop the whole cluster because Hermes was unavailable.
    }
    const clusterId = newId();
    for (const member of cluster.members) {
      await c.query(
        `UPDATE search_keywords SET cluster_id = $2, cluster_label = $3, intent = $4, updated_at = now() WHERE id = $1`,
        [member.id, clusterId, label, intent],
      );
    }
    summaries.push({ clusterId, label, intent, size: cluster.members.length, keywordIds: cluster.members.map((m) => m.id) });
  }

  return { mode, clusters: summaries, skipped };
}
