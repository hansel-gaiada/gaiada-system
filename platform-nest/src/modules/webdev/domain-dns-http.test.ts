// M6-P6i — `GET /api/:t/modules/webdev/sites/:id/dns`: the DNS checklist and the read-only check, against REAL Cerbos + RLS, with a
// STUBBED resolver and operator targets installed through the test seams (no suite ever dials a resolver). Also the claim route's
// additive `property` member, because that is how the console learns whether MON-01 may probe the domain.
//
// What it proves:
//   - the gate is `webdev_site · read`: admin and webdev staff read, a member and a client-only grant are 403, another company's row
//     and a malformed id are 404;
//   - the states, in the order a person fixes them: `not_claimed` (the placeholder), `needs_binding`, `target_unknown` (the
//     console says to ask the operator; the resolver is NOT asked and no address is invented), `ready` with the records, and the
//     check `pending` (nothing there, elsewhere, half-finished, resolver down) or `pointing`;
//   - O-12: who edits the records (the owner for an internal domain, the client for a client's);
//   - the property's consent state is on the answer, and the claim's response carries it too;
//   - it writes nothing: no registry change, no property, no approval, from any read.
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { createWebdevSite } from "./site-registry.service";
import { setDnsLookupForTests } from "./domain-dns-lookup";
import { setDnsTargetsForTests } from "./domain-dns.service";
import type { ObservedDns } from "./domain-dns";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const TARGETS = new Map([
  ["hostinger-1", [{ type: "A" as const, value: "203.0.113.10" }]],
  ["edge-1", [{ type: "CNAME" as const, value: "edge.hosting.example.net" }]],
]);

