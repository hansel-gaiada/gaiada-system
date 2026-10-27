// SCP-2b — a design's stored thumbnail against live Postgres (design-thumbs.ts; FRONTEND-BFF-CONTRACT §63.8 "Thumbnails").
// Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real. The resize needs no mocks (real sharp on small
// generated images); the storage backend is an in-memory map. The reads are driven the way a person reaches them: the feed's
// page extras through the real query, and the designer's queue through the real endpoint with the real policies.
//
// What it proves:
//   (1) a stored image design gets a thumbnail: a `files` row on the same post (role NULL, WebP, `<name>-thumb.webp`, the design
//       file's uploader), its bytes in storage and no larger than 640 x 640, remembered on `thumb_file_id`; a small image is not
//       enlarged; a video keeps no thumbnail; a link-only design is not a candidate; a second run does nothing;
//   (2) a resizer that cannot load is counted as a failure and changes nothing (no row, no throw), and a later run makes the thumbnail;
//   (3) the reads answer the thumbnail when there is one and the full file when there is not (feed extras, designer's queue);
//   (4) a design that moves to a new file (a newer asset version) loses its old thumbnail and gets a fresh one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { buildApp } from "../../../main";
import { setStorageForTest, localStorage as diskStorage, type StorageBackend } from "../../../core/storage";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { ensureDesignThumbs } from "./design-thumbs";
import { readFeedPageExtras } from "./feed-data";

const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };

interface Design { designId: string; fileId: string }

