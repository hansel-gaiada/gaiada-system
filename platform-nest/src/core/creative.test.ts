// Creative Image Studio persist API. Verifies the reproducibility contract: graded +
// original bytes round-trip, the grade JSON is stored and returned verbatim, malformed
// grades are rejected, and tenant/role gating + delete behave. In-memory storage so the
// suite never touches disk. Skips cleanly without a test DB (matches files.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { setStorageForTest } from "./storage";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("creative image studio — assets", () => {
  let app: NestFastifyApplication;
  let co: string, member: string, viewer: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  const bin = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  const GRADE = { exposure: -0.04, contrast: 1.18, temperature: 0.34, tint: 0.04, gamma: 0.97, saturation: 1.1, vibrance: 0.32, highlights: -0.1, shadows: -0.16 };

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
    member = await createUser("designer@c.test");
    viewer = await createUser("view@c.test");
    await addMembership(co, member);
    await addMembership(co, viewer);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); await teardownTestDb(); });

  let assetId: string;

  it("saves a graded asset with original + grade params", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(member),
      payload: {
        name: "hero.webp", contentType: "image/webp", width: 1080, height: 1350, presetId: "vivid-warm",
        grade: GRADE, graded: bin([1, 2, 3, 4, 5]), original: bin([9, 8, 7]), originalContentType: "image/jpeg",
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.gradedByteSize).toBe(5);
    expect(body.originalByteSize).toBe(3);
    assetId = body.id;
  });

  it("round-trips the graded and original bytes", async () => {
    const g = await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${assetId}/content`, headers: asUser(member) });
    expect(g.statusCode).toBe(200);
    expect(Array.from(g.rawPayload)).toEqual([1, 2, 3, 4, 5]);
    const o = await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${assetId}/original`, headers: asUser(member) });
    expect(Array.from(o.rawPayload)).toEqual([9, 8, 7]);
  });

  it("stores and returns the grade JSON verbatim (reproducibility)", async () => {
    const m = await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${assetId}`, headers: asUser(member) });
    expect(m.statusCode).toBe(200);
    expect(m.json().grade).toEqual(GRADE);
    expect(m.json().preset_id).toBe("vivid-warm");
  });

  it("rejects a malformed grade", async () => {
    const missing = await app.inject({
      method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(member),
      payload: { name: "x.webp", grade: { ...GRADE, shadows: undefined }, graded: bin([1]) },
    });
    expect(missing.statusCode).toBe(400);
    const nan = await app.inject({
      method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(member),
      payload: { name: "x.webp", grade: { ...GRADE, contrast: "loud" }, graded: bin([1]) },
    });
    expect(nan.statusCode).toBe(400);
  });

  it("rejects missing name or graded content", async () => {
    const noName = await app.inject({ method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(member), payload: { grade: GRADE, graded: bin([1]) } });
    expect(noName.statusCode).toBe(400);
    const noImg = await app.inject({ method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(member), payload: { name: "x.webp", grade: GRADE } });
    expect(noImg.statusCode).toBe(400);
  });

  it("lists assets, then delete removes them", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/creative/assets`, headers: asUser(member) });
    expect(list.json().length).toBeGreaterThanOrEqual(1);
    const del = await app.inject({ method: "DELETE", url: `/api/${co}/creative/assets/${assetId}`, headers: asUser(member) });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${assetId}`, headers: asUser(member) });
    expect(after.statusCode).toBe(404);
  });
});
