// M5-W1q (owner ruling WSK-D84) -- the contributor upload QUARANTINE, WebDesk half. A freelance writer's upload is created
// `quarantined`: scanned like every upload, stored, and then served by NOTHING until a staff editor accepts it (media.review).
// Real Postgres (migrations through 0020), real Redis, real RustFS, real ClamAV, the real AppModule with the REAL Layer-3/4
// PDP (content-test-kit.ts). Needs the Linux gate (webdesk/qa/linux-gate.sh) or the CI `webdesk-api` job.
//
// What each wall is proven with (every denial beside a positive control that sends the SAME request and succeeds):
//   state       a contributor's upload is quarantined (token, row, audit); a staff upload is accepted and served as before
//   serving     a quarantined / rejected asset is 404 on the public media route (by id, upper-cased id, transform route, another
//               tenant's slug), and absent from the default library listing; accept makes it served; reject never does
//   publishing  content that references an unaccepted asset cannot be published or scheduled (409 media-not-accepted), nothing
//               written; after accept it publishes
//   scan        an infected file from a contributor is refused 403 as for anyone, no asset row
//   review      accept / reject by staff; a decision is final; the same decision again is a no-op; a contributor (xc) and a client
//               editor (ce) are refused; the uploader cannot review their own upload; a never-quarantined asset is 409
//   reject      the row is soft-deleted exactly like media.delete (purge_after = deleted_at + the bucket retention), so the existing
//               media-purge job frees the bytes: there is no second purge path
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, base, buildContentApp, createContentFixture, createItem, hdr, publishItems, serviceFields, type ContentFixture } from "./content-test-kit";
import { assetUrl, auditRows, buildEicarPdf, buildPng, dumpAssets, dumpTokens, getAsset, listMedia, mediaBase, mintUploadToken, seedAsset, uploadFile } from "./media-library-kit";
import { storageConfig } from "../src/storage/storage.config";
import { MediaService } from "../src/media/media.service";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const CONTRIBUTOR = JSON.stringify({ sub: "contrib-1", xc: true });
const CLIENT = JSON.stringify({ sub: "client-1", ce: true });
const STAFF_ED = "staff-editor-1";
const STAFF_OTHER = "staff-editor-2";
/** AuditService.hashArgs: sha256 of the JSON text of the args, in key order. */
const sha = (_label: string, args: unknown): string => createHash("sha256").update(JSON.stringify(args)).digest("hex");

