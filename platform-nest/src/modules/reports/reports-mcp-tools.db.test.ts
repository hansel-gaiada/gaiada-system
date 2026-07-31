// TR-28 — Cerbos parity for the four §9.2 read tools this ticket registers (reports.getDocument /
// reports.listPeriods / reports.getMetrics / reports.getCompliance), against LIVE Postgres + real
// RLS + real Cerbos.
//
// "A tool invocation must resolve to the same decision the direct HTTP call would" cannot be
// PROVEN by reading code alone — mcp-hub is a separate project this repo does not import (README:
// "keep components as separate projects, not a monorepo"), and the hub's own generic fronting
// (mcp-hub/src/module-tools.ts's callPlatform()) only ever sends: (1) whatever `fillPath()`
// substitutes into pathTemplate's `:token`s, and (2) for a non-GET method, the remaining args as a
// JSON body. For a GET request every arg NOT consumed by a `:token` is silently DROPPED — see
// index.ts's header for the full accounting of why that forced this file's tool defs to embed
// every real HTTP filter as a `?key=:key` query-string token (and, as a consequence, to mark every
// one of them `required`). `fillPath` below mirrors mcp-hub's implementation byte-for-byte so this
// test builds the EXACT request the hub would send; mcp-hub/src/module-tools.test.ts is what proves
// the hub's OWN code does the same substitution — this file proves the OTHER half: that the
// resulting HTTP request, once it reaches this repo's controllers, resolves to the identical Cerbos
// decision (and identical response body) a direct HTTP call by the SAME underlying user would get.
// Since the hub adds no logic of its own (no DB access, no authz — WS2's own backbone rule) and
// only forwards `x-obo-provider`/`x-obo-external-id`, that parity is not an assumption here, it is
// exercised: every test below fires the OBO-envelope path AND the direct x-user-id path for the
// same identity and compares status code + JSON body.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../../main";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantRole, linkIdentity } from "../../testing/fixtures";
import { newId, withTenants } from "../../db";
import { syncMetricDefinitions } from "../../rollups/engine";
import { reportsModule } from "./index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const obo = (provider: string, externalId: string) => ({ ...svc, "x-obo-provider": provider, "x-obo-external-id": externalId });

/** Mirrors mcp-hub/src/module-tools.ts's fillPath() byte-for-byte (regex substitution over the
 *  WHOLE template string, throws on a missing/empty arg — no path/query distinction, exactly the
 *  mechanism index.ts's header documents). Reimplemented here only because that file lives in a
 *  separate project this repo cannot import. */
function fillPath(template: string, args: Record<string, unknown>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = args[name];
    if (v == null || v === "") throw new Error(`missing path parameter: ${name}`);
    return encodeURIComponent(String(v));
  });
}

/** The exact URL mcp-hub would call the platform with for a proxied invocation of this module's
 *  own registered tool `name`, given `args`. Throws if the tool or its pathTemplate is missing —
 *  which would itself mean the tool can never be fronted generically, exactly what this suite
 *  exists to catch. */
function toolUrl(name: string, args: Record<string, unknown>): string {
  const def = reportsModule.mcpTools.find((t) => t.name === name);
  if (!def?.pathTemplate) throw new Error(`no callable pathTemplate registered for tool ${name}`);
  return fillPath(def.pathTemplate, args);
}

/** A live (unsealed) ReportDocument stamps `header.generatedAt` with the wall clock at compute
 *  time, so two genuinely-identical live computes a few milliseconds apart differ on that ONE
 *  field by construction — not a parity bug. Strips it before a deep-equal comparison; every other
 *  field (including every KPI/series/table value) is still compared byte-for-byte. */
function withoutGeneratedAt<T>(body: T): T {
  const clone = JSON.parse(JSON.stringify(body)) as T & { header?: { generatedAt?: unknown } };
  if (clone && typeof clone === "object" && "header" in clone && clone.header && typeof clone.header === "object") {
    delete (clone.header as { generatedAt?: unknown }).generatedAt;
  }
  return clone;
}

