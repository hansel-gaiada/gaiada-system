// WS4 §3 / D14 — the automation approvals suspension surface, against live Postgres + RLS + Cerbos.
// A scoped automation service account files a suspension (as the hub `approvals.request` tool would);
// an elevated human reads the pending inbox and decides; non-elevated members are denied read/decide.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

describe.skipIf(!TEST_URL)("automation approvals suspension surface (WS4 §3)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    await seedAutomationAccounts(co); // gives wf:new-client-seed a manager-role service principal
    admin = await createUser("admin@approvals.test");
    member = await createUser("member@approvals.test");
    await addMembership(co, admin);
    await addMembership(co, member);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("a scoped automation account files a pending suspension (as approvals.request would)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 100 }, impact: "medium", reason: "suspend: medium-impact write" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: "pending" });
  });

  it("an elevated human reads the pending inbox; a plain member cannot", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) });
    expect(ok.statusCode).toBe(200);
    const rows = ok.json() as Array<{ tool_name: string; status: string; impact: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ tool_name: "money.transfer", status: "pending", impact: "medium" });

    const denied = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(member) });
    expect(denied.statusCode).toBe(403);
  });

  it("company_admin approves it; a second decide is 404; a member may not decide", async () => {
    const id = ((await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as Array<{ id: string }>)[0].id;

    const memberTry = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(member), payload: { decision: "approved" } });
    expect(memberTry.statusCode).toBe(403);

    const decided = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin), payload: { decision: "approved" } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "approved" });

    const again = await app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${id}/decide`, headers: asUser(admin), payload: { decision: "rejected" } });
    expect(again.statusCode).toBe(404); // no longer pending

    // It leaves the default pending inbox once decided.
    const pending = (await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as unknown[];
    expect(pending).toHaveLength(0);
  });

  it("accepts an agent-origin suspension (WS8 Step B) and surfaces origin + agentName", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: asWorkflow("wf:new-client-seed"), // filed under the OBO principal (agent runs as a user in prod)
      payload: { workflowId: "task-triager", toolName: "tasks.update", toolArgs: { taskId: "t1", status: "done" }, impact: "high", reason: "high_write requires approval", origin: "agent", agentName: "task-triager" },
    });
    expect(created.statusCode).toBe(201);
    const rows = (await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(admin) })).json() as Array<{ origin: string; agent_name: string; tool_name: string }>;
    const agentRow = rows.find((r) => r.origin === "agent");
    expect(agentRow).toMatchObject({ origin: "agent", agent_name: "task-triager", tool_name: "tasks.update" });
  });

  it("rejects an invalid origin (400)", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "x", toolName: "y", origin: "bogus" } })).statusCode,
    ).toBe(400);
  });

  it("rejects a bad impact and a missing toolName (400)", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "wf:new-client-seed", toolName: "x", impact: "bogus" } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: `/api/${co}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"), payload: { workflowId: "wf:new-client-seed" } })).statusCode,
    ).toBe(400);
  });
});
