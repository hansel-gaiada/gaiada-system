// SMM-23 — the client-facing engagement report lifecycle, against LIVE Postgres (RLS) + the real
// HTTP layer, same harness as social-ai-drafts.test.ts (SMM-19). Cerbos is stubbed to always-allow
// (the tier matrix is social.test.ts's job) — this file exercises what SMM-23 actually owns: the
// frozen metrics snapshot (no invented numbers), the AI narrative grounded in SMM-19's brand-voice
// RAG (with the SAME cross-client leak test shape SMM-19's own file uses), the in-console
// approve/deliver lifecycle, and the render round trip through the EXISTING report-renderer /
// print-payload pipeline (TR-21's own building blocks — no second renderer).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { setRedis, closeRedis } from "../../events/redis";
import { socialModule } from "./index";

// mintPrintJobToken/renderPdfViaSidecar need a REAL Redis — same requirement TR-21's own
// reports.controller.export.pdf.db.test.ts documents (`REDIS_URL_TEST`, explicit `setRedis`).
const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

// Deterministic "gateway" stand-in, mirroring social-ai-drafts.test.ts's own technique: echoes
// which client's secret marker (if any) reached the prompt, so the leak test proves the ACTUAL
// prompt content, not just the plumbing. `narrativeCalls` lets tests assert idempotent create never
// spends a second gateway call on a retry.
let narrativeCalls = 0;
const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }));
completeMock.mockImplementation(async (prompt: string) => {
  const sawA = prompt.includes("CLIENT_A_SECRET_CAMPAIGN");
  const sawB = prompt.includes("CLIENT_B_SECRET_CAMPAIGN");
  return { text: JSON.stringify({ narrative: `narrative sawA=${sawA} sawB=${sawB}` }), provider: "hermes-mock" };
});
vi.mock("./gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway-client")>();
  return { ...actual, completeViaGateway: (...args: unknown[]) => { narrativeCalls++; return completeMock(...(args as [string])); } };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("social-media client-facing reports (SMM-23)", () => {
  let app: NestFastifyApplication;
  let nestBaseUrl: string;
  let A: string;
  let uA: string;
  let clientA: string;
  let clientB: string;
  let engA: string;
  let engB: string;
  let acctA: string;
  let fakeKnowledge: Server;
  let sidecar: Server;
  let sidecarUrl: string;
  let sidecarRequestsSeen: number;
  let ingested: Record<string, string[]>;
  let searches: Array<{ scope: string; query: string }>;

  async function makeAccount(client: string, network = "instagram"): Promise<string> {
    const accId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
         VALUES ($1,$2,$3,$4,'env:KEY','central') ON CONFLICT (tenant_id, client_id) DO NOTHING`,
        [newId(), A, client, `org-${A}-${client}`],
      );
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM social_publisher_orgs WHERE tenant_id=$1 AND client_id=$2`, [A, client]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'connected','{}'::jsonb,'central')`,
        [accId, A, client, rows[0].id, network, `@h-${accId}`],
      );
    }, { modules: ["social"] });
    return accId;
  }

  async function seedDailyMetric(accountId: string, date: string, fields: { followers?: number; impressions?: number }) {
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_metrics_daily (tenant_id, account_id, date, followers, impressions)
       VALUES ($1,$2,$3::date,$4,$5)`,
      [A, accountId, date, fields.followers ?? null, fields.impressions ?? null],
    ), { modules: ["social"] });
  }

  async function importPublishedPost(engagementId: string, accountId: string, publishedAt: string): Promise<{ postId: string; variantId: string }> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/posts/import-native`, headers: asUser(uA),
      payload: { engagementId, accountId, title: "seeded post", body: "hello", publishedAt },
    });
    expect(res.statusCode).toBe(201);
    const postId = res.json().id as string;
    const detail = await app.inject({ method: "GET", url: `/api/${A}/modules/social/posts/${postId}`, headers: asUser(uA) });
    const variantId = detail.json().variants[0].id as string;
    return { postId, variantId };
  }

  async function seedPostMetric(variantId: string, fields: { impressions?: number; likes?: number }) {
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_post_metrics (tenant_id, variant_id, impressions, likes)
       VALUES ($1,$2,$3,$4)`,
      [A, variantId, fields.impressions ?? null, fields.likes ?? null],
    ), { modules: ["social"] });
  }

  beforeAll(async () => {
    await initTestDb();
    setRedis(new Redis(REDIS_TEST_URL));
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SMM23 Co", ["social"]);
    uA = await createUser("smm23@a.test");
    await addMembership(A, uA);
    clientA = await createClient(A, "Brand A");
    clientB = await createClient(A, "Brand B");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    nestBaseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const engARes = await app.inject({ method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA), payload: { clientId: clientA, name: "Engagement A" } });
    engA = engARes.json().id;
    const engBRes = await app.inject({ method: "POST", url: `/api/${A}/modules/social/engagements`, headers: asUser(uA), payload: { clientId: clientB, name: "Engagement B" } });
    engB = engBRes.json().id;

    acctA = await makeAccount(clientA, "instagram");
    await makeAccount(clientB, "linkedin");

    // Fake WS8 knowledge service — same isolation predicate SMM-19's own file uses.
    ingested = {};
    searches = [];
    fakeKnowledge = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === "POST" && req.url === "/ingest") {
          ingested[body.sourceRef as string] = body.chunks as string[];
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ written: (body.chunks as string[]).length }));
        } else if (req.method === "POST" && req.url === "/search") {
          searches.push({ scope: body.scope, query: body.query });
          const chunks = ingested[body.scope as string] ?? [];
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits: chunks.map((text, i) => ({ sourceRef: `${body.scope}#${i}`, text, score: 0.9 })) }));
        } else {
          res.writeHead(404).end("{}");
        }
      });
    });
    const kbBase = await new Promise<string>((resolve) => {
      fakeKnowledge.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(fakeKnowledge.address() as AddressInfo).port}`));
    });
    config.services.knowledge = { url: kbBase, token: "kn-tok" };

    await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["Our brand always highlights the CLIENT_A_SECRET_CAMPAIGN launch."] },
    });
    await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engB}/brand-corpus/ingest`, headers: asUser(uA),
      payload: { chunks: ["Our brand always highlights the CLIENT_B_SECRET_CAMPAIGN launch."] },
    });

    // Metrics for engagement A / client A's account, August 2026: followers present every day,
    // impressions present on ONLY the first day — the "no invented numbers" fixture (a field never
    // fetched on the other days must not silently zero the sum).
    await seedDailyMetric(acctA, "2026-08-01", { followers: 100, impressions: 500 });
    await seedDailyMetric(acctA, "2026-08-02", { followers: 110 }); // impressions NEVER pulled this day
    const { variantId } = await importPublishedPost(engA, acctA, "2026-08-01T10:00:00Z");
    // Post metrics: impressions present, likes NEVER fetched — same discipline at the per-post grain.
    await seedPostMetric(variantId, { impressions: 250 });

    // Sidecar stand-in — same technique reports.controller.export.pdf.db.test.ts uses: it relays to
    // OUR real print-payload route over a real socket, proving the actual round trip.
    sidecarRequestsSeen = 0;
    sidecar = createServer((req, res) => {
      sidecarRequestsSeen++;
      if (req.method !== "POST" || req.url !== "/render") { res.writeHead(404).end(); return; }
      if (req.headers.authorization !== "Bearer render-tok") {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const { url } = JSON.parse(raw) as { url: string };
        const jobToken = url.slice(url.lastIndexOf("/") + 1);
        const payloadRes = await fetch(`${nestBaseUrl}/internal/reports/print-payload/${jobToken}`);
        if (!payloadRes.ok) { res.writeHead(502).end(); return; }
        const payload = (await payloadRes.json()) as { document: { header: { scopeName: string } } };
        res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.from(`%PDF-fake\nscopeName=${payload.document.header.scopeName}`));
      });
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    config.services.knowledge = { url: "", token: "" };
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 30000 };
    await new Promise<void>((r) => fakeKnowledge.close(() => r()));
    await new Promise<void>((r) => sidecar.close(() => r()));
    await app?.close();
    await closeRedis();
    await teardownTestDb();
  });

  // ── NO INVENTED NUMBERS ──────────────────────────────────────────────────────────────────────────
  it("builds the frozen snapshot from SMM-21's own tables; a metric NEVER fetched is omitted, never a fabricated 0", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/reports`, headers: asUser(uA),
      payload: { kind: "monthly", period: "2026-08" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("draft");
    const kpis = body.metrics.kpis as Array<{ metricKey: string; value: number }>;

    // Real numbers, correctly summed/latest: followers (latest known reading = 110), impressions
    // (only the one day it was ever pulled = 500), posts published = 1 (a REAL count of our own
    // rows, never "unknown").
    expect(kpis.find((k) => k.metricKey === "followers_total")?.value).toBe(110);
    expect(kpis.find((k) => k.metricKey === "impressions_period")?.value).toBe(500);
    expect(kpis.find((k) => k.metricKey === "posts_published_period")?.value).toBe(1);

    // Never fetched at all this period -> ABSENT from the array, never present with value 0.
    expect(kpis.find((k) => k.metricKey === "reach_period")).toBeUndefined();
    expect(kpis.find((k) => k.metricKey === "video_views_period")).toBeUndefined();

    // Same discipline at the per-post grain: likes was never fetched for the one published post ->
    // the top_posts table renders it as null, never 0.
    const topPosts = body.metrics.tables.find((t: { key: string }) => t.key === "top_posts");
    expect(topPosts.rows[0].impressions).toBe(250);
    expect(topPosts.rows[0].likes).toBeNull();
  });

  // ── THE MODULE GUC (recurring defect class #1) — pinned by asserting a REAL row is readable
  //    through the exact query path every route above declares `{ modules: ["social"] }` on. Delete
  //    that option from any query in social-reports.controller.ts and this assertion regresses from
  //    "one report, real numbers" to "zero rows, looks perfectly healthy" — the precise failure
  //    shape every other job in this module has been bitten by (see the file's own header list). ──
  it("(module GUC) the created report is readable back through GET reports and GET reports/:id — zero rows would mean the declaration was dropped", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/social/reports?engagementId=${engA}`, headers: asUser(uA) });
    expect(list.statusCode).toBe(200);
    expect(list.json().reports.length).toBeGreaterThan(0);
    const id = list.json().reports[0].id as string;
    const detail = await app.inject({ method: "GET", url: `/api/${A}/modules/social/reports/${id}`, headers: asUser(uA) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().document.header.scopeName).toBe("Brand A");
  });

  // ── CROSS-CLIENT LEAK TEST — the assertion the ticket names as mattering most ──────────────────
  it("CROSS-CLIENT LEAK TEST: a report's narrative is grounded ONLY in its own client's brand corpus, never the other client's", async () => {
    searches.length = 0;
    const resA = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/reports`, headers: asUser(uA),
      payload: { id: newId(), kind: "adhoc" },
    });
    expect(resA.statusCode).toBe(201);
    expect(resA.json().narrativeMd).toContain("sawA=true");
    expect(resA.json().narrativeMd).toContain("sawB=false");
    const lastSearchA = searches[searches.length - 1];
    expect(lastSearchA.scope).toBe(`social-brand:${A}:${clientA}`);
    expect(lastSearchA.scope).not.toBe(`social-brand:${A}:${clientB}`);

    searches.length = 0;
    const resB = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engB}/reports`, headers: asUser(uA),
      payload: { id: newId(), kind: "adhoc" },
    });
    expect(resB.statusCode).toBe(201);
    expect(resB.json().narrativeMd).toContain("sawA=false");
    expect(resB.json().narrativeMd).toContain("sawB=true");
    const lastSearchB = searches[searches.length - 1];
    expect(lastSearchB.scope).toBe(`social-brand:${A}:${clientB}`);
    expect(lastSearchB.scope).not.toBe(`social-brand:${A}:${clientA}`);
  });

  // ── IDEMPOTENT CREATE (agentic criterion 3) ─────────────────────────────────────────────────────
  it("a repeated create with the same id returns the EXISTING report and spends no second gateway call", async () => {
    const id = newId();
    const first = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/reports`, headers: asUser(uA), payload: { id },
    });
    expect(first.statusCode).toBe(201);
    const callsAfterFirst = narrativeCalls;
    const second = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/reports`, headers: asUser(uA), payload: { id },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().draftedVia).toBe("existing");
    expect(second.json().narrativeMd).toBe(first.json().narrativeMd);
    expect(narrativeCalls).toBe(callsAfterFirst); // no second gateway call on the retry
  });

  // ── LIFECYCLE: draft -> in_review -> approved -> delivered, via the REAL sidecar round trip ─────
  it("submits, approves, and delivers a report — rendering through the REAL report-renderer round trip and writing a files row", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/social/engagements/${engA}/reports`, headers: asUser(uA),
      payload: { kind: "monthly", period: "2026-08" },
    });
    const id = create.json().id as string;

    const submit = await app.inject({ method: "PATCH", url: `/api/${A}/modules/social/reports/${id}`, headers: asUser(uA), payload: { status: "in_review" } });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("in_review");

    // Approve BEFORE deliver-configured — proves approve never touches the renderer at all.
    const approve = await app.inject({ method: "POST", url: `/api/${A}/modules/social/reports/${id}/approve`, headers: asUser(uA) });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");

    // Deliver with the sidecar NOT configured -> honest 503, never a silent skip.
    const notConfigured = await app.inject({ method: "POST", url: `/api/${A}/modules/social/reports/${id}/deliver`, headers: asUser(uA) });
    expect(notConfigured.statusCode).toBe(503);
    expect(notConfigured.json().error).toContain("not_configured");

    config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
    const deliver = await app.inject({ method: "POST", url: `/api/${A}/modules/social/reports/${id}/deliver`, headers: asUser(uA) });
    expect(deliver.statusCode).toBe(200);
    expect(deliver.json().status).toBe("delivered");
    expect(typeof deliver.json().fileId).toBe("string");
    expect(sidecarRequestsSeen).toBeGreaterThan(0);

    // The files row is real — mirrors search-reports.controller.ts's own delivery guarantee.
    const fileId = deliver.json().fileId as string;
    const fileRow = await withTenants([A], (c) => c.query(
      `SELECT target_entity_type, content_type FROM files WHERE id = $1`, [fileId],
    ), {});
    expect(fileRow.rows[0].target_entity_type).toBe("social_report");
    expect(fileRow.rows[0].content_type).toBe("application/pdf");

    // Re-delivering an already-delivered report is refused, never silently re-rendered.
    const redeliver = await app.inject({ method: "POST", url: `/api/${A}/modules/social/reports/${id}/deliver`, headers: asUser(uA) });
    expect(redeliver.statusCode).toBe(400);

    // approve from a non-'in_review' status is refused too (already 'delivered' here).
    const reapprove = await app.inject({ method: "POST", url: `/api/${A}/modules/social/reports/${id}/approve`, headers: asUser(uA) });
    expect(reapprove.statusCode).toBe(400);
  });
});
