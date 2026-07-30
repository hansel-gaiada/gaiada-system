// Regression: the scheduler's DDL must run as the OWNER, not the runtime role.
//
// `ensureTables()` used to issue CREATE TABLE on the runtime pool. Under the owner/runtime role
// split that pool is `bot_app`, which has no rights on schema public — so EVERY digest, including
// the 12:00/18:00 cron, died with `permission denied for schema public` (42501) inside
// loadLastRun() before summarizing anything. It surfaced as a bare 500 from /run-digests/:slot and
// an empty digest history, with nothing pointing at the cause.
//
// This asserts the wiring (which DSN the DDL is issued against), not Postgres' own grants: the
// live-database behaviour is covered by store/pg.* against a real server.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const RUNTIME_DSN = "postgres://bot_app:runtime@pg-bot:5432/gaiada_bot";
const OWNER_DSN = "postgres://bot_owner:owner@pg-bot:5432/gaiada_bot";

type PoolRec = { dsn: string; queries: string[]; ended: boolean };
/** Pools built since the current test started (cleared per test). */
const pools: PoolRec[] = [];
/** Every pool built in this FILE — schedule-state memoizes its runtime pool for the process
 *  lifetime, so a later test reuses a pool created by an earlier one and `pools` can't see it. */
const allPools: PoolRec[] = [];

vi.mock("pg", () => ({
  Pool: class {
    queries: string[] = [];
    constructor(opts: { connectionString?: string }) {
      const rec = { dsn: opts.connectionString ?? "", queries: this.queries, ended: false };
      pools.push(rec);
      allPools.push(rec);
      this.rec = rec;
    }
    rec: { dsn: string; queries: string[]; ended: boolean };
    async query(sql: string) {
      this.queries.push(sql);
      return { rows: [], rowCount: 0 };
    }
    async connect() {
      return {
        query: async (sql: string) => {
          this.queries.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined,
      };
    }
    async end() {
      this.rec.ended = true;
    }
  },
}));

const { config } = await import("./config");
const { loadLastRun, resetScheduleStateTables } = await import("./schedule-state");

function ddlPools() {
  return pools.filter((p) => p.queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS schedule_state")));
}

describe("schedule-state DDL runs as the owner", () => {
  beforeEach(() => {
    pools.length = 0;
    resetScheduleStateTables();
    config.databaseUrl = RUNTIME_DSN;
    config.migrateDatabaseUrl = OWNER_DSN;
  });
  afterEach(() => {
    config.migrateDatabaseUrl = "";
    config.databaseUrl = "";
    resetScheduleStateTables();
  });

  it("issues CREATE TABLE against MIGRATE_DATABASE_URL (owner), never the runtime DSN", async () => {
    await loadLastRun("evening");

    const ddl = ddlPools();
    expect(ddl).toHaveLength(1);
    expect(ddl[0]?.dsn).toBe(OWNER_DSN);
    // The restricted runtime role must never be asked to do DDL — that is the 42501 bug.
    expect(pools.filter((p) => p.dsn === RUNTIME_DSN).flatMap((p) => p.queries).join("\n")).not.toMatch(
      /CREATE TABLE|ALTER TABLE|CREATE POLICY/,
    );
    // The short-lived owner pool is closed; the shared runtime pool is not.
    expect(ddl[0]?.ended).toBe(true);
  });

  it("creates the tables once across repeated calls (memoized, no owner pool per digest)", async () => {
    await loadLastRun("evening");
    await loadLastRun("noon");
    await loadLastRun("evening");
    expect(ddlPools()).toHaveLength(1);
  });

  it("falls back to the runtime pool when no migrate DSN is configured (dev: owner == runtime)", async () => {
    config.migrateDatabaseUrl = "";
    resetScheduleStateTables();

    await loadLastRun("evening");

    // Look in allPools, not pools: the runtime pool is memoized from an earlier test in this file.
    const runtime = allPools.filter((p) => p.dsn === RUNTIME_DSN);
    expect(runtime.length).toBeGreaterThan(0);
    const gotDdl = runtime.some((p) => p.queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS schedule_state")));
    expect(gotDdl).toBe(true);
    // No NEW owner pool was opened this round...
    expect(pools.some((p) => p.dsn === OWNER_DSN)).toBe(false);
    // ...and the shared runtime pool must NOT be closed out from under the rest of the process.
    expect(runtime.every((p) => !p.ended)).toBe(true);
  });
});
