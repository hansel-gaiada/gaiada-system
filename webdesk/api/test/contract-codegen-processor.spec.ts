// M6-P4r-b -- the contract-codegen worker's per-job behaviour, with NO services: fake runner, fake lock.
// Covers per-tenant serialization (two runs for one tenant never interleave), the timeout that must NOT
// release the lock early, failure handling, the compiled runner's currency check, and the advisory lock's
// own acquire/release logic over a fake pool. The same lock against a real Postgres is in
// contract-codegen-live.spec.ts.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContractCodegenProcessor } from "../src/codegen/contract-codegen.processor";
import { isContractCurrent, resolveBundlePath } from "../src/codegen/contract-codegen.runner";
import { PgContractCodegenLock, lockKeyFor } from "../src/codegen/contract-codegen.lock";
import {
  ContractCodegenLockBusyError,
  ContractCodegenTimeoutError,
  parseJobData,
  type ContractCodegenLock,
  type ContractCodegenLockHandle,
  type ContractCodegenRunResult,
  type ContractCodegenRunner,
} from "../src/codegen/contract-codegen.types";
import type { DbService } from "../src/db/db.service";

/** An in-memory per-tenant mutex with the same contract as the Postgres advisory lock. */
class MemoryLock implements ContractCodegenLock {
  private readonly held = new Map<string, Promise<void>>();
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  async acquire(tenantSlug: string): Promise<ContractCodegenLockHandle> {
    while (this.held.has(tenantSlug)) await this.held.get(tenantSlug);
    let open!: () => void;
    this.held.set(tenantSlug, new Promise<void>((r) => (open = r)));
    this.acquired.push(tenantSlug);
    return {
      release: async () => {
        this.released.push(tenantSlug);
        this.held.delete(tenantSlug);
        open();
      },
    };
  }
  isHeld(slug: string) {
    return this.held.has(slug);
  }
}

const done = (v: Partial<ContractCodegenRunResult> = {}): ContractCodegenRunResult => ({ outcome: "published", contractVersion: "1.0.0", contentHash: "sha256:abc", ...v });

function processor(runner: ContractCodegenRunner, lock: ContractCodegenLock) {
  return new ContractCodegenProcessor(runner, lock, {} as DbService);
}
const job = (tenantSlug: unknown) => ({ data: { tenantSlug } });
const tick = () => new Promise((r) => setImmediate(r));

