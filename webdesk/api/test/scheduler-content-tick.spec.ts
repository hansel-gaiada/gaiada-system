// WSK-61 — the content tick, end to end: due publishes, due takedowns, version swaps on live items,
// cancellation, validation failure, and concurrency. Real Postgres (0001-0012, webdesk_app
// NOBYPASSRLS), real Redis, the real AppModule and the REAL Layer-3/4 PolicyDecisionPoint (see
// content-test-kit.ts). The scheduler is OFF in this app (NODE_ENV=test default), so nothing ticks by
// itself: every test calls ContentTickService.runContentTick() directly with an injected clock, which
// is what makes the time-dependent behaviour deterministic. The wiring and config are in
// scheduler-wiring.spec.ts.
//
// Time. content.schedule only accepts a FUTURE publishAt, so each test schedules for `Date.now() + 1h`
// and ticks at an injected `+30min` (not due) and `+2h` (due). The /v1 reads use the database clock,
// so what they show is the stored state the tick produced, which is exactly what is under test.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the local HTTPS webhook sink's self-signed cert (test-only)
process.env.TENANT_WEBHOOK_QUEUE_NAME = `wsk61-tick-${Date.now()}`;
process.env.TENANT_WEBHOOK_BACKOFF_DELAY_MS = "200";
process.env.TENANT_WEBHOOK_MAX_ATTEMPTS = "2";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  MIGRATOR_URL,
  asPlatform,
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  createItem,
  hdr,
  mintReadKeys,
  publishItems,
  serviceFields,
  v1Get,
  waitFor,
  ws4For,
  type ContentFixture,
} from "./content-test-kit";
import { AuditService } from "../src/audit/audit.service";
import { PgIdempotencyStore } from "../src/control/idempotency/pg-idempotency-store";
import { SubmissionsPurgeService } from "../src/forms/submissions-purge.service";
import { TenantWebhooksService } from "../src/tenant-webhooks/tenant-webhooks.service";
import { ContentTickService, SCHEDULE_EXECUTED_ACTION, SCHEDULER_ACTOR, type TenantTickResult } from "../src/scheduler/content-tick.service";
import { MaintenanceJobsService } from "../src/scheduler/maintenance-jobs.service";
import { TenantWebhookSink } from "./helpers/tenant-webhook-sink";

const HOUR = 3_600_000;
const EDITOR = "user-editor-1";

