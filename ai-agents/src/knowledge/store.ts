// Knowledge/memory store (WS8 §3-4, D9 LOCKED). WS8 is the SOLE owner of derived
// stores; everything else reaches this through the MCP `knowledge.search` wrapper.
//  D9.1 retrieval-time authorization: every chunk stamped tenant_id + acl + source_ref +
//       source_hlc; the caller's authorized-tenant-set + scope is a HARD SQL pre-filter
//       BEFORE similarity ranking — a cross-tenant chunk is never a candidate.
//  D9.2 source-driven lifecycle: re-ingesting a source REPLACES its chunks; erasure
//       HARD-DELETES them (this is how crypto-shred reaches derived stores).
//  D9.3 memory integrity: provenance + trust + confidence on every row; untrusted
//       content is quarantined (never retrieved, never auto-promoted); agent-written
//       facts are down-weighted at ranking time.
// VECTOR BACKEND (P5e): dual-mode. When the `vector` extension is present the embedding is
// a pgvector column and ranking is pushed into SQL (cosine distance, HNSW index) over the
// authorization-pre-filtered candidate set — the D9.1 filter stays in the WHERE clause, so
// pgvector never widens the candidate set. Where the extension is absent (plain Postgres /
// tests) it falls back to float8[] + app-side cosine with identical scoring semantics.
import { Pool } from "pg";

export type Provenance = "human" | "agent" | "external";
export type Trust = "trusted" | "untrusted";

export interface IngestDoc {
  tenantId: string;
  sourceRef: string;
  acl: string[]; // scopes allowed to read (empty = whole tenant)
  kind: "doc" | "memory";
  chunks: string[];
  provenance: Provenance;
  trust: Trust;
  confidence?: number; // 0..1
}

export interface SearchCtx {
  tenantSet: string[]; // the caller's authorized-tenant-set (from the platform principal)
  scope: string; // e.g. group chat id / project scope
  topK?: number;
}

export interface Hit {
  tenantId: string;
  sourceRef: string;
  kind: string;
  text: string;
  provenance: Provenance;
  confidence: number;
  score: number;
}

export type Embedder = (text: string) => Promise<number[]>;

export interface StoreOpts {
  /** Fixed embedding dimension for the pgvector column (ignored in array fallback mode). */
  dim?: number;
  /** Owner DSN for schema DDL (knowledge_owner). Empty -> DDL runs on the runtime pool (dev). */
  migrateUrl?: string;
}

/** pgvector text literal: '[1,2,3]'. */
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

export class KnowledgeStore {
  private pgvector = false;
  private dim: number;
  private migrateUrl: string;

  constructor(
    private pool: Pool,
    private embed: Embedder,
    opts: StoreOpts = {},
  ) {
    this.dim = opts.dim ?? 768;
    this.migrateUrl = opts.migrateUrl ?? "";
  }

  /** Which vector backend init() selected — 'pgvector' or 'array' (fallback). */
  mode(): "pgvector" | "array" {
    return this.pgvector ? "pgvector" : "array";
  }

  async init(): Promise<void> {
    // DDL runs as the OWNER (knowledge_owner) via migrateUrl; the runtime pool stays on the
    // restricted knowledge_app. Dev (no migrateUrl) falls back to the runtime pool.
    const ddlPool = this.migrateUrl ? new Pool({ connectionString: this.migrateUrl }) : this.pool;
    try {
      // Detect pgvector by READ (the extension is created at provisioning by a superuser — the
      // owner/app roles can't CREATE it). Runtime never needs DDL for this.
      const ext = await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      this.pgvector = (ext.rowCount ?? 0) > 0;
      const embType = this.pgvector ? `vector(${this.dim})` : "double precision[]";
      await ddlPool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        source_ref text NOT NULL,
        acl text[] NOT NULL DEFAULT '{}',
        source_hlc timestamptz NOT NULL DEFAULT now(),
        kind text NOT NULL DEFAULT 'doc',
        text text NOT NULL,
        embedding ${embType} NOT NULL,
        provenance text NOT NULL DEFAULT 'human',
        trust text NOT NULL DEFAULT 'trusted',
        confidence real NOT NULL DEFAULT 1,
        quarantined boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_chunks (tenant_id, kind);
      CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks (source_ref);
    `);
      if (this.pgvector) {
        // HNSW cosine index; ignore if the pgvector build is too old for HNSW (ivfflat would do).
        await ddlPool
          .query(`CREATE INDEX IF NOT EXISTS idx_knowledge_vec ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`)
          .catch(() => undefined);
      }
    } finally {
      if (ddlPool !== this.pool) await ddlPool.end();
    }
  }

  /** D9.2: ingest REPLACES the source's previous chunks (source-driven invalidation). */
  async ingest(doc: IngestDoc): Promise<number> {
    const quarantined = doc.trust === "untrusted"; // D9.3: never auto-promoted
    const confidence = doc.confidence ?? (doc.provenance === "agent" ? 0.6 : 1);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM knowledge_chunks WHERE source_ref = $1`, [doc.sourceRef]);
      for (const text of doc.chunks) {
        const embedding = await this.embed(text);
        // pgvector wants a '[..]'::vector literal; the array backend takes the number[] directly.
        const embParam = this.pgvector ? vectorLiteral(embedding) : embedding;
        const embPlaceholder = this.pgvector ? "$6::vector" : "$6";
        await client.query(
          `INSERT INTO knowledge_chunks (tenant_id, source_ref, acl, kind, text, embedding, provenance, trust, confidence, quarantined)
           VALUES ($1, $2, $3, $4, $5, ${embPlaceholder}, $7, $8, $9, $10)`,
          [doc.tenantId, doc.sourceRef, doc.acl, doc.kind, text, embParam, doc.provenance, doc.trust, confidence, quarantined],
        );
      }
      await client.query("COMMIT");
      return doc.chunks.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** D9.1: authorization pre-filter FIRST (SQL WHERE), ranking only over allowed candidates.
   *  Scoring is identical in both backends: cosine similarity × confidence × provenance factor
   *  (agent-written down-weighted, D9.3). */
  async search(query: string, ctx: SearchCtx): Promise<Hit[]> {
    if (ctx.tenantSet.length === 0) return []; // no authorized tenants → nothing, ever
    const topK = ctx.topK ?? 5;
    const q = await this.embed(query);

    if (this.pgvector) {
      // Ranking pushed into SQL over the pre-filtered set; HNSW index accelerates <=>.
      const { rows } = await this.pool.query<{
        tenant_id: string; source_ref: string; kind: string; text: string;
        provenance: Provenance; confidence: number; score: string;
      }>(
        `SELECT tenant_id, source_ref, kind, text, provenance, confidence, score FROM (
           SELECT tenant_id, source_ref, kind, text, provenance, confidence,
                  (1 - (embedding <=> $3::vector)) * confidence
                    * (CASE WHEN provenance = 'agent' THEN 0.8 ELSE 1 END) AS score
           FROM knowledge_chunks
           WHERE tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)) AND NOT quarantined
         ) ranked
         WHERE score > 0
         ORDER BY score DESC LIMIT $4`,
        [ctx.tenantSet, ctx.scope, vectorLiteral(q), topK],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id, sourceRef: r.source_ref, kind: r.kind, text: r.text,
        provenance: r.provenance, confidence: r.confidence, score: Number(r.score),
      }));
    }

