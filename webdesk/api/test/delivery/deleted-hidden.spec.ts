// WSK-41b — a soft-deleted content item (content_items.deleted_at IS NOT NULL, migration 0009) must
// disappear from every public /v1 read: the item route, the list, search, and a sibling's
// `localizations`. The positive control is the same shape with deleted_at NULL, so a green result
// here cannot come from the fixtures simply being invisible.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { startTestApp, stopTestApp } from "../helpers/app";
import { createFixtureTenant, seedContentItem, type FixtureTenant } from "../helpers/fixtures";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";

type MintedKey = { id: string; key: string };

const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

async function mint(app: NestFastifyApplication, t: FixtureTenant, envId: string): Promise<MintedKey> {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${t.slug}/api-keys`,
    payload: { envId, scope: "read", actor: "wsk41b-test" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<MintedKey>();
}

/** Raw write as webdesk_migrator with the tenant GUC set, the same way the other fixtures do. */
async function writeAs(t: FixtureTenant, sql: string, params: unknown[]): Promise<void> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [t.tenantId]);
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Seeds three published items: `deletedprobe` (en-US), and a twin pair `twinen` (en-US) /
 * `twinfr` (fr-FR) sharing one localization group. When `deleted` is true, `deletedprobe` and
 * `twinfr` get deleted_at set; otherwise the identical rows are left live (the positive control).
 */
async function seedTwins(t: FixtureTenant, deleted: boolean): Promise<void> {
  const probeId = await seedContentItem(t, { slug: "deletedprobe", locale: "en-US", publishState: "published" });
  const twinEnId = await seedContentItem(t, { slug: "twinen", locale: "en-US", publishState: "published" });
  const twinFrId = await seedContentItem(t, { slug: "twinfr", locale: "fr-FR", publishState: "published" });
  const groupId = randomUUID();
  await writeAs(t, `UPDATE content_items SET localization_group_id = $1 WHERE id = ANY($2::uuid[])`, [
    groupId,
    [twinEnId, twinFrId],
  ]);
  if (deleted) {
    await writeAs(t, `UPDATE content_items SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [
      [probeId, twinFrId],
    ]);
  }
}

describe("WSK-41b — soft-deleted items are hidden from every /v1 read", () => {
  let app: NestFastifyApplication;
  let deletedT: FixtureTenant;
  let controlT: FixtureTenant;
  let deletedKey: MintedKey;
  let controlKey: MintedKey;

  beforeAll(async () => {
    app = await startTestApp();
    deletedT = await createFixtureTenant("deleted");
    controlT = await createFixtureTenant("deleted-control");
    deletedKey = await mint(app, deletedT, deletedT.productionEnvId);
    controlKey = await mint(app, controlT, controlT.productionEnvId);
    await seedTwins(deletedT, true);
    await seedTwins(controlT, false);
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  describe("deleted_at set", () => {
    it("item route: 404 item-not-found", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${deletedT.slug}/case-study/deletedprobe?locale=en-US`,
        headers: bearer(deletedKey.key),
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toBe("application/problem+json");
      expect(res.json<{ type: string }>().type).toMatch(/item-not-found$/);
    });

    it("list: the deleted item is absent, its live sibling is present", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${deletedT.slug}/case-study?locale=en-US`,
        headers: bearer(deletedKey.key),
      });
      expect(res.statusCode).toBe(200);
      const slugs = res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug);
      expect(slugs).toContain("twinen");
      expect(slugs).not.toContain("deletedprobe");
    });

    it("search: the deleted item is absent", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${deletedT.slug}/search?q=deletedprobe&locale=en-US`,
        headers: bearer(deletedKey.key),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual([]);
    });

    it("localizations: the deleted fr-FR twin is absent from its sibling's localizations", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${deletedT.slug}/case-study/twinen?locale=en-US`,
        headers: bearer(deletedKey.key),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ localizations: { locale: string; slug: string }[] }>().localizations).toEqual([]);
    });
  });

  describe("positive control: identical rows with deleted_at NULL", () => {
    it("item route: 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/v1/t/${controlT.slug}/case-study/deletedprobe?locale=en-US`,
        headers: bearer(controlKey.key),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ slug: string }>().slug).toBe("deletedprobe");
    });

    it("list, search and localizations all include it", async () => {
      const list = await app.inject({
        method: "GET",
        url: `/v1/t/${controlT.slug}/case-study?locale=en-US`,
        headers: bearer(controlKey.key),
      });
      expect(list.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toContain("deletedprobe");

      const search = await app.inject({
        method: "GET",
        url: `/v1/t/${controlT.slug}/search?q=deletedprobe&locale=en-US`,
        headers: bearer(controlKey.key),
      });
      expect(search.json<{ items: { slug: string }[] }>().items.map((i) => i.slug)).toEqual(["deletedprobe"]);

      const sibling = await app.inject({
        method: "GET",
        url: `/v1/t/${controlT.slug}/case-study/twinen?locale=en-US`,
        headers: bearer(controlKey.key),
      });
      expect(sibling.json<{ localizations: { locale: string; slug: string }[] }>().localizations).toEqual([
        { locale: "fr-FR", slug: "twinfr" },
      ]);
    });
  });
});
