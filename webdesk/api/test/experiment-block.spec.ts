// M5-V5-a (vocabulary 1.5.0) — the `experiment` block in the WRITE plane: the publish lock, never client-editable,
// and the frozen /v1 read path serving it as one more block. Design: docs/plans/2026-10-12-m5-phase5-design.md 5.1, 5.2.
//
// Real Postgres, real Redis, the real AppModule with the REAL PDP and the REAL editorial resolver verifying
// EdDSA-signed assertions (the pattern of client-editor-enforcement.spec.ts), so a client editor (`ce: true`) is the
// production code path. Every request is valid for its command (validation never pre-empts the check under test), and
// every refusal proves NOTHING WAS WRITTEN.
//
// The pure rules (validateItemContent, experimentLockViolations, isClientEditable) are covered without a database in
// webdesk/delivery/test/v5a-experiment.test.mjs. This file proves they are WIRED: needs the Linux gate (CI).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, base, buildContentApp, createContentFixture, hdr, mintReadKeys, v1Get, ws4For, type ContentFixture } from "./content-test-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import type { CommandName } from "../src/control/command-types";
import { freshKey, keySetOf, mintEditorial } from "./editorial-assertion-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const HEADER = "x-webdesk-editorial-assertion";

/** Typed fields; the collection as a whole is client-editable, so a client could (wrongly) reach a block after blocks[0]. */
const XPAGE = {
  ui: { label: "Experiment pages", clientEditable: true },
  fields: [
    { name: "headline", primitive: "text" },
    { name: "ctaLabel", primitive: "text" },
    { name: "note", primitive: "text" },
  ],
  blocks: ["richText"],
};

