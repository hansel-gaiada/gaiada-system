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

  it("WD-05: wf:delivery can park a run 'blocked' (revise-budget escalation); cross-tenant denied; invalid status is 400", async () => {
    const bad = await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${runId}`, headers: asWorkflow("wf:delivery"), payload: { status: "bogus" } });
    expect(bad.statusCode).toBe(400);

    // Same posture as create/update elsewhere on this resource (Cerbos grants company_admin/
    // manager/member — the low-privilege automation posture); the isolation boundary that
    // matters is tenancy, exercised at the bottom of this file for the same run/company.
    const otherTenant = await app.inject({ method: "PATCH", url: `/api/${other}/pipeline/runs/${runId}`, headers: asUser(otherAdmin), payload: { status: "blocked" } });
    expect(otherTenant.statusCode).toBe(404);

    const r = await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${runId}`, headers: asWorkflow("wf:delivery"), payload: { status: "blocked" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: runId, status: "blocked" });

    const get = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${runId}`, headers: asUser(admin) });
    expect(get.json().status).toBe("blocked");

    const ev = await adminPool().query(`SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.run.updated'`, [runId]);
    expect(ev.rowCount).toBe(1);

    // Restore to 'extracting' so the remaining tests in this file (scope sign-off etc.) proceed normally.
    const restore = await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${runId}`, headers: asWorkflow("wf:delivery"), payload: { status: "extracting" } });
    expect(restore.statusCode).toBe(200);
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

  // WD-03 (D-3) — the artifact signature lock. Fresh run per test (own stage/gate) so these don't
  // disturb the shared `runId` fixture's state from earlier tests in this file.
  describe("WD-03: artifact signature lock (D-3)", () => {
    it("edit-before-sign persists (and is what a later read returns) — this is the feature; a non-elevated member is denied outright", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asWorkflow("wf:mtg-dispatcher"),
        payload: {
          sourceMeetingId: "mtg-wd03-edit",
          stages: [{ track: "delivery", name: "prd_extract", status: "done", artifactRef: "# Draft PRD v1", confidence: 0.8 }],
        },
      });
      expect(created.statusCode).toBe(201);
      const wdRunId = created.json().id;
      const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId}`, headers: asUser(admin) });
      const stageId = detail.json().stages[0].id;
      expect(detail.json().stages[0].status).toBe("done"); // already 'done' at extraction — proves 'done' alone can't be the lock trigger

      // A plain member is denied (Cerbos: pipeline_stage.update no longer grants "member" — WD-03).
      const memberTry = await app.inject({
        method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(member), payload: { artifactRef: "member forgery attempt" },
      });
      expect(memberTry.statusCode).toBe(403);

      // The elevated human edits BEFORE any client sign gate exists — the D-3 feature, even though
      // the stage is already 'done' (mirrors the real "Acme Coffee kickoff" run's exact shape).
      const edited = await app.inject({
        method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(admin), payload: { artifactRef: "# Draft PRD v2 — revised scope" },
      });
      expect(edited.statusCode).toBe(200);

      const afterEdit = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId}`, headers: asUser(admin) });
      expect(afterEdit.json().stages[0].artifact_ref).toBe("# Draft PRD v2 — revised scope");

      // Provenance: writeActivity + pipeline.stage.updated, specifically for this edit.
      const activity = await adminPool().query(
        `SELECT metadata FROM activities WHERE target_entity_type = 'pipeline_stage' AND target_entity_id = $1 AND verb = 'edited'`,
        [stageId],
      );
      expect(activity.rowCount).toBe(1);
      expect(activity.rows[0].metadata).toMatchObject({ artifactEdited: true });
      const events = await adminPool().query(
        `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'pipeline.stage.updated' AND (payload->>'artifactEdited')::boolean = true`,
        [stageId],
      );
      expect(events.rowCount).toBe(1);

      // Now open + decide the client PRD-sign gate for this stage's track (delivery), native route.
      const gate = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId: wdRunId, kind: "prd_sign", actorSide: "client" } });
      expect(gate.statusCode).toBe(201);
      const gateId = gate.json().id;
      const signed = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates/${gateId}/decide`, headers: asUser(admin), payload: { decision: "signed" } });
      expect(signed.statusCode).toBe(200);

      // Edit-after-signed is refused — even the SAME elevated caller who could edit a moment ago.
      const lockedTry = await app.inject({
        method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(admin), payload: { artifactRef: "forged after sign" },
      });
      expect(lockedTry.statusCode).toBe(409);

      // Status-only transitions (no artifactRef) are NOT locked — automation can still advance state.
      const statusOnly = await app.inject({
        method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asWorkflow("wf:delivery"), payload: { confidence: 0.95 },
      });
      expect(statusOnly.statusCode).toBe(200);

      // The record still holds exactly what was signed — not the forgery attempt.
      const finalRead = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId}`, headers: asUser(admin) });
      expect(finalRead.json().stages[0].artifact_ref).toBe("# Draft PRD v2 — revised scope");
    });

    it("the SAME 409 fires when the gate was decided via the generic approvals/:id/decide façade path — no bypass", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asWorkflow("wf:mtg-dispatcher"),
        payload: {
          sourceMeetingId: "mtg-wd03-facade",
          stages: [{ track: "scope", name: "scope_extract", status: "done", artifactRef: "## Scope v1", confidence: 0.85 }],
        },
      });
      expect(created.statusCode).toBe(201);
      const wdRunId2 = created.json().id;
      const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId2}`, headers: asUser(admin) });
      const stageId = detail.json().stages[0].id;

      // Editable before sign, exactly as the native-route test proves — sanity check on this fixture too.
      const preSign = await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(admin), payload: { artifactRef: "## Scope v2" } });
      expect(preSign.statusCode).toBe(200);

      const gate = await app.inject({ method: "POST", url: `/api/${co}/pipeline/gates`, headers: asWorkflow("wf:scope"), payload: { runId: wdRunId2, kind: "scope_signoff", actorSide: "client" } });
      expect(gate.statusCode).toBe(201);
      const gateId = gate.json().id;

      // Decide it through the GENERIC façade (POST /approvals/:id/decide, origin=pipeline) — NOT the
      // native /pipeline/gates/:id/decide route. Same underlying pipeline_gates row either way.
      const decide = await app.inject({
        method: "POST", url: `/api/${co}/approvals/${gateId}/decide`, headers: asUser(admin),
        payload: { origin: "pipeline", decision: "signed" },
      });
      expect(decide.statusCode).toBe(200);

      const lockedTry = await app.inject({
        method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(admin), payload: { artifactRef: "forged via the facade path" },
      });
      expect(lockedTry.statusCode).toBe(409);

      const finalRead = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId2}`, headers: asUser(admin) });
      expect(finalRead.json().stages[0].artifact_ref).toBe("## Scope v2");
    });

    it("the report track never locks (no client ever signs it) and stages with no client gate at all stay editable", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asWorkflow("wf:mtg-dispatcher"),
        payload: {
          sourceMeetingId: "mtg-wd03-report",
          stages: [{ track: "report", name: "report_extract", status: "done", artifactRef: "internal notes v1", confidence: 0.8 }],
        },
      });
      const wdRunId3 = created.json().id;
      const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${wdRunId3}`, headers: asUser(admin) });
      const stageId = detail.json().stages[0].id;
      const edited = await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/stages/${stageId}`, headers: asUser(admin), payload: { artifactRef: "internal notes v2" } });
      expect(edited.statusCode).toBe(200);
    });
  });
});
