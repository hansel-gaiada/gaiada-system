// WSK-41 — done-when (5) gate order with VALID bodies and (6) WS4 single-use, plus the production
// binding of the editorial seam. Real DB, real Layer-3/4 PDP (content-test-kit.ts).
//
// Doctrine (estate memory: "validation pre-empts authz"): every denial below sends a body that is
// valid for its command, and is paired with an allowed control that sends the IDENTICAL body (and,
// for HIGH commands, the identical WS4 assertion) and succeeds. A denial that a 400/422 could have
// produced proves nothing about authorisation.
//
// Gate order: L1 mTLS -> L2 token -> L3 scope -> L4 WS4 -> L2e editorial principal -> validation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asTenant,
  base,
  buildContentApp,
  createContentFixture,
  createItem,
  hdr,
  publishItems,
  serviceFields,
  ws4For,
  type ContentFixture,
  type HeaderOpts,
} from "./content-test-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { NotConfiguredEditorialPrincipalResolver } from "../src/control/auth/not-configured-editorial-principal-resolver";
import { ContentCommandsService, type EditorialCommandContext } from "../src/control/content/content-commands.service";
import { ControlProblem } from "../src/control/content/content-problem";

const PROBLEM = "https://webdesk.gaiada.online/errors/";

type Req = { method: "POST" | "PUT"; url: string; body: Record<string, unknown>; ws4?: string; ok: number };

