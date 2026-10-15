// PV7-02 — `pm_milestones.completed_at` (migration 202610151710), proven against real Postgres.
//
// The trigger sets the column when a milestone's status ENTERS the done set and clears it when the status LEAVES it. The
// done set is the one `computeMilestoneHitRate` (reports/report-rollups.ts) counts: `status = 'done'`. Nothing is
// back-filled, so an old done row stays NULL and an unrelated edit must not stamp it.
//
// Needs DATABASE_URL_TEST (skips silently without it: check the skip count). Runs on the Linux CI gate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createProject } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { config } from "../../config";

const site = () => config.originSite;

describe.skipIf(!TEST_URL)("PV7-02 · pm_milestones.completed_at trigger", () => {
  let co: string;
  let project: string;

  const insert = (status: string, completedAt: string | null = null) => {
    const id = newId();
    return withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, completed_at, origin_site)
         VALUES ($1, $2, $3, 'Launch', current_date, $4, $5::timestamptz, $6)`,
        [id, co, project, status, completedAt, site()],
      );
      return id;
    });
  };
  const setStatus = (id: string, status: string) =>
    withTenants([co], (c) => c.query(`UPDATE pm_milestones SET status = $2 WHERE id = $1`, [id, status]));
  const completedAt = async (id: string): Promise<Date | null> =>
    (await withTenants([co], (c) => c.query<{ completed_at: Date | null }>(`SELECT completed_at FROM pm_milestones WHERE id = $1`, [id]))).rows[0].completed_at;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Milestone Co", ["pm"]);
    project = await createProject(co, "Milestone project");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("a milestone inserted open has no completion time", async () => {
    expect(await completedAt(await insert("open"))).toBeNull();
  });

  it("a milestone inserted already done is stamped with the insert time", async () => {
    const at = await completedAt(await insert("done"));
    expect(at).not.toBeNull();
    expect(Math.abs(Date.now() - at!.getTime())).toBeLessThan(5 * 60_000);
  });

  it("an insert may name its own completion time (an import of dated history), and it is kept", async () => {
    const at = await completedAt(await insert("done", "2026-01-15T08:00:00.000Z"));
    expect(at?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("an insert that is not done never carries one, even if the row names it", async () => {
    expect(await completedAt(await insert("open", "2026-01-15T08:00:00.000Z"))).toBeNull();
  });

  it("entering done stamps it, and leaving done clears it", async () => {
    const id = await insert("open");
    await setStatus(id, "in_progress");
    expect(await completedAt(id)).toBeNull();
    await setStatus(id, "done");
    const first = await completedAt(id);
    expect(first).not.toBeNull();
    await setStatus(id, "open");
    expect(await completedAt(id)).toBeNull();
  });

  it("reopening and finishing again stamps the NEW completion", async () => {
    const id = await insert("done", "2026-01-15T08:00:00.000Z");
    await setStatus(id, "open");
    await setStatus(id, "done");
    const again = await completedAt(id);
    expect(again!.getTime()).toBeGreaterThan(new Date("2026-01-15T08:00:00.000Z").getTime());
  });

  it("an edit that leaves a done milestone done does not move its completion time", async () => {
    const id = await insert("done", "2026-01-15T08:00:00.000Z");
    await withTenants([co], (c) => c.query(`UPDATE pm_milestones SET name = 'Renamed', due_date = current_date + 3 WHERE id = $1`, [id]));
    expect((await completedAt(id))?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    await setStatus(id, "done");
    expect((await completedAt(id))?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("nothing is back-filled: an old done row with no completion time stays NULL through an unrelated edit", async () => {
    // A done row as it exists on a database that predates the column: written with triggers off, as the backfill-free
    // migration leaves it.
    const id = newId();
    const admin = await adminPool().connect();
    try {
      await admin.query(`SET session_replication_role = replica`);
      await admin.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
         VALUES ($1, $2, $3, 'Old', current_date - 90, 'done', $4)`,
        [id, co, project, site()],
      );
      await admin.query(`SET session_replication_role = DEFAULT`);
    } finally {
      admin.release();
    }
    expect(await completedAt(id)).toBeNull();
    await withTenants([co], (c) => c.query(`UPDATE pm_milestones SET name = 'Old, renamed' WHERE id = $1`, [id]));
    expect(await completedAt(id)).toBeNull();
  });

  it("pins the done set to the one computeMilestoneHitRate counts", () => {
    // If the rollup's done set ever changes, this trigger must change with it. The file read keeps the two from drifting silently.
    const rollup = readFileSync(join(__dirname, "..", "reports", "report-rollups.ts"), "utf8");
    expect(rollup).toContain("count(*) FILTER (WHERE status = 'done') AS hit");
    const migration = readFileSync(join(__dirname, "..", "..", "..", "migrations", "202610151710_pm_milestones_completed_at.sql"), "utf8");
    expect(migration).toContain("NEW.status = 'done'");
  });
});
