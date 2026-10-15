// PV7-02 — every query the health reads issue binds its parameters DENSELY, in both modes. Pure: no database.
//
// WHY. Postgres refuses a statement whose text references $3 but not $2 ("could not determine data type of parameter $2")
// and one that is handed more values than it references. The first version of the portal ball bound four values and
// referenced three, so EVERY portal read of it failed. The route did not 500: the failure was caught by the per-source reader
// and surfaced as `unavailable: ["ball"]`, which only the DB suite noticed. This test catches the class without a database:
// a fake connection records each statement, and the test checks that the highest placeholder equals the number of values and
// that every placeholder from $1 up is referenced.
import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { loadClientBall } from "./client-ball";
import { loadProjectHealth, loadTurnaround, type Reach } from "./client-health";

interface Seen { sql: string; values: unknown[] }

function recorder(): { client: PoolClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      seen.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, seen };
}

/** The placeholders a statement references. */
const referenced = (sql: string): number[] => [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

function expectDense(seen: Seen[]): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const { sql, values } of seen) {
    const refs = referenced(sql);
    const head = sql.replace(/\s+/g, " ").trim().slice(0, 90);
    expect(refs, `references of: ${head}`).toEqual(Array.from({ length: refs.length }, (_, i) => i + 1));
    expect(values.length, `values bound to: ${head}`).toBe(refs.length);
  }
}

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const portalReach: Reach = { kind: "portal", clientIds: IDS, scopeParams: [IDS, [IDS[0]], ["33333333-3333-4333-8333-333333333333"]] };
const staffReach: Reach = { kind: "staff", clientIds: IDS };

describe("PV7-02 · the health reads bind their parameters densely", () => {
  it("client-ball, staff mode: every read references $1 only and is handed one value", async () => {
    const { client, seen } = recorder();
    await loadClientBall(client, IDS);
    expect(seen).toHaveLength(8);
    expectDense(seen);
    for (const s of seen) expect(s.values).toEqual([IDS]);
  });

  it("client-ball, portal mode: dense prefixes, seven reads (the drafted-agreement read is skipped)", async () => {
    const { client, seen } = recorder();
    await loadClientBall(client, IDS, { portal: { params: [IDS, [IDS[0]], ["33333333-3333-4333-8333-333333333333"]] } });
    expect(seen).toHaveLength(7);
    expectDense(seen);
    // The client-wide-only reads (payments, post reviews) take two values; the reads that also reach by project take three.
    const widths = seen.map((s) => s.values.length).sort();
    expect(widths).toEqual([2, 2, 2, 3, 3, 3, 3]);
  });

  it("project health: dense in both modes, four reads always", async () => {
    for (const reach of [staffReach, portalReach]) {
      const { client, seen } = recorder();
      await loadProjectHealth(client, reach);
      expect(seen).toHaveLength(4);
      expectDense(seen);
    }
  });

  it("turnaround: one read, dense in both modes", async () => {
    for (const reach of [staffReach, portalReach]) {
      const { client, seen } = recorder();
      await loadTurnaround(client, reach);
      expect(seen).toHaveLength(1);
      expectDense(seen);
    }
  });

  it("portal mode really narrows: the portal reads reference the scope arrays, the staff reads do not", async () => {
    const staff = recorder();
    await loadTurnaround(staff.client, staffReach);
    expect(referenced(staff.seen[0].sql)).toEqual([1]);
    const portal = recorder();
    await loadTurnaround(portal.client, portalReach);
    expect(referenced(portal.seen[0].sql)).toEqual([1, 2, 3, 4]);
  });
});
