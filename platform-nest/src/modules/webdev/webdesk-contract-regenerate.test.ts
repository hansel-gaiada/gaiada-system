// M6-P4c — `POST /api/:tenantId/modules/webdev/control/contract/regenerate` (`webdesk.contract.regenerate`)
// against REAL Postgres + Cerbos, with the WebDesk control client faked at its HTTP boundary, plus the D14
// approval -> execute path for an UNATTENDED caller (the hub faked at its HTTP boundary, as in
// approval-execute.test.ts).
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. Cerbos `operate` is the first statement: a plain member is 403 with a VALID body and nothing reaches WebDesk;
//   2. one tenant: only an ACTIVE tenant of THIS company (another company's slug is the uniform 404), the
//      caller's Idempotency-Key forwarded, no WS4 assertion (MEDIUM), the answer reported;
//   3. company scope (no slug): every active tenant of THIS company, one per-tenant command each, never another
//      company's, never WebDesk's platform-wide route; a retried company call reuses the derived keys;
//   4. a strict body;
//   5. approval -> execute: an approved suspension of the tool is re-driven through the hub exactly once, as
//      the ORIGINAL filing principal, with the stored args; a malformed slug fails at the precondition and
//      the hub is never called.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { executeApprovedAutomationWrite } from "../../core/approval-execute";
import { WebdeskControlController } from "./webdesk-control.controller";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { problem } from "./webdesk-content-testkit";
import type { WebdeskControlClient, WebdeskControlRequest, WebdeskControlResponse } from "./webdesk-control-client";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const ok = (json: unknown, status = 200): WebdeskControlResponse => ({ status, contentType: "application/json", json, bodyText: JSON.stringify(json) });

class FakeWebdesk {
  calls: WebdeskControlRequest[] = [];
  tenants: Array<{ slug: string; companyRef: string; status: string }> = [];
  keys = new Set<string>();
  failSlug: string | null = null;

