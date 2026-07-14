// Hybrid Logical Clock (sync-engine revision §2, D3 fix #2 and #4). THE only clock stamped on
// every outbox_events row for cross-site ordering. Mirrors sync-engine-go/internal/hlc so both
// sides interoperate byte-for-byte.
//
// Canonical text format: ZERO-PADDED "%013d.%010d" (wallMs.counter). Padding makes plain text
// ordering equal logical ordering, so SQL `hlc > cursor` and `MAX(hlc)` are correct as text
// comparisons — see migrations/0012_outbox_hlc.sql.
//
// D3 #4 (failover monotonicity): seedFromPersisted() lifts the clock to at least the last HLC
// persisted for this origin_site, so a process restart (or a promoted standby with a lagging
// wall clock) can never mint an HLC that regresses behind what is already committed.

import type { Pool, PoolClient } from "pg";
import { config } from "../config";

const WALL_WIDTH = 13;
const CTR_WIDTH = 10;

export function formatHlc(wallMs: number, counter: number): string {
  return `${String(wallMs).padStart(WALL_WIDTH, "0")}.${String(counter).padStart(CTR_WIDTH, "0")}`;
}

export function parseHlc(s: string): { wallMs: number; counter: number } {
  const dot = s.indexOf(".");
  if (dot < 0) throw new Error(`invalid HLC string: ${s}`);
  return { wallMs: Number(s.slice(0, dot)), counter: Number(s.slice(dot + 1)) };
}

export class HlcClock {
  private lastMs = 0;
  private counter = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Monotonic next HLC. Same-wall-ms calls bump the counter; a wall advance resets it. */
  next(): string {
    const wall = this.now();
    if (wall > this.lastMs) {
      this.lastMs = wall;
      this.counter = 0;
    } else {
      this.counter++;
    }
    return formatHlc(this.lastMs, this.counter);
  }

  /** D3 #4 startup guard: never issue an HLC <= lastKnown. */
  seedFromPersisted(lastKnown: string | null | undefined): void {
    if (!lastKnown) return;
    const { wallMs, counter } = parseHlc(lastKnown);
    if (wallMs > this.lastMs || (wallMs === this.lastMs && counter > this.counter)) {
      this.lastMs = wallMs;
      this.counter = counter;
    }
  }
}

// Process-wide singleton (Node is single-threaded per process; no mutex needed for the
// synchronous next()). emitEvent() stamps every row from this instance.
let singleton: HlcClock | null = null;
export function getClock(): HlcClock {
  if (!singleton) singleton = new HlcClock();
  return singleton;
}

/**
 * Seed the singleton from the DB at startup (call from main bootstrap). Reads the greatest HLC
 * this origin_site has ever written, parsing numerically so it is robust regardless of format.
 */
export async function seedClockFromDb(db: Pool | PoolClient): Promise<void> {
  const { rows } = await db.query<{ hlc: string | null }>(
    `SELECT hlc FROM outbox_events
     WHERE origin_site = $1 AND hlc IS NOT NULL
     ORDER BY (split_part(hlc, '.', 1))::bigint DESC, (split_part(hlc, '.', 2))::bigint DESC
     LIMIT 1`,
    [config.originSite],
  );
  getClock().seedFromPersisted(rows[0]?.hlc ?? null);
}
