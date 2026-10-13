// PV6-04 — a failing profile prefill must never block a lead conversion (savepoint guard).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership } from "../../../testing/fixtures";
import { newId, withTenants } from "../../../db";
import { convertAgencyLead } from "../../../core/agency-lead-convert.service";

// Make the fill fail AFTER it has written the profile row: its own event is the only thing that throws.
vi.mock("../../../events/outbox.service", async (orig) => {
  const real = await orig<typeof import("../../../events/outbox.service")>();
  return {
    ...real,
    emitEvent: (async (...a: Parameters<typeof real.emitEvent>) => {
      if (a[4] === "client.centre_updated") throw new Error("forced discovery-fill failure");
      return real.emitEvent(...a);
    }) as typeof real.emitEvent,
  };
});

describe.skipIf(!TEST_URL)("PV6-04 · a failing discovery fill does not block the conversion", () => {
  let co: string;
  let admin: string;
  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Discovery Safe Co", ["clients", "agency"]);
    admin = await createUser("discovery-safe@a.test");
    await addMembership(co, admin);
  }, 120_000);
  afterAll(async () => { await teardownTestDb(); });

  it("conversion commits (client, project, run, lead update) and leaves no profile row when the fill throws", async () => {
    const leadId = newId();
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, owner_id, origin_site)
         VALUES ($1, $2, 'Safe Lead', 'Prospect Contact', $3, '+62-811-000-000', 'invite', 'submitted', 'enquiry', $4, 'test')`,
        [leadId, co, `${leadId}@prospect.test`, admin],
      );
      await c.query(
        `INSERT INTO agency_discovery_submissions (id, tenant_id, lead_id, schema_version, answers, meta, answered_count, required_answered, required_total, origin_site)
         VALUES ($1, $2, $3, 'v1', $4, '{}'::jsonb, 1, 1, 1, 'test')`,
        [newId(), co, leadId, JSON.stringify({ org_name: "Safe Org Ltd", platform: "Webflow" })],
      );
    });
    const out = await convertAgencyLead({ tenantId: co, leadId, actorUserId: admin, delegations: [] });
    expect(out.outcome).toBe("converted");
    const { clientId, projectId, runId } = out as { clientId: string; projectId: string; runId: string };

    const rows = await withTenants([co], async (c) => ({
      client: (await c.query(`SELECT 1 FROM clients WHERE id = $1`, [clientId])).rowCount,
      project: (await c.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId])).rowCount,
      run: (await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1`, [runId])).rowCount,
      lead: (await c.query<{ status: string; converted_client_id: string }>(`SELECT status, converted_client_id FROM agency_leads WHERE id = $1`, [leadId])).rows[0],
      profile: (await c.query(`SELECT 1 FROM client_centre_profiles WHERE client_id = $1`, [clientId])).rowCount,
      activity: (await c.query(`SELECT 1 FROM activities WHERE target_entity_id = $1 AND metadata->>'via' = 'discovery'`, [clientId])).rowCount,
    }));
    expect(rows.client).toBe(1);
    expect(rows.project).toBe(1);
    expect(rows.run).toBe(1);
    expect(rows.lead).toMatchObject({ status: "converted", converted_client_id: clientId });
    expect(rows.profile).toBe(0); // rolled back to the savepoint, not half-written
    expect(rows.activity).toBe(0);
  });
});
