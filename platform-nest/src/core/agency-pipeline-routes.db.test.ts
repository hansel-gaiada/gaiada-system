// M5-P1-c — the lead-pipeline routes, driven over HTTP (app.inject) against REAL Postgres and REAL Cerbos.
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §6 and the P1-c row of §9.
//
// Roles (resource_agency_lead.yaml, unchanged by P1): viewer = read; member = read + update; manager =
// + triage; company_admin = + convert. Every denial below sends a VALID body (a valid stage, a valid
// deal), so a validation 400 can never stand in for the 403 being asserted.
//
// Needs DATABASE_URL_TEST (+ CERBOS_URL, REDIS_URL_TEST): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("M5-P1-c — pipeline routes: authz per action, cross-company, typed reasons", () => {
  let app: NestFastifyApplication;
  let co: string; // tenant A
  let coB: string; // tenant B
  let viewer: string;
  let member: string;
  let manager: string;
  let admin: string;
  let adminB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Pipeline Routes A");
    coB = await createCompany("Pipeline Routes B");
    const mk = async (email: string, role: string, tenant: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    viewer = await mk("viewer@pipeline-routes.test", "viewer", co);
    member = await mk("member@pipeline-routes.test", "member", co);
    manager = await mk("manager@pipeline-routes.test", "manager", co);
    admin = await mk("admin@pipeline-routes.test", "company_admin", co);
    adminB = await mk("admin-b@pipeline-routes.test", "company_admin", coB);
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let seq = 0;
  async function newLead(tenant = co, status = "in_review"): Promise<string> {
    const id = newId();
    const n = ++seq;
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, source, status, stage, owner_id, origin_site)
         VALUES ($1, $2, $3, 'Route Prospect', $4, 'staff', $5, 'enquiry', $6, 'test')`,
        [id, tenant, `Route Org ${n}`, `route${n}@pipeline-routes.test`, status, tenant === co ? admin : adminB],
      ),
    );
    return id;
  }
  const post = (tenant: string, user: string, path: string, payload?: unknown) =>
    app.inject({ method: "POST", url: `/api/${tenant}/agency/${path}`, headers: asUser(user), payload: payload as never });
  const get = (tenant: string, user: string, path: string) =>
    app.inject({ method: "GET", url: `/api/${tenant}/agency/${path}`, headers: asUser(user) });
  const stageOf = async (id: string) =>
    (await adminPool().query<{ stage: string; deal_value: string | null }>(`SELECT stage, deal_value::text AS deal_value FROM agency_leads WHERE id = $1`, [id])).rows[0];
  const DEAL = { value: "15000000", currency: "IDR" };

  // ── authorization per action ───────────────────────────────────────────────────────────────
  it("a viewer reads everything and writes nothing: a move, a move with a deal, and a value are all 403 with valid bodies", async () => {
    const id = await newLead();
    for (const path of [`leads/${id}`, `leads/${id}/stage-history`, "pipeline/reference", "leads"]) {
      expect((await get(co, viewer, path)).statusCode, path).toBe(200);
    }
    expect((await post(co, viewer, `leads/${id}/stage`, { stage: "contacted" })).statusCode).toBe(403);
    expect((await post(co, viewer, `leads/${id}/stage`, { stage: "contacted", deal: DEAL })).statusCode).toBe(403);
    expect((await post(co, viewer, `leads/${id}/deal`, DEAL)).statusCode).toBe(403);
    expect(await stageOf(id)).toEqual({ stage: "enquiry", deal_value: null });
  });

  it("a member is refused a move (with or without a deal) but MAY set the value", async () => {
    const id = await newLead();
    expect((await post(co, member, `leads/${id}/stage`, { stage: "contacted" })).statusCode).toBe(403);
    expect((await post(co, member, `leads/${id}/stage`, { stage: "contacted", deal: DEAL })).statusCode).toBe(403);
    expect(await stageOf(id)).toEqual({ stage: "enquiry", deal_value: null });
    const r = await post(co, member, `leads/${id}/deal`, DEAL);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id, changed: true, dealValue: "15000000.0000", dealCurrency: "IDR" });
    expect((await stageOf(id)).deal_value).toBe("15000000.0000");
  });

  it("a manager may move, with a deal too; the response has the documented shape", async () => {
    const id = await newLead();
    const a = await post(co, manager, `leads/${id}/stage`, { stage: "qualified" });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ id, stage: "qualified", changed: true });
    expect(typeof a.json().stageEventId).toBe("string");
    const b = await post(co, manager, `leads/${id}/stage`, { stage: "proposal", deal: { value: "10.25", currency: "USD" } });
    expect(b.statusCode).toBe(200);
    expect(await stageOf(id)).toEqual({ stage: "proposal", deal_value: "10.2500" });
    const again = await post(co, manager, `leads/${id}/stage`, { stage: "proposal" });
    expect(again.json()).toEqual({ id, stage: "proposal", changed: false });
  });

  it("a manager is refused Convert (with a valid deal); a company_admin converts with a deal and the lead is won", async () => {
    const id = await newLead();
    expect((await post(co, manager, `leads/${id}/convert`, { deal: DEAL })).statusCode).toBe(403);
    expect(await stageOf(id)).toEqual({ stage: "enquiry", deal_value: null });
    const r = await post(co, admin, `leads/${id}/convert`, { delegations: [], deal: DEAL });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "converted", dealValue: "15000000.0000", dealCurrency: "IDR" });
    expect(await stageOf(id)).toEqual({ stage: "won", deal_value: "15000000.0000" });
  });

  it("a manager may decline from any open status (lost); the viewer may not", async () => {
    const id = await newLead(co, "new");
    expect((await post(co, viewer, `leads/${id}/decline`, { reason: "not a fit" })).statusCode).toBe(403);
    expect((await post(co, manager, `leads/${id}/decline`, { reason: "not a fit" })).statusCode).toBe(200);
    expect((await stageOf(id)).stage).toBe("lost");
  });

  // ── cross-company: 403 and 404 stay distinct ──────────────────────────────────────────────
  it("another company's admin is 403 on this tenant's path, and 404 (RLS) when naming this lead on THEIR own path; nothing changes", async () => {
    const id = await newLead();
    // wrong tenant in the path: not a member of A, so Cerbos refuses
    expect((await post(co, adminB, `leads/${id}/stage`, { stage: "contacted" })).statusCode).toBe(403);
    expect((await post(co, adminB, `leads/${id}/deal`, DEAL)).statusCode).toBe(403);
    expect((await post(co, adminB, `leads/${id}/convert`, { deal: DEAL })).statusCode).toBe(403);
    expect((await get(co, adminB, `leads/${id}/stage-history`)).statusCode).toBe(403);
    // own tenant in the path, A's lead id: authorized there, but the row is invisible
    expect((await post(coB, adminB, `leads/${id}/stage`, { stage: "contacted" })).statusCode).toBe(404);
    expect((await post(coB, adminB, `leads/${id}/deal`, DEAL)).statusCode).toBe(404);
    expect((await get(coB, adminB, `leads/${id}/stage-history`)).statusCode).toBe(404);
    expect(await stageOf(id)).toEqual({ stage: "enquiry", deal_value: null });
  });

  // ── typed reasons ──────────────────────────────────────────────────────────────────────────
  it("every typed refusal reaches the caller as `reason`", async () => {
    const id = await newLead();
    const reason = async (p: Promise<{ statusCode: number; json: () => { reason?: string } }>) => {
      const r = await p;
      return { status: r.statusCode, reason: r.json().reason };
    };
    const st = (body: unknown) => post(co, manager, `leads/${id}/stage`, body);
    const dl = (body: unknown) => post(co, manager, `leads/${id}/deal`, body);
    expect(await reason(st({ stage: "negotiation" }))).toEqual({ status: 400, reason: "stage_unknown" });
    expect(await reason(st({ stage: "won" }))).toEqual({ status: 400, reason: "stage_terminal" });
    expect(await reason(st({ stage: "lost" }))).toEqual({ status: 400, reason: "stage_terminal" });
    expect(await reason(dl({ value: "5" }))).toEqual({ status: 400, reason: "deal_incomplete" });
    expect(await reason(dl({ value: "-5", currency: "USD" }))).toEqual({ status: 400, reason: "deal_value_invalid" });
    expect(await reason(dl({ value: "5", currency: "XXX" }))).toEqual({ status: 400, reason: "deal_currency_unknown" });
    expect(await reason(dl({ value: "1500.5", currency: "IDR" }))).toEqual({ status: 400, reason: "deal_value_precision" });
    expect(await reason(dl({ value: "10.255", currency: "USD" }))).toEqual({ status: 400, reason: "deal_value_precision" });
    expect(await stageOf(id)).toEqual({ stage: "enquiry", deal_value: null });

    const closed = await newLead();
    expect((await post(co, admin, `leads/${closed}/convert`, { delegations: [] })).statusCode).toBe(200);
    expect(await reason(post(co, manager, `leads/${closed}/stage`, { stage: "contacted" }))).toEqual({ status: 409, reason: "lead_closed" });
  });

  it("an invalid deal on a convert is a typed 400 and nothing is spawned", async () => {
    const id = await newLead();
    const r = await post(co, admin, `leads/${id}/convert`, { delegations: [], deal: { value: "1500.5", currency: "IDR" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().reason).toBe("deal_value_precision");
    expect((await stageOf(id)).stage).toBe("enquiry");
  });

  // ── reads ──────────────────────────────────────────────────────────────────────────────────
  it("list and detail carry stage, dealValue (a string), dealCurrency and stageEnteredAt; the queue order is untouched", async () => {
    const id = await newLead();
    await post(co, manager, `leads/${id}/stage`, { stage: "contacted", deal: DEAL });
    const detail = (await get(co, viewer, `leads/${id}`)).json();
    expect(detail).toMatchObject({ id, stage: "contacted", dealValue: "15000000.0000", dealCurrency: "IDR" });
    const hist = (await get(co, viewer, `leads/${id}/stage-history`)).json() as { occurredAt: string }[];
    expect(new Date(detail.stageEnteredAt).getTime()).toBe(new Date(hist[0].occurredAt).getTime());
    const list = (await get(co, viewer, "leads")).json() as Record<string, unknown>[];
    const row = list.find((l) => l.id === id)!;
    expect(row).toMatchObject({ stage: "contacted", dealValue: "15000000.0000", dealCurrency: "IDR" });
    expect(typeof row.stageEnteredAt).toBe("string");
    // a lead never moved: stageEnteredAt falls back to created_at
    const fresh = await newLead();
    const f = ((await get(co, viewer, "leads")).json() as Record<string, unknown>[]).find((l) => l.id === fresh)!;
    expect(new Date(f.stageEnteredAt as string).getTime()).toBe(new Date(f.createdAt as string).getTime());
    // queue order mirrors queueRank: submitted(0) < new(1) < invited(2) < the rest(3)
    const ranks = list.map((l) => ({ submitted: 0, new: 1, invited: 2 } as Record<string, number>)[l.status as string] ?? 3);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("stage history is newest first and names the actor; no personal data in a row", async () => {
    const id = await newLead();
    for (const s of ["contacted", "qualified", "proposal"]) {
      expect((await post(co, manager, `leads/${id}/stage`, { stage: s })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 15));
    }
    const rows = (await get(co, viewer, `leads/${id}/stage-history`)).json() as Record<string, unknown>[];
    expect(rows.map((r) => `${r.fromStage}>${r.toStage}`)).toEqual(["qualified>proposal", "contacted>qualified", "enquiry>contacted"]);
    expect(rows[0]).toMatchObject({ actorId: manager, viaAgent: null });
    expect(Object.keys(rows[0]).sort()).toEqual(["actorId", "actorName", "dealCurrency", "dealValue", "fromStage", "id", "occurredAt", "toStage", "viaAgent"]);
    expect(JSON.stringify(rows)).not.toContain("pipeline-routes.test");
  });

  it("reference returns the six stages in order and the active currencies with their minor units", async () => {
    const r = (await get(co, viewer, "pipeline/reference")).json() as {
      stages: { key: string; position: number; kind: string; label: string }[];
      currencies: { code: string; symbol: string | null; minorUnit: number }[];
    };
    expect(r.stages.map((s) => s.key)).toEqual(["enquiry", "contacted", "qualified", "proposal", "won", "lost"]);
    expect(r.stages.map((s) => s.kind)).toEqual(["open", "open", "open", "open", "won", "lost"]);
    expect(r.stages.map((s) => s.position)).toEqual([...r.stages.map((s) => s.position)].sort((a, b) => a - b));
    const by = new Map(r.currencies.map((c) => [c.code, c.minorUnit]));
    expect(by.get("IDR")).toBe(0);
    expect(by.get("USD")).toBe(2);
    expect(r.currencies.map((c) => c.code)).toEqual([...r.currencies.map((c) => c.code)].sort());
  });

  it("a value edit is audited in activities (hand-off 2) and the staff create names no org (hand-off 4)", async () => {
    const id = await newLead();
    await post(co, member, `leads/${id}/deal`, DEAL);
    const a = await adminPool().query(`SELECT verb AS action, metadata FROM activities WHERE target_entity_id = $1`, [id]);
    expect(a.rows.map((x) => x.action)).toEqual(["deal_set"]);
    expect(a.rows[0].metadata).toMatchObject({ dealCurrency: "IDR" });

    const orgName = "Sole Trader Unique Name";
    const c = await post(co, admin, "leads", { orgName, contactEmail: "sole@pipeline-routes.test" });
    expect(c.statusCode).toBe(201);
    const created = await adminPool().query(`SELECT metadata::text AS m FROM activities WHERE target_entity_id = $1`, [c.json().id]);
    expect(created.rows[0].m).not.toContain(orgName);
  });
});