  regenerateCalls(): WebdeskControlRequest[] {
    return this.calls.filter((c) => c.command === "contract.regenerate");
  }

  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    this.calls.push(req);
    if (req.command === "tenant.list") {
      return ok({
        tenants: this.tenants
          .filter((t) => t.companyRef === req.query?.companyRef)
          .map((t) => ({ slug: t.slug, status: t.status, defaultLocale: "en", locales: ["en"], sites: [] })),
      });
    }
    if (req.command === "contract.regenerate") {
      const slug = req.params?.tenantSlug as string;
      if (slug === this.failSlug) return problem(404, "not-found");
      const key = req.idempotencyKey as string;
      const replayed = this.keys.has(`${slug}|${key}`);
      this.keys.add(`${slug}|${key}`);
      return ok(replayed
        ? { scope: "tenant", tenants: [slug], replayed: true }
        : { scope: "tenant", tenants: [slug], replayed: false, enqueue: { requested: 1, queued: 1, failed: 0 } });
    }
    return problem(404, "not-found");
  }
}

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdeskControlController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P4c · webdesk.contract.regenerate (HTTP, isolated app, faked WebDesk)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let otherCo: string;
  let member: string;
  let admin: string;
  let wd: FakeWebdesk;
  const url = () => `/api/${tenant}/modules/webdev/control/contract/regenerate`;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("P4c Regenerate Co", ["webdev"]);
    otherCo = await createCompany("P4c Regenerate Other", ["webdev"]);
    member = await createUser("p4c-regen-member@a.test", "Regen Member");
    admin = await createUser("p4c-regen-admin@a.test", "Regen Admin");
    await addMembership(tenant, member);
    await addMembership(tenant, admin);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenant);
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    setWebdeskApprovedCommandDepsForTests(null);
    await app.close();
    await teardownTestDb();
  });
  beforeEach(() => {
    wd = new FakeWebdesk();
    wd.tenants.push(
      { slug: "acme", companyRef: tenant, status: "active" },
      { slug: "acme-shop", companyRef: tenant, status: "active" },
      { slug: "acme-old", companyRef: tenant, status: "archived" },
      { slug: "rival", companyRef: otherCo, status: "active" },
    );
    setWebdeskApprovedCommandDepsForTests({ client: wd as unknown as WebdeskControlClient });
    webdeskZoneB.clearSiteCache();
  });

  it("a plain member is DENIED (403) with a VALID body, and nothing reaches WebDesk", async () => {
    const r = await app.inject({ method: "POST", url: url(), headers: asUser(member), payload: { slug: "acme" } });
    expect(r.statusCode).toBe(403);
    expect(wd.calls).toHaveLength(0);
  });

  it("ONE tenant: the company_admin's call queues WebDesk's per-tenant command with the caller's key and no WS4", async () => {
    const r = await app.inject({
      method: "POST", url: url(), headers: { ...asUser(admin), "idempotency-key": "regen-key-0001" }, payload: { slug: "acme" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      scope: "tenant",
      tenants: [{ tenantSlug: "acme", outcome: "queued", replayed: false, enqueue: { requested: 1, queued: 1, failed: 0 } }],
    });
    const sent = wd.regenerateCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST", path: "/control/v1/tenants/:tenantSlug/contract/regenerate", params: { tenantSlug: "acme" }, idempotencyKey: "regen-key-0001",
    });
    expect(sent[0].ws4).toBeUndefined();
    expect(sent[0].body).toBeUndefined();
    // Ledgered like every control write: attempted, then succeeded.
    const acts = await adminPool().query(
      `SELECT metadata->>'outcome' AS outcome FROM activities WHERE tenant_id = $1 AND verb = 'webdesk.contract.regenerate' AND metadata->>'idempotencyKey' = 'regen-key-0001' ORDER BY occurred_at`,
      [tenant],
    );
    expect(acts.rows.map((x) => x.outcome)).toEqual(["attempted", "succeeded"]);
  });

  it("another company's slug (and an archived one) is the uniform 404 site-not-found; nothing is queued", async () => {
    for (const slug of ["rival", "acme-old", "no-such-tenant"]) {
      webdeskZoneB.clearSiteCache();
      const r = await app.inject({ method: "POST", url: url(), headers: asUser(admin), payload: { slug } });
      expect(r.statusCode).toBe(404);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.json().type).toMatch(/site-not-found$/);
    }
    expect(wd.regenerateCalls()).toHaveLength(0);
  });

  it("COMPANY scope (no slug, or no body at all): every ACTIVE tenant of THIS company, never another's, never the platform route", async () => {
    for (const payload of [{}, undefined]) {
      wd.calls = [];
      webdeskZoneB.clearSiteCache();
      const r = await app.inject({ method: "POST", url: url(), headers: { ...asUser(admin), "idempotency-key": "company-key-0001" }, ...(payload ? { payload } : {}) });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.scope).toBe("company");
      expect(body.tenants.map((t: { tenantSlug: string }) => t.tenantSlug).sort()).toEqual(["acme", "acme-shop"]);
      const paths = wd.regenerateCalls().map((c) => c.params?.tenantSlug).sort();
      expect(paths).toEqual(["acme", "acme-shop"]);
      expect(wd.calls.some((c) => c.path === "/control/v1/contract/regenerate")).toBe(false);
    }
    // The second pass used the same caller key, so WebDesk saw the same derived per-tenant keys: replays.
    const keys = wd.regenerateCalls().map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => /^regen-[0-9a-f]{64}$/.test(k as string))).toBe(true);
  });

  it("COMPANY scope: a tenant whose command fails is reported failed with a typed token; the others still run", async () => {
    wd.failSlug = "acme-shop";
    const r = await app.inject({ method: "POST", url: url(), headers: asUser(admin), payload: {} });
    expect(r.statusCode).toBe(200);
    const byslug = Object.fromEntries(r.json().tenants.map((t: { tenantSlug: string }) => [t.tenantSlug, t]));
    expect(byslug.acme).toMatchObject({ outcome: "queued" });
    expect(byslug["acme-shop"]).toMatchObject({ outcome: "failed", error: "webdesk_refused: 404 not-found" });
  });

  it("a strict body: an unknown key, a non-string slug, or a non-object is 400 — after the 403 for a member", async () => {
    for (const payload of [{ slug: "acme", all: true }, { slug: 5 }, { slug: "" }, ["acme"]]) {
      const r = await app.inject({ method: "POST", url: url(), headers: asUser(admin), payload: payload as never });
      expect(r.statusCode).toBe(400);
    }
    expect(wd.regenerateCalls()).toHaveLength(0);
  });
});

