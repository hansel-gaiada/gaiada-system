import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("OutboxService.emit", () => {
  let co: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Outbox Test Co");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("writes a row in the same transaction as the caller", async () => {
    const entityId = "00000000-0000-0000-0000-000000000001";
    await withTenants([co], async (c) => {
      await emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { approvedBy: "u1" });
    });
    const { rows } = await adminPool().query(
      `SELECT tenant_id, entity_type, entity_id, event_type, payload, relayed_at FROM outbox_events WHERE entity_id = $1`,
      [entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("deliverable.approved");
    expect(rows[0].payload).toEqual({ approvedBy: "u1" });
    expect(rows[0].relayed_at).toBeNull();
  });

  it("rolls back the outbox row if the transaction rolls back", async () => {
    const entityId = "00000000-0000-0000-0000-000000000002";
    await expect(
      withTenants([co], async (c) => {
        await emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {});
        throw new Error("simulated failure after emit");
      }),
    ).rejects.toThrow("simulated failure");
    const { rows } = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1`, [entityId]);
    expect(rows).toHaveLength(0);
  });

  it("RLS: tenant A cannot read tenant B's outbox rows via withTenants", async () => {
    const coB = await createCompany("Outbox Test Co B");
    const entityIdA = "00000000-0000-0000-0000-000000000003";
    const entityIdB = "00000000-0000-0000-0000-000000000004";

    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityIdA, "deliverable.approved", {}));
    await withTenants([coB], (c) => emitEvent(c, coB, "deliverable", entityIdB, "deliverable.approved", {}));

    // Query under company A's tenant context only — the RLS policy on outbox_events
    // (migration 0010_outbox_events.sql) should filter out company B's row entirely,
    // not just rely on the WHERE clause.
    const { rows } = await withTenants([co], (c) =>
      c.query<{ entity_id: string; tenant_id: string }>(
        `SELECT entity_id, tenant_id FROM outbox_events WHERE entity_id IN ($1, $2)`,
        [entityIdA, entityIdB],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(entityIdA);
    expect(rows[0].tenant_id).toBe(co);
  });
});
