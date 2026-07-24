// GoalQueue — bounded FIFO, concurrency cap, queue-full rejection, idle signalling. No DB.
import { describe, it, expect } from "vitest";
import { GoalQueue } from "./queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Wait until `cond` holds, letting queued microtasks (the worker's .finally→pump hops) flush. */
async function until(cond: () => boolean, tries = 50) {
  for (let i = 0; i < tries && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
}

describe("GoalQueue", () => {
  it("caps concurrency and drains FIFO", async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const q = new GoalQueue(
      async (id) => {
        order.push(id);
        const g = deferred();
        gates.set(id, g);
        await g.promise;
      },
      { maxConcurrent: 2, maxQueue: 10 },
    );
    expect(q.enqueue("a")).toBe(true);
    expect(q.enqueue("b")).toBe(true);
    expect(q.enqueue("c")).toBe(true);
    await until(() => order.length >= 2);
    // only 2 run at once
    expect(q.size()).toEqual({ running: 2, queued: 1 });
    expect(order).toEqual(["a", "b"]);
    gates.get("a")!.resolve();
    await until(() => order.length >= 3);
    expect(order).toEqual(["a", "b", "c"]); // c admitted after a finished
    gates.get("b")!.resolve();
    gates.get("c")!.resolve();
    await q.idle();
    expect(q.size()).toEqual({ running: 0, queued: 0 });
  });

  it("rejects enqueue when the waiting list is full (→ 429 upstream)", async () => {
    const gate = deferred();
    const q = new GoalQueue(async () => gate.promise, { maxConcurrent: 1, maxQueue: 1 });
    expect(q.enqueue("a")).toBe(true); // runs
    await Promise.resolve();
    expect(q.enqueue("b")).toBe(true); // waits (queue depth 1)
    expect(q.enqueue("c")).toBe(false); // full
    expect(q.size()).toEqual({ running: 1, queued: 1 });
    gate.resolve();
    await q.idle();
  });

  it("idle() resolves immediately when empty", async () => {
    const q = new GoalQueue(async () => {}, { maxConcurrent: 1, maxQueue: 1 });
    await expect(q.idle()).resolves.toBeUndefined();
  });
});
