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
// DEPARTMENT (AIP-11/AIP-12, docs/plans/2026-10-27-ai-plan.md 6.2 items 4-5): a chunk may carry the org node id
// of the department that owns its record. It is a RANKING signal only (section 3.3: "the department tag decides
// ranking, not access"): the D9.1 WHERE pre-filter below never mentions it, so it can neither admit a row nor hide one.
import { Pool } from "pg";

export type Provenance = "human" | "agent" | "external";
export type Trust = "trusted" | "untrusted";
/** D9.4 audience tier. `internal` (the DEFAULT, and the only value the old schema could express)
 *  keeps the full D9.1 contract: tenant pre-filter + ACL scope. `public` is company knowledge that
 *  is deliberately world-readable — the gaiada.com marketing corpus — and is therefore retrievable
 *  with NO resolved identity at all, so a lead/client on WhatsApp can be answered. Because `public`
 *  is the ONLY way to escape the tenant pre-filter, it must never be inferred: it is opt-in per
 *  ingest, the column defaults to `internal`, and only service-token'd internal pipelines can set it. */
export type Audience = "public" | "internal";

export interface IngestDoc {
  tenantId: string;
  sourceRef: string;
  acl: string[]; // scopes allowed to read (empty = whole tenant). Ignored when audience='public'.
  kind: "doc" | "memory";
  chunks: string[];
  provenance: Provenance;
  trust: Trust;
  confidence?: number; // 0..1
  audience?: Audience; // default 'internal' — fail-closed
  /** The org node id of the department that owns the record (same shape as `projects.department_id`, e.g. `d-seo`).
   *  Optional and fail-soft: anything but a trimmed non-empty string of at most MAX_DEPARTMENT_ID_CHARS becomes null.
   *  It is metadata for ranking only and is rewritten on every ingest, including for kept chunks. */
  departmentId?: string | null;
}

/** Longest department id stored. The ids are org node ids (`d-seo`); anything near this is already not one. */
export const MAX_DEPARTMENT_ID_CHARS = 100;

/** A department id as stored: a trimmed non-empty string of at most MAX_DEPARTMENT_ID_CHARS, else null. A wrong type or an
 *  over-long value is dropped, never truncated (a cut id would name some other department) and never an error. */
export function normaliseDepartmentId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_DEPARTMENT_ID_CHARS ? t : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ranking boost for the caller's own department (AIP-12). */
export const DEFAULT_DEPARTMENT_BOOST = 1.25;

/** KNOWLEDGE_DEPARTMENT_BOOST as a factor: missing, empty or NaN means the default, anything else is clamped to [1, 2]
 *  (below 1 would demote the department, above 2 would stop being a boost and become a partition). */
export function parseDepartmentBoost(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return DEFAULT_DEPARTMENT_BOOST;
  const n = Number(raw);
  if (Number.isNaN(n)) return DEFAULT_DEPARTMENT_BOOST;
  return Math.min(2, Math.max(1, n));
}

/** The department a search ranks first, or null when the input is not a usable one. `tenantId` must be a uuid (it is compared
 *  with `tenant_id`; node ids repeat across companies, so the node id alone means nothing) and `nodeId` a non-empty string of at
 *  most MAX_DEPARTMENT_ID_CHARS. Anything else is ignored, which means no boost and never an error. */
export function normaliseSearchDepartment(v: unknown): { tenantId: string; nodeId: string } | null {
  if (!v || typeof v !== "object") return null;
  const { tenantId, nodeId } = v as { tenantId?: unknown; nodeId?: unknown };
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) return null;
  const node = normaliseDepartmentId(nodeId);
  return node ? { tenantId: tenantId.toLowerCase(), nodeId: node } : null;
}

