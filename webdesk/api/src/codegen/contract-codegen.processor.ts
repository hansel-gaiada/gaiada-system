// M6-P4r-b -- the contract-codegen worker, in the api process (the scheduler's and the webhook worker's
// precedent): concurrency 1, so the 1 CPU / 768 MiB api container never runs two generations at once.
//
// ONE JOB, ONE TENANT:
//   1. take the tenant's advisory lock (waits up to TENANT_LOCK_WAIT_MS for another run to finish);
//   2. run the generator under a timeout;
//   3. release the lock WHEN THE RUN SETTLES, not when the timeout fires. A run that overran its timeout
//      is still writing to RustFS; releasing the lock early would let the retry interleave with it.
// A throw fails the attempt (BullMQ retries with exponential backoff; the last failure is logged with the
// way to re-run). `tenant-not-found` (archived since the enqueue) is a success: there is nothing to do.
//
// SHUTDOWN. The worker closes first (it finishes a running job, then stops taking more). Nest destroys
// modules deepest-first and DbModule sits deeper than this one, so the close is also registered with
// DbService.onBeforeEnd, which runs it before the pool ends (the scheduler's trap, see its header).
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { DbService } from "../db/db.service";
import { redisConnectionOptions } from "../queue/redis-connection";
import { closeBullmq } from "../queue/bullmq-shutdown";
import { resolveContractCodegenSettings, TENANT_LOCK_WAIT_MS } from "./contract-codegen.config";
import {
  CONTRACT_CODEGEN_LOCK,
  CONTRACT_CODEGEN_RUNNER,
  ContractCodegenTimeoutError,
  parseJobData,
  type ContractCodegenLock,
  type ContractCodegenRunResult,
  type ContractCodegenRunner,
} from "./contract-codegen.types";

@Injectable()
export class ContractCodegenProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractCodegenProcessor.name);
  private worker?: Worker;
  private stopped?: Promise<void>;
  private timeoutMs = 120_000;
  private lockWaitMs = TENANT_LOCK_WAIT_MS;

  constructor(
    @Inject(CONTRACT_CODEGEN_RUNNER) private readonly runner: ContractCodegenRunner,
    @Inject(CONTRACT_CODEGEN_LOCK) private readonly lock: ContractCodegenLock,
    private readonly db: DbService,
  ) {}

  onModuleInit(): void {
    const settings = resolveContractCodegenSettings();
    this.timeoutMs = settings.jobTimeoutMs;
    if (!settings.enabled) return; // ContractCodegenQueue logs the "disabled" line once.

    this.worker = new Worker(settings.queueName, (job) => this.process(job), {
      connection: redisConnectionOptions() as never,
      concurrency: 1,
      // The default 30 s lock is renewed by a timer; a long synchronous stretch of generation on a shared
      // 2 vCPU box could starve it and get the job treated as stalled. Hold it for a whole attempt.
      lockDuration: settings.jobTimeoutMs,
    });
    this.worker.on("error", (err) => this.logger.warn(`contract codegen worker error: ${String(err)}`));
    this.worker.on("failed", (job, err) => {
      const slug = (job?.data as { tenantSlug?: string } | undefined)?.tenantSlug ?? "?";
      const final = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true;
      if (final) {
        this.logger.error(
          `contract codegen for tenant '${slug}' FAILED after ${job?.attemptsMade ?? "?"} attempt(s): ${String(err?.message ?? err)}. ` +
            `No new contract was published; re-run it with the contract.regenerate control command.`,
        );
      } else {
        this.logger.warn(`contract codegen for tenant '${slug}' failed (attempt ${job?.attemptsMade}), will retry: ${String(err?.message ?? err)}`);
      }
    });
    this.db.onBeforeEnd(() => this.stop());
  }

  /** What the worker does with a job. Exposed (not private) so it is exercised without Redis. */
  async process(job: Pick<Job, "data">): Promise<ContractCodegenRunResult> {
    const { tenantSlug } = parseJobData(job.data);
    const handle = await this.lock.acquire(tenantSlug, this.lockWaitMs);

    // `.then` also turns a synchronous throw from the runner into a rejection, so the lock below is always released.
    const run: Promise<ContractCodegenRunResult> = Promise.resolve().then(() => this.runner.run(tenantSlug));
    // The lock is released when the run ACTUALLY ends, win or lose, even if the timeout answered first.
    const release = () => handle.release().catch(() => undefined);
    void run.then(release, release);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ContractCodegenTimeoutError(tenantSlug, this.timeoutMs)), this.timeoutMs);
    });
    try {
      const result = await Promise.race([run, timeout]);
      if (result.outcome === "published") {
        this.logger.log(`contract codegen published tenant '${tenantSlug}' at ${result.contractVersion} (${String(result.contentHash).slice(0, 12)})`);
      } else if (result.outcome === "unchanged") {
        this.logger.log(`contract codegen: tenant '${tenantSlug}' is already current at ${result.contractVersion}; nothing published`);
      } else {
        this.logger.warn(`contract codegen skipped tenant '${tenantSlug}': no active tenant with that slug`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Test hook: the timeout `process` applies (set from config at boot). */
  setLimitsForTest(limits: { timeoutMs?: number; lockWaitMs?: number }): void {
    if (limits.timeoutMs !== undefined) this.timeoutMs = limits.timeoutMs;
    if (limits.lockWaitMs !== undefined) this.lockWaitMs = limits.lockWaitMs;
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private stop(): Promise<void> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await closeBullmq(worker, (err) => this.logger.warn(`contract codegen worker close failed: ${String(err)}`));
  }
}
