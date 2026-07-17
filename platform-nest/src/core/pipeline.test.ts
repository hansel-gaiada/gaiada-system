// WS11 §4B — the meeting-to-delivery pipeline state surface, against live Postgres + RLS + Cerbos.
// A scoped automation account (as the dispatcher/delivery workflows would) creates runs, advances
// stages and opens gates; elevated humans read the inbox and decide; members are denied read/decide;
// dual-party scope sign-off emits scope.signed. Mirrors automation-approvals.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

describe.skipIf(!TEST_URL)("meeting-to-delivery pipeline surface (WS11 §4B)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let admin: string;
  let member: string;
  let otherAdmin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    await seedAutomationAccounts(co); // gives wf:mtg-dispatcher / wf:delivery / wf:scope a manager principal
    admin = await createUser("admin@pipeline.test");
    member = await createUser("member@pipeline.test");
    otherAdmin = await createUser("admin@rival.test");
    await addMembership(co, admin);
    await addMembership(co, member);
    await addMembership(other, otherAdmin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", other);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let runId: string;

  it("the dispatcher creates a run with initial stages (as wf:mtg-dispatcher)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/runs`,
      headers: asWorkflow("wf:mtg-dispatcher"),
      payload: {
        sourceMeetingId: "mtg-001",
        title: "Acme kickoff",
        momRef: "s3://mom/mtg-001",
        stages: [
          { track: "delivery", name: "prd_extract" },
          { track: "report", name: "report_extract" },
          { track: "scope", name: "scope_extract" },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ deduped: false });
    runId = r.json().id;
    expect(runId).toBeTruthy();
  });

  it("the dispatcher can populate stage artifacts + confidence in the create call", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/runs`,
      headers: asWorkflow("wf:mtg-dispatcher"),
      payload: {
        sourceMeetingId: "mtg-artifacts",
        stages: [{ track: "delivery", name: "prd_extract", status: "done", artifactRef: "# PRD...", confidence: 0.9 }],
      },
    });
    expect(r.statusCode).toBe(201);
    const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${r.json().id}`, headers: asUser(admin) });
    const stage = detail.json().stages[0];
    expect(stage).toMatchObject({ name: "prd_extract", status: "done", artifact_ref: "# PRD..." });
    expect(Number(stage.confidence)).toBe(0.9);
  });

  it("re-delivery of the same meeting id dedupes to the same run", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/runs`,
      headers: asWorkflow("wf:mtg-dispatcher"),
      payload: { sourceMeetingId: "mtg-001", title: "Acme kickoff (retry)" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id: runId, deduped: true });
  });

  it("emitted pipeline.run.created to the outbox (the durable resume path)", async () => {
    const rows = await adminPool().query(
      `SELECT event_type FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.run.created'`,
      [runId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("an elevated human reads the run + stages; a plain member cannot", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${runId}`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().stages).toHaveLength(3);

    const denied = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);
  });

  it("the workflow advances a stage and it emits pipeline.stage.updated", async () => {
    const stageId = (await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${runId}`, headers: asUser(admin) }))
      .json().stages.find((s: { name: string }) => s.name === "prd_extract").id;
    const r = await app.inject({
      method: "PATCH",
      url: `/api/${co}/pipeline/stages/${stageId}`,
      headers: asWorkflow("wf:delivery"),
      payload: { status: "done", artifactRef: "s3://prd/mtg-001", confidence: 0.82 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "done" });
    const ev = await adminPool().query(
      `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.stage.updated'`,
      [stageId],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("opens the PRD-sign client gate; member cannot decide, admin signs, second decide is 404", async () => {
    const opened = await app.inject({
      method: "POST",
      url: `/api/${co}/pipeline/gates`,
      headers: asWorkflow("wf:delivery"),
      payload: { runId, kind: "prd_sign", actorSide: "client" },
    });
    expect(opened.statusCode).toBe(201);
    const gateId = opened.json().id;

    const memberTry = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates/${gateId}/decide`, headers: asUser(member), payload: { decision: "signed" } });
    expect(memberTry.statusCode).toBe(403);

    const signed = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates/${gateId}/decide`, headers: asUser(admin), payload: { decision: "signed" } });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ decision: "signed", status: "decided" });

    const again = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates/${gateId}/decide`, headers: asUser(admin), payload: { decision: "approved" } });
    expect(again.statusCode).toBe(404);

    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.gate.decided'`, [gateId]);
    expect(ev.rowCount).toBe(1);
  });

  it("the pending gate inbox filters by actorSide", async () => {
    // Open one more internal gate; the signed client gate should no longer be pending.
    await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId, kind: "pm_review", actorSide: "internal" } });
    const internal = await app.inject({ method: "GET", url: `/api/${co}/pipeline/gates?actorSide=internal`, headers: asUser(admin) });
    expect(internal.statusCode).toBe(200);
    expect(internal.json().every((g: { actor_side: string; status: string }) => g.actor_side === "internal" && g.status === "pending")).toBe(true);
    const client = await app.inject({ method: "GET", url: `/api/${co}/pipeline/gates?actorSide=client`, headers: asUser(admin) });
    expect(client.json()).toHaveLength(0); // the only client gate was signed
  });

  it("dual-party scope sign-off completes and emits scope.signed", async () => {
    const first = await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider", signerName: "Gaiada" } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ complete: false });

    const second = await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`, headers: asUser(admin), payload: { party: "client", signerName: "Acme Inc" } });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ complete: true });

    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'scope.signed'`, [runId]);
    expect(ev.rowCount).toBe(1);
  });

  it("a re-filed party signature is idempotent (no error, stays complete)", async () => {
    const dup = await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`, headers: asUser(admin), payload: { party: "provider", signerName: "Gaiada again" } });
    expect(dup.statusCode).toBe(201);
    expect(dup.json()).toMatchObject({ complete: true });
    const rows = await adminPool().query(`SELECT count(*)::int AS n FROM scope_signoffs WHERE run_id = $1 AND party = 'provider'`, [runId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("tenant isolation: a rival-company admin cannot see the run", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${other}/pipeline/runs`, headers: asUser(otherAdmin) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(0);
    // Cross-tenant read of a known id is filtered by RLS -> not found.
    const cross = await app.inject({ method: "GET", url: `/api/${other}/pipeline/runs/${runId}`, headers: asUser(otherAdmin) });
    expect(cross.statusCode).toBe(404);
  });

  it("rejects invalid gate kind / actorSide / decision / stage track (400)", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId, kind: "bogus", actorSide: "client" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId, kind: "prd_sign", actorSide: "sideways" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs/${runId}/stages`, headers: asWorkflow("wf:delivery"), payload: { track: "nope", name: "x" } })).statusCode).toBe(400);
  });
});
