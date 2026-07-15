// WS8 Step C — the DURABLE model registry. `ModelRegistry` (in-memory) is the fast/test default; this
// is its Postgres-backed counterpart so approvals + provenance + eval attestations survive restarts and
// can be shared (e.g. read by the Gateway's routing decision). It reuses the SAME pure D13 gates
// (`validateIntake`, `assertApprovable`) as the in-memory registry so the rules can't drift.
import { Pool } from "pg";
import {
  DEFAULT_POLICY, ProvenanceError, NotFoundError, isLocalWeightBackend, validateIntake, assertApprovable,
  type ModelEntry, type RegistryPolicy, type Provenance, type EvalAttestation, type Backend,
} from "./registry";

export class PgModelRegistry {
  private migrateUrl: string;
  constructor(
    private pool: Pool,
    private policy: RegistryPolicy = DEFAULT_POLICY,
    opts: { migrateUrl?: string } = {},
  ) {
    this.migrateUrl = opts.migrateUrl ?? "";
  }

  async init(): Promise<void> {
    const ddl = this.migrateUrl ? new Pool({ connectionString: this.migrateUrl }) : this.pool;
    try {
      await ddl.query(`
        CREATE TABLE IF NOT EXISTS model_registry (
          id text PRIMARY KEY,
          name text NOT NULL,
          version text NOT NULL,
          backend text NOT NULL,
          provenance jsonb NOT NULL,
          eval jsonb,
          status text NOT NULL DEFAULT 'candidate',
          provenance_verified boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    } finally {
      if (ddl !== this.pool) await ddl.end();
    }
  }

  private rowToEntry(r: {
    id: string; name: string; version: string; backend: string; provenance: Provenance;
    eval: EvalAttestation | null; status: string; provenance_verified: boolean;
  }): ModelEntry {
    return {
      id: r.id, name: r.name, version: r.version, backend: r.backend as Backend, provenance: r.provenance,
      eval: r.eval ?? undefined, status: r.status as ModelEntry["status"], provenanceVerified: r.provenance_verified,
    };
  }

  private async has(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`SELECT 1 FROM model_registry WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async register(input: Omit<ModelEntry, "status" | "provenanceVerified">): Promise<ModelEntry> {
    // Resolve base existence up-front (async) so the pure validator can stay synchronous.
    const baseId = input.provenance.baseModelId;
    const baseOk = baseId ? await this.has(baseId) : true;
    validateIntake(input, this.policy, () => baseOk);
    const provenanceVerified = !isLocalWeightBackend(input.backend);
    await this.pool.query(
      `INSERT INTO model_registry (id, name, version, backend, provenance, eval, status, provenance_verified)
       VALUES ($1,$2,$3,$4,$5,$6,'candidate',$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, version=$3, backend=$4, provenance=$5, status='candidate', provenance_verified=$7, updated_at=now()`,
      [input.id, input.name, input.version, input.backend, JSON.stringify(input.provenance), input.eval ? JSON.stringify(input.eval) : null, provenanceVerified],
    );
    return this.get(input.id);
  }

  async get(id: string): Promise<ModelEntry> {
    const { rows } = await this.pool.query(`SELECT * FROM model_registry WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundError(`model not registered: ${id}`);
    return this.rowToEntry(rows[0]);
  }

  async list(): Promise<ModelEntry[]> {
    const { rows } = await this.pool.query(`SELECT * FROM model_registry ORDER BY created_at`);
    return rows.map((r) => this.rowToEntry(r));
  }

  async verifyWeightDigest(id: string, actualSha256: string): Promise<ModelEntry> {
    const e = await this.get(id);
    if (!isLocalWeightBackend(e.backend)) return e;
    if (!e.provenance.sha256 || actualSha256 !== e.provenance.sha256)
      throw new ProvenanceError(`${id}: weight digest mismatch — pinned ${e.provenance.sha256}, got ${actualSha256}`);
    await this.pool.query(`UPDATE model_registry SET provenance_verified = true, updated_at = now() WHERE id = $1`, [id]);
    return this.get(id);
  }

  async attachEval(id: string, attestation: EvalAttestation): Promise<ModelEntry> {
    await this.get(id); // existence
    await this.pool.query(`UPDATE model_registry SET eval = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(attestation)]);
    return this.get(id);
  }

  async approveForServing(id: string): Promise<ModelEntry> {
    const e = await this.get(id);
    assertApprovable(e, this.policy);
    await this.pool.query(`UPDATE model_registry SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
    return this.get(id);
  }

  async reject(id: string, _reason: string): Promise<ModelEntry> {
    await this.get(id);
    await this.pool.query(`UPDATE model_registry SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
    return this.get(id);
  }

  /** The Gateway's routing question, now durable + shareable across processes. */
  async isRoutable(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ status: string; provenance_verified: boolean }>(
      `SELECT status, provenance_verified FROM model_registry WHERE id = $1`,
      [id],
    );
    return !!rows[0] && rows[0].status === "approved" && rows[0].provenance_verified;
  }
}