// ══ The D14 approval -> execute path (an UNATTENDED caller's suspension, approved) ══════════════════════

type HubReply = { kind: "ok"; text: string };
let hubCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
const realFetch = globalThis.fetch;

function installHubStub(reply: HubReply): void {
  hubCalls = [];
  const stub = vi.fn(async (u: string, init: any) => {
    if (!String(u).startsWith("http://hub.test")) return realFetch(u as any, init);
    hubCalls.push({ url: String(u), headers: init.headers as Record<string, string>, body: JSON.parse(init.body) });
    const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }] } };
    return { ok: true, status: 200, text: async () => `event: message\ndata: ${JSON.stringify(rpc)}\n\n` };
  });
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
}

describe.skipIf(!TEST_URL)("M6-P4c · webdesk.contract.regenerate — D14 approval -> execute", () => {
  let co: string;
  let admin: string;
  let wfUser: string;

  async function fileDecided(args: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1, $2, 'wf:delivery', 'webdesk.contract.regenerate', $3, 'medium', 'approved', $4, $5, now(), 'automation', 'main', 'pending')`,
        [id, co, JSON.stringify(args), wfUser, admin],
      ),
    );
    return id;
  }

  async function rowOf(id: string) {
    const r = await adminPool().query(`SELECT execution_status, execution_error, executed_by FROM automation_approvals WHERE id = $1`, [id]);
    return r.rows[0] as { execution_status: string; execution_error: string | null; executed_by: string | null };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "p4c-regenerate-test-secret-not-real";
    config.services.hub = { url: "http://hub.test", token: "hub-token", assuranceToken: "" };
    co = await createCompany("P4c Regenerate D14 Co", ["webdev"]);
    await seedAutomationAccounts(co);
    admin = await createUser("p4c-regen-d14-admin@a.test");
    await addMembership(co, admin);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(() => installHubStub({ kind: "ok", text: JSON.stringify({ scope: "tenant", tenants: [{ tenantSlug: "acme", outcome: "queued" }] }) }));
  afterEach(() => vi.restoreAllMocks());

  it("an approved suspension is re-driven through the hub ONCE, as the original filing principal, with the stored args", async () => {
    const id = await fileDecided({ tenantId: co, slug: "acme" });
    const outcome = await executeApprovedAutomationWrite(co, id);
    expect(outcome).toMatchObject({ status: "executed" });
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].body).toMatchObject({
      method: "tools/call",
      params: { name: "webdesk.contract.regenerate", arguments: { tenantId: co, slug: "acme" } },
    });
    expect(hubCalls[0].headers["x-obo-provider"]).toBe("n8n");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("wf:delivery");
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.executed_by).toBe(wfUser);
    // Single use: a second execution of the same row does not call the hub again.
    await executeApprovedAutomationWrite(co, id);
    expect(hubCalls).toHaveLength(1);
  });

  it("the company-wide form (no slug) executes the same way", async () => {
    const id = await fileDecided({ tenantId: co });
    expect(await executeApprovedAutomationWrite(co, id)).toMatchObject({ status: "executed" });
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].body.params.arguments).toEqual({ tenantId: co });
  });

  it("a malformed slug fails at the precondition: the row is failed with the typed reason and the hub is never called", async () => {
    const id = await fileDecided({ tenantId: co, slug: "Not A Slug" });
    const outcome = await executeApprovedAutomationWrite(co, id);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(hubCalls).toHaveLength(0);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("failed");
    expect(row.execution_error).toContain("tenant_slug_invalid");
  });
});
