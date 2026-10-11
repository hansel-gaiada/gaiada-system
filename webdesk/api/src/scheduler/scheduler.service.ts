// WSK-61 — the scheduler: four BullMQ job schedulers on one queue, one worker, in the api process
// (three from WSK-61, plus WSK-43a's media-purge).
//
// WHY BULLMQ JOB SCHEDULERS. Redis is already a hard dependency (tenant webhooks, mail), and a job
// scheduler makes BullMQ create ONE job per tick per scheduler id however many replicas run. Rejected:
// setInterval (runs once per replica), the compose `worker` stub (a second process to ship and harden
// for three small jobs), pg_cron (not in the image; application logic in the database).
//
//   id (= job name)         every                             runs
//   content-tick            WEBDESK_SCHEDULER_TICK_SECONDS    ContentTickService.runContentTick()
//   forms-retention-purge   WEBDESK_SCHEDULER_HOURLY_SECONDS  MaintenanceJobsService.runFormsPurge()
//   idempotency-sweep       WEBDESK_SCHEDULER_HOURLY_SECONDS  MaintenanceJobsService.runIdempotencySweep()
//   media-purge             WEBDESK_SCHEDULER_HOURLY_SECONDS  MediaPurgeService.runMediaPurge()  (WSK-43a)
//
// MULTI-REPLICA. upsertJobScheduler is idempotent (same id + same interval changes nothing), so every
// replica registers on boot without coordination. Every replica also runs a worker (concurrency 1), so
// whichever picks a tick job up runs it. Even if two ticks ever overlap (a slow tick, clock skew),
// ContentTickService claims each item with FOR UPDATE SKIP LOCKED, MediaPurgeService claims each asset the
// same way, and the two maintenance jobs are idempotent, so overlap is safe, merely wasted work.
//
// BOOT. Registration happens in the background and retries until Redis answers, so a Redis outage
// delays the schedule rather than blocking or failing the api's boot (the webhook and mail queues are
// built the same non-blocking way). `registered` resolves once all four are in; it never rejects.
//
// SHUTDOWN. The worker closes first (it finishes a running job, then stops taking more), then the queue,
// both awaited, and a registration still retrying is told to stop. No promise is left to reject later.
// Both objects get an 'error' listener: an EventEmitter 'error' with no listener throws. Nest destroys
// modules deepest-first and DbModule sits deeper than this one, so the pool would end under a running
// tick; the close is therefore also registered with DbService.onBeforeEnd, which runs it first.
//
// With WEBDESK_SCHEDULER_ENABLED=false nothing is created: no queue, no worker, no Redis connection.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { DbService } from "../db/db.service";
import { redisConnectionOptions } from "../queue/redis-connection";
import { closeBullmq } from "../queue/bullmq-shutdown";
import { ContentTickService } from "./content-tick.service";
import { MaintenanceJobsService } from "./maintenance-jobs.service";
import { MediaPurgeService } from "./media-purge.service";
import {
  JOB_CONTENT_TICK,
  JOB_FORMS_PURGE,
  JOB_IDEMPOTENCY_SWEEP,
  JOB_MEDIA_PURGE,
  resolveSchedulerSettings,
  type SchedulerSettings,
} from "./scheduler.config";

