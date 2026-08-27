// WS11 §4B — the meeting-to-delivery pipeline state surface, against live Postgres + RLS + Cerbos.
// A scoped automation account (as the dispatcher/delivery workflows would) creates runs, advances
// stages and opens gates; elevated humans read the inbox and decide; members are denied read/decide;
// dual-party scope sign-off emits scope.signed. Mirrors automation-approvals.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
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

  // E1 follow-up: this is what the hub's read-only `pipeline.runBySourceMeeting` tool fronts —
  // the dispatcher's dedupe branch resolves the authoritative pipeline_runs.source_meeting_id
  // link this way instead of via meeting_recordings.pipeline_run_id (circular, always null on a
  // timed-out first attempt). Same "read" action as above -- manager (the automation tier) is
  // already allowed; a plain member is still not.
  it("GET pipeline/runs?sourceMeetingId filters to the exact match (the dedupe-resolution read)", async () => {
    const hit = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?sourceMeetingId=mtg-001`, headers: asWorkflow("wf:mtg-dispatcher") });
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toHaveLength(1);
    expect(hit.json()[0]).toMatchObject({ id: runId, source_meeting_id: "mtg-001" });

    const miss = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?sourceMeetingId=mtg-does-not-exist`, headers: asWorkflow("wf:mtg-dispatcher") });
    expect(miss.statusCode).toBe(200);
    expect(miss.json()).toHaveLength(0);

    const denied = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?sourceMeetingId=mtg-001`, headers: asUser(member) });
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

  // The junk-party defect, found on a live server walk rather than by reading the code: `party` was
  // checked only for truthiness, so an arbitrary string was accepted and stored. The response then
  // read `complete:false` — indistinguishable from a correct "waiting on the other party" — while the
  // run could never complete, because the recorded party satisfies neither entry of
  // REQUIRED_SCOPE_PARTIES. The unique index is on (run_id, party), so the junk row also permanently
  // occupies a slot that the real party can no longer use under a different spelling.
  describe("scope sign-off: party is validated, not merely present", () => {
    it("refuses a party outside provider|client with a 400", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs/${runId}/scope-signoffs`,
        headers: asUser(admin),
        payload: { party: "agency", signerName: "Someone" },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/provider\|client/);
    });

    it("still accepts the two real parties, and only both together complete the run", async () => {
      // Its OWN run: the shared `runId` already carries sign-offs from earlier tests, so reusing it
      // would assert against whatever state those left behind rather than against this behaviour.
      const created = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asUser(admin),
        payload: { title: "party-validation run" },
      });
      expect(created.statusCode).toBe(201);
      const freshRun = created.json().id;

      const first = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs/${freshRun}/scope-signoffs`,
        headers: asUser(admin),
        payload: { party: "provider", signerName: "Agency PM" },
      });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ complete: false });

      const second = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs/${freshRun}/scope-signoffs`,
        headers: asUser(admin),
        payload: { party: "client", signerName: "Client Lead" },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json()).toMatchObject({ complete: true });
    });
  });

  // migration 0072 added pipeline_runs.owner_id and NOTHING could write it: createRun's body type
  // never accepted it and updateRun took only `status`, so in production it was permanently NULL and
  // every "notify the owner, else created_by" silently resolved to created_by. A column no code can
  // set is indistinguishable from a column that does not exist.
  describe("run owner: assignable, clearable, and staff-only", () => {
    it("createRun accepts an ownerId and stores it", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "owned run", ownerId: admin },
      });
      expect(r.statusCode).toBe(201);
      const row = await adminPool().query(`SELECT owner_id FROM pipeline_runs WHERE id = $1`, [r.json().id]);
      expect(row.rows[0].owner_id).toBe(admin);
    });

    it("PATCH assigns an owner, and an explicit null CLEARS it while omitting the key leaves it alone", async () => {
      const created = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin), payload: { title: "reassign" },
      });
      const id = created.json().id;

      await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${id}`, headers: asUser(admin), payload: { ownerId: admin } });
      let row = await adminPool().query(`SELECT owner_id FROM pipeline_runs WHERE id = $1`, [id]);
      expect(row.rows[0].owner_id).toBe(admin);

      // status-only update must NOT wipe the owner — the reason this is not a bare COALESCE.
      await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${id}`, headers: asUser(admin), payload: { status: "blocked" } });
      row = await adminPool().query(`SELECT owner_id, status FROM pipeline_runs WHERE id = $1`, [id]);
      expect(row.rows[0].owner_id).toBe(admin);
      expect(row.rows[0].status).toBe("blocked");

      // explicit null = unassign
      await app.inject({ method: "PATCH", url: `/api/${co}/pipeline/runs/${id}`, headers: asUser(admin), payload: { ownerId: null } });
      row = await adminPool().query(`SELECT owner_id FROM pipeline_runs WHERE id = $1`, [id]);
      expect(row.rows[0].owner_id).toBeNull();
    });

    it("refuses a CLIENT CONTACT as owner — owner_id is who INTERNAL notifications go to", async () => {
      // Accepting one here would quietly route internal-side messages to the client.
      const clientUser = await createUser("owner-must-not-be-client@client.test");
      const cl = await createClient(co, "Owner Guard Co");
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
           VALUES ($1, $2, $3, $4, 'signer', 'active', $5)`,
          [newId(), co, cl, clientUser, config.originSite],
        ),
      );
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "bad owner", ownerId: clientUser },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/staff member/i);
    });
  });

  // C1 — the list filters. Added because /pipeline previously fetched the 200-row cap and narrowed in
  // the browser, which stops being a filter the moment a tenant has more than 200 runs.
  describe("C1 list filters", () => {
    it("narrows by clientId, and excludes other clients' runs", () => {
      // The assertion that matters is the EXCLUSION: a filter that returns everything looks identical
      // to one that works when the fixture has few rows.
      return (async () => {
        const mine = await createClient(co, "Filter Target Co");
        const theirs = await createClient(co, "Filter Other Co");
        for (const [cl, title] of [[mine, "mine-1"], [mine, "mine-2"], [theirs, "theirs-1"]] as [string, string][]) {
          await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin), payload: { title, clientId: cl } });
        }
        const r = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?clientId=${mine}`, headers: asUser(admin) });
        expect(r.statusCode).toBe(200);
        const titles = r.json().map((x: { title: string }) => x.title);
        expect(titles).toContain("mine-1");
        expect(titles).toContain("mine-2");
        expect(titles).not.toContain("theirs-1");
      })();
    });

    it("a malformed clientId matches nothing instead of 500ing on a uuid cast", () => {
      // Compared as text on purpose: a hand-edited query string is a normal thing to receive, and an
      // invalid-uuid cast would fail the whole request rather than return an empty list.
      return (async () => {
        const r = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?clientId=not-a-uuid`, headers: asUser(admin) });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual([]);
      })();
    });

    it("narrows by projectId", () => {
      return (async () => {
        const cl = await createClient(co, "Proj Filter Co");
        const proj = await withTenants([co], (c) =>
          c.query<{ id: string }>(
            `INSERT INTO projects (id, tenant_id, name, status, origin_site) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
            [newId(), co, "Filterable Project", config.originSite],
          ),
        ).then((x) => x.rows[0].id);
        await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
          payload: { title: "in-project", clientId: cl, projectId: proj } });
        await app.inject({ method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
          payload: { title: "no-project", clientId: cl } });
        const r = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?projectId=${proj}`, headers: asUser(admin) });
        const titles = r.json().map((x: { title: string }) => x.title);
        expect(titles).toEqual(["in-project"]);
      })();
    });

    it("the LIST now returns client_id and project_id (C4/C6)", () => {
      // Their absence is why the UI cross-referenced the recordings registry for a client column and
      // why run->project navigation did not exist. Pinned so a future SELECT tidy-up cannot drop them.
      return (async () => {
        const r = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs`, headers: asUser(admin) });
        expect(r.statusCode).toBe(200);
        expect(r.json()[0]).toHaveProperty("client_id");
        expect(r.json()[0]).toHaveProperty("project_id");
      })();
    });
  });

  // WD-30. The gap these cover was found on the LIVE server, not here: every pipeline_run on
  // gda-aicenter had client_id NULL (5 of 5), because createRun has always accepted clientId while
  // the n8n extraction flow never sent one. `/portal/runs` filters by the caller's client ids, so a
  // correctly-invited, correctly-authorized contact still saw `[]` — the portal was structurally
  // blind for a reason no test asserted, since every existing test passes clientId explicitly or
  // never looks at it.
  describe("WD-30 run inherits client/project from its source meeting", () => {
    async function recording(meetingId: string, clientId: string | null, projectId: string | null, departmentId: string | null = null) {
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, client_id, project_id, department_id, title, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId(), co, meetingId, clientId, projectId, departmentId, "src", config.originSite],
        ),
      );
    }
    const runRow = (id: string) =>
      withTenants([co], (c) =>
        c.query<{ client_id: string | null; project_id: string | null; department_id: string | null }>(
          `SELECT client_id, project_id, department_id FROM pipeline_runs WHERE id = $1`,
          [id],
        ),
      ).then((r) => r.rows[0]);

    it("department lineage: fills department_id from the meeting, the caller's explicit value wins, and the list returns it", async () => {
      await recording("mtg-dept-1", null, null, "dept-web");
      const derived = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-dept-1", title: "no departmentId sent" },
      });
      expect(derived.statusCode).toBe(201);
      expect((await runRow(derived.json().id))?.department_id).toBe("dept-web");

      await recording("mtg-dept-2", null, null, "dept-web");
      const explicit = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-dept-2", departmentId: "dept-seo" },
      });
      expect((await runRow(explicit.json().id))?.department_id).toBe("dept-seo");

      const list = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs?sourceMeetingId=mtg-dept-1`, headers: asWorkflow("wf:mtg-dispatcher") });
      expect(list.json()[0]).toMatchObject({ department_id: "dept-web" });
      const detail = await app.inject({ method: "GET", url: `/api/${co}/pipeline/runs/${derived.json().id}`, headers: asWorkflow("wf:mtg-dispatcher") });
      expect(detail.json()).toMatchObject({ department_id: "dept-web" });
    });

    it("department lineage: falls back to the project's department when the meeting has none", async () => {
      const projectId = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO projects (id, tenant_id, name, department_id, origin_site) VALUES ($1, $2, $3, $4, $5)`,
          [projectId, co, "Dept-owned project", "dept-web", config.originSite],
        ),
      );
      await recording("mtg-dept-3", null, projectId, null);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-dept-3", title: "via project" },
      });
      expect(r.statusCode).toBe(201);
      expect((await runRow(r.json().id))?.department_id).toBe("dept-web");
    });

    it("fills client_id from the meeting when the caller omits it", async () => {
      const cl = await createClient(co, "Inheriting Co");
      await recording("mtg-inherit-1", cl, null);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-inherit-1", title: "no clientId sent" },
      });
      expect(r.statusCode).toBe(201);
      // Without the derivation this is null — which is exactly the live state that blinded the portal.
      expect((await runRow(r.json().id))?.client_id).toBe(cl);
    });

    it("an explicit clientId still WINS over the meeting's", async () => {
      // The derivation fills a gap; it must not override a caller that deliberately said otherwise.
      const fromMeeting = await createClient(co, "Meeting Co");
      const explicit = await createClient(co, "Explicit Co");
      await recording("mtg-inherit-2", fromMeeting, null);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-inherit-2", clientId: explicit },
      });
      expect(r.statusCode).toBe(201);
      expect((await runRow(r.json().id))?.client_id).toBe(explicit);
    });

    it("leaves client_id null when the meeting has none, and never invents one", async () => {
      await recording("mtg-inherit-3", null, null);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-inherit-3" },
      });
      expect(r.statusCode).toBe(201);
      const row = await runRow(r.json().id);
      expect(row?.client_id).toBeNull();
      expect(row?.project_id).toBeNull();
    });

    it("inherits project_id too — the link WD-06's single-project env var existed to work around", async () => {
      const cl = await createClient(co, "Proj Co");
      const proj = await withTenants([co], (c) =>
        c.query<{ id: string }>(
          `INSERT INTO projects (id, tenant_id, name, status, origin_site) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
          [newId(), co, "Inherited Project", config.originSite],
        ),
      ).then((r) => r.rows[0].id);
      await recording("mtg-inherit-4", cl, proj);
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"),
        payload: { sourceMeetingId: "mtg-inherit-4" },
      });
      expect(r.statusCode).toBe(201);
      expect(await runRow(r.json().id)).toMatchObject({ client_id: cl, project_id: proj });
    });

    it("a run with no sourceMeetingId is untouched (no meeting to inherit from)", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
        payload: { title: "standalone" },
      });
      expect(r.statusCode).toBe(201);
      expect((await runRow(r.json().id))?.client_id).toBeNull();
    });
  });
});
