// A2: /admin/groups and /admin/config route tests — auth (401/503), full-replace
// validation surfaced as field-level 400s, GET shape, and the safe-fields-only PUT
// /admin/config contract (design doc §2.3).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { buildApp } from "./server";
import { config } from "./config";
import { resetRegistryCache } from "./groups";
import { resetPostToGroups } from "./safety/post-toggle";

const gw = { sendText: async () => {} };
const DIR = "data/test-admin-groups";
const FILE = `${DIR}/groups.yaml`;

const ROUTES: Array<["GET" | "PUT", string]> = [
  ["GET", "/admin/groups"],
  ["PUT", "/admin/groups"],
  ["GET", "/admin/config"],
  ["PUT", "/admin/config"],
];

describe("admin groups + config routes", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    config.adminToken = "sekret";
    config.groupsFile = FILE;
    config.groupsSeedFile = "";
    config.managementGroupId = "envmgmt@g.us";
    resetRegistryCache();
    resetPostToGroups();
  });

  afterEach(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("401s every route without the admin token", async () => {
    const app = buildApp(gw as any);
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it("503s every route when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    for (const [method, url] of ROUTES) {
      const res = await app.inject({ method, url, headers: { authorization: "Bearer whatever" } });
      expect(res.statusCode).toBe(503);
    }
    await app.close();
  });

  it("GET /admin/groups: inactive-registry snapshot shape", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/groups", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      registryActive: false,
      groups: [],
      discovered: [],
      managementGroupId: "envmgmt@g.us",
    });
    await app.close();
  });

  it("PUT /admin/groups: full-replace with a bad group id returns 400 + field error", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups",
      headers: { authorization: "Bearer sekret" },
      payload: { groups: [{ id: "not-a-group", name: "Bad" }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string };
    expect(body.error).toMatch(/invalid group id/i);
    expect(body.field).toBe("groups[0].id");
    await app.close();
  });

  it("PUT /admin/groups: two management groups returns 400 + field error", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/groups",
      headers: { authorization: "Bearer sekret" },
      payload: {
        groups: [
          { id: "1@g.us", name: "A", isManagement: true },
          { id: "2@g.us", name: "B", isManagement: true },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; field?: string };
    expect(body.error).toMatch(/at most one/i);
    expect(body.field).toBe("groups");
    await app.close();
  });

  it("PUT /admin/groups: valid full-replace persists, is reflected by GET, and hot-reloads", async () => {
    const app = buildApp(gw as any);
    const put = await app.inject({
      method: "PUT",
      url: "/admin/groups",
      headers: { authorization: "Bearer sekret" },
      payload: {
        groups: [
          { id: "111@g.us", name: "Site A", category: "construction", optIn: true },
          { id: "999@g.us", name: "Mgmt", isManagement: true },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json() as { registryActive: boolean; groups: unknown[]; managementGroupId: string };
    expect(putBody.registryActive).toBe(true);
    expect(putBody.managementGroupId).toBe("999@g.us");

    const get = await app.inject({ method: "GET", url: "/admin/groups", headers: { authorization: "Bearer sekret" } });
    expect(get.json()).toEqual(putBody);
    await app.close();
  });

  it("GET /admin/config: safe fields snapshot (ro + editable)", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/config", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const fields = (res.json() as { fields: Array<{ key: string; editable: boolean; value: unknown }> }).fields;
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.wahaSession?.editable).toBe(false);
    expect(byKey.botName?.editable).toBe(false);
    expect(byKey.monitoredCount?.editable).toBe(false);
    expect(byKey.postToGroups?.editable).toBe(true);
    expect(byKey.managementGroupId?.editable).toBe(true);
    expect(byKey.managementGroupId?.value).toBe("envmgmt@g.us");
    await app.close();
  });

  it("PUT /admin/config: only postToGroups/managementGroupId are writable; postToGroups flips the toggle", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: "Bearer sekret" },
      payload: { postToGroups: true },
    });
    expect(res.statusCode).toBe(200);
    const fields = (res.json() as { fields: Array<{ key: string; value: unknown }> }).fields;
    expect(fields.find((f) => f.key === "postToGroups")?.value).toBe(true);
    await app.close();
  });

  it("PUT /admin/config: managementGroupId rewrites the registry (adds a minimal entry when unknown)", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: "Bearer sekret" },
      payload: { managementGroupId: "555@g.us" },
    });
    expect(res.statusCode).toBe(200);
    const fields = (res.json() as { fields: Array<{ key: string; value: unknown }> }).fields;
    expect(fields.find((f) => f.key === "managementGroupId")?.value).toBe("555@g.us");

    const groupsRes = await app.inject({ method: "GET", url: "/admin/groups", headers: { authorization: "Bearer sekret" } });
    const groupsBody = groupsRes.json() as { groups: Array<{ id: string; isManagement: boolean }> };
    expect(groupsBody.groups.find((g) => g.id === "555@g.us")).toMatchObject({ isManagement: true });
    await app.close();
  });

  it("PUT /admin/config: rejects a non-string managementGroupId with a field error", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: "Bearer sekret" },
      payload: { managementGroupId: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { field?: string }).field).toBe("managementGroupId");
    await app.close();
  });

  it("PUT /admin/config: rejects a non-boolean postToGroups with a field error", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({
      method: "PUT",
      url: "/admin/config",
      headers: { authorization: "Bearer sekret" },
      payload: { postToGroups: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { field?: string }).field).toBe("postToGroups");
    await app.close();
  });
});