    // Array fallback: pre-filter in SQL, cosine + rank in app.
    const { rows } = await this.pool.query<{
      tenant_id: string; source_ref: string; kind: string; text: string;
      embedding: number[]; provenance: Provenance; confidence: number;
    }>(
      `SELECT tenant_id, source_ref, kind, text, embedding, provenance, confidence
       FROM knowledge_chunks
       WHERE tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)) AND NOT quarantined`,
      [ctx.tenantSet, ctx.scope],
    );
    return rows
      .map((r) => ({
        tenantId: r.tenant_id, sourceRef: r.source_ref, kind: r.kind, text: r.text,
        provenance: r.provenance, confidence: r.confidence,
        score: cosine(q, r.embedding) * r.confidence * (r.provenance === "agent" ? 0.8 : 1),
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Distinct sources for a tenant set (admin console read). Aggregates chunks per
   *  source_ref with its latest provenance + a derived status. No chunk text leaves here. */
  async listSources(tenantSet: string[]): Promise<
    { sourceRef: string; kind: string; chunks: number; provenance: Provenance; status: string; updatedAt: string }[]
  > {
    if (tenantSet.length === 0) return [];
    const { rows } = await this.pool.query<{
      source_ref: string; kind: string; chunks: string; provenance: Provenance; quarantined: boolean; updated_at: string;
    }>(
      `SELECT source_ref, min(kind) AS kind, count(*)::int AS chunks,
              (array_agg(provenance ORDER BY created_at DESC))[1] AS provenance,
              bool_and(quarantined) AS quarantined, max(source_hlc) AS updated_at
       FROM knowledge_chunks
       WHERE tenant_id = ANY($1::uuid[])
       GROUP BY source_ref
       ORDER BY max(source_hlc) DESC`,
      [tenantSet],
    );
    return rows.map((r) => ({
      sourceRef: r.source_ref,
      kind: r.kind,
      chunks: Number(r.chunks),
      provenance: r.provenance,
      status: r.quarantined ? "quarantined" : "indexed",
      updatedAt: r.updated_at,
    }));
  }

  /** D9.2: erasure hard-deletes derived rows (crypto-shred reaches this store). */
  async eraseSource(sourceRef: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM knowledge_chunks WHERE source_ref = $1`, [sourceRef]);
    return r.rowCount ?? 0;
  }

  async eraseTenant(tenantId: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM knowledge_chunks WHERE tenant_id = $1`, [tenantId]);
    return r.rowCount ?? 0;
  }

  /** Quarantine review (D9.3): approve un-quarantines a source's chunks so retrieval can
   *  surface them; reject quarantines them (kept for provenance, never retrieved). Scoped to
   *  the tenant so a review can never touch another company's chunks. Returns rows affected. */
  async reviewSource(tenantId: string, sourceRef: string, decision: "approved" | "rejected"): Promise<number> {
    const r = await this.pool.query(
      `UPDATE knowledge_chunks SET quarantined = $3 WHERE tenant_id = $1 AND source_ref = $2`,
      [tenantId, sourceRef, decision === "rejected"],
    );
    return r.rowCount ?? 0;
  }
}
