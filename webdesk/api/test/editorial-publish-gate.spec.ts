// M5-W2c (writers' room design 4.5, decision D6) — THE PUBLISH GATE, end to end: on a review-required collection only
// the EXACT approved version goes live, through content.publish, content.schedule and the scheduler's due swap; review
// OFF changes nothing. Real Postgres (migrations through 0016, webdesk_app NOBYPASSRLS), real Redis, the real AppModule
// with the REAL Layer-3/4 PDP (content-test-kit.ts: real WS4 HMAC, command hash, single use); Layers 1/2/2e stay the
// NODE_ENV=test header stubs (the stub carries `ce` for a client editor, WSK-49b). The scheduler is driven by calling
// ContentTickService.runContentTick() with an injected clock, as scheduler-content-tick.spec.ts does.
//
// The W2c acceptance row, item by item:
//   unapproved version: 409 review-not-approved, projection unchanged, WS4 claim rolled back      -> "the gate" block
//   (the approval row going `failed` is the ERP's half: platform-nest webdesk-approved-command.test.ts)
//   the approved version publishes                                                                  -> "the gate" block
//   a mixed batch refuses whole                                                                     -> "batches"
//   review-free collections unchanged                                                               -> "review off" (+ every
//                                                                                                     existing publish spec, untouched)
//   schedule gated the same, and re-checked at fire time                                            -> "schedule" + "scheduler"
//   a `ce` publish still held to D62                                                                -> "client editors"
//   promotion moved the head under an approved item                                                 -> "promotion"
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  hdr,
  mintReadKeys,
  publishItems,
  serviceFields,
  v1Get,
  ws4For,
  type ContentFixture,
  type HeaderOpts,
} from "./content-test-kit";
import { ContentTickService } from "../src/scheduler/content-tick.service";
import { ContentBundleService } from "../src/promotion/content-bundle.service";
import { DbService } from "../src/db/db.service";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const REVIEW = `${PROBLEM}review-not-approved`;
const HOUR = 3_600_000;

const WRITER = "user-writer-w2c"; // writes and submits
const EDITOR = "user-editor-w2c"; // approves (never the maker of what it approves)
const PUBLISHER = "user-publisher-w2c";
const AUTOMATION = JSON.stringify({ sub: "auto-w2c", pk: "automation" });
const AGENT = JSON.stringify({ sub: "agent-w2c", pk: "agent", agt: "webdev-writer" });
const CLIENT = JSON.stringify({ sub: "client-w2c", ce: true });

/** A client-editable composition (vocabulary 1.2.0): headline is client-editable, price is not. */
const CPAGE = {
  ui: { label: "Client pages" },
  fields: [
    { name: "headline", primitive: "text", ui: { clientEditable: true } },
    { name: "price", primitive: "number" },
  ],
  blocks: ["richText"],
};
/** Plain collections with no singleton rule: `notes` stays review-OFF for the whole file; `late` is turned on mid-test. */
const NOTES = { fields: [{ name: "title", primitive: "text" }], blocks: [] };

