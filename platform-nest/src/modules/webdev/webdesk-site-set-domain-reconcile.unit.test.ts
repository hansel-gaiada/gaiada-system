// M6-P6i — the reconcile-by-reading step of site.setDomain, and the fake Zone B's `site.setDomain` that the DB suite
// (webdesk-site-set-domain.test.ts) leans on, WITHOUT Postgres or Cerbos. After an ambiguous failure the executor READS the
// environment's domain (`tenant.list?companyRef=`) and decides whether the requested value holds; it never resends. The fake is
// held to WebDesk's own refusals (lifecycle.service#setSiteDomain) here, so a DB suite that passes against it means something.
import { beforeEach, describe, expect, it } from "vitest";
import { WebdeskControlTransportError, type WebdeskControlRequest } from "./webdesk-control-client";
import { reconcileSetDomainByReading } from "./webdesk-approved-command";
import { FakeZoneB, GAIADA_ENV, GAIADA_SITE, GAIADA_SLUG, OTHER_ENV } from "./webdesk-content-testkit";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const setDomain = (envId: string, domain: string | null, siteId = GAIADA_SITE): WebdeskControlRequest => ({
  command: "site.setDomain",
  method: "POST",
  path: "/control/v1/tenants/:tenantSlug/sites/:siteId/domain",
  params: { tenantSlug: GAIADA_SLUG, siteId },
  body: { envId, domain },
  idempotencyKey: "ws4:test-approval",
  ws4: { approvalId: "test-approval" },
});
const args = (envId: string, domain: string | null) => ({ command: "site.setDomain" as const, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, envId, domain });

describe("the fake Zone B's site.setDomain follows WebDesk's own refusals", () => {
  let zb: FakeZoneB;
  beforeEach(() => {
    zb = new FakeZoneB(COMPANY_A, COMPANY_B);
  });

  it("sets, names the previous domain, and tenant.list then reports the new one", async () => {
    const r = await zb.send(setDomain(GAIADA_ENV.production, "shop.example.test"));
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ environment: { id: GAIADA_ENV.production, name: "production", domain: "shop.example.test", previousDomain: null }, replayed: false });
    const again = await zb.send(setDomain(GAIADA_ENV.production, "shop2.example.test"));
    expect(again.json).toMatchObject({ environment: { domain: "shop2.example.test", previousDomain: "shop.example.test" } });
    const list = await zb.send({ command: "tenant.list", method: "GET", path: "/control/v1/tenants", query: { companyRef: COMPANY_A } });
    const envs = (list.json as { tenants: Array<{ sites: Array<{ environments: Array<{ envId: string; domain: string | null }> }> }> }).tenants[0].sites[0].environments;
    expect(envs.find((e) => e.envId === GAIADA_ENV.production)?.domain).toBe("shop2.example.test");
  });

  it("a clear sets null and names what it cleared; a no-op is a 409", async () => {
    await zb.send(setDomain(GAIADA_ENV.production, "shop.example.test"));
    const cleared = await zb.send(setDomain(GAIADA_ENV.production, null));
    expect(cleared.json).toMatchObject({ environment: { domain: null, previousDomain: "shop.example.test" } });
    expect((await zb.send(setDomain(GAIADA_ENV.production, null))).status).toBe(409);
    expect((await zb.send(setDomain(GAIADA_ENV.staging, "staging.gaiada.test"))).status).toBe(409); // the fixture's own staging domain
  });

  it("an env that is not THIS site's is a 404, a domain held by the sibling environment is a 409, an archived site is a 409", async () => {
    expect((await zb.send(setDomain(OTHER_ENV.production, "x.example.test"))).status).toBe(404);
    await zb.send(setDomain(GAIADA_ENV.production, "held.example.test"));
    expect((await zb.send(setDomain(GAIADA_ENV.staging, "held.example.test"))).status).toBe(409);
    zb.archivedSites.add(GAIADA_SITE);
    expect((await zb.send(setDomain(GAIADA_ENV.production, "later.example.test"))).status).toBe(409);
  });

  it("records the call with its WS4 marker, params and body (what the executor's suite asserts)", async () => {
    await zb.send(setDomain(GAIADA_ENV.production, "shop.example.test"));
    expect(zb.writes).toHaveLength(1);
    expect(zb.calls[0]).toMatchObject({
      command: "site.setDomain", hadWs4: true, params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE }, body: { envId: GAIADA_ENV.production, domain: "shop.example.test" },
    });
  });
});

describe("reconcileSetDomainByReading: the environment has the requested value, or it does not, or it could not be read", () => {
  let zb: FakeZoneB;
  beforeEach(() => {
    zb = new FakeZoneB(COMPANY_A, COMPANY_B);
  });

  it("true when the environment already has the domain (the answer was lost but the write landed)", async () => {
    await zb.send(setDomain(GAIADA_ENV.production, "shop.example.test"));
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, "shop.example.test"))).toBe(true);
  });

  it("false when it does not (the write never landed), for a set and for a clear", async () => {
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, "shop.example.test"))).toBe(false);
    await zb.send(setDomain(GAIADA_ENV.production, "shop.example.test"));
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, null))).toBe(false);
  });

  it("a clear is confirmed by the environment having NO domain", async () => {
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, null))).toBe(true); // it has none today
  });

  it("null when the state cannot be read: an unknown env, another company's tenant, a transport failure, a refusal", async () => {
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args("99999999-9999-4999-8999-999999999999", "x.example.test"))).toBeNull();
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_B, args(GAIADA_ENV.production, "x.example.test"))).toBeNull(); // tenant.list is company-filtered
    zb.failWith = new WebdeskControlTransportError("down", 1, false, "ECONNREFUSED");
    expect(await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, "x.example.test"))).toBeNull();
  });

  it("only READS: it sends tenant.list and never a second site.setDomain", async () => {
    await reconcileSetDomainByReading(zb.asClient(), COMPANY_A, args(GAIADA_ENV.production, "shop.example.test"));
    expect(zb.calls.map((c) => c.command)).toEqual(["tenant.list"]);
    expect(zb.calls[0].query).toEqual({ companyRef: COMPANY_A });
  });
});
