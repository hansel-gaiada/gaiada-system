// M6-P4r-b -- the seams of the live contract-codegen rail. Plain types and tokens (no Nest decorators,
// no vocabulary import), so a spec can fake each seam without booting anything.

/** The only thing a job carries. The worker re-reads the tenant's composition itself. */
export interface ContractCodegenJobData {
  tenantSlug: string;
}

/** Who asked for the run; logged only, never part of the job (a job is per tenant, not per request). */
export type ContractCodegenSource = "tenant.provision" | "schema.apply" | "contract.regenerate";

export interface ContractCodegenRunResult {
  /**
   * `published`: a new contract version was written (latest.json last).
   * `unchanged`: the stored contract already matches the tenant's composition and the vocabulary version, so
   *   nothing was written. The generator would otherwise publish a PATCH bump for an identical composition
   *   (versioning.mts: "no structural change" is PATCH), so a repeated apply, a retry after a run that did
   *   finish, or a backfill of a current tenant would mint a pointless version, and a new snapshot in the
   *   ERP mirror, every time.
   * `tenant-not-found`: no ACTIVE tenant has this slug (archived or gone since the enqueue). Not a failure, not retried.
   */
  outcome: "published" | "unchanged" | "tenant-not-found";
  contractVersion?: string;
  contentHash?: string;
}

/**
 * Runs the compiled generator for ONE tenant and publishes to RustFS. The production implementation
 * (contract-codegen.runner.ts) imports dist/codegen/generator.mjs; a spec provides a fake.
 * Must be safe to call twice in a row for the same tenant (the second reports `unchanged` and writes nothing);
 * the WORKER, not the runner, guarantees two runs never interleave.
 */
export interface ContractCodegenRunner {
  run(tenantSlug: string): Promise<ContractCodegenRunResult>;
}
export const CONTRACT_CODEGEN_RUNNER = Symbol("CONTRACT_CODEGEN_RUNNER");

/** Holds the per-tenant mutual exclusion for the duration of one run. */
export interface ContractCodegenLockHandle {
  release(): Promise<void>;
}
export interface ContractCodegenLock {
  /** Resolves once this tenant's lock is held; rejects ContractCodegenLockBusyError after `waitMs`. */
  acquire(tenantSlug: string, waitMs: number): Promise<ContractCodegenLockHandle>;
}
export const CONTRACT_CODEGEN_LOCK = Symbol("CONTRACT_CODEGEN_LOCK");

export class ContractCodegenLockBusyError extends Error {
  constructor(tenantSlug: string, waitMs: number) {
    super(`another contract codegen run for tenant '${tenantSlug}' still holds the lock after ${waitMs} ms`);
    this.name = "ContractCodegenLockBusyError";
  }
}

export class ContractCodegenTimeoutError extends Error {
  constructor(tenantSlug: string, timeoutMs: number) {
    super(`contract codegen for tenant '${tenantSlug}' exceeded its ${timeoutMs} ms timeout`);
    this.name = "ContractCodegenTimeoutError";
  }
}

/** What a job's data must look like before the worker acts on it (it comes back out of Redis). */
const JOB_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function parseJobData(data: unknown): ContractCodegenJobData {
  const slug = (data as { tenantSlug?: unknown } | null | undefined)?.tenantSlug;
  if (typeof slug !== "string" || !JOB_SLUG_RE.test(slug)) {
    throw new Error("contract codegen job carries no valid tenantSlug");
  }
  return { tenantSlug: slug };
}