describe.skipIf(!TEST_URL)("SCP-2b · a design's stored thumbnail", () => {
  let app: NestFastifyApplication;
  let A: string;
  let designer: string;
  let engagementId: string;
  let cycleId: string;
  const bytes = new Map<string, Buffer>();
  const memory: StorageBackend = {
    async put(key, data) { bytes.set(key, data); },
    async get(key) { const b = bytes.get(key); if (!b) throw new Error(`no bytes for ${key}`); return b; },
    async del(key) { bytes.delete(key); },
  };

  const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();

  async function newPost(title: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, format, pipeline_status, status_since, creative_source, creative_state, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'feed', 'design', now(), 'in_team', 'not_started', 'central')`,
      [id, A, engagementId, cycleId, title],
    );
    return id;
  }

  /** A stored design: the asset, the materialized `files` row (bytes in the memory storage) and the design row pointing at both. */
  async function addDesign(postId: string, position: number, name: string, contentType: string, data: Buffer | null): Promise<Design> {
    const assetId = newId();
    const fileId = newId();
    const designId = newId();
    const key = `${A}/${fileId}`;
    if (data) bytes.set(key, data);
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, 'central')`,
      [assetId, A, designer, name, contentType, key, data?.byteLength ?? 0],
    );
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'social_post', $4, $5, $6, $7, $8, false, 'central')`,
      [fileId, A, designer, postId, name, contentType, data?.byteLength ?? 0, key],
    );
    await adminPool().query(
      `INSERT INTO social_post_designs (id, tenant_id, post_id, position, asset_group_id, file_id, file_version_no, added_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'central')`,
      [designId, A, postId, position, assetId, fileId, designer],
    );
    return { designId, fileId };
  }

  const designRow = async (designId: string) =>
    (await adminPool().query(`SELECT file_id::text AS file_id, thumb_file_id::text AS thumb_file_id FROM social_post_designs WHERE id = $1`, [designId])).rows[0] as
      { file_id: string; thumb_file_id: string | null };
  const fileRow = async (id: string) =>
    (await adminPool().query(
      `SELECT target_entity_type, target_entity_id::text AS post_id, role, filename, content_type, byte_size::int AS byte_size, storage_key, uploader_id::text AS uploader_id, scrubbed, sha256
         FROM files WHERE id = $1`, [id])).rows[0];
  const fileCount = async (postId: string) =>
    (await adminPool().query(`SELECT count(*)::int AS n FROM files WHERE target_entity_type = 'social_post' AND target_entity_id = $1`, [postId])).rows[0].n as number;
  const extras = (postIds: string[]) => withTenants([A], (c) => readFeedPageExtras(c, A, postIds, []), SOCIAL);
  const queue = async () => {
    const res = await app.inject({ method: "GET", url: `/api/${A}/modules/social/design-queue`, headers: { ...SVC, "x-user-id": designer } });
    expect(res.statusCode, res.body).toBe(200);
    return new Map((res.json().items as Array<{ postId: string; thumbFileId: string | null }>).map((i) => [i.postId, i.thumbFileId]));
  };

  let postImages: string; let big: Design; let small: Design; let video: Design;
  let postRetry: string; let retry: Design;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);
    setStorageForTest(memory);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    await seedSocialOrgTree(A);
    designer = await createUser("scp2b-designer@mock.test", "Mock designer");
    await addMembership(A, designer);
    await grantSocialRole(A, designer, "member");
    await grantSocialRole(A, designer, "social_designer");

    const clientId = await createClient(A, "Mock Client");
    engagementId = newId();
    cycleId = newId();
    await adminPool().query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
       VALUES ($1, $2, $3, 'Mock engagement', $4, 'active', '{"networks":{"instagram":true}}', 'in_team', '{instagram}', 'central')`,
      [engagementId, A, clientId, designer],
    );
    await adminPool().query(
      `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site) VALUES ($1, $2, $3, '2040-03-01', '2040-02-26', '2040-02-24', 'central')`,
      [cycleId, A, engagementId],
    );
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    setStorageForTest(diskStorage);
    await teardownTestDb();
  });

  it("a stored image gets a WebP thumbnail on the same post; a small one is not enlarged; a video and a link-only design get none", async () => {
    postImages = await newPost("Mock bakery: morning pastries");
    big = await addDesign(postImages, 1, "morning pastries.png", "image/png", await png(2000, 1000));
    small = await addDesign(postImages, 2, "badge.png", "image/png", await png(120, 80));
    video = await addDesign(postImages, 3, "teaser.mp4", "video/mp4", Buffer.from("not really a video"));
    await adminPool().query(
      `INSERT INTO social_post_designs (id, tenant_id, post_id, position, link_url, link_source, added_by, origin_site)
       VALUES ($1, $2, $3, 4, 'https://example.invalid/design', 'own', $4, 'central')`, [newId(), A, postImages, designer]);

    expect(await ensureDesignThumbs(A, postImages)).toEqual({ made: 2, skipped: 1, failed: 0 });

    const bigRow = await designRow(big.designId);
    expect(bigRow.file_id).toBe(big.fileId); // the full file is untouched
    expect(bigRow.thumb_file_id).toMatch(/^[0-9a-f-]{36}$/);
    const thumb = await fileRow(bigRow.thumb_file_id!);
    expect(thumb).toMatchObject({
      target_entity_type: "social_post", post_id: postImages, role: null, filename: "morning pastries-thumb.webp", content_type: "image/webp",
      uploader_id: designer, scrubbed: false,
    });
    expect(thumb.sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = await memory.get(thumb.storage_key);
    expect(stored.byteLength).toBe(thumb.byte_size);
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 640, 320]);

    const smallRow = await designRow(small.designId);
    expect(smallRow.thumb_file_id).not.toBeNull();
    const smallMeta = await sharp(await memory.get((await fileRow(smallRow.thumb_file_id!)).storage_key)).metadata();
    expect([smallMeta.format, smallMeta.width, smallMeta.height]).toEqual(["webp", 120, 80]);

    expect((await designRow(video.designId)).thumb_file_id).toBeNull();
    // the post's three design files plus the two thumbnails: none for the video
    expect(await fileCount(postImages)).toBe(5);
  });

  it("a second run makes nothing more (the video is still skipped)", async () => {
    const before = await fileCount(postImages);
    expect(await ensureDesignThumbs(A, postImages)).toEqual({ made: 0, skipped: 1, failed: 0 });
    expect(await fileCount(postImages)).toBe(before);
  });

  it("a resizer that cannot load counts a failure and changes nothing; the next run makes the thumbnail", async () => {
    postRetry = await newPost("Mock florist: autumn bouquets");
    retry = await addDesign(postRetry, 1, "bouquet.png", "image/png", await png(1200, 1200));
    expect(await ensureDesignThumbs(A, postRetry, async () => null)).toEqual({ made: 0, skipped: 0, failed: 1 });
    expect((await designRow(retry.designId)).thumb_file_id).toBeNull();
    expect(await fileCount(postRetry)).toBe(1);

    expect(await ensureDesignThumbs(A, postRetry)).toEqual({ made: 1, skipped: 0, failed: 0 });
    expect((await designRow(retry.designId)).thumb_file_id).not.toBeNull();
  });

  it("a file whose bytes are gone or are not an image counts a failure, never a throw, and leaves no thumbnail", async () => {
    const post = await newPost("Mock spa: winter warmth");
    const gone = await addDesign(post, 1, "gone.png", "image/png", null);
    const broken = await addDesign(post, 2, "broken.png", "image/png", Buffer.from("not an image at all"));
    expect(await ensureDesignThumbs(A, post)).toEqual({ made: 0, skipped: 0, failed: 2 });
    expect((await designRow(gone.designId)).thumb_file_id).toBeNull();
    expect((await designRow(broken.designId)).thumb_file_id).toBeNull();
    expect(await fileCount(post)).toBe(2);
  });

  it("a removed design and a post with no designs are no candidates", async () => {
    const post = await newPost("Mock cafe: a removed design");
    const d = await addDesign(post, 1, "removed.png", "image/png", await png(50, 50));
    await adminPool().query(`UPDATE social_post_designs SET removed_at = now(), removed_by = $2 WHERE id = $1`, [d.designId, designer]);
    expect(await ensureDesignThumbs(A, post)).toEqual({ made: 0, skipped: 0, failed: 0 });
    expect(await ensureDesignThumbs(A, newId())).toEqual({ made: 0, skipped: 0, failed: 0 });
  });

  it("the reads answer the thumbnail when there is one and the full file when there is not", async () => {
    const postVideo = await newPost("Mock gym: a video only");
    const onlyVideo = await addDesign(postVideo, 1, "reel.mp4", "video/mp4", Buffer.from("not really a video"));
    await ensureDesignThumbs(A, postVideo);
    const bigThumb = (await designRow(big.designId)).thumb_file_id;
    const retryThumb = (await designRow(retry.designId)).thumb_file_id;
    expect(bigThumb).not.toBeNull();
    expect(bigThumb).not.toBe(big.fileId);

    // The feed's page extras (the first design of each post, by position).
    const feed = await extras([postImages, postVideo, postRetry]);
    expect(feed.thumbs.get(postImages)).toBe(bigThumb);
    expect(feed.thumbs.get(postRetry)).toBe(retryThumb);
    expect(feed.thumbs.get(postVideo)).toBe(onlyVideo.fileId); // no thumbnail: the full file

    // The designer's queue, through the real endpoint.
    const q = await queue();
    expect(q.get(postImages)).toBe(bigThumb);
    expect(q.get(postRetry)).toBe(retryThumb);
    expect(q.get(postVideo)).toBe(onlyVideo.fileId);
  });

  it("a design that moves to a new file loses its old thumbnail, so the next run makes a fresh one", async () => {
    // What materializeDesignMedia does when the asset has a newer version: file_id moves, thumb_file_id clears.
    const post = await newPost("Mock bakery: a new version");
    const d = await addDesign(post, 1, "v1.png", "image/png", await png(900, 900));
    await ensureDesignThumbs(A, post);
    const firstThumb = (await designRow(d.designId)).thumb_file_id;
    expect(firstThumb).not.toBeNull();

    const v2 = newId();
    const key = `${A}/${v2}`;
    bytes.set(key, await png(300, 100));
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
       VALUES ($1, $2, $3, 'social_post', $4, 'v2.png', 'image/png', 10, $5, false, 'central')`, [v2, A, designer, post, key]);
    await adminPool().query(`UPDATE social_post_designs SET file_id = $2, file_version_no = 2, thumb_file_id = NULL WHERE id = $1`, [d.designId, v2]);
    expect(await ensureDesignThumbs(A, post)).toEqual({ made: 1, skipped: 0, failed: 0 });
    const after = await designRow(d.designId);
    expect(after.thumb_file_id).not.toBe(firstThumb);
    const meta = await sharp(await memory.get((await fileRow(after.thumb_file_id!)).storage_key)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 100]);
  });
});
