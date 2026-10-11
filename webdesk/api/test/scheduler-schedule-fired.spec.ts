// WSK-61 — the producer half of the `schedule.fired` Zone B event. Real Postgres/Redis and the real
// AppModule (as scheduler-content-tick.spec.ts); the emitter's HTTP goes to a plain node:http server
// that records each request, exactly as events-emitter.spec.ts does, so the signature header is checked
// with the same verifySignature(). The tick is driven directly with an injected clock.
//
// The tick runs over EVERY active tenant in the shared test database, so each assertion filters the
// captured events to this test's own tenant (envelope.tenantId = the fixture's company_ref).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.TENANT_WEBHOOK_QUEUE_NAME = `wsk61-fired-${Date.now()}`;
process.env.TENANT_WEBHOOK_BACKOFF_DELAY_MS = "200";
process.env.TENANT_WEBHOOK_MAX_ATTEMPTS = "2";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asPlatform,
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  createItem,
  hdr,
  publishItems,
  serviceFields,
  waitFor,
  ws4For,
  type ContentFixture,
} from "./content-test-kit";
import { AuditService } from "../src/audit/audit.service";
import { TenantWebhooksService } from "../src/tenant-webhooks/tenant-webhooks.service";
import { ContentTickService } from "../src/scheduler/content-tick.service";
import type { ScheduleFiredData } from "../src/events/zoneb-event.types";
import { ZoneBEventEmitterService } from "../src/events/zoneb-event-emitter.service";
import { verifySignature } from "../src/events/zoneb-event-signature";
import { MAX_ITEMS_PER_EVENT, groupFired, scheduleFiredEventId, type FiredTransition } from "../src/scheduler/schedule-fired";
import { TenantWebhookSink } from "./helpers/tenant-webhook-sink";

const HOUR = 3_600_000;
const SECRET = "wsk61-fired-test-secret";

type Captured = { headers: IncomingMessage["headers"]; rawBody: string };
interface Envelope {
  eventId: string;
  kind: string;
  tenantId: string;
  originSite: string;
  occurredAt: string;
  data: ScheduleFiredData;
}

describe("WSK-61 schedule.fired producer (pure)", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const SITE = "11111111-1111-4111-8111-111111111111";
  const t = (over: Partial<FiredTransition>): FiredTransition => ({ siteId: SITE, kind: "publish", itemId: A, version: 1, effectiveAt: "2026-10-12T10:00:00.000Z", approvalId: null, ...over });

  it("eventId is sha256 of the documented string, lowercase hex, and the same on recompute", () => {
    const data = groupFired("acme", [t({ itemId: B }), t({ itemId: A, version: null })])[0].data;
    const expected = createHash("sha256")
      .update(`schedule.fired|acme|${SITE}|publish|-|${A}:-:2026-10-12T10:00:00.000Z,${B}:1:2026-10-12T10:00:00.000Z`)
      .digest("hex");
    expect(scheduleFiredEventId(data)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(groupFired("acme", [t({ itemId: A, version: null }), t({ itemId: B })])[0].eventId).toBe(expected); // input order is irrelevant
  });

  it("the same item and version fired again with a different effectiveAt gets a different eventId", () => {
    const one = groupFired("acme", [t({})])[0].eventId;
    const two = groupFired("acme", [t({ effectiveAt: "2026-10-13T10:00:00.000Z" })])[0].eventId;
    expect(one).not.toBe(two);
  });

  it("effectiveAt is normalised to ISO UTC whatever the driver returned", () => {
    const d = groupFired("acme", [t({ effectiveAt: new Date("2026-10-12T17:00:00+07:00") })])[0].data;
    expect(d.items[0].effectiveAt).toBe("2026-10-12T10:00:00.000Z");
  });

  it("a swap approval that is not a uuid is sent as null (the contract is uuid-or-null)", () => {
    const events = groupFired("acme", [t({ kind: "swap", approvalId: "apr-not-a-uuid" }), t({ itemId: B })]);
    expect(events).toHaveLength(1);
    expect(events[0].data.approvalId).toBeNull();
    expect(events[0].data.items).toHaveLength(2);
  });

  it("150 transitions chunk into 100 + 50, in itemId order, deterministically", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const shuffled = [...ids].reverse();
    const events = groupFired("acme", shuffled.map((itemId) => t({ itemId })));
    expect(events.map((e) => e.data.items.length)).toEqual([MAX_ITEMS_PER_EVENT, 50]);
    expect(events.flatMap((e) => e.data.items.map((i) => i.itemId))).toEqual(ids);
    expect(groupFired("acme", ids.map((itemId) => t({ itemId }))).map((e) => e.eventId)).toEqual(events.map((e) => e.eventId));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(2);
  });
});

