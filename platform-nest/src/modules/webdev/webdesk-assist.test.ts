// M5-W6 — AI assist over HTTP: `POST …/content/sites/:ts/:site/items/:itemId/assist` and the MCP tool `webdesk.content.assist`.
//
// Same harness as webdesk-content-preview.test.ts: real Postgres (RLS, the `activities` ledger the budget lives in), real Cerbos
// (the real policies), the full NestJS app, the real `WebdeskContentService` / `WebdeskAssistService`; Zone B is the strict
// in-process fake and the gateway is a recording stub (no network). The local half (stub Cerbos, in-memory budget) is
// webdesk-assist.service.unit.test.ts; the pure half is webdesk-assist.unit.test.ts.
//
// What is pinned here that the local halves cannot:
//   * authorize-FIRST on the real policies: a principal with no right to edit is 403 with a VALID body, and neither the gateway
//     nor WebDesk is reached; an editor is the positive control. The Cerbos question is `update` on `webdesk_content_item`.
//   * the REAL budget SQL: the per-principal daily count in `activities`, the advisory lock (concurrent calls cannot overshoot), the refund of a
//     call the gateway never served, and that no row holds content
//   * typed 429 / 503 / 422 over the wire as problem+json
//   * the route never calls a WebDesk write command
//   * no prompt or completion text in any log line or stored row
//   * the MCP tool is the same path, LOW impact (it changes nothing on the site; the budget is its control)
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise): the Linux gate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { webdeskAssist } from "./webdesk-assist.service";
import { ASSIST_VERB } from "./webdesk-assist-budget";
import { webdevModule } from "./index";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

// A pass-through spy on the platform's Cerbos gate: it pins WHICH kind and action assist asks.
const authCalls = vi.hoisted(() => [] as Array<{ resource: Record<string, unknown>; action: string }>);
vi.mock("../../core/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/http")>();
  return {
    ...real,
    authorize: (async (principal: never, resource: never, action: never) => {
      authCalls.push({ resource: { ...(resource as Record<string, unknown>) }, action: action as string });
      return (real.authorize as (...a: unknown[]) => Promise<unknown>)(principal, resource, action);
    }) as typeof real.authorize,
  };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const CANARY = "CANARY-ZEBRA-4242";
const BODY = `Our team builds fast, accessible websites for clinics and schools across Indonesia. ${CANARY} We start with a short discovery call, agree a fixed scope, and ship in weeks, not months. `.repeat(3);
const GOOD = "Fast, accessible websites for clinics and schools, shipped in weeks with a fixed scope and a plain-spoken team that stays after launch.";

