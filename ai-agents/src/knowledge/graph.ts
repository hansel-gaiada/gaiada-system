// WS8 Step E — the knowledge graph / semantic layer (spec §4, §8.6, D9). The cross-business "one
// brain": typed entities + relations over the D9-governed store. It is a DERIVED store, so it inherits
// D9 exactly like the vector store (`store.ts`):
//   D9.1 retrieval-time authorization — every node/edge is stamped tenant_id + acl; traversal HARD
//        pre-filters candidates by the caller's authorized-tenant-set + scope BEFORE walking the graph
//        (authorizing the call is not enough). Cross-company "one-brain" nodes are READ-ONLY and
//        `group_executive`-gated: invisible unless the caller is explicitly cross-company-elevated, so
//        a lower-tenant / tool-authorizing agent never sees them.
//   D9.2 source-driven lifecycle — eraseSource / eraseTenant hard-delete (crypto-shred reach).
//   D9.3 provenance — every node/edge carries provenance (agent-derived relations are distinguishable
//        from human/source-of-truth ones by the consumer).
// Traversal is BOUNDED (depth + breadth caps) so a query can't fan out without limit.
import { Pool } from "pg";
import type { Provenance } from "./store";

export interface GraphNode {
  tenantId: string;
  entityKey: string; // stable business key, unique per tenant (e.g. "client:acme", "person:u-123")
  kind: string; // e.g. client | project | person | campaign
  label: string;
  acl?: string[]; // scopes allowed to read (empty = whole tenant)
  crossCompany?: boolean; // a cross-business "one brain" node (read-only, group_executive-gated)
  provenance?: Provenance;
  sourceRef?: string; // the source row/doc this node derives from (for lifecycle + erasure)
}

export interface GraphEdge {
  tenantId: string;
  srcKey: string;
  rel: string; // typed relation, e.g. "owns" | "assigned_to" | "part_of"
  dstKey: string;
  acl?: string[];
  provenance?: Provenance;
}

export interface GraphCtx {
  tenantSet: string[]; // caller's authorized-tenant-set (from the platform principal)
  scope: string; // acl scope (e.g. group chat / project id)
  /** Cross-company elevation (group_executive). Default false ⇒ cross-company nodes are invisible. */
  crossCompany?: boolean;
  maxDepth?: number; // default 2
  maxNodes?: number; // breadth/total cap, default 50
}

export interface GraphHit {
  entityKey: string;
  kind: string;
  label: string;
  tenantId: string;
  provenance: Provenance;
  depth: number;
  via: string | null; // the relation traversed to reach this node (null for the start node)
}

export class KnowledgeGraph {
  private migrateUrl: string;
  constructor(
    private pool: Pool,
    opts: { migrateUrl?: string } = {},
  ) {
    this.migrateUrl = opts.migrateUrl ?? "";
  }

  async init(): Promise<void> {
    const ddlPool = this.migrateUrl ? new Pool({ connectionString: this.migrateUrl }) : this.pool;
    try {
      await ddlPool.query(`
        CREATE TABLE IF NOT EXISTS graph_nodes (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          entity_key text NOT NULL,
          kind text NOT NULL,
          label text NOT NULL,
          acl text[] NOT NULL DEFAULT '{}',
          cross_company boolean NOT NULL DEFAULT false,
          provenance text NOT NULL DEFAULT 'human',
          source_ref text,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (tenant_id, entity_key)
        );
        CREATE TABLE IF NOT EXISTS graph_edges (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          src_key text NOT NULL,
          rel text NOT NULL,
          dst_key text NOT NULL,
          acl text[] NOT NULL DEFAULT '{}',
          provenance text NOT NULL DEFAULT 'human',
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (tenant_id, src_key, rel, dst_key)
        );
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_tenant ON graph_nodes (tenant_id, kind);
        CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges (tenant_id, src_key);
      `);
    } finally {
      if (ddlPool !== this.pool) await ddlPool.end();
    }
  }

  async upsertNode(n: GraphNode): Promise<void> {
    await this.pool.query(
      `INSERT INTO graph_nodes (tenant_id, entity_key, kind, label, acl, cross_company, provenance, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, entity_key) DO UPDATE SET
         kind = $3, label = $4, acl = $5, cross_company = $6, provenance = $7, source_ref = $8`,
      [n.tenantId, n.entityKey, n.kind, n.label, n.acl ?? [], n.crossCompany ?? false, n.provenance ?? "human", n.sourceRef ?? null],
    );
  }