describe("WSK-61 schedule.fired producer (real DB, injected clock)", () => {
  let app: NestFastifyApplication;
  let tick: ContentTickService;
  let sink: TenantWebhookSink;
  let server: Server;
  let bridgeUrl: string;
  let captured: Captured[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("failed to bind test server");
    bridgeUrl = `http://127.0.0.1:${address.port}/webhook/wd-zoneb-intake`;

    sink = await TenantWebhookSink.start();
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = `127.0.0.1:${sink.port}`;
    app = await buildContentApp();
    tick = app.get(ContentTickService);
  });

  afterAll(async () => {
    await app?.close();
    process.env.TENANT_WEBHOOK_SSRF_TEST_ALLOWLIST = "";
    await sink?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    captured = [];
    process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "true";
    process.env.WEBDESK_ZONEB_BRIDGE_URL = bridgeUrl;
    process.env.WEBDESK_EVENT_SECRET = SECRET;
    process.env.WEBDESK_ZONEB_ORIGIN_SITE = "wsk61-test-site";
    process.env.WEBDESK_ZONEB_EVENT_TIMEOUT_MS = "2000";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface Ctx {
    fx: ContentFixture;
    companyRef: string;
  }

  async function newTenant(label: string): Promise<Ctx> {
    const fx = await createContentFixture(label);
    await app.get(TenantWebhooksService).register(fx.tenantId, {
      targetUrl: sink.url(),
      eventKinds: ["content.published", "content.unpublished"],
      description: label,
    });
    const companyRef = await asPlatform(async (db) => (await db.query(`SELECT company_ref FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].company_ref as string);
    return { fx, companyRef };
  }

  async function create(c: Ctx, slug: string): Promise<string> {
    const res = await createItem(app, c.fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1: slug }) });
    expect(res.statusCode).toBe(201);
    return res.json().item.itemId as string;
  }

  async function live(c: Ctx, slug: string): Promise<string> {
    const itemId = await create(c, slug);
    expect((await publishItems(app, c.fx, [{ itemId, version: 1 }])).statusCode).toBe(200);
    return itemId;
  }

  async function put(c: Ctx, itemId: string, baseVersion: number) {
    const res = await app.inject({ method: "PUT", url: `${base(c.fx)}/items/${itemId}`, headers: hdr(), payload: { baseVersion, fields: serviceFields({ h1: "next" }) } });
    expect(res.statusCode).toBe(200);
  }

  async function schedule(c: Ctx, body: Record<string, unknown>, approvalId = `apr-${randomUUID()}`) {
    const ws4 = ws4For("content.schedule", { tenantSlug: c.fx.slug, siteId: c.fx.siteId }, body, approvalId);
    const res = await app.inject({ method: "POST", url: `${base(c.fx)}/schedule`, headers: hdr({ ws4 }), payload: body });
    expect(res.statusCode).toBe(200);
  }

  const envelopes = (c: Ctx): Envelope[] =>
    captured.map((r) => JSON.parse(r.rawBody) as Envelope).filter((e) => e.tenantId === c.companyRef);
  const mine = (c: Ctx, r: { tenants: { tenantId: string }[] }) => r.tenants.find((t) => t.tenantId === c.fx.tenantId) as unknown as Record<string, number>;
  const deliveries = (c: Ctx) =>
    asTenant(c.fx.tenantId, async (db) => (await db.query(`SELECT kind, count(*)::int AS n FROM tenant_webhook_deliveries WHERE tenant_id = $1 GROUP BY kind ORDER BY kind`, [c.fx.tenantId])).rows as { kind: string; n: number }[]);

  /** 2 due publishes + 1 swap (with an approval) + 1 takedown, all in one site. Returns what the events must say. */
  async function fourTransitions(c: Ctx, approvalId: string) {
    const publishAt = new Date(Date.now() + HOUR).toISOString();
    const p1 = await create(c, "service.fired-p1");
    const p2 = await create(c, "service.fired-p2");
    await schedule(c, { items: [{ itemId: p1, version: 1 }, { itemId: p2, version: 1 }], publishAt });

    const swapId = await live(c, "service.fired-swap");
    await put(c, swapId, 1);
    const swapAt = new Date(Date.now() + 2 * HOUR).toISOString();
    await schedule(c, { items: [{ itemId: swapId, version: 2 }], publishAt: swapAt }, approvalId);

    const downId = await live(c, "service.fired-down");
    const unpublishAt = new Date(Date.now() + 3 * HOUR).toISOString();
    await schedule(c, { items: [{ itemId: downId, version: 1 }], unpublishAt });
    return { p1, p2, swapId, downId, publishAt, swapAt, unpublishAt };
  }

  it("2 publishes + 1 swap + 1 takedown give exactly 3 events with the contract's data, signed, with the tenant's company_ref", async () => {
    const c = await newTenant("fired4");
    const approvalId = randomUUID();
    const w = await fourTransitions(c, approvalId);

    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 4 * HOUR)));
    expect(r).toMatchObject({ published: 2, swapped: 1, tookDown: 1, errors: 0 });

    await waitFor(async () => envelopes(c).length >= 3, 5000);
    const evs = envelopes(c);
    expect(evs).toHaveLength(3);
    for (const e of evs) {
      expect(Object.keys(e).sort()).toEqual(["data", "eventId", "kind", "occurredAt", "originSite", "tenantId"]);
      expect(Object.keys(e.data).sort()).toEqual(["approvalId", "items", "siteId", "tenantSlug", "transition"]);
      expect(e.kind).toBe("schedule.fired");
      expect(e.tenantId).toBe(c.companyRef);
      expect(e.originSite).toBe("wsk61-test-site");
      expect(e.eventId).toMatch(/^[0-9a-f]{64}$/);
      for (const i of e.data.items) expect(Object.keys(i).sort()).toEqual(["effectiveAt", "itemId", "version"]);
    }

    const by = (transition: string, approval: string | null) => evs.filter((e) => e.data.transition === transition && e.data.approvalId === approval);
    const pubs = by("publish", null);
    expect(pubs).toHaveLength(1);
    expect(pubs[0].data).toEqual({
      tenantSlug: c.fx.slug,
      siteId: c.fx.siteId,
      transition: "publish",
      approvalId: null,
      items: [w.p1, w.p2].sort().map((itemId) => ({ itemId, version: 1, effectiveAt: w.publishAt })),
    });
    const swaps = by("publish", approvalId);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].data).toEqual({
      tenantSlug: c.fx.slug,
      siteId: c.fx.siteId,
      transition: "publish",
      approvalId,
      items: [{ itemId: w.swapId, version: 2, effectiveAt: w.swapAt }],
    });
    const downs = by("unpublish", null);
    expect(downs).toHaveLength(1);
    expect(downs[0].data).toEqual({
      tenantSlug: c.fx.slug,
      siteId: c.fx.siteId,
      transition: "unpublish",
      approvalId: null,
      items: [{ itemId: w.downId, version: 1, effectiveAt: w.unpublishAt }],
    });
    // eventId is the documented hash of exactly that data.
    for (const e of evs) expect(e.eventId).toBe(scheduleFiredEventId(e.data));

    // The signature header verifies against the exact bytes that crossed the socket.
    for (const req of captured.filter((x) => (JSON.parse(x.rawBody) as Envelope).tenantId === c.companyRef)) {
      const result = verifySignature({
        secret: SECRET,
        timestampHeader: req.headers["x-webdesk-timestamp"] as string,
        rawBody: req.rawBody,
        signatureHeader: req.headers["x-webdesk-signature"] as string,
        toleranceMs: 5 * 60_000,
      });
      expect(result.ok).toBe(true);
    }

    // A second tick finds nothing left, so it emits nothing for this tenant.
    captured = [];
    await tick.runContentTick(new Date(Date.now() + 4 * HOUR));
    expect(envelopes(c)).toHaveLength(0);
  });

  it("150 due publishes give 2 events (100 + 50) in deterministic itemId order", async () => {
    const c = await newTenant("fired150");
    const collectionId = c.fx.collections.service;
    const publishAt = new Date(Date.now() - HOUR);
    const ids = await asTenant(c.fx.tenantId, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, head_version, published_version, publish_state, publish_at)
         SELECT $1, $2, $3, 'en', 'service.bulk-' || g, 1, 1, 'scheduled', $4::timestamptz
           FROM generate_series(1, 150) g
         RETURNING id`,
        [c.fx.tenantId, c.fx.siteId, collectionId, publishAt.toISOString()],
      );
      return rows.map((r: { id: string }) => r.id).sort();
    });

    const r = mine(c, await tick.runContentTick(new Date()));
    expect(r).toMatchObject({ published: 150, errors: 0 });
    await waitFor(async () => envelopes(c).length >= 2, 5000);
    const evs = envelopes(c);
    expect(evs).toHaveLength(2);
    const sizes = evs.map((e) => e.data.items.length).sort((a, b) => b - a);
    expect(sizes).toEqual([100, 50]);
    const first = evs.find((e) => e.data.items.length === 100) as Envelope;
    const second = evs.find((e) => e.data.items.length === 50) as Envelope;
    expect(first.data.items.map((i) => i.itemId)).toEqual(ids.slice(0, 100));
    expect(second.data.items.map((i) => i.itemId)).toEqual(ids.slice(100));
    expect(first.eventId).not.toBe(second.eventId);
  });

  it("fail-soft: a throwing transport changes neither the tick, its counts, nor the tenant webhook", async () => {
    const c = await newTenant("failsoft");
    const itemId = await create(c, "service.fired-failsoft");
    await schedule(c, { items: [{ itemId, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() });

    const realFetch = globalThis.fetch;
    const bridgeCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === bridgeUrl) {
        bridgeCalls.push(String(input));
        return Promise.reject(new TypeError("fetch failed (simulated bridge outage)"));
      }
      return realFetch(input, init);
    }) as typeof fetch);

    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r).toMatchObject({ published: 1, swapped: 0, tookDown: 0, errors: 0 });
    expect(bridgeCalls).toHaveLength(1);
    expect(envelopes(c)).toHaveLength(0);
    await waitFor(async () => (await deliveries(c)).some((d) => d.kind === "content.published"), 5000);
    expect(await deliveries(c)).toEqual([{ kind: "content.published", n: 1 }]);
  });

  it("fail-soft: even an emitter that rejects outright does not touch the tick", async () => {
    const c = await newTenant("rejects");
    const itemId = await create(c, "service.fired-rejects");
    await schedule(c, { items: [{ itemId, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() });
    vi.spyOn(app.get(ZoneBEventEmitterService), "emitScheduleFired").mockRejectedValue(new Error("boom"));

    const r = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r).toMatchObject({ published: 1, errors: 0 });
    await waitFor(async () => (await deliveries(c)).some((d) => d.kind === "content.published"), 5000);
  });

  it("nothing is emitted for a transition that rolled back or did not apply", async () => {
    const c = await newTenant("rolledback");

    // (a) a swap whose version no longer validates: marked failed, nothing fires.
    const swapId = await live(c, "service.fired-swapfail");
    await put(c, swapId, 1);
    await schedule(c, { items: [{ itemId: swapId, version: 2 }], publishAt: new Date(Date.now() + HOUR).toISOString() }, randomUUID());
    await asTenant(c.fx.tenantId, async (db) => {
      const { rows } = await db.query(`SELECT schema FROM collections WHERE id = $1`, [c.fx.collections.service]);
      const schema = rows[0].schema;
      schema.fields.push({ name: "must_have", primitive: "text", required: true });
      await db.query(`UPDATE collections SET schema = $2::jsonb WHERE id = $1`, [c.fx.collections.service, JSON.stringify(schema)]);
    });
    const r1 = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r1).toMatchObject({ swapped: 0, swapsFailed: 1, errors: 0 });
    expect(envelopes(c)).toHaveLength(0);

    // (b) a publish whose transaction throws (the audit write fails) rolls back: nothing fires for it.
    const c2 = await newTenant("rolledback2");
    const itemId = await create(c2, "service.fired-throws");
    await schedule(c2, { items: [{ itemId, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() });
    const audit = app.get(AuditService);
    const realRecord = audit.record.bind(audit);
    vi.spyOn(audit, "record").mockImplementation(async (client, args) => {
      if (args.tenantId === c2.fx.tenantId) throw new Error("simulated audit failure");
      return realRecord(client, args);
    });
    const r2 = mine(c2, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r2).toMatchObject({ published: 0, errors: 1 });
    expect(envelopes(c2)).toHaveLength(0);
  });

  it("disabled, or an empty bridge URL: no HTTP call and no error", async () => {
    const c = await newTenant("disabled");
    const a = await create(c, "service.fired-off-a");
    await schedule(c, { items: [{ itemId: a, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() });
    process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "false";
    const r1 = mine(c, await tick.runContentTick(new Date(Date.now() + 2 * HOUR)));
    expect(r1).toMatchObject({ published: 1, errors: 0 });
    expect(captured).toHaveLength(0);

    process.env.WEBDESK_ZONEB_EVENTS_ENABLED = "true";
    process.env.WEBDESK_ZONEB_BRIDGE_URL = "";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const b = await create(c, "service.fired-off-b");
    await schedule(c, { items: [{ itemId: b, version: 1 }], publishAt: new Date(Date.now() + 3 * HOUR).toISOString() });
    const r2 = mine(c, await tick.runContentTick(new Date(Date.now() + 4 * HOUR)));
    expect(r2).toMatchObject({ published: 1, errors: 0 });
    expect(captured).toHaveLength(0);
    expect(fetchSpy.mock.calls.filter(([u]) => String(u) === bridgeUrl)).toHaveLength(0);
  });
});