describe("contract-codegen worker: per-tenant serialization", () => {
  it("two runs for ONE tenant never interleave, even when started together", async () => {
    const events: string[] = [];
    const gates: (() => void)[] = [];
    const runner: ContractCodegenRunner = {
      async run(slug) {
        events.push(`start:${slug}`);
        await new Promise<void>((r) => gates.push(r));
        events.push(`end:${slug}`);
        return done();
      },
    };
    const lock = new MemoryLock();
    const p = processor(runner, lock);
    const a = p.process(job("acme"));
    const b = p.process(job("acme"));
    await tick();
    await tick();
    expect(events).toEqual(["start:acme"]); // the second one is waiting on the lock, not running
    gates.shift()!();
    await a;
    await tick();
    await tick();
    expect(events).toEqual(["start:acme", "end:acme", "start:acme"]);
    gates.shift()!();
    await b;
    expect(events).toEqual(["start:acme", "end:acme", "start:acme", "end:acme"]);
    expect(lock.released).toEqual(["acme", "acme"]);
  });

  it("runs for DIFFERENT tenants are independent", async () => {
    const running = new Set<string>();
    let peak = 0;
    const gates: (() => void)[] = [];
    const runner: ContractCodegenRunner = {
      async run(slug) {
        running.add(slug);
        peak = Math.max(peak, running.size);
        await new Promise<void>((r) => gates.push(r));
        running.delete(slug);
        return done();
      },
    };
    const p = processor(runner, new MemoryLock());
    const a = p.process(job("acme"));
    const b = p.process(job("globex"));
    await tick();
    await tick();
    expect(peak).toBe(2);
    gates.forEach((g) => g());
    await Promise.all([a, b]);
  });

  it("a runner failure fails the attempt AND releases the lock, so the retry can run", async () => {
    let calls = 0;
    const runner: ContractCodegenRunner = {
      async run() {
        calls++;
        if (calls === 1) throw new Error("rustfs unreachable");
        return done();
      },
    };
    const lock = new MemoryLock();
    const p = processor(runner, lock);
    await expect(p.process(job("acme"))).rejects.toThrow("rustfs unreachable");
    await tick();
    expect(lock.isHeld("acme")).toBe(false);
    await expect(p.process(job("acme"))).resolves.toMatchObject({ outcome: "published" });
  });

  it("a runner that throws SYNCHRONOUSLY also releases the lock", async () => {
    const lock = new MemoryLock();
    const runner = {
      run() {
        throw new Error("sync boom");
      },
    } as unknown as ContractCodegenRunner;
    await expect(processor(runner, lock).process(job("acme"))).rejects.toThrow("sync boom");
    await tick();
    expect(lock.isHeld("acme")).toBe(false);
  });

  it("on TIMEOUT the attempt fails but the lock stays held until the run really ends (a late writer must not interleave with the retry)", async () => {
    let finish!: () => void;
    const events: string[] = [];
    let calls = 0;
    const runner: ContractCodegenRunner = {
      async run() {
        const n = ++calls;
        events.push(`start:${n}`);
        if (n === 1) await new Promise<void>((r) => (finish = r));
        events.push(`end:${n}`);
        return done();
      },
    };
    const lock = new MemoryLock();
    const p = processor(runner, lock);
    p.setLimitsForTest({ timeoutMs: 20 });
    await expect(p.process(job("acme"))).rejects.toBeInstanceOf(ContractCodegenTimeoutError);
    expect(lock.isHeld("acme")).toBe(true); // the first run is still writing
    const retry = p.process(job("acme")); // BullMQ's retry
    await tick();
    await tick();
    expect(events).toEqual(["start:1"]); // not started: waiting for the lock
    finish(); // the overrunning run completes
    await retry;
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("a lock that cannot be had fails the attempt without calling the runner", async () => {
    let called = false;
    const runner: ContractCodegenRunner = { run: async () => ((called = true), done()) };
    const busy: ContractCodegenLock = {
      acquire: async (slug, waitMs) => {
        throw new ContractCodegenLockBusyError(slug, waitMs);
      },
    };
    await expect(processor(runner, busy).process(job("acme"))).rejects.toBeInstanceOf(ContractCodegenLockBusyError);
    expect(called).toBe(false);
  });

  it("refuses a job whose data is not a plausible tenant slug, before taking any lock", async () => {
    const lock = new MemoryLock();
    const p = processor({ run: async () => done() }, lock);
    for (const bad of [undefined, "", "../etc", "a/b", 42, "x".repeat(300)]) {
      await expect(p.process(job(bad))).rejects.toThrow("no valid tenantSlug");
    }
    expect(lock.acquired).toEqual([]);
    expect(parseJobData({ tenantSlug: "acme-2.test" })).toEqual({ tenantSlug: "acme-2.test" });
  });

  it("an archived or missing tenant is a success with nothing to do, not a failure to retry", async () => {
    const p = processor({ run: async () => ({ outcome: "tenant-not-found" }) }, new MemoryLock());
    await expect(p.process(job("gone"))).resolves.toEqual({ outcome: "tenant-not-found" });
  });

  it("an unchanged contract is a success", async () => {
    const p = processor({ run: async () => done({ outcome: "unchanged" }) }, new MemoryLock());
    await expect(p.process(job("acme"))).resolves.toMatchObject({ outcome: "unchanged" });
  });
});

describe("compiled runner: currency check", () => {
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : v !== null && typeof v === "object"
        ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`
        : JSON.stringify(v);
  const snap = { collections: { page: { fields: [{ name: "title" }] } } };
  const pointer = { contractVersion: "1.1.0", contentHash: "sha256:x", vocabularyVersion: "1.1.0", compositionSnapshot: snap };

  it("is current when the composition snapshot and the vocabulary version both match", () => {
    expect(isContractCurrent(pointer, structuredClone(snap), "1.1.0", stable)).toBe(true);
  });
  it("is NOT current when the composition changed", () => {
    expect(isContractCurrent(pointer, { collections: { page: { fields: [{ name: "title" }, { name: "sub" }] } } }, "1.1.0", stable)).toBe(false);
  });
  it("is NOT current after a vocabulary release (the contract must be regenerated)", () => {
    expect(isContractCurrent(pointer, snap, "1.2.0", stable)).toBe(false);
  });
  // M6-P4b0 -- the block library is part of "current" only when the image bakes one.
  it("is NOT current when the image bakes a block library the pointer never recorded (a pre-M6-P4b0 tenant)", () => {
    expect(isContractCurrent(pointer, snap, "1.1.0", stable, "a".repeat(64))).toBe(false);
  });
  it("is NOT current when the pointer recorded a different (older) library tarball", () => {
    expect(isContractCurrent({ ...pointer, blockLibrarySha256: "b".repeat(64) }, snap, "1.1.0", stable, "a".repeat(64))).toBe(false);
  });
  it("is current when the pointer recorded exactly the baked tarball", () => {
    expect(isContractCurrent({ ...pointer, blockLibrarySha256: "a".repeat(64) }, snap, "1.1.0", stable, "a".repeat(64))).toBe(true);
  });
  it("ignores the library when no tarball is baked, even if the pointer carries one", () => {
    expect(isContractCurrent({ ...pointer, blockLibrarySha256: "b".repeat(64) }, snap, "1.1.0", stable, null)).toBe(true);
  });
});

describe("compiled runner: bundle resolution", () => {
  it("finds the bundle next to the compiled file (the image layout), else <api>/dist/codegen, and says where it looked when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "codegen-bundle-"));
    try {
      const image = join(root, "image", "dist", "codegen");
      mkdirSync(image, { recursive: true });
      writeFileSync(join(image, "generator.mjs"), "");
      expect(resolveBundlePath({}, image)).toBe(join(image, "generator.mjs"));

      const src = join(root, "checkout", "src", "codegen");
      mkdirSync(src, { recursive: true });
      mkdirSync(join(root, "checkout", "dist", "codegen"), { recursive: true });
      writeFileSync(join(root, "checkout", "dist", "codegen", "generator.mjs"), "");
      expect(resolveBundlePath({}, src)).toBe(join(src, "..", "..", "dist", "codegen", "generator.mjs"));

      const lone = join(root, "nothing", "src", "codegen");
      mkdirSync(lone, { recursive: true });
      expect(() => resolveBundlePath({}, lone)).toThrow(/bundle not found.*npm run build/s);
      expect(resolveBundlePath({ WEBDESK_CODEGEN_BUNDLE: join(image, "generator.mjs") }, lone)).toBe(join(image, "generator.mjs"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("PgContractCodegenLock over a fake pool", () => {
  function fakePool(script: (sql: string, params: unknown[]) => { ok: boolean } | Error) {
    const log: { sql: string; params: unknown[] }[] = [];
    const releases: unknown[] = [];
    const client = {
      async query(sql: string, params: unknown[]) {
        log.push({ sql, params });
        const r = script(sql, params);
        if (r instanceof Error) throw r;
        return { rows: [r] };
      },
      release(arg?: unknown) {
        releases.push(arg === undefined ? "pooled" : arg);
      },
    };
    const db = { pool: { connect: async () => client } } as unknown as DbService;
    return { db, log, releases };
  }

  it("keys the lock on the namespaced tenant slug, takes it with try-lock, and unlocks the same key", async () => {
    const { db, log, releases } = fakePool(() => ({ ok: true }));
    const handle = await new PgContractCodegenLock(db).acquire("acme", 1000);
    expect(log[0].sql).toContain("pg_try_advisory_lock");
    expect(log[0].params).toEqual([lockKeyFor("acme")]);
    expect(lockKeyFor("acme")).toBe("webdesk:contract-codegen:acme");
    await handle.release();
    await handle.release(); // idempotent
    expect(log.filter((l) => l.sql.includes("pg_advisory_unlock"))).toHaveLength(1);
    expect(releases).toEqual(["pooled"]);
  });

  it("when another session holds it, gives up after the wait with ContractCodegenLockBusyError and returns the connection to the pool", async () => {
    const { db, releases } = fakePool(() => ({ ok: false }));
    await expect(new PgContractCodegenLock(db).acquire("acme", 10)).rejects.toBeInstanceOf(ContractCodegenLockBusyError);
    expect(releases).toEqual(["pooled"]);
  });

  it("an unlock that fails DESTROYS the connection (release(true)) so a held lock can never leak back into the pool", async () => {
    const { db, releases } = fakePool((sql) => (sql.includes("pg_advisory_unlock") ? new Error("connection reset") : { ok: true }));
    const handle = await new PgContractCodegenLock(db).acquire("acme", 1000);
    await handle.release();
    expect(releases).toEqual([true]);
  });
});
