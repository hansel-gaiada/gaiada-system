// Files §4: reference-attach mode (no binary) + entityType/entityId aliases. Against live PG+RLS+Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("files: reference attach (§4)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let user: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency"]);
    user = await createUser("u@a.test");
    await addMembership(tenant, user);
    await grantRole(user, await createRole("manager"), "company", tenant);
    projectId = await createProject(tenant, "Proj", user);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("attaches a reference (filename + url, no binary) using entityType/entityId aliases", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/files`, headers: asUser(user),
      payload: { entityType: "project", entityId: projectId, filename: "brief.pdf", url: "https://drive.example/brief" },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; byteSize: number };
    expect(body.byteSize).toBe(0);

    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/files?entityType=project&entityId=${projectId}`, headers: asUser(user) })).json() as Array<{ id: string; filename: string }>;
    expect(list.find((f) => f.id === body.id)?.filename).toBe("brief.pdf");

    // No stored blob → content download 404s cleanly.
    const dl = await app.inject({ method: "GET", url: `/api/${tenant}/files/${body.id}/content`, headers: asUser(user) });
    expect(dl.statusCode).toBe(404);
  });
});