describe("M5-W2c the publish gate (real DB, real WS4)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let keys: { production: string; staging: string };
  let tick: ContentTickService;

  const site = () => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}`;
  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });

  async function setPolicy(key: string, review: boolean): Promise<void> {
    const r = await app.inject({
      method: "PUT",
      url: `${site()}/collections/${key}/editorial-policy`,
      headers: hdr({ editorial: EDITOR }),
      payload: { reviewRequired: review, seoSignoffRequired: false },
    });
    if (r.statusCode !== 200) throw new Error(`policySet answered ${r.statusCode} ${r.body}`);
  }

  const fieldsFor = (collection: string, label: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
    collection === "service" ? serviceFields({ h1: label, ...over }) : collection === "cpage" ? { headline: label, price: 10, ...over } : { title: label, ...over };

  /** An item created by WRITER (version 1). */
  async function newItem(collection = "service", label = "v1"): Promise<{ itemId: string; slug: string }> {
    const slug = `${collection === "service" ? "service." : ""}w2c-${randomUUID().slice(0, 8)}`;
    const r = await app.inject({
      method: "POST",
      url: `${base(fx)}/items`,
      headers: hdr({ editorial: WRITER }),
      payload: { collectionKey: collection, locale: "en", slug, fields: fieldsFor(collection, label) },
    });
    if (r.statusCode !== 201) throw new Error(`create answered ${r.statusCode} ${r.body}`);
    return { itemId: r.json().item.itemId as string, slug };
  }

  /** A new head version (returns its number). */
  async function edit(itemId: string, baseVersion: number, collection: string, label: string, who = WRITER, over: Record<string, unknown> = {}): Promise<number> {
    const r = await app.inject({ method: "PUT", url: `${base(fx)}/items/${itemId}`, headers: hdr({ editorial: who }), payload: { baseVersion, fields: fieldsFor(collection, label, over) } });
    if (r.statusCode !== 200) throw new Error(`update answered ${r.statusCode} ${r.body}`);
    return r.json().version.version as number;
  }

  const editorial = (itemId: string, path: string, body: Record<string, unknown>, who: string) =>
    app.inject({ method: "POST", url: `${base(fx)}/items/${itemId}/editorial/${path}`, headers: hdr({ editorial: who }), payload: body });

  /** submit `version` (by WRITER) and approve it (by EDITOR, never its maker). */
  async function approve(itemId: string, version: number): Promise<void> {
    const s = await editorial(itemId, "submit", { version }, WRITER);
    if (s.statusCode !== 200) throw new Error(`submit answered ${s.statusCode} ${s.body}`);
    const a = await editorial(itemId, "approve", { version }, EDITOR);
    if (a.statusCode !== 200) throw new Error(`approve answered ${a.statusCode} ${a.body}`);
  }

  const publish = (items: { itemId: string; version: number }[], opts: { approvalId?: string; editorial?: string } = {}) =>
    publishItems(app, fx, items, { approvalId: opts.approvalId, editorial: opts.editorial ?? PUBLISHER });

  function schedule(body: Record<string, unknown>, approvalId = `apr-${randomUUID()}`, opts: HeaderOpts = {}) {
    const ws4 = ws4For("content.schedule", params(), body, approvalId);
    return app.inject({ method: "POST", url: `${base(fx)}/schedule`, headers: hdr({ ws4, editorial: PUBLISHER, ...opts }), payload: body });
  }

  const row = (itemId: string) =>
    asTenant(fx.tenantId, async (db) =>
      (
        await db.query(
          `SELECT blocks, seo, head_version, published_version, publish_state, publish_at, unpublish_at, updated_at, last_published_by
             FROM content_items WHERE id = $1`,
          [itemId],
        )
      ).rows[0],
    );
  const claims = (approvalId: string) =>
    asTenant(fx.tenantId, async (db) => (await db.query(`SELECT action FROM audit_entries WHERE ws4_approval_id = $1`, [approvalId])).rows);
  const swaps = (itemId: string) =>
    asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM content_schedules WHERE content_item_id = $1 ORDER BY created_at, id`, [itemId])).rows);
  const editorialOf = async (itemId: string) => (await app.inject({ method: "GET", url: `${base(fx)}/items/${itemId}`, headers: hdr({ idem: null, editorial: null }) })).json().editorial;

  function expectRefused(r: { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }, items: Array<{ itemIndex: number; itemId: string; version: number; approvedVersion: number | null }>) {
    expect(r.statusCode, r.body).toBe(409);
    expect(String(r.headers["content-type"])).toContain("application/problem+json");
    expect(r.json()).toMatchObject({ type: REVIEW, status: 409, total: items.length });
    expect(r.json().items).toEqual(items);
  }

  /** An item live at version 1 on a review-required collection (approved, then published). */
  async function liveReviewed(collection = "service"): Promise<{ itemId: string; slug: string }> {
    const it = await newItem(collection);
    await approve(it.itemId, 1);
    const p = await publish([{ itemId: it.itemId, version: 1 }]);
    if (p.statusCode !== 200) throw new Error(`publish answered ${p.statusCode} ${p.body}`);
    return it;
  }

  /** A fresh tenant: the kit's five collections plus cpage/notes/late; review ON for service and cpage only. */
  async function useFreshTenant(label: string): Promise<void> {
    fx = await createContentFixture(label);
    keys = await mintReadKeys(app, fx);
    await asTenant(fx.tenantId, async (db) => {
      for (const [k, schema] of Object.entries({ cpage: CPAGE, notes: NOTES, late: NOTES })) {
        const id = randomUUID();
        await db.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4, $5::jsonb)`, [id, fx.tenantId, fx.siteId, k, JSON.stringify(schema)]);
        fx.collections[k] = id;
      }
    });
    await setPolicy("service", true);
    await setPolicy("cpage", true);
  }

  beforeAll(async () => {
    app = await buildContentApp();
    tick = app.get(ContentTickService);
    await useFreshTenant("w2c");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  describe("the gate on content.publish", () => {
    it("an unapproved version: 409 review-not-approved, the projection is unchanged, nothing is live, and the WS4 claim rolled back", async () => {
      const { itemId, slug } = await newItem("service", "never approved");
      const before = await row(itemId);
      const approvalId = `apr-${randomUUID()}`;
      const r = await publish([{ itemId, version: 1 }], { approvalId });
      expectRefused(r, [{ itemIndex: 0, itemId, version: 1, approvedVersion: null }]);
      expect(await row(itemId)).toEqual(before);
      expect((await v1Get(app, fx, keys.production, "service", slug)).statusCode).toBe(404);
      // the claim (the envelope's audit row, 0009's single-use index) rolled back with the refusal ...
      expect(await claims(approvalId)).toEqual([]);
      // ... so, once the version IS approved, the very same approval can still be spent exactly once
      await approve(itemId, 1);
      const ok = await publish([{ itemId, version: 1 }], { approvalId });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await claims(approvalId)).toEqual([{ action: "control.content.publish" }]);
      expect((await v1Get(app, fx, keys.production, "service", slug)).statusCode).toBe(200);
    });

    it("a submitted version that is in review but not approved is refused; approved, it publishes and production serves it", async () => {
      const { itemId, slug } = await newItem("service", "in review");
      expect((await editorial(itemId, "submit", { version: 1 }, WRITER)).statusCode).toBe(200);
      expectRefused(await publish([{ itemId, version: 1 }]), [{ itemId, itemIndex: 0, version: 1, approvedVersion: null }]);
      expect((await editorial(itemId, "approve", { version: 1 }, EDITOR)).statusCode).toBe(200);
      const ok = await publish([{ itemId, version: 1 }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().published).toMatchObject([{ itemId, version: 1 }]);
      expect((await row(itemId)).published_version).toBe(1);
      const v1 = await v1Get(app, fx, keys.production, "service", slug);
      expect(v1.statusCode).toBe(200);
      expect(v1.json().blocks[0].props.h1).toBe("in review");
    });

    it("an edit after approval: the item is back in draft, the APPROVED version still publishes, the new head is refused (naming the approved one)", async () => {
      const { itemId } = await newItem("service", "approved bytes");
      await approve(itemId, 1);
      expect(await edit(itemId, 1, "service", "edited after approval")).toBe(2);
      expect(await editorialOf(itemId)).toMatchObject({ state: "draft", approvedVersion: 1, approvedIsHead: false });
      expectRefused(await publish([{ itemId, version: 2 }]), [{ itemIndex: 0, itemId, version: 2, approvedVersion: 1 }]);
      const ok = await publish([{ itemId, version: 1 }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row(itemId)).published_version).toBe(1);
    });

    it("for every principal class: an automation, an agent and a human publisher are refused alike; the gate does not care who publishes, only what (R4: the maker may publish what someone else approved)", async () => {
      const { itemId } = await newItem("service", "every principal");
      for (const who of [AUTOMATION, AGENT, PUBLISHER, WRITER]) {
        expectRefused(await publish([{ itemId, version: 1 }], { editorial: who }), [{ itemIndex: 0, itemId, version: 1, approvedVersion: null }]);
      }
      await approve(itemId, 1);
      // WRITER made version 1 and EDITOR approved it: WRITER's own publish is the second person's decision already taken
      const ok = await publish([{ itemId, version: 1 }], { editorial: WRITER });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row(itemId)).last_published_by).toBe(WRITER);
    });

    it("a version that does not exist on a review-required collection is refused by the gate (it can never be the approved one)", async () => {
      const { itemId } = await newItem("service", "ghost version");
      await approve(itemId, 1);
      expectRefused(await publish([{ itemId, version: 9 }]), [{ itemIndex: 0, itemId, version: 9, approvedVersion: 1 }]);
    });
  });

  // ==============================================================================================
  describe("batches", () => {
    it("a mixed batch (approved + review-off + unapproved) is refused WHOLE: only the unapproved one is named, and nothing is published", async () => {
      const approved = await newItem("service", "batch approved");
      await approve(approved.itemId, 1);
      const free = await newItem("notes", "batch free");
      const unapproved = await newItem("service", "batch unapproved");
      const before = await Promise.all([approved, free, unapproved].map((i) => row(i.itemId)));
      const items = [
        { itemId: approved.itemId, version: 1 },
        { itemId: free.itemId, version: 1 },
        { itemId: unapproved.itemId, version: 1 },
      ];
      expectRefused(await publish(items), [{ itemIndex: 2, itemId: unapproved.itemId, version: 1, approvedVersion: null }]);
      expect(await Promise.all([approved, free, unapproved].map((i) => row(i.itemId)))).toEqual(before);
      // positive control: without the unapproved item the same batch publishes
      const ok = await publish(items.slice(0, 2));
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row(approved.itemId)).published_version).toBe(1);
      expect((await row(free.itemId)).published_version).toBe(1);
    });

    it("several unapproved items are all named, by request index", async () => {
      const a = await newItem("service", "multi a");
      const b = await newItem("service", "multi b");
      await approve(b.itemId, 1);
      await edit(b.itemId, 1, "service", "multi b v2");
      expectRefused(await publish([{ itemId: a.itemId, version: 1 }, { itemId: b.itemId, version: 2 }]), [
        { itemIndex: 0, itemId: a.itemId, version: 1, approvedVersion: null },
        { itemIndex: 1, itemId: b.itemId, version: 2, approvedVersion: 1 },
      ]);
    });
  });

  // ==============================================================================================
  describe("review off: nothing changes", () => {
    it("a collection with no policy row publishes and schedules any version, exactly as before (no review row is ever written)", async () => {
      const { itemId, slug } = await newItem("notes", "free v1");
      await edit(itemId, 1, "notes", "free v2");
      const ok = await publish([{ itemId, version: 1 }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await v1Get(app, fx, keys.production, "notes", slug)).statusCode).toBe(200);
      const at = new Date(Date.now() + HOUR).toISOString();
      const s = await schedule({ items: [{ itemId, version: 2 }], publishAt: at, unpublishAt: null });
      expect(s.statusCode, s.body).toBe(200);
      expect(await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT 1 FROM editorial_items WHERE content_item_id = $1`, [itemId])).rows)).toEqual([]);
    });

    it("turning review OFF again lifts the gate (approved_version is untouched; nothing else is needed)", async () => {
      const { itemId } = await newItem("late", "late off");
      await setPolicy("late", true);
      expectRefused(await publish([{ itemId, version: 1 }]), [{ itemIndex: 0, itemId, version: 1, approvedVersion: null }]);
      await setPolicy("late", false);
      expect((await publish([{ itemId, version: 1 }])).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  describe("content.schedule is gated the same", () => {
    it("a non-live item: an unapproved version is 409 and nothing is scheduled; the approved one is scheduled", async () => {
      const { itemId } = await newItem("service", "sched non-live");
      const before = await row(itemId);
      const at = new Date(Date.now() + HOUR).toISOString();
      const approvalId = `apr-${randomUUID()}`;
      const body = { items: [{ itemId, version: 1 }], publishAt: at, unpublishAt: null };
      expectRefused(await schedule(body, approvalId), [{ itemIndex: 0, itemId, version: 1, approvedVersion: null }]);
      expect(await row(itemId)).toEqual(before);
      expect(await swaps(itemId)).toEqual([]);
      expect(await claims(approvalId)).toEqual([]);
      await approve(itemId, 1);
      const ok = await schedule(body, approvalId);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(itemId)).toMatchObject({ publish_state: "scheduled", published_version: 1 });
    });

    it("a live item: a swap to an unapproved version is 409 (no pending swap); approved, the swap is queued", async () => {
      const { itemId } = await liveReviewed();
      await edit(itemId, 1, "service", "swap v2");
      const at = new Date(Date.now() + HOUR).toISOString();
      const body = { items: [{ itemId, version: 2 }], publishAt: at, unpublishAt: null };
      expectRefused(await schedule(body), [{ itemIndex: 0, itemId, version: 2, approvedVersion: 1 }]);
      expect(await swaps(itemId)).toEqual([]);
      await approve(itemId, 2);
      expect((await schedule(body)).statusCode).toBe(200);
      expect(await swaps(itemId)).toMatchObject([{ version: 2, executed_at: null, cancelled_at: null, failed_at: null }]);
      expect((await row(itemId)).published_version).toBe(1);
    });

    it("a takedown-only schedule puts nothing live and is NOT gated (even when the live version is no longer the approved one)", async () => {
      const { itemId } = await liveReviewed();
      await edit(itemId, 1, "service", "takedown v2");
      await approve(itemId, 2); // approved_version 2, live 1
      const r = await schedule({ items: [{ itemId, version: 1 }], publishAt: null, unpublishAt: new Date(Date.now() + HOUR).toISOString() });
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  // ==============================================================================================
  describe("the scheduler re-checks a due swap at fire time (WSK-61 step 2)", () => {
    const resultFor = (r: Awaited<ReturnType<ContentTickService["runContentTick"]>>) => r.tenants.find((t) => t.tenantId === fx.tenantId);
    // A tick processes EVERY due row of the tenant, so the blocks above (which queued swaps and schedules of their
    // own) would pollute the counts asserted here: these tests run on a tenant of their own.
    beforeAll(async () => {
      await useFreshTenant("w2c-tick");
    });

    it("an edit AFTER the swapped version was approved does not stale it: approved_version survives the edit, and the swap fires", async () => {
      const { itemId } = await liveReviewed();
      await edit(itemId, 1, "service", "fire v2");
      await approve(itemId, 2);
      expect((await schedule({ items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString(), unpublishAt: null })).statusCode).toBe(200);
      await edit(itemId, 2, "service", "fire v3"); // back to draft, approved_version stays 2
      expect(await editorialOf(itemId)).toMatchObject({ state: "draft", approvedVersion: 2 });
      const t = resultFor(await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
      expect(t).toMatchObject({ swapped: 1, swapsFailed: 0 });
      expect((await row(itemId)).published_version).toBe(2);
      expect((await swaps(itemId))[0].executed_at).not.toBeNull();
    });

    it("a NEWER approval stales the queued swap: at fire time it fails `review-not-approved`, and the live version keeps serving", async () => {
      const { itemId, slug } = await liveReviewed();
      await edit(itemId, 1, "service", "stale v2");
      await approve(itemId, 2);
      expect((await schedule({ items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString(), unpublishAt: null })).statusCode).toBe(200);
      await edit(itemId, 2, "service", "stale v3");
      await approve(itemId, 3); // approved_version 3: the queued v2 no longer matches
      const t = resultFor(await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
      expect(t).toMatchObject({ swapped: 0, swapsFailed: 1 });
      const [swap] = await swaps(itemId);
      expect(swap.executed_at).toBeNull();
      expect(swap.failed_at).not.toBeNull();
      expect(swap.fail_reason).toBe("review-not-approved: version 2 is not the approved version (approved: 3)");
      expect((await row(itemId)).published_version).toBe(1);
      expect((await v1Get(app, fx, keys.production, "service", slug)).json().blocks[0].props.h1).toBe("v1");
      // a failed swap is final: the next tick does not retry it
      expect(resultFor(await tick.runContentTick(new Date(Date.now() + 3 * HOUR)))).toMatchObject({ swapped: 0, swapsFailed: 0 });
    });

    it("review switched ON after a swap was queued (when review was off): at fire time nothing is approved, so the swap fails", async () => {
      await setPolicy("late", false);
      const { itemId } = await newItem("late", "late v1");
      expect((await publish([{ itemId, version: 1 }])).statusCode).toBe(200);
      await edit(itemId, 1, "late", "late v2");
      expect((await schedule({ items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString(), unpublishAt: null })).statusCode).toBe(200);
      await setPolicy("late", true);
      const t = resultFor(await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
      expect(t).toMatchObject({ swapped: 0, swapsFailed: 1 });
      expect((await swaps(itemId))[0].fail_reason).toBe("review-not-approved: version 2 is not the approved version (nothing is approved)");
      expect((await row(itemId)).published_version).toBe(1);
      await setPolicy("late", false);
    });

    it("review off: a queued swap fires exactly as before", async () => {
      const { itemId } = await newItem("notes", "notes v1");
      expect((await publish([{ itemId, version: 1 }])).statusCode).toBe(200);
      await edit(itemId, 1, "notes", "notes v2");
      expect((await schedule({ items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString(), unpublishAt: null })).statusCode).toBe(200);
      expect(resultFor(await tick.runContentTick(new Date(Date.now() + 2 * HOUR)))).toMatchObject({ swapped: 1, swapsFailed: 0 });
      expect((await row(itemId)).published_version).toBe(2);
    });
  });

  // ==============================================================================================
  describe("promotion moved the head under an approved item (versions appended WITHOUT the review hooks)", () => {
    it("the real applyBundle appends version 2 and leaves the review row at approved v1: v2 is refused, v1 still publishes", async () => {
      const { itemId, slug } = await newItem("service", "before promotion");
      await approve(itemId, 1);

      const bundles = app.get(ContentBundleService);
      const bundle = await bundles.exportBundle(fx.tenantId, fx.siteId);
      const entry = bundle.contentItems.find((i) => i.slug === slug && i.collectionKey === "service");
      expect(entry).toBeDefined();
      const blocks = JSON.parse(JSON.stringify(entry!.blocks)) as Array<{ props: Record<string, unknown> }>;
      blocks[0].props.h1 = "promoted in";
      entry!.blocks = blocks;
      const result = await app
        .get(DbService)
        .withTenant(fx.tenantId, (db) =>
          db.transaction((client) =>
            bundles.applyBundle(client, fx.tenantId, fx.siteId, bundle, "merge", { actor: "promotion-w2c", actorKind: "automation", ws4ApprovalId: null, note: "promotion w2c" }),
          ),
        );
      expect(result.versionsAppended).toBeGreaterThanOrEqual(1);
      expect((await row(itemId)).head_version).toBe(2);
      // the hook never ran: the row still says "approved, version 1", which is no longer the head
      expect(await editorialOf(itemId)).toMatchObject({ state: "approved", approvedVersion: 1, approvedIsHead: false });

      expectRefused(await publish([{ itemId, version: 2 }]), [{ itemIndex: 0, itemId, version: 2, approvedVersion: 1 }]);
      const ok = await publish([{ itemId, version: 1 }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await v1Get(app, fx, keys.production, "service", slug)).json().blocks[0].props.h1).toBe("before promotion");
    });
  });

  // ==============================================================================================
  describe("client editors (D58 self-publish, D62 path check) on a review-required collection", () => {
    it("a client's own edit cannot go live until the agency approves it; then the client's self-publish goes through", async () => {
      const { itemId, slug } = await liveReviewed("cpage");
      const v2 = await edit(itemId, 1, "cpage", "client headline", CLIENT); // client-editable path only
      expect(v2).toBe(2);
      // D62 passes (only a client-editable path changed), the review gate refuses
      expectRefused(await publish([{ itemId, version: 2 }], { editorial: CLIENT }), [{ itemIndex: 0, itemId, version: 2, approvedVersion: 1 }]);
      // a client cannot approve: no editorial command is on its allow-list
      const self = await editorial(itemId, "submit", { version: 2 }, CLIENT);
      expect(self.statusCode).toBe(403);
      expect(self.json().type).toBe(`${PROBLEM}client-command-not-allowed`);
      await approve(itemId, 2); // the agency: WRITER submits, EDITOR approves the client's version
      const ok = await publish([{ itemId, version: 2 }], { editorial: CLIENT });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await v1Get(app, fx, keys.production, "cpage", slug)).statusCode).toBe(200);
      expect((await row(itemId)).last_published_by).toBe("client-w2c");
    });

    it("D62 still holds independently: an APPROVED version carrying an agency change to a non-editable field is 422 for the client, 200 for staff", async () => {
      const { itemId } = await liveReviewed("cpage");
      await edit(itemId, 1, "cpage", "v1", WRITER, { price: 99 }); // the agency changed a non-client-editable field
      await approve(itemId, 2);
      const client = await publish([{ itemId, version: 2 }], { editorial: CLIENT });
      expect(client.statusCode, client.body).toBe(422);
      expect(client.json().type).toBe(`${PROBLEM}publish-not-client-editable`);
      expect((await row(itemId)).published_version).toBe(1);
      expect((await publish([{ itemId, version: 2 }])).statusCode).toBe(200);
    });

    it("the order is D62 first, then review: an unapproved version with a non-editable change is the 422, never the 409", async () => {
      const { itemId } = await liveReviewed("cpage");
      await edit(itemId, 1, "cpage", "v1", WRITER, { price: 77 });
      const r = await publish([{ itemId, version: 2 }], { editorial: CLIENT });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().type).toBe(`${PROBLEM}publish-not-client-editable`);
      // the same version from staff meets the review gate instead
      expectRefused(await publish([{ itemId, version: 2 }]), [{ itemIndex: 0, itemId, version: 2, approvedVersion: 1 }]);
    });
  });
});
