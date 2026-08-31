// WSK-21 — "long-running commands job-tracked and queryable" (ticket AC): release.deploy/
// promote/rollback/triggerRebuild return a jobId immediately; this service is what that jobId
// resolves against.
//
// IN-MEMORY, SINGLE-PROCESS — same flagged limitation as idempotency-store.ts. A persisted
// `control_jobs` table is the natural next step and needs a migration this ticket does not own.
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CommandName, ImpactClass } from "../command-types";
import type { JobRecord } from "./job.types";

@Injectable()
export class JobsService {
  private readonly jobs = new Map<string, JobRecord>();

  create(input: { tenantSlug: string; command: CommandName; impactClass: ImpactClass }): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      tenantSlug: input.tenantSlug,
      command: input.command,
      impactClass: input.impactClass,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(tenantSlug: string, jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantSlug !== tenantSlug) {
      // Same "no existence oracle across a tenant boundary" doctrine WSK-07 documented for
      // media: do not let the response distinguish "wrong tenant" from "no such job".
      throw new NotFoundException("job not found for this tenant");
    }
    return job;
  }

  list(tenantSlug: string): JobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.tenantSlug === tenantSlug)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private transition(jobId: string, patch: Partial<Pick<JobRecord, "status" | "result" | "error">>): void {
    const job = this.jobs.get(jobId);
    if (!job) return; // vanished (only possible if a test cleared state mid-flight) — nothing to update
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  }

  /**
   * Drives a job from `queued` through `running` to a terminal state, running `executor` exactly
   * once. Never throws — a rejected executor lands the job in `failed` with the error captured,
   * never an unhandled rejection reaching the process.
   */
  async run(jobId: string, executor: () => Promise<unknown>): Promise<void> {
    this.transition(jobId, { status: "running" });
    try {
      const result = await executor();
      this.transition(jobId, { status: "succeeded", result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "EXECUTION_FAILED";
      this.transition(jobId, { status: "failed", error: { code, message } });
    }
  }

  /** Test escape hatch only. */
  clear(): void {
    this.jobs.clear();
  }
}
