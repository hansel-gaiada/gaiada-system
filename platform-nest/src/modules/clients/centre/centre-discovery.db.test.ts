// PV6-04 (CC-D6) — discovery answers fill the Business profile: the conversion step and the two staff
// routes, against real Postgres + Cerbos (skips without DATABASE_URL_TEST — check the skip count).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { buildApp } from "../../../main";
import { resetModules } from "../../registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { newId, withTenants } from "../../../db";
import { convertAgencyLead } from "../../../core/agency-lead-convert.service";
import { fillProfileFromAnswers } from "./centre-discovery.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ANSWERS = {
  org_name: "Discovery Org Ltd",
  current_url: "https://discovery.example",
  platform: "Webflow",
  languages: ["English", "Bahasa Indonesia"],
  market: "Indonesia",
  dns_owner: "password: hunter2 held by the registrar", // secret-looking: must be refused
  vis_minimal_expressive: 3, // project-brief slider: never mapped
};

describe.skipIf(!TEST_URL)("PV6-04 · discovery fills the Business profile", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coNoAgency: string;
  let admin: string;
  let viewer: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    co = await createCompany("Discovery Fill Co", ["clients", "agency"]);
    coNoAgency = await createCompany("Discovery No Agency Co", ["clients"]);
    admin = await createUser("discovery-admin@a.test");
    viewer = await createUser("discovery-viewer@a.test");
    for (const c of [co, coNoAgency]) {
      await addMembership(c, admin);
      await addMembership(c, viewer);
      await grantRole(admin, await createRole("company_admin"), "company", c);
      await grantRole(viewer, await createRole("viewer"), "company", c);
    }
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  async function newLead(tenant: string, answers: Record<string, unknown> | null): Promise<string> {
    const id = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage, owner_id, origin_site)
         VALUES ($1, $2, $3, 'Prospect Contact', $4, '+62-811-000-000', 'invite', 'submitted', 'enquiry', $5, 'test')`,
        [id, tenant, `Discovery Lead ${++seq}`, `${id}@prospect.test`, admin],
      );
      if (answers) {
        await c.query(
          `INSERT INTO agency_discovery_submissions
             (id, tenant_id, lead_id, schema_version, answers, meta, answered_count, required_answered, required_total, origin_site)
           VALUES ($1, $2, $3, 'v1', $4, '{}'::jsonb, 1, 1, 1, 'test')`,
          [newId(), tenant, id, JSON.stringify(answers)],
        );
      }
    });
    return id;
  }

  /** A client converted before PV6-04: the link exists, the profile was never filled. */
  async function legacyConvertedClient(tenant: string, answers: Record<string, unknown> | null): Promise<string> {
    const clientId = await createClient(tenant, `Legacy Client ${++seq}`);
    const leadId = await newLead(tenant, answers);
    await withTenants([tenant], (c) =>
      c.query(`UPDATE agency_leads SET status = 'converted', stage = 'won', converted_client_id = $2 WHERE id = $1`, [leadId, clientId]),
    );
    return clientId;
  }

  const profileOf = async (tenant: string, clientId: string) =>
    (await withTenants([tenant], (c) =>
      c.query<{ profile: Record<string, string> }>(`SELECT profile FROM client_centre_profiles WHERE client_id = $1`, [clientId]),
    )).rows[0]?.profile ?? null;
  const activitiesOf = async (tenant: string, clientId: string) =>
    (await withTenants([tenant], (c) =>
      c.query<{ metadata: { via: string; changes: Array<{ path: string }>; skipped: Array<{ key: string; reason: string }> } }>(
        `SELECT metadata FROM activities WHERE target_entity_type = 'client' AND target_entity_id = $1 AND metadata->>'via' = 'discovery'`,
        [clientId],
      ),
    )).rows;

  it("conversion fills the new client's empty keys, names a refused secret, and logs one discovery activity", async () => {
    const leadId = await newLead(co, ANSWERS);
    const out = await convertAgencyLead({ tenantId: co, leadId, actorUserId: admin, delegations: [] });
    expect(out.outcome).toBe("converted");
    const clientId = (out as { clientId: string }).clientId;

    const profile = await profileOf(co, clientId);
    expect(profile).toMatchObject({
      legal: "Discovery Org Ltd", website: "https://discovery.example", cms: "Webflow",
      languages: "English, Bahasa Indonesia", markets: "Indonesia",
    });
    expect(profile?.domains).toBeUndefined(); // the secret-looking answer
    expect(profile?.platform).toBeUndefined(); // the false friend never lands on the e-commerce key

    const acts = await activitiesOf(co, clientId);
    expect(acts).toHaveLength(1);
    expect(acts[0].metadata.changes.map((c) => c.path)).toContain("profile.cms");
    expect(acts[0].metadata.skipped).toEqual([{ key: "domains", reason: "looks like a credential" }]);
  });

  it("a lead with no submission converts and writes no profile row and no activity", async () => {
    const leadId = await newLead(co, null);
    const out = await convertAgencyLead({ tenantId: co, leadId, actorUserId: admin, delegations: [] });
    const clientId = (out as { clientId: string }).clientId;
    expect(await profileOf(co, clientId)).toBeNull();
    expect(await activitiesOf(co, clientId)).toHaveLength(0);
  });

  it("the fill never overwrites a filled key (service level)", async () => {
    const clientId = await createClient(co, "Prefilled Client");
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_centre_profiles (id, tenant_id, client_id, business_type, profile, revision, origin_site)
         VALUES ($1, $2, $3, 'other', $4, 1, 'test')`,
        [newId(), co, clientId, JSON.stringify({ legal: "Hand Typed Legal Name" })],
      ),
    );
    const res = await withTenants([co], (c) => fillProfileFromAnswers(c, { tenantId: co, clientId, actorId: admin, answers: ANSWERS }));
    expect(res.filled).not.toContain("legal");
    expect(res.skipped).toContainEqual({ key: "legal", reason: "already filled" });
    const profile = await profileOf(co, clientId);
    expect(profile?.legal).toBe("Hand Typed Legal Name");
    expect(profile?.cms).toBe("Webflow");
  });

  it("preview and fill for a client converted before PV6-04; the second run fills nothing", async () => {
    const clientId = await legacyConvertedClient(co, ANSWERS);

    const preview = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/centre/discovery`, headers: asUser(admin) });
    expect(preview.statusCode).toBe(200);
    const pv = preview.json() as { available: boolean; fillable: string[] };
    expect(pv.available).toBe(true);
    expect(pv.fillable).toEqual(expect.arrayContaining(["legal", "website", "cms", "languages"]));
    expect(pv.fillable).not.toContain("domains");

    const run1 = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/centre/fill-from-discovery`, headers: asUser(admin) });
    expect(run1.statusCode).toBe(201);
    const r1 = run1.json() as { filled: string[]; skipped: Array<{ key: string; reason: string }> };
    expect([...r1.filled].sort()).toEqual([...pv.fillable].sort()); // preview and fill share one planner
    expect(r1.skipped).toContainEqual({ key: "domains", reason: "looks like a credential" });

    const run2 = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/centre/fill-from-discovery`, headers: asUser(admin) });
    expect(run2.json().filled).toEqual([]);
    expect(await activitiesOf(co, clientId)).toHaveLength(1); // the idempotent run logged nothing new

    const after = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/centre/discovery`, headers: asUser(admin) });
    expect(after.json()).toEqual({ available: true, fillable: [] });
  });

  it("a viewer is refused 403 on the fill and nothing is written", async () => {
    const clientId = await legacyConvertedClient(co, ANSWERS);
    const r = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/centre/fill-from-discovery`, headers: asUser(viewer) });
    expect(r.statusCode).toBe(403);
    expect(await profileOf(co, clientId)).toBeNull();
    // ...but a viewer may read the preview (client read).
    const p = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/centre/discovery`, headers: asUser(viewer) });
    expect(p.statusCode).toBe(200);
  });

  it("a viewer's 403 comes before the 404 for a missing client (authorization first)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/clients/00000000-0000-0000-0000-000000000000/centre/fill-from-discovery`, headers: asUser(viewer),
    });
    expect(r.statusCode).toBe(403);
  });

  it("a client with no converted lead: preview says unavailable, the fill is a 404", async () => {
    const clientId = await createClient(coNoAgency, "Never Converted");
    const p = await app.inject({ method: "GET", url: `/api/${coNoAgency}/clients/${clientId}/centre/discovery`, headers: asUser(admin) });
    expect(p.json()).toEqual({ available: false, fillable: [] });
    const f = await app.inject({ method: "POST", url: `/api/${coNoAgency}/clients/${clientId}/centre/fill-from-discovery`, headers: asUser(admin) });
    expect(f.statusCode).toBe(404);
  });

  it("a converted lead whose submission is missing is also a 404", async () => {
    const clientId = await legacyConvertedClient(co, null);
    const f = await app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/centre/fill-from-discovery`, headers: asUser(admin) });
    expect(f.statusCode).toBe(404);
  });
});