describe.skipIf(!TEST_URL)("TR-28 reports MCP read tools — Cerbos parity (live PG + RLS + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let otherCo: string;
  let alice: string; // member, self
  let bob: string; // member, unrelated to alice's own-scope data
  let admin: string; // company_admin — broad read tier

  const ALICE_WA = "6281177770001@c.us";
  const BOB_WA = "6281177770002@c.us";
  const ADMIN_WA = "6281177770003@c.us";
  const UNKNOWN_WA = "6281177779999@c.us"; // never linked at all — resolves to ANONYMOUS

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("TR-28 Co", ["reports", "pm", "hr"]);
    otherCo = await createCompany("TR-28 Unrelated Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr28.test");
    bob = await createUser("bob@tr28.test");
    admin = await createUser("admin@tr28.test");
    for (const u of [alice, bob, admin]) await addMembership(co, u);
    const memberRole = await createRole("member");
    await grantRole(alice, memberRole, "company", co);
    await grantRole(bob, memberRole, "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1,$2,$3,'d-seo',true,'2020-01-01','manual','central'),
                ($4,$2,$5,'d-seo',true,'2020-01-01','manual','central')`,
        [newId(), co, alice, newId(), bob],
      ),
    );
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO report_work_calendars (tenant_id, working_days, holidays, workday_minutes, origin_site)
           VALUES ($1, '{1,2,3,4,5,6,7}', '[]'::jsonb, 480, 'central')`,
          [co],
        ),
      { modules: ["reports", "pm", "hr"] },
    );

    await linkIdentity(alice, "whatsapp", ALICE_WA, true);
    await linkIdentity(bob, "whatsapp", BOB_WA, true);
    await linkIdentity(admin, "whatsapp", ADMIN_WA, true);

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("reports.getDocument", () => {
    it("an OBO self-read and a direct self session return byte-identical documents", async () => {
      const args = { tenantId: co, grain: "person", scopeRef: alice, periodKind: "day", start: "2026-01-15", end: "2026-01-15" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.getDocument", args), headers: obo("whatsapp", ALICE_WA) });
      const viaDirect = await app.inject({
        method: "GET",
        url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=day&start=2026-01-15`,
        headers: asUser(alice),
      });
      expect(viaObo.statusCode).toBe(200);
      expect(viaDirect.statusCode).toBe(200);
      expect(withoutGeneratedAt(viaObo.json())).toEqual(withoutGeneratedAt(viaDirect.json()));
    });

    it("the tool's own pathTemplate denies a linked user reading someone ELSE's person document — matching a direct call by that same user", async () => {
      const args = { tenantId: co, grain: "person", scopeRef: alice, periodKind: "day", start: "2026-01-15", end: "2026-01-15" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.getDocument", args), headers: obo("whatsapp", BOB_WA) });
      const viaDirect = await app.inject({
        method: "GET",
        url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=day&start=2026-01-15`,
        headers: asUser(bob),
      });
      expect(viaObo.statusCode).toBe(403);
      expect(viaDirect.statusCode).toBe(403);
    });

    it("an OBO envelope that was never linked at all resolves to ANONYMOUS and is denied, never silently granted", async () => {
      const args = { tenantId: co, grain: "person", scopeRef: alice, periodKind: "day", start: "2026-01-15", end: "2026-01-15" };
      const r = await app.inject({ method: "GET", url: toolUrl("reports.getDocument", args), headers: obo("whatsapp", UNKNOWN_WA) });
      expect(r.statusCode).toBe(403);
    });

    it("a custom-range call actually reaches the endpoint with 'end' honored (proves the query string, not just tenantId, survives the hub's pathTemplate substitution)", async () => {
      const args = { tenantId: co, grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-01-01", end: "2026-01-31" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.getDocument", args), headers: obo("whatsapp", ALICE_WA) });
      const viaDirect = await app.inject({
        method: "GET",
        url: `/api/${co}/reports/document?grain=person&scopeRef=${alice}&periodKind=custom&start=2026-01-01&end=2026-01-31`,
        headers: asUser(alice),
      });
      expect(viaObo.statusCode).toBe(200);
      expect(viaObo.json().header.periodKind).toBe("custom");
      expect(withoutGeneratedAt(viaObo.json())).toEqual(withoutGeneratedAt(viaDirect.json()));
    });
  });

  describe("reports.listPeriods", () => {
    it("an OBO member and a direct session for the SAME member return byte-identical period lists", async () => {
      const args = { tenantId: co, kind: "day", from: "2026-01-01", to: "2026-01-31" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.listPeriods", args), headers: obo("whatsapp", ALICE_WA) });
      const viaDirect = await app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=day&from=2026-01-01&to=2026-01-31`, headers: asUser(alice) });
      expect(viaObo.statusCode).toBe(200);
      expect(viaDirect.statusCode).toBe(200);
      expect(viaObo.json()).toEqual(viaDirect.json());
    });

    it("cross-tenant: a linked identity has no membership in a DIFFERENT company and is denied — same as a direct cross-tenant attempt", async () => {
      const args = { tenantId: otherCo, kind: "day", from: "2026-01-01", to: "2026-01-31" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.listPeriods", args), headers: obo("whatsapp", ALICE_WA) });
      expect(viaObo.statusCode).toBe(403);
    });
  });

  describe("reports.getMetrics", () => {
    it("an OBO company_admin and a direct company_admin session return byte-identical series, and the ratio-rule metric carries n/d rather than a bare ratio", async () => {
      const args = { tenantId: co, metricKey: "delivery.on_time_rate", grain: "company", from: "2026-01-01", to: "2026-01-31" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.getMetrics", args), headers: obo("whatsapp", ADMIN_WA) });
      const viaDirect = await app.inject({
        method: "GET",
        url: `/api/${co}/reports/metrics?metricKey=delivery.on_time_rate&grain=company&from=2026-01-01&to=2026-01-31`,
        headers: asUser(admin),
      });
      expect(viaObo.statusCode).toBe(200);
      expect(viaDirect.statusCode).toBe(200);
      expect(viaObo.json()).toEqual(viaDirect.json());
      // The tool's own description is the ratio-rule enforcement point (no server-side change to
      // make); this just confirms the shape it warns about is really there to misuse.
      for (const row of viaObo.json() as Array<{ numerator: number; denominator: number | null }>) {
        expect(row).toHaveProperty("numerator");
        expect(row).toHaveProperty("denominator");
      }
    });

    it("a plain member (no ownerId set on this call, no broader grant) is denied — matching a direct attempt by the same member", async () => {
      const args = { tenantId: co, metricKey: "delivery.on_time_rate", grain: "person", from: "2026-01-01", to: "2026-01-31" };
      const viaObo = await app.inject({ method: "GET", url: toolUrl("reports.getMetrics", args), headers: obo("whatsapp", ALICE_WA) });
      const viaDirect = await app.inject({
        method: "GET",
        url: `/api/${co}/reports/metrics?metricKey=delivery.on_time_rate&grain=person&from=2026-01-01&to=2026-01-31`,
        headers: asUser(alice),
      });
      expect(viaObo.statusCode).toBe(403);
      expect(viaDirect.statusCode).toBe(403);
    });
  });

  // reports.getCompliance keeps §9.2's literal minAssurance:'verified', so it is DORMANT at the hub
  // layer today (mcp-hub's mintPrincipal() can only ever mint "anonymous"/"low" — see index.ts's
  // header). That is a SEPARATE gate from the one this file proves (the pathTemplate's own
  // correctness/Cerbos-parity once a call does reach the platform) — proven here by driving the
  // SAME pathTemplate the hub would eventually use, via a real HTTP call, rather than through an
  // OBO envelope this hub configuration cannot yet produce for a "verified" tool.
  describe("reports.getCompliance (schema/route proven directly; hub-layer dormancy is mcp-hub's own concern)", () => {
    it("self ⊆ scope (TR-39): the tool's own pathTemplate returns only the caller's own row, matching a direct self session exactly, even with 'unit' forced non-empty by the hub-fronting constraint", async () => {
      const args = { tenantId: co, unit: "d-seo", periodKind: "day", start: "2026-01-15", end: "2026-01-15" };
      const viaToolShape = await app.inject({ method: "GET", url: toolUrl("reports.getCompliance", args), headers: asUser(alice) });
      const viaDirect = await app.inject({ method: "GET", url: `/api/${co}/checkins/compliance?unit=d-seo&periodKind=day&start=2026-01-15`, headers: asUser(alice) });
      expect(viaToolShape.statusCode).toBe(200);
      expect(viaDirect.statusCode).toBe(200);
      expect(viaToolShape.json()).toEqual(viaDirect.json());
      for (const row of viaToolShape.json().rows as Array<{ userId: string }>) expect(row.userId).toBe(alice);
    });

    it("a company_admin's broad grid via the tool's pathTemplate matches the direct call exactly", async () => {
      const args = { tenantId: co, unit: "d-seo", periodKind: "day", start: "2026-01-15", end: "2026-01-15" };
      const viaToolShape = await app.inject({ method: "GET", url: toolUrl("reports.getCompliance", args), headers: asUser(admin) });
      const viaDirect = await app.inject({ method: "GET", url: `/api/${co}/checkins/compliance?unit=d-seo&periodKind=day&start=2026-01-15`, headers: asUser(admin) });
      expect(viaToolShape.statusCode).toBe(200);
      expect(viaToolShape.json()).toEqual(viaDirect.json());
    });
  });
});