export interface SearchCtx {
  tenantSet: string[]; // the caller's authorized-tenant-set (from the platform principal); [] = unresolved
  scope: string; // e.g. group chat id / project scope
  topK?: number;
  /** Restrict retrieval to the public tier even for a resolved caller. Used by surfaces that must
   *  never leak internal knowledge regardless of who is asking (e.g. a public website widget). */
  publicOnly?: boolean;
  /** AIP-12: the department to rank first. A chunk that is `internal`, of THIS tenant and of THIS department has its score
   *  multiplied by `departmentBoost`. It never adds a row: the authorization pre-filter is evaluated without it, so a
   *  department of a company outside `tenantSet` (or the same node id in another company) is not a candidate at all. */
  department?: { tenantId: string; nodeId: string };
  /** Factor for the above; default DEFAULT_DEPARTMENT_BOOST, clamped to [1, 2]. */
  departmentBoost?: number;
}

export interface Hit {
  tenantId: string;
  sourceRef: string;
  kind: string;
  text: string;
  provenance: Provenance;
  confidence: number;
  score: number;
  audience: Audience;
  /** The org node id the chunk's record belongs to, or null (company-wide, or not yet backfilled). */
  departmentId: string | null;
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
        audience text NOT NULL DEFAULT 'internal',
        department_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      -- Deployed stores predate the audience tier; add it in place. The DEFAULT backfills every
      -- existing row to 'internal', so an upgrade can only ever narrow visibility, never widen it.
      ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'internal';
      -- AIP-11: the owning department's org node id. NULL for every existing row (company-wide until the next sweep
      -- stamps it: the reuse path in ingestDetailed rewrites it without re-embedding), so an upgrade changes nothing.
      ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS department_id text;
      CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON knowledge_chunks (tenant_id, kind);
      CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks (source_ref);
      CREATE INDEX IF NOT EXISTS idx_knowledge_public ON knowledge_chunks (audience) WHERE audience = 'public';
      CREATE INDEX IF NOT EXISTS idx_knowledge_tenant_dept ON knowledge_chunks (tenant_id, department_id) WHERE department_id IS NOT NULL;
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
    return (await this.ingestDetailed(doc)).written;
  }

  /** The same replace, reporting how many chunks were embedded and how many were kept as they were.
   *
   *  A chunk whose text is byte-identical to one already stored under this source keeps its row and
   *  its vector: nothing is embedded for it. Without this a scheduled re-ingest of an unchanged corpus
   *  re-embedded every chunk every sweep (the 2026-10-28 daily-cap exhaustion). The stored `text` IS
   *  the content identity, so no hash column is needed and nothing needs backfilling. Kept rows still
   *  get their metadata (tenant, acl, kind, trust, quarantine, audience, department) rewritten from `doc`, so the
   *  replace semantics are unchanged: only the embedding call is skipped. That rewrite is also how a column added
   *  after the fact is backfilled: the next sweep stamps `department_id` on every kept row with zero re-embedding.
   *
   *  Ordering is the safety property. New chunks are embedded BEFORE anything is deleted or changed,
   *  so an embedding failure (a gateway 429 above all) throws with the stored source untouched, and
   *  the transaction rolls back anyway. A per-source advisory lock serialises two ingests of the same
   *  source (the old DELETE did that implicitly). */
  async ingestDetailed(doc: IngestDoc): Promise<{ written: number; embedded: number; reused: number }> {
    const quarantined = doc.trust === "untrusted"; // D9.3: never auto-promoted
    const confidence = doc.confidence ?? (doc.provenance === "agent" ? 0.6 : 1);
    // D9.4: anything but an explicit 'public' is internal. A typo'd/absent audience must fail CLOSED.
    const audience: Audience = doc.audience === "public" ? "public" : "internal";
    const departmentId = normaliseDepartmentId(doc.departmentId); // an absent id CLEARS the column: a record that left its department says so
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [doc.sourceRef]);
      const existing = await client.query<{ id: string; text: string }>(
        `SELECT id, text FROM knowledge_chunks WHERE source_ref = $1 ORDER BY created_at, id`,
        [doc.sourceRef],
      );
      // text -> stored row ids; each stored row can satisfy at most one incoming chunk, so a source
      // that repeats a paragraph is matched as a multiset, not collapsed.
      const stored = new Map<string, string[]>();
      for (const r of existing.rows) {
        const ids = stored.get(r.text);
        if (ids) ids.push(r.id);
        else stored.set(r.text, [r.id]);
      }
      const keepIds: string[] = [];
      const fresh: string[] = [];
      for (const text of doc.chunks) {
        const id = stored.get(text)?.shift();
        if (id) keepIds.push(id);
        else fresh.push(text);
      }
      // Embed first: a throw here leaves every stored row exactly as it was.
      const vectors: number[][] = [];
      for (const text of fresh) vectors.push(await this.embed(text));

      await client.query(`DELETE FROM knowledge_chunks WHERE source_ref = $1 AND NOT (id = ANY($2::uuid[]))`, [doc.sourceRef, keepIds]);
      if (keepIds.length > 0) {
        await client.query(
          `UPDATE knowledge_chunks
              SET tenant_id = $2, acl = $3, kind = $4, provenance = $5, trust = $6, confidence = $7,
                  quarantined = $8, audience = $9, department_id = $10, source_hlc = now()
            WHERE id = ANY($1::uuid[])`,
          [keepIds, doc.tenantId, doc.acl, doc.kind, doc.provenance, doc.trust, confidence, quarantined, audience, departmentId],
        );
      }
      for (let i = 0; i < fresh.length; i++) {
        // pgvector wants a '[..]'::vector literal; the array backend takes the number[] directly.
        const embParam = this.pgvector ? vectorLiteral(vectors[i]) : vectors[i];
        const embPlaceholder = this.pgvector ? "$6::vector" : "$6";
        await client.query(
          `INSERT INTO knowledge_chunks (tenant_id, source_ref, acl, kind, text, embedding, provenance, trust, confidence, quarantined, audience, department_id)
           VALUES ($1, $2, $3, $4, $5, ${embPlaceholder}, $7, $8, $9, $10, $11, $12)`,
          [doc.tenantId, doc.sourceRef, doc.acl, doc.kind, fresh[i], embParam, doc.provenance, doc.trust, confidence, quarantined, audience, departmentId],
        );
      }
      await client.query("COMMIT");
      return { written: doc.chunks.length, embedded: fresh.length, reused: keepIds.length };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** D9.1: authorization pre-filter FIRST (SQL WHERE), ranking only over allowed candidates.
   *  Scoring is identical in both backends: cosine similarity × confidence × provenance factor
   *  (agent-written down-weighted, D9.3).
   *
   *  D9.4 two-tier visibility. The predicate is a disjunction of exactly two branches:
   *    public   — audience='public'; no tenant and no ACL condition, because this tier IS the
   *               published company corpus. An unresolved caller (tenantSet=[]) reaches only this.
   *    internal — UNCHANGED from D9.1: audience='internal' AND tenant_id ∈ authorized-set AND the
   *               ACL scope matches. An empty tenantSet makes `= ANY('{}')` false, so this branch
   *               self-disables for an unresolved caller — the old blanket early-return is no longer
   *               needed and would now wrongly suppress the public tier.
   *  Both branches stay inside the SQL WHERE, so a chunk the caller may not see is never a ranking
   *  candidate — pgvector still never widens the candidate set.
   *
   *  AIP-12 department boost. It happens AFTER the pre-filter and changes only the order: a chunk that is `internal`, of
   *  `ctx.department.tenantId` and of `ctx.department.nodeId` has its score multiplied by the boost. The pre-filter is
   *  untouched, so the boost can never admit a row; `score > 0` stays on the BASE score, so a boost cannot rescue a chunk
   *  with no similarity; and node ids repeat across companies, which is why the tenant is part of the match. With no usable
   *  department the multiplier is 1 and results and order are exactly what they were. */
  async search(query: string, ctx: SearchCtx): Promise<Hit[]> {
    const topK = ctx.topK ?? 5;
    const publicOnly = ctx.publicOnly === true;
    const q = await this.embed(query);
    const dept = normaliseSearchDepartment(ctx.department);
    const boost = dept ? parseDepartmentBoost(ctx.departmentBoost) : 1;

    if (this.pgvector) {
      // Ranking pushed into SQL over the pre-filtered set; HNSW index accelerates <=>.
      const { rows } = await this.pool.query<{
        tenant_id: string; source_ref: string; kind: string; text: string;
        provenance: Provenance; confidence: number; audience: Audience; department_id: string | null; ranked_score: string;
      }>(
        `SELECT tenant_id, source_ref, kind, text, provenance, confidence, audience, department_id,
                score * (CASE WHEN audience = 'internal' AND tenant_id = $6::uuid AND department_id = $7::text THEN $8::float8 ELSE 1 END) AS ranked_score
         FROM (
           SELECT tenant_id, source_ref, kind, text, provenance, confidence, audience, department_id,
                  (1 - (embedding <=> $3::vector)) * confidence
                    * (CASE WHEN provenance = 'agent' THEN 0.8 ELSE 1 END) AS score
           FROM knowledge_chunks
           WHERE NOT quarantined AND (
                   audience = 'public'
                   OR (NOT $5::boolean AND audience = 'internal'
                       AND tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)))
                 )
         ) ranked
         WHERE score > 0
         ORDER BY ranked_score DESC LIMIT $4`,
        [ctx.tenantSet, ctx.scope, vectorLiteral(q), topK, publicOnly, dept?.tenantId ?? null, dept?.nodeId ?? null, boost],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id, sourceRef: r.source_ref, kind: r.kind, text: r.text,
        provenance: r.provenance, confidence: r.confidence, audience: r.audience, departmentId: r.department_id,
        score: Number(r.ranked_score),
      }));
    }

    // Array fallback: pre-filter in SQL, cosine + rank in app.
    const { rows } = await this.pool.query<{
      tenant_id: string; source_ref: string; kind: string; text: string;
      embedding: number[]; provenance: Provenance; confidence: number; audience: Audience; department_id: string | null;
    }>(
      `SELECT tenant_id, source_ref, kind, text, embedding, provenance, confidence, audience, department_id
       FROM knowledge_chunks
       WHERE NOT quarantined AND (
               audience = 'public'
               OR (NOT $3::boolean AND audience = 'internal'
                   AND tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)))
             )`,
      [ctx.tenantSet, ctx.scope, publicOnly],
    );
    return rows
      .map((r) => {
        const base = cosine(q, r.embedding) * r.confidence * (r.provenance === "agent" ? 0.8 : 1);
        const boosted = dept && r.audience === "internal" && r.tenant_id === dept.tenantId && r.department_id === dept.nodeId;
        const hit: Hit = {
          tenantId: r.tenant_id, sourceRef: r.source_ref, kind: r.kind, text: r.text,
          provenance: r.provenance, confidence: r.confidence, audience: r.audience, departmentId: r.department_id,
          score: boosted ? base * boost : base,
        };
        return { hit, base };
      })
      .filter((x) => x.base > 0) // the existing score > 0 cut stays on the base score
      .map((x) => x.hit)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Distinct sources for a tenant set (admin console read). Aggregates chunks per
   *  source_ref with its latest provenance + a derived status. No chunk text leaves here. */
  async listSources(tenantSet: string[]): Promise<
    { sourceRef: string; kind: string; chunks: number; provenance: Provenance; audience: Audience; departmentId: string | null; status: string; updatedAt: string }[]
  > {
    if (tenantSet.length === 0) return [];
    const { rows } = await this.pool.query<{
      source_ref: string; kind: string; chunks: string; provenance: Provenance; audience: Audience; department_id: string | null; quarantined: boolean; updated_at: string;
    }>(
      `SELECT source_ref, min(kind) AS kind, count(*)::int AS chunks,
              (array_agg(provenance ORDER BY created_at DESC))[1] AS provenance,
              min(audience) AS audience, min(department_id) AS department_id,
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
      audience: r.audience,
      departmentId: r.department_id,
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