describe("M5-W1q the contributor upload quarantine (WSK-D84)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("w1q");
    other = await createContentFixture("w1q-other");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  const mintAs = (editorial: string, body: Record<string, unknown> = { bucket: "media" }, f: ContentFixture = fx) => mintUploadToken(app, f, body, { editorial });
  async function uploadAs(editorial: string, f: ContentFixture = fx, png = buildPng(32, 24, 400)) {
    const minted = await mintAs(editorial, { bucket: "media" }, f);
    expect(minted.statusCode, minted.body).toBe(201);
    const m = minted.json();
    const up = await uploadFile(app, f.slug, m.token, png);
    return { minted: m, up, png };
  }
  const review = (assetId: string, decision: unknown, editorial: string, f: ContentFixture = fx, idem?: string) =>
    app.inject({ method: "POST", url: `${mediaBase(f)}/${assetId}/review`, headers: hdr({ editorial, idem }), payload: { decision } });
  const serve = (f: ContentFixture, assetId: string) => app.inject({ method: "GET", url: assetUrl(f, assetId) });
  const problemType = (r: { json: () => any }) => r.json().type as string;

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("state: who is quarantined", () => {
    it("a contributor's token quarantines: the mint says so, the token row carries it, the upload is a quarantined asset, the audit names the state", async () => {
      const { minted, up } = await uploadAs(CONTRIBUTOR);
      expect(minted.quarantined).toBe(true);
      expect(up.statusCode, up.body).toBe(201);
      const asset = up.json();
      expect(asset.reviewState).toBe("quarantined");
      expect(asset.reviewedBy).toBeNull();
      expect(asset.createdBy).toBe("contrib-1");
      expect((await dumpTokens(fx)).find((t) => t.id === minted.tokenId)).toMatchObject({ quarantine: true });
      expect(await getAsset(fx, asset.assetId)).toMatchObject({ review_state: "quarantined", created_by: "contrib-1", reviewed_by: null, reviewed_at: null });
      // the audit row stores a hash of its args: the args name the review state, so a quarantined and an accepted upload differ
      const expected = sha("webdesk.media.upload args", { bucket: "media", mediaAssetId: asset.assetId, sizeBytes: 400, reviewState: "quarantined", via: "upload-token", tokenId: minted.tokenId });
      const audit = (await auditRows(fx, "webdesk.media.upload")).find((r) => r.args_hash === expected);
      expect(audit, "an upload audit row whose args carry reviewState quarantined").toBeTruthy();
      expect(audit?.actor).toBe("contrib-1");
    });

    it("a STAFF upload is unchanged: the token does not quarantine, the asset is accepted and served (the positive control)", async () => {
      const { minted, up, png } = await uploadAs(STAFF_ED);
      expect(minted.quarantined).toBe(false);
      expect(up.statusCode, up.body).toBe(201);
      const asset = up.json();
      expect(asset.reviewState).toBe("accepted");
      expect(await getAsset(fx, asset.assetId)).toMatchObject({ review_state: "accepted" });
      const served = await serve(fx, asset.assetId);
      expect(served.statusCode).toBe(200);
      expect(Buffer.compare(served.rawPayload, png)).toBe(0);
    });

    it("a row that exists before the migration, or any row nobody names a state for, is accepted (the column default)", async () => {
      const seeded = await seedAsset(fx, { title: "legacy" });
      expect(await getAsset(fx, seeded.id)).toMatchObject({ review_state: "accepted" });
    });

    it("the state cannot be chosen by the uploader: the quarantine is read from the token minted for the principal, never from the upload request", async () => {
      const staff = await mintAs(STAFF_ED);
      const up = await uploadFile(app, fx.slug, staff.json().token, buildPng(), { extraHeaders: { "x-quarantine": "true", "x-review-state": "quarantined" } });
      expect(up.statusCode, up.body).toBe(201);
      expect(up.json().reviewState).toBe("accepted");
      const contrib = await mintAs(CONTRIBUTOR);
      const up2 = await uploadFile(app, fx.slug, contrib.json().token, buildPng(), { extraHeaders: { "x-review-state": "accepted" } });
      expect(up2.json().reviewState).toBe("quarantined");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("serving: a quarantined or rejected asset is served by NO route", () => {
    it("404 on the public media route by id, by an upper-cased id, on the transform route, and under another tenant's slug; the bytes never leave", async () => {
      const { up, png } = await uploadAs(CONTRIBUTOR);
      const id = up.json().assetId as string;
      for (const url of [assetUrl(fx, id), assetUrl(fx, id.toUpperCase()), `${assetUrl(fx, id)}/transform?w=64`, assetUrl(other, id)]) {
        const r = await app.inject({ method: "GET", url });
        expect(r.statusCode, url).toBe(404);
        expect(Buffer.compare(r.rawPayload, png), url).not.toBe(0);
      }
      // positive control: an accepted asset of the same shape is served on the same route
      const staff = (await uploadAs(STAFF_ED)).up.json().assetId as string;
      expect((await serve(fx, staff)).statusCode).toBe(200);
      // The transform route answers 404 for EVERY asset where imgproxy is not wired, so its 404 above proves little. Both public
      // routes resolve the asset through ONE lookup, and that is where the wall is: the lookup refuses the quarantined one and
      // finds the accepted one.
      const media = app.get(MediaService);
      expect(await media.getPublicAsset(fx.tenantId, id)).toBeNull();
      expect(await media.getPublicAsset(fx.tenantId, staff)).toMatchObject({ id: staff, tenantId: fx.tenantId });
    });

    it("it is absent from the default library listing, and visible only to an explicit reviewState=quarantined (or all) read", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      const ids = (r: { json: () => any }) => (r.json().assets as Array<{ assetId: string }>).map((a) => a.assetId);
      expect(ids(await listMedia(app, fx))).not.toContain(id);
      expect(ids(await listMedia(app, fx, "reviewState=accepted"))).not.toContain(id);
      const queue = await listMedia(app, fx, "reviewState=quarantined");
      expect(ids(queue)).toContain(id);
      expect((queue.json().assets as Array<{ reviewState: string }>).every((a) => a.reviewState === "quarantined")).toBe(true);
      expect(ids(await listMedia(app, fx, "reviewState=all"))).toContain(id);
      expect(ids(await listMedia(app, fx, `reviewState=all&assetId=${id}`))).toEqual([id]);
      expect((await listMedia(app, fx, "reviewState=pending")).statusCode).toBe(400);
      expect((await listMedia(app, fx, "assetId=not-a-uuid")).statusCode).toBe(400);
    });

    it("accept makes it served, by every route that serves an accepted asset", async () => {
      const { up, png } = await uploadAs(CONTRIBUTOR);
      const id = up.json().assetId as string;
      expect((await serve(fx, id)).statusCode).toBe(404);
      const r = await review(id, "accept", STAFF_ED);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ decision: "accept", alreadyDecided: false, asset: { assetId: id, reviewState: "accepted", reviewedBy: STAFF_ED } });
      const served = await serve(fx, id);
      expect(served.statusCode).toBe(200);
      expect(Buffer.compare(served.rawPayload, png)).toBe(0);
      expect(await getAsset(fx, id)).toMatchObject({ review_state: "accepted", reviewed_by: STAFF_ED });
      expect(((await getAsset(fx, id)) as any).reviewed_at).not.toBeNull();
      const ids = ((await listMedia(app, fx)).json().assets as Array<{ assetId: string }>).map((a) => a.assetId);
      expect(ids).toContain(id);
    });

    it("reject: never served, not in the library, soft-deleted exactly like media.delete (purge_after = deleted_at + the bucket retention), and the state stays rejected", async () => {
      const { up } = await uploadAs(CONTRIBUTOR);
      const id = up.json().assetId as string;
      const r = await review(id, "reject", STAFF_ED);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ decision: "reject", alreadyDecided: false, asset: { reviewState: "rejected", reviewedBy: STAFF_ED } });
      expect((await serve(fx, id)).statusCode).toBe(404);
      expect(`${assetUrl(fx, id)}/transform`).toBeTruthy();
      expect((await app.inject({ method: "GET", url: `${assetUrl(fx, id)}/transform?w=64` })).statusCode).toBe(404);
      const row = (await getAsset(fx, id)) as Record<string, any>;
      expect(row.review_state).toBe("rejected");
      expect(row.deleted_at).not.toBeNull();
      expect(row.purged_at).toBeNull();
      const days = await asTenant(fx.tenantId, async (c) =>
        Number((await c.query(`SELECT extract(epoch FROM (purge_after - deleted_at)) / 86400 AS d FROM media_assets WHERE id = $1`, [id])).rows[0].d),
      );
      expect(Math.round(days)).toBe(storageConfig.objectLockRetentionDays);
      const ids = ((await listMedia(app, fx, "reviewState=all")).json().assets as Array<{ assetId: string }>).map((a) => a.assetId);
      expect(ids).not.toContain(id); // soft-deleted: hidden unless includeDeleted
      const withDeleted = (await listMedia(app, fx, "reviewState=rejected&includeDeleted=true")).json().assets as Array<{ assetId: string }>;
      expect(withDeleted.map((a) => a.assetId)).toContain(id);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("publishing: content cannot go public naming an unaccepted asset", () => {
    const newItem = async (assetId: string) => {
      const slug = `service.q-${randomUUID().slice(0, 8)}`;
      const body = serviceFields({ body: `# Hero\n\n![hero](/v1/t/${fx.slug}/media/${assetId})` });
      const c = await createItem(app, fx, { collectionKey: "service", locale: "en", slug, fields: body });
      expect(c.statusCode, c.body).toBe(201); // a DRAFT may name a quarantined asset: staff preview it, the url just 404s
      return c.json().item.itemId as string;
    };
    const itemState = async (itemId: string) => asTenant(fx.tenantId, async (c) => (await c.query(`SELECT publish_state FROM content_items WHERE id = $1`, [itemId])).rows[0].publish_state as string);

    it("publish is 409 media-not-accepted while the asset is quarantined, writes nothing, and succeeds after accept (same request)", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      const itemId = await newItem(id);
      const refused = await publishItems(app, fx, [{ itemId, version: 1 }]);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(problemType(refused)).toBe(`${PROBLEM}media-not-accepted`);
      expect(refused.json()).toMatchObject({ total: 1, assets: [{ assetId: id, reviewState: "quarantined", itemIndex: 0 }] });
      expect(await itemState(itemId)).toBe("draft");
      expect((await review(id, "accept", STAFF_ED)).statusCode).toBe(200);
      const ok = await publishItems(app, fx, [{ itemId, version: 1 }]);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await itemState(itemId)).toBe("published");
    });

    it("a rejected asset blocks publishing for good, and the whole batch is refused (one bad item publishes none)", async () => {
      const bad = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      expect((await review(bad, "reject", STAFF_ED)).statusCode).toBe(200);
      const staffAsset = (await uploadAs(STAFF_ED)).up.json().assetId as string;
      const badItem = await newItem(bad);
      const goodItem = await newItem(staffAsset);
      const refused = await publishItems(app, fx, [{ itemId: goodItem, version: 1 }, { itemId: badItem, version: 1 }]);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().assets).toMatchObject([{ assetId: bad, reviewState: "rejected", itemIndex: 1 }]);
      expect(await itemState(goodItem)).toBe("draft");
      expect(await itemState(badItem)).toBe("draft");
      // control: the accepted asset's item alone publishes
      expect((await publishItems(app, fx, [{ itemId: goodItem, version: 1 }])).statusCode).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the scan still gates a contributor's upload", () => {
    it("an infected file is refused 403 upload-infected and leaves no asset row, quarantined or otherwise", async () => {
      const f = await createContentFixture("w1q-scan");
      const m = (await mintAs(CONTRIBUTOR, { bucket: "media", mime: "application/pdf" }, f)).json();
      const res = await uploadFile(app, f.slug, m.token, buildEicarPdf(), { contentType: "application/pdf" });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().type).toBe(`${PROBLEM}upload-infected`);
      expect(await dumpAssets(f)).toHaveLength(0);
      expect((await dumpTokens(f))[0].used_at).not.toBeNull(); // spent, fail closed, exactly as for staff
      expect((await auditRows(f, "webdesk.media.uploadRefused")).length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("media.review: who may decide, and what a decision is", () => {
    it("a contributor (xc) and a client editor (ce) are refused 403 and the asset stays quarantined; staff decide the SAME request", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      const xc = await review(id, "accept", JSON.stringify({ sub: "contrib-2", xc: true }));
      expect(xc.statusCode, xc.body).toBe(403);
      expect(problemType(xc)).toBe(`${PROBLEM}contributor-command-not-allowed`);
      const ce = await review(id, "accept", CLIENT);
      expect(ce.statusCode, ce.body).toBe(403);
      expect(problemType(ce)).toBe(`${PROBLEM}client-command-not-allowed`);
      expect(await getAsset(fx, id)).toMatchObject({ review_state: "quarantined" });
      expect((await review(id, "accept", STAFF_ED)).statusCode).toBe(200);
    });

    it("the uploader cannot review their own upload (403 media-self-review, nothing changes); another staff editor can", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      // the same sub as the uploader, signed WITHOUT xc (a mis-marked staff assertion): still refused
      const self = await review(id, "accept", "contrib-1");
      expect(self.statusCode, self.body).toBe(403);
      expect(problemType(self)).toBe(`${PROBLEM}media-self-review`);
      expect(await getAsset(fx, id)).toMatchObject({ review_state: "quarantined", reviewed_by: null });
      expect((await review(id, "reject", "contrib-1")).statusCode).toBe(403);
      expect((await review(id, "accept", STAFF_OTHER)).statusCode).toBe(200);
    });

    it("the same decision again is a no-op that keeps the first reviewer; the opposite decision is 409 media-not-quarantined (a decision is final)", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      expect((await review(id, "accept", STAFF_ED)).statusCode).toBe(200);
      const again = await review(id, "accept", STAFF_OTHER); // a new Idempotency-Key, so the command really runs again
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ alreadyDecided: true, asset: { reviewState: "accepted", reviewedBy: STAFF_ED } });
      const flip = await review(id, "reject", STAFF_OTHER);
      expect(flip.statusCode, flip.body).toBe(409);
      expect(problemType(flip)).toBe(`${PROBLEM}media-not-quarantined`);
      expect(await getAsset(fx, id)).toMatchObject({ review_state: "accepted", reviewed_by: STAFF_ED });
      // and a rejected asset cannot be accepted later
      const id2 = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      expect((await review(id2, "reject", STAFF_ED)).statusCode).toBe(200);
      const late = await review(id2, "accept", STAFF_OTHER);
      expect(late.statusCode, late.body).toBe(409);
      expect(problemType(late)).toBe(`${PROBLEM}media-not-quarantined`);
      expect((await serve(fx, id2)).statusCode).toBe(404);
    });

    it("an asset that never needed a review (a staff upload) is 409 media-not-quarantined; an unknown, malformed or another site's asset is one 404", async () => {
      const staffAsset = (await uploadAs(STAFF_ED)).up.json().assetId as string;
      const never = await review(staffAsset, "accept", STAFF_OTHER);
      expect(never.statusCode, never.body).toBe(409);
      expect(problemType(never)).toBe(`${PROBLEM}media-not-quarantined`);
      expect(await getAsset(fx, staffAsset)).toMatchObject({ review_state: "accepted", reviewed_by: null });
      for (const id of [randomUUID(), "not-a-uuid"]) {
        const r = await review(id, "accept", STAFF_ED);
        expect(r.statusCode, id).toBe(404);
        expect(problemType(r)).toBe(`${PROBLEM}media-asset-not-found`);
      }
      const theirs = (await uploadAs(CONTRIBUTOR, other)).up.json().assetId as string;
      const cross = await review(theirs, "accept", STAFF_ED); // on OUR site's route
      expect(cross.statusCode).toBe(404);
      expect(await getAsset(other, theirs)).toMatchObject({ review_state: "quarantined" });
    });

    it("an asset a staff editor already deleted cannot be reviewed (409 media-asset-deleted)", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      const del = await app.inject({ method: "DELETE", url: `${mediaBase(fx)}/${id}`, headers: hdr({ editorial: STAFF_ED }) });
      expect(del.statusCode, del.body).toBe(200);
      const r = await review(id, "accept", STAFF_OTHER);
      expect(r.statusCode, r.body).toBe(409);
      expect(problemType(r)).toBe(`${PROBLEM}media-asset-deleted`);
    });

    it("validation: the body is {decision: accept|reject} and nothing else; a bad body writes nothing (and is not what refused a contributor)", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      for (const payload of [{ decision: "maybe" }, {}, { decision: "accept", extra: 1 }, { decision: "accept", assetId: id }]) {
        const r = await app.inject({ method: "POST", url: `${mediaBase(fx)}/${id}/review`, headers: hdr({ editorial: STAFF_ED }), payload });
        expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      }
      expect(await getAsset(fx, id)).toMatchObject({ review_state: "quarantined" });
      const noKey = await app.inject({ method: "POST", url: `${mediaBase(fx)}/${id}/review`, headers: hdr({ editorial: STAFF_ED, idem: null }), payload: { decision: "accept" } });
      expect(noKey.statusCode).toBe(400);
    });

    it("the review is an audited control command: one `control.media.review` row naming the decision", async () => {
      const id = (await uploadAs(CONTRIBUTOR)).up.json().assetId as string;
      expect((await review(id, "reject", STAFF_ED)).statusCode).toBe(200);
      const want = sha("review args", { tenantSlug: fx.slug, siteId: fx.siteId, assetId: id, decision: "reject" });
      const rows = (await auditRows(fx, "control.media.review")).filter((r) => r.args_hash === want);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toBe(STAFF_ED);
    });
  });

  it("base() is the content route (sanity for the helpers above)", () => {
    expect(base(fx)).toBe(`/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/content`);
  });
});
