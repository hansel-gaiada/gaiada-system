// M6-P4r-b -- the contract-codegen BullMQ queue: the ONLY place that adds a job.
//
// COALESCING. The job id is derived from the tenant, and BullMQ ignores an add whose id already
// exists, so a burst of applies for one tenant leaves ONE waiting job. Two refinements keep that
// from LOSING an update:
//   - a job that is already ACTIVE has read the composition before this change committed, so a change
//     that commits while a run is in flight must queue a follow-up. There are two slots per tenant
//     (`<id>` and `<id>--next`): an enqueue goes to whichever slot is not running, and is absorbed
//     when either slot is already waiting. A run that STARTS after the commit reads the new state, so
//     only a run that was active at the moment of the enqueue needs the follow-up.
//   - completed and failed jobs are removed (removeOnComplete / removeOnFail), because BullMQ would
//     otherwise keep the id occupied and silently swallow every later enqueue for that tenant. A
//     terminal failure is logged by the processor; the re-run path is the `contract.regenerate`
//     control command.
//
// With the feature disabled (config) no queue and no Redis connection exist and enqueue is a no-op.
// The queue is closed first when the pool ends (DbService.onBeforeEnd), like the scheduler's.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import { DbService } from "../db/db.service";
import { redisConnectionOptions } from "../queue/redis-connection";
import { closeBullmq } from "../queue/bullmq-shutdown";
import { resolveContractCodegenSettings, type ContractCodegenSettings } from "./contract-codegen.config";
import type { ContractCodegenJobData } from "./contract-codegen.types";

export const CONTRACT_CODEGEN_JOB_NAME = "run";

export type EnqueueOutcome = "added" | "coalesced" | "disabled";

/** What the queue needs from BullMQ; a spec fakes it with BullMQ's id-dedupe semantics. */
export interface CodegenJobSlots {
  getJobState(jobId: string): Promise<string>;
  add(name: string, data: ContractCodegenJobData, opts: JobsOptions): Promise<unknown>;
}

const WAITING_STATES = new Set(["waiting", "delayed", "prioritized", "waiting-children"]);

export function jobIdFor(tenantSlug: string): string {
  return `contract-codegen-${tenantSlug}`;
}

export function jobOptionsFor(settings: Pick<ContractCodegenSettings, "attempts" | "backoffMs">, jobId: string): JobsOptions {
  return {
    jobId,
    attempts: settings.attempts,
    backoff: { type: "exponential", delay: settings.backoffMs },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/** Pure coalescing logic over the two slots; exported so it can be exercised without Redis. */
export async function enqueueCoalesced(
  slots: CodegenJobSlots,
  settings: Pick<ContractCodegenSettings, "attempts" | "backoffMs">,
  tenantSlug: string,
  now: () => number = Date.now,
): Promise<Exclude<EnqueueOutcome, "disabled">> {
  const main = jobIdFor(tenantSlug);
  const next = `${main}--next`;
  const [mainState, nextState] = await Promise.all([slots.getJobState(main), slots.getJobState(next)]);

  // A run for this tenant that has not started yet will read the state this change committed.
  if (WAITING_STATES.has(mainState) || WAITING_STATES.has(nextState)) return "coalesced";

  let id = main;
  if (mainState === "active" && nextState !== "active") id = next;
  else if (mainState === "active" && nextState === "active") id = `${main}--late-${now()}`; // two replicas, both running
  await slots.add(CONTRACT_CODEGEN_JOB_NAME, { tenantSlug }, jobOptionsFor(settings, id));
  return "added";
}

@Injectable()
export class ContractCodegenQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractCodegenQueue.name);
  private queue?: Queue<ContractCodegenJobData>;
  private stopped?: Promise<void>;

  /** Resolved by onModuleInit (undefined before). */
  settings?: ContractCodegenSettings;

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    // Throws ContractCodegenConfigError on a malformed value: the app refuses to boot, enabled or not.
    this.settings = resolveContractCodegenSettings();
    if (!this.settings.enabled) {
      this.logger.log("contract codegen disabled (WEBDESK_CONTRACT_CODEGEN_ENABLED): no queue, no worker");
      return;
    }
    this.queue = new Queue<ContractCodegenJobData>(this.settings.queueName, { connection: redisConnectionOptions() as never });
    // An EventEmitter 'error' with no listener throws inside an unawaited handler.
    this.queue.on("error", (err) => this.logger.warn(`contract codegen queue error: ${String(err)}`));
    this.db.onBeforeEnd(() => this.stop());
  }

  /** Rejects when Redis cannot take the job; the caller (ContractCodegenTrigger) is the fail-soft layer. */
  async enqueue(tenantSlug: string): Promise<EnqueueOutcome> {
    const queue = this.queue;
    const settings = this.settings;
    if (!queue || !settings) return "disabled";
    return enqueueCoalesced(
      { getJobState: (id) => queue.getJobState(id), add: (name, data, opts) => queue.add(name as never, data as never, opts) },
      settings,
      tenantSlug,
    );
  }

  /** For tests and ops: how many codegen jobs are waiting / running / backing off. */
  async counts(): Promise<{ waiting: number; active: number; delayed: number }> {
    if (!this.queue) return { waiting: 0, active: 0, delayed: 0 };
    const c = await this.queue.getJobCounts("waiting", "active", "delayed");
    return { waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0 };
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  private stop(): Promise<void> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<void> {
    const queue = this.queue;
    this.queue = undefined;
    if (queue) await closeBullmq(queue, (err) => this.logger.warn(`contract codegen queue close failed: ${String(err)}`));
  }
}
