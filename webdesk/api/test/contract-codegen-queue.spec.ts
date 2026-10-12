// M6-P4r-b -- the contract-codegen queue's pure parts, with NO services: the config contract, the
// coalescing logic over BullMQ's job-id semantics, and the fail-soft trigger. The Redis-backed behaviour
// (a real BullMQ queue) is in contract-codegen-live.spec.ts.
import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPTS,
  BACKOFF_SECONDS,
  ContractCodegenConfigError,
  ENQUEUE_TIMEOUT_MS,
  TIMEOUT_SECONDS,
  resolveContractCodegenSettings,
} from "../src/codegen/contract-codegen.config";
import { enqueueCoalesced, jobIdFor, jobOptionsFor, type CodegenJobSlots } from "../src/codegen/contract-codegen.queue";
import { ContractCodegenTrigger } from "../src/codegen/contract-codegen.trigger";
import type { ContractCodegenQueue } from "../src/codegen/contract-codegen.queue";

const env = (over: Record<string, string | undefined>) => ({ NODE_ENV: "production", ...over }) as NodeJS.ProcessEnv;

describe("contract-codegen config", () => {
  it("defaults: enabled in production and dev, OFF under NODE_ENV=test; 120 s timeout, 3 attempts, 10 s backoff", () => {
    expect(resolveContractCodegenSettings(env({}))).toEqual({
      enabled: true,
      queueName: "contract-codegen",
      jobTimeoutMs: 120_000,
      attempts: 3,
      backoffMs: 10_000,
    });
    expect(resolveContractCodegenSettings(env({ NODE_ENV: "development" })).enabled).toBe(true);
    expect(resolveContractCodegenSettings(env({ NODE_ENV: "test" })).enabled).toBe(false);
    expect(resolveContractCodegenSettings(env({ NODE_ENV: "test", WEBDESK_CONTRACT_CODEGEN_ENABLED: "true" })).enabled).toBe(true);
    expect(TIMEOUT_SECONDS.default).toBe(120);
    expect(ATTEMPTS.default).toBe(3);
    expect(BACKOFF_SECONDS.default).toBe(10);
  });

  it("an EMPTY variable means the default, never 0 (compose passes the variable through as an empty string)", () => {
    const s = resolveContractCodegenSettings(
      env({
        WEBDESK_CONTRACT_CODEGEN_ENABLED: "",
        WEBDESK_CONTRACT_CODEGEN_QUEUE_NAME: "  ",
        WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS: "",
        WEBDESK_CONTRACT_CODEGEN_ATTEMPTS: " ",
        WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS: "",
      }),
    );
    expect(s).toEqual({ enabled: true, queueName: "contract-codegen", jobTimeoutMs: 120_000, attempts: 3, backoffMs: 10_000 });
  });

  it("values inside their range are taken, boundaries included", () => {
    expect(
      resolveContractCodegenSettings(
        env({ WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS: "10", WEBDESK_CONTRACT_CODEGEN_ATTEMPTS: "10", WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS: "600" }),
      ),
    ).toMatchObject({ jobTimeoutMs: 10_000, attempts: 10, backoffMs: 600_000 });
  });

  it.each([
    ["WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS", "9"],
    ["WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS", "901"],
    ["WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS", "0"],
    ["WEBDESK_CONTRACT_CODEGEN_TIMEOUT_SECONDS", "1e2"],
    ["WEBDESK_CONTRACT_CODEGEN_ATTEMPTS", "0"],
    ["WEBDESK_CONTRACT_CODEGEN_ATTEMPTS", "11"],
    ["WEBDESK_CONTRACT_CODEGEN_ATTEMPTS", "-1"],
    ["WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS", "601"],
    ["WEBDESK_CONTRACT_CODEGEN_ENABLED", "maybe"],
  ])("%s=%s is refused loudly, naming the variable", (name, value) => {
    let err: unknown;
    try {
      resolveContractCodegenSettings(env({ [name]: value }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContractCodegenConfigError);
    expect((err as Error).message).toContain(name);
  });
});

/** BullMQ's observable behaviour for the two calls enqueueCoalesced makes: an add with an id that exists is ignored. */
class FakeSlots implements CodegenJobSlots {
  readonly jobs = new Map<string, { state: string; data: unknown; opts: Record<string, unknown> }>();
  readonly addCalls: { id: string }[] = [];
  async getJobState(id: string) {
    return this.jobs.get(id)?.state ?? "unknown";
  }
  async add(_name: string, data: { tenantSlug: string }, opts: Record<string, unknown>) {
    const id = opts.jobId as string;
    this.addCalls.push({ id });
    if (!this.jobs.has(id)) this.jobs.set(id, { state: "waiting", data, opts });
    return {};
  }
  /** The worker picking the job up, and later finishing it (removeOnComplete). */
  start(id: string) {
    this.jobs.get(id)!.state = "active";
  }
  finish(id: string) {
    this.jobs.delete(id);
  }
  waitingFor(slug: string) {
    return [...this.jobs.entries()].filter(([id, j]) => id.startsWith(jobIdFor(slug)) && j.state === "waiting").length;
  }
}
const SETTINGS = { attempts: 3, backoffMs: 10_000 };

describe("contract-codegen queue: coalescing", () => {
  it("a burst of enqueues for one tenant leaves exactly ONE waiting job, with the job id derived from the tenant", async () => {
    const q = new FakeSlots();
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await enqueueCoalesced(q, SETTINGS, "acme"));
    expect(outcomes).toEqual(["added", "coalesced", "coalesced", "coalesced", "coalesced"]);
    expect(q.waitingFor("acme")).toBe(1);
    expect([...q.jobs.keys()]).toEqual(["contract-codegen-acme"]);
    expect(q.addCalls).toHaveLength(1);
  });

  it("different tenants do not coalesce into each other", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    await enqueueCoalesced(q, SETTINGS, "globex");
    expect([...q.jobs.keys()].sort()).toEqual(["contract-codegen-acme", "contract-codegen-globex"]);
  });

  it("the job carries only the tenant slug, with small attempts + exponential backoff, and removes finished jobs", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    const job = q.jobs.get("contract-codegen-acme")!;
    expect(job.data).toEqual({ tenantSlug: "acme" });
    expect(job.opts).toEqual({
      jobId: "contract-codegen-acme",
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: true,
      // A failed job left in place would keep its id occupied and silently swallow every later enqueue.
      removeOnFail: true,
    });
    expect(jobOptionsFor(SETTINGS, "x").removeOnFail).toBe(true);
  });

  it("a change that commits while a run is ACTIVE queues a follow-up instead of being swallowed by the running job", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    q.start("contract-codegen-acme"); // the run read the composition BEFORE this change committed
    expect(await enqueueCoalesced(q, SETTINGS, "acme")).toBe("added");
    expect([...q.jobs.keys()].sort()).toEqual(["contract-codegen-acme", "contract-codegen-acme--next"]);
    // ... and a further burst while that follow-up waits is absorbed by it.
    expect(await enqueueCoalesced(q, SETTINGS, "acme")).toBe("coalesced");
    expect(q.waitingFor("acme")).toBe(1);
  });

  it("once the first run finished, a later enqueue goes to a free slot and the follow-up still absorbs bursts", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    q.start("contract-codegen-acme");
    await enqueueCoalesced(q, SETTINGS, "acme"); // -> --next, waiting
    q.finish("contract-codegen-acme");
    // --next is still waiting, and a run that has not started will read the newest state: coalesced, not a third job.
    expect(await enqueueCoalesced(q, SETTINGS, "acme")).toBe("coalesced");
    expect(q.waitingFor("acme")).toBe(1);
    // The follow-up starts; now a new change needs the main slot again.
    q.start("contract-codegen-acme--next");
    expect(await enqueueCoalesced(q, SETTINGS, "acme")).toBe("added");
    expect(q.jobs.get("contract-codegen-acme")?.state).toBe("waiting");
  });

  it("a job that is retrying (delayed backoff) counts as waiting: the retry will read the new state", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    q.jobs.get("contract-codegen-acme")!.state = "delayed";
    expect(await enqueueCoalesced(q, SETTINGS, "acme")).toBe("coalesced");
  });

  it("both slots running (two replicas) still queues the change, under a fresh id", async () => {
    const q = new FakeSlots();
    await enqueueCoalesced(q, SETTINGS, "acme");
    q.start("contract-codegen-acme");
    await enqueueCoalesced(q, SETTINGS, "acme");
    q.start("contract-codegen-acme--next");
    expect(await enqueueCoalesced(q, SETTINGS, "acme", () => 42)).toBe("added");
    expect(q.jobs.get("contract-codegen-acme--late-42")?.state).toBe("waiting");
  });
});

