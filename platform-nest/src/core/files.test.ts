// 5c.4: files / attachments. Verifies base64 upload, day-one PII scrub on text (never
// stored in the clear), binary round-trip, tenant/role gating, list-by-target, and delete.
// Uses an in-memory storage backend so the suite never touches disk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { setStorageForTest } from "./storage";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";

const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("files / attachments", () => {
  let app: NestFastifyApplication;
  let co: string, member: string, viewer: string, projectId: string;
  let textFileId: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });

    co = await createCompany("Creative House");
    member = await createUser("mem@f.test");
    viewer = await createUser("view@f.test");
    await addMembership(co, member);
    await addMembership(co, viewer);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    projectId = await createProject(co, "Rebrand");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("scrubs PII from a text upload before storing", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/files`, headers: asUser(member),
      payload: {
        targetType: "project", targetId: projectId, filename: "notes.txt", contentType: "text/plain",
        content: b64("Client NIK 3273123456789012, email ops@acme.test — do not leak"),
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().scrubbed).toBe(true);
    textFileId = r.json().id;
    const content = await app.inject({
      method: "GET", url: `/api/${co}/files/${textFileId}/content`, headers: asUser(member),
    });
    expect(content.body).toContain("REDACTED");
    expect(content.body).not.toContain("3273123456789012");
    expect(content.body).not.toContain("ops@acme.test");
  });

  it("stores binary content unchanged (not scrubbed)", async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const r = await app.inject({
      method: "POST", url: `/api/${co}/files`, headers: asUser(member),
      payload: {
        targetType: "project", targetId: projectId, filename: "logo.bin",
        contentType: "application/octet-stream", content: bin.toString("base64"),
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().scrubbed).toBe(false);
    const content = await app.inject({
      method: "GET", url: `/api/${co}/files/${r.json().id}/content`, headers: asUser(member),
    });
    expect(Buffer.compare(content.rawPayload, bin)).toBe(0);
  });

  it("lists files by target and a viewer can read them", async () => {
    const list = await app.inject({
      method: "GET", url: `/api/${co}/files?entityType=project&entityId=${projectId}`, headers: asUser(viewer),
    });
    expect((list.json() as Array<unknown>).length).toBe(2);
  });

  it("a viewer cannot upload (read-only role)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/files`, headers: asUser(viewer),
      payload: { targetType: "project", targetId: projectId, filename: "x.txt", contentType: "text/plain", content: b64("hi") },
    });
    expect(r.statusCode).toBe(403);
  });

  it("delete soft-deletes and removes the bytes from storage", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/${co}/files/${textFileId}`, headers: asUser(member) });
    expect(del.statusCode).toBe(200);
    expect(mem.has(`${co}/${textFileId}`)).toBe(false);
    const list = await app.inject({
      method: "GET", url: `/api/${co}/files?entityType=project&entityId=${projectId}`, headers: asUser(member),
    });
    expect((list.json() as Array<{ id: string }>).some((f) => f.id === textFileId)).toBe(false);
  });
});
