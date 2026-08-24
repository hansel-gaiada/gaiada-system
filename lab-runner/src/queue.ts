// The queue — the feature, not the plumbing.
//
// SumoPod has 4 vCPU, was measured at load 6.39, and carries 19 containers of the owner's private
// production plus two unrelated projects. Free-for-all execution there is not a performance
// question; it is a production incident somewhere else. So: a hard concurrency cap, a BOUNDED
// backlog, and a refusal when the backlog is full.
//
// Refusing beats queueing indefinitely. An unbounded queue is a memory leak with a politer name,
// and a learner told "queued" for twenty minutes concludes the feature is broken — so they submit
// again, which is exactly the wrong response to a saturated box.
import { config } from "./config.js";
import { runLab, type RunRequest, type RunResult } from "./runner.js";

type State = "queued" | "running" | "done";

interface Entry {
  runId: string;
  state: State;
  queuedAt: number;
  result: RunResult | null;
  /** Resolved when the run finishes — lets a caller await instead of polling, if it wants to. */
  done: Promise<RunResult>;
}

export class LabQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly pending: (() => void)[] = [];
  private active = 0;

  get depth(): number { return this.pending.length; }
  get running(): number { return this.active; }

  /**
   * Accept a run, or refuse.
   *
   * Returns the runId immediately; the caller polls `get()`. Refusal is an exception rather than a
   * queued-forever promise, because the only honest answer to a full box is "not now".
   */
  submit(req: RunRequest): { runId: string } {
    if (this.pending.length >= config.maxQueued) {
      throw new QueueFullError(
        `the lab runner has ${this.active} running and ${this.pending.length} queued, which is its ` +
        `limit. Try again shortly — this box also runs production for other systems, so the cap is ` +
        `deliberate rather than a shortage.`,
      );
    }

    let resolveDone!: (r: RunResult) => void;
    const done = new Promise<RunResult>((res) => { resolveDone = res; });
    // The id is minted by the runner itself, so the entry is keyed after the run begins. Reserve a
    // slot under a temporary key first so `submit` can answer synchronously.
    const placeholder = `pending-${Math.random().toString(36).slice(2, 12)}`;
    const entry: Entry = { runId: placeholder, state: "queued", queuedAt: Date.now(), result: null, done };
    this.entries.set(placeholder, entry);

    const start = async () => {
      this.active += 1;
      entry.state = "running";
      try {
        const result = await runLab(req);
        entry.result = result;
        // Re-key to the real run id, keeping the placeholder resolvable so a caller that already
        // has it does not get a 404 halfway through.
        this.entries.set(result.runId, entry);
        entry.runId = result.runId;
        resolveDone(result);
      } catch (e) {
        // runLab already converts its own failures into an `error` result; reaching here means
        // something outside it threw. Record it rather than leaving the entry stuck at "running"
        // forever — a run that never resolves is indistinguishable from a hung box.
        const result: RunResult = {
          runId: entry.runId, challengeId: req.challengeId, status: "error",
          exitCode: null, timedOut: false, stdout: "", stderr: "",
          artefacts: [], grade: null,
          error: e instanceof Error ? e.message : String(e),
          startedAt: new Date(entry.queuedAt).toISOString(),
          finishedAt: new Date().toISOString(), durationMs: Date.now() - entry.queuedAt,
        };
        entry.result = result;
        resolveDone(result);
      } finally {
        entry.state = "done";
        this.active -= 1;
        this.sweep();
        const next = this.pending.shift();
        if (next) next();
      }
    };

    if (this.active < config.maxConcurrent) void start();
    else this.pending.push(() => void start());

    return { runId: placeholder };
  }

  get(runId: string): { state: State; result: RunResult | null } | null {
    const e = this.entries.get(runId);
    return e ? { state: e.state, result: e.result } : null;
  }

  await(runId: string): Promise<RunResult> | null {
    return this.entries.get(runId)?.done ?? null;
  }

  /**
   * Drop finished entries past their TTL.
   *
   * Results are not durable state — the PLATFORM records the grade; this service is a compute
   * surface. Keeping every result forever would make the runner a store nobody backs up and a
   * memory leak nobody notices until the box is short of RAM it does not have.
   */
  sweep(now = Date.now()): void {
    const ttl = config.resultTtlSec * 1000;
    for (const [key, e] of this.entries) {
      if (e.state === "done" && e.result && now - Date.parse(e.result.finishedAt) > ttl) {
        this.entries.delete(key);
      }
    }
  }

  /** Test seam. */
  size(): number { return this.entries.size; }
}

export class QueueFullError extends Error {
  readonly status = 429;
}
