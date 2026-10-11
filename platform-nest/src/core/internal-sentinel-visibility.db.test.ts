// M5-G0b — the internal sentinel client (WSK-D36, clients.is_internal) is HIDDEN from client-facing
// surfaces and SHOWN (flagged) to staff. Real Postgres (RLS) + the real HTTP layer; Cerbos is stubbed
// to allow-all because what is under test is the visibility predicate, not the tier matrix.
// Needs DATABASE_URL_TEST (skips silently otherwise — check the skip count). Linux gate only.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants, newId } from "../db";
import { buildApp } from "../main";
import { setStorageForTest } from "./storage";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../testing/fixtures";
import { registerModule, resetModules } from "../modules/registry";
import { searchModule } from "../modules/search/index";
import { socialModule } from "../modules/social/index";
import { resolvePortalScope } from "./portal-scope";
import { resolveCitation } from "../modules/assistant/citations";
import { buildErpDocuments } from "../modules/knowledge/ingest/erp-source";

vi.mock("../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("M5-G0b · internal sentinel client visibility", () => {
  let app: NestFastifyApplication;
  let co: string;
  let staff: string;
  let portalUser: string;
  let normal: string;
  let internal: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    resetModules();
    registerModule(searchModule);
    registerModule(socialModule);
    co = await createCompany("Sentinel Co", ["clients", "search", "social", "invoice", "knowledge"]);
    staff = await createUser("sentinel-staff@a.test");
    portalUser = await createUser("sentinel-portal@a.test");
    await addMembership(co, staff);
    await addMembership(co, portalUser);
    normal = await createClient(co, "Normal Client", portalUser);
    internal = await createClient(co, "Our Own Sites");
    await withTenants([co], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [internal]));
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── SHOWN to staff, flagged ───────────────────────────────────────────────────────────────────
  it("the staff client list includes the sentinel with isInternal=true and a normal client with false", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients`, headers: asUser(staff) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ id: string; isInternal: boolean }>;
    expect(rows.find((x) => x.id === internal)?.isInternal).toBe(true);
    expect(rows.find((x) => x.id === normal)?.isInternal).toBe(false);
  });

  it("the Clients Centre list includes the sentinel flagged", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/centre`, headers: asUser(staff) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ clientId: string; isInternal: boolean }>;
    expect(rows.find((x) => x.clientId === internal)?.isInternal).toBe(true);
    expect(rows.find((x) => x.clientId === normal)?.isInternal).toBe(false);
  });

  // ── HIDDEN: portal scope ──────────────────────────────────────────────────────────────────────
  it("portal scope excludes the sentinel even for a contact and a legacy portal_user_id owner", async () => {
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1,$2,$3,$4,NULL,'viewer','active',now(),$5)`,
        [newId(), co, internal, portalUser, config.originSite],
      );
      await c.query(`UPDATE clients SET portal_user_id = $2 WHERE id = $1`, [internal, portalUser]);
    });
    const scope = await withTenants([co], (c) => resolvePortalScope(c, { userId: portalUser } as never));
    expect(scope.clientIds).toContain(normal);
    expect(scope.clientIds).not.toContain(internal);
  });

  it("the portal centre list excludes the sentinel and includes the normal client", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/centre`, headers: asUser(portalUser) });
    expect(r.statusCode).toBe(200);
    const ids = (r.json() as Array<{ clientId: string }>).map((x) => x.clientId);
    expect(ids).toContain(normal);
    expect(ids).not.toContain(internal);
  });

  // ── HIDDEN: invoicing ─────────────────────────────────────────────────────────────────────────
  it("invoice generation is refused for the sentinel (404) and accepted for a normal client", async () => {
    const body = (clientId: string) => ({ clientId, periodStart: "2026-01-01", periodEnd: "2026-01-31", rate: 100 });
    const bad = await app.inject({ method: "POST", url: `/api/${co}/invoices`, headers: asUser(staff), payload: body(internal) });
    expect(bad.statusCode).toBe(404);
    const ok = await app.inject({ method: "POST", url: `/api/${co}/invoices`, headers: asUser(staff), payload: body(normal) });
    expect(ok.statusCode).toBe(201);
  });

  // ── HIDDEN: assistant citations + knowledge ingest ────────────────────────────────────────────
  it("a client citation resolves for a normal client and not for the sentinel", async () => {
    const [n, i] = await withTenants([co], async (c) => [
      await resolveCitation(c, co, `erp:client:${normal}`),
      await resolveCitation(c, co, `erp:client:${internal}`),
    ]);
    expect(n?.label).toBe("Normal Client");
    expect(i).toBeNull();
  });

  it("the knowledge ERP ingest emits a client document for a normal client and not for the sentinel", async () => {
    const docs = await buildErpDocuments(co);
    const refs = docs.map((d) => d.sourceRef);
    expect(refs).toContain(`erp:client:${normal}`);
    expect(refs).not.toContain(`erp:client:${internal}`);
  });

  // ── HIDDEN: client-facing reports ─────────────────────────────────────────────────────────────
  async function mkEngagement(clientId: string, domain: string): Promise<string> {
    const p = await app.inject({
      method: "POST", url: `/api/${co}/modules/search/properties`, headers: asUser(staff),
      payload: { clientId, domain, siteUrl: `https://${domain}` },
    });
    expect(p.statusCode).toBe(201);
    const e = await app.inject({
      method: "POST", url: `/api/${co}/modules/search/engagements`, headers: asUser(staff),
      payload: { clientId, propertyId: p.json().id, name: `eng ${domain}` },
    });
    expect(e.statusCode).toBe(201);
    return e.json().id as string;
  }
  const draft = (eng: string, period: string) => app.inject({
    method: "POST", url: `/api/${co}/modules/search/engagements/${eng}/reports`,
    headers: asUser(staff), payload: { period, kind: "monthly" },
  });

  it("search: no report is drafted for a sentinel engagement; one is for a normal client", async () => {
    const engInternal = await mkEngagement(internal, "own.example.com");
    const engNormal = await mkEngagement(normal, "client.example.com");
    expect((await draft(engInternal, "2026-01")).statusCode).toBe(400);
    expect((await draft(engNormal, "2026-01")).statusCode).toBe(201);
  });

  it("search: an approved report whose client is the sentinel is not delivered (400); a normal one is (200)", async () => {
    const mkApproved = async (clientId: string, domain: string) => {
      const d = await draft(await mkEngagement(clientId, domain), "2026-02");
      expect(d.statusCode).toBe(201);
      const id = d.json().id as string;
      await app.inject({ method: "PATCH", url: `/api/${co}/modules/search/reports/${id}`, headers: asUser(staff), payload: { status: "in_review" } });
      await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${id}/approve`, headers: asUser(staff) });
      return id;
    };
    const normalReport = await mkApproved(normal, "deliver-normal.example.com");
    // A second normal client is flipped to internal AFTER its report is approved, to reach the deliver guard.
    const flip = await createClient(co, "Flipped Later");
    const flipReport = await mkApproved(flip, "deliver-flip.example.com");
    await withTenants([co], (c) => c.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [flip]));
    const bad = await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${flipReport}/deliver`, headers: asUser(staff) });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toMatch(/internal client/);
    const ok = await app.inject({ method: "POST", url: `/api/${co}/modules/search/reports/${normalReport}/deliver`, headers: asUser(staff) });
    expect(ok.statusCode).toBe(200);
  });

  it("social: report creation is refused for a sentinel engagement with internal_client_no_reports", async () => {
    const mkEng = async (clientId: string) => {
      const e = await app.inject({
        method: "POST", url: `/api/${co}/modules/social/engagements`, headers: asUser(staff),
        payload: { clientId, name: "social eng" },
      });
      expect(e.statusCode).toBe(201);
      return e.json().id as string;
    };
    const post = (eng: string) => app.inject({
      method: "POST", url: `/api/${co}/modules/social/engagements/${eng}/reports`,
      headers: asUser(staff), payload: { kind: "monthly", period: "2026-01" },
    });
    const bad = await post(await mkEng(internal));
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain("internal_client_no_reports");
    // A normal client is NOT refused for this reason (it may still fail downstream on the unconfigured gateway).
    const other = await post(await mkEng(normal));
    expect(JSON.stringify(other.json())).not.toContain("internal_client_no_reports");
  });
});
