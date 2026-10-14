// Files §4: reference-attach mode (no binary) + entityType/entityId aliases. Against live PG+RLS+Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
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

  // DW-6i: the reference write was extracted into core/file-reference.ts so Google Drive's attach shares it. This pins what POST /files
  // still does through it: the day-one scrub of the name AND the link, the 2048 cap on the link, the response shape, and the
  // `attached` activity row (with no extra keys: Drive's source/driveFileId keys appear only on Drive's own rows).
  it("still scrubs the name and the link, caps the link, answers { id, scrubbed, byteSize } and writes the plain `attached` activity", async () => {
    const longTail = "x".repeat(3000);
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/files`, headers: asUser(user),
      payload: { targetType: "project", targetId: projectId, filename: "Report for jo@x.test (2026).pdf", url: `https://drive.example/b?card=4111111111111111&t=${longTail}` },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; scrubbed: boolean; byteSize: number };
    expect(Object.keys(body).sort()).toEqual(["byteSize", "id", "scrubbed"]);
    expect(body).toMatchObject({ scrubbed: false, byteSize: 0 });

    const row = (await adminPool().query(`SELECT filename, url, byte_size, storage_key, scrubbed FROM files WHERE id = $1`, [body.id])).rows[0];
    expect(row.filename).toBe("Report for [REDACTED-EMAIL] (2026).pdf");
    expect(row.url.startsWith("https://drive.example/b?card=[REDACTED-PAN]&t=xxx")).toBe(true);
    expect(row.url.length).toBe(2048);
    expect(row).toMatchObject({ byte_size: "0", storage_key: null, scrubbed: false });

    const act = (await adminPool().query(
      `SELECT actor_id, verb, target_entity_type, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND verb = 'attached' AND metadata->>'fileId' = $2`,
      [tenant, body.id],
    )).rows;
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ actor_id: user, target_entity_type: "project", target_entity_id: projectId });
    expect(Object.keys(act[0].metadata).filter((k) => k !== "via").sort()).toEqual(["fileId", "filename"]);
    expect(act[0].metadata.filename).toBe("Report for [REDACTED-EMAIL] (2026).pdf");
  });
});