describe.skipIf(!live)("M5-W6 · AI assist: the route, the budget and the MCP tool", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, editorA: string, editor2A: string, memberA: string, adminB: string;
  let zb: FakeZoneB;
  let item: FakeItem;
  const signer = makeTestSigner();

  // ── the gateway, as a recording stub ─────────────────────────────────────────────────────────────
  let prompts: string[] = [];
  let reply: () => Promise<{ text: string; provider?: string }> = async () => ({ text: JSON.stringify({ description: GOOD }), provider: "ollama" });

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const assist = (as: string, itemId: string, body: unknown = { kind: "meta_description" }, siteUrl = site()) =>
    app.inject({ method: "POST", url: `${siteUrl}/items/${itemId}/assist`, headers: asUser(as), payload: body as never });

  async function ledger() {
    const { rows } = await adminPool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = $2 ORDER BY occurred_at, id`,
      [A, ASSIST_VERB],
    );
    return rows;
  }
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb = $2`, [A, ASSIST_VERB]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W6 Co A", ["webdev"]);
    B = await createCompany("W6 Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "w6-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "w6-editor-a@ex.test", "webdev_staff");
    editor2A = await mk(A, "w6-editor2-a@ex.test", "webdev_staff");
    memberA = await mk(A, "w6-member-a@ex.test", "member");
    adminB = await mk(B, "w6-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    authCalls.length = 0;
    prompts = [];
    reply = async () => ({ text: JSON.stringify({ description: GOOD }), provider: "ollama" });
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    webdeskAssist.setDepsForTests({ gateway: async (p) => { prompts.push(p); return reply(); } });
    for (const k of ["WEBDESK_ASSIST_DAILY_CALLS", "WEBDESK_ASSIST_DAILY_TOKENS", "WEBDESK_ASSIST_DAILY_CALLS_AUTOMATED", "WEBDESK_ASSIST_DAILY_TOKENS_AUTOMATED"]) delete process.env[k];
    item = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo" });
    item.versions[0].fields = { h1: "Web design for clinics", body: BODY };
    item.versions[0].seo = { title: "Clinic web design" };
    await clearLedger();
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    webdeskAssist.setDepsForTests(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const onlyReads = () => zb.calls.every((c) => c.command === "item.get" || c.command === "tenant.list");

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden case and authorization", () => {
    it("an editor gets 200 {suggestions}; the Cerbos question was `update` on the item; WebDesk saw no write", async () => {
      const r = await assist(editorA, item.itemId);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ kind: "meta_description", advisory: true, version: 1, suggestions: [{ target: "/seo/description", text: GOOD }] });
      expect(authCalls.some((a) => a.action === "update" && a.resource.kind === "webdesk_content_item" && a.resource.id === item.itemId)).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(zb.writes).toHaveLength(0);
      expect(onlyReads()).toBe(true);
      expect(signer.calls).toHaveLength(0);
    });

    it("🔴 a principal who may not edit is 403 with a VALID body: the gateway and WebDesk's write plane are never reached (the editor, same request, is the positive control)", async () => {
      const denied = await assist(memberA, item.itemId, { kind: "meta_description" });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(prompts).toHaveLength(0);
      expect(zb.writes).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);
      const ok = await assist(editorA, item.itemId, { kind: "meta_description" });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("authorization precedes validation: the denied caller is 403 for an invalid body; the editor is 400 for the same", async () => {
      for (const bad of [{ kind: "nonsense" }, {}, { kind: "outline", siteId: "forged" }]) {
        expect((await assist(memberA, item.itemId, bad)).statusCode).toBe(403);
        expect((await assist(editorA, item.itemId, bad)).statusCode).toBe(400);
      }
      expect(prompts).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);
    });

    it("a company admin may assist too (the same `update` action); another company's admin cannot use this company's path", async () => {
      expect((await assist(adminA, item.itemId)).statusCode).toBe(200);
      expect((await assist(adminB, item.itemId)).statusCode).toBe(403);
    });

    it("the cross-company wall: another company's site on this company's path is the uniform 404 and nothing is spent", async () => {
      const foreign = zb.seedItem({ siteId: OTHER_SITE, slug: "svc.other" });
      const r = await assist(editorA, foreign.itemId, { kind: "meta_description" }, site(A, OTHER_SLUG, OTHER_SITE));
      expect(r.statusCode).toBe(404);
      expect(prompts).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the budget, in the real ledger", () => {
    it("the Nth+1 call is 429 problem+json `assist-budget-exceeded`; the gateway was called N times; two rows per call, none holding content", async () => {
      process.env.WEBDESK_ASSIST_DAILY_CALLS = "2";
      expect((await assist(editorA, item.itemId)).statusCode).toBe(200);
      expect((await assist(editorA, item.itemId)).statusCode).toBe(200);
      const r = await assist(editorA, item.itemId);
      expect(r.statusCode).toBe(429);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/assist-budget-exceeded", scope: "principal", limits: { calls: 2 }, used: { calls: 2 } });
      expect(r.json().retryAfterSeconds).toBeGreaterThan(0);
      expect(prompts).toHaveLength(2);
      const rows = await ledger();
      expect(rows.map((x) => x.metadata.phase)).toEqual(["reserved", "completed", "reserved", "completed"]);
      expect(rows.every((x) => x.actor_id === editorA)).toBe(true);
      const dump = JSON.stringify(rows);
      for (const secret of [CANARY, "Clinic web design", GOOD, "discovery call"]) expect(dump).not.toContain(secret);
      // the other editor's day is their own
      expect((await assist(editor2A, item.itemId)).statusCode).toBe(200);
    });

    it("🔴 concurrent calls cannot overshoot the limit (the per-principal advisory lock): 8 at once against a limit of 3 -> exactly 3 are served", async () => {
      process.env.WEBDESK_ASSIST_DAILY_CALLS = "3";
      reply = async () => { await new Promise((r) => setTimeout(r, 25)); return { text: JSON.stringify({ description: GOOD }), provider: "ollama" }; };
      const all = await Promise.all(Array.from({ length: 8 }, () => assist(editorA, item.itemId)));
      const codes = all.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(3);
      expect(codes.filter((c) => c === 429)).toHaveLength(5);
      expect(prompts).toHaveLength(3);
      expect((await ledger()).filter((x) => x.metadata.phase === "reserved")).toHaveLength(3);
    });

    it("a call the gateway never served is refunded: with a limit of 1, a 503 does not use up the day", async () => {
      process.env.WEBDESK_ASSIST_DAILY_CALLS = "1";
      reply = async () => { throw new Error("ai-gateway /complete returned HTTP 503"); };
      const down = await assist(editorA, item.itemId);
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/assist-unavailable", reason: "gateway_unavailable" });
      expect(down.json()).not.toHaveProperty("suggestions");
      const rows = await ledger();
      expect(rows.find((x) => x.metadata.phase === "completed")!.metadata).toMatchObject({ outcome: "gateway_unavailable", refundCalls: 1 });
      reply = async () => ({ text: JSON.stringify({ description: GOOD }), provider: "ollama" });
      expect((await assist(editorA, item.itemId)).statusCode).toBe(200);
    });

    it("only TODAY counts: a reservation from before 00:00 UTC does not", async () => {
      process.env.WEBDESK_ASSIST_DAILY_CALLS = "1";
      await adminPool().query(
        `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at, origin_site)
         VALUES (gen_random_uuid(), $1, $2, $3, 'webdesk_content_item', NULL, '{"phase":"reserved","tokensEst":100}', now() - interval '2 days', 'test')`,
        [A, editorA, ASSIST_VERB],
      );
      expect((await assist(editorA, item.itemId)).statusCode).toBe(200);
      expect((await assist(editorA, item.itemId)).statusCode).toBe(429);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("typed refusals over the wire", () => {
    it("422 assist-not-applicable (no image without alt) costs nothing; 502 assist-output-invalid when the answer breaks the W3 lengths", async () => {
      const na = await assist(editorA, item.itemId, { kind: "alt_text" });
      expect(na.statusCode).toBe(422);
      expect(na.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/assist-not-applicable", reason: "no_image_without_alt" });
      expect(prompts).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);

      reply = async () => ({ text: JSON.stringify({ description: "Far too short." }), provider: "ollama" });
      const bad = await assist(editorA, item.itemId);
      expect(bad.statusCode).toBe(502);
      expect(bad.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/assist-output-invalid", reason: "description_length" });
    });

    it("503 when the gateway is not configured; the keyless `echo` provider is not a suggestion", async () => {
      webdeskAssist.setDepsForTests({ gateway: async () => { const { GatewayNotConfiguredError } = await import("../search/providers/gateway-client"); throw new GatewayNotConfiguredError(); } });
      const r = await assist(editorA, item.itemId);
      expect([r.statusCode, r.json().reason]).toEqual([503, "not_configured"]);
      webdeskAssist.setDepsForTests({ gateway: async () => ({ text: "echo", provider: "echo" }) });
      const e = await assist(editorA, item.itemId);
      expect([e.statusCode, e.json().reason]).toEqual([503, "no_provider"]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("🔴 no content in logs or stored rows", () => {
    it("across success, an unusable answer and a gateway failure: no title, field text, prompt or completion appears in a log line or in the activities table", async () => {
      const seen: string[] = [];
      const grab = (...a: unknown[]) => { seen.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      for (const m of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) vi.spyOn(Logger.prototype, m).mockImplementation(grab as never);
      for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab as never);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);
      const ok = await assist(editorA, item.itemId);
      reply = async () => ({ text: `{"description":"COMPLETION-CANARY-777 short"}` });
      const invalid = await assist(editorA, item.itemId);
      reply = async () => { throw new Error(`down ${CANARY}`); };
      const down = await assist(editorA, item.itemId);
      out.mockRestore(); err.mockRestore();
      expect([ok.statusCode, invalid.statusCode, down.statusCode]).toEqual([200, 502, 503]);
      const everything = seen.join("\n");
      expect(everything).toContain("assist kind=meta_description");
      const stored = JSON.stringify(await adminPool().query(`SELECT metadata FROM activities WHERE tenant_id = $1`, [A]).then((r) => r.rows));
      for (const secret of [CANARY, "COMPLETION-CANARY-777", "Clinic web design", "Web design for clinics", GOOD, "discovery call"]) {
        expect(everything, `a log line carries: ${secret}`).not.toContain(secret);
        expect(stored, `a stored row carries: ${secret}`).not.toContain(secret);
        for (const r of [invalid, down]) expect(r.body).not.toContain(secret);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the MCP tool webdesk.content.assist: the SAME route, LOW impact", () => {
    const def = () => webdevModule.mcpTools.find((t) => t.name === "webdesk.content.assist");

    it("is declared as a LOW write on POST …/items/:itemId/assist (a POST is a `write` by the registry's rule; it changes nothing on the site), minAssurance low", () => {
      const d = def();
      expect(d).toBeDefined();
      expect(d).toMatchObject({ write: true, impact: "low", method: "POST", minAssurance: "low", pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/assist" });
      const schema = d!.inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
      expect(schema.properties.kind.enum).toEqual(["outline", "meta_description", "faq", "translate_draft", "alt_text"]);
      expect(schema.required).toEqual(["tenantId", "tenantSlug", "siteId", "itemId", "kind"]);
    });

    it("calling it the way the hub does (path args consumed, the rest is the JSON body) reaches the same handler and the same authorization", async () => {
      const d = def()!;
      const args: Record<string, unknown> = { tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, itemId: item.itemId, kind: "outline", version: 1 };
      const used = new Set<string>();
      const path = d.pathTemplate!.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => { used.add(p); return encodeURIComponent(String(args[p])); });
      const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
      expect(path).toBe(`${site()}/items/${item.itemId}/assist`);
      reply = async () => ({ text: JSON.stringify({ headings: [{ level: 2, text: "What does a clinic website need?" }, { level: 2, text: "How long does it take?" }, { level: 3, text: "Booking and forms" }] }), provider: "ollama" });
      const r = await app.inject({ method: "POST", url: path, headers: { ...asUser(editorA), "content-type": "application/json" }, payload: JSON.stringify(rest) });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().suggestions[0].kind).toBe("outline");
      const denied = await app.inject({ method: "POST", url: path, headers: { ...asUser(memberA), "content-type": "application/json" }, payload: JSON.stringify(rest) });
      expect(denied.statusCode).toBe(403);
    });
  });
});