function fakeQueue(enqueue: (slug: string) => Promise<string>): ContractCodegenQueue {
  return { enqueue } as unknown as ContractCodegenQueue;
}

describe("ContractCodegenTrigger: fail-soft", () => {
  it("returns true and enqueues once when the queue accepts", async () => {
    const enqueue = vi.fn(async (_slug: string) => "added");
    expect(await new ContractCodegenTrigger(fakeQueue(enqueue)).requestRun("acme", "schema.apply")).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("acme");
  });

  it("a rejecting queue never rejects the caller: it answers false", async () => {
    const trigger = new ContractCodegenTrigger(fakeQueue(async () => Promise.reject(new Error("redis down"))));
    await expect(trigger.requestRun("acme", "tenant.provision")).resolves.toBe(false);
  });

  it("a queue that THROWS SYNCHRONOUSLY never throws at the caller either", async () => {
    const trigger = new ContractCodegenTrigger(
      fakeQueue(() => {
        throw new Error("boom");
      }),
    );
    await expect(trigger.requestRun("acme", "schema.apply")).resolves.toBe(false);
  });

  it("a queue that never answers (Redis unreachable: BullMQ retries forever) is abandoned after ENQUEUE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const trigger = new ContractCodegenTrigger(fakeQueue(() => new Promise<string>(() => undefined)));
      const p = trigger.requestRun("acme", "schema.apply");
      await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS + 1);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejection that arrives AFTER the timeout is not an unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // setImmediate stays real: the test awaits it
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate!: (e: Error) => void;
      const trigger = new ContractCodegenTrigger(fakeQueue(() => new Promise<string>((_, rej) => (rejectLate = rej))));
      const p = trigger.requestRun("acme", "schema.apply");
      await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS + 1);
      await p;
      rejectLate(new Error("late"));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });

  it("requestRuns enqueues one per tenant, in order, and reports the count", async () => {
    const seen: string[] = [];
    const trigger = new ContractCodegenTrigger(fakeQueue(async (s) => (seen.push(s), "added")));
    expect(await trigger.requestRuns(["a", "b", "c"], "contract.regenerate")).toEqual({ enqueued: 3, failed: 0 });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("requestRuns stops at the first failure (Redis is down) and reports the rest as failed, without waiting out each one", async () => {
    const seen: string[] = [];
    const trigger = new ContractCodegenTrigger(
      fakeQueue(async (s) => {
        seen.push(s);
        if (s === "b") throw new Error("redis down");
        return "added";
      }),
    );
    expect(await trigger.requestRuns(["a", "b", "c", "d"], "contract.regenerate")).toEqual({ enqueued: 1, failed: 3 });
    expect(seen).toEqual(["a", "b"]);
  });
});