const MAX_REGISTER_BACKOFF_MS = 30_000;
const REGISTER_DRAIN_ON_CLOSE_MS = 5_000;

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;
  private closing = false;
  private wakeBackoff?: () => void;
  private stopped?: Promise<void>;

  /** The resolved settings (set by onModuleInit; undefined before). */
  settings?: SchedulerSettings;
  /** Resolves when the four job schedulers are registered (or the service is closing). Never rejects. */
  registered: Promise<void> = Promise.resolve();

  constructor(
    private readonly content: ContentTickService,
    private readonly jobs: MaintenanceJobsService,
    private readonly mediaPurge: MediaPurgeService,
    private readonly db: DbService,
  ) {}

  onModuleInit(): void {
    // Throws SchedulerConfigError on an out-of-range value: the app refuses to boot, loudly, whether or
    // not the scheduler is enabled (a typo should not wait for the day someone enables it).
    const settings = resolveSchedulerSettings();
    this.settings = settings;
    if (!settings.enabled) {
      this.logger.log("scheduler disabled (WEBDESK_SCHEDULER_ENABLED): no queue, no worker");
      return;
    }

    this.queue = new Queue(settings.queueName, { connection: redisConnectionOptions() as never });
    this.queue.on("error", (err) => this.logger.warn(`scheduler queue error: ${String(err)}`));
    this.worker = new Worker(settings.queueName, (job) => this.dispatch(job), {
      connection: redisConnectionOptions() as never,
      concurrency: 1,
    });
    this.worker.on("error", (err) => this.logger.warn(`scheduler worker error: ${String(err)}`));
    this.worker.on("failed", (job, err) => this.logger.error(`scheduler job ${job?.name ?? "?"} failed: ${String(err?.message ?? err)}`));
    this.registered = this.registerWithRetry(this.queue, settings);
    this.db.onBeforeEnd(() => this.stop());
  }

  private async registerWithRetry(queue: Queue, s: SchedulerSettings): Promise<void> {
    const schedule: [string, number][] = [
      [JOB_CONTENT_TICK, s.tickSeconds],
      [JOB_FORMS_PURGE, s.hourlySeconds],
      [JOB_IDEMPOTENCY_SWEEP, s.hourlySeconds],
      [JOB_MEDIA_PURGE, s.hourlySeconds],
    ];
    for (let attempt = 0; !this.closing; attempt++) {
      try {
        for (const [id, seconds] of schedule) {
          await queue.upsertJobScheduler(id, { every: seconds * 1000 }, { name: id, opts: { removeOnComplete: 20, removeOnFail: 100 } });
        }
        this.logger.log(`scheduler registered: ${schedule.map(([id, sec]) => `${id} every ${sec}s`).join(", ")} on queue ${s.queueName}`);
        return;
      } catch (err) {
        if (this.closing) return;
        const backoff = Math.min(MAX_REGISTER_BACKOFF_MS, 1000 * 2 ** attempt);
        this.logger.warn(`scheduler registration failed (retrying in ${backoff}ms): ${String(err)}`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoff);
          this.wakeBackoff = () => {
            clearTimeout(t);
            resolve();
          };
        });
        this.wakeBackoff = undefined;
      }
    }
  }

  /** What a worker does with a job: dispatch by name. A throw is recorded by BullMQ as a failed job. */
  private async dispatch(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOB_CONTENT_TICK: {
        const result = await this.content.runContentTick(await this.content.databaseNow());
        // Per-item failures are counted, not thrown, so one poison item cannot starve the rest; surface
        // them here so the job shows as failed and the next tick still runs.
        if (result.totals.errors > 0) throw new Error(`content tick finished with ${result.totals.errors} error(s); see the api log`);
        return result.totals;
      }
      case JOB_FORMS_PURGE:
        return this.jobs.runFormsPurge();
      case JOB_IDEMPOTENCY_SWEEP:
        return this.jobs.runIdempotencySweep();
      case JOB_MEDIA_PURGE:
        // Per-asset failures are counted and logged inside, never thrown: a storage outage must not fail the job loop.
        return this.mediaPurge.runMediaPurge();
      default:
        throw new Error(`unknown scheduler job: ${job.name}`);
    }
  }

  /** For tests and ops: the job schedulers currently registered on this queue. */
  async listJobSchedulers(): Promise<{ id: string; everyMs: number | null }[]> {
    if (!this.queue) return [];
    const list = await this.queue.getJobSchedulers();
    return list.map((j) => ({ id: j.key, everyMs: j.every ? Number(j.every) : null }));
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** Idempotent: the first caller (DbService's before-end task, or this module's own destroy) does the work. */
  private stop(): Promise<void> {
    this.stopped ??= this.doStop();
    return this.stopped;
  }

  private async doStop(): Promise<void> {
    this.closing = true;
    this.wakeBackoff?.();
    const worker = this.worker;
    const queue = this.queue;
    this.worker = undefined;
    this.queue = undefined;
    // Worker first: it stops taking jobs and waits for a running one. Then the queue. Both awaited.
    // closeBullmq waits (bounded) for a still-connecting client before closing it: bullmq's close() of an
    // initialising connection leaves an unhandled rejection behind (see ../queue/bullmq-shutdown.ts).
    if (worker) await closeBullmq(worker, (err) => this.logger.warn(`scheduler worker close failed: ${String(err)}`));
    if (queue) await closeBullmq(queue, (err) => this.logger.warn(`scheduler queue close failed: ${String(err)}`));
    // A registration that was mid-command has failed by now (its queue closed under it) and returned.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.registered,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REGISTER_DRAIN_ON_CLOSE_MS);
      }),
    ]);
    clearTimeout(timer);
  }
}
