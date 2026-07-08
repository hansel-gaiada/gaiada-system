// 5c.6 / D17: the custom-field registry endpoint the UI reads to render dynamic forms.
// Verifies define (admin/manager only), read (any member), duplicate guard, and that a
// defined field is then enforced by validateCustomFields on entity writes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("custom-field registry (D17)", () => {
  let app: NestFastifyApplication;
  let co: string, manager: string, member: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Creative House");
    manager = await createUser("mgr@cf.test");
    member = await createUser("mem@cf.test");
    await addMembership(co, manager);
    await addMembership(co, member);
    await grantRole(manager, await createRole("manager"), "company", co);
    await grantRole(member, await createRole("member"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("manager defines a select field; member can read it", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/custom-fields`, headers: asUser(manager),
      payload: { entityType: "project", key: "region", label: "Region", dataType: "select", options: ["bali", "jakarta"] },
    });
    expect(r.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/${co}/custom-fields?entityType=project`, headers: asUser(member) });
    const rows = list.json() as Array<{ key: string; data_type: string }>;
    expect(rows.find((f) => f.key === "region")?.data_type).toBe("select");
  });

  it("a member cannot define fields", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/custom-fields`, headers: asUser(member),
      payload: { entityType: "project", key: "secret", label: "Secret", dataType: "text" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("duplicate key for the same entity is rejected", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/custom-fields`, headers: asUser(manager),
      payload: { entityType: "project", key: "region", label: "Region 2", dataType: "text" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("the defined field is enforced on entity writes", async () => {
    const ok = await app.inject({
      method: "POST", url: `/api/${co}/projects`, headers: asUser(manager),
      payload: { name: "Bali Launch", customFields: { region: "bali" } },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await app.inject({
      method: "POST", url: `/api/${co}/projects`, headers: asUser(manager),
      payload: { name: "Paris Launch", customFields: { region: "paris" } },
    });
    expect(bad.statusCode).toBe(400);
  });
});
