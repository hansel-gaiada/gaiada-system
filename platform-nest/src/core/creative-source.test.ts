// SCP-1h (BFF §63.6.6, §35.2): the Asset Library save gains `source` and `aiNote`, under its existing gate (`file` · `create`), and every asset read
// returns them. Against live Postgres and Cerbos, in-memory storage; skips without a test DB (as creative.test.ts does).
//
// Proves: a plain save reads `unknown` and no note (today's body is unchanged); each source round-trips through the save, the list, the detail and the
// versions read; an AI asset needs its note (400 `ai_note_required` on `aiNote`); a bad source or a note over 1,000 characters is a 400 on its field;
// authorization still comes before validation (a viewer with a bad source is 403, not 400); a new version starts `unknown` unless the save says
// otherwise, whatever the version it replaces was; and nothing is half-written on a refusal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { setStorageForTest } from "./storage";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("SCP-1h · the Asset Library save: source and AI note", () => {
  let app: NestFastifyApplication;
  let co: string;
  let designer: string;
  let viewer: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });
  const bin = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  const GRADE = { exposure: 0, contrast: 1, temperature: 0, tint: 0, gamma: 1, saturation: 1, vibrance: 0, highlights: 0, shadows: 0 };

  const save = (who: string, extra: Record<string, unknown> = {}, name = "hero.webp") =>
    app.inject({
      method: "POST", url: `/api/${co}/creative/assets`, headers: asUser(who),
      payload: { name, contentType: "image/webp", presetId: "neutral", grade: GRADE, graded: bin([1, 2, 3]), ...extra },
    });
  const created = async (extra: Record<string, unknown> = {}, name?: string) => {
    const r = await save(designer, extra, name);
    if (r.statusCode !== 201) throw new Error(`save: ${r.statusCode} ${r.body}`);
    return r.json() as { id: string; versionNo: number; versionGroupId: string };
  };
  const detail = async (id: string) => (await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${id}`, headers: asUser(designer) })).json();
  const stored = async (id: string) =>
    (await adminPool().query(`SELECT source, ai_note FROM creative_assets WHERE id = $1`, [id])).rows[0] as { source: string; ai_note: string | null };
  const assetCount = async () => Number((await adminPool().query(`SELECT count(*) AS n FROM creative_assets WHERE tenant_id = $1`, [co])).rows[0].n);

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
    designer = await createUser("scp1h-designer@c.test");
    viewer = await createUser("scp1h-viewer@c.test");
    await addMembership(co, designer);
    await addMembership(co, viewer);
    await grantRole(designer, await createRole("member"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); await teardownTestDb(); });

  it("a plain save (today's body) reads unknown and no note, on the detail, the list and the versions", async () => {
    const a = await created();
    expect(await stored(a.id)).toEqual({ source: "unknown", ai_note: null });
    expect(await detail(a.id)).toMatchObject({ source: "unknown", aiNote: null });
    const list = (await app.inject({ method: "GET", url: `/api/${co}/creative/assets`, headers: asUser(designer) })).json() as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === a.id)).toMatchObject({ source: "unknown", aiNote: null });
    const versions = (await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${a.id}/versions`, headers: asUser(designer) })).json() as Array<Record<string, unknown>>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ source: "unknown", aiNote: null });
  });

  it("each source round-trips through the save and every read", async () => {
    for (const source of ["own", "client", "stock"]) {
      const a = await created({ source }, `${source}.webp`);
      expect(await stored(a.id)).toEqual({ source, ai_note: null });
      expect(await detail(a.id)).toMatchObject({ source, aiNote: null });
    }
    const ai = await created({ source: "ai", aiNote: "  Background from an image model; the text is set by hand.  " }, "ai.webp");
    expect(await stored(ai.id)).toEqual({ source: "ai", ai_note: "Background from an image model; the text is set by hand." });
    expect(await detail(ai.id)).toMatchObject({ source: "ai", aiNote: "Background from an image model; the text is set by hand." });
    const list = (await app.inject({ method: "GET", url: `/api/${co}/creative/assets`, headers: asUser(designer) })).json() as Array<Record<string, unknown>>;
    expect(list.find((x) => x.id === ai.id)).toMatchObject({ source: "ai", aiNote: "Background from an image model; the text is set by hand." });
  });

  it("an AI asset needs its note: 400 on aiNote, and nothing is stored", async () => {
    const before = await assetCount();
    for (const aiNote of [undefined, null, "", "   "]) {
      const r = await save(designer, { source: "ai", ...(aiNote === undefined ? {} : { aiNote }) });
      expect([r.statusCode, r.json().reason, r.json().field], JSON.stringify(aiNote)).toEqual([400, "ai_note_required", "aiNote"]);
    }
    expect(await assetCount()).toBe(before);
  });

  it("a source that is not one of the five and a note that is too long or not text are 400s on their fields", async () => {
    const before = await assetCount();
    for (const source of ["AI", "", "generated", 5, true]) {
      const r = await save(designer, { source });
      expect([r.statusCode, r.json().reason, r.json().field], String(source)).toEqual([400, "source_invalid", "source"]);
    }
    const tooLong = await save(designer, { source: "ai", aiNote: "x".repeat(1001) });
    expect([tooLong.statusCode, tooLong.json().reason, tooLong.json().field]).toEqual([400, "ai_note_invalid", "aiNote"]);
    const notText = await save(designer, { source: "own", aiNote: 7 });
    expect([notText.statusCode, notText.json().reason, notText.json().field]).toEqual([400, "ai_note_invalid", "aiNote"]);
    const edge = await save(designer, { source: "ai", aiNote: "x".repeat(1000) });
    expect(edge.statusCode).toBe(201);
    expect(await assetCount()).toBe(before + 1);
  });

  it("authorization comes before validation: a viewer with a bad source is 403, never 400", async () => {
    const bad = await save(viewer, { source: "nonsense" });
    expect(bad.statusCode).toBe(403);
    const noNote = await save(viewer, { source: "ai" });
    expect(noNote.statusCode).toBe(403);
  });

  it("a new version starts unknown unless the save says otherwise, whatever the version it replaces was", async () => {
    const v1 = await created({ source: "ai", aiNote: "Made with an image model." }, "versioned.webp");
    const r2 = await save(designer, { versionOf: v1.id }, "versioned.webp");
    expect(r2.statusCode).toBe(201);
    const v2 = r2.json() as { id: string; versionNo: number };
    expect(v2.versionNo).toBe(2);
    expect(await stored(v2.id)).toEqual({ source: "unknown", ai_note: null });
    expect(await stored(v1.id)).toEqual({ source: "ai", ai_note: "Made with an image model." });

    const r3 = await save(designer, { versionOf: v1.id, source: "own" }, "versioned.webp");
    const v3 = r3.json() as { id: string; versionNo: number };
    expect(v3.versionNo).toBe(3);
    expect(await stored(v3.id)).toEqual({ source: "own", ai_note: null });

    // A refused new version leaves the group as it was (no half-saved row, no superseded round).
    const before = await assetCount();
    const refused = await save(designer, { versionOf: v1.id, source: "ai" }, "versioned.webp");
    expect([refused.statusCode, refused.json().reason]).toEqual([400, "ai_note_required"]);
    expect(await assetCount()).toBe(before);

    // The versions read carries each version's own source and note, newest first.
    const versions = (await app.inject({ method: "GET", url: `/api/${co}/creative/assets/${v1.id}/versions`, headers: asUser(designer) })).json() as Array<{ versionNo: number; source: string; aiNote: string | null }>;
    expect(versions.map((v) => [v.versionNo, v.source, v.aiNote])).toEqual([[3, "own", null], [2, "unknown", null], [1, "ai", "Made with an image model."]]);
  });
});