describe.skipIf(!live)("GET sites/:id/dns — the checklist and the read-only check (M6-P6i)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let admin: string;
  let webdevStaff: string;
  let member: string;
  let clientOnly: string;
  let realClient: string;
  let sentinel: string;
  let asked: string[];
  let answer: ObservedDns;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Dns Co", ["webdev", "search"]);
    other = await createCompany("Rival Dns Co", ["webdev", "search"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    admin = await mk("admin@dns.test", "company_admin");
    webdevStaff = await mk("staff@dns.test", "webdev_staff");
    member = await mk("member@dns.test", "member");
    clientOnly = await mk("client@dns.test", "client");
    realClient = await createClient(co, "Real Dns Client");
    sentinel = await createClient(co, "Internal Dns");
    await adminPool().query(`UPDATE clients SET is_internal = true WHERE id = $1`, [sentinel]);
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  afterEach(() => {
    setDnsLookupForTests(null);
    setDnsTargetsForTests(null);
  });

  const dns = (id: string, who = admin, tenant = co) =>
    app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/sites/${id}/dns`, headers: asUser(who) });
  const bound = (domain: string, over: Record<string, unknown> = {}) =>
    createWebdevSite(co, { domain, hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh", ...over } as never, null);
  const setup = (a: ObservedDns = { a: [], aaaa: [], cname: [] }, targets = TARGETS) => {
    asked = [];
    answer = a;
    setDnsTargetsForTests(targets);
    setDnsLookupForTests(async (d) => (asked.push(d), answer));
  };
  const counts = async () => {
    const q = (sql: string) => adminPool().query<{ n: string }>(sql).then((r) => Number(r.rows[0].n));
    return {
      sites: await q(`SELECT count(*)::text AS n FROM webdev_sites`),
      properties: await q(`SELECT count(*)::text AS n FROM search_properties`),
      approvals: await q(`SELECT count(*)::text AS n FROM automation_approvals`),
    };
  };

  it("authorization: admin and webdev staff read (200); a member and a client-only grant are 403; another company's row and a malformed id are 404", async () => {
    setup();
    const s = await bound("authz.example.com");
    expect((await dns(s.id)).statusCode).toBe(200);
    expect((await dns(s.id, webdevStaff)).statusCode).toBe(200);
    expect((await dns(s.id, member)).statusCode).toBe(403);
    expect((await dns(s.id, clientOnly)).statusCode).toBe(403);
    expect((await dns("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await dns("not-a-uuid")).statusCode).toBe(404);
    // company B's row is not visible to company A's admin (the URL says A, the id is B's)
    const foreign = await createWebdevSite(other, { domain: "foreign.example.com" }, null);
    expect((await dns(foreign.id)).statusCode).toBe(404);
  });

  it("READY + POINTING: the records are the documented target on the domain, the resolver was asked about THAT domain only, and the answer is `pointing`", async () => {
    setup({ a: ["203.0.113.10"], aaaa: [], cname: [] });
    const s = await bound("pointing.example.com", { clientId: realClient });
    const r = await dns(s.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      siteId: s.id, domain: "pointing.example.com", environment: "production", hostKind: "shared-hosting", hostRef: "hostinger-1",
      recordsOwner: "client",
      checklist: { state: "ready", records: [{ type: "A", name: "pointing.example.com", target: "203.0.113.10" }], instruction: null },
      observed: { a: ["203.0.113.10"], aaaa: [], cname: [] },
      check: { state: "pointing", reason: null },
    });
    expect(typeof r.json().checkedAt).toBe("string");
    expect(asked).toEqual(["pointing.example.com"]);
  });

  it("READY + PENDING, case by case: nothing there yet, points elsewhere, half-finished, and a resolver failure", async () => {
    const s = await bound("pending.example.com");
    const check = async (a: ObservedDns) => {
      setup(a);
      const r = await dns(s.id);
      expect(r.statusCode, r.body).toBe(200);
      return r.json().check;
    };
    expect(await check({ a: [], aaaa: [], cname: [] })).toEqual({ state: "pending", reason: "no_records" });
    expect(await check({ a: ["198.51.100.7"], aaaa: [], cname: [] })).toEqual({ state: "pending", reason: "points_elsewhere" });
    expect(await check({ a: ["203.0.113.10", "198.51.100.7"], aaaa: [], cname: [] })).toEqual({ state: "pending", reason: "mixed_with_other_hosts" });
    expect(await check({ a: [], aaaa: [], cname: [], error: "ESERVFAIL" })).toEqual({ state: "pending", reason: "lookup_failed" });
  });

  it("a CNAME host: the record is a CNAME on the domain, and `pointing` is the domain's CNAME being that name", async () => {
    const s = await bound("cname.example.com", { hostKind: "our-box", hostRef: "edge-1" });
    setup({ a: ["198.51.100.7"], aaaa: [], cname: ["edge.hosting.example.net"] });
    const r = await dns(s.id);
    expect(r.json()).toMatchObject({
      checklist: { state: "ready", records: [{ type: "CNAME", name: "cname.example.com", target: "edge.hosting.example.net" }] },
      check: { state: "pointing", reason: null },
    });
  });

  it("TARGET UNKNOWN: a host_ref with no documented target says to ask the operator, lists NO record, and the resolver is not asked", async () => {
    setup({ a: ["203.0.113.10"], aaaa: [], cname: [] });
    const s = await bound("unknown-target.example.com", { hostRef: "hostinger-9" });
    const r = await dns(s.id);
    expect(r.json()).toMatchObject({
      checklist: {
        state: "target_unknown", records: [],
        instruction: 'Ask the operator for the DNS target of the host account "hostinger-9": it is not recorded here, and none is guessed.',
      },
      observed: null,
      check: { state: "pending", reason: "target_unknown" },
    });
    expect(asked).toEqual([]); // nothing to compare with, so nothing is asked
  });

  it("with NO targets configured at all, every bound host is target_unknown (the default: the repo carries no address)", async () => {
    setup({ a: ["203.0.113.10"], aaaa: [], cname: [] }, new Map());
    const s = await bound("no-targets.example.com");
    expect((await dns(s.id)).json().checklist.state).toBe("target_unknown");
  });

  it("NEEDS BINDING: a row with no delivery binding has no records yet, and the resolver is not asked", async () => {
    setup();
    const s = await createWebdevSite(co, { domain: "unbound.example.com" }, null); // host_kind unknown, no host_ref
    const r = await dns(s.id);
    expect(r.json()).toMatchObject({ checklist: { state: "needs_binding", records: [] }, observed: null, check: { state: "pending", reason: "needs_binding" } });
    expect(asked).toEqual([]);
  });

  it("NOT CLAIMED: the registry's placeholder domain has no records and cannot be checked, whatever the binding", async () => {
    setup({ a: ["203.0.113.10"], aaaa: [], cname: [] });
    const s = await bound("unclaimed.provisioned.invalid", { origin: "provisioned", environment: "staging" });
    const r = await dns(s.id);
    expect(r.json()).toMatchObject({ checklist: { state: "not_claimed", records: [] }, observed: null, check: { state: "pending", reason: "domain_not_claimed" } });
    expect(asked).toEqual([]);
  });

  it("O-12: the owner edits the records of an INTERNAL domain (no client, or the sentinel), the client those of a client's", async () => {
    setup();
    const none = await bound("owner-none.example.com");
    const sen = await bound("owner-sentinel.example.com", { clientId: sentinel });
    const cl = await bound("owner-client.example.com", { clientId: realClient });
    expect((await dns(none.id)).json().recordsOwner).toBe("owner");
    expect((await dns(sen.id)).json().recordsOwner).toBe("owner");
    expect((await dns(cl.id)).json().recordsOwner).toBe("client");
  });

  it("the consent gate rides along: `none` before a claim, `unverified` for a client's claimed domain, `verified` for an internal one; the claim's own answer carries it too", async () => {
    setup();
    // a client's provisioned site: placeholder -> claim over HTTP
    const prov = await createWebdevSite(co, { domain: "gate-client.provisioned.invalid", origin: "provisioned", adoption: "mandated", environment: "staging", clientId: realClient, hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ssh" } as never, null);
    expect((await dns(prov.id)).json().property).toEqual({ id: null, state: "none" });
    const claimed = await app.inject({ method: "POST", url: `/api/${co}/modules/webdev/sites/${prov.id}/domain`, headers: asUser(admin), payload: { domain: "gate-client.example.com" } });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json()).toMatchObject({ domain: "gate-client.example.com", property: { state: "created", verified: false, internal: false } });
    const after = (await dns(prov.id)).json();
    expect(after.property).toEqual({ id: claimed.json().property.propertyId, state: "unverified" });

    // an internal one (the company has a sentinel)
    const internal = await createWebdevSite(co, { domain: "gate-internal.provisioned.invalid", origin: "provisioned", adoption: "mandated", environment: "staging" }, null);
    const c2 = await app.inject({ method: "POST", url: `/api/${co}/modules/webdev/sites/${internal.id}/domain`, headers: asUser(admin), payload: { domain: "gate-internal.example.com" } });
    expect(c2.json()).toMatchObject({ property: { state: "created", verified: true, internal: true } });
    expect((await dns(internal.id)).json().property.state).toBe("verified");
  });

  it("a claim that collides with another client's property is 409 property_domain_conflict over HTTP and the row keeps its placeholder", async () => {
    const otherClient = await createClient(co, "Holds The Domain");
    await adminPool().query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, origin_site) VALUES ($1, $2, 'http-conflict.example.com', 'https://http-conflict.example.com/', 'dns-test')`,
      [co, otherClient],
    );
    const prov = await createWebdevSite(co, { domain: "http-conflict.provisioned.invalid", origin: "provisioned", adoption: "mandated", environment: "staging", clientId: realClient }, null);
    const r = await app.inject({ method: "POST", url: `/api/${co}/modules/webdev/sites/${prov.id}/domain`, headers: asUser(admin), payload: { domain: "http-conflict.example.com" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("property_domain_conflict");
    const row = await app.inject({ method: "GET", url: `/api/${co}/modules/webdev/sites/${prov.id}`, headers: asUser(admin) });
    expect(row.json().domain).toBe("http-conflict.provisioned.invalid");
  });

  it("it is a READ: no registry row, property or approval is created or changed by any of the above reads", async () => {
    setup({ a: ["203.0.113.10"], aaaa: [], cname: [] });
    const s = await bound("readonly.example.com");
    const before = await counts();
    for (let i = 0; i < 3; i++) expect((await dns(s.id)).statusCode).toBe(200);
    expect(await counts()).toEqual(before);
  });
});
