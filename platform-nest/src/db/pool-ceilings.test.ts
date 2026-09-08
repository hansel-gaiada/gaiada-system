// Pins the connection-pool ceilings added 2026-09-08 (fault register finding 03).
//
// WHY THIS FILE EXISTS RATHER THAN A COMMENT ON getPool():
// Before this change `getPool()` was `new Pool({ connectionString })` — pg's defaults, i.e.
// **max 10** and **connectionTimeoutMillis 0, which means wait forever**. Request traffic and the
// ~15 background loops main.ts starts share that one pool, and no `statement_timeout` existed
// anywhere in the repository. One slow query on a grown table therefore took the whole ERP down —
// every caller blocked on `pool.connect()` indefinitely — while `/health`, which touches none of
// this, kept answering 200.
//
// The dangerous property of that fix is that it is SILENT IF IT REGRESSES. If someone later
// "tidies" the Pool construction back to a bare connection string, or renames a config key, or a
// pg upgrade stops honouring one of these options, nothing throws, no test goes red, and the
// system quietly returns to unbounded waiting. It looks identical to a working system right up
// until the outage. So the ceilings are asserted against the CONSTRUCTED pool's own options,
// not against the config object — the config being right is not the same as the pool receiving it.
import { describe, it, expect, afterEach } from "vitest";
import { getPool, closePool } from "./index";
import { config } from "../config";

// pg's Pool keeps the resolved config on `.options`. Not in its public typings, hence the cast.
type PoolWithOptions = { options: Record<string, unknown> };

describe("connection-pool ceilings (finding 03)", () => {
  const original = config.databaseUrl;

  afterEach(async () => {
    await closePool();
    (config as { databaseUrl: string }).databaseUrl = original;
  });

  it("constructs the pool WITH every ceiling — no pg default survives", () => {
    // A syntactically valid DSN is enough: pg resolves options at construction and opens no
    // socket until the first connect(), so this asserts the wiring without needing a database.
    (config as { databaseUrl: string }).databaseUrl = "postgres://u:p@127.0.0.1:1/db";
    const opts = (getPool() as unknown as PoolWithOptions).options;

    // The load-bearing one. pg's default is 0 = wait forever, which is what turned a slow query
    // into a total outage. If this ever reads 0 or undefined again, that outage mode is back.
    expect(opts.connectionTimeoutMillis).toBe(config.poolConnectionTimeoutMs);
    expect(opts.connectionTimeoutMillis).toBeGreaterThan(0);

    expect(opts.max).toBe(config.poolMax);
    expect(opts.idleTimeoutMillis).toBe(config.poolIdleTimeoutMs);

    // Sent as Postgres startup parameters, so they bound background-loop queries too — the
    // callers nobody is watching, and the ones most likely to run long.
    expect(opts.statement_timeout).toBe(config.statementTimeoutMs);
    expect(opts.idle_in_transaction_session_timeout).toBe(config.idleInTransactionTimeoutMs);
  });

  it("every ceiling is a positive number — a 0 here means 'unbounded', not 'off'", () => {
    // Guards the compose `${VAR:-}` hazard from the other side: config uses positiveIntFromEnv,
    // but a future edit to a raw `Number(process.env.X)` would yield 0 for an empty string and
    // silently restore the unbounded behaviour under a config that LOOKS configured.
    for (const [name, value] of [
      ["poolMax", config.poolMax],
      ["poolConnectionTimeoutMs", config.poolConnectionTimeoutMs],
      ["poolIdleTimeoutMs", config.poolIdleTimeoutMs],
      ["statementTimeoutMs", config.statementTimeoutMs],
      ["idleInTransactionTimeoutMs", config.idleInTransactionTimeoutMs],
    ] as const) {
      expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
      expect(value, `${name} must be > 0`).toBeGreaterThan(0);
    }
  });

  it("idle-in-transaction is looser than statement_timeout — they catch different faults", () => {
    // A slow STATEMENT and an abandoned OPEN TRANSACTION are different failures: the second holds
    // locks while running nothing at all. Inverting these would let a leaked transaction be
    // reaped before a legitimately slow query, which is backwards.
    expect(config.idleInTransactionTimeoutMs).toBeGreaterThan(config.statementTimeoutMs);
  });
});
