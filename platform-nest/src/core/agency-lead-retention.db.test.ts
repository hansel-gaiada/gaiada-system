// M5-G5 — the agency-lead retention purge against REAL Postgres (migration 202610121835 + the pipeline's
// append-only stage history and its `app.lead_purge` hatch, 202610111425). Every write runs as
// `platform_app_test` (NOSUPERUSER NOBYPASSRLS), so the purge is proven to set the tenant GUC per tenant
// (otherwise it would delete nothing and report success). `adminPool()` (superuser) only READS evidence.
//
// Needs DATABASE_URL_TEST: the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { runLeadRetentionPurge } from "./agency-lead-retention";

const NOW = new Date("2026-10-12T00:00:00Z");
const OLD = "2024-08-01T00:00:00Z"; // > 24 months before NOW
const RECENT = "2026-01-01T00:00:00Z"; // < 24 months before NOW

describe.skipIf(!TEST_URL)("M5-G5 — retention purge of unconverted agency leads", () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    await initTestDb();
    a = await createCompany("Retention Agency A");
    b = await createCompany("Retention Agency B");
  }, 60000);
  afterAll(async () => {
    await teardownTestDb();
  });

  async function insertLead(tenant: string, f: { status: string; stage: string; clock: string; clientId?: string | null; reason?: string | null }) {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, source, status, stage, declined_reason,
                                   converted_client_id, origin_site, created_at, updated_at, status_changed_at, attribution, visitor_consent)
         VALUES ($1, $2, 'Old Org', 'Old Person', $3, 'web', $4, $5, $6, $7, 'test', $8, $8, $8,
                 '{"gclid":"g"}'::jsonb, '{"marketing":true}'::jsonb)`,
        [id, tenant, `p-${id}@retention.test`, f.status, f.stage, f.reason ?? null, f.clientId ?? null, f.clock],
      ),
    );
    return id;
  }
  async function addChildren(tenant: string, leadId: string, at: string) {
    const tok = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO agency_intake_tokens (id, tenant_id, lead_id, kind, token_hash, expires_at, used_at, origin_site, created_at)
         VALUES ($1, $2, $3, 'invite', $4, $5::timestamptz + interval '30 days', $5, 'test', $5)`,
        [tok, tenant, leadId, createHash("sha256").update(randomBytes(32)).digest(), at],
      );
      await c.query(
        `INSERT INTO agency_discovery_submissions (id, tenant_id, lead_id, token_id, schema_version, answers, origin_site, created_at)
         VALUES ($1, $2, $3, $4, 'v1', '{"contact_name":"Old Person"}'::jsonb, 'test', $5)`,
        [newId(), tenant, leadId, tok, at],
      );
      await c.query(
        `INSERT INTO agency_lead_stage_events (id, tenant_id, lead_id, from_stage, to_stage, occurred_at, origin_site)
         VALUES ($1, $2, $3, 'enquiry', 'contacted', $4, 'test')`,
        [newId(), tenant, leadId, at],
      );
    });
  }
  const exists = async (table: string, col: string, id: string) =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n;

  it("the append-only history still refuses a delete WITHOUT the hatch (and a lead with history cannot be deleted)", async () => {
    const id = await insertLead(a, { status: "declined", stage: "lost", clock: OLD, reason: "r" });
    await addChildren(a, id, OLD);
    await expect(
      withTenants([a], (c) => c.query(`DELETE FROM agency_lead_stage_events WHERE lead_id = $1`, [id])),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTenants([a], async (c) => {
        await c.query(`DELETE FROM agency_discovery_submissions WHERE lead_id = $1`, [id]);
        await c.query(`DELETE FROM agency_intake_tokens WHERE lead_id = $1`, [id]);
        await c.query(`DELETE FROM agency_leads WHERE id = $1`, [id]);
      }),
    ).rejects.toThrow(/append-only/);
    expect(await exists("agency_leads", "id", id)).toBe(1);
  });

  it("purges due unconverted leads with their AD-1 submissions, tokens and history, in every tenant; keeps everything else", async () => {
    const clientA = await createClient(a, "Converted Client");
    const dueDeclined = await insertLead(a, { status: "declined", stage: "lost", clock: OLD, reason: "no budget" });
    await addChildren(a, dueDeclined, OLD);
    const dueNew = await insertLead(a, { status: "new", stage: "enquiry", clock: OLD });
    const dueB = await insertLead(b, { status: "nurturing", stage: "qualified", clock: OLD });
    await addChildren(b, dueB, OLD);
    const keptConverted = await insertLead(a, { status: "converted", stage: "won", clock: OLD, clientId: clientA });
    const keptRecent = await insertLead(a, { status: "declined", stage: "lost", clock: RECENT, reason: "later" });
    // Old clock, but a submission arrived after the cutoff (a late AD-1 to a declined lead does not move status).
    const keptActive = await insertLead(a, { status: "declined", stage: "lost", clock: OLD, reason: "late" });
    await addChildren(a, keptActive, RECENT);

    const r = await runLeadRetentionPurge(NOW, { months: 24, batch: 2 }); // batch 2: proves the per-tenant batching loop
    expect(r.errors).toBe(0);
    expect(r.totals.leads).toBeGreaterThanOrEqual(3);

    for (const id of [dueDeclined, dueNew, dueB]) {
      expect(await exists("agency_leads", "id", id), id).toBe(0);
      expect(await exists("agency_discovery_submissions", "lead_id", id)).toBe(0);
      expect(await exists("agency_intake_tokens", "lead_id", id)).toBe(0);
      expect(await exists("agency_lead_stage_events", "lead_id", id)).toBe(0);
    }
    for (const id of [keptConverted, keptRecent, keptActive]) expect(await exists("agency_leads", "id", id), id).toBe(1);
    expect(await exists("agency_discovery_submissions", "lead_id", keptActive)).toBe(1);
    expect(await exists("clients", "id", clientA)).toBe(1);

    // Evidence rows, per tenant, counts only.
    const runs = (await adminPool().query<{ tenant_id: string; leads: number; months: number }>(
      `SELECT tenant_id, sum(leads_deleted)::int AS leads, max(retention_months) AS months FROM agency_lead_retention_runs GROUP BY tenant_id`,
    )).rows;
    expect(runs.find((x) => x.tenant_id === b)).toMatchObject({ leads: 1, months: 24 });
    expect(runs.find((x) => x.tenant_id === a)!.leads).toBeGreaterThanOrEqual(2);

    // The hatch did not leak: a fresh transaction is refused again.
    const survivor = await insertLead(a, { status: "declined", stage: "lost", clock: RECENT, reason: "x" });
    await addChildren(a, survivor, RECENT);
    await expect(
      withTenants([a], (c) => c.query(`DELETE FROM agency_lead_stage_events WHERE lead_id = $1`, [survivor])),
    ).rejects.toThrow(/append-only/);

    // A second run finds nothing more.
    const again = await runLeadRetentionPurge(NOW, { months: 24, batch: 2 });
    expect(again.totals.leads).toBe(0);
  });

  it("the retention window is configurable: 36 months keeps a 26-month-old lead that 24 would purge", async () => {
    const id = await insertLead(b, { status: "declined", stage: "lost", clock: OLD, reason: "r" });
    await runLeadRetentionPurge(NOW, { months: 36, batch: 50 });
    expect(await exists("agency_leads", "id", id)).toBe(1);
    await runLeadRetentionPurge(NOW, { months: 24, batch: 50 });
    expect(await exists("agency_leads", "id", id)).toBe(0);
  });

  it("the clock moves on a status or stage change and on nothing else", async () => {
    const id = await insertLead(a, { status: "new", stage: "enquiry", clock: OLD });
    const clock = async () => (await adminPool().query<{ t: Date }>(`SELECT status_changed_at AS t FROM agency_leads WHERE id = $1`, [id])).rows[0].t;
    await withTenants([a], (c) => c.query(`UPDATE agency_leads SET org_name = 'Renamed', updated_at = now() WHERE id = $1`, [id]));
    expect((await clock()).toISOString()).toBe(new Date(OLD).toISOString());
    await withTenants([a], (c) => c.query(`UPDATE agency_leads SET stage = 'contacted' WHERE id = $1`, [id]));
    expect((await clock()).getTime()).toBeGreaterThan(new Date(RECENT).getTime());
    await withTenants([a], (c) => c.query(`UPDATE agency_leads SET status_changed_at = $2 WHERE id = $1`, [id, OLD]));
    await withTenants([a], (c) => c.query(`UPDATE agency_leads SET status = 'nurturing' WHERE id = $1`, [id]));
    expect((await clock()).getTime()).toBeGreaterThan(new Date(RECENT).getTime());
  });
});