describe("M5-V5-a the experiment block: publish lock, never client-editable, served by /v1 (real DB + real resolver)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let keys: { production: string; staging: string };
  const clock = Math.floor(Date.now() / 1000);
  const key = freshKey("wde-exp-v5a");
  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });

  beforeAll(async () => {
    const resolver = new RealEditorialPrincipalResolver({ keys: keySetOf(key), store: { consume: async () => true, close: async () => {} }, now: () => clock });
    app = await buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useValue(resolver));
    fx = await createContentFixture("exp5a");
    keys = await mintReadKeys(app, fx);
    await asTenant(fx.tenantId, async (db) => {
      const id = randomUUID();
      await db.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4, $5::jsonb)`, [id, fx.tenantId, fx.siteId, "xpage", JSON.stringify(XPAGE)]);
      fx.collections.xpage = id;
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  interface Call {
    method: "POST" | "PUT";
    url: string;
    command: CommandName;
    params: Record<string, string>;
    body?: Record<string, unknown>;
    ce?: boolean;
    approval?: string;
  }
  async function call(c: Call) {
    const args = { ...c.params, ...(c.body ?? {}) };
    const headers = hdr({ editorial: null, ws4: c.approval ? ws4For(c.command, c.params, c.body ?? {}, c.approval) : undefined });
    headers[HEADER] = mintEditorial(key, {
      sub: c.ce ? "erp-client-user-1" : "erp-staff-user-1",
      pk: "human",
      ten: fx.slug,
      site: fx.siteId,
      cmd: c.command,
      cmh: computeCommandHash(c.command, args),
      ...(c.approval ? { apr: c.approval } : {}),
      ...(c.ce ? { ce: true } : {}),
      iat: clock,
      exp: clock + 60,
      jti: randomUUID(),
    });
    return app.inject({ method: c.method, url: c.url, headers, payload: c.body });
  }
  const create = (body: Record<string, unknown>, ce = false) => call({ method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body, ce });
  const update = (itemId: string, body: Record<string, unknown>, ce = false) =>
    call({ method: "PUT", url: `${base(fx)}/items/${itemId}`, command: "content.update", params: { ...params(), itemId }, body, ce });
  const publish = (items: { itemId: string; version: number }[], ce = false) =>
    call({ method: "POST", url: `${base(fx)}/publish`, command: "content.publish", params: params(), body: { items }, ce, approval: `apr-${randomUUID()}` });
  const schedule = (items: { itemId: string; version: number }[], publishAt: string) =>
    call({ method: "POST", url: `${base(fx)}/schedule`, command: "content.schedule", params: params(), body: { items, publishAt }, approval: `apr-${randomUUID()}` });

  const slug = () => `xp-${randomUUID().slice(0, 8)}`;
  const fieldsOf = (over: Record<string, unknown> = {}) => ({ headline: "Websites that win work", ctaLabel: "Get a quote", note: "n1", ...over });
  const experiment = (over: Record<string, unknown> = {}) => ({
    type: "experiment",
    props: {
      key: "home-hero-2026-11",
      target: "fields",
      enrolment: "consented",
      goal: { event: "lead_form_start", match: { form_id: "contact" } },
      arms: [
        { key: "a", weight: 50 },
        { key: "b", weight: 50, override: { headline: "Your next client is searching now" } },
      ],
      ...over,
    },
  });

  async function rows(sql: string, args: unknown[] = []): Promise<any[]> {
    return asTenant(fx.tenantId, async (db) => (await db.query(sql, args)).rows);
  }
  const versionCount = async (itemId: string) => (await rows(`SELECT count(*)::int AS n FROM content_versions WHERE content_item_id = $1`, [itemId]))[0].n as number;
  const publishedVersion = async (itemId: string) => (await rows(`SELECT published_version FROM content_items WHERE id = $1`, [itemId]))[0].published_version as number | null;
  function expectProblem(r: { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }, status: number, slugName: string) {
    expect(r.statusCode, r.body).toBe(status);
    expect(String(r.headers["content-type"])).toContain("application/problem+json");
    expect(r.json().type).toBe(`${PROBLEM}${slugName}`);
  }
  const listed = (r: { json: () => any }): string[] => (r.json().issues as { path: string }[]).map((i) => i.path).sort();

  /** A staff item carrying an experiment, version 1 PUBLISHED (the test is running). */
  async function runningItem(over: { fields?: Record<string, unknown>; exp?: Record<string, unknown> } = {}): Promise<{ itemId: string; slug: string }> {
    const s = slug();
    const c = await create({ collectionKey: "xpage", locale: "en", slug: s, fields: over.fields ?? fieldsOf(), blocks: [experiment(over.exp)] });
    expect(c.statusCode, c.body).toBe(201);
    const itemId = c.json().item.itemId as string;
    const p = await publish([{ itemId, version: 1 }]);
    expect(p.statusCode, p.body).toBe(200);
    return { itemId, slug: s };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The block is an ordinary item block to write, validate and serve
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a valid experiment is stored as blocks[1], and /v1 serves it as one more block (the envelope is unchanged)", async () => {
    const { slug: s } = await runningItem();
    const r = await v1Get(app, fx, keys.production, "xpage", s);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(["blocks", "collection", "locale", "localizations", "meta", "seo", "slug"]);
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0]).toEqual({ type: "fields", props: fieldsOf() });
    expect(body.blocks[1]).toEqual(experiment());
  });

  it("an invalid experiment is 422 composition-violation with the exact path, and nothing is written", async () => {
    const s = slug();
    const r = await create({
      collectionKey: "xpage",
      locale: "en",
      slug: s,
      fields: fieldsOf(),
      blocks: [experiment({ arms: [{ key: "a", weight: 50 }, { key: "b", weight: 40, override: { headline: "x" } }] })],
    });
    expectProblem(r, 422, "composition-violation");
    expect(listed(r)).toEqual(["/blocks/1/props/arms"]);
    expect(await rows(`SELECT 1 FROM content_items WHERE slug = $1`, [s])).toHaveLength(0);
  });

  it("an override of a field the collection does not declare is 422 at its own path", async () => {
    const r = await create({
      collectionKey: "xpage",
      locale: "en",
      slug: slug(),
      fields: fieldsOf(),
      blocks: [experiment({ arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50, override: { nope: "x" } }] })],
    });
    expectProblem(r, 422, "composition-violation");
    expect(listed(r)).toEqual(["/blocks/1/props/arms/1/override/nope"]);
  });

  it("/v1 search indexes only the control: the override copy is not in search_text", async () => {
    const { itemId } = await runningItem({ fields: fieldsOf({ headline: "Controlheadline" }), exp: { arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50, override: { headline: "Variantheadline" } }] } });
    const st = (await rows(`SELECT search_text FROM content_items WHERE id = $1`, [itemId]))[0].search_text as string;
    expect(st).toContain("Controlheadline");
    expect(st).not.toContain("Variantheadline");
    expect(st).not.toContain("home-hero-2026-11");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The publish lock
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the publish lock (409 experiment-locked)", () => {
    it("a first publish of an item carrying an experiment is not locked (nothing is running yet)", async () => {
      const { itemId } = await runningItem(); // runningItem itself asserts the 200
      expect(await publishedVersion(itemId)).toBe(1);
    });

    it("publishing a version that changes the CONTROL value the experiment overrides is refused, names the field, and v1 stays live", async () => {
      const { itemId, slug: s } = await runningItem();
      const u = await update(itemId, { baseVersion: 1, fields: fieldsOf({ headline: "A new control headline" }), blocks: [experiment()] });
      expect(u.statusCode, u.body).toBe(200); // a draft may be edited freely: only a PUBLISH is locked
      const p = await publish([{ itemId, version: 2 }]);
      expectProblem(p, 409, "experiment-locked");
      expect(listed(p)).toEqual(["/items/0/blocks/0/props/headline"]);
      expect(await publishedVersion(itemId)).toBe(1);
      const live = await v1Get(app, fx, keys.production, "xpage", s);
      expect(live.json().blocks[0].props.headline).toBe("Websites that win work");
    });

    it("publishing a version that changes the experiment itself (a weight) is refused", async () => {
      const { itemId } = await runningItem();
      const u = await update(itemId, {
        baseVersion: 1,
        fields: fieldsOf(),
        blocks: [experiment({ arms: [{ key: "a", weight: 70 }, { key: "b", weight: 30, override: { headline: "Your next client is searching now" } }] })],
      });
      expect(u.statusCode, u.body).toBe(200);
      const p = await publish([{ itemId, version: 2 }]);
      expectProblem(p, 409, "experiment-locked");
      expect(listed(p)).toEqual(["/items/0/blocks/1/props"]);
      expect(await publishedVersion(itemId)).toBe(1);
    });

    it("a change to a field the experiment does NOT override is allowed (200), and the experiment stays", async () => {
      const { itemId, slug: s } = await runningItem();
      const u = await update(itemId, { baseVersion: 1, fields: fieldsOf({ note: "n2", ctaLabel: "Request a quote" }), blocks: [experiment()] });
      expect(u.statusCode, u.body).toBe(200);
      const p = await publish([{ itemId, version: 2 }]);
      expect(p.statusCode, p.body).toBe(200);
      const live = await v1Get(app, fx, keys.production, "xpage", s);
      expect(live.json().blocks[1].type).toBe("experiment");
      expect(live.json().blocks[0].props.ctaLabel).toBe("Request a quote");
    });

    it("the STOP is always allowed: a version without the block publishes even when the control changed (the winner merged in)", async () => {
      const { itemId, slug: s } = await runningItem();
      const u = await update(itemId, { baseVersion: 1, fields: fieldsOf({ headline: "Your next client is searching now" }), blocks: [] });
      expect(u.statusCode, u.body).toBe(200);
      const p = await publish([{ itemId, version: 2 }]);
      expect(p.statusCode, p.body).toBe(200);
      const live = await v1Get(app, fx, keys.production, "xpage", s);
      expect(live.json().blocks).toEqual([{ type: "fields", props: fieldsOf({ headline: "Your next client is searching now" }) }]);
    });

    it("after the stop nothing is locked: the same control edit that was refused is now allowed", async () => {
      const { itemId } = await runningItem();
      expect((await update(itemId, { baseVersion: 1, fields: fieldsOf(), blocks: [] })).statusCode).toBe(200);
      expect((await publish([{ itemId, version: 2 }])).statusCode).toBe(200);
      expect((await update(itemId, { baseVersion: 2, fields: fieldsOf({ headline: "Edited after the stop" }), blocks: [] })).statusCode).toBe(200);
      expect((await publish([{ itemId, version: 3 }])).statusCode).toBe(200);
    });

    it("one locked item refuses the WHOLE batch: the other item is not published either", async () => {
      const locked = await runningItem();
      const free = await create({ collectionKey: "xpage", locale: "en", slug: slug(), fields: fieldsOf() });
      expect(free.statusCode, free.body).toBe(201);
      const freeId = free.json().item.itemId as string;
      expect((await update(locked.itemId, { baseVersion: 1, fields: fieldsOf({ headline: "Locked change" }), blocks: [experiment()] })).statusCode).toBe(200);
      const p = await publish([{ itemId: freeId, version: 1 }, { itemId: locked.itemId, version: 2 }]);
      expectProblem(p, 409, "experiment-locked");
      expect(listed(p)).toEqual(["/items/1/blocks/0/props/headline"]);
      expect(await publishedVersion(freeId)).toBeNull();
      expect(await publishedVersion(locked.itemId)).toBe(1);
    });

    it("scheduling the locked version onto the live item is refused too (a pending swap would sidestep the lock)", async () => {
      const { itemId } = await runningItem();
      expect((await update(itemId, { baseVersion: 1, fields: fieldsOf({ headline: "Scheduled change" }), blocks: [experiment()] })).statusCode).toBe(200);
      const r = await schedule([{ itemId, version: 2 }], new Date(Date.now() + 3_600_000).toISOString());
      expectProblem(r, 409, "experiment-locked");
      expect(await rows(`SELECT 1 FROM content_schedules WHERE content_item_id = $1`, [itemId])).toHaveLength(0);
    });

    it("the lock holds for a client editor's publish as well (the refusal is for every principal class)", async () => {
      const { itemId } = await runningItem();
      expect((await update(itemId, { baseVersion: 1, fields: fieldsOf({ headline: "Client tried" }), blocks: [experiment()] })).statusCode).toBe(200);
      const p = await publish([{ itemId, version: 2 }], true);
      // The client check (D62) runs first: the experiment block is unchanged, the headline is client-editable, so it passes
      // and the lock is what refuses.
      expectProblem(p, 409, "experiment-locked");
      expect(await publishedVersion(itemId)).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Never client-editable
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("never client-editable (422 field-not-client-editable)", () => {
    const NOT_EDITABLE = "field-not-client-editable";

    it("a client editor ADDING an experiment to an item is 422 and nothing is written; the same call as staff is allowed", async () => {
      const s = slug();
      const c = await create({ collectionKey: "xpage", locale: "en", slug: s, fields: fieldsOf() });
      expect(c.statusCode, c.body).toBe(201);
      const itemId = c.json().item.itemId as string;
      const bad = await update(itemId, { baseVersion: 1, fields: fieldsOf(), blocks: [experiment()] }, true);
      expectProblem(bad, 422, NOT_EDITABLE);
      expect(listed(bad).every((p) => p.startsWith("/blocks/1"))).toBe(true);
      expect(listed(bad)).toContain("/blocks/1/type");
      expect(await versionCount(itemId)).toBe(1);
      const ok = await update(itemId, { baseVersion: 1, fields: fieldsOf(), blocks: [experiment()] }, false);
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("a client editor CHANGING an experiment's weights is 422 and names the pointer", async () => {
      const { itemId } = await runningItem();
      const r = await update(itemId, {
        baseVersion: 1,
        fields: fieldsOf(),
        blocks: [experiment({ arms: [{ key: "a", weight: 60 }, { key: "b", weight: 40, override: { headline: "Your next client is searching now" } }] })],
      }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r)).toEqual(["/blocks/1/props/arms/0/weight", "/blocks/1/props/arms/1/weight"]);
      expect(await versionCount(itemId)).toBe(1);
    });

    it("a client editor REMOVING the experiment is 422", async () => {
      const { itemId } = await runningItem();
      const r = await update(itemId, { baseVersion: 1, fields: fieldsOf(), blocks: [] }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r).every((p) => p.startsWith("/blocks/1"))).toBe(true);
      expect(await versionCount(itemId)).toBe(1);
    });

    it("a client editor CREATING an item that carries an experiment is 422 and no item exists", async () => {
      const s = slug();
      const r = await create({ collectionKey: "xpage", locale: "en", slug: s, fields: fieldsOf(), blocks: [experiment()] }, true);
      expectProblem(r, 422, NOT_EDITABLE);
      expect(listed(r).every((p) => p.startsWith("/blocks/1"))).toBe(true);
      expect(await rows(`SELECT 1 FROM content_items WHERE slug = $1`, [s])).toHaveLength(0);
    });

    it("a client editor can still edit the item's own client-editable fields beside an experiment (the rule is the block, not the item)", async () => {
      const { itemId } = await runningItem();
      const r = await update(itemId, { baseVersion: 1, fields: fieldsOf({ note: "client note" }), blocks: [experiment()] }, true);
      expect(r.statusCode, r.body).toBe(200);
    });
  });
});
