// WS11 build item 4 — client portal BFF, against live Postgres + RLS + Cerbos. A client (external
// `client` role, linked to a clients row via portal_user_id) sees only THEIR runs + a plain-language
// blockage, signs their client-side gates, and cannot touch another client's run or an internal gate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("client portal BFF (WS11 item 4)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;      // agency staff (company_admin) — creates runs + gates
  let member: string;     // plain staff — NOT a portal client
  let portalA: string;    // client A's portal login
  let portalB: string;    // client B's portal login
  let clientA: string;
  let runA: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    admin = await createUser("admin@portal.test");
    member = await createUser("member@portal.test");
    portalA = await createUser("clientA@acme.test");
    portalB = await createUser("clientB@rival.test");
    for (const u of [admin, member, portalA, portalB]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    const clientRole = await createRole("client");
    await grantRole(portalA, clientRole, "company", co);
    await grantRole(portalB, clientRole, "company", co);
    clientA = await createClient(co, "Acme Inc", portalA);
    await createClient(co, "Rival Ltd", portalB);
    app = await buildApp();

    // Staff creates client A's run with a client-side PRD-sign gate + a client scope gate.
    runA = (await app.inject({
      method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
      payload: { title: "Acme site", clientId: clientA, stages: [{ track: "delivery", name: "prd_extract", status: "done" }, { track: "report", name: "report_extract", status: "done" }] },
    })).json().id;
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let prdGate: string;

  it("opens a client-side PRD-sign gate (staff)", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin), payload: { runId: runA, kind: "prd_sign", actorSide: "client" } });
    expect(r.statusCode).toBe(201);
    prdGate = r.json().id;
  });

  it("client A sees only their run, with a plain-language blockage", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(portalA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
    expect(r.json()[0]).toMatchObject({ id: runA, title: "Acme site" });
    expect(r.json()[0].currentBlockage).toMatch(/signature on the PRD/i);
  });

  it("the portal run detail hides the internal report track + internal gates", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs/${runA}`, headers: asUser(portalA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().stages.every((s: { track: string }) => s.track !== "report")).toBe(true);
    expect(r.json().gates.every((g: { kind: string }) => g.kind === "prd_sign")).toBe(true);
  });

  it("client B cannot see client A's run (isolation)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(portalB) });
    expect(list.json()).toHaveLength(0);
    const detail = await app.inject({ method: "GET", url: `/api/${co}/portal/runs/${runA}`, headers: asUser(portalB) });
    expect(detail.statusCode).toBe(404);
  });

  it("a non-client staff member is denied the portal (no client role)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(member) });
    expect(r.statusCode).toBe(403);
  });

  it("client A signs the PRD gate through the portal; it emits gate.decided", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${co}/portal/gates/${prdGate}/decide`, headers: asUser(portalA), payload: { decision: "signed" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ decision: "signed" });
    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.gate.decided'`, [prdGate]);
    expect(ev.rowCount).toBe(1);
  });

  it("client B cannot decide client A's gate", async () => {
    // Re-open a fresh client gate on A's run, then B tries to decide it.
    const g = (await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin), payload: { runId: runA, kind: "customer_feedback", actorSide: "client" } })).json().id;
    const bTry = await app.inject({ method: "POST", url: `/api/${co}/portal/gates/${g}/decide`, headers: asUser(portalB), payload: { decision: "approved" } });
    expect(bTry.statusCode).toBe(404); // not yours
  });

  it("client A cannot decide an INTERNAL gate via the portal", async () => {
    const internal = (await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin), payload: { runId: runA, kind: "pm_review", actorSide: "internal" } })).json().id;
    const t = await app.inject({ method: "POST", url: `/api/${co}/portal/gates/${internal}/decide`, headers: asUser(portalA), payload: { decision: "approved" } });
    expect(t.statusCode).toBe(404); // client-side gates only
  });

  it("dual-party scope sign-off completes when client signs via portal + provider via staff", async () => {
    const scopeGate = (await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asUser(admin), payload: { runId: runA, kind: "scope_signoff", actorSide: "client" } })).json().id;
    // Provider signs (staff), then the client signs via the portal -> both -> scope.signed.
    await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${runA}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider", signerName: "Gaiada" } });
    const clientSign = await app.inject({ method: "POST", url: `/api/${co}/portal/runs/${runA}/scope-sign`, headers: asUser(portalA), payload: { signerName: "Acme Inc", gateId: scopeGate } });
    expect(clientSign.statusCode).toBe(201);
    expect(clientSign.json()).toMatchObject({ party: "client", complete: true });
    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'scope.signed'`, [runA]);
    expect(ev.rowCount).toBe(1);
  });
});
