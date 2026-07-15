// WS8 Step C — the model registry (spec §5 model platform, D13 model-trust locks).
//
// A model is not routable just because it exists. D13 makes two things gates:
//  1. WEIGHT PROVENANCE — a local weight blob must be an allow-listed format, carry a PINNED
//     SHA-256, and come from a TRUSTED MIRROR; the pinned digest must be VERIFIED against the actual
//     blob before use. (Code-signing/SBOM does not cover weight blobs — provenance must be explicit.)
//  2. EVAL-GATED ACTIVATION — a model becomes servable only after passing its eval suite (Step A);
//     LoRA / fine-tune candidates are entries that must clear the same bar as any other.
//
// This is the governance layer (in-memory + serializable, dependency-free, testable). Persisting it
// and having the Gateway consult it before routing to a local model is the runtime wire (documented
// in the WS8 plan Step C) — mirrors how Step A shipped the library ahead of the WS9 hookup.

/** Formats a weight blob can take. Cloud-hosted models have no local blob ("none"). */
export type WeightFormat = "safetensors" | "gguf" | "none";
/** Serving backends. Cloud = a provider the Gateway calls (no local weights). */
export type Backend = "ollama" | "vllm" | "gguf" | "lora" | "cloud";

export interface Provenance {
  weightFormat: WeightFormat;
  /** Pinned SHA-256 of the weight blob — REQUIRED for any local (non-cloud) weight. */
  sha256?: string;
  /** The trusted mirror the blob was fetched from — REQUIRED for any local weight. */
  sourceMirror?: string;
  /** For a LoRA / fine-tune: the registry id of the base model it derives from. */
  baseModelId?: string;
  note?: string;
}

/** An eval attestation (from the Step-A harness): which suite, which provider, did it pass. */
export interface EvalAttestation {
  suite: string;
  provider: string;
  passed: boolean;
  score?: number;
  ranAt?: string;
}

export type ModelStatus = "candidate" | "approved" | "rejected";

export interface ModelEntry {
  id: string;
  name: string;
  version: string;
  backend: Backend;
  provenance: Provenance;
  eval?: EvalAttestation;
  status: ModelStatus;
  /** True once the pinned digest has been checked against the actual blob (auto-true for cloud). */
  provenanceVerified: boolean;
}

export interface RegistryPolicy {
  /** Weight-blob format allow-list. D13 default is safetensors-only; widen deliberately (e.g. to
   *  admit GGUF for Ollama) with the SAME sha256 + trusted-mirror discipline. */
  allowedWeightFormats: WeightFormat[];
  /** Mirrors a local weight blob may originate from. */
  trustedMirrors: string[];
  /** Minimum eval score to approve for serving (if the attestation carries a score). */
  minEvalScore?: number;
}

export const DEFAULT_POLICY: RegistryPolicy = {
  allowedWeightFormats: ["safetensors"], // D13: safetensors-only by default
  trustedMirrors: ["huggingface.co", "hf-mirror.gaiada.internal"],
};

export class ProvenanceError extends Error {}
export class NotFoundError extends Error {}

/** A backend that runs a LOCAL weight blob (so weight provenance applies). */
export function isLocalWeightBackend(b: Backend): boolean {
  return b !== "cloud";
}

/**
 * D13 weight-provenance check at intake, as a PURE function so the in-memory and Postgres registries
 * enforce identical rules. `baseExists` answers whether a LoRA's baseModelId is registered. Throws
 * ProvenanceError on any violation; returns void when the entry may be admitted as a candidate.
 */