describe("WSK-41 gates: order with valid bodies, WS4 single-use, production binding", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("gates");
  });
  afterAll(async () => {
    await app?.close();
  });

  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });

  async function draft(label: string): Promise<string> {
    const r = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: `service.${label}-${randomUUID().slice(0, 6)}`, fields: serviceFields() });
    expect(r.statusCode).toBe(201);
    return r.json().item.itemId as string;
  }
  async function live(label: string): Promise<string> {
    const id = await draft(label);
    expect((await publishItems(app, fx, [{ itemId: id, version: 1 }])).statusCode).toBe(200);
    return id;
  }
  async function withTwoVersions(label: string): Promise<string> {
    const id = await draft(label);
    const r = await app.inject({ method: "PUT", url: `${base(fx)}/items/${id}`, headers: hdr(), payload: { baseVersion: 1, fields: serviceFields({ h1: "two" }) } });
    expect(r.statusCode).toBe(200);
    return id;
  }

  /** A fresh, VALID request for each command, in a state where it will succeed. */
  const setups: Record<string, () => Promise<Req>> = {
    "content.create": async () => ({
      method: "POST",
      url: `${base(fx)}/items`,
      body: { collectionKey: "service", locale: "en", slug: `service.gate-${randomUUID().slice(0, 8)}`, fields: serviceFields() },
      ok: 201,
    }),
    "content.update": async () => {
      const id = await draft("upd");
      return { method: "PUT", url: `${base(fx)}/items/${id}`, body: { baseVersion: 1, fields: serviceFields({ h1: "changed" }) }, ok: 200 };
    },
    "content.restoreVersion": async () => {
      const id = await withTwoVersions("rst");
      return { method: "POST", url: `${base(fx)}/items/${id}/restore`, body: { version: 1, baseVersion: 2 }, ok: 200 };
    },
    "content.publish": async () => {
      const id = await draft("pub");
      const body = { items: [{ itemId: id, version: 1 }] };
      return { method: "POST", url: `${base(fx)}/publish`, body, ws4: ws4For("content.publish", params(), body), ok: 200 };
    },
    "content.schedule": async () => {
      const id = await draft("sch");
      const body = { items: [{ itemId: id, version: 1 }], publishAt: new Date(Date.now() + 3_600_000).toISOString() };
      return { method: "POST", url: `${base(fx)}/schedule`, body, ws4: ws4For("content.schedule", params(), body), ok: 200 };
    },
    "content.unpublish": async () => {
      const id = await live("unp");
      return { method: "POST", url: `${base(fx)}/items/${id}/unpublish`, body: { expectedPublishedVersion: 1 }, ok: 200 };
    },
    "content.delete": async () => {
      const id = await draft("del");
      return { method: "POST", url: `${base(fx)}/items/${id}/delete`, body: { baseVersion: 1 }, ok: 200 };
    },
  };

  const send = (r: Req, opts: HeaderOpts = {}) =>
    app.inject({ method: r.method, url: r.url, headers: hdr({ ws4: r.ws4, ...opts }), payload: r.body });

  async function auditCount(): Promise<number> {
    return asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT count(*)::int AS n FROM audit_entries WHERE tenant_id = $1 AND action LIKE 'control.content.%'`, [fx.tenantId])).rows[0].n,
    );
  }

  // ==============================================================================================
  // (5) every editorial command: L2e refuses, the identical request with a principal succeeds
  // ==============================================================================================
  for (const command of Object.keys(setups)) {
    it(`(5) ${command}: no editorial principal -> 401 editorial-assertion-missing; identical body + principal -> ${command === "content.create" ? 201 : 200}`, async () => {
      const r = await setups[command]();
      const before = await auditCount();
      const denied = await send(r, { editorial: null });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().type).toBe(`${PROBLEM}editorial-assertion-missing`);
      expect(await auditCount()).toBe(before); // refused before anything was written
      const allowed = await send(r);
      expect(allowed.statusCode).toBe(r.ok);
    });

    it(`(5) ${command}: a scopeless token -> 403 (L3); identical body with scopes -> success`, async () => {
      const r = await setups[command]();
      const denied = await send(r, { scopes: [] });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toMatch(/lacks required scope/);
      const allowed = await send(r);
      expect(allowed.statusCode).toBe(r.ok);
    });
  }

  it("(5) the operate scope is not enough for a promote-scoped command (unpublish); promote is", async () => {
    const r = await setups["content.unpublish"]();
    const denied = await send(r, { scopes: ["webdesk:read", "webdesk:operate"] });
    expect(denied.statusCode).toBe(403);
    expect((await send(r, { scopes: ["webdesk:promote"] })).statusCode).toBe(200);
  });

  for (const command of ["content.publish", "content.schedule"]) {
    it(`(5) ${command} without WS4 -> 403 (L4, HIGH for every principal); identical body WITH WS4 -> 200`, async () => {
      const r = await setups[command]();
      const denied = await app.inject({ method: r.method, url: r.url, headers: hdr(), payload: r.body });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toMatch(/HIGH-impact and always requires a WS4 assertion/);
      expect((await send(r)).statusCode).toBe(200);
    });

    it(`(5) ${command}: a WS4 assertion minted for a different body -> 403 commandHash mismatch; the matching one -> 200`, async () => {
      const r = await setups[command]();
      const other = { ...r.body, items: [{ itemId: randomUUID(), version: 1 }] };
      const wrong = ws4For(command, params(), other);
      const denied = await app.inject({ method: r.method, url: r.url, headers: hdr({ ws4: wrong }), payload: r.body });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().message).toMatch(/commandHash does not match/);
      expect((await send(r)).statusCode).toBe(200);
    });
  }

  it("(5) gate ORDER: L3 before L2e, L4 before L2e, L2e before validation; full authorisation + invalid body -> 422", async () => {
    const pub = await setups["content.publish"]();
    // scopeless AND no editorial principal -> the L3 refusal (403), not L2e's 401
    expect((await send(pub, { scopes: [], editorial: null })).statusCode).toBe(403);
    // no WS4 AND no editorial principal -> the L4 refusal (403)
    const noWs4 = await app.inject({ method: pub.method, url: pub.url, headers: hdr({ editorial: null }), payload: pub.body });
    expect(noWs4.statusCode).toBe(403);
    expect(noWs4.json().message).toMatch(/WS4/);
    // no editorial principal AND an invalid body -> L2e's 401, never a 422
    const invalidBody = { collectionKey: "service", locale: "en", slug: "service.invalid-body", fields: { url: 42 } };
    const create = { method: "POST" as const, url: `${base(fx)}/items`, body: invalidBody, ok: 201 };
    const l2e = await send(create, { editorial: null });
    expect(l2e.statusCode).toBe(401);
    // fully authorised, invalid body -> 422 (validation runs after every gate)
    const v = await send(create);
    expect(v.statusCode).toBe(422);
    expect(v.json().type).toBe(`${PROBLEM}composition-violation`);
    expect(v.json().issues[0]).toMatchObject({ path: "/blocks/0/props/url" });
    // and the positive control for that same command with a valid body
    expect((await send({ ...create, body: { ...invalidBody, fields: serviceFields() } })).statusCode).toBe(201);
  });

  it("(5) a malformed editorial principal -> 401 editorial-assertion-malformed", async () => {
    const r = await setups["content.create"]();
    const bad = await send(r, { editorial: '{"sub": 5}' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().type).toBe(`${PROBLEM}editorial-assertion-malformed`);
    expect((await send(r, { editorial: '{"sub":"bot-7","pk":"agent","agt":"webdev-writer"}' })).statusCode).toBe(201);
  });

  it("a MEDIUM command never claims a WS4 approval even when an assertion is attached", async () => {
    const r = await setups["content.unpublish"]();
    const approvalId = `apr-stray-${randomUUID()}`;
    const res = await send({ ...r, ws4: ws4For("content.unpublish", { ...params(), itemId: r.url.split("/").at(-2) }, r.body, approvalId) });
    expect(res.statusCode).toBe(200);
    const rows = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM audit_entries WHERE ws4_approval_id = $1`, [approvalId])).rows[0].n);
    expect(rows).toBe(0);
  });

  // ==============================================================================================
  // (6) WS4 single-use
  // ==============================================================================================
  it("(6) the same approval on a second publish (new idempotency key) -> 403, and that item stays unpublished", async () => {
    const a = await draft("once-a");
    const b = await draft("once-b");
    const approvalId = `apr-once-${randomUUID()}`;
    expect((await publishItems(app, fx, [{ itemId: a, version: 1 }], { approvalId })).statusCode).toBe(200);
    const reuse = await publishItems(app, fx, [{ itemId: b, version: 1 }], { approvalId });
    expect(reuse.statusCode).toBe(403);
    const bRow = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT publish_state, published_version FROM content_items WHERE id = $1`, [b])).rows[0],
    );
    expect(bRow).toEqual({ publish_state: "draft", published_version: null });
  });

  it("(6) two CONCURRENT publishes with one approval -> exactly one 200; the loser's item is unchanged", async () => {
    const a = await draft("race-a");
    const b = await draft("race-b");
    const approvalId = `apr-race-${randomUUID()}`;
    const [ra, rb] = await Promise.all([
      publishItems(app, fx, [{ itemId: a, version: 1 }], { approvalId }),
      publishItems(app, fx, [{ itemId: b, version: 1 }], { approvalId }),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 403]);
    const loser = ra.statusCode === 403 ? a : b;
    const winner = loser === a ? b : a;
    const rows = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT id, publish_state, published_version FROM content_items WHERE id = ANY($1::uuid[])`, [[a, b]])).rows,
    );
    expect(rows.find((r) => r.id === loser)).toMatchObject({ publish_state: "draft", published_version: null });
    expect(rows.find((r) => r.id === winner)).toMatchObject({ publish_state: "published", published_version: 1 });
    const audits = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT action FROM audit_entries WHERE ws4_approval_id = $1`, [approvalId])).rows.map((r) => r.action),
    );
    expect(audits).toEqual(["control.content.publish"]);
  });

  it("(6) the claim precedes the effect: concurrent SERVICE calls (no PDP pre-check) with one approval -> one succeeds, the other 403 ws4-approval-already-used and changes nothing", async () => {
    const svc = app.get(ContentCommandsService);
    const { tenant } = await svc.resolveTenantSite(fx.slug, fx.siteId);
    const approvalId = `apr-svc-${randomUUID()}`;
    const ctx = (): EditorialCommandContext => ({
      tenant,
      siteId: fx.siteId,
      principal: { sub: "user-publisher-1", pk: "human", jti: randomUUID() },
      idempotencyKey: `svc-${randomUUID()}`,
      ws4ApprovalId: approvalId,
      command: "content.publish",
    });
    const ids = [await draft("svc-a"), await draft("svc-b"), await draft("svc-c")];
    // Batch 1 = [a]; batch 2 = [b, c]. Whichever loses must leave ALL its items untouched.
    const results = await Promise.allSettled([
      svc.publish(ctx(), { items: [{ itemId: ids[0], version: 1 }] }),
      svc.publish(ctx(), { items: [{ itemId: ids[1], version: 1 }, { itemId: ids[2], version: 1 }] }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(ControlProblem);
    expect((bad[0].reason as ControlProblem).getStatus()).toBe(403);
    expect((bad[0].reason as ControlProblem).slug).toBe("ws4-approval-already-used");
    const loserIds = results[0].status === "rejected" ? [ids[0]] : [ids[1], ids[2]];
    const rows = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT publish_state, published_version, last_published_by FROM content_items WHERE id = ANY($1::uuid[])`, [loserIds])).rows,
    );
    for (const r of rows) expect(r).toEqual({ publish_state: "draft", published_version: null, last_published_by: null });
    // The loser's idempotency claim was released, so its key is free for a retry.
    const claims = await asTenant(fx.tenantId, async (db) =>
      (await db.query(`SELECT status FROM control_idempotency_keys WHERE command = 'content.publish' AND status = 'in_flight'`)).rows,
    );
    expect(claims).toEqual([]);
  });

  // ==============================================================================================
  // Production binding: with no editorial keys every content write is refused, nothing is written
  // ==============================================================================================
  it("NotConfiguredEditorialPrincipalResolver (the non-test binding until WSK-40): 503 editorial-keys-not-configured, nothing written", async () => {
    const prodLike = await buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useClass(NotConfiguredEditorialPrincipalResolver));
    try {
      const slug = `service.noprod-${randomUUID().slice(0, 6)}`;
      const r = await prodLike.inject({
        method: "POST",
        url: `${base(fx)}/items`,
        headers: hdr(),
        payload: { collectionKey: "service", locale: "en", slug, fields: serviceFields() },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().type).toBe(`${PROBLEM}editorial-keys-not-configured`);
      const n = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [slug])).rows[0].n);
      expect(n).toBe(0);
    } finally {
      await prodLike.close();
    }
  });
});
