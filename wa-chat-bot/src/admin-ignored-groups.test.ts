// PUT /admin/groups/ignored (1a): auth (401/503), full-replace validation, and the
// groupsSnapshot() reflection (discovered excludes ignored; ignored lists them).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { buildApp } from "./server";
import { config } from "./config";
import { resetRegistryCache, noteDiscovered } from "./groups";

const gw = { sendText: async () => {} };
const DIR = "data/test-admin-ignored-groups";
const FILE = `${DIR}/groups.yaml`;

describe("PUT /admin/groups/ignored", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.groupsFile = FILE;
    config.groupsSeedFile = "";
    resetRegistryCache();
  });

  afterEach(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "PUT", url: "/admin/groups/ignored", payload: { ids: [] } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer whatever" },
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("rejects a non-array body with a field-level 400", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer sekret" },
      payload: { ids: "not-an-array" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string };
    expect(body.field).toBe("ids");
    await app.close();
  });

  it("rejects a bad group id with a field-level 400 (same shape as PUT /admin/groups)", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer sekret" },
      payload: { ids: ["not-a-group-id"] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string };
    expect(body.error).toMatch(/invalid group id/i);
    expect(body.field).toBe("ids[0]");
    await app.close();
  });

  it("full-replace persists and is reflected by GET /admin/groups (discovered excludes ignored)", async () => {
    noteDiscovered("111@g.us", "Keep");
    noteDiscovered("222@g.us", "Drop");

    const app = buildApp(gw as any);
    const put = await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer sekret" },
      payload: { ids: ["222@g.us"] },
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json() as { discovered: Array<{ id: string }>; ignored: Array<{ id: string }> };
    expect(putBody.discovered.map((g) => g.id)).toEqual(["111@g.us"]);
    expect(putBody.ignored.map((g) => g.id)).toEqual(["222@g.us"]);

    const get = await app.inject({ method: "GET", url: "/admin/groups", headers: { authorization: "Bearer sekret" } });
    expect(get.json()).toEqual(putBody);
    await app.close();
  });

  it("un-ignoring is a full-replace omitting the id", async () => {
    const app = buildApp(gw as any);
    await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer sekret" },
      payload: { ids: ["111@g.us", "222@g.us"] },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups/ignored",
      headers: { authorization: "Bearer sekret" },
      payload: { ids: ["222@g.us"] },
    });
    const body = res.json() as { ignored: Array<{ id: string }> };
    expect(body.ignored.map((g) => g.id)).toEqual(["222@g.us"]);
    await app.close();
  });
});