  async addEdge(e: GraphEdge): Promise<void> {
    await this.pool.query(
      `INSERT INTO graph_edges (tenant_id, src_key, rel, dst_key, acl, provenance)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, src_key, rel, dst_key) DO UPDATE SET acl = $5, provenance = $6`,
      [e.tenantId, e.srcKey, e.rel, e.dstKey, e.acl ?? [], e.provenance ?? "human"],
    );
  }

  /** The SQL fragment + params that make a node row VISIBLE to ctx (D9.1). Applied to every read. */
  private nodeVisibility(ctx: GraphCtx): { sql: string; params: unknown[] } {
    // tenant in set AND (acl open OR scope granted) AND (not cross-company OR caller elevated)
    return {
      sql: `tenant_id = ANY($1::uuid[]) AND (acl = '{}' OR $2 = ANY(acl)) AND (cross_company = false OR $3 = true)`,
      params: [ctx.tenantSet, ctx.scope, ctx.crossCompany === true],
    };
  }

  /**
   * Bounded BFS from `startKey`, returning every node reachable within maxDepth — but ONLY over nodes
   * and edges the caller may see (D9.1 hard pre-filter at every hop). Returns [] if the start node
   * itself is not visible or there is no tenant context.
   */
  async neighbors(startKey: string, ctx: GraphCtx, opts?: { rel?: string }): Promise<GraphHit[]> {
    if (ctx.tenantSet.length === 0) return []; // no authorized tenants → nothing, ever
    const maxDepth = ctx.maxDepth ?? 2;
    const maxNodes = ctx.maxNodes ?? 50;
    const vis = this.nodeVisibility(ctx);

    // The start node must itself be visible.
    const start = await this.pool.query<{ entity_key: string; kind: string; label: string; tenant_id: string; provenance: Provenance }>(
      `SELECT entity_key, kind, label, tenant_id, provenance FROM graph_nodes WHERE entity_key = $4 AND ${vis.sql}`,
      [...vis.params, startKey],
    );
    if (start.rowCount === 0) return [];

    const seen = new Set<string>([startKey]);
    const hits: GraphHit[] = [
      { entityKey: startKey, kind: start.rows[0].kind, label: start.rows[0].label, tenantId: start.rows[0].tenant_id, provenance: start.rows[0].provenance, depth: 0, via: null },
    ];
    let frontier = [startKey];

    for (let depth = 1; depth <= maxDepth && frontier.length && hits.length < maxNodes; depth++) {
      // Visible edges out of the frontier, joined to visible destination nodes only (D9.1 on both).
      const relFilter = opts?.rel ? "AND e.rel = $5" : "";
      const { rows } = await this.pool.query<{ entity_key: string; kind: string; label: string; tenant_id: string; provenance: Provenance; via: string }>(
        `SELECT n.entity_key, n.kind, n.label, n.tenant_id, n.provenance, e.rel AS via
         FROM graph_edges e
         JOIN graph_nodes n ON n.tenant_id = e.tenant_id AND n.entity_key = e.dst_key
         WHERE e.tenant_id = ANY($1::uuid[]) AND (e.acl = '{}' OR $2 = ANY(e.acl))
           AND e.src_key = ANY($4::text[])
           AND (n.acl = '{}' OR $2 = ANY(n.acl)) AND (n.cross_company = false OR $3 = true)
           AND n.tenant_id = ANY($1::uuid[]) ${relFilter}`,
        opts?.rel ? [ctx.tenantSet, ctx.scope, ctx.crossCompany === true, frontier, opts.rel] : [ctx.tenantSet, ctx.scope, ctx.crossCompany === true, frontier],
      );
      const next: string[] = [];
      for (const r of rows) {
        if (seen.has(r.entity_key) || hits.length >= maxNodes) continue;
        seen.add(r.entity_key);
        hits.push({ entityKey: r.entity_key, kind: r.kind, label: r.label, tenantId: r.tenant_id, provenance: r.provenance, depth, via: r.via });
        next.push(r.entity_key);
      }
      frontier = next;
    }
    return hits;
  }

  async eraseSource(sourceRef: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM graph_nodes WHERE source_ref = $1`, [sourceRef]);
    return r.rowCount ?? 0;
  }

  async eraseTenant(tenantId: string): Promise<number> {
    await this.pool.query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [tenantId]);
    const r = await this.pool.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [tenantId]);
    return r.rowCount ?? 0;
  }
}
