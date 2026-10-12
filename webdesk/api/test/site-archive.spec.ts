// site.archive (owner ruling 2026-10-12: archiving a site TAKES a WS4 approval; migration 0019 added
// sites.status). The command is the site-scope mirror of tenant.archive: same envelope, same WS4 claim,
// one terminal UPDATE. What this proves, against a real Postgres (0001-0019, webdesk_app NOBYPASSRLS),
// real Redis, the real AppModule and the REAL Layer-3/4 PolicyDecisionPoint (content-test-kit.ts):
//   - the command refuses without a WS4 assertion, and with one minted for different arguments;
//   - a valid assertion archives: status, the audit row carrying the approval, the single-use claim;
//   - a replay of the same Idempotency-Key answers from the stored record (one effect, one audit row);
//   - another tenant's slug (or an unknown site) is a 404, and an already-archived site a 409;
//   - what archiving does at site scope, mirroring an archived tenant: the site's keys stop resolving
//     (/v1 answers 401 invalid-credentials, the same as a revoked key), its control routes refuse with a
//     typed 409 site-archived (writes, publishes, reads), its pending schedule is skipped by the tick, and
//     it is still listed (status 'archived'); a SIBLING site of the same tenant is untouched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
  ws4For,
  type ContentFixture,
} from "./content-test-kit";
import { Client } from "pg";
import { ApiKeysService } from "../src/api-keys/api-keys.service";
import { TenantReadsService } from "../src/control/tenants/tenant-reads.service";
import { ContentTickService } from "../src/scheduler/content-tick.service";
import { computeCommandHash, mintWs4Assertion } from "../src/control/auth/ws4-assertion";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const HOUR = 3_600_000;

const archiveUrl = (fx: ContentFixture, siteId = fx.siteId) => `/control/v1/tenants/${fx.slug}/sites/${siteId}/archive`;