export function validateIntake(
  input: Pick<ModelEntry, "id" | "backend" | "provenance">,
  policy: RegistryPolicy,
  baseExists: (id: string) => boolean,
): void {
  if (!isLocalWeightBackend(input.backend)) return; // cloud: no blob provenance
  const p = input.provenance;
  if (p.weightFormat === "none") throw new ProvenanceError(`${input.id}: a local backend needs a weight blob (format is "none")`);
  if (!policy.allowedWeightFormats.includes(p.weightFormat))
    throw new ProvenanceError(`${input.id}: weight format "${p.weightFormat}" is not allow-listed (${policy.allowedWeightFormats.join(", ")})`);
  if (!p.sha256) throw new ProvenanceError(`${input.id}: a pinned sha256 is required for a local weight`);
  if (!p.sourceMirror || !policy.trustedMirrors.includes(p.sourceMirror))
    throw new ProvenanceError(`${input.id}: sourceMirror "${p.sourceMirror ?? ""}" is not a trusted mirror`);
  if (input.backend === "lora" && !p.baseModelId) throw new ProvenanceError(`${input.id}: a LoRA/fine-tune must name its baseModelId`);
  if (p.baseModelId && !baseExists(p.baseModelId)) throw new ProvenanceError(`${input.id}: baseModelId "${p.baseModelId}" is not registered`);
}

/** D13 double gate for serving: verified provenance AND a passing eval ≥ the policy score floor. */
export function assertApprovable(entry: Pick<ModelEntry, "id" | "provenanceVerified" | "eval">, policy: RegistryPolicy): void {
  if (!entry.provenanceVerified) throw new ProvenanceError(`${entry.id}: weight provenance not verified — cannot approve`);
  if (!entry.eval || !entry.eval.passed) throw new ProvenanceError(`${entry.id}: no passing eval attestation — cannot approve`);
  if (policy.minEvalScore !== undefined && (entry.eval.score ?? 0) < policy.minEvalScore)
    throw new ProvenanceError(`${entry.id}: eval score ${entry.eval.score ?? 0} below floor ${policy.minEvalScore}`);
}

export class ModelRegistry {
  private readonly entries = new Map<string, ModelEntry>();
  constructor(private readonly policy: RegistryPolicy = DEFAULT_POLICY) {}

  /**
   * Register a model as a `candidate`. Enforces D13 weight provenance at intake: a local-weight
   * entry MUST declare an allow-listed format, a pinned sha256, and a trusted mirror; a LoRA/fine-tune
   * must name its base. Cloud entries need no blob provenance. Throws ProvenanceError on violation.
   */
  register(input: Omit<ModelEntry, "status" | "provenanceVerified">): ModelEntry {
    validateIntake(input, this.policy, (id) => this.entries.has(id));
    const entry: ModelEntry = {
      ...input,
      status: "candidate",
      provenanceVerified: !isLocalWeightBackend(input.backend), // cloud needs no blob verification
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): ModelEntry {
    const e = this.entries.get(id);
    if (!e) throw new NotFoundError(`model not registered: ${id}`);
    return e;
  }

  list(): ModelEntry[] {
    return [...this.entries.values()];
  }

  /** Verify the actual weight-blob digest against the pinned sha256. Mismatch ⇒ ProvenanceError
   *  (the model is NOT trusted). On match, marks the entry provenance-verified. */
  verifyWeightDigest(id: string, actualSha256: string): ModelEntry {
    const e = this.get(id);
    if (!isLocalWeightBackend(e.backend)) return e; // nothing to verify for cloud
    if (!e.provenance.sha256 || actualSha256 !== e.provenance.sha256)
      throw new ProvenanceError(`${id}: weight digest mismatch — pinned ${e.provenance.sha256}, got ${actualSha256}`);
    e.provenanceVerified = true;
    return e;
  }

  /** Attach an eval attestation (from the Step-A harness) to a candidate. */
  attachEval(id: string, attestation: EvalAttestation): ModelEntry {
    const e = this.get(id);
    e.eval = attestation;
    return e;
  }

  /**
   * Approve a candidate for serving. D13 double gate: provenance must be verified (local weights) AND
   * the eval attestation must be present, passing, and (if scored) at/above the policy floor.
   * Refuses otherwise — a model is never routable on trust-me alone.
   */
  approveForServing(id: string): ModelEntry {
    const e = this.get(id);
    assertApprovable(e, this.policy);
    e.status = "approved";
    return e;
  }

  reject(id: string, _reason: string): ModelEntry {
    const e = this.get(id);
    e.status = "rejected";
    return e;
  }

  /** The Gateway's routing question: may this model serve traffic right now? */
  isRoutable(id: string): boolean {
    const e = this.entries.get(id);
    return !!e && e.status === "approved" && e.provenanceVerified;
  }
}
