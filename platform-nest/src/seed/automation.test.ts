// WS4 §3: proves the automation service-account chain works end-to-end. Without a verified
// identity_link, an n8n OBO envelope resolves to ANONYMOUS and Cerbos denies everything; after
// seedAutomationAccounts, the same envelope becomes a real, least-privilege principal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "./automation";

describe.skipIf(!TEST_URL)("automation service accounts (WS4 §3)", () => {
  let app: NestFastifyApplication;
  let co: string;
  const svc = { authorization: "Bearer svc-token" };
  // An n8n workflow's OBO envelope — the exact headers the mcp-hub forwards.
  const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative"); // the name the seed looks up (id passed directly here)
    const created = await seedAutomationAccounts(co);
    expect(created).toBeGreaterThan(0);
    // Idempotent: a second run creates nothing.
    expect(await seedAutomationAccounts(co)).toBe(0);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("wf:new-client-seed (manager role) can create a project via its OBO envelope", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/projects`,
      headers: asWorkflow("wf:new-client-seed"), payload: { name: "Onboarding — Acme" },
    });
    expect(r.statusCode).toBe(201);
  });

  it("an UNSEEDED workflow id resolves to anonymous and is denied (proves the link is what grants access)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/projects`,
      headers: asWorkflow("wf:not-seeded"), payload: { name: "Nope" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("wf:stale-approval-chaser (manager role) is a real non-anonymous principal (can read projects)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${co}/projects`, headers: asWorkflow("wf:stale-approval-chaser"),
    });
    expect(r.statusCode).toBe(200);
  });

  it("wf:task-sla (member role) resolves to a real principal (can read tasks)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${co}/tasks`, headers: asWorkflow("wf:task-sla"),
    });
    expect(r.statusCode).toBe(200);
  });
});