describe("site.archive (WS4-gated, irreversible, site-scope mirror of tenant.archive)", () => {
  let app: NestFastifyApplication;
  let tick: ContentTickService;

  beforeAll(async () => {
    app = await buildContentApp();
    tick = app.get(ContentTickService);
  });
  afterAll(async () => {
    await app?.close();
  });

  const promoteHdr = (ws4?: string, idem: string | null = `idem-${randomUUID()}`) => hdr({ scopes: ["webdesk:promote"], ws4, idem, editorial: null });
  const archiveWs4 = (fx: ContentFixture, siteId = fx.siteId, approvalId = `apr-${randomUUID()}`) =>
    ws4For("site.archive", { tenantSlug: fx.slug, siteId }, {}, approvalId);

  const post = (fx: ContentFixture, ws4: string | undefined, idem?: string | null, siteId = fx.siteId) =>
    app.inject({ method: "POST", url: archiveUrl(fx, siteId), headers: promoteHdr(ws4, idem) });

  const siteStatus = (fx: ContentFixture, siteId = fx.siteId) =>
    asTenant(fx.tenantId, async (c) => (await c.query(`SELECT status FROM sites WHERE id = $1`, [siteId])).rows[0]?.status as string | undefined);

  const auditActions = (fx: ContentFixture, approvalId?: string) =>
    asTenant(fx.tenantId, async (c) =>
      (
        await c.query(
          approvalId
            ? `SELECT action FROM audit_entries WHERE tenant_id = $1 AND ws4_approval_id = $2 ORDER BY action`
            : `SELECT action FROM audit_entries WHERE tenant_id = $1 AND action LIKE 'control.site.archive%' ORDER BY action`,
          approvalId ? [fx.tenantId, approvalId] : [fx.tenantId],
        )
      ).rows.map((r) => r.action as string),
    );

  /** A second site (with its own environment) under the same tenant, to prove archiving one leaves the other alone. */
  async function addSibling(fx: ContentFixture): Promise<{ siteId: string; envId: string }> {
    const siteId = randomUUID();
    const envId = randomUUID();
    const c = new Client({ connectionString: MIGRATOR_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [fx.tenantId]);
      await c.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'sibling')`, [siteId, fx.tenantId]);
      await c.query(`INSERT INTO environments (id, site_id, tenant_id, name, domain, status) VALUES ($1, $2, $3, 'production', NULL, 'active')`, [envId, siteId, fx.tenantId]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      await c.end();
    }
    return { siteId, envId };
  }

  // ----------------------------------------------------------------------------------------------
  // The gate
  // ----------------------------------------------------------------------------------------------
  it("REFUSES without a WS4 assertion (403) and changes nothing", async () => {
    const fx = await createContentFixture("sa-nows4");
    const res = await post(fx, undefined);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/HIGH-impact and always requires a WS4 assertion/);
    expect(await siteStatus(fx)).toBe("active");
  });

  it("REFUSES a WS4 assertion minted for a DIFFERENT site (commandHash mismatch, 403)", async () => {
    const fx = await createContentFixture("sa-badhash");
    const wrong = mintWs4Assertion(
      { approvalId: `apr-${randomUUID()}`, commandHash: computeCommandHash("site.archive", { tenantSlug: fx.slug, siteId: randomUUID() }), exp: Math.floor(Date.now() / 1000) + 120 },
      process.env.WEBDESK_APPROVAL_ASSERTION_KEY as string,
    );
    const res = await post(fx, wrong);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/commandHash does not match/);
    expect(await siteStatus(fx)).toBe("active");
  });

  it("REFUSES a TAMPERED assertion signature (403) and a token minted for another command (403)", async () => {
    const fx = await createContentFixture("sa-tamper");
    const good = archiveWs4(fx);
    const [payload, sig] = good.split(".");
    const bad = `${payload}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`;
    expect((await post(fx, bad)).statusCode).toBe(403);
    const otherCommand = ws4For("tenant.archive", { tenantSlug: fx.slug, siteId: fx.siteId }, {});
    expect((await post(fx, otherCommand)).statusCode).toBe(403);
    expect(await siteStatus(fx)).toBe("active");
  });

  it("REFUSES a caller without the webdesk:promote scope (403)", async () => {
    const fx = await createContentFixture("sa-scope");
    const res = await app.inject({ method: "POST", url: archiveUrl(fx), headers: hdr({ scopes: ["webdesk:read", "webdesk:operate"], ws4: archiveWs4(fx), editorial: null }) });
    expect(res.statusCode).toBe(403);
    expect(await siteStatus(fx)).toBe("active");
  });

  it("REFUSES a missing Idempotency-Key (400)", async () => {
    const fx = await createContentFixture("sa-nokey");
    const res = await post(fx, archiveWs4(fx), null);
    expect(res.statusCode).toBe(400);
    expect(await siteStatus(fx)).toBe("active");
  });

  // ----------------------------------------------------------------------------------------------
  // The command
  // ----------------------------------------------------------------------------------------------
  it("archives with a valid assertion: status, one audit row carrying the approval, single-use afterwards", async () => {
    const fx = await createContentFixture("sa-ok");
    const approvalId = `apr-${randomUUID()}`;
    const res = await post(fx, archiveWs4(fx, fx.siteId, approvalId));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ site: { id: fx.siteId, status: "archived" }, replayed: false });
    expect(await siteStatus(fx)).toBe("archived");
    expect(await auditActions(fx, approvalId)).toEqual(["control.site.archive"]);

    // The same approval cannot archive anything again (single use): a second site of the tenant, same assertion id.
    const sibling = await addSibling(fx);
    const reuse = await post(fx, archiveWs4(fx, sibling.siteId, approvalId), undefined, sibling.siteId);
    expect(reuse.statusCode).toBe(403);
    expect(await siteStatus(fx, sibling.siteId)).toBe("active");
  });

  it("a retry of the SAME Idempotency-Key is answered from the stored record: one effect, one audit row", async () => {
    const fx = await createContentFixture("sa-replay");
    const idem = `idem-${randomUUID()}`;
    const first = await post(fx, archiveWs4(fx), idem);
    expect(first.statusCode).toBe(201);
    // The real PDP refuses a re-used approval id, so the retry carries a fresh assertion for the same arguments.
    const replay = await post(fx, archiveWs4(fx), idem);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().replayed).toBe(true);
    const { replayed: _a, ...a } = first.json();
    const { replayed: _b, ...b } = replay.json();
    expect(b).toEqual(a);
    expect(await auditActions(fx)).toEqual(["control.site.archive", "control.site.archive.replay"]);
  });

  it("a FRESH key on an already-archived site is a 409 and its approval stays unclaimed", async () => {
    const fx = await createContentFixture("sa-twice");
    expect((await post(fx, archiveWs4(fx))).statusCode).toBe(201);
    const approvalId = `apr-${randomUUID()}`;
    const again = await post(fx, archiveWs4(fx, fx.siteId, approvalId));
    expect(again.statusCode).toBe(409);
    expect(await auditActions(fx, approvalId)).toEqual([]);
  });

  it("another tenant's slug, an unknown site and a malformed id all refuse (404 / 404 / 400) and nothing is archived", async () => {
    const a = await createContentFixture("sa-ta");
    const b = await createContentFixture("sa-tb");
    // b's slug + a's site id: the site is not b's.
    const cross = await app.inject({ method: "POST", url: archiveUrl(b, a.siteId), headers: promoteHdr(ws4For("site.archive", { tenantSlug: b.slug, siteId: a.siteId }, {})) });
    expect(cross.statusCode).toBe(404);
    expect(await siteStatus(a)).toBe("active");

    const ghost = randomUUID();
    const unknown = await app.inject({ method: "POST", url: archiveUrl(a, ghost), headers: promoteHdr(ws4For("site.archive", { tenantSlug: a.slug, siteId: ghost }, {})) });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({ method: "POST", url: archiveUrl(a, "not-a-uuid"), headers: promoteHdr(ws4For("site.archive", { tenantSlug: a.slug, siteId: "not-a-uuid" }, {})) });
    expect(malformed.statusCode).toBe(400);

    expect(await siteStatus(a)).toBe("active");
  });

  // ----------------------------------------------------------------------------------------------
  // What an archived site stops doing (and what it keeps doing)
  // ----------------------------------------------------------------------------------------------
  it("archived: keys stop resolving, control routes refuse with 409 site-archived, the schedule is skipped; the sibling site and the listing are unaffected", async () => {
    const fx = await createContentFixture("sa-effects");
    const keys = await mintReadKeys(app, fx);
    const sibling = await addSibling(fx);

    // A live item (served), and a second one scheduled to go live in an hour.
    const liveRes = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.live", fields: serviceFields() });
    expect(liveRes.statusCode).toBe(201);
    expect((await publishItems(app, fx, [{ itemId: liveRes.json().item.itemId, version: 1 }])).statusCode).toBe(200);
    const dueRes = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.due", fields: serviceFields({ h1: "Due" }) });
    expect(dueRes.statusCode).toBe(201);
    const dueId = dueRes.json().item.itemId as string;
    const schedBody = { items: [{ itemId: dueId, version: 1 }], publishAt: new Date(Date.now() + HOUR).toISOString() };
    const sched = await app.inject({
      method: "POST",
      url: `${base(fx)}/schedule`,
      headers: hdr({ ws4: ws4For("content.schedule", { tenantSlug: fx.slug, siteId: fx.siteId }, schedBody) }),
      payload: schedBody,
    });
    expect(sched.statusCode).toBe(200);

    expect((await v1Get(app, fx, keys.production, "service", "service.live")).statusCode).toBe(200); // before

    expect((await post(fx, archiveWs4(fx))).statusCode).toBe(201);

    // Public reads: the key no longer resolves — the same answer as a revoked key.
    const afterRead = await v1Get(app, fx, keys.production, "service", "service.live");
    expect(afterRead.statusCode).toBe(401);
    expect(afterRead.json().type).toBe(`${PROBLEM}invalid-credentials`);
    expect((await v1Get(app, fx, keys.staging, "service", "service.live")).statusCode).toBe(401);

    // Control-plane writes and publishes: a typed 409.
    const create = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: "service.new", fields: serviceFields() });
    expect(create.statusCode).toBe(409);
    expect(create.json().type).toBe(`${PROBLEM}site-archived`);
    const publish = await publishItems(app, fx, [{ itemId: dueId, version: 1 }]);
    expect(publish.statusCode).toBe(409);
    expect(publish.json().type).toBe(`${PROBLEM}site-archived`);
    const env = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/environments`,
      headers: hdr({ scopes: ["webdesk:operate"], editorial: null }),
      payload: { name: "staging" },
    });
    expect(env.statusCode).toBe(409);

    // Control reads of the site refuse too (the mirror of an archived tenant's 404, typed).
    const read = await app.inject({ method: "GET", url: `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/collections`, headers: hdr({ scopes: ["webdesk:read"], editorial: null, idem: null }) });
    expect(read.statusCode).toBe(409);
    expect(read.json().type).toBe(`${PROBLEM}site-archived`);

    // Schedules: the tick skips the archived site's due item (it stays 'scheduled', never goes live).
    await tick.runContentTick(new Date(Date.now() + 2 * HOUR));
    const due = await asTenant(fx.tenantId, async (c) => (await c.query(`SELECT publish_state FROM content_items WHERE id = $1`, [dueId])).rows[0]);
    expect(due.publish_state).toBe("scheduled");

    // The sibling site of the same tenant is untouched and still resolves its own key.
    expect(await siteStatus(fx, sibling.siteId)).toBe("active");
    const apiKeys = app.get(ApiKeysService);
    const sibKey = (await apiKeys.mint(fx.tenantId, sibling.envId, "read", "sa-test")).key;
    expect(await apiKeys.resolve(fx.tenantId, sibKey)).toMatchObject({ siteId: sibling.siteId });

    // The tenant listing still lists the archived site, marked archived (the staff UI shows it as such).
    const companyRef = await asPlatform(async (c) => (await c.query(`SELECT company_ref FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].company_ref as string);
    const listed = (await app.get(TenantReadsService).list(companyRef)).tenants.find((t) => t.slug === fx.slug);
    expect(listed?.sites.find((s) => s.siteId === fx.siteId)?.status).toBe("archived");
    expect(listed?.sites.find((s) => s.siteId === sibling.siteId)?.status).toBe("active");
  });
});
