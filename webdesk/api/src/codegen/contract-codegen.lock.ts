// M6-P4r-b -- per-tenant mutual exclusion for contract codegen, a Postgres SESSION advisory lock.
//
// WHY. Two runs for one tenant (a retry overlapping a new job, a second api replica, a hand-run
// `codegen:run` against the same database) would each read latest.json, build the next version and
// overwrite latest.json: the later writer can publish a pointer built from an OLDER composition. The
// generator reads the previous pointer INSIDE its run, so holding this lock around the whole run makes
// the read-build-publish sequence atomic per tenant. (Compare-and-set on the previous snapshot was the
// alternative; the lock is simpler and the pointer write is a plain S3 PUT with no conditional form.)
//
// HOW. One dedicated pooled connection holds `pg_advisory_lock(hashtextextended(key, 0))` for the run.
// A session lock dies with its connection, so a crashed worker can never leave a tenant locked. The
// connection is released with `release(true)` (destroyed, not pooled) if the unlock itself failed, so a
// lock can never leak into the pool. The key is namespaced (`webdesk:contract-codegen:<slug>`) so it
// cannot collide with another advisory-lock user, and nothing else in this service uses advisory locks.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { ContractCodegenLockBusyError, type ContractCodegenLock, type ContractCodegenLockHandle } from "./contract-codegen.types";

const POLL_MS = 250;
const TRY_LOCK = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`;
const UNLOCK = `SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok`;

export function lockKeyFor(tenantSlug: string): string {
  return `webdesk:contract-codegen:${tenantSlug}`;
}

@Injectable()
export class PgContractCodegenLock implements ContractCodegenLock {
  constructor(private readonly db: DbService) {}

  async acquire(tenantSlug: string, waitMs: number): Promise<ContractCodegenLockHandle> {
    const key = lockKeyFor(tenantSlug);
    const client = await this.db.pool.connect();
    try {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const { rows } = await client.query<{ ok: boolean }>(TRY_LOCK, [key]);
        if (rows[0]?.ok === true) break;
        if (Date.now() >= deadline) throw new ContractCodegenLockBusyError(tenantSlug, waitMs);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (err) {
      // Nothing is held on this connection (the lock was never taken), so it can go back to the pool.
      client.release();
      throw err;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          const { rows } = await client.query<{ ok: boolean }>(UNLOCK, [key]);
          if (rows[0]?.ok !== true) throw new Error("advisory unlock reported the lock was not held");
          client.release();
        } catch {
          // Could not prove the lock is gone: destroy the connection, which ends the session and the lock.
          client.release(true);
        }
      },
    };
  }
}
