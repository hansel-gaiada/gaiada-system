// 5c.7: first-deploy readiness e2e — the agency's daily flow end to end through the real
// API (auth → Cerbos → RLS → activity/notifications → rollups), proving the vertical is
// genuinely operable at first deploy, not a set of isolated units. One tenant, the full
// role spread, and the path a real day takes: client → project → campaign → brief → asset →
// review/approve → deliverable → assign → log time → comment/mention → attach file →
// management rollups.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "./config";
import { buildApp } from "./main";
import { agencyModule } from "./modules/agency";
import { registerModule, resetModules } from "./modules/registry";
import {
  recomputeRollups, syncMetricDefinitions, registerCoreRollupProvider, resetCoreRollupProviders, coreTaskRollups,
} from "./rollups/engine";
import { clientWorkRollups } from "./core/client-work";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "./testing/fixtures";

const PERIOD = "2026-07-05";

describe.skipIf(!TEST_URL)("agency first-deploy daily flow (e2e)", () => {
  let app: NestFastifyApplication;
  let co: string;
  const u: Record<string, string> = {};
  const svc = { authorization: "Bearer svc-token" };
  const as = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);
    registerCoreRollupProvider(coreTaskRollups);
    registerCoreRollupProvider(clientWorkRollups);
    await syncMetricDefinitions();

    co = await createCompany("Gaiada Creative", ["agency"]);
    u.admin = await createUser("owner@gc.test", "Ayu");
    u.pm = await createUser("pm@gc.test", "Budi");
    u.designer = await createUser("design@gc.test", "Citra");
    u.approver = await createUser("lead@gc.test", "Eka");
    u.exec = await createUser("exec@gc.test", "Exec");
    for (const id of [u.admin, u.pm, u.designer, u.approver]) await addMembership(co, id);
    await grantRole(u.admin, await createRole("company_admin"), "company", co);
    await grantRole(u.pm, await createRole("manager"), "company", co);
    await grantRole(u.designer, await createRole("member"), "company", co);
    await grantRole(u.approver, await createRole("member"), "company", co);
    await grantRole(u.approver, await createRole("agency_approver"), "company", co);
    await grantRole(u.exec, await createRole("group_executive"), "global", null);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("runs the whole day: client → campaign → review → deliverable → time → rollups", async () => {
    const post = (uid: string, url: string, payload?: object): Promise<LightMyRequestResponse> =>
      app.inject({ method: "POST", url: `/api/${co}${url}`, headers: as(uid), payload });
    const patch = (uid: string, url: string, payload: object): Promise<LightMyRequestResponse> =>
      app.inject({ method: "PATCH", url: `/api/${co}${url}`, headers: as(uid), payload });
    const get = (uid: string, url: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: "GET", url: `/api/${co}${url}`, headers: as(uid) });

    // 1. Admin onboards a client; PM opens a client-linked project.
    const client = await post(u.admin, "/clients", { name: "Bali Beach Resort", contact: { email: "gm@bbr.test" } });
    expect(client.statusCode).toBe(201);
    const clientId = client.json().id;
    const project = await post(u.pm, "/projects", { name: "Q3 Rebrand", clientId });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id;

    // 2. PM runs a campaign; designer files a brief and a creative asset.
    const campaign = await post(u.pm, "/modules/agency/campaigns", { name: "Rebrand Launch", projectId });
    expect(campaign.statusCode).toBe(201);
    const campaignId = campaign.json().id;
    expect((await post(u.designer, `/modules/agency/campaigns/${campaignId}/briefs`, { title: "Hero brief", body: "coastal luxury" })).statusCode).toBe(201);
    const asset = await post(u.designer, `/modules/agency/campaigns/${campaignId}/assets`, { name: "Hero banner", kind: "design" });
    expect(asset.statusCode).toBe(201);
    const assetId = asset.json().id;

    // 3. Designer submits for review; client lead approves → asset approved + designer notified.
    const submit = await post(u.designer, `/modules/agency/assets/${assetId}/submit`);
    expect(submit.statusCode).toBe(201);
    const decide = await post(u.approver, `/modules/agency/approvals/${submit.json().approvalId}/decide`, { decision: "approved" });
    expect(decide.statusCode).toBe(200);
    const assets = await get(u.pm, `/modules/agency/campaigns/${campaignId}/assets`);
    expect((assets.json() as Array<{ id: string; review_status: string }>).find((a) => a.id === assetId)?.review_status).toBe("approved");

    // 4. PM plans a deliverable due this week; assigns a task to the designer (notifies them).
    expect((await post(u.pm, "/deliverables", { projectId, clientId, name: "Brand guidelines", dueDate: "2026-07-07" })).statusCode).toBe(201);
    const task = await post(u.pm, `/projects/${projectId}/tasks`, { title: "Design hero banner" });
    expect(task.statusCode).toBe(201);
    const taskId = task.json().id;
    expect((await patch(u.pm, `/tasks/${taskId}`, { assigneeId: u.designer, status: "in_progress" })).statusCode).toBe(200);

    // 5. Designer logs billable time and the PM comments, mentioning the designer.
    expect((await post(u.designer, "/time-entries", { projectId, taskId, minutes: 180, billable: true, entryDate: PERIOD })).statusCode).toBe(201);
    expect((await post(u.pm, "/comments", { entityType: "task", entityId: taskId, body: "Looks great @Citra", mentions: [u.designer] })).statusCode).toBe(201);

    // 6. Designer attaches a spec file with PII — stored scrubbed.
    const upload = await post(u.designer, "/files", {
      targetType: "agency_campaign", targetId: campaignId, filename: "client-brief.txt", contentType: "text/plain",
      content: Buffer.from("Client contact NIK 3273123456789012, gm@bbr.test").toString("base64"),
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().scrubbed).toBe(true);

    // 7. Designer's inbox has the assignment + mention + approval-decided notifications.
    const notifs = (await get(u.designer, "/notifications?unread=true")).json() as Array<{ type: string }>;
    const types = new Set(notifs.map((n) => n.type));
    expect(types.has("assignment")).toBe(true);
    expect(types.has("mention")).toBe(true);
    expect(types.has("approval_decided")).toBe(true);

    // 8. Management view: recompute this tenant, exec reads the cross-company rollups.
    await recomputeRollups(co, PERIOD);
    const rollups = (await app.inject({ method: "GET", url: `/api/rollups?period=${PERIOD}`, headers: as(u.exec) })).json() as
      Array<{ metric_key: string; numerator: string; denominator: string | null }>;
    const val = (k: string) => Number(rollups.find((r) => r.metric_key === k)?.numerator);
    expect(val("agency.campaigns.active")).toBeGreaterThanOrEqual(1);
    expect(val("agency.approvals.pending")).toBe(0); // the only approval was decided
    expect(val("agency.deliverables.due_week")).toBeGreaterThanOrEqual(1);
    expect(val("core.time.billable_minutes")).toBe(180);
    const util = rollups.find((r) => r.metric_key === "agency.utilization");
    expect(Number(util?.numerator)).toBe(180);
    expect(Number(util?.denominator)).toBe(4 * 8 * 60); // 4 members × 8h
  });
});