describe("WSK-61 content tick (real DB, injected clock)", () => {
  let app: NestFastifyApplication;
  let tick: ContentTickService;
  let audit: AuditService;
  let sink: TenantWebhookSink;

  beforeAll(async () => {
    sink = await TenantWebhookSink.start();
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = `127.0.0.1:${sink.port}`;
    app = await buildContentApp();
    tick = app.get(ContentTickService);
    audit = app.get(AuditService);
  });

  afterAll(async () => {
    await app?.close();
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = "";
    await sink?.stop();
  });

  // ----------------------------------------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------------------------------------
  interface Ctx {
    fx: ContentFixture;
    keys: { production: string; staging: string };
  }

  /** A tenant with read keys and a webhook registered for both content kinds. */
  async function newTenant(label: string): Promise<Ctx> {
    const fx = await createContentFixture(label);
    const keys = await mintReadKeys(app, fx);
    await app.get(TenantWebhooksService).register(fx.tenantId, {
      targetUrl: sink.url(),
      eventKinds: ["content.published", "content.unpublished"],
      description: label,
    });
    return { fx, keys };
  }

  const h1Of = (res: { json: () => { blocks: { props: { h1: string } }[] } }) => res.json().blocks[0].props.h1;

  async function create(c: Ctx, slug: string, h1 = "v1"): Promise<string> {
    const res = await createItem(app, c.fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1 }) });
    expect(res.statusCode).toBe(201);
    return res.json().item.itemId as string;
  }

  async function put(c: Ctx, itemId: string, baseVersion: number, h1: string) {
    const res = await app.inject({ method: "PUT", url: `${base(c.fx)}/items/${itemId}`, headers: hdr(), payload: { baseVersion, fields: serviceFields({ h1 }) } });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function live(c: Ctx, slug: string, h1 = "v1"): Promise<string> {
    const itemId = await create(c, slug, h1);
    expect((await publishItems(app, c.fx, [{ itemId, version: 1 }])).statusCode).toBe(200);
    return itemId;
  }

  async function schedule(c: Ctx, body: Record<string, unknown>, approvalId = `apr-${randomUUID()}`) {
    const ws4 = ws4For("content.schedule", { tenantSlug: c.fx.slug, siteId: c.fx.siteId }, body, approvalId);
    return app.inject({ method: "POST", url: `${base(c.fx)}/schedule`, headers: hdr({ ws4 }), payload: body });
  }

  async function unpublish(c: Ctx, itemId: string, expectedPublishedVersion: number) {
    return app.inject({ method: "POST", url: `${base(c.fx)}/items/${itemId}/unpublish`, headers: hdr(), payload: { expectedPublishedVersion } });
  }

  const item = (c: Ctx, itemId: string) =>
    asTenant(c.fx.tenantId, async (db) =>
      (
        await db.query(
          `SELECT publish_state, published_version, head_version, publish_at, unpublish_at, last_published_by, last_published_at, updated_at, deleted_at
             FROM content_items WHERE id = $1`,
          [itemId],
        )
      ).rows[0],
    );

  const swaps = (c: Ctx, itemId: string) =>
    asTenant(c.fx.tenantId, async (db) =>
      (await db.query(`SELECT * FROM content_schedules WHERE content_item_id = $1 ORDER BY created_at, id`, [itemId])).rows,
    );

  const auditRows = (c: Ctx) =>
    asTenant(c.fx.tenantId, async (db) =>
      (
        await db.query(
          `SELECT actor, action, args_hash, ws4_approval_id FROM audit_entries WHERE tenant_id = $1 AND action = $2 ORDER BY at, id`,
          [c.fx.tenantId, SCHEDULE_EXECUTED_ACTION],
        )
      ).rows,
    );

  const deliveries = (c: Ctx) =>
    asTenant(c.fx.tenantId, async (db) =>
      (
        await db.query(`SELECT kind, count(*)::int AS n FROM tenant_webhook_deliveries WHERE tenant_id = $1 GROUP BY kind ORDER BY kind`, [c.fx.tenantId])
      ).rows as { kind: string; n: number }[],
    );

  const mine = (c: Ctx, r: { tenants: TenantTickResult[] }) => r.tenants.find((t) => t.tenantId === c.fx.tenantId) as TenantTickResult;
  const hashOf = (args: Record<string, string | number | boolean | null>) => audit.hashArgs(args);

  // ----------------------------------------------------------------------------------------------
  // Due publishes
  // ----------------------------------------------------------------------------------------------
  it("publish: a scheduled item past publish_at becomes published after a tick (one audit row, one content.published); a future one is untouched", async () => {
    const c = await newTenant("pub");
    const itemId = await create(c, "service.tick-publish", "Scheduled H1");
    const publishAt = new Date(Date.now() + HOUR).toISOString();
    const sched = await schedule(c, { items: [{ itemId, version: 1 }], publishAt });
    expect(sched.statusCode).toBe(200);
    const before = await item(c, itemId);
    expect(before).toMatchObject({ publish_state: "scheduled", published_version: 1, last_published_by: EDITOR });

    // Not yet due: nothing changes, nothing is audited or announced.
    const early = mine(c, await tick.runContentTick(new Date(Date.now() + HOUR / 2)));
    expect(early).toMatchObject({ published: 0, swapped: 0, tookDown: 0, errors: 0 });
    expect((await item(c, itemId)).publish_state).toBe("scheduled");
    expect(await auditRows(c)).toHaveLength(0);

    // Due.
    const due = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(due).toMatchObject({ published: 1, swapped: 0, tookDown: 0, errors: 0 });
    const after = await item(c, itemId);
    expect(after.publish_state).toBe("published");
    expect(after.published_version).toBe(1);
    // Attribution and the projection were set at schedule time and are left alone; updated_at moves to
    // the instant it went live.
    expect(after.last_published_by).toBe(EDITOR);
    expect(after.last_published_at).toEqual(before.last_published_at);
    expect(new Date(after.updated_at).toISOString()).toBe(publishAt);
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.tick-publish"))).toBe("Scheduled H1");

    const rows = await auditRows(c);
    expect(rows).toEqual([
      { actor: SCHEDULER_ACTOR, action: SCHEDULE_EXECUTED_ACTION, args_hash: hashOf({ kind: "publish", itemId, version: 1 }), ws4_approval_id: null },
    ]);
    await waitFor(async () => (await deliveries(c)).length > 0, 5000);
    expect(await deliveries(c)).toEqual([{ kind: "content.published", n: 1 }]);

    // A second tick finds nothing left to do.
    const again = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(again).toMatchObject({ published: 0, errors: 0 });
    expect(await auditRows(c)).toHaveLength(1);
  });

  it("publish: the webhook payload carries the item ref and no values", async () => {
    const c = await newTenant("pubpayload");
    const SECRET = `secret-${randomUUID()}`;
    const itemId = await create(c, "service.tick-payload", SECRET);
    expect((await schedule(c, { items: [{ itemId, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    const got = await waitFor(async () => sink.received().find((r) => r.rawBody.includes(c.fx.tenantId) && r.rawBody.includes('"content.published"')), 15000);
    const env = JSON.parse(got.rawBody);
    expect(env.kind).toBe("content.published");
    expect(env.data.siteId).toBe(c.fx.siteId);
    expect(env.data.items).toEqual([{ itemId, collectionKey: "service", locale: "en", slug: "service.tick-payload", version: 1 }]);
    expect(got.rawBody).not.toContain(SECRET);
  });

  // ----------------------------------------------------------------------------------------------
  // Due takedowns
  // ----------------------------------------------------------------------------------------------
  it("takedown: after the tick the item is unpublished: production /v1 404s, staging sees the HEAD, one content.unpublished is enqueued", async () => {
    const c = await newTenant("down");
    const itemId = await live(c, "service.tick-down", "Live H1");
    await put(c, itemId, 1, "Draft H1 (v2)");
    const unpublishAt = new Date(Date.now() + HOUR).toISOString();
    const sched = await schedule(c, { items: [{ itemId, version: 1 }], unpublishAt });
    expect(sched.statusCode).toBe(200);
    expect((await item(c, itemId)).unpublish_at).not.toBeNull();
    expect((await v1Get(app, c.fx, c.keys.production, "service", "service.tick-down")).statusCode).toBe(200);

    const early = mine(c, await tick.runContentTick(new Date(Date.now() + HOUR / 2)));
    expect(early.tookDown).toBe(0);
    expect((await item(c, itemId)).publish_state).toBe("published");

    const due = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(due).toMatchObject({ tookDown: 1, published: 0, errors: 0 });
    expect(await item(c, itemId)).toMatchObject({ publish_state: "unpublished", published_version: null, publish_at: null, unpublish_at: null, head_version: 2 });
    expect((await v1Get(app, c.fx, c.keys.production, "service", "service.tick-down")).statusCode).toBe(404);
    const staging = await v1Get(app, c.fx, c.keys.staging, "service", "service.tick-down");
    expect(staging.statusCode).toBe(200);
    expect(h1Of(staging)).toBe("Draft H1 (v2)"); // the head, exactly as content.unpublish leaves it

    expect(await auditRows(c)).toEqual([
      { actor: SCHEDULER_ACTOR, action: SCHEDULE_EXECUTED_ACTION, args_hash: hashOf({ kind: "takedown", itemId, version: 1 }), ws4_approval_id: null },
    ]);
    await waitFor(async () => (await deliveries(c)).some((d) => d.kind === "content.unpublished"), 5000);
    expect(await deliveries(c)).toEqual([
      { kind: "content.published", n: 1 }, // the original publish command's own event
      { kind: "content.unpublished", n: 1 },
    ]);
  });

  it("takedown is exactly content.unpublish's effect: the same row state either way", async () => {
    const c = await newTenant("same");
    const viaCommand = await live(c, "service.same-cmd", "S");
    const viaTick = await live(c, "service.same-tick", "S");
    await put(c, viaCommand, 1, "S2");
    await put(c, viaTick, 1, "S2");
    expect((await unpublish(c, viaCommand, 1)).statusCode).toBe(200);
    expect((await schedule(c, { items: [{ itemId: viaTick, version: 1 }], unpublishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    const strip = (r: Record<string, unknown>) => ({ ...r, updated_at: undefined, last_published_at: undefined });
    expect(strip(await item(c, viaTick))).toEqual(strip(await item(c, viaCommand)));
  });

  // ----------------------------------------------------------------------------------------------
  // Version swaps on live items
  // ----------------------------------------------------------------------------------------------
  it("swap, end to end: schedule returns 200 with a pending row and production still serves the old version; a tick before publish_at changes nothing; a tick after makes production serve the new one", async () => {
    const c = await newTenant("swap");
    const itemId = await live(c, "service.tick-swap", "Old H1");
    await put(c, itemId, 1, "New H1");
    const beforeRow = await item(c, itemId);
    const publishAt = new Date(Date.now() + HOUR).toISOString();
    const approvalId = `apr-swap-${randomUUID()}`;

    const sched = await schedule(c, { items: [{ itemId, version: 2 }], publishAt }, approvalId);
    expect(sched.statusCode).toBe(200);
    expect(sched.json().scheduled).toEqual([
      { itemId, collectionKey: "service", locale: "en", slug: "service.tick-swap", version: 2, publishAt, unpublishAt: null },
    ]);
    expect(sched.json().replayed).toBe(false);

    const pending = await swaps(c, itemId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      tenant_id: c.fx.tenantId,
      site_id: c.fx.siteId,
      content_item_id: itemId,
      version: 2,
      requested_by: EDITOR,
      ws4_approval_id: approvalId,
      unpublish_at: null,
      executed_at: null,
      cancelled_at: null,
      failed_at: null,
    });
    expect(new Date(pending[0].publish_at).toISOString()).toBe(publishAt);
    // The projection is untouched.
    expect(await item(c, itemId)).toEqual(beforeRow);
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.tick-swap"))).toBe("Old H1");

    // A tick before publish_at: nothing.
    const early = mine(c, await tick.runContentTick(new Date(Date.now() + HOUR / 2)));
    expect(early).toMatchObject({ swapped: 0, swapsCancelled: 0, swapsFailed: 0, errors: 0 });
    expect(await item(c, itemId)).toEqual(beforeRow);
    expect((await swaps(c, itemId))[0].executed_at).toBeNull();
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.tick-swap"))).toBe("Old H1");

    // A tick after: production serves the new version.
    const due = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(due).toMatchObject({ swapped: 1, published: 0, tookDown: 0, errors: 0 });
    const after = await item(c, itemId);
    expect(after).toMatchObject({ publish_state: "published", published_version: 2, head_version: 2, publish_at: null, unpublish_at: null, last_published_by: EDITOR });
    expect(new Date(after.last_published_at).toISOString()).toBe(publishAt); // when it went live, not when the worker ran
    expect(new Date(after.updated_at).toISOString()).toBe(publishAt);
    const prod = await v1Get(app, c.fx, c.keys.production, "service", "service.tick-swap");
    expect(prod.statusCode).toBe(200);
    expect(h1Of(prod)).toBe("New H1");
    const done = (await swaps(c, itemId))[0];
    expect(done.executed_at).not.toBeNull();
    expect(done.cancelled_at).toBeNull();
    expect(done.failed_at).toBeNull();

    // Audit: the original approval is in the args, never in ws4_approval_id (0009's single-use index).
    expect(await auditRows(c)).toEqual([
      {
        actor: SCHEDULER_ACTOR,
        action: SCHEDULE_EXECUTED_ACTION,
        args_hash: hashOf({ kind: "swap", itemId, version: 2, approvalId }),
        ws4_approval_id: null,
      },
    ]);
    await waitFor(async () => (await deliveries(c)).find((d) => d.kind === "content.published")?.n === 2, 5000); // publish command + swap
    expect(await deliveries(c)).toEqual([{ kind: "content.published", n: 2 }]);

    // Idempotent: the swap is not applied twice.
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)))).toMatchObject({ swapped: 0 });
    expect(await auditRows(c)).toHaveLength(1);
  });

  it("swap: the new version's own takedown time becomes the item's unpublish_at", async () => {
    const c = await newTenant("swapwin");
    const itemId = await live(c, "service.swap-window", "Old");
    await put(c, itemId, 1, "New");
    const publishAt = new Date(Date.now() + HOUR).toISOString();
    const unpublishAt = new Date(Date.now() + 3 * HOUR).toISOString();
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt, unpublishAt })).statusCode).toBe(200);
    expect((await swaps(c, itemId))[0].unpublish_at).not.toBeNull();
    await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    expect(new Date((await item(c, itemId)).unpublish_at).toISOString()).toBe(unpublishAt);
    // ...and a later tick past it takes the item down.
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 4 * HOUR)))).toMatchObject({ tookDown: 1 });
    expect((await item(c, itemId)).publish_state).toBe("unpublished");
  });

  it("swap: a second schedule supersedes the first (one pending at a time; the loser is cancelled 'superseded')", async () => {
    const c = await newTenant("super");
    const itemId = await live(c, "service.swap-super", "V1");
    await put(c, itemId, 1, "V2");
    await put(c, itemId, 2, "V3");
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect((await schedule(c, { items: [{ itemId, version: 3 }], publishAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode).toBe(200);
    const rows = await swaps(c, itemId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 2, cancel_reason: "superseded" });
    expect(rows[0].cancelled_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ version: 3, cancelled_at: null, executed_at: null, failed_at: null });

    // Only the newest runs, and only when ITS time comes.
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 1.5 * HOUR)))).toMatchObject({ swapped: 0 });
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 3 * HOUR)))).toMatchObject({ swapped: 1 });
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.swap-super"))).toBe("V3");
    expect((await item(c, itemId)).published_version).toBe(3);
  });

  it("swap: publish, unpublish and delete each cancel a pending swap, in their own transaction", async () => {
    const c = await newTenant("cancel");

    // publish (of another version) -> 'superseded-by-publish'
    const a = await live(c, "service.cancel-publish", "A1");
    await put(c, a, 1, "A2");
    await put(c, a, 2, "A3");
    expect((await schedule(c, { items: [{ itemId: a, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect((await publishItems(app, c.fx, [{ itemId: a, version: 3 }])).statusCode).toBe(200);
    expect(await swaps(c, a)).toMatchObject([{ version: 2, cancel_reason: "superseded-by-publish" }]);
    expect((await swaps(c, a))[0].cancelled_at).not.toBeNull();
    await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.cancel-publish"))).toBe("A3"); // the swap never ran

    // unpublish -> 'unpublished'
    const b = await live(c, "service.cancel-unpublish", "B1");
    await put(c, b, 1, "B2");
    expect((await schedule(c, { items: [{ itemId: b, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect((await unpublish(c, b, 1)).statusCode).toBe(200);
    expect(await swaps(c, b)).toMatchObject([{ version: 2, cancel_reason: "unpublished" }]);
    const tickB = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(tickB.swapped).toBe(0);
    expect((await item(c, b)).publish_state).toBe("unpublished"); // a cancelled swap must not bring the item back
    expect((await v1Get(app, c.fx, c.keys.production, "service", "service.cancel-unpublish")).statusCode).toBe(404);

    // update and restoreVersion do NOT cancel: they never change what is live.
    const d = await live(c, "service.cancel-update", "D1");
    await put(c, d, 1, "D2");
    expect((await schedule(c, { items: [{ itemId: d, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    await put(c, d, 2, "D3");
    const restore = await app.inject({ method: "POST", url: `${base(c.fx)}/items/${d}/restore`, headers: hdr(), payload: { version: 1, baseVersion: 3 } });
    expect(restore.statusCode).toBe(200);
    expect(await swaps(c, d)).toMatchObject([{ version: 2, cancelled_at: null, cancel_reason: null }]);

    // delete: a live item cannot be deleted (409 item-is-live), so a pending swap normally never
    // reaches a delete. Make the state reachable at the database level (the item is no longer
    // live-like) to prove the command cancels in its own transaction when it does.
    const e = await live(c, "service.cancel-delete", "E1");
    await put(c, e, 1, "E2");
    expect((await schedule(c, { items: [{ itemId: e, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: `${base(c.fx)}/items/${e}/delete`, headers: hdr(), payload: { baseVersion: 2 } });
    expect(refused.statusCode).toBe(409);
    expect((await swaps(c, e))[0].cancelled_at).toBeNull(); // the refused delete rolled back: nothing was cancelled
    await asTenant(c.fx.tenantId, (db) => db.query(`UPDATE content_items SET published_version = NULL, publish_state = 'unpublished' WHERE id = $1`, [e]));
    const deleted = await app.inject({ method: "POST", url: `${base(c.fx)}/items/${e}/delete`, headers: hdr(), payload: { baseVersion: 2 } });
    expect(deleted.statusCode).toBe(200);
    expect(await swaps(c, e)).toMatchObject([{ version: 2, cancel_reason: "deleted" }]);
  });

  it("swap: a scheduled takedown and a pending swap reconcile (the newest decision is never silently undone)", async () => {
    const c = await newTenant("recon");

    // Swap at +2h, then a takedown at +3h: the takedown becomes the swap's own window, so it survives the swap.
    const a = await live(c, "service.recon-after", "A1");
    await put(c, a, 1, "A2");
    expect((await schedule(c, { items: [{ itemId: a, version: 2 }], publishAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode).toBe(200);
    const takedownAt = new Date(Date.now() + 3 * HOUR).toISOString();
    expect((await schedule(c, { items: [{ itemId: a, version: 1 }], unpublishAt: takedownAt })).statusCode).toBe(200);
    const aRows = await swaps(c, a);
    expect(aRows).toHaveLength(1);
    expect(new Date(aRows[0].unpublish_at).toISOString()).toBe(takedownAt);
    expect(aRows[0].cancelled_at).toBeNull();
    await tick.runContentTick(new Date(Date.now() + 2.5 * HOUR));
    expect(new Date((await item(c, a)).unpublish_at).toISOString()).toBe(takedownAt);
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 4 * HOUR)))).toMatchObject({ tookDown: 1 });

    // Swap at +2h, then a takedown at +1h: the item is down before the swap is due, so the swap is moot.
    const b = await live(c, "service.recon-before", "B1");
    await put(c, b, 1, "B2");
    expect((await schedule(c, { items: [{ itemId: b, version: 2 }], publishAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode).toBe(200);
    expect((await schedule(c, { items: [{ itemId: b, version: 1 }], unpublishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect(await swaps(c, b)).toMatchObject([{ version: 2, cancel_reason: "superseded" }]);
  });

  it("swap: an item that stopped being live by time before the swap fell due has the swap cancelled 'item-not-live' (and is then taken down)", async () => {
    const c = await newTenant("notlive");
    const itemId = await live(c, "service.not-live", "N1");
    await put(c, itemId, 1, "N2");
    // Takedown first at +1h, then a swap at +2h written in the gap the takedown left... the schedule
    // command reconciles a pending swap against a LATER takedown, so write the swap AFTER the takedown.
    expect((await schedule(c, { items: [{ itemId, version: 1 }], unpublishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode).toBe(200);
    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 3 * HOUR)));
    expect(r).toMatchObject({ swapped: 0, swapsCancelled: 1, tookDown: 1, errors: 0 });
    expect(await swaps(c, itemId)).toMatchObject([{ version: 2, cancel_reason: "item-not-live" }]);
    expect(await item(c, itemId)).toMatchObject({ publish_state: "unpublished", published_version: null });
    // The swap never brought it back.
    expect((await v1Get(app, c.fx, c.keys.production, "service", "service.not-live")).statusCode).toBe(404);
  });

  it("swap: a deleted item has its swap cancelled 'item-deleted' and nothing else changes", async () => {
    const c = await newTenant("deleted");
    const itemId = await live(c, "service.swap-deleted", "X1");
    await put(c, itemId, 1, "X2");
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    await asTenant(c.fx.tenantId, (db) => db.query(`UPDATE content_items SET deleted_at = now() WHERE id = $1`, [itemId]));
    const before = await item(c, itemId);
    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r).toMatchObject({ swapped: 0, swapsCancelled: 1, errors: 0 });
    expect(await swaps(c, itemId)).toMatchObject([{ version: 2, cancel_reason: "item-deleted" }]);
    expect(await item(c, itemId)).toEqual(before);
    expect(await auditRows(c)).toHaveLength(0);
  });

  it("swap: a version that no longer validates ends 'failed' with nothing changed", async () => {
    const c = await newTenant("fail");
    const itemId = await live(c, "service.swap-fail", "F1");
    await put(c, itemId, 1, "F2");
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    // The collection gains a required field the scheduled version does not have.
    await asTenant(c.fx.tenantId, async (db) => {
      const { rows } = await db.query(`SELECT schema FROM collections WHERE id = $1`, [c.fx.collections.service]);
      const schema = rows[0].schema;
      schema.fields.push({ name: "must_have", primitive: "text", required: true });
      await db.query(`UPDATE collections SET schema = $2::jsonb WHERE id = $1`, [c.fx.collections.service, JSON.stringify(schema)]);
    });
    const before = await item(c, itemId);

    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r).toMatchObject({ swapped: 0, swapsFailed: 1, errors: 0 });
    const [row] = await swaps(c, itemId);
    expect(row.failed_at).not.toBeNull();
    expect(row.executed_at).toBeNull();
    expect(row.cancelled_at).toBeNull();
    expect(row.fail_reason).toMatch(/no longer satisfies the collection's composition/);
    expect(row.fail_reason).toMatch(/must_have/);
    expect(await item(c, itemId)).toEqual(before);
    expect(h1Of(await v1Get(app, c.fx, c.keys.production, "service", "service.swap-fail"))).toBe("F1");
    expect(await auditRows(c)).toHaveLength(0);
    // Failed is terminal: the next tick does not retry it.
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 3 * HOUR)))).toMatchObject({ swapsFailed: 0 });
  });

  it("schedule: scheduling a non-live item still puts the version in the projection and cancels a pending swap the item was holding", async () => {
    const c = await newTenant("nonlive");
    const itemId = await live(c, "service.nonlive", "L1");
    await put(c, itemId, 1, "L2");
    expect((await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + 2 * HOUR).toISOString() })).statusCode).toBe(200);
    // The live version expires by time (a takedown scheduled earlier than the swap is due), then the
    // item is scheduled afresh: that newer decision replaces the swap it left behind.
    await asTenant(c.fx.tenantId, (db) => db.query(`UPDATE content_items SET unpublish_at = now() - interval '1 minute', publish_at = NULL WHERE id = $1`, [itemId]));
    const sched = await schedule(c, { items: [{ itemId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() });
    expect(sched.statusCode).toBe(200);
    expect(await item(c, itemId)).toMatchObject({ publish_state: "scheduled", published_version: 2 });
    expect(await swaps(c, itemId)).toMatchObject([{ version: 2, cancel_reason: "superseded" }]);
  });

  // ----------------------------------------------------------------------------------------------
  // Concurrency
  // ----------------------------------------------------------------------------------------------
  it("concurrency: two ticks in parallel over the same due items process each item exactly once (audit rows and webhooks counted)", async () => {
    const c = await newTenant("conc");
    const toPublish: string[] = [];
    const toSwap = new Map<string, string>(); // itemId -> the swap's approval id
    const toTakeDown: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await create(c, `service.conc-pub-${i}`, `P${i}`);
      expect((await schedule(c, { items: [{ itemId: id, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
      toPublish.push(id);
    }
    for (let i = 0; i < 3; i++) {
      const id = await live(c, `service.conc-swap-${i}`, `S${i}`);
      await put(c, id, 1, `S${i}-new`);
      const approvalId = `apr-conc-${randomUUID()}`;
      expect((await schedule(c, { items: [{ itemId: id, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() }, approvalId)).statusCode).toBe(200);
      toSwap.set(id, approvalId);
    }
    for (let i = 0; i < 3; i++) {
      const id = await live(c, `service.conc-down-${i}`, `D${i}`);
      expect((await schedule(c, { items: [{ itemId: id, version: 1 }], unpublishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
      toTakeDown.push(id);
    }
    // The live() publishes' own events are already in the delivery count; the tick adds to it.
    await waitFor(async () => (await deliveries(c)).find((d) => d.kind === "content.published")?.n === 6, 8000);

    const now = new Date(Date.now() + 2 * HOUR);
    const results = await Promise.all([tick.runContentTick(now), tick.runContentTick(now), tick.runContentTick(now)]);
    const per = results.map((r) => mine(c, r));
    const sum = (k: "published" | "swapped" | "tookDown" | "errors" | "swapsCancelled" | "swapsFailed") => per.reduce((n, r) => n + r[k], 0);
    expect(sum("published")).toBe(4);
    expect(sum("swapped")).toBe(3);
    expect(sum("tookDown")).toBe(3);
    expect(sum("errors")).toBe(0);
    expect(sum("swapsCancelled") + sum("swapsFailed")).toBe(0);

    // Exactly one audit row per item, ten in all, each with the hash of ITS item's args.
    const rows = await auditRows(c);
    expect(rows).toHaveLength(10);
    const expected = [
      ...toPublish.map((itemId) => hashOf({ kind: "publish", itemId, version: 1 })),
      ...[...toSwap].map(([itemId, approvalId]) => hashOf({ kind: "swap", itemId, version: 2, approvalId })),
      ...toTakeDown.map((itemId) => hashOf({ kind: "takedown", itemId, version: 1 })),
    ];
    expect(rows.map((r) => r.args_hash).sort()).toEqual([...expected].sort());
    expect(rows.every((r) => r.actor === SCHEDULER_ACTOR && r.ws4_approval_id === null)).toBe(true);

    const states = await Promise.all([...toPublish, ...toSwap.keys(), ...toTakeDown].map((id) => item(c, id)));
    expect(states.slice(0, 4).every((st) => st.publish_state === "published")).toBe(true);
    expect(states.slice(4, 7).every((st) => st.published_version === 2)).toBe(true);
    expect(states.slice(7).every((st) => st.publish_state === "unpublished")).toBe(true);
    const swapRows = await Promise.all([...toSwap.keys()].map((id) => swaps(c, id)));
    expect(swapRows.every((r) => r.length === 1 && r[0].executed_at !== null)).toBe(true);

    // Webhooks: 4 publishes + 3 swaps = 7 more content.published (6 from the live() setup + 7), 3 content.unpublished.
    await waitFor(async () => (await deliveries(c)).find((d) => d.kind === "content.unpublished")?.n === 3, 8000);
    const finalDeliveries = await deliveries(c);
    expect(finalDeliveries.find((d) => d.kind === "content.published")?.n).toBe(6 + 7);
    expect(finalDeliveries.find((d) => d.kind === "content.unpublished")?.n).toBe(3);
  }, 120_000);

  it("concurrency: an item another transaction holds is SKIPPED, not waited for; it is processed on the next tick", async () => {
    const c = await newTenant("skip");
    const held = await create(c, "service.skip-held", "H");
    const free = await create(c, "service.skip-free", "F");
    for (const id of [held, free]) {
      expect((await schedule(c, { items: [{ itemId: id, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    }
    const holder = new Client({ connectionString: MIGRATOR_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [c.fx.tenantId]);
      await holder.query(`SELECT id FROM content_items WHERE id = $1 FOR UPDATE`, [held]);

      const t0 = Date.now();
      const r = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
      expect(Date.now() - t0).toBeLessThan(5000); // did not block on the held row
      expect(r).toMatchObject({ published: 1, errors: 0 });
      expect((await item(c, held)).publish_state).toBe("scheduled");
      expect((await item(c, free)).publish_state).toBe("published");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
    expect(mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)))).toMatchObject({ published: 1, errors: 0 });
    expect((await item(c, held)).publish_state).toBe("published");
    expect(await auditRows(c)).toHaveLength(2);
  });

  it("isolation: a tick walks each tenant under its own context and never touches another tenant's items", async () => {
    const a = await newTenant("isoA");
    const b = await newTenant("isoB");
    const ia = await create(a, "service.iso-a", "A");
    const ib = await create(b, "service.iso-b", "B");
    expect((await schedule(a, { items: [{ itemId: ia, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() })).statusCode).toBe(200);
    expect((await schedule(b, { items: [{ itemId: ib, version: 1 }], publishAt: new Date(Date.now() + 5 * HOUR).toISOString() })).statusCode).toBe(200);
    const r = await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    expect(mine(a, r).published).toBe(1);
    expect(mine(b, r).published).toBe(0);
    expect((await item(b, ib)).publish_state).toBe("scheduled");
    expect(await auditRows(b)).toHaveLength(0);
    expect(await auditRows(a)).toHaveLength(1);
  });

  // ----------------------------------------------------------------------------------------------
  // The two maintenance jobs (plain methods, called directly)
  // ----------------------------------------------------------------------------------------------
  describe("maintenance handlers", () => {
    it("runIdempotencySweep deletes expired keys (tenant and platform rows) and keeps live ones", async () => {
      const jobs = app.get(MaintenanceJobsService);
      const store = app.get(PgIdempotencyStore);
      const c = await newTenant("sweep");
      const keep = `keep:${randomUUID()}`;
      const gone = `gone:${randomUUID()}`;
      const gonePlatform = `gone-p:${randomUUID()}`;
      for (const [t, k] of [[c.fx.tenantId, keep], [c.fx.tenantId, gone], [null, gonePlatform]] as const) {
        expect((await store.begin({ tenantId: t, scopeKey: k, command: "tenant.provision", requestHash: "h" })).kind).toBe("fresh");
      }
      const expire = `UPDATE control_idempotency_keys SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE scope_key = $1`;
      await asTenant(c.fx.tenantId, (db) => db.query(expire, [gone]));
      await asPlatform((db) => db.query(expire, [gonePlatform]));

      const out = await jobs.runIdempotencySweep();
      expect(out.tenantRows).toBeGreaterThanOrEqual(1);
      expect(out.platformRows).toBeGreaterThanOrEqual(1);
      const left = await asTenant(c.fx.tenantId, async (db) => (await db.query(`SELECT scope_key FROM control_idempotency_keys WHERE scope_key = ANY($1)`, [[keep, gone]])).rows.map((r) => r.scope_key));
      expect(left).toEqual([keep]);
      const leftP = await asPlatform(async (db) => (await db.query(`SELECT scope_key FROM control_idempotency_keys WHERE tenant_id IS NULL AND scope_key = $1`, [gonePlatform])).rows);
      expect(leftP).toEqual([]);
    });

    it("runFormsPurge scrubs a due submission and leaves a not-yet-due one", async () => {
      const jobs = app.get(MaintenanceJobsService);
      const c = await newTenant("purge");
      const { formId, due, notDue } = await asTenant(c.fx.tenantId, async (db) => {
        const formId = randomUUID();
        await db.query(`INSERT INTO form_defs (id, tenant_id, site_id, key, schema, notify, retention_days, consent_notice_version) VALUES ($1,$2,$3,'contact','{}'::jsonb,'{}'::jsonb,1,'v1')`, [formId, c.fx.tenantId, c.fx.siteId]);
        const ins = async (createdAgo: string, expiresIn: string) =>
          (
            await db.query(
              `INSERT INTO submissions (tenant_id, site_id, form_def_id, payload, consent_notice_text, consent_notice_version, created_at, expires_at)
               VALUES ($1,$2,$3,'{"fields":{"name":"x"}}'::jsonb,'consent','v1', now() - $4::interval, now() + $5::interval) RETURNING id`,
              [c.fx.tenantId, c.fx.siteId, formId, createdAgo, expiresIn],
            )
          ).rows[0].id as string;
        return { formId, due: await ins("3 days", "-1 day"), notDue: await ins("1 hour", "1 day") };
      });
      void formId;
      const out = await jobs.runFormsPurge();
      expect(out.purged).toBeGreaterThanOrEqual(1);
      const state = await asTenant(c.fx.tenantId, async (db) => (await db.query(`SELECT id, status, payload FROM submissions WHERE id = ANY($1)`, [[due, notDue]])).rows);
      expect(state.find((r) => r.id === due)).toMatchObject({ status: "purged", payload: {} });
      expect(state.find((r) => r.id === notDue)?.status).toBe("received");
    });

    it("errors are logged and rethrown (BullMQ records the failure); the process does not crash", async () => {
      const jobs = app.get(MaintenanceJobsService);
      const purge = app.get(SubmissionsPurgeService);
      const store = app.get(PgIdempotencyStore);
      const p = vi.spyOn(purge, "purgeDueSubmissions").mockRejectedValueOnce(new Error("purge boom"));
      await expect(jobs.runFormsPurge()).rejects.toThrow("purge boom");
      p.mockRestore();
      const s = vi.spyOn(store, "sweepExpired").mockRejectedValueOnce(new Error("sweep boom"));
      await expect(jobs.runIdempotencySweep()).rejects.toThrow("sweep boom");
      s.mockRestore();
      // And both still work afterwards.
      await expect(jobs.runFormsPurge()).resolves.toBeTruthy();
      await expect(jobs.runIdempotencySweep()).resolves.toBeTruthy();
    });
  });
});
